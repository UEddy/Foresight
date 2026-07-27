const Anthropic = require('@anthropic-ai/sdk');
const { sanitizeCopyDeep } = require('./lib/sanitizeText');

let client;

function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

class AIAnalysisError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'AIAnalysisError';
    this.code = code; // ai_auth_failed | ai_out_of_credits | ai_rate_limited | ai_service_error | ai_invalid_response | ai_error
    this.cause = cause;
  }
}

function categorizeAnthropicError(err) {
  const status = err?.status ?? err?.statusCode;
  const msg = String(err?.message || err || '');

  if (status === 401 || /authentication_error|invalid x-api-key|invalid api key/i.test(msg)) {
    return new AIAnalysisError('ai_auth_failed',
      `Anthropic API key rejected (401). Check ANTHROPIC_API_KEY in .env.`, err);
  }
  if (status === 402 || /credit balance|plans & billing|insufficient_quota|billing/i.test(msg)) {
    return new AIAnalysisError('ai_out_of_credits',
      `Anthropic account is out of credits. Refill at console.anthropic.com → Plans & Billing.`, err);
  }
  if (status === 429 || /rate_limit|too many requests/i.test(msg)) {
    return new AIAnalysisError('ai_rate_limited',
      `Anthropic rate limit hit. Will retry on next scheduled check.`, err);
  }
  if (status >= 500 && status < 600) {
    return new AIAnalysisError('ai_service_error',
      `Anthropic service error (${status}). Will retry on next scheduled check.`, err);
  }
  return new AIAnalysisError('ai_error', `AI analysis failed: ${msg}`, err);
}

// Canonical pattern tag vocabulary. The model is told to pick from this set so
// historical grouping is consistent and the UI can render predictable callouts.
const ALLOWED_PATTERN_TAGS = [
  'pricing_change',
  'plan_restructure',
  'feature_launch',
  'feature_removal',
  'positioning_shift',
  'enterprise_push',
  'smb_push',
  'integration',
  'partnership',
  'certification',
  'hiring_signal',
  'comparison_page',
  'messaging_refresh',
  'other',
];

