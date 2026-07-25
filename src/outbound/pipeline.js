// Outbound — background run processor.
//
// startRun(runId) is fire-and-forget: it flips the run to 'running', walks the
// pipeline, persists leads, and flips the run to 'done' (or 'error'). It never
// blocks the HTTP request that started it (the endpoint returns the run id
// immediately) and it never throws to the caller. Each company is wrapped in
// try/catch so one bad company cannot fail the whole run.
//
// Pipeline: discover -> (per company) people -> contact -> score -> draft ->
// persist. Anything below SCORE_THRESHOLD is dropped.

const store = require('./store');
const { getProvider, OutboundConfigError, rolesForStage, classifyCompany } = require('./provider');
const { structuredCall, draftCall } = require('./ai');
const { getAgentPrompt } = require('./agentPrompt');
const { makeFunnel, formatFunnel, totalRejectedPeople } = require('./funnel');
const { sanitizeCopy, sanitizeCopyDeep } = require('../lib/sanitizeText');
const { sleep } = require('../lib/retry');

const SCORE_THRESHOLD = 60;   // drop candidates scoring below this
const HARD_CAP = 25;          // max FINAL leads a run may request (targetCount ceiling)

// Over-discovery means the pipeline processes the whole discovered pool
// (bounded by provider MAX_POOL), not just targetCount. Each company costs one
// search plus a few model calls, so we space companies out to stay under
// provider per-minute limits. withRetry() in lib/retry.js is the backstop when
// we still get a 429.
const COMPANY_GAP_MS = 750;

// Kick off a run in the background. Returns immediately.
function startRun(runId) {
  // Defer to the next tick so the HTTP handler can respond first.
  setImmediate(() => {
    runPipeline(runId).catch(err => {
      console.error('[outbound.pipeline] unhandled run error:', err);
      try { store.updateRun(runId, { status: 'error', error_message: safeMsg(err) }); } catch (_) {}
    });
  });
}

async function runPipeline(runId) {
  const run = store.getRun(runId);
  if (!run) return;
  store.updateRun(runId, { status: 'running' });

  const params = run.params || {};
  const brief = params.brief || '';
  const targetCount = clampCount(params.targetCount);
  const regionHints = params.regionHints || '';

  const provider = getProvider();

  // Per-run funnel: every stage records where candidates die so a run that
  // yields zero leads is diagnosable (see funnel.js, and the admin UI).
  const funnel = makeFunnel();

  let candidates;
  try {
    candidates = await provider.discoverCompanies(brief, { targetCount, regionHints, funnel });
  } catch (err) {
    // Config errors (missing/invalid SERPER key) surface as a clean run error.
    const msg = err instanceof OutboundConfigError ? err.message : `Discovery failed: ${safeMsg(err)}`;
    store.updateRun(runId, { status: 'error', error_message: msg });
    return;
  }

  const totalFound = candidates.length; // the discovered POOL size
  // Every scored candidate (kept or dropped) so the score distribution can be
  // inspected when below-threshold turns out to dominate the funnel.
  const scoreLog = [];
  // Leads that clear EVERY gate. The targetCount cap is applied to these last.
  const survivors = [];

  let firstCompany = true;
  for (const company of candidates) {
    if (!firstCompany) await sleep(COMPANY_GAP_MS);
    firstCompany = false;
    try {
      const lead = await buildLead(provider, brief, company, funnel, scoreLog);
      if (!lead) continue;                       // rejected upstream; funnel already tallied
      survivors.push(lead);
    } catch (err) {
      console.warn('[outbound.pipeline] company failed:', company?.company, '-', safeMsg(err));
      // continue on partial failure
    }
  }

  // Cap LAST: order the gate survivors by freshness then score, keep the top
  // targetCount, and persist only those. Anything beyond the cap is a valid lead
  // dropped purely because the run asked for fewer (funnel.capped), not a
  // quality rejection.
  const { kept: keptLeads, capped } = selectTopLeads(survivors, targetCount);
  for (const lead of keptLeads) store.insertLead(runId, lead);

  funnel.kept = keptLeads.length;
  funnel.capped = capped;
  store.updateRun(runId, { status: 'done', total_found: totalFound, total_kept: keptLeads.length, funnel });
  console.log(formatFunnel(funnel, runId));
  logScoreDistributionIfBelowThresholdDominates(runId, funnel, scoreLog);
}

