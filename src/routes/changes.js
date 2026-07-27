const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { getWorkspaceTier, maxPages, workspaceOwnerIsPrivileged } = require('../lib/tierLimits');

function parseChange(c) {
  return {
    ...c,
    analysis: c.analysis ? JSON.parse(c.analysis) : null,
    talking_points: c.talking_points ? JSON.parse(c.talking_points) : [],
    diff_summary: c.diff_summary ? JSON.parse(c.diff_summary) : null,
  };
}

router.get('/', (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const threat = req.query.threat;
  const competitorId = req.query.competitor_id;

  const conditions = ['c.user_id = ?'];
  const params = [req.userId];

  if (threat && ['low', 'medium', 'high'].includes(threat)) {
    conditions.push('ch.threat_level = ?');
    params.push(threat);
  }
  if (competitorId) {
    conditions.push('ch.competitor_id = ?');
    params.push(competitorId);
  }
  // Trivial (AI-downgraded / pre-AI-gated) changes are hidden from every
  // customer-facing view. They stay in the table for audit but are NEVER
  // returned here, regardless of query params. Legacy NULL rows (pre-Phase 4)
  // count as meaningful so existing history isn't hidden.
  conditions.push('(ch.is_meaningful IS NULL OR ch.is_meaningful = 1)');

  const where = conditions.join(' AND ');

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    WHERE ${where}
  `).get(...params).n;

  // Baseline rows ARE returned here. They are the "monitoring started" marker
  // that keeps a brand-new dashboard from looking broken, and the client renders
  // them as a baseline rather than as a change. They carry a NULL threat_level,
  // so any threat filter above already excludes them.
  const rows = db.prepare(`
    SELECT ch.id, ch.competitor_id, ch.threat_level, ch.headline, ch.recommended_response,
      ch.talking_points, ch.analysis, ch.diff_summary, ch.detected_at,
      ch.is_meaningful, ch.is_baseline, ch.gate_category, ch.gate_reason,
      c.name AS competitor_name, c.url AS competitor_url
    FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    WHERE ${where}
    ORDER BY ch.detected_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ changes: rows.map(parseChange), total, page, limit, pages: Math.ceil(total / limit) });
});

