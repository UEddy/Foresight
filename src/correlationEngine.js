// Phase 9 — win/loss correlation engine.
//
// PURE DATA ANALYSIS. No AI is called here by design (keeps AI cost out of this
// phase and keeps the math auditable). For every lost or stalled deal tied to a
// competitor, we look at that competitor's meaningful changes in the 30 days
// BEFORE the deal closed, classify each change (pricing / messaging / feature),
// and count how many losses line up with each kind of move. Confidence is a
// function of the count of supporting deals — nothing fancier, because Nivaria
// users will never have the sample sizes that real statistical inference needs.
//
// STATISTICAL HONESTY is enforced in the language: every description says
// "correlates with", never "caused". Small samples are flagged. Low-confidence
// patterns are returned but marked so the UI can de-emphasize them.
//
// SECURITY: every query is scoped by user_id. One user's deals/changes can never
// feed another user's correlations.

const { getDb } = require('./db');

// ── Change-type classification ───────────────────────────────────────────────
// A single change can map to several types (a repricing that also relaunches a
// plan is both pricing and messaging). We union all signals: pattern_tags first
// (the AI's structured vocabulary), then the pre-AI gate category, then the
// analysis key_changes categories as a fallback for older rows that predate
// pattern_tags.
//
// Two rules keep the buckets honest:
//   1. The `feature` bucket means a feature *launch*. It is set ONLY by an
//      explicit launch tag — never by a bare "features" key_change category,
//      which cannot tell a launch from a removal or an incidental line item
//      inside a pricing change. (A 30%-price-cut whose analysis happened to list
//      a "features" key_change was being mislabeled a feature launch.)
//   2. Feature *removals* / deprecations live in their own `removed` bucket so
//      they are never reported as launches.

const PATTERN_KINDS = ['pricing', 'messaging', 'feature', 'removed'];

const PRICING_TAGS   = new Set(['pricing_change', 'plan_restructure', 'tier_change']);
const FEATURE_TAGS   = new Set(['feature_launch', 'new_feature', 'capability_added', 'product_launch']);
const MESSAGING_TAGS = new Set([
  'messaging_shift', 'positioning_pivot', 'copy_change', 'headings_changed',
  // pre-existing vocabulary, kept so already-tagged rows still classify:
  'positioning_shift', 'messaging_refresh', 'enterprise_push', 'smb_push', 'comparison_page',
]);
const REMOVED_TAGS   = new Set(['removed_feature', 'feature_removed', 'feature_removal', 'deprecation']);

const PATTERN_TYPES = {
  pricing:   'pricing_change_correlated_with_losses',
  messaging: 'messaging_shift_correlated_with_losses',
  feature:   'feature_launch_correlated_with_losses',
  removed:   'feature_removal_correlated_with_losses',
};

const TYPE_LABEL = {
  pricing:   'pricing change',
  messaging: 'messaging or positioning shift',
  feature:   'feature launch',
  removed:   'feature removal or deprecation',
};