const SYSTEM_PROMPT = `You are a competitive intelligence analyst writing briefs for a SaaS sales team.
You analyze diffs of competitor website content and decide what, if anything, the sales team needs to know.

THREAT-LEVEL CALIBRATION (apply strictly):

LOW: cosmetic or organizational, no strategic implication.
  • Copy refresh, wording polish, design tweak, image swap
  • New testimonial, customer logo update, blog rotation
  • Footer / nav / legal text update
  • Date or year rollover ("© 2025" → "© 2026")
  → If the change is mostly cosmetic or organizational with no strategic implication, classify as low.

MEDIUM: substantive but not urgent.
  • New feature added to the feature list
  • Repositioning or rewording of an existing feature
  • Expanded use-case or industry section
  • New integration, partnership, or certification mentioned
  • Hiring page surge, new exec announcement

HIGH: directly affects a live sales conversation, reserve for these only.
  • Pricing change (any tier added, removed, repriced, or repackaged)
  • Plan structure change (seat caps changed, limits added/removed)
  • New product tier or product line launched
  • Removal of a feature we compete on
  • Competitor entering a new market segment or geography
  • Explicit comparison page targeting our product

Reserve "high" for changes that would directly affect a sales conversation.
When in doubt between two levels, choose the lower one.

HISTORICAL CONTEXT (Phase 5):
When the prompt includes a "PRIOR CHANGES (last 90 days)" section, treat it as
ground truth about this competitor's recent trajectory. Use it to:
  • Reference recurring patterns when relevant. For example, "third pricing adjustment
    in 6 weeks", "fourth enterprise-focused update since September".
  • Identify acceleration, deceleration, or directional shifts across the
    sequence (feature-led → enterprise-led, premium → SMB, etc.).
  • Calibrate threat level when a pattern shows escalation (a single pricing
    tweak is medium; the third in two months may warrant high).

Be SILENT about history when there is no relevant pattern. Do NOT write filler
like "this is their first observed change" or "no prior changes exist". When
the PRIOR CHANGES section is absent or empty, simply omit historical_context
or set it to an empty string. Inventing patterns from sparse data is worse
than saying nothing.

USER'S BUSINESS CONTEXT (Phase 6):
When the prompt includes a "USER'S BUSINESS CONTEXT" section, this describes
the SaaS company you are advising (their product, ICP, positioning, deal size,
and sales motion). Treat it as ground truth and write the entire analysis from
their strategic perspective:
  • Frame why_it_matters and recommended_response in terms of THEIR business,
    not a generic outside view. Reference their ICP, deal size, or motion when
    relevant ("this affects your mid-market HR-tech buyers because…", "your
    PLG signup flow is now harder to differentiate from theirs…").
  • Compare the competitor's move against the user's stated positioning. When
    the competitor moves toward something the user owns (e.g. user competes on
    depth, competitor adds enterprise-grade workflows), say so explicitly and
    treat the threat as higher. When the move is in a space the user does not
    play in, treat it as lower.
  • Adjust threat level based on whether the change directly affects the user's
    typical deal size and ICP, vs being adjacent. A pricing change at $9/mo
    matters less to an enterprise-only seller than a $250K-ACV competitor pivot.
  • Talking_points should reference the user's own product/strengths when the
    context provides them.

When no USER'S BUSINESS CONTEXT section is provided, fall back to the
generic outside-observer voice. Do NOT invent context the user didn't supply,
do NOT speculate about their product, and do NOT pretend to know their ICP.

STYLE GUIDELINES (apply to every string field you write):
- Never use em-dashes (—), en-dashes (–), or the "+" character as a connector between words or phrases. Write "and" instead, or use commas, periods, colons, or parentheses. Ordinary hyphens in compound words ("pre-meeting") are fine. The ONLY time you may write "+" is when quoting a competitor's literal product name, plan name, or pricing string exactly as it appears on their site (e.g. a plan actually called "Copilot+" or a price like "$20+").
- Do not use the terms "battlecards" or "battle cards." Use "competitive briefings," "sales positioning notes," or "competitor playbooks" instead.
- Write naturally and concisely. Avoid AI-tells like "leverage," "delve," "robust," "seamless," "In summary," or "It's worth noting that."
- When listing items, use "and" or commas between them, never the "+" character, em-dashes, or en-dashes.

OUTPUT FORMAT (strict): return ONE JSON object, no markdown fences, no prose
before or after. The object MUST contain these fields, all required:

{
  "is_meaningful": true | false,
  "changed_what":  string (1 sentence, factual description of what actually changed),
  "why_it_matters": string (1-2 sentences explaining strategic relevance; write "no strategic implication" if is_meaningful is false),
  "threat_level":  "low" | "medium" | "high",
  "threat_reasoning": string (1-2 sentences justifying the threat level using the calibration above),
  "recommended_response": string (specific action the sales/product team should take; write "no action needed" if is_meaningful is false),
  "talking_points": [ array of 1-4 short strings the sales team can use; empty array if is_meaningful is false ],
  "headline": string (max 100 chars, punchy summary suitable for a notification),
  "summary":  string (2-3 sentences),
  "key_changes": [
    { "category": "pricing" | "features" | "positioning" | "messaging" | "partnership" | "other",
      "description": string,
      "impact": string }
  ],
  "opportunity": string (any opportunity this creates for our company, or empty string),
  "historical_context": string (1-2 sentences ONLY when a meaningful pattern exists in PRIOR CHANGES; empty string when no prior history or no real pattern),
  "pattern_tags": [ array of 1-3 short tags from this vocabulary: ${ALLOWED_PATTERN_TAGS.join(', ')}, used to group this change with future ones. Pick "other" only if nothing fits ]
}

If after reading the diff you conclude there is no real change worth a sales
team's attention (only whitespace shuffled, only a year incremented, only meta
tags rewritten), set is_meaningful=false, threat_level="low", and
fill the other fields with the trivial-case defaults above. Do NOT invent
strategic significance for changes that don't have it.`;

function buildPrompt(competitor, diff, historyText, userContextText) {
  // Only emit the PRIOR CHANGES block when there's actually something to say —
  // an empty section invites the model to comment on its emptiness.
  const historyBlock = historyText && historyText.trim()
    ? `\nPRIOR CHANGES (last 90 days), most recent first, format "YYYY-MM-DD | THREAT [tags] | summary":\n${historyText}\n`
    : '';

  // Same rationale for user business context — only inject when meaningful.
  const contextBlock = userContextText && userContextText.trim()
    ? `\nUSER'S BUSINESS CONTEXT (write the analysis from this company's strategic perspective):\n${userContextText}\n`
    : '';

  return `Competitor: ${competitor.name}
URL: ${competitor.url}
${competitor.description ? `Internal context: ${competitor.description}\n` : ''}${contextBlock}${historyBlock}
CHANGES DETECTED:

Page title: "${diff.beforeTitle || ''}" → "${diff.afterTitle || ''}"
Meta description: "${diff.beforeMeta || ''}" → "${diff.afterMeta || ''}"

Previous headings: ${(diff.beforeHeadings || []).slice(0, 20).join(' | ')}
Current headings:  ${(diff.afterHeadings  || []).slice(0, 20).join(' | ')}

Previous pricing section: ${(diff.beforePricing || '').substring(0, 2000) || 'N/A'}
Current pricing section:  ${(diff.afterPricing  || '').substring(0, 2000) || 'N/A'}

Previous features section: ${(diff.beforeFeatures || '').substring(0, 1500) || 'N/A'}
Current features section:  ${(diff.afterFeatures  || '').substring(0, 1500) || 'N/A'}

Notable new words/phrases: ${(diff.added   || []).slice(0, 40).join(', ')}
Removed words/phrases:     ${(diff.removed || []).slice(0, 40).join(', ')}

Apply the threat-level calibration in the system prompt. Return the JSON object only.`;
}

