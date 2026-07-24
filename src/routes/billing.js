// Phase 10 — billing routes. All require authentication and are scoped to the
// requesting user's current workspace (req.workspaceId, set in requireAuth).
//
// IMPORTANT: these routes NEVER write subscription tier/status directly. They
// call Lemon Squeezy and let the verified webhook drive all local state, so the
// DB can never drift from Lemon Squeezy's source of truth.

const express = require('express');
const router = express.Router();

const { getDb } = require('../db');
const ls = require('../lemonSqueezy');
const { getWorkspaceTier } = require('../lib/tierLimits');
const { getTrialInfo } = require('../lib/trial');
const { TRIAL_DAYS } = require('../config');
const { logAudit } = require('../lib/audit');
const { mapStatus, toTs } = require('../lemonSqueezyWebhook');
const limits = require('../middleware/rateLimits');

function workspace(req) {
  return getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
}

// POST /api/billing/checkout  { tier: 'pro' } → { checkoutUrl }
router.post('/checkout', limits.billingCheckout, async (req, res) => {
  const tier = String(req.body?.tier || '').toLowerCase();
  if (tier !== 'pro') return res.status(400).json({ error: 'Only the Pro tier is available for checkout.' });
  if (!ls.isConfigured()) return res.status(503).json({ error: 'Billing is not configured on this server.' });

  const ws = workspace(req);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });
  // Gate on the REAL paid subscription, not the effective tier: a trial
  // workspace resolves to effective Pro but must still be able to purchase.
  if (ws.subscription_id || (ws.subscription_tier || 'free') !== 'free') {
    return res.status(409).json({ error: 'This workspace already has a subscription.' });
  }

  try {
    const checkoutUrl = await ls.createProCheckout({ workspaceId: ws.id, userEmail: req.user?.email });
    if (!checkoutUrl) throw new Error('No checkout URL returned');
    res.json({ checkoutUrl });
  } catch (e) {
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// POST /api/billing/portal → { portalUrl }
router.post('/portal', limits.billingPortal, async (req, res) => {
  const ws = workspace(req);
  if (!ws?.subscription_id) return res.status(400).json({ error: 'No active subscription to manage.' });
  try {
    const portalUrl = await ls.getCustomerPortalUrl(ws.subscription_id);
    if (!portalUrl) throw new Error('No portal URL available');
    res.json({ portalUrl });
  } catch (e) {
    res.status(502).json({ error: 'Could not open the billing portal. Please try again.' });
  }
});

// GET /api/billing/subscription → current workspace subscription state,
// including the 14-day trial overlay the in-app banner renders from.
router.get('/subscription', (req, res) => {
  const ws = workspace(req);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });
  const trialInfo = getTrialInfo(ws);
  res.json({
    tier: ws.subscription_tier,
    effectiveTier: getWorkspaceTier(ws.id), // honours cancellation grace period and trial
    status: ws.subscription_status,
    currentPeriodEnd: ws.subscription_current_period_end,
    cancelAtPeriodEnd: !!ws.subscription_cancel_at_period_end,
    hasSubscription: !!ws.subscription_id,
    trial: {
      onTrial: trialInfo.onTrial,
      expired: trialInfo.expired,
      daysLeft: trialInfo.daysLeft,
      trialEndsAt: trialInfo.trialEndsAt,
      trialDays: TRIAL_DAYS,
    },
  });
});

// POST /api/billing/reconcile → recover from a dropped/lost webhook.
// Fetches the workspace's subscription from Lemon Squeezy (source of truth) and
// updates local state if it has drifted (e.g. "paid but shows Free"). This is
// the safety net for permanent webhook delivery failures.
router.post('/reconcile', limits.billingReconcile, async (req, res) => {
  const ws = workspace(req);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });
  if (!ls.isConfigured()) return res.status(503).json({ error: 'Billing is not configured on this server.' });
  try {
    const remote = await ls.findWorkspaceSubscription({ customerId: ws.lemon_squeezy_customer_id, email: req.user?.email });
    if (!remote) {
      return res.json({ reconciled: false, message: 'No Lemon Squeezy subscription found for this account.', tier: getWorkspaceTier(ws.id) });
    }
    const a = remote.attributes;
    const tier = ls.variantToTier(a.variant_id) || 'pro';
    const status = mapStatus(a.status);
    const periodEnd = toTs(a.cancelled ? a.ends_at : a.renews_at) || toTs(a.renews_at);
    const before = { subscription_id: ws.subscription_id, tier: ws.subscription_tier, status: ws.subscription_status, cancel: !!ws.subscription_cancel_at_period_end };
    const after = { subscription_id: remote.id, tier, status, cancel: !!a.cancelled };
    const changed = JSON.stringify(before) !== JSON.stringify(after);

    if (changed) {
      getDb().prepare(`
        UPDATE workspaces SET
          subscription_id = ?, subscription_status = ?, subscription_tier = ?,
          subscription_current_period_end = ?, subscription_cancel_at_period_end = ?,
          lemon_squeezy_customer_id = ?, lemon_squeezy_subscription_variant_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(remote.id, status, tier, periodEnd, a.cancelled ? 1 : 0,
             a.customer_id != null ? String(a.customer_id) : ws.lemon_squeezy_customer_id,
             a.variant_id != null ? String(a.variant_id) : ws.lemon_squeezy_subscription_variant_id, ws.id);
      logAudit({ workspaceId: ws.id, userId: req.userId, eventType: 'subscription_reconciled', eventData: { before, after }, req });
    }

    const fresh = workspace(req);
    res.json({
      reconciled: changed,
      tier: getWorkspaceTier(ws.id),
      status: fresh.subscription_status,
      currentPeriodEnd: fresh.subscription_current_period_end,
      cancelAtPeriodEnd: !!fresh.subscription_cancel_at_period_end,
    });
  } catch (e) {
    res.status(502).json({ error: 'Could not reconcile with Lemon Squeezy. Please try again.' });
  }
});

// POST /api/billing/cancel → schedule cancellation at period end (webhook-driven).
router.post('/cancel', async (req, res) => {
  const ws = workspace(req);
  if (!ws?.subscription_id) return res.status(400).json({ error: 'No active subscription to cancel.' });
  try {
    await ls.cancelAtPeriodEnd(ws.subscription_id);
    // Do NOT mutate local state here — the subscription_cancelled webhook does.
    res.json({ ok: true, message: 'Cancellation scheduled. Your access continues until the end of the period.' });
  } catch (e) {
    res.status(502).json({ error: 'Could not cancel the subscription. Please try again.' });
  }
});

// POST /api/billing/resume → undo a scheduled cancellation (webhook-driven).
router.post('/resume', async (req, res) => {
  const ws = workspace(req);
  if (!ws?.subscription_id) return res.status(400).json({ error: 'No subscription to resume.' });
  try {
    await ls.resume(ws.subscription_id);
    res.json({ ok: true, message: 'Subscription resumed.' });
  } catch (e) {
    res.status(502).json({ error: 'Could not resume the subscription. Please try again.' });
  }
});

module.exports = router;
