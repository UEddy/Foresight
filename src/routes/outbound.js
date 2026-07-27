// Outbound — admin-only API router, mounted at /api/admin/outbound in server.js
// behind: limits.api, requireAuth, csrfProtect, requireOutboundAccess. By the
// time a handler runs, req.user is an admin (the gate lives entirely in
// src/outbound/access.js) and req.userId is set.
//
//   POST   /runs                 start a run (returns the run id immediately)
//   GET    /runs                 recent runs for the current user
//   GET    /runs/:id             run status + progress counts
//   GET    /runs/:id/leads       leads for a run, ranked by score
//   GET    /leads?status=        pipeline view across runs, filterable
//   PATCH  /leads/:id            update status and/or notes
//   POST   /leads/:id/redraft    re-run drafting for one lead

const express = require('express');
const store = require('../outbound/store');
const { checkQuota } = require('../outbound/access');
const { startRun, redraftLead, HARD_CAP } = require('../outbound/pipeline');

const router = express.Router();

// Discovery segments a run may request. '' is the default (web search only).
const SEGMENTS = ['', 'web3'];

// ── Runs ─────────────────────────────────────────────────────────────────────────

router.post('/runs', (req, res) => {
  const quota = checkQuota(req.user);
  if (!quota.allowed) {
    return res.status(429).json({ error: quota.reason || 'Outbound quota reached.' });
  }

  const brief = String(req.body?.brief || '').trim();
  if (!brief) return res.status(400).json({ error: 'A brief is required to start a run.' });

  let targetCount = parseInt(req.body?.targetCount, 10);
  if (!Number.isFinite(targetCount) || targetCount < 1) targetCount = 10;
  targetCount = Math.min(targetCount, HARD_CAP);

  const regionHints = String(req.body?.regionHints || '').slice(0, 200);

  // Discovery segment. '' (the default) is web search only. 'web3' adds recent
  // crypto funding rounds from DeFiLlama and CryptoRank alongside the search
  // results (see src/outbound/cryptoDiscovery.js). An unrecognised value falls
  // back to the default rather than erroring.
  const segment = SEGMENTS.includes(req.body?.segment) ? req.body.segment : '';

  const run = store.createRun(req.userId, {
    brief: brief.slice(0, 4000),
    targetCount,
    regionHints,
    segment,
  });

  startRun(run.id); // fire-and-forget background processing
  res.status(202).json({ id: run.id, status: run.status });
});

router.get('/runs', (req, res) => {
  res.json({ runs: store.listRunsForUser(req.userId) });
});

router.get('/runs/:id', (req, res) => {
  const run = store.getRunForUser(req.params.id, req.userId);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  res.json({ run });
});

router.get('/runs/:id/leads', (req, res) => {
  const run = store.getRunForUser(req.params.id, req.userId);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  res.json({ leads: store.listLeadsForRun(run.id) });
});

// ── Leads ────────────────────────────────────────────────────────────────────────

router.get('/leads', (req, res) => {
  const status = req.query.status && store.LEAD_STATUSES.includes(req.query.status)
    ? req.query.status : undefined;
  res.json({ leads: store.listLeadsForUser(req.userId, { status }) });
});

router.patch('/leads/:id', (req, res) => {
  const { status, notes } = req.body || {};
  if (status !== undefined && !store.LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const updated = store.updateLeadForUser(req.params.id, req.userId, { status, notes });
  if (!updated) return res.status(404).json({ error: 'Lead not found.' });
  res.json({ lead: updated });
});

router.post('/leads/:id/redraft', async (req, res) => {
  const lead = store.getLeadForUser(req.params.id, req.userId);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });

  const channel = String(req.body?.channel || '').trim() || undefined;
  const angle = String(req.body?.angle || '').trim() || undefined;

  try {
    const result = await redraftLead(lead, { channel, angle });
    if (!result) {
      return res.status(502).json({ error: 'Drafting is unavailable right now (check ANTHROPIC_API_KEY).' });
    }
    store.updateLeadDraft(lead.id, { draft: result.text, channel: result.channel });
    res.json({ lead: store.getLeadForUser(lead.id, req.userId) });
  } catch (err) {
    console.error('[outbound] redraft failed:', err?.message || err);
    res.status(500).json({ error: 'Redraft failed.' });
  }
});

module.exports = router;
