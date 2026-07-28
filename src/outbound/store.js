// Outbound — persistence helpers for outbound_runs and outbound_leads.
//
// Thin wrappers over the shared sql.js DatabaseWrapper (getDb()). Every write
// auto-persists to the Railway volume: Statement.run() / DatabaseWrapper.exec()
// call saveDb() internally, so there is no explicit flush to make here.
//
// NOTE: `trigger` is a SQLite keyword, so the leads column is always written and
// read as "trigger" (double-quoted). JSON columns (params, score_breakdown) are
// stored as text and parsed on read.

const { getDb } = require('../db');

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

// ── Runs ─────────────────────────────────────────────────────────────────────────

function createRun(userId, params) {
  const db = getDb();
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO outbound_runs (created_by, status, params) VALUES (?, 'pending', ?)"
  ).run(userId, JSON.stringify(params || {}));
  return getRun(lastInsertRowid);
}

function getRun(id) {
  const row = getDb().prepare('SELECT * FROM outbound_runs WHERE id = ?').get(id);
  return row ? hydrateRun(row) : null;
}

// Scope a run to its creator (defensive: even though only admins reach these
// routes today, a run id should never leak another user's run once opened up).
function getRunForUser(id, userId) {
  const row = getDb().prepare('SELECT * FROM outbound_runs WHERE id = ? AND created_by = ?').get(id, userId);
  return row ? hydrateRun(row) : null;
}

