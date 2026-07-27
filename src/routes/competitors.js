const express = require('express');
const router  = express.Router();
const { getDb, extractDomainFromUrl } = require('../db');
const { checkCompetitor }  = require('../scheduler');
const { canAddPage, canAddPageToCompetitor, MAX_PAGES_PER_COMPETITOR, upgradeRequired, getWorkspaceTier } = require('../lib/tierLimits');
const { logAudit } = require('../lib/audit');
const { getCompetitorHistory, generatePatternCallouts } = require('../historicalContext');
const { normalizeCompetitorUrl, canonicalUrlKey } = require('../lib/urlNormalize');

// ── Input validation ───────────────────────────────────────────────────────────

// Returns the id of an existing competitor whose URL is the same site as `url`
// after normalization (scheme/www/trailing-slash insensitive, path-sensitive),
// or null. `excludeId` skips a row (used on edit so a competitor isn't flagged a
// duplicate of itself). Scoped to the user so it only considers their own list.
function findDuplicateUrl(db, userId, url, excludeId = null) {
  const key = canonicalUrlKey(url);
  if (!key) return null;
  const rows = db.prepare('SELECT id, url FROM competitors WHERE user_id = ?').all(userId);
  for (const r of rows) {
    if (excludeId != null && r.id === excludeId) continue;
    if (canonicalUrlKey(r.url) === key) return r.id;
  }
  return null;
}

// ── Grouped-competitor helpers ────────────────────────────────────────────────
// A competitor (company) is a competitor_groups row; each monitored page is a
// competitors row linked by group_id. Pages, not groups, count toward the plan
// page limit (see src/lib/tierLimits.js).

// Number of monitored pages currently under one competitor (group).
function pagesInGroup(db, groupId) {
  if (!groupId) return 0;
  return db.prepare('SELECT COUNT(*) AS n FROM competitors WHERE group_id = ?').get(groupId).n;
}

// Total monitored pages in the workspace — the value compared against the plan
// page limit. Archived pages (trial expiry keeps them read-only above the Free
// cap) do not count: they are not monitored and must not block the one slot
// the Free plan grants.
function workspacePageCount(db, workspaceId) {
  return db.prepare('SELECT COUNT(*) AS n FROM competitors WHERE workspace_id = ? AND COALESCE(archived, 0) = 0').get(workspaceId).n;
}

// Archived competitor page matching this URL (same canonicalization as
// findDuplicateUrl), or null. Re-adding a previously archived domain restores
// the original row, and with it the full change timeline: that is the backfill
// path for "prior snapshots exist for this domain".
function findArchivedByUrl(db, workspaceId, url) {
  const key = canonicalUrlKey(url);
  if (!key) return null;
  const rows = db.prepare('SELECT * FROM competitors WHERE workspace_id = ? AND COALESCE(archived, 0) = 1').all(workspaceId);
  for (const r of rows) {
    if (canonicalUrlKey(r.url) === key) return r;
  }
  return null;
}

// Find an existing competitor (group) for this user by case-insensitive name, or
// null. Lets "attach a page" reuse a company the user already tracks instead of
// creating a duplicate group.
function findGroupByName(db, userId, name) {
  return db.prepare(
    'SELECT * FROM competitor_groups WHERE user_id = ? AND LOWER(name) = LOWER(?) ORDER BY id LIMIT 1'
  ).get(userId, name) || null;
}

// Returns { value, error }. value is always 'fetch' or 'js'; defaults to 'fetch' when missing.
function validateRenderMode(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: 'fetch', error: null };
  const s = String(raw).trim().toLowerCase();
  if (s !== 'fetch' && s !== 'js') return { value: null, error: 'render_mode must be "fetch" or "js"' };
  return { value: s, error: null };
}

// Returns { value, error }. `value === null` means "no selector / clear it".
function validateCssSelector(raw) {
  if (raw === undefined || raw === null) return { value: null, error: null };
  const s = String(raw).trim();
  if (s.length === 0) return { value: null, error: null };
  if (s.length > 200) return { value: null, error: 'CSS selector must be 200 characters or fewer' };
  // Anything that smells like injection / template breakage is rejected.
  // We are deliberately permissive about CSS punctuation: . # > + ~ [ ] = " ' : ( ) , whitespace.
  if (/<\/?script/i.test(s))                     return { value: null, error: 'CSS selector must not contain script tags' };
  if (s.includes('`'))                            return { value: null, error: 'CSS selector must not contain backticks' };
  if (/[{}]/.test(s))                             return { value: null, error: 'CSS selector must not contain { or }' };
  if (/javascript:/i.test(s))                     return { value: null, error: 'CSS selector must not contain javascript: URIs' };
  return { value: s, error: null };
}

