// 14-day Pro trial helpers (length lives in src/config.js TRIAL_DAYS).
//
// The trial is an OVERLAY on a free workspace, driven entirely by
// workspaces.trial_ends_at: while the timestamp is in the future and no paid
// subscription exists, getWorkspaceTier (src/lib/tierLimits.js) resolves the
// workspace to effective Pro. When it passes, the workspace falls back to Free
// naturally; nothing is locked and nothing is deleted. This module is the one
// place that interprets the trial columns, so the banner API, the reminder
// sweep, and the admin view all agree.

const { getDb } = require('../db');

const DAY_MS = 86400000;

function parseDbDate(v) {
  if (!v) return null;
  const t = Date.parse(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? t : null;
}

// A workspace is "on trial infrastructure" when it has a trial_ends_at and no
// real paid subscription. (A paid sub sets subscription_tier and
// subscription_id via the payment webhook, which always wins over the trial.)
function hasTrialOverlay(ws) {
  return Boolean(ws && ws.trial_ends_at && !ws.subscription_id
    && (ws.subscription_tier || 'free') === 'free');
}

// Full trial state for a workspace row or id:
//   { onTrial, expired, trialEndsAt, daysLeft }
// daysLeft counts partial days up (13.2 days -> 14), floors at 0, and is null
// when there is no trial at all (pre-trial accounts, paid accounts).
function getTrialInfo(wsOrId) {
  const ws = typeof wsOrId === 'object' && wsOrId !== null
    ? wsOrId
    : getDb().prepare('SELECT id, subscription_tier, subscription_id, trial_ends_at FROM workspaces WHERE id = ?').get(wsOrId);
  if (!hasTrialOverlay(ws)) {
    return { onTrial: false, expired: false, trialEndsAt: null, daysLeft: null };
  }
  const ends = parseDbDate(ws.trial_ends_at);
  if (ends == null) return { onTrial: false, expired: false, trialEndsAt: null, daysLeft: null };
  const msLeft = ends - Date.now();
  const onTrial = msLeft > 0;
  return {
    onTrial,
    expired: !onTrial,
    trialEndsAt: ws.trial_ends_at,
    daysLeft: Math.max(0, Math.ceil(msLeft / DAY_MS)),
  };
}

// True when the workspace's trial has ended with no paid subscription: the
// account is on Free-fallback limits (never locked out).
function isTrialActive(wsOrId) {
  return getTrialInfo(wsOrId).onTrial;
}

module.exports = { getTrialInfo, isTrialActive, hasTrialOverlay };
