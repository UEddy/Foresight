// Phase 5 — historical pattern analysis.
//
// Fetches a competitor's recent change history in a compact, prompt-ready form
// so the AI analyzer can reference prior moves ("third pricing change this
// quarter") instead of judging every diff in isolation.
//
// Security model: callers MUST pass the requesting user's id. The history
// query joins through the competitors table and filters on user_id, so a
// user cannot read another user's competitor history even by guessing ids.
//
// Caching: same competitor's history is requested both by the scheduler and
// by API endpoints. We memoize for 1 hour and offer an explicit invalidator
// that the scheduler calls after inserting a new change.

const { getDb } = require('./db');

const DEFAULT_DAYS = 90;
const DEFAULT_MAX_ROWS = 50;        // hard cap on prompt payload — keeps token cost bounded
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// In-process LRU-ish cache. Map preserves insertion order; we evict oldest when
// the cache grows past CACHE_MAX_ENTRIES.
const CACHE_MAX_ENTRIES = 500;
const cache = new Map(); // key: `${userId}:${competitorId}:${days}:${maxRows}` -> { value, expiresAt }

function cacheKey(competitorId, userId, days, maxRows, includeBaseline) {
  return `${userId}:${competitorId}:${days}:${maxRows}:${includeBaseline ? 'b1' : 'b0'}`;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh recency
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * Invalidate every cached history entry for a given competitor (across all
 * userId / days / maxRows variants). Called by the scheduler after inserting
 * a new change so the next analyzer call sees fresh data.
 */
function invalidateCompetitorHistory(competitorId) {
  const suffix = `:${competitorId}:`;
  for (const k of cache.keys()) {
    // keys look like `${userId}:${competitorId}:${days}:${maxRows}`
    if (k.includes(suffix)) cache.delete(k);
  }
}

/**
 * Fetch up to `maxRows` of a competitor's most recent changes within the last
 * `days` days, scoped to the requesting user.
 *
 * The monitoring baseline (the first snapshot of a newly added page) is NOT a
 * change and is excluded by default, so it never reaches an AI prompt as prior
 * history and never feeds pattern detection. Pass `includeBaseline: true` for
 * the timeline view, which shows it as the labelled starting point.
 *
 * Returns { changes, count, truncated, formatted } where:
 *   - changes: array of { id, detected_at, threat_level, pattern_tags, summary, is_meaningful, is_baseline }
 *   - count: number of rows returned
 *   - truncated: true if more rows existed than maxRows allowed
 *   - formatted: compact multi-line string ready to drop into an AI prompt
 *                (empty string when there is no prior history)
 *
 * The query always filters on user_id via the competitors join, so an attacker
 * cannot read another user's history by guessing a competitor id.
 */
function getCompetitorHistory(competitorId, options = {}) {
  const days = Number.isFinite(options.days) ? options.days : DEFAULT_DAYS;
  const maxRows = Math.min(
    Number.isFinite(options.maxRows) ? options.maxRows : DEFAULT_MAX_ROWS,
    DEFAULT_MAX_ROWS,
  );
  const userId = options.userId;
  const includeBaseline = options.includeBaseline === true;

  if (!Number.isInteger(competitorId)) {
    throw new Error('getCompetitorHistory: competitorId must be an integer');
  }
  if (!Number.isInteger(userId)) {
    throw new Error('getCompetitorHistory: userId must be an integer (required for tenant scoping)');
  }

  const key = cacheKey(competitorId, userId, days, maxRows, includeBaseline);
  const cached = cacheGet(key);
  if (cached) return { ...cached, cacheHit: true };

  const db = getDb();

  // user_id is enforced in the WHERE — even if competitorId is wrong, no rows
  // for another user will leak.
  const baselineClause = includeBaseline ? '' : 'AND COALESCE(ch.is_baseline, 0) = 0';
  const rows = db.prepare(`
    SELECT ch.id, ch.detected_at, ch.threat_level, ch.pattern_tags,
           ch.headline, ch.analysis, ch.is_meaningful, ch.is_baseline, ch.gate_category
    FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    WHERE ch.competitor_id = ?
      AND c.user_id = ?
      AND ch.detected_at >= datetime('now', ?)
      AND (ch.is_meaningful IS NULL OR ch.is_meaningful = 1)
      ${baselineClause}
    ORDER BY ch.detected_at DESC
    LIMIT ?
  `).all(competitorId, userId, `-${days} days`, maxRows + 1); // +1 to detect truncation

  const truncated = rows.length > maxRows;
  const trimmed = rows.slice(0, maxRows);

  const changes = trimmed.map(r => {
    let tags = [];
    try { tags = r.pattern_tags ? JSON.parse(r.pattern_tags) : []; } catch (_) { tags = []; }
    if (!Array.isArray(tags)) tags = [];

    // Prefer the AI's structured `changed_what` (1-sentence factual); fall back
    // to headline if analysis JSON is missing or malformed.
    let summary = r.headline || '';
    if (r.analysis) {
      try {
        const a = JSON.parse(r.analysis);
        if (a && typeof a.changed_what === 'string' && a.changed_what.trim()) {
          summary = a.changed_what.trim();
        }
      } catch (_) { /* fall through to headline */ }
    }

    const isBaseline = r.is_baseline === 1;

    return {
      id: r.id,
      detected_at: r.detected_at,
      // A baseline carries no threat level, and must not be defaulted into one.
      threat_level: isBaseline ? null : (r.threat_level || 'low'),
      pattern_tags: isBaseline ? [] : tags,
      summary: truncateSummary(summary, 220),
      is_meaningful: r.is_meaningful ?? 1,
      is_baseline: isBaseline,
    };
  });

  const result = {
    changes,
    // count is the number of CHANGES: a baseline row, when included for the
    // timeline, is the starting point rather than something that happened.
    count: changes.filter(c => !c.is_baseline).length,
    truncated,
    formatted: formatHistoryForPrompt(changes.filter(c => !c.is_baseline)),
    cacheHit: false,
  };

  cacheSet(key, result);
  return result;
}

function truncateSummary(s, max) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Build the prompt-ready block. Empty string when there is no history — the
 * caller decides whether to omit the section entirely so the AI is never
 * tempted to write "this is their first change" filler.
 */
function formatHistoryForPrompt(changes) {
  if (!changes || changes.length === 0) return '';

  const lines = changes.map(c => {
    const date = String(c.detected_at || '').slice(0, 10); // YYYY-MM-DD
    const threat = String(c.threat_level || 'low').toUpperCase();
    const tagSegment = c.pattern_tags.length > 0 ? ` [${c.pattern_tags.join(', ')}]` : '';
    return `- ${date} | ${threat}${tagSegment} | ${c.summary}`;
  });

  return lines.join('\n');
}

/**
 * Derive 0-3 short pattern callouts from a history (as returned by
 * getCompetitorHistory). Lightweight, pure, no I/O — safe to call inline
 * from a route handler. Returns [{ kind, label }].
 *
 * Rules (kept intentionally simple):
 *   - Any pattern tag appearing >= 2 times → "N <tag-as-label> in 90 days"
 *   - A directional tag (enterprise_push, smb_push, feature_launch) appearing
 *     in 3 of the most-recent 5 changes → trend callout
 *   - >= 3 high-threat changes in window → severity callout
 */
function generatePatternCallouts(input) {
  if (!Array.isArray(input) || input.length === 0) return [];
  // A baseline is the starting point, not a move the competitor made, so it can
  // never contribute to a pattern.
  const changes = input.filter(c => !c.is_baseline);
  if (changes.length === 0) return [];

  const tagCounts = {};
  for (const c of changes) {
    for (const t of (c.pattern_tags || [])) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }

  const callouts = [];

  const repeatLabels = {
    pricing_change:   'pricing change',
    plan_restructure: 'plan restructure',
    feature_launch:   'feature launch',
    feature_removal:  'feature removal',
    integration:      'integration announcement',
    partnership:      'partnership announcement',
    certification:    'certification update',
    comparison_page:  'comparison-page update',
  };
  for (const [tag, label] of Object.entries(repeatLabels)) {
    const n = tagCounts[tag] || 0;
    if (n >= 2) {
      callouts.push({
        kind: 'repeat',
        tag,
        label: `${n} ${label}${n === 1 ? '' : 's'} in 90 days`,
      });
    }
  }

  // Directional trend — a sustained push picked up by 3 of the last 5 changes.
  const recent5 = changes.slice(0, 5);
  const trendLabels = {
    enterprise_push: 'Steady shift toward enterprise messaging',
    smb_push:        'Steady shift toward SMB messaging',
    feature_launch:  'Sustained feature-launch cadence',
    positioning_shift: 'Ongoing positioning shift',
  };
  for (const [tag, label] of Object.entries(trendLabels)) {
    const n = recent5.filter(c => (c.pattern_tags || []).includes(tag)).length;
    if (n >= 3) {
      callouts.push({ kind: 'trend', tag, label });
    }
  }

  // Severity cadence.
  const highCount = changes.filter(c => c.threat_level === 'high').length;
  if (highCount >= 3) {
    callouts.push({
      kind: 'severity',
      tag: null,
      label: `${highCount} high-threat changes in 90 days`,
    });
  }

  // De-dupe by label, cap at 3.
  const seen = new Set();
  return callouts.filter(c => {
    if (seen.has(c.label)) return false;
    seen.add(c.label);
    return true;
  }).slice(0, 3);
}

// Test seam — lets tests reset state between cases.
function _clearCacheForTests() {
  cache.clear();
}

module.exports = {
  getCompetitorHistory,
  invalidateCompetitorHistory,
  formatHistoryForPrompt,
  generatePatternCallouts,
  _clearCacheForTests,
  DEFAULT_DAYS,
  DEFAULT_MAX_ROWS,
  CACHE_TTL_MS,
};