// Freshness bucket for a trigger date, matching store.js freshnessRank exactly:
// 0 this week, 1 this month, 2 last 3 months, 3 three to six months, 4 undated,
// 5 stale (>180 days). A missing/unparseable date is unknown recency (4), not
// stale.
function freshnessBucket(triggerDate) {
  if (!triggerDate) return 4;
  const t = Date.parse(triggerDate);
  if (!Number.isFinite(t)) return 4;
  const days = (Date.now() - t) / 86400000;
  if (days <= 7) return 0;
  if (days <= 30) return 1;
  if (days <= 90) return 2;
  if (days <= 180) return 3;
  return 5;
}

// Apply the targetCount cap to gate survivors, ordered freshness-first then by
// score (the same order the leads table uses). Returns the kept leads and how
// many were dropped by the cap alone.
function selectTopLeads(survivors, targetCount) {
  const n = Number.isFinite(targetCount) && targetCount > 0 ? targetCount : 0;
  const ordered = survivors.slice().sort((a, b) =>
    freshnessBucket(a.trigger_at) - freshnessBucket(b.trigger_at) || (b.score || 0) - (a.score || 0));
  const kept = ordered.slice(0, n);
  return { kept, capped: ordered.length - kept.length };
}

// Diagnostic: when below-threshold is the single largest funnel bucket, the
// scores themselves are the thing to inspect, so dump the full distribution with
// each candidate's sub-score breakdown. Inert (logs nothing) otherwise, to keep
// the log quiet on healthy runs.
function logScoreDistributionIfBelowThresholdDominates(runId, funnel, scoreLog) {
  const buckets = {
    no_person: funnel.no_person,
    rejected: totalRejectedPeople(funnel),
    no_contact: funnel.no_contact,
    below_threshold: funnel.below_threshold,
    kept: funnel.kept,
  };
  const dominant = Object.keys(buckets).reduce((a, b) => (buckets[b] > buckets[a] ? b : a));
  if (dominant !== 'below_threshold' || !funnel.below_threshold || !scoreLog.length) return;

  const rows = scoreLog.slice().sort((a, b) => b.score - a.score);
  const lines = ['[outbound.pipeline] run #' + runId
    + ' below-threshold dominates (' + funnel.below_threshold + ' dropped, threshold '
    + SCORE_THRESHOLD + '). Score distribution:'];
  for (const r of rows) {
    const b = r.breakdown || {};
    const g = (v) => (Number.isFinite(v) ? v : '?');
    lines.push('  ' + String(r.score).padStart(3)
      + '  fit ' + g(b.fit) + ', pain ' + g(b.pain) + ', reach ' + g(b.reachability)
      + ', timing ' + g(b.timing)
      + '  trigger_date=' + (r.trigger_date || 'null')
      + '  ' + (r.company || '?'));
  }
  console.log(lines.join('\n'));
}