function listRunsForUser(userId, limit = 20) {
  return getDb()
    .prepare('SELECT * FROM outbound_runs WHERE created_by = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit)
    .map(hydrateRun);
}

function updateRun(id, fields) {
  const allowed = ['status', 'error_message', 'total_found', 'total_kept', 'funnel'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (!(k in fields)) continue;
    let v = fields[k];
    // funnel is stored as JSON text; accept either an object or a ready string.
    if (k === 'funnel' && v != null && typeof v !== 'string') v = JSON.stringify(v);
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  getDb().prepare(`UPDATE outbound_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function hydrateRun(row) {
  return { ...row, params: parseJson(row.params, {}), funnel: parseJson(row.funnel, null) };
}

// ── Leads ────────────────────────────────────────────────────────────────────────

const LEAD_INSERT_COLS = [
  'run_id', 'company', 'domain', 'category', 'stage_size', 'region',
  'trigger', 'trigger_url', 'trigger_at', 'score', 'score_breakdown', 'why_now',
  'person_name', 'person_title', 'person_seniority',
  'channel', 'handle_or_email', 'contact_status', 'backup_channel',
  'linkedin_status', 'source',
  'draft', 'draft_subject', 'confidence',
];

// Freshness-first ranking (rule 3). Buckets a lead by how recent its trigger is,
// so recency dominates the sort and score only breaks ties within a bucket. The
// window spans a full 6 months (triggers up to 180 days old stay valid):
//   0 this week, 1 this month, 2 last 3 months, 3 three to six months,
//   4 undated, 5 stale (>180 days).
// Undated triggers rank above stale (a missing date is unknown recency, not old)
// but below any dated-valid lead. Stale is down-ranked, not dropped, because the
// dates are model-inferred. `prefix` qualifies the column in a JOIN (e.g. 'l.').
function freshnessRank(prefix = '') {
  const col = `${prefix}"trigger_at"`;
  return `CASE
    WHEN ${col} IS NULL THEN 4
    WHEN julianday('now') - julianday(${col}) <= 7   THEN 0
    WHEN julianday('now') - julianday(${col}) <= 30  THEN 1
    WHEN julianday('now') - julianday(${col}) <= 90  THEN 2
    WHEN julianday('now') - julianday(${col}) <= 180 THEN 3
    ELSE 5 END`;
}

function insertLead(runId, lead) {
  const row = {
    run_id: runId,
    company: lead.company || null,
    domain: lead.domain || null,
    category: lead.category || null,
    stage_size: lead.stage_size || null,
    region: lead.region || null,
    trigger: lead.trigger || null,
    trigger_url: lead.trigger_url || null,
    trigger_at: lead.trigger_at || null,
    score: Number.isFinite(lead.score) ? Math.round(lead.score) : 0,
    score_breakdown: JSON.stringify(lead.score_breakdown || {}),
    why_now: lead.why_now || null,
    person_name: lead.person_name || null,
    person_title: lead.person_title || null,
    person_seniority: lead.person_seniority || null,
    channel: lead.channel || null,
    handle_or_email: lead.handle_or_email || null,
    contact_status: lead.contact_status || 'manual',
    backup_channel: lead.backup_channel || null,
    linkedin_status: lead.linkedin_status || null,
    source: lead.source || null,
    draft: lead.draft || null,
    // Email drafts only. NULL on linkedin/x leads, which have no subject.
    draft_subject: lead.draft_subject || null,
    confidence: lead.confidence || null,
  };
  // Quote every column so the "trigger" keyword is handled; status/notes/
  // created_at keep their schema defaults (new / null / now).
  const cols = LEAD_INSERT_COLS.map(c => `"${c}"`).join(', ');
  const placeholders = LEAD_INSERT_COLS.map(() => '?').join(', ');
  const vals = LEAD_INSERT_COLS.map(c => row[c]);
  const { lastInsertRowid } = getDb()
    .prepare(`INSERT INTO outbound_leads (${cols}) VALUES (${placeholders})`)
    .run(...vals);
  return lastInsertRowid;
}

function listLeadsForRun(runId) {
  return getDb()
    .prepare(
      `SELECT * FROM outbound_leads WHERE run_id = ?
       ORDER BY ${freshnessRank()} ASC, score DESC, id ASC`
    )
    .all(runId)
    .map(hydrateLead);
}

// Pipeline view: all leads for a user's runs, newest run first then by score,
// optionally filtered by lead status.
function listLeadsForUser(userId, { status } = {}) {
  const db = getDb();
  const params = [userId];
  let sql = `SELECT l.* FROM outbound_leads l
             JOIN outbound_runs r ON r.id = l.run_id
             WHERE r.created_by = ?`;
  if (status) { sql += ' AND l.status = ?'; params.push(status); }
  // Freshness first (rule 3): newest triggers lead the pipeline, then score, then
  // most recent run as the final tiebreaker.
  sql += ` ORDER BY ${freshnessRank('l.')} ASC, l.score DESC, l.run_id DESC, l.id ASC`;
  return db.prepare(sql).all(...params).map(hydrateLead);
}

function getLeadForUser(id, userId) {
  const row = getDb().prepare(
    `SELECT l.* FROM outbound_leads l
     JOIN outbound_runs r ON r.id = l.run_id
     WHERE l.id = ? AND r.created_by = ?`
  ).get(id, userId);
  return row ? hydrateLead(row) : null;
}

const LEAD_STATUSES = ['new', 'contacted', 'replied', 'skipped'];

// Patch status and/or notes for a lead the user owns. Returns the updated lead,
// or null if not found. Ignores unknown/invalid fields.
function updateLeadForUser(id, userId, { status, notes }) {
  const existing = getLeadForUser(id, userId);
  if (!existing) return null;
  const sets = [];
  const vals = [];
  if (status !== undefined && LEAD_STATUSES.includes(status)) { sets.push('status = ?'); vals.push(status); }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(String(notes).slice(0, 2000)); }
  if (sets.length) {
    vals.push(id);
    getDb().prepare(`UPDATE outbound_leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return getLeadForUser(id, userId);
}

// Replace the generated draft (and optional channel) after a redraft.
//
// `subject` is written whenever the key is present, including as null: a redraft
// from email to linkedin has no subject, and leaving the old email subject in
// place would attach it to a message that cannot carry one.
function updateLeadDraft(id, { draft, channel, confidence, subject } = {}) {
  const sets = ['draft = ?'];
  const vals = [draft];
  if (subject !== undefined) { sets.push('draft_subject = ?'); vals.push(subject || null); }
  if (channel) { sets.push('channel = ?'); vals.push(channel); }
  if (confidence) { sets.push('confidence = ?'); vals.push(confidence); }
  vals.push(id);
  getDb().prepare(`UPDATE outbound_leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function hydrateLead(row) {
  return { ...row, score_breakdown: parseJson(row.score_breakdown, {}) };
}

module.exports = {
  createRun, getRun, getRunForUser, listRunsForUser, updateRun,
  insertLead, listLeadsForRun, listLeadsForUser, getLeadForUser,
  updateLeadForUser, updateLeadDraft,
  LEAD_STATUSES,
};
