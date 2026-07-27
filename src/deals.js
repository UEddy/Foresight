// Phase 9 — deal data layer.
//
// Win/loss outcomes are the raw signal the correlation engine and ROI dashboard
// run on. This module owns validation, persistence, and the value-masking used
// everywhere a deal value might otherwise leak into a log.
//
// SECURITY: every read/write is scoped by user_id. A user can never see, edit,
// or delete another user's deals. deal_value_usd is sensitive financial data —
// it is masked in logs (maskValue) and only ever returned to the owning user.

const { getDb } = require('./db');

const OUTCOMES = ['won', 'lost', 'stalled'];
const SOURCES  = ['manual_form', 'slack_command', 'api'];
const MAX_VALUE = 1_000_000_000_000; // sanity ceiling: $1T

class DealError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DealError';
    this.status = status;
  }
}

// Privacy-preserving mask for logs. We never write the real figure to disk —
// only a coarse band that's enough to debug without exposing deal economics.
function maskValue(v) {
  if (v === null || v === undefined || v === '') return 'none';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  if (n === 0)          return '$0';
  if (n < 10_000)       return '$<10K';
  if (n < 100_000)      return '$10K-100K';
  if (n < 1_000_000)    return '$100K-1M';
  return '$1M+';
}

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Coerce a value input (number or string) to an integer dollar amount or null.
// Rejects negatives and non-numerics. Accepts already-parsed integers from the
// Slack value parser too.
function normalizeValue(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: null, error: null };
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return { value: null, error: 'Deal value must be a number' };
  if (n < 0)               return { value: null, error: 'Deal value cannot be negative' };
  if (n > MAX_VALUE)       return { value: null, error: 'Deal value is implausibly large' };
  return { value: n, error: null };
}