// ── Routes — all queries include user_id to prevent IDOR ──────────────────────

router.get('/', (req, res) => {
  const db   = getDb();

  // Restore on upgrade: the moment the workspace is entitled beyond Free
  // (paid subscription or admin/developer override), any competitors archived
  // at trial expiry come back automatically, timeline intact.
  if (getWorkspaceTier(req.workspaceId) !== 'free') {
    db.prepare('UPDATE competitors SET archived = 0 WHERE workspace_id = ? AND COALESCE(archived, 0) = 1').run(req.workspaceId);
  }

  // change_count and the "last change" fields feed customer-facing counts and
  // badges, so they exclude trivial (AI-downgraded / pre-AI-gated) changes.
  // Those rows are retained in the table for audit but never surfaced to users.
  // They also exclude the monitoring baseline, which is a snapshot rather than
  // a change: a page that has only ever been baselined reports 0 changes and no
  // last alert, and surfaces baseline_at instead.
  // (MEANINGFUL is a fixed literal, not user input — no injection surface.)
  const MEANINGFUL = '(is_meaningful IS NULL OR is_meaningful = 1) AND COALESCE(is_baseline, 0) = 0';
  // Each row is a monitored PAGE. group_id + group_name identify the competitor
  // (company) it belongs to; the frontend groups pages by group_id. group_name
  // comes from the canonical competitor_groups row so a rename stays consistent.
  const rows = db.prepare(`
    SELECT c.*,
      g.name        AS group_name,
      g.description AS group_description,
      (SELECT COUNT(*) FROM changes WHERE competitor_id = c.id AND ${MEANINGFUL}) AS change_count,
      (SELECT headline     FROM changes WHERE competitor_id = c.id AND ${MEANINGFUL} ORDER BY detected_at DESC LIMIT 1) AS last_headline,
      (SELECT threat_level FROM changes WHERE competitor_id = c.id AND ${MEANINGFUL} ORDER BY detected_at DESC LIMIT 1) AS last_threat,
      (SELECT detected_at  FROM changes WHERE competitor_id = c.id AND ${MEANINGFUL} ORDER BY detected_at DESC LIMIT 1) AS last_change_at,
      (SELECT detected_at  FROM changes WHERE competitor_id = c.id AND COALESCE(is_baseline, 0) = 1 ORDER BY detected_at DESC LIMIT 1) AS baseline_at
    FROM competitors c
    LEFT JOIN competitor_groups g ON g.id = c.group_id
    WHERE c.user_id = ?
    ORDER BY COALESCE(g.name, c.name) COLLATE NOCASE ASC, c.created_at DESC
  `).all(req.userId);
  res.json(rows);
});

