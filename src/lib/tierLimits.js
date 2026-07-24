// Phase 10 — tier enforcement (server-side source of truth).
//
// The frontend's tier display is advisory only. Every Pro-gated route MUST call
// canWorkspaceAccess()/requireFeature() server-side. Limits are keyed by the
// workspace's EFFECTIVE tier (see getWorkspaceTier — honours cancellation grace
// periods so a cancelled-but-still-paid workspace keeps Pro until period end).

const { getDb } = require('../db');
const { logAudit } = require('./audit');
const { isAdminEmail } = require('./adminEmails');

// ── Cost-safe PAGE limits ─────────────────────────────────────────────────────
// The billable unit is a monitored PAGE, not a competitor. A competitor
// (company) groups one or more pages; each page is scraped and briefed
// individually, so each page carries the real per-check cost. Grouping is
// organizational only and grants NO extra monitoring: maxPages caps the total
// number of pages an account may monitor.
//
// Cost model to respect when setting any maxPages value:
//     monthly cost ≈ maxPages × checks-per-day × 30 × cost-per-brief
// so the number MUST be computed against price to avoid running at a loss.
//
// CURRENT CHECK FREQUENCY (see src/scheduler.js, cron '0 9 * * *'): every tier
// with daily monitoring is checked ONCE PER DAY. Free has no scheduled
// monitoring (manual checks only). Frequency multiplies cost, so it must be
// factored in before raising any page cap.

// Team/Business are waitlist-only (no active checkout) and their page caps are
// deliberately NOT set yet: the number must come from a per-brief cost analysis
// (pages × check-frequency × price) so the tier does not run at a loss. Left as
// a named TODO constant rather than a guessed number. `null` means "no cap
// configured yet" and is treated as uncapped until a real value is set, which
// MUST happen before Team/Business checkout goes live.
const TIER_PAGE_LIMIT_TODO = null; // TODO(pricing): compute pages × frequency × price

// Maximum pages that may be grouped under a single competitor. A structural,
// cost-safety cap so one company cannot absorb an unbounded share of the
// account allowance (and to bound per-competitor brief fan-out).
const MAX_PAGES_PER_COMPETITOR = 5;

const TIER_LIMITS = {
  // maxPages: total monitored pages allowed on the tier. -1 would mean unlimited;
  // null (TIER_PAGE_LIMIT_TODO) means not-yet-configured (treated as uncapped).
  free:     { maxPages: 1,  dailyMonitoring: false, webhooks: false, calendar: false, playbooks: false, winLossCorrelation: false, historicalContext: false },
  // Pro is the cost-safe, transactable tier: 15 pages total.
  pro:      { maxPages: 15, dailyMonitoring: true,  webhooks: true,  calendar: true,  playbooks: true,  winLossCorrelation: true,  historicalContext: true  },
  // Team/Business page caps are TODO pending the cost analysis above. Do NOT
  // invent a number here; set TIER_PAGE_LIMIT_TODO's replacement per tier once
  // the per-brief cost against price is known.
  team:     { maxPages: TIER_PAGE_LIMIT_TODO, dailyMonitoring: true,  webhooks: true,  calendar: true,  playbooks: true,  winLossCorrelation: true,  historicalContext: true  },
  business: { maxPages: TIER_PAGE_LIMIT_TODO, dailyMonitoring: true,  webhooks: true,  calendar: true,  playbooks: true,  winLossCorrelation: true,  historicalContext: true  },
};

// Backend owns the gate-modal copy; the frontend renders message + upgradeUrl
// straight from the 402 body.
const FEATURE_INFO = {
  add_competitor:       { message: 'You’ve reached your plan’s page limit. Upgrade to Pro to monitor more pages.' },
  daily_monitoring:     { message: 'Automatic daily monitoring is a Pro feature.' },
  webhooks:             { message: 'Slack & Discord alert webhooks are a Pro feature.' },
  calendar:             { message: 'Pre-meeting calendar briefings are a Pro feature.' },
  playbooks:            { message: 'AI outreach playbooks are a Pro feature.' },
  win_loss_correlation: { message: 'Win/loss correlation analysis is a Pro feature.' },
  historical_context:   { message: 'Historical pattern analysis is a Pro feature.' },
};