// Build one persisted-shaped lead from a company candidate: person -> contact ->
// score -> draft. Returns null when the company is not a lead: no verified
// current person (rule 1), no usable contact (rule 2), or a below-threshold score.
async function buildLead(provider, brief, company, funnel, scoreLog) {
  // Peer gate FIRST. Never pitch a company that itself sells competitor
  // monitoring, whether as a core product or as a feature of a different core
  // business (see provider.classifyCompany). Peers are excluded and logged, not
  // shown as leads, and filtering here avoids wasting the people/contact/score
  // calls on them.
  const kind = classifyCompany(company);
  if (kind.classification === 'peer') {
    if (funnel) funnel.peer += 1;
    console.log('[outbound.pipeline] peer (filtered): ' + JSON.stringify(company.company || '?')
      + ' - ' + (kind.reason || 'sells competitor monitoring'));
    return null;
  }

  // People + contact (never fabricated). findPeople only returns a person whose
  // current employment at the company is verified (see provider.findPeople), and
  // it records the per-gate rejection reason into the funnel itself.
  const roles = rolesForStage(company.stage_size);
  let person = null, contact = null;
  try {
    const people = await provider.findPeople(company.company, roles, { funnel });
    person = people[0] || null;
  } catch (err) {
    console.warn('[outbound.pipeline] findPeople failed:', company.company, '-', safeMsg(err));
    // Error path: findPeople never reached its own accounting, so count it here.
    if (funnel) funnel.no_person += 1;
  }
  // Rule 1 + 2: no verified current person means the company is not a lead. The
  // reason was already tallied (inside findPeople, or the catch above).
  if (!person) return null;

  try { contact = await provider.findContact(person); } catch (_) { contact = null; }
  // Rule 2: require a usable way to reach them (a valid profile URL or a found
  // email). No reachable contact means the company is dropped, never shown blank.
  if (!hasUsableContact(person, contact)) { if (funnel) funnel.no_contact += 1; return null; }

  // Score on the rubric (fit 30 / pain 30 / reachability 20 / timing 20).
  const scoreResult = await scoreCandidate(brief, company, person);
  const score = Number.isFinite(scoreResult?.score) ? scoreResult.score : 0;
  if (scoreLog) {
    scoreLog.push({
      company: company.company,
      score,
      breakdown: scoreResult?.score_breakdown || {},
      trigger_date: company.trigger_date || null,
    });
  }
  if (score < SCORE_THRESHOLD) { if (funnel) funnel.below_threshold += 1; return null; }

  // Draft (we always have a verified someone to write to by this point).
  const drafted = await draftMessage(company, person, contact);
  const draft = drafted?.text || null;
  const confidence = drafted?.confidence || scoreResult?.confidence || null;

  return {
    company: company.company,
    domain: company.domain,
    category: company.category,
    stage_size: company.stage_size,
    region: company.region,
    trigger: company.trigger,
    trigger_url: company.trigger_url,
    trigger_at: company.trigger_date || null,
    score,
    score_breakdown: scoreResult?.score_breakdown || {},
    why_now: scoreResult?.why_now || null,
    person_name: person?.person_name || null,
    person_title: person?.person_title || null,
    person_seniority: person?.person_seniority || null,
    channel: contact?.channel || person?.channel || 'linkedin',
    handle_or_email: contact?.handle_or_email || person?.profileUrl || null,
    contact_status: contact?.contact_status || 'manual',
    backup_channel: contact?.backup_channel || null,
    draft,
    confidence,
  };
}

// Anthropic scoring. Returns { score, score_breakdown, why_now, confidence }.
// If the model is unavailable, returns a neutral score so the pipeline degrades
// rather than dropping everything.
async function scoreCandidate(brief, company, person) {
  const system = 'You score outbound leads for Nivaria, a competitor-intelligence app for SaaS '
    + 'sales and product-marketing teams. Score each candidate 0-100 as the sum of: fit (0-30), '
    + 'pain (0-30), reachability (0-20), timing (0-20). Be strict. If the candidate itself BUILDS, '
    + 'SHIPS, or SELLS competitor-analysis, competitor-tracking, price-monitoring, or '
    + 'market-intelligence capability (as a core product OR as a feature of a different core '
    + 'business), it is a peer, not a prospect: score it near 0. Shipping such a feature is a '
    + 'DISQUALIFIER, not evidence of pain, because a company that builds it will not buy it. '
    + 'Return JSON only. Never use em-dashes, en-dashes, or a connecting "+"; write "and" instead.';
  const user = 'ICP brief:\n' + String(brief || '').slice(0, 1500)
    + '\n\nToday is ' + new Date().toISOString().slice(0, 10) + '. Score the timing sub-score (0 to '
    + '20) on how recent the trigger is, scaled across a full 6 months: a trigger from the last few '
    + 'days scores near the full 20, one about 3 months old scores around half, and one approaching '
    + '6 months old scores low but not zero. If trigger_date is null the recency is UNKNOWN, not '
    + 'old: give timing a neutral score of about 10 out of 20, and never score timing at 0 just '
    + 'because the date is missing.'
    + '\n\nCandidate:\n' + JSON.stringify({
      company: company.company, category: company.category, stage_size: company.stage_size,
      region: company.region, trigger: company.trigger, trigger_url: company.trigger_url,
      trigger_date: company.trigger_date || null,
      person: person ? { title: person.person_title, seniority: person.person_seniority } : null,
    })
    + '\n\nReturn: { "score": int 0-100, "score_breakdown": { "fit": int, "pain": int, '
    + '"reachability": int, "timing": int }, "why_now": string (one sentence, why reach out now), '
    + '"confidence": "high"|"medium"|"low" }';

  const parsed = await structuredCall({ system, user, maxTokens: 700 });
  if (!parsed) {
    // No AI available: neutral pass-through so discovery is still usable.
    return { score: SCORE_THRESHOLD, score_breakdown: {}, why_now: company.trigger || null, confidence: 'low' };
  }
  return sanitizeCopyDeep({
    score: clampScore(parsed.score),
    score_breakdown: parsed.score_breakdown || {},
    why_now: parsed.why_now || null,
    confidence: normalizeConfidence(parsed.confidence),
  });
}