// Returns the owned competitor row or throws. Used for lost/stalled deals.
function requireOwnedCompetitor(db, userId, competitorId) {
  const id = parseInt(competitorId, 10);
  if (!Number.isInteger(id)) throw new DealError(400, 'A competitor is required for lost and stalled deals');
  const row = db.prepare('SELECT id, name FROM competitors WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw new DealError(400, 'Competitor not found or not in your tracked list');
  return row;
}

// Create a deal. `input` is already-untrusted: validates everything.
// Returns the hydrated deal row (with competitor_name).
function createDeal(userId, input = {}) {
  const db = getDb();

  const dealName = String(input.deal_name || '').trim();
  if (!dealName)               throw new DealError(400, 'Deal name is required');
  if (dealName.length > 200)   throw new DealError(400, 'Deal name must be 200 characters or fewer');

  const outcome = String(input.outcome || '').trim().toLowerCase();
  if (!OUTCOMES.includes(outcome)) throw new DealError(400, "Outcome must be 'won', 'lost', or 'stalled'");

  const source = SOURCES.includes(input.source) ? input.source : 'manual_form';

  // competitor_id: required for lost/stalled, ignored for won.
  let competitorId = null;
  if (outcome === 'lost' || outcome === 'stalled') {
    competitorId = requireOwnedCompetitor(db, userId, input.competitor_id).id;
  } else if (input.competitor_id !== undefined && input.competitor_id !== null && input.competitor_id !== '') {
    // A won deal may optionally cite the competitor it beat.
    competitorId = requireOwnedCompetitor(db, userId, input.competitor_id).id;
  }

  const { value: valueUsd, error: valueErr } = normalizeValue(input.deal_value_usd);
  if (valueErr) throw new DealError(400, valueErr);

  let closeDate = input.close_date ? String(input.close_date).trim() : todayStr();
  if (!isValidDateStr(closeDate)) throw new DealError(400, 'Close date must be a valid YYYY-MM-DD date');

  const notes = input.notes ? String(input.notes).trim().slice(0, 2000) : null;

  const result = db.prepare(`
    INSERT INTO deals (user_id, deal_name, outcome, competitor_id, deal_value_usd, close_date, notes, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, dealName, outcome, competitorId, valueUsd, closeDate, notes, source);

  // Observability: log creation with the value MASKED.
  console.log(`📝 Deal logged: user=${userId} outcome=${outcome} competitor=${competitorId ?? '-'} value=${maskValue(valueUsd)} source=${source} id=${result.lastInsertRowid}`);

  return getDeal(userId, result.lastInsertRowid);
}

function getDeal(userId, id) {
  const db = getDb();
  return db.prepare(`
    SELECT d.*, c.name AS competitor_name
    FROM deals d
    LEFT JOIN competitors c ON d.competitor_id = c.id
    WHERE d.id = ? AND d.user_id = ?
  `).get(parseInt(id, 10), userId) || null;
}

function listDeals(userId, opts = {}) {
  const db = getDb();
  const limit  = Math.min(500, Math.max(1, parseInt(opts.limit, 10) || 200));
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);

  const conds = ['d.user_id = ?'];
  const params = [userId];
  if (opts.outcome && OUTCOMES.includes(opts.outcome)) {
    conds.push('d.outcome = ?');
    params.push(opts.outcome);
  }
  if (opts.competitor_id) {
    conds.push('d.competitor_id = ?');
    params.push(parseInt(opts.competitor_id, 10));
  }
  const where = conds.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM deals d WHERE ${where}`).get(...params).n;
  const rows = db.prepare(`
    SELECT d.*, c.name AS competitor_name
    FROM deals d
    LEFT JOIN competitors c ON d.competitor_id = c.id
    WHERE ${where}
    ORDER BY d.close_date DESC, d.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { deals: rows, total, limit, offset };
}

function updateDeal(userId, id, input = {}) {
  const db = getDb();
  const existing = getDeal(userId, id);
  if (!existing) throw new DealError(404, 'Deal not found');

  let dealName    = existing.deal_name;
  let outcome     = existing.outcome;
  let competitorId = existing.competitor_id;
  let valueUsd    = existing.deal_value_usd;
  let closeDate   = existing.close_date;
  let notes       = existing.notes;

  if (input.deal_name !== undefined) {
    dealName = String(input.deal_name).trim();
    if (!dealName)             throw new DealError(400, 'Deal name cannot be empty');
    if (dealName.length > 200) throw new DealError(400, 'Deal name must be 200 characters or fewer');
  }
  if (input.outcome !== undefined) {
    outcome = String(input.outcome).trim().toLowerCase();
    if (!OUTCOMES.includes(outcome)) throw new DealError(400, "Outcome must be 'won', 'lost', or 'stalled'");
  }
  // Resolve competitor against the (possibly updated) outcome.
  if (input.competitor_id !== undefined) {
    if (input.competitor_id === null || input.competitor_id === '') {
      competitorId = null;
    } else {
      competitorId = requireOwnedCompetitor(db, userId, input.competitor_id).id;
    }
  }
  if ((outcome === 'lost' || outcome === 'stalled') && !competitorId) {
    throw new DealError(400, 'A competitor is required for lost and stalled deals');
  }
  if (input.deal_value_usd !== undefined) {
    const { value, error } = normalizeValue(input.deal_value_usd);
    if (error) throw new DealError(400, error);
    valueUsd = value;
  }
  if (input.close_date !== undefined) {
    closeDate = String(input.close_date).trim();
    if (!isValidDateStr(closeDate)) throw new DealError(400, 'Close date must be a valid YYYY-MM-DD date');
  }
  if (input.notes !== undefined) {
    notes = input.notes ? String(input.notes).trim().slice(0, 2000) : null;
  }

  db.prepare(`
    UPDATE deals
    SET deal_name = ?, outcome = ?, competitor_id = ?, deal_value_usd = ?,
        close_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(dealName, outcome, competitorId, valueUsd, closeDate, notes, existing.id, userId);

  console.log(`✏️  Deal updated: user=${userId} id=${existing.id} outcome=${outcome} value=${maskValue(valueUsd)}`);
  return getDeal(userId, existing.id);
}

function deleteDeal(userId, id) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM deals WHERE id = ? AND user_id = ?').get(parseInt(id, 10), userId);
  if (!existing) throw new DealError(404, 'Deal not found');
  db.prepare('DELETE FROM deals WHERE id = ? AND user_id = ?').run(existing.id, userId);
  console.log(`🗑️  Deal deleted: user=${userId} id=${existing.id}`);
  return { success: true };
}

// Distinct prior deal names for autocomplete, most-recent first, scoped to user.
function dealNameSuggestions(userId, query, limit = 8) {
  const db = getDb();
  const q = String(query || '').trim().toLowerCase();
  const rows = db.prepare(`
    SELECT deal_name, MAX(created_at) AS last_used
    FROM deals
    WHERE user_id = ? ${q ? 'AND lower(deal_name) LIKE ?' : ''}
    GROUP BY deal_name
    ORDER BY last_used DESC
    LIMIT ?
  `).all(...(q ? [userId, `%${q}%`, limit] : [userId, limit]));
  return rows.map(r => r.deal_name);
}

// CSV export for the owning user. Values are intentionally INCLUDED here — this
// is the owner pulling their own data into their CRM, the one place full
// figures are appropriate. Never call this for anyone but the row owner.
function dealsToCsv(userId) {
  const { deals } = listDeals(userId, { limit: 500 });
  const header = ['id', 'deal_name', 'outcome', 'competitor', 'deal_value_usd', 'close_date', 'source', 'notes', 'created_at'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const d of deals) {
    lines.push([
      d.id, esc(d.deal_name), d.outcome, esc(d.competitor_name || ''),
      d.deal_value_usd ?? '', d.close_date, d.source, esc(d.notes || ''), esc(d.created_at),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

// Adoption funnel across all users: how many have logged at least 1 / 5 / 15
// deals. Logged by the nightly engine; also exposed for the report.
function adoptionMetrics() {
  const db = getDb();
  const rows = db.prepare('SELECT user_id, COUNT(*) AS n FROM deals GROUP BY user_id').all();
  const atLeast1  = rows.filter(r => r.n >= 1).length;
  const atLeast5  = rows.filter(r => r.n >= 5).length;
  const atLeast15 = rows.filter(r => r.n >= 15).length;
  const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  return { total_users: totalUsers, logged_1: atLeast1, logged_5: atLeast5, logged_15: atLeast15 };
}

// Competitor activity in the `days` before a deal's close date — powers the
// individual deal "what was the competitor doing" timeline. user_id scoped.
function competitorActivityBeforeClose(userId, competitorId, closeDate, days = 30) {
  const db = getDb();
  if (!competitorId) return [];
  return db.prepare(`
    SELECT ch.id, ch.headline, ch.threat_level, ch.detected_at, ch.pattern_tags, ch.gate_category
    FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    WHERE ch.competitor_id = ?
      AND c.user_id = ?
      AND (ch.is_meaningful IS NULL OR ch.is_meaningful = 1)
      AND COALESCE(ch.is_baseline, 0) = 0
      AND date(ch.detected_at) > date(?, ?)
      AND date(ch.detected_at) <= date(?)
    ORDER BY ch.detected_at DESC
  `).all(competitorId, userId, closeDate, `-${days} days`, closeDate)
    .map(r => ({
      id: r.id,
      headline: r.headline,
      threat_level: r.threat_level || 'low',
      detected_at: r.detected_at,
      pattern_tags: (() => { try { return r.pattern_tags ? JSON.parse(r.pattern_tags) : []; } catch { return []; } })(),
    }));
}

module.exports = {
  OUTCOMES, SOURCES, DealError,
  maskValue, normalizeValue, isValidDateStr, todayStr,
  createDeal, getDeal, listDeals, updateDeal, deleteDeal,
  dealNameSuggestions, dealsToCsv, adoptionMetrics, competitorActivityBeforeClose,
};