const FEATURE_TO_LIMIT = {
  daily_monitoring: 'dailyMonitoring',
  webhooks: 'webhooks',
  calendar: 'calendar',
  playbooks: 'playbooks',
  win_loss_correlation: 'winLossCorrelation',
  historical_context: 'historicalContext',
};

// ── Developer override (Phase 12) ─────────────────────────────────────────────
// is_developer is a per-user emergency flag (set via /admin/set-developer) that
// grants UNLIMITED Pro feature access regardless of subscription state. It is a
// hard override, not subject to expiration.
//
// It deliberately lives in the FEATURE-ACCESS layer only. getWorkspaceTier()
// below is NOT overridden, so billing/checkout (src/routes/billing.js) always
// sees the REAL Lemon Squeezy subscription state — paid-tier logic is unaffected.
function isDeveloperUser(userId) {
  if (!userId) return false;
  const u = getDb().prepare('SELECT is_developer FROM users WHERE id = ?').get(userId);
  return !!(u && u.is_developer);
}

// Resolve the override via a workspace's owner, so it applies both in request
// handlers and in the background scheduler (which only has workspace_id).
function workspaceOwnerIsDeveloper(workspaceId) {
  if (!workspaceId) return false;
  const w = getDb().prepare('SELECT owner_user_id FROM workspaces WHERE id = ?').get(workspaceId);
  return w ? isDeveloperUser(w.owner_user_id) : false;
}

// ── Admin-account override (competitor cap only) ──────────────────────────────
// A workspace whose OWNER is an admin (their email is in ADMIN_EMAILS, the same
// gate that guards /admin/*) has NO cap on the number of competitors it can add.
// This is a per-account override keyed off the existing admin mechanism, NOT a
// tier change: TIER_LIMITS and getWorkspaceTier are untouched, so Pro/Team/
// Business keep their exact competitor caps and all billing logic is unaffected.
function workspaceOwnerIsAdmin(workspaceId) {
  if (!workspaceId) return false;
  const w = getDb().prepare('SELECT owner_user_id FROM workspaces WHERE id = ?').get(workspaceId);
  if (!w || !w.owner_user_id) return false;
  const u = getDb().prepare('SELECT email FROM users WHERE id = ?').get(w.owner_user_id);
  return u ? isAdminEmail(u.email) : false;
}

// Effective tier, accounting for cancellation grace periods and the 14-day
// Pro trial overlay (src/lib/trial.js): a free workspace with an unexpired
// trial_ends_at resolves to Pro; when the trial passes it falls back to free
// automatically, with no scheduled downgrade step needed for gating.
function getWorkspaceTier(workspaceId) {
  if (!workspaceId) return 'free';
  const w = getDb().prepare('SELECT subscription_tier, subscription_status, subscription_current_period_end, subscription_id, trial_ends_at FROM workspaces WHERE id = ?').get(workspaceId);
  if (!w) return 'free';
  const tier = w.subscription_tier || 'free';
  if (tier === 'free') {
    // Trial overlay: effective Pro until trial_ends_at passes. Lazy require to
    // keep module-load order simple (trial.js also requires db.js).
    const { isTrialActive } = require('./trial');
    return isTrialActive(w) ? 'pro' : 'free';
  }
  if (w.subscription_status === 'expired') return 'free';

  // Cancelled (scheduled to end) but still inside the paid period → keep tier.
  // Once the period has elapsed for a cancelled/expired sub → drop to free.
  if (w.subscription_current_period_end) {
    const ended = new Date(String(w.subscription_current_period_end).replace(' ', 'T')).getTime() < Date.now();
    if (ended && (w.subscription_status === 'cancelled' || w.subscription_status === 'expired')) {
      return 'free';
    }
  }
  // past_due → keep tier (Lemon Squeezy dunning retries); paused → keep tier
  // visible (read-only handled at the UI layer).
  return tier;
}