function classifyChangeTypes(row) {
  const types = new Set();

  let tags = [];
  try { tags = row.pattern_tags ? JSON.parse(row.pattern_tags) : []; } catch { tags = []; }
  if (!Array.isArray(tags)) tags = [];
  for (const raw of tags) {
    const t = String(raw || '').toLowerCase();
    if (PRICING_TAGS.has(t) || t === 'pricing' || t.startsWith('pricing_')) types.add('pricing');
    if (FEATURE_TAGS.has(t))   types.add('feature');
    if (MESSAGING_TAGS.has(t)) types.add('messaging');
    if (REMOVED_TAGS.has(t))   types.add('removed');
  }

  // Pre-AI gate category. Only the unambiguous pricing signal is mapped here;
  // 'headings_changed' as a raw gate signal is a detection mechanism (the page
  // headings moved), not a semantic classification, so it is left to the
  // pattern_tags / key_changes signals rather than forced into messaging.
  if (row.gate_category === 'pricing_pattern') types.add('pricing');

  // Fallback for legacy rows without pattern_tags: classify from the analysis
  // key_changes categories. Pricing and messaging categories are reasonably
  // unambiguous; a bare "features" category is deliberately NOT mapped to the
  // feature-launch bucket (see rule 1 above) — launch requires an explicit tag.
  let analysis = null;
  try { analysis = row.analysis ? JSON.parse(row.analysis) : null; } catch { analysis = null; }
  const kcs = analysis && Array.isArray(analysis.key_changes) ? analysis.key_changes : [];
  for (const kc of kcs) {
    const cat = String(kc?.category || '').toLowerCase();
    if (cat === 'pricing' || cat === 'plans' || cat === 'plan' || cat === 'tier') types.add('pricing');
    else if (cat === 'messaging' || cat === 'positioning' || cat === 'copy')      types.add('messaging');
    // 'features'/'feature' intentionally unmapped here — see rule 1.
  }

  return types;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function changesInWindow(db, userId, competitorId, closeDate, days = 30) {
  return db.prepare(`
    SELECT ch.id, ch.headline, ch.threat_level, ch.detected_at, ch.pattern_tags, ch.analysis, ch.gate_category
    FROM changes ch
    JOIN competitors c ON ch.competitor_id = c.id
    WHERE ch.competitor_id = ?
      AND c.user_id = ?
      AND (ch.is_meaningful IS NULL OR ch.is_meaningful = 1)
      AND COALESCE(ch.is_baseline, 0) = 0
      AND date(ch.detected_at) > date(?, ?)
      AND date(ch.detected_at) <= date(?)
    ORDER BY ch.detected_at DESC
  `).all(competitorId, userId, closeDate, `-${days} days`, closeDate);
}

function confidenceFor(supportingDealCount) {
  if (supportingDealCount >= 15) return 'high';
  if (supportingDealCount >= 6)  return 'medium';
  return 'low'; // 3-5 (groups with < 3 are never emitted)
}

function daysBetween(aIso, bDateStr) {
  const a = new Date(String(aIso).replace(' ', 'T'));
  const b = new Date(bDateStr + 'T00:00:00');
  return Math.abs((b - a) / (24 * 60 * 60 * 1000));
}

// Informational strength score (0..1) per supporting deal: rewards high-threat
// changes and recency relative to the close date. Not used to set confidence
// (that's count-based per spec), only surfaced so the UI can rank within a tier.
function scoreDeal(closeDate, typedChanges) {
  if (typedChanges.length === 0) return 0;
  const highCount = typedChanges.filter(c => c.threat_level === 'high').length;
  const minDays = Math.min(...typedChanges.map(c => daysBetween(c.detected_at, closeDate)));
  const recency = 1 - Math.min(minDays, 30) / 30;
  const severity = Math.min(highCount, 3) / 3;
  return Math.round((0.4 + 0.3 * severity + 0.3 * recency) * 100) / 100;
}

function describePattern(competitorName, type, supportingCount, totalAgainst, confidence) {
  const label = TYPE_LABEL[type];
  let desc = `${supportingCount} of your ${totalAgainst} tracked deals against ${competitorName} (lost or stalled) closed within 30 days of a ${label} by ${competitorName}. ` +
    `These outcomes correlate with ${competitorName}'s ${label} activity, but correlation does not prove it caused the result.`;
  if (confidence === 'low') {
    desc += ' Based on a small sample, so treat this as a signal to watch rather than a firm conclusion.';
  }
  return desc;
}

// ── Core computation ─────────────────────────────────────────────────────────

// Compute correlation patterns for one user. When persist=true (the default),
// the user's correlations table is fully rebuilt to match. Returns a rich
// in-memory result the ROI dashboard hydrates from directly.
function computeCorrelationsForUser(userId, { persist = true } = {}) {
  const start = Date.now();
  const db = getDb();

  const deals = db.prepare('SELECT * FROM deals WHERE user_id = ?').all(userId);
  const totalDeals = deals.length;

  const lostStalledTagged = deals.filter(d => (d.outcome === 'lost' || d.outcome === 'stalled') && d.competitor_id);
  const lostTagged = deals.filter(d => d.outcome === 'lost' && d.competitor_id);
  const distinctCompetitors = new Set(lostStalledTagged.map(d => d.competitor_id)).size;

  // Engine gate: at least 5 logged deals AND at least 3 lost deals tagged to a
  // competitor. Below this we refuse to invent patterns from noise.
  const gateMet = totalDeals >= 5 && lostTagged.length >= 3;

  if (!gateMet) {
    if (persist) db.prepare('DELETE FROM correlations WHERE user_id = ?').run(userId);
    const reason = totalDeals < 5 ? 'need_5_deals' : 'need_3_lost_tagged';
    console.log(`🔗 Correlation run: user=${userId} deals=${totalDeals} lost_tagged=${lostTagged.length} GATE_NOT_MET (${reason}) ${Date.now() - start}ms`);
    return {
      ran: false, reason, total_deals: totalDeals,
      lost_tagged: lostTagged.length, lost_stalled_tagged: lostStalledTagged.length,
      distinct_competitors: distinctCompetitors, patterns: [],
    };
  }

  // Total lost/stalled deals per competitor — denominator for "X of Y".
  const totalAgainst = {};
  for (const d of lostStalledTagged) {
    totalAgainst[d.competitor_id] = (totalAgainst[d.competitor_id] || 0) + 1;
  }

  // Accumulate supporting deals per (competitor, type).
  const groups = new Map(); // key `${competitorId}:${type}`
  for (const deal of lostStalledTagged) {
    const windowChanges = changesInWindow(db, userId, deal.competitor_id, deal.close_date, 30);
    const typedFor = Object.fromEntries(PATTERN_KINDS.map(k => [k, []]));
    for (const ch of windowChanges) {
      for (const t of classifyChangeTypes(ch)) typedFor[t].push(ch);
    }
    for (const type of PATTERN_KINDS) {
      const typed = typedFor[type];
      if (typed.length === 0) continue;
      const key = `${deal.competitor_id}:${type}`;
      if (!groups.has(key)) {
        groups.set(key, {
          competitorId: deal.competitor_id, type,
          dealIds: new Set(), changeIds: new Set(), valueSum: 0, valuedDeals: 0, scores: [],
        });
      }
      const g = groups.get(key);
      g.dealIds.add(deal.id);
      typed.forEach(c => g.changeIds.add(c.id));
      if (deal.deal_value_usd != null) { g.valueSum += deal.deal_value_usd; g.valuedDeals += 1; }
      g.scores.push(scoreDeal(deal.close_date, typed));
    }
  }

  // Names for description rendering.
  const compNames = {};
  for (const id of new Set(lostStalledTagged.map(d => d.competitor_id))) {
    const r = db.prepare('SELECT name FROM competitors WHERE id = ? AND user_id = ?').get(id, userId);
    compNames[id] = r ? r.name : `Competitor #${id}`;
  }

  // Emit a pattern for every group with >= 3 supporting deals.
  const patterns = [];
  for (const g of groups.values()) {
    const supportingCount = g.dealIds.size;
    if (supportingCount < 3) continue;
    const confidence = confidenceFor(supportingCount);
    const estImpact = g.valuedDeals > 0 ? g.valueSum : null;
    const name = compNames[g.competitorId];
    patterns.push({
      competitor_id: g.competitorId,
      competitor_name: name,
      pattern_type: PATTERN_TYPES[g.type],
      type_key: g.type,
      pattern_description: describePattern(name, g.type, supportingCount, totalAgainst[g.competitorId], confidence),
      confidence,
      estimated_impact_usd: estImpact,
      supporting_deal_ids: [...g.dealIds],
      supporting_change_ids: [...g.changeIds],
      avg_strength: g.scores.length ? Math.round((g.scores.reduce((a, b) => a + b, 0) / g.scores.length) * 100) / 100 : 0,
    });
  }

  // Sort: confidence DESC, then estimated impact DESC.
  const confRank = { high: 3, medium: 2, low: 1 };
  patterns.sort((a, b) =>
    (confRank[b.confidence] - confRank[a.confidence]) ||
    ((b.estimated_impact_usd || 0) - (a.estimated_impact_usd || 0))
  );

  if (persist) persistCorrelations(userId, patterns);

  console.log(`🔗 Correlation run: user=${userId} deals_scanned=${lostStalledTagged.length} lost_tagged=${lostTagged.length} patterns=${patterns.length} (${patterns.map(p => p.confidence).join('/') || 'none'}) ${Date.now() - start}ms`);

  return {
    ran: true, reason: null, total_deals: totalDeals,
    lost_tagged: lostTagged.length, lost_stalled_tagged: lostStalledTagged.length,
    distinct_competitors: distinctCompetitors, patterns,
  };
}

function persistCorrelations(userId, patterns) {
  const db = getDb();
  db.prepare('DELETE FROM correlations WHERE user_id = ?').run(userId);
  const insert = db.prepare(`
    INSERT INTO correlations (user_id, competitor_id, pattern_type, pattern_description, confidence,
      supporting_deal_ids, supporting_change_ids, estimated_impact_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of patterns) {
    insert.run(
      userId, p.competitor_id, p.pattern_type, p.pattern_description, p.confidence,
      JSON.stringify(p.supporting_deal_ids), JSON.stringify(p.supporting_change_ids),
      p.estimated_impact_usd,
    );
  }
}

// ── Dashboard assembly ───────────────────────────────────────────────────────

// Build the full ROI dashboard payload for a user. Recomputes fresh (cheap,
// no AI) and persists as a side effect, then hydrates supporting deals/changes.
function getRoiDashboard(userId) {
  const db = getDb();
  const result = computeCorrelationsForUser(userId, { persist: true });

  const status = result.total_deals === 0 ? 'empty' : (result.ran ? 'ok' : 'insufficient');

  // Date range across all logged deals (for the "based on N deals over [range]").
  const range = db.prepare('SELECT MIN(close_date) AS from_date, MAX(close_date) AS to_date FROM deals WHERE user_id = ?').get(userId);

  const strongPatterns = result.patterns.filter(p => p.confidence === 'medium' || p.confidence === 'high');

  // Distinct supporting deals across ALL patterns — drives the small-sample
  // banner ("less than 5 supporting deals across the dataset").
  const allSupporting = new Set();
  for (const p of result.patterns) p.supporting_deal_ids.forEach(id => allSupporting.add(id));
  const smallSample = allSupporting.size < 5;

  // Hydrate each pattern with the actual deals + changes (owner-scoped).
  const patterns = result.patterns.map(p => ({
    ...p,
    supporting_deals: hydrateDeals(db, userId, p.supporting_deal_ids),
    supporting_changes: hydrateChanges(db, userId, p.supporting_change_ids),
    alert_active: !!db.prepare('SELECT 1 FROM pattern_alerts WHERE user_id = ? AND competitor_id = ? AND pattern_type = ?')
      .get(userId, p.competitor_id, p.pattern_type),
  }));

  // Headline "revenue at risk": the value of distinct deals supporting any
  // medium+high pattern, counted ONCE. The spec describes this as a sum of
  // per-pattern impacts, but a single lost deal often supports two patterns for
  // the same competitor (a repricing that also touches the feature list), and
  // naively summing would double-count it. Deduplicating by deal id keeps the
  // headline honest — it never claims more revenue at risk than was actually
  // logged. Per-pattern estimated_impact_usd is left intact on each card.
  const countedDealValue = new Map(); // dealId -> value
  for (const p of patterns) {
    if (p.confidence !== 'medium' && p.confidence !== 'high') continue;
    for (const d of p.supporting_deals) {
      if (d.deal_value_usd != null) countedDealValue.set(d.id, d.deal_value_usd);
    }
  }
  const revenueAtRisk = [...countedDealValue.values()].reduce((s, v) => s + v, 0);
  const revenueAtRiskDealCount = countedDealValue.size;

  return {
    status,
    reason: result.reason,
    total_deals: result.total_deals,
    lost_tagged: result.lost_tagged,
    lost_stalled_tagged: result.lost_stalled_tagged,
    distinct_competitors: result.distinct_competitors,
    needed_more_for_reliable: Math.max(0, 15 - result.total_deals),
    small_sample_banner: status === 'ok' && smallSample,
    revenue_at_risk_usd: revenueAtRisk,
    revenue_at_risk_deal_count: revenueAtRiskDealCount,
    strong_pattern_count: strongPatterns.length,
    date_range: { from: range?.from_date || null, to: range?.to_date || null },
    patterns,
    generated_at: new Date().toISOString(),
  };
}

function hydrateDeals(db, userId, ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT d.id, d.deal_name, d.outcome, d.deal_value_usd, d.close_date, c.name AS competitor_name
    FROM deals d LEFT JOIN competitors c ON d.competitor_id = c.id
    WHERE d.user_id = ? AND d.id IN (${placeholders})
    ORDER BY d.close_date DESC
  `).all(userId, ...ids);
}

function hydrateChanges(db, userId, ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT ch.id, ch.headline, ch.threat_level, ch.detected_at
    FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE c.user_id = ? AND ch.id IN (${placeholders})
    ORDER BY ch.detected_at DESC
  `).all(userId, ...ids);
}

// Lightweight read of the persisted headline for the main dashboard widget —
// no recompute, just reads what the nightly job / last ROI-page open produced.
function getRevenueAtRiskCached(userId) {
  const db = getDb();
  const totalDeals = db.prepare('SELECT COUNT(*) AS n FROM deals WHERE user_id = ?').get(userId).n;
  let rows = db.prepare(
    'SELECT confidence, supporting_deal_ids FROM correlations WHERE user_id = ?'
  ).all(userId);

  // Cold cache: a user with enough deals who hasn't opened the ROI page yet (and
  // before the nightly job runs) would otherwise see a blank widget. Compute
  // once on demand — cheap, no AI — so the dashboard headline is never stale-empty.
  // Below the engine gate (5 deals) no pattern can exist, so we skip the work.
  if (rows.length === 0 && totalDeals >= 5) {
    computeCorrelationsForUser(userId, { persist: true });
    rows = db.prepare('SELECT confidence, supporting_deal_ids FROM correlations WHERE user_id = ?').all(userId);
  }
  const strong = rows.filter(r => r.confidence === 'medium' || r.confidence === 'high');

  // Same dedup-by-deal logic as the full dashboard headline, computed from the
  // persisted supporting_deal_ids so the widget and the page agree.
  const dealIds = new Set();
  for (const r of strong) {
    try { (JSON.parse(r.supporting_deal_ids) || []).forEach(id => dealIds.add(id)); } catch (_) {}
  }
  let revenueAtRisk = 0;
  if (dealIds.size > 0) {
    const ids = [...dealIds];
    const placeholders = ids.map(() => '?').join(',');
    const valRows = db.prepare(
      `SELECT deal_value_usd FROM deals WHERE user_id = ? AND id IN (${placeholders}) AND deal_value_usd IS NOT NULL`
    ).all(userId, ...ids);
    revenueAtRisk = valRows.reduce((s, v) => s + v.deal_value_usd, 0);
  }

  return {
    total_deals: totalDeals,
    pattern_count: rows.length,
    strong_pattern_count: strong.length,
    revenue_at_risk_usd: revenueAtRisk,
  };
}

// ── Nightly job ──────────────────────────────────────────────────────────────

function runNightlyForAllUsers() {
  const db = getDb();
  const start = Date.now();
  const users = db.prepare('SELECT DISTINCT user_id FROM deals').all();
  let usersWithPatterns = 0, totalPatterns = 0;
  for (const { user_id } of users) {
    try {
      const r = computeCorrelationsForUser(user_id, { persist: true });
      if (r.patterns.length > 0) { usersWithPatterns += 1; totalPatterns += r.patterns.length; }
    } catch (e) {
      console.error(`🔗 Nightly correlation failed for user=${user_id}: ${e.message}`);
    }
  }
  // Adoption funnel (lazy require to avoid a cycle).
  let adoption = {};
  try { adoption = require('./deals').adoptionMetrics(); } catch (_) {}
  console.log(`🔗 Nightly correlations done: users=${users.length} with_patterns=${usersWithPatterns} patterns=${totalPatterns} adoption=${JSON.stringify(adoption)} ${Date.now() - start}ms`);
  return { users: users.length, usersWithPatterns, totalPatterns, adoption };
}

module.exports = {
  classifyChangeTypes,
  computeCorrelationsForUser,
  getRoiDashboard,
  getRevenueAtRiskCached,
  runNightlyForAllUsers,
  PATTERN_TYPES,
  TYPE_LABEL,
};