// Human trigger-age line for the draft user message. The draft prompt's "No
// stale premises" rule needs the trigger's age to decide present vs past tense,
// so it must be supplied here, not left for the model to guess. A null or
// unparseable date is reported as unknown (never assumed current).
function triggerAgeLine(triggerDate) {
  const unknown = 'Trigger date: unknown (do not describe the trigger as current '
    + 'or ongoing; do not use present tense such as "is hiring" or "just posted")';
  if (!triggerDate) return unknown;
  const t = Date.parse(triggerDate);
  if (Number.isNaN(t)) return unknown;
  const days = Math.max(0, Math.floor((Date.now() - t) / 86400000));
  return `Trigger date: ${String(triggerDate).slice(0, 10)} (${days} days ago)`;
}

// Anthropic drafting with the outbound agent as the system prompt. Runs the
// output through the no-dash / no-connector sanitizer before returning.
async function draftMessage(company, person, contact) {
  const channel = contact?.channel || person?.channel || 'linkedin';
  const user = 'Write one outreach message.\n'
    + `Channel: ${channel}\n`
    + `Company: ${company.company}\n`
    + `Category: ${company.category || 'unknown'}\n`
    + `Trigger: ${company.trigger || 'n/a'}\n`
    + `Trigger source: ${company.trigger_url || 'n/a'}\n`
    + `${triggerAgeLine(company.trigger_date)}\n`
    + `Person: ${person?.person_name || 'unknown'} (${person?.person_title || 'unknown title'})\n`;
  const text = await draftCall({ system: getAgentPrompt(), user, maxTokens: 700 });
  if (!text) return null;
  return { text: sanitizeCopy(text), confidence: undefined };
}

// Re-run drafting for a single existing lead (redraft endpoint). Optional new
// channel/angle. Returns the sanitized draft text or null.
async function redraftLead(lead, { channel, angle } = {}) {
  const ch = channel || lead.channel || 'linkedin';
  let user = 'Write one outreach message.\n'
    + `Channel: ${ch}\n`
    + `Company: ${lead.company}\n`
    + `Category: ${lead.category || 'unknown'}\n`
    + `Trigger: ${lead.trigger || 'n/a'}\n`
    + `Trigger source: ${lead.trigger_url || 'n/a'}\n`
    + `${triggerAgeLine(lead.trigger_at)}\n`
    + `Person: ${lead.person_name || 'unknown'} (${lead.person_title || 'unknown title'})\n`;
  if (angle) user += `Angle to emphasize: ${String(angle).slice(0, 300)}\n`;
  const text = await draftCall({ system: getAgentPrompt(), user, maxTokens: 700 });
  if (!text) return null;
  return { text: sanitizeCopy(text), channel: ch };
}

// ── helpers ──────────────────────────────────────────────────────────────────────

function clampCount(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v < 1) return 10;
  return Math.min(v, HARD_CAP);
}
function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}
function normalizeConfidence(c) {
  const v = String(c || '').toLowerCase();
  return ['high', 'medium', 'low'].includes(v) ? v : 'low';
}
function safeMsg(err) {
  return String(err?.message || err || 'unknown error').slice(0, 500);
}

// A usable contact is a valid profile URL or a found email. Anything else (empty,
// "manual" with no link) means the company has no reachable contact and is dropped.
function isUsableContactValue(v) {
  if (!v) return false;
  const s = String(v).trim();
  return /^https?:\/\/\S+\.\S+/.test(s) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function hasUsableContact(person, contact) {
  return isUsableContactValue(contact?.handle_or_email)
    || isUsableContactValue(contact?.profileUrl)
    || isUsableContactValue(person?.profileUrl);
}

module.exports = {
  startRun, redraftLead, SCORE_THRESHOLD, HARD_CAP,
  freshnessBucket, selectTopLeads,
};