// Add a monitored PAGE. Two ways to say which competitor (company) it belongs to:
//   • group_id  → attach the page to an existing competitor the user owns.
//   • name      → create a new competitor, or reuse an existing one of the same
//                 name (case-insensitive) if it already exists.
// page_label is an optional per-page label ("Pricing", "Changelog"). Pages, not
// competitors, count toward the plan page limit; a single competitor holds at
// most MAX_PAGES_PER_COMPETITOR pages.
router.post('/', (req, res) => {
  const db          = getDb();
  const name        = String(req.body.name        || '').trim();
  const url         = String(req.body.url         || '').trim();
  const description = String(req.body.description || '').trim();
  const pageLabel   = String(req.body.page_label  || '').trim();
  const rawGroupId  = req.body.group_id;

  // URL is always required.
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (pageLabel.length   > 100)  return res.status(400).json({ error: 'page label must be 100 characters or fewer' });
  if (description.length > 500)  return res.status(400).json({ error: 'description must be 500 characters or fewer' });

  // Resolve the target competitor (group). Either an existing group_id the user
  // owns, or a name (reused if present, otherwise created after the cap checks).
  let group = null;      // existing group row, if any
  let createName = null; // name to create a new group with, if group is null
  if (rawGroupId !== undefined && rawGroupId !== null && String(rawGroupId) !== '') {
    const gid = parseInt(rawGroupId, 10);
    if (!Number.isInteger(gid)) return res.status(400).json({ error: 'invalid group_id' });
    group = db.prepare('SELECT * FROM competitor_groups WHERE id = ? AND user_id = ?').get(gid, req.userId);
    if (!group) return res.status(404).json({ error: 'Competitor not found' });
  } else {
    if (!name) return res.status(400).json({ error: 'name (or group_id) is required' });
    if (name.length > 100) return res.status(400).json({ error: 'name must be 100 characters or fewer' });
    group = findGroupByName(db, req.userId, name); // reuse if the company already exists
    if (!group) createName = name;
  }

  // URL normalization + completion. The user may type a bare domain ("apple.com")
  // or a full URL; we complete a missing scheme to https and store the cleaned,
  // monitorable form. Length is checked inside on the raw input.
  const norm = normalizeCompetitorUrl(url);
  if (norm.error) return res.status(400).json({ error: norm.error });
  const normalizedUrl = norm.url;

  // Optional CSS selector
  const sel = validateCssSelector(req.body.css_selector);
  if (sel.error) return res.status(400).json({ error: sel.error });

  // Optional render_mode — defaults to 'fetch'
  const rm = validateRenderMode(req.body.render_mode);
  if (rm.error) return res.status(400).json({ error: rm.error });

  // Re-adding a domain that was archived at trial expiry RESTORES the original
  // row instead of creating a fresh one, so the full change timeline for that
  // domain comes back with it (the "prior snapshots exist" backfill path).
  // Must run before duplicate detection, which would otherwise 409 on the
  // archived row. Restoring consumes a live page slot, so the plan cap applies.
  const archivedMatch = findArchivedByUrl(db, req.workspaceId, normalizedUrl);
  if (archivedMatch) {
    const livePages = workspacePageCount(db, req.workspaceId);
    if (!canAddPage(req.workspaceId, livePages)) {
      logAudit({ workspaceId: req.workspaceId, userId: req.userId, eventType: 'gate_violation', eventData: { feature: 'add_competitor', pages: livePages, restore: true }, req });
      return upgradeRequired(res, 'add_competitor');
    }
    db.prepare('UPDATE competitors SET archived = 0, active = 1 WHERE id = ?').run(archivedMatch.id);
    const restoredRow = db.prepare('SELECT * FROM competitors WHERE id = ?').get(archivedMatch.id);
    const restoredGroup = restoredRow.group_id
      ? db.prepare('SELECT name FROM competitor_groups WHERE id = ?').get(restoredRow.group_id)
      : null;
    return res.status(200).json({ ...restoredRow, group_name: restoredGroup?.name || restoredRow.name, restored: true });
  }

  // Duplicate detection uses the same normalization, so "apple.com" is caught as
  // a duplicate of an existing "https://www.apple.com".
  if (findDuplicateUrl(db, req.userId, normalizedUrl) != null) {
    return res.status(409).json({ error: 'You are already monitoring this URL.' });
  }

  // Cost-safe cap 1: total PAGES against the plan page limit. Pages are the
  // billable unit, so grouping never grants extra monitoring.
  const pageCount = workspacePageCount(db, req.workspaceId);
  if (!canAddPage(req.workspaceId, pageCount)) {
    logAudit({ workspaceId: req.workspaceId, userId: req.userId, eventType: 'gate_violation', eventData: { feature: 'add_competitor', pages: pageCount }, req });
    return upgradeRequired(res, 'add_competitor');
  }

  // Cost-safe cap 2: at most MAX_PAGES_PER_COMPETITOR pages under one competitor.
  // Upgrading does not lift this structural cap, so it is a plain 400 (not a 402
  // upgrade gate) with a clear, actionable message.
  const groupPages = group ? pagesInGroup(db, group.id) : 0;
  if (!canAddPageToCompetitor(req.workspaceId, groupPages)) {
    return res.status(400).json({
      error: 'per_competitor_limit',
      message: `This competitor already has the maximum of ${MAX_PAGES_PER_COMPETITOR} monitored pages. Create a separate competitor to track more pages.`,
    });
  }

  // Create the competitor (group) now that both caps have passed, so a blocked
  // add never leaves an empty group behind.
  if (!group) {
    const g = db.prepare(
      'INSERT INTO competitor_groups (user_id, workspace_id, name, description) VALUES (?, ?, ?, ?)'
    ).run(req.userId, req.workspaceId, createName, description || null);
    group = db.prepare('SELECT * FROM competitor_groups WHERE id = ?').get(g.lastInsertRowid);
  }

  const domain = extractDomainFromUrl(normalizedUrl);

  // competitors.name mirrors the group's company name so every existing consumer
  // that reads competitors.name keeps showing the company. page_label labels the
  // individual page.
  const result = db.prepare(
    'INSERT INTO competitors (user_id, workspace_id, group_id, page_label, name, url, description, css_selector, render_mode, domain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.userId, req.workspaceId, group.id, pageLabel || null, group.name, normalizedUrl, description || null, sel.value, rm.value, domain);

  const created = db.prepare('SELECT * FROM competitors WHERE id = ?').get(result.lastInsertRowid);

  // Run the first check immediately rather than at the next scheduled run, so
  // the page's baseline snapshot is captured within minutes of it being added.
  // That first check is silent by design: it records the starting state and
  // shows a "baseline captured" row, and never reports pre-existing content as
  // a change. Briefs start at the next check, if the page actually differs.
  // Fire-and-forget: the add response never blocks on the fetch.
  setImmediate(() => {
    checkCompetitor(created, db).catch(err => {
      console.error(`First check failed for competitor ${created.id}:`, err.message);
    });
  });

  res.status(201).json({ ...created, group_name: group.name });
});

router.put('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Archived (trial expiry) rows are read-only: visible, never editable.
  if (row.archived) {
    return res.status(403).json({ error: 'This competitor is archived on the Free plan. Upgrade to Pro to restore and edit it.' });
  }

  let name        = row.name;
  let url         = row.url;
  let description = row.description;
  let cssSelector = row.css_selector;
  let renderMode  = row.render_mode || 'fetch';
  let pageLabel   = row.page_label;
  let resetHash   = false;

  if (req.body.name !== undefined) {
    name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    if (name.length > 100) return res.status(400).json({ error: 'name must be 100 characters or fewer' });
  }

  if (req.body.page_label !== undefined) {
    const pl = String(req.body.page_label).trim();
    if (pl.length > 100) return res.status(400).json({ error: 'page label must be 100 characters or fewer' });
    pageLabel = pl || null;
  }

  if (req.body.url !== undefined) {
    const rawUrl = String(req.body.url).trim();
    if (!rawUrl) return res.status(400).json({ error: 'url cannot be empty' });
    // Same completion + validation as add: accept a bare domain, store the
    // cleaned URL. Length is checked inside normalizeCompetitorUrl.
    const norm = normalizeCompetitorUrl(rawUrl);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const newUrl = norm.url;
    // Reject an edit that would collide with another competitor (same normalized
    // site), excluding this row so an unchanged URL is never a self-duplicate.
    if (findDuplicateUrl(db, req.userId, newUrl, row.id) != null) {
      return res.status(409).json({ error: 'You are already monitoring this URL.' });
    }
    if (newUrl !== url) resetHash = true;
    url = newUrl;
  }

  if (req.body.description !== undefined) {
    const d = String(req.body.description).trim();
    if (d.length > 500) return res.status(400).json({ error: 'description must be 500 characters or fewer' });
    description = d || null;
  }

  if (req.body.css_selector !== undefined) {
    const sel = validateCssSelector(req.body.css_selector);
    if (sel.error) return res.status(400).json({ error: sel.error });
    if (sel.value !== cssSelector) resetHash = true;
    cssSelector = sel.value;
  }

  if (req.body.render_mode !== undefined) {
    const rm = validateRenderMode(req.body.render_mode);
    if (rm.error) return res.status(400).json({ error: rm.error });
    // Switching render mode changes how content is extracted, so the prior
    // hash is no longer comparable — clear the baseline.
    if (rm.value !== renderMode) resetHash = true;
    renderMode = rm.value;
  }

  // Re-derive bare domain if URL changed. Cheap; keeps attendee matching in
  // sync with whatever the competitor's primary URL now points at.
  const domain = extractDomainFromUrl(url);

  // When URL, selector, or render mode changes, the previous baseline is no
  // longer comparable. Clear it so the next check captures a fresh baseline
  // rather than firing a bogus "change detected" against content from a
  // different region or rendering pipeline.
  if (resetHash) {
    db.prepare(`
      UPDATE competitors
      SET name = ?, url = ?, description = ?, css_selector = ?, render_mode = ?, domain = ?, page_label = ?,
          last_content_hash = NULL, last_check_status = NULL, last_check_error = NULL
      WHERE id = ?
    `).run(name, url, description, cssSelector, renderMode, domain, pageLabel, row.id);
  } else {
    db.prepare(`
      UPDATE competitors
      SET name = ?, url = ?, description = ?, css_selector = ?, render_mode = ?, domain = ?, page_label = ?
      WHERE id = ?
    `).run(name, url, description, cssSelector, renderMode, domain, pageLabel, row.id);
  }

  // The company name is denormalized onto every page in the group, so a rename
  // must propagate to the canonical group row and all sibling pages to keep the
  // grouped list consistent.
  if (req.body.name !== undefined && name !== row.name && row.group_id) {
    db.prepare('UPDATE competitor_groups SET name = ? WHERE id = ? AND user_id = ?').run(name, row.group_id, req.userId);
    db.prepare('UPDATE competitors SET name = ? WHERE group_id = ? AND user_id = ?').run(name, row.group_id, req.userId);
  }

  res.json(db.prepare('SELECT * FROM competitors WHERE id = ?').get(row.id));
});