// Required keys on a successful AI response. Anything missing → retry once
// with an instruction to comply with the schema.
const REQUIRED_KEYS = [
  'is_meaningful', 'changed_what', 'why_it_matters', 'threat_level',
  'threat_reasoning', 'recommended_response', 'talking_points',
  'headline', 'summary', 'key_changes',
];

function tryParseAnalysis(text) {
  const trimmed = String(text || '').trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { ok: false, reason: 'no JSON object found in response' };
  let obj;
  try { obj = JSON.parse(jsonMatch[0]); }
  catch (e) { return { ok: false, reason: `JSON parse error: ${e.message}` }; }

  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) return { ok: false, reason: `missing required key "${k}"` };
  }
  if (!['low', 'medium', 'high'].includes(obj.threat_level)) {
    return { ok: false, reason: `invalid threat_level "${obj.threat_level}"` };
  }
  if (typeof obj.is_meaningful !== 'boolean') {
    return { ok: false, reason: `is_meaningful must be boolean, got ${typeof obj.is_meaningful}` };
  }
  if (!Array.isArray(obj.talking_points)) obj.talking_points = [];
  if (!Array.isArray(obj.key_changes))    obj.key_changes    = [];
  if (typeof obj.opportunity !== 'string') obj.opportunity   = '';

  // Phase 5: historical_context and pattern_tags are optional in the response
  // (we don't fail validation if the model omits them — older prompts and the
  // fallback path don't produce them). Normalize when present.
  if (typeof obj.historical_context !== 'string') obj.historical_context = '';
  if (!Array.isArray(obj.pattern_tags)) {
    obj.pattern_tags = [];
  } else {
    // Filter to the allowed vocabulary, dedupe, cap at 3 tags. Anything else
    // gets dropped — we'd rather store nothing than store noise.
    const allowed = new Set(ALLOWED_PATTERN_TAGS);
    const seen = new Set();
    obj.pattern_tags = obj.pattern_tags
      .map(t => String(t || '').trim().toLowerCase())
      .filter(t => allowed.has(t) && !seen.has(t) && (seen.add(t), true))
      .slice(0, 3);
  }

  // Deterministic safety net for the punctuation convention (CLAUDE.md): strip
  // any em/en dashes and connector-plus from every string field before this
  // brief is stored or shown. The prompt asks the model to avoid them, but LLM
  // output is sticky; this guarantees compliance.
  sanitizeCopyDeep(obj);
  return { ok: true, value: obj };
}

// Single call to Anthropic. Returns { analysis, usage, raw }.
async function callAnthropic(prompt, retryContext) {
  const messages = retryContext
    ? [
        { role: 'user',      content: prompt },
        { role: 'assistant', content: retryContext.priorRaw || '' },
        { role: 'user',      content:
          `Your previous response could not be parsed: ${retryContext.reason}. ` +
          `Respond again with ONLY the JSON object, no prose, no markdown fences. ` +
          `Every required field must be present and threat_level must be exactly "low", "medium", or "high".` },
      ]
    : [{ role: 'user', content: prompt }];

  let response;
  try {
    response = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages,
    });
  } catch (err) {
    throw categorizeAnthropicError(err);
  }

  const raw = response.content?.[0]?.text || '';
  const usage = response.usage
    ? { input_tokens: response.usage.input_tokens || 0, output_tokens: response.usage.output_tokens || 0 }
    : { input_tokens: 0, output_tokens: 0 };

  return { raw, usage };
}

async function analyzeChange(competitor, before, after, diff, historyText, userContextText) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { analysis: buildFallbackAnalysis(competitor, diff), usage: null };
  }

  const prompt = buildPrompt(competitor, diff, historyText, userContextText);

  // First attempt
  const first = await callAnthropic(prompt, null);
  const firstParse = tryParseAnalysis(first.raw);
  if (firstParse.ok) {
    return { analysis: firstParse.value, usage: first.usage };
  }

  // Single retry — feed back the bad response and ask for compliance.
  const second = await callAnthropic(prompt, { priorRaw: first.raw, reason: firstParse.reason });
  const secondParse = tryParseAnalysis(second.raw);
  if (secondParse.ok) {
    return {
      analysis: secondParse.value,
      usage: {
        input_tokens:  (first.usage.input_tokens  || 0) + (second.usage.input_tokens  || 0),
        output_tokens: (first.usage.output_tokens || 0) + (second.usage.output_tokens || 0),
      },
    };
  }

  throw new AIAnalysisError('ai_invalid_response',
    `AI response failed schema validation twice: ${firstParse.reason}; retry: ${secondParse.reason}`, null);
}