router.get('/stats', (req, res) => {
  const db = getDb();
  const uid = req.userId;

  // Each competitors row is a monitored PAGE. pages_used is the billable count
  // (what the plan page limit caps); competitor_count is the number of distinct
  // companies (groups) those pages are organized under.
  const total_competitors = db.prepare('SELECT COUNT(*) AS n FROM competitors WHERE user_id = ?').get(uid).n;
  const active_competitors = db.prepare('SELECT COUNT(*) AS n FROM competitors WHERE user_id = ? AND active = 1').get(uid).n;
  const pages_used = total_competitors;
  const competitor_count = db.prepare(
    'SELECT COUNT(DISTINCT COALESCE(group_id, -id)) AS n FROM competitors WHERE user_id = ?'
  ).get(uid).n;
  // Phase 4: dashboard counters reflect MEANINGFUL changes only — trivial
  // gated rows shouldn't inflate the "high threats" and "changes this week"
  // numbers users glance at. Legacy NULL rows count as meaningful so the
  // migration doesn't suddenly empty out historical dashboards.
  // A baseline row is a snapshot, not a change, so it never counts toward any
  // of these numbers. Legacy NULL rows count as changes (existing history is
  // left exactly as it was).
  const meaningfulOnly = `(ch.is_meaningful IS NULL OR ch.is_meaningful = 1) AND COALESCE(ch.is_baseline, 0) = 0`;

  const total_changes = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE c.user_id = ? AND ${meaningfulOnly}
  `).get(uid).n;
  const changes_this_week = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE c.user_id = ? AND ${meaningfulOnly} AND ch.detected_at >= datetime('now', '-7 days')
  `).get(uid).n;
  const high_threats = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE c.user_id = ? AND ${meaningfulOnly} AND ch.threat_level = 'high'
  `).get(uid).n;
  const medium_threats = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE c.user_id = ? AND ${meaningfulOnly} AND ch.threat_level = 'medium'
  `).get(uid).n;
  // Pages whose baseline snapshot has been captured. Lets the dashboard say
  // monitoring is live and watching from a known starting point, even before
  // anything has changed.
  const baselined_pages = db.prepare(`
    SELECT COUNT(DISTINCT ch.competitor_id) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE c.user_id = ? AND COALESCE(ch.is_baseline, 0) = 1
  `).get(uid).n;
  const trivial_changes = db.prepare(`
    SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE c.user_id = ? AND ch.is_meaningful = 0
  `).get(uid).n;

  // Tier and competitor cap come from the SAME authoritative source the rest of
  // the app uses (getWorkspaceTier → workspace subscription state), not the
  // deprecated users.tier column. This keeps the dashboard slot counter in sync
  // with the sidebar/Settings/Profile plan labels and survives the Dodo
  // migration (Dodo writes subscription_tier via webhook → getWorkspaceTier).
  // The billable unit is a PAGE. max_pages of -1 means unlimited; null means a
  // not-yet-configured (TODO) tier cap (team/business), also treated as no cap.
  const tier = getWorkspaceTier(req.workspaceId);
  // A privileged workspace (admin / developer override) has no enforced page cap
  // in canAddPage, so it can legitimately exceed the nominal tier limit. Report
  // -1 (unlimited) here so the usage banner shows the uncapped state instead of a
  // false over-limit reading like "17 of 15". Normal accounts get the tier cap.
  const max_pages = workspaceOwnerIsPrivileged(req.workspaceId) ? -1 : maxPages(req.workspaceId);

  res.json({
    total_competitors, active_competitors, total_changes, changes_this_week,
    high_threats, medium_threats, trivial_changes, baselined_pages, tier,
    // Page-based fields (billable unit) plus the company count for display.
    pages_used, max_pages, competitor_count,
    // Deprecated alias kept for any older consumer; equals max_pages now.
    max_competitors: max_pages,
  });
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT ch.*, c.name AS competitor_name, c.url AS competitor_url, c.description AS competitor_description,
           uc.company_name AS user_company_name
    FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    LEFT JOIN user_context uc ON uc.user_id = c.user_id
    WHERE ch.id = ? AND c.user_id = ?
  `).get(req.params.id, req.userId);

  if (!row) return res.status(404).json({ error: 'Not found' });

  // Phase 5: include the 5 most-recent prior changes for the same competitor
  // so the battle card can render a "Recent changes from this competitor"
  // strip without a separate round-trip. Always scoped to user_id via the
  // competitors join we already performed above. The baseline snapshot is
  // excluded: this strip lists changes, and a baseline is not one.
  const recentRows = db.prepare(`
    SELECT ch.id, ch.detected_at, ch.threat_level, ch.headline, ch.pattern_tags, ch.is_meaningful
    FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    WHERE ch.competitor_id = ?
      AND c.user_id = ?
      AND ch.id != ?
      AND ch.detected_at < ?
      AND (ch.is_meaningful IS NULL OR ch.is_meaningful = 1)
      AND COALESCE(ch.is_baseline, 0) = 0
    ORDER BY ch.detected_at DESC
    LIMIT 5
  `).all(row.competitor_id, req.userId, row.id, row.detected_at);

  const recent_changes = recentRows.map(r => ({
    id: r.id,
    detected_at: r.detected_at,
    threat_level: r.threat_level || 'low',
    headline: r.headline || '',
    pattern_tags: (() => {
      try { return r.pattern_tags ? JSON.parse(r.pattern_tags) : []; } catch (_) { return []; }
    })(),
  }));

  const parsed = parseChange(row);
  // Surface pattern_tags on the change object too (parsed from the raw column).
  let pattern_tags = [];
  try { pattern_tags = row.pattern_tags ? JSON.parse(row.pattern_tags) : []; } catch (_) {}
  res.json({ ...parsed, pattern_tags, recent_changes });
});

module.exports = router;