router.get('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// Phase 5: chronological change history for a single competitor. Used by the
// timeline view on the competitor detail page. Scoped to user_id via the
// historicalContext helper (which joins on competitors.user_id).
router.get('/:id/history', (req, res) => {
  const db = getDb();
  const competitorId = parseInt(req.params.id, 10);
  if (!Number.isInteger(competitorId)) return res.status(400).json({ error: 'invalid id' });

  // 404 before fetching history — don't leak whether the id exists for a
  // different user.
  const own = db.prepare('SELECT id, name FROM competitors WHERE id = ? AND user_id = ?')
    .get(competitorId, req.userId);
  if (!own) return res.status(404).json({ error: 'Not found' });

  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 90));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 50));

  // includeBaseline: the timeline shows the monitoring baseline as its labelled
  // starting point, so a page that has not changed yet reads as "monitoring
  // started" instead of an empty list. hist.count still counts changes only.
  const hist = getCompetitorHistory(competitorId, { userId: req.userId, days, maxRows: limit, includeBaseline: true });
  res.json({
    competitor_id: competitorId,
    competitor_name: own.name,
    days,
    count: hist.count,
    truncated: hist.truncated,
    changes: hist.changes,
  });
});

// Phase 5: auto-generated pattern callouts for the competitor detail page.
// Derived inline from the cached history — cheap, no separate job needed.
router.get('/:id/patterns', (req, res) => {
  const db = getDb();
  const competitorId = parseInt(req.params.id, 10);
  if (!Number.isInteger(competitorId)) return res.status(400).json({ error: 'invalid id' });

  const own = db.prepare('SELECT id FROM competitors WHERE id = ? AND user_id = ?')
    .get(competitorId, req.userId);
  if (!own) return res.status(404).json({ error: 'Not found' });

  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 90));
  const hist = getCompetitorHistory(competitorId, { userId: req.userId, days });
  const callouts = generatePatternCallouts(hist.changes);

  res.json({ competitor_id: competitorId, days, callouts, source_count: hist.count });
});

router.delete('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT id FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM competitors WHERE id = ?').run(row.id);
  res.json({ success: true });
});

router.put('/:id/toggle', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.archived) {
    return res.status(403).json({ error: 'This competitor is archived on the Free plan. Upgrade to Pro to restore it.' });
  }
  const newActive = row.active ? 0 : 1;
  db.prepare('UPDATE competitors SET active = ? WHERE id = ?').run(newActive, row.id);
  res.json({ active: !!newActive });
});

router.post('/:id/check', async (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM competitors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.archived) {
    return res.status(403).json({ error: 'This competitor is archived on the Free plan. Upgrade to Pro to restore and check it.' });
  }

  // Respond immediately; run check in background. If this page has never been
  // captured (added before first-check-on-add existed, or its first fetch
  // failed), checkCompetitor records the baseline instead of diffing, so a
  // manual check can never turn pre-existing content into a change alert.
  res.json({ message: 'Check started', competitor_id: row.id });

  try {
    await checkCompetitor(row, db);
  } catch (err) {
    console.error(`Manual check failed for competitor ${row.id}:`, err.message);
  }
});

module.exports = router;