// ── Baseline record (first snapshot of a newly monitored page) ───────────────
// A brand-new page has no prior snapshot, so nothing has changed yet. Whatever
// the page shows on day one, including a post published weeks ago, is the
// STARTING STATE, not a change, so we never analyze it as one and never alert
// on it. This builds a deterministic, factual record of what was captured: no
// AI call, no threat level, no claim that anything happened today. Change
// briefs begin at the second scrape, measured against this snapshot.
//
// The record is intentionally descriptive about the SNAPSHOT ("captured") and
// silent about the CONTENT's age, because we do not know when that content was
// published and must never imply it appeared today.
function buildBaselineRecord(competitor, content) {
  const hasPricing  = Boolean((content?.pricing  || '').trim());
  const hasFeatures = Boolean((content?.features || '').trim());
  const headings    = Array.isArray(content?.headings) ? content.headings.filter(Boolean) : [];
  const title       = (content?.title || '').trim();

  // Neutral inventory of what the snapshot contains, so the user can confirm
  // the right page is being watched without any of it reading as news.
  const captured = [];
  if (title) captured.push(`page title "${title.slice(0, 120)}"`);
  if (headings.length) captured.push(`${headings.length} heading${headings.length === 1 ? '' : 's'}`);
  if (hasPricing) captured.push('a pricing section');
  if (hasFeatures) captured.push('a features section');
  const inventory = captured.length ? `Captured: ${captured.join(', ')}.` : '';

  return {
    is_meaningful: true,
    changed_what: 'Nothing changed. This is the starting snapshot for monitoring.',
    why_it_matters: 'Everything on the page today is the starting point. Future briefs describe what changes against this snapshot.',
    threat_level: null,
    threat_reasoning: '',
    recommended_response: 'No action needed. Check that this is the page you want monitored.',
    talking_points: [],
    headline: 'Monitoring started, baseline captured',
    summary: `Baseline snapshot of ${competitor.url} recorded. This is the page as it stands now, not a change. ${inventory} Monitoring is live, and you get a brief the next time this page differs from this snapshot.`.replace(/\s+/g, ' ').trim(),
    key_changes: [],
    opportunity: '',
    historical_context: '',
    pattern_tags: [],
  };
}

function buildFallbackAnalysis(competitor, diff) {
  const hasHeadingChanges = (diff?.afterHeadings || []).some(h => !(diff?.beforeHeadings || []).includes(h));
  const hasPricingChanges = (diff?.afterPricing || '') !== (diff?.beforePricing || '');
  const threatLevel = hasPricingChanges ? 'medium' : 'low';

  return {
    is_meaningful: true,  // fallback is conservative — assume the change matters until AI says otherwise
    changed_what: `${competitor.name} updated their website content`,
    why_it_matters: 'Automated detection without AI analysis. Manual review recommended to determine strategic relevance.',
    threat_level: threatLevel,
    threat_reasoning: 'Threat level estimated from heuristics (pricing-section delta) without LLM reasoning.',
    recommended_response: 'Review the competitor page manually and enable AI analysis (set ANTHROPIC_API_KEY) for detailed intelligence.',
    talking_points: ['Competitor made updates. Manual review recommended.'],
    headline: `${competitor.name} updated their website content`,
    summary: `Changes detected on ${competitor.url}. ${hasPricingChanges ? 'Pricing section was modified. ' : ''}${hasHeadingChanges ? 'Page structure and headings changed. ' : ''}Enable ANTHROPIC_API_KEY for detailed AI analysis.`,
    key_changes: [{ category: 'other', description: 'Page content changed', impact: 'Requires manual review' }],
    opportunity: '',
    historical_context: '',
    pattern_tags: [],
  };
}

// Sonnet 4.6 published rates (Jan 2026): $3.00 / 1M input, $15.00 / 1M output.
// Used for logging only — informational, not billed against the user.
function estimateCostUsd(usage) {
  if (!usage) return 0;
  const inp = usage.input_tokens  || 0;
  const out = usage.output_tokens || 0;
  return (inp * 3 + out * 15) / 1_000_000;
}

module.exports = {
  analyzeChange,
  buildBaselineRecord,
  buildFallbackAnalysis,
  buildPrompt,
  AIAnalysisError,
  categorizeAnthropicError,
  tryParseAnalysis,
  estimateCostUsd,
  ALLOWED_PATTERN_TAGS,
};