function getLimits(workspaceId) {
  return TIER_LIMITS[getWorkspaceTier(workspaceId)] || TIER_LIMITS.free;
}

function canWorkspaceAccess(workspaceId, feature) {
  // Developer override: unlimited access regardless of subscription state.
  if (workspaceOwnerIsDeveloper(workspaceId)) return true;
  const key = FEATURE_TO_LIMIT[feature];
  if (!key) return false;
  return !!getLimits(workspaceId)[key];
}

// True when the workspace owner has an account-level override (developer flag or
// admin email). Both bypass page caps entirely — the developer flag for
// emergencies, the admin override so the account holder can run uncapped demos.
function workspaceOwnerIsPrivileged(workspaceId) {
  return workspaceOwnerIsDeveloper(workspaceId) || workspaceOwnerIsAdmin(workspaceId);
}

// Total monitored-page cap for the workspace's effective tier. Returns -1 for an
// explicitly-unlimited tier and null for a not-yet-configured (TODO) tier; both
// mean "no cap enforced" to canAddPage.
function maxPages(workspaceId) {
  return getLimits(workspaceId).maxPages;
}

// True if the workspace can add one more PAGE at its current page count. Pages,
// not competitors, are what count toward the plan limit.
function canAddPage(workspaceId, currentPageCount) {
  // Account-level override (developer/admin): no page cap.
  if (workspaceOwnerIsPrivileged(workspaceId)) return true;
  const max = maxPages(workspaceId);
  if (max === -1 || max === null || max === undefined) return true; // unlimited / TODO-not-configured
  return currentPageCount < max;
}

// True if one more page may be added to a SINGLE competitor (group) that already
// has `currentPagesInCompetitor` pages. Enforces the per-competitor structural
// cap. Account-level overrides bypass it so uncapped demos are not constrained.
function canAddPageToCompetitor(workspaceId, currentPagesInCompetitor) {
  if (workspaceOwnerIsPrivileged(workspaceId)) return true;
  return currentPagesInCompetitor < MAX_PAGES_PER_COMPETITOR;
}

// Deprecated aliases. The billable unit is a page; these keep older call sites
// working and now delegate to the page-based functions.
function maxCompetitors(workspaceId)               { return maxPages(workspaceId); }
function canAddCompetitor(workspaceId, currentCount) { return canAddPage(workspaceId, currentCount); }

// Standard 402 body. Backend controls all gate messaging.
function upgradeRequired(res, feature) {
  return res.status(402).json({
    error: 'upgrade_required',
    feature,
    message: (FEATURE_INFO[feature] || {}).message || 'This is a Pro feature.',
    upgradeUrl: '/app#/plans',
  });
}

// Express middleware: deny with 402 + a gate_violation audit entry. The
// developer override is honoured here too, since canWorkspaceAccess() bypasses
// for a developer-owned workspace (so next() is called, no violation logged).
function requireFeature(feature) {
  return (req, res, next) => {
    const wsId = req.workspaceId;
    if (wsId && canWorkspaceAccess(wsId, feature)) return next();
    logAudit({ workspaceId: wsId, userId: req.userId, eventType: 'gate_violation', eventData: { feature }, req });
    return upgradeRequired(res, feature);
  };
}

module.exports = {
  TIER_LIMITS, FEATURE_INFO, MAX_PAGES_PER_COMPETITOR, TIER_PAGE_LIMIT_TODO,
  getWorkspaceTier, getLimits, canWorkspaceAccess,
  maxPages, canAddPage, canAddPageToCompetitor,
  maxCompetitors, canAddCompetitor, upgradeRequired, requireFeature,
  isDeveloperUser, workspaceOwnerIsDeveloper, workspaceOwnerIsAdmin, workspaceOwnerIsPrivileged,
};
