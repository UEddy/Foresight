// Phase 8 — generated response playbooks.
//
// For every meaningful high/medium-threat change we generate 2-3 ready-to-send
// outreach messages tailored to the user's voice. Each variant is one Sonnet
// call; we run them serially with a small delay so a transient 429 doesn't
// kill the whole batch.
//
// THE PROMPT does the heavy lifting. It enforces the human-tone rules and
// instructs the model to write like the user, anchored to their voice_sample.
// Post-hoc validators (em-dash strip, avoid-phrases scan, contraction
// application) act as belt-and-suspenders — the prompt is the primary line
// of defense, the validators are the safety net.

const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('./db');
const { getProfileWithDefaults, parseAvoidPhrases } = require('./voiceProfile');
const { getUserContext, hasMeaningfulContext, formatContextForPrompt } = require('./userContext');
const { getCompetitorHistory } = require('./historicalContext');
const { categorizeAnthropicError } = require('./analyzer');

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SONNET_MODEL = 'claude-sonnet-4-6';
// Sonnet 4.6 published rates (Jan 2026): $3.00 / 1M input, $15.00 / 1M output.
const SONNET_INPUT_PER_M  = 3.0;
const SONNET_OUTPUT_PER_M = 15.0;

function estimateCostUsd(usage) {
  if (!usage) return 0;
  const inp = usage.input_tokens  || 0;
  const out = usage.output_tokens || 0;
  return (inp * SONNET_INPUT_PER_M + out * SONNET_OUTPUT_PER_M) / 1_000_000;
}

// ── Variant catalog ──────────────────────────────────────────────────────────
// All three variants share the same system prompt (human-tone rules). The
// per-variant instructions are concatenated into the user message so we can
// regenerate one without re-emitting the full rule set every time.

const VARIANTS = {
  slack_to_team: {
    label:         'Slack to team',
    description:   'Short Slack heads-up to the sales team',
    has_subject:   false,
    word_target:   'under 80 words',
    extra_rules:   [
      'Plain text only. No signature, no greeting, no sign-off.',
      'Open with the substance ("Acme just dropped Pro pricing…"), not a salutation.',
      'Two short paragraphs max, or a 2- or 4-bullet list if the change has discrete elements. Never 3 bullets.',
      'Tone is conversational, peer to peer, not a press release.',
    ],
  },
  email_to_prospect: {
    label:         'Email to prospect',
    description:   'Email to a specific prospect in an active deal',
    has_subject:   true,
    word_target:   '80-150 words for the body',
    extra_rules:   [
      'Subject line under 70 chars. No "Quick question" / "Touching base" / "Following up". Write something specific.',
      'Open with a substantive observation about the competitor change, not "I hope this finds you well".',
      'Frame the change in terms of how it affects this prospect specifically (their decision, their evaluation, their team).',
      'End with a single concrete next step, phrased as a question or a soft proposal. Not "Looking forward to your thoughts".',
    ],
  },
  followup_email: {
    label:         'Follow-up email',
    description:   'Follow-up to a prospect who recently mentioned this competitor',
    has_subject:   true,
    word_target:   '60-100 words for the body',
    extra_rules:   [
      'Subject line under 60 chars and clearly references the prior conversation ("Re: the Acme question" / "Quick update on Acme").',
      'Open by acknowledging the prior thread in one short clause, then move to the news.',
      'Stay tight. This is a nudge, not a deck.',
      'Close with one short ask or offer. No "looking forward to" language.',
    ],
  },
};

// ── System prompt: the human-tone rules ──────────────────────────────────────

const SYSTEM_PROMPT_HEADER = `You are writing outreach messages on behalf of a B2B sales representative at a SaaS company.
Your goal is for the message to be indistinguishable from one the user wrote themselves.
A reader who knows the user should not be able to tell that an AI helped.

HUMAN-TONE RULES. The following are dead-giveaway AI tells. Even if the input
context (the COMPETITOR CHANGE block) contains any of these patterns, your
output MUST NOT inherit them. Read the input for facts and stakes; rewrite the
voice from scratch.

1. NEVER use em-dashes (—) or en-dashes (–). Anywhere. In subjects, in bodies,
   in any context. If you find yourself wanting an em-dash or en-dash, use a
   period, a comma, or "and" instead. Zero exceptions. Hyphens in compound
   words like "follow-up", "data-driven", "go-to-market" are fine (those are
   hyphens, not dashes).

2. NO plus signs (+) used as connectors in prose. Write "X, Y, and Z", not
   "X + Y + Z". Plus signs are for math and code only. The ONLY allowed uses
   are inside a number ("$5M+") or a technology name ("C++"). Never join
   words or phrases with a plus sign.

3. AVOID generic management-directive phrasing: "prepare a 1-pager", "schedule
   a briefing", "circle back", "take action on", "we need to", "immediate
   action required", "let's align on this", "loop in", "drive alignment",
   "actionable insights", "next steps include". Write what a senior individual
   contributor would actually write in Slack to their team. If a sentence
   could appear in any sales playbook for any company, rewrite it specifically
   for THIS competitor and THIS user.

4. NEVER use corporate-speak: "leverage", "synergy", "circle back", "touch
   base", "delve", "navigate" (as a verb for "deal with"), "robust",
   "comprehensive solution", "value proposition", "in today's landscape",
   "at the end of the day", "moving forward", "best of breed",
   "low-hanging fruit", "boil the ocean".

5. NEVER use these AI-tell email openers: "I hope this email finds you well",
   "I trust this email finds you well", "I hope you're doing well",
   "I wanted to reach out to", "I wanted to touch base",
   "I just wanted to follow up", "I trust this finds you well".

6. NEVER open with the recipient's name followed by gushing. No "John, I just
   had to reach out about your incredible…".

7. NEVER use a three-bullet list in an email body. AI defaults to threes,
   humans don't. If you need a list, use 2 or 4 items, or write the content
   as prose.

8. NEVER start a sentence with "I hope", "I trust", or "I wanted to".

9. VARY sentence length within the same message. AI defaults to uniform
   medium sentences. Mix a fragment, a short sentence, a longer one. Read
   your draft aloud in your head. If it sounds like a metronome, rewrite it.

10. START WITH SUBSTANCE. The first sentence must advance the reader's
    understanding of why this message exists. No throat-clearing.

11. END NATURALLY. No "Looking forward to your thoughts!", "Excited to hear
    back!", "Let me know!". Use what the user typically uses (sign-off
    examples below) or just their name. The body should land on a real
    sentence, not a closer.

12. Apply contractions per the user's preference below. If the user says
    "always", every "do not" becomes "don't", every "I will" becomes "I'll",
    every "we are" becomes "we're". If "never", expand all contractions.
    If "sometimes", be natural: use contractions in conversational moments,
    avoid them in emphatic ones.

13. NEVER use the terms "battlecards" or "battle cards". If you need to refer
    to this kind of competitive collateral, use "competitive briefings", "sales
    positioning notes", or "competitor playbooks" instead. Also avoid the
    AI-tells "seamless", "In summary", and "It's worth noting that" (rule 4
    already bans "leverage", "delve", and "robust").

VOICE ANCHOR: if the user provided a voice_sample in the VOICE PROFILE block,
study it carefully. Mirror its rhythm, its preferred connectives, its use of
fragments vs full sentences, its emoji and capitalization habits. Do not copy
specific phrases verbatim, but reproduce the texture.

OUTPUT FORMAT: return a single JSON object with these fields, no markdown
fences, no prose outside the JSON:
{
  "subject": string (subject line, or empty string if this variant has no subject),
  "body":    string (the message body, plain text, no signature wrapper unless the variant requires one)
}

Do not include any commentary, no preamble, no postamble. JUST the JSON.`;

// ── Prompt building ──────────────────────────────────────────────────────────

/**
 * Wrap user-supplied text in clearly delimited blocks so the AI cannot mistake
 * it for an instruction. We also strip the delimiter tags themselves from the
 * payload to prevent breakout via nested tags.
 */
function safeWrap(label, text) {
  if (!text) return '';
  const cleaned = String(text)
    .replace(/<\/?USER_DATA[^>]*>/gi, '')
    .replace(/<\/?SYSTEM[^>]*>/gi, '')
    .replace(/<\/?INSTRUCTIONS?[^>]*>/gi, '')
    .replace(/\u0000/g, '');
  return `<USER_DATA label="${label}">
${cleaned}
</USER_DATA>`;
}

function buildVariantPrompt({ change, competitor, voiceProfile, userContext, historyText, variantKey, prospectHint }) {
  const v = VARIANTS[variantKey];
  if (!v) throw new Error(`Unknown variant: ${variantKey}`);

  const analysis = (() => {
    try { return change.analysis ? JSON.parse(change.analysis) : {}; }
    catch (_) { return {}; }
  })();

  const avoidList = parseAvoidPhrases(voiceProfile.avoid_phrases);

  const profileLines = [
    `Formality: ${voiceProfile.formality}`,
    `Contractions: ${voiceProfile.contraction_style}`,
    `Opener style: ${voiceProfile.opener_style}`,
    `Sentence rhythm: ${voiceProfile.sentence_rhythm}`,
  ];

  const userContextBlock = (userContext && hasMeaningfulContext(userContext))
    ? `\nUSER'S BUSINESS CONTEXT (their company, ICP, positioning. Write as them, for their audience):\n${formatContextForPrompt(userContext)}\n`
    : '';

  const historyBlock = (historyText && historyText.trim())
    ? `\nPRIOR CHANGES FROM THIS COMPETITOR (last 90 days, most recent first):\n${historyText}\n`
    : '';

  const signOffBlock = voiceProfile.sign_off_examples
    ? `\nUSER'S TYPICAL SIGN-OFFS (mirror these. Do not invent new closers):\n${safeWrap('sign_off_examples', voiceProfile.sign_off_examples)}\n`
    : '';

  const voiceSampleBlock = voiceProfile.voice_sample
    ? `\nUSER'S VOICE SAMPLE (study the rhythm, phrasing, and texture. Write a message that sounds like the same person wrote it):\n${safeWrap('voice_sample', voiceProfile.voice_sample)}\n`
    : '';

  const avoidBlock = avoidList.length > 0
    ? `\nFORBIDDEN PHRASES (the user hates these. Do not use any of them, even in altered form):\n${safeWrap('avoid_phrases', avoidList.join(', '))}\n`
    : '';

  const prospectBlock = (variantKey === 'email_to_prospect' || variantKey === 'followup_email')
    ? `\nPROSPECT CONTEXT: ${prospectHint || 'a prospect currently evaluating both this competitor and the user\'s product'}\n`
    : '';

  const competitorBlock = `COMPETITOR CHANGE
Competitor: ${competitor.name}
URL: ${competitor.url}
Threat level: ${change.threat_level || 'medium'}
Headline: ${change.headline || analysis.headline || ''}
Summary: ${analysis.summary || ''}
What changed: ${analysis.changed_what || ''}
Why it matters: ${analysis.why_it_matters || ''}
Recommended response: ${analysis.recommended_response || change.recommended_response || ''}
Opportunity: ${analysis.opportunity || ''}
`;

  const extraRules = v.extra_rules.map((r, i) => `${i + 1}. ${r}`).join('\n');

  return `${competitorBlock}
VOICE PROFILE
${profileLines.join('\n')}
${signOffBlock}${voiceSampleBlock}${avoidBlock}${userContextBlock}${historyBlock}
TASK: Write a ${v.description}.
Target length: ${v.word_target}.

Variant-specific rules:
${extraRules}

Apply ALL human-tone rules from the system prompt. Return JSON only: { "subject": "...", "body": "..." }${v.has_subject ? '' : '. Subject must be an empty string for this variant'}.`;
}

// ── Post-hoc validators ──────────────────────────────────────────────────────

const DASH_RE = /[—–]/g; // em-dash + en-dash

function stripDashes(text) {
  if (!text) return text;
  // Replace " — " patterns with comma+space; bare dashes become a period+space
  // followed by a capitalized continuation when it would otherwise look weird.
  return String(text)
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,/g, ',');
}

// Plus-sign as a prose connector: word + word. We only flag when both sides
// of the "+" are alphabetic, so numeric/technical uses like "$5M+", "C++",
// "Node 18+" are not affected. We scan every " + " independently so chains
// like "X + Y + Z" report each link instead of being eaten by a greedy match.
function detectPlusConnectors(text) {
  if (!text) return [];
  const hits = [];
  const re = /\s\+\s/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const i = m.index;
    const before = text[i - 1];
    const after  = text[i + m[0].length];
    if (before && /[a-zA-Z]/.test(before) && after && /[a-zA-Z]/.test(after)) {
      const start = Math.max(0, i - 20);
      const end   = Math.min(text.length, i + m[0].length + 20);
      hits.push(text.slice(start, end).trim());
      if (hits.length >= 5) break;
    }
  }
  return hits;
}

function stripPlusConnectors(text) {
  if (!text) return text;
  // Replace a "+" connector between words with " and " iteratively so chains
  // like "X + Y + Z" become "X and Y and Z" cleanly. Matches the canonical
  // replacement in src/lib/sanitizeText.js (the convention is " and ", see
  // CLAUDE.md).
  let prev = null;
  let out = String(text);
  let guard = 10;
  while (prev !== out && guard-- > 0) {
    prev = out;
    out = out.replace(/([a-zA-Z][a-zA-Z\s]{0,30})\s\+\s([a-zA-Z])/g, '$1 and $2');
  }
  return out;
}

function containsForbiddenPhrase(text, phrase) {
  if (!phrase) return false;
  // Word-boundary, case-insensitive. We do NOT use \b on both ends because
  // phrases with leading/trailing punctuation should still match.
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return re.test(text);
}

function scanForbidden(text, avoidList) {
  const hits = [];
  for (const p of avoidList) {
    if (containsForbiddenPhrase(text, p)) hits.push(p);
  }
  return hits;
}

/**
 * Apply contraction rules deterministically as a safety net. The prompt
 * tells the model to handle this, but we re-apply on output so a slip doesn't
 * leak through.
 */
const CONTRACTION_PAIRS = [
  [/\bdo not\b/gi,   "don't"],
  [/\bdoes not\b/gi, "doesn't"],
  [/\bdid not\b/gi,  "didn't"],
  [/\bis not\b/gi,   "isn't"],
  [/\bare not\b/gi,  "aren't"],
  [/\bwas not\b/gi,  "wasn't"],
  [/\bwere not\b/gi, "weren't"],
  [/\bhave not\b/gi, "haven't"],
  [/\bhas not\b/gi,  "hasn't"],
  [/\bhad not\b/gi,  "hadn't"],
  [/\bcan not\b/gi,  "can't"],
  [/\bcannot\b/gi,   "can't"],
  [/\bwill not\b/gi, "won't"],
  [/\bwould not\b/gi,"wouldn't"],
  [/\bshould not\b/gi,"shouldn't"],
  [/\bcould not\b/gi,"couldn't"],
  [/\bI am\b/g,      "I'm"],
  [/\byou are\b/gi,  "you're"],
  [/\bwe are\b/gi,   "we're"],
  [/\bthey are\b/gi, "they're"],
  [/\bit is\b/gi,    "it's"],
  [/\bthat is\b/gi,  "that's"],
  [/\bthere is\b/gi, "there's"],
  [/\bhere is\b/gi,  "here's"],
  [/\bI will\b/g,    "I'll"],
  [/\byou will\b/gi, "you'll"],
  [/\bwe will\b/gi,  "we'll"],
  [/\bI would\b/g,   "I'd"],
  [/\byou would\b/gi,"you'd"],
  [/\bI have\b/g,    "I've"],
  [/\byou have\b/gi, "you've"],
  [/\bwe have\b/gi,  "we've"],
];

function applyContractions(text) {
  if (!text) return text;
  let out = text;
  for (const [re, sub] of CONTRACTION_PAIRS) {
    out = out.replace(re, (m) => {
      // Preserve initial capitalization of the matched span
      const replacement = typeof sub === 'function' ? sub(m) : sub;
      return /^[A-Z]/.test(m) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
    });
  }
  return out;
}

function expandContractions(text) {
  if (!text) return text;
  const pairs = [
    [/\bdon't\b/gi,  'do not'],
    [/\bdoesn't\b/gi,'does not'],
    [/\bdidn't\b/gi, 'did not'],
    [/\bisn't\b/gi,  'is not'],
    [/\baren't\b/gi, 'are not'],
    [/\bwasn't\b/gi, 'was not'],
    [/\bweren't\b/gi,'were not'],
    [/\bhaven't\b/gi,'have not'],
    [/\bhasn't\b/gi, 'has not'],
    [/\bhadn't\b/gi, 'had not'],
    [/\bcan't\b/gi,  'cannot'],
    [/\bwon't\b/gi,  'will not'],
    [/\bwouldn't\b/gi,'would not'],
    [/\bshouldn't\b/gi,'should not'],
    [/\bcouldn't\b/gi,'could not'],
    [/\bI'm\b/g,     'I am'],
    [/\byou're\b/gi, 'you are'],
    [/\bwe're\b/gi,  'we are'],
    [/\bthey're\b/gi,'they are'],
    [/\bit's\b/gi,   'it is'],
    [/\bthat's\b/gi, 'that is'],
    [/\bthere's\b/gi,'there is'],
    [/\bhere's\b/gi, 'here is'],
    [/\bI'll\b/g,    'I will'],
    [/\byou'll\b/gi, 'you will'],
    [/\bwe'll\b/gi,  'we will'],
    [/\bI'd\b/g,     'I would'],
    [/\byou'd\b/gi,  'you would'],
    [/\bI've\b/g,    'I have'],
    [/\byou've\b/gi, 'you have'],
    [/\bwe've\b/gi,  'we have'],
  ];
  let out = text;
  for (const [re, sub] of pairs) {
    out = out.replace(re, (m) => /^[A-Z]/.test(m) ? sub[0].toUpperCase() + sub.slice(1) : sub);
  }
  return out;
}

function applyVoiceFilters(text, voiceProfile) {
  if (!text) return text;
  let out = stripDashes(text);
  out = stripPlusConnectors(out);
  if (voiceProfile.contraction_style === 'always')      out = applyContractions(out);
  else if (voiceProfile.contraction_style === 'never')  out = expandContractions(out);
  return out;
}

// ── AI call ──────────────────────────────────────────────────────────────────

function parseJsonResponse(raw) {
  const trimmed = String(raw || '').trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, reason: 'no JSON object in response' };
  try {
    const obj = JSON.parse(match[0]);
    const subject = typeof obj.subject === 'string' ? obj.subject : '';
    const body    = typeof obj.body    === 'string' ? obj.body    : '';
    if (!body || !body.trim()) return { ok: false, reason: 'empty body' };
    return { ok: true, subject: subject.trim(), body: body.trim() };
  } catch (e) {
    return { ok: false, reason: `JSON parse error: ${e.message}` };
  }
}

async function callSonnet(prompt, { temperature = 0.7 } = {}) {
  let response;
  try {
    response = await getClient().messages.create({
      model:       SONNET_MODEL,
      max_tokens:  1200,
      temperature,
      system:      SYSTEM_PROMPT_HEADER,
      messages:    [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    throw categorizeAnthropicError(err);
  }
  const raw   = response.content?.[0]?.text || '';
  const usage = response.usage
    ? { input_tokens: response.usage.input_tokens || 0, output_tokens: response.usage.output_tokens || 0 }
    : { input_tokens: 0, output_tokens: 0 };
  return { raw, usage };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Decide which variants to generate for a given user. We always do
 * slack_to_team. We add email_to_prospect and followup_email only when the
 * user's business context suggests they have prospects (target_icp filled,
 * or sales_motion is slg/hybrid). PLG-only users with no target_icp get just
 * the Slack variant — saves two Sonnet calls per change.
 */
function pickVariantsForUser(userContext) {
  if (!userContext || !hasMeaningfulContext(userContext)) {
    return ['slack_to_team', 'email_to_prospect', 'followup_email'];
  }
  const hasIcp = userContext.target_icp && String(userContext.target_icp).trim().length > 0;
  const motion = userContext.sales_motion;

  if (!hasIcp && motion === 'plg') {
    return ['slack_to_team'];
  }
  return ['slack_to_team', 'email_to_prospect', 'followup_email'];
}

// Scan the model's raw output (subject + body, BEFORE the deterministic
// strip pass) for the three classes of violation we care about. Returns an
// object the caller can use to decide whether to retry.
// Exported under both names: scanViolations (legacy) and postGenerationCheck
// (preferred per Task 3 naming).
function scanViolations(subject, body, avoidList) {
  const blob = (subject || '') + '\n' + (body || '');
  const dashCount = (blob.match(DASH_RE) || []).length;
  const plusHits  = detectPlusConnectors(blob);
  const avoidHits = scanForbidden(blob, avoidList || []);
  return {
    dashes:        dashCount,
    plus_examples: plusHits,
    avoid_phrases: avoidHits,
    any:           dashCount > 0 || plusHits.length > 0 || avoidHits.length > 0,
  };
}

// Build a corrective follow-up message quoting the specific violations back to
// the model. The model gets exactly one chance to fix them; if it still slips
// up, the deterministic strip pass in applyVoiceFilters covers em-dashes and
// plus connectors. avoid_phrases is left alone (no safe deterministic fix).
function buildCorrectionPrompt(originalPrompt, parsed, violations) {
  const issues = [];
  if (violations.dashes > 0) {
    issues.push(`- Your previous output contained ${violations.dashes} em-dash or en-dash character(s) (— or –). REMOVE every one. Use a period, a comma, or the word "and" instead. ZERO em-dashes or en-dashes are allowed.`);
  }
  if (violations.plus_examples.length > 0) {
    issues.push(`- Your previous output used plus signs as prose connectors. Examples found: ${violations.plus_examples.map(p => `"${p}"`).join(', ')}. REMOVE every "+" used to join words. Write "X, Y, and Z" instead of "X + Y + Z". Plus signs are only acceptable in numbers ("$5M+") or technology names ("C++").`);
  }
  if (violations.avoid_phrases.length > 0) {
    issues.push(`- Your previous output contained these forbidden phrases the user explicitly bans: ${violations.avoid_phrases.map(p => `"${p}"`).join(', ')}. REMOVE every one. Use different words.`);
  }

  return `${originalPrompt}

═══════════════════════════════════════════════════════════════════════════════
REGENERATE. Your previous response violated the rules:

${issues.join('\n\n')}

Your previous response was:
SUBJECT: ${parsed.subject || '(none)'}
BODY:
${parsed.body}

Write a NEW response. Keep the same facts and overall structure. Fix every
violation listed above. Return ONLY the JSON object.
═══════════════════════════════════════════════════════════════════════════════`;
}

async function generateOneVariant({ change, competitor, voiceProfile, userContext, historyText, variantKey, temperature, prospectHint }) {
  const prompt = buildVariantPrompt({ change, competitor, voiceProfile, userContext, historyText, variantKey, prospectHint });
  const avoidList = parseAvoidPhrases(voiceProfile.avoid_phrases);

  // ── Attempt 1 ─────────────────────────────────────────────────────────
  let { raw, usage } = await callSonnet(prompt, { temperature });
  let parsed = parseJsonResponse(raw);
  if (!parsed.ok) {
    const e = new Error(`Playbook parse failure: ${parsed.reason}`);
    e.usage = usage; e.raw = raw;
    throw e;
  }
  let totalIn  = usage.input_tokens  || 0;
  let totalOut = usage.output_tokens || 0;
  let attempts = 1;

  // ── Pre-filter violation scan + single corrective retry ──────────────
  const pre = scanViolations(parsed.subject, parsed.body, avoidList);
  if (pre.any) {
    console.log(`  ↻ ${variantKey} pre-filter violations: dashes=${pre.dashes} plus=${pre.plus_examples.length} avoid=${pre.avoid_phrases.length}, retrying once`);
    const correctionPrompt = buildCorrectionPrompt(prompt, parsed, pre);
    const retry = await callSonnet(correctionPrompt, { temperature: Math.min(1.0, (temperature || 0.7) + 0.05) });
    totalIn  += retry.usage.input_tokens  || 0;
    totalOut += retry.usage.output_tokens || 0;
    const retryParsed = parseJsonResponse(retry.raw);
    if (retryParsed.ok) {
      parsed = retryParsed;
      attempts = 2;
    } else {
      console.warn(`  ! retry response unparseable (${retryParsed.reason}), keeping attempt 1`);
    }
  }

  // ── Deterministic strip pass (belt-and-suspenders for em-dashes and +) ─
  const subject = applyVoiceFilters(parsed.subject, voiceProfile);
  const body    = applyVoiceFilters(parsed.body,    voiceProfile);

  // ── Post-filter scan: what (if anything) leaked through everything ──
  const post = scanViolations(subject, body, avoidList);

  return {
    subject, body,
    usage: { input_tokens: totalIn, output_tokens: totalOut },
    quality: {
      attempts,
      pre_filter_violations: pre,
      // After applyVoiceFilters these two SHOULD always be 0; if not, something
      // is broken in the strip regex.
      dash_hits_after_strip: post.dashes,
      plus_hits_after_strip: post.plus_examples,
      // avoid_phrases is not hard-fixed (no safe deterministic substitution),
      // so this can be non-empty even after a retry — UI surfaces a warning.
      avoid_phrase_hits: post.avoid_phrases,
    },
  };
}

/**
 * Generate (or regenerate) all variants for a given change. Returns an array
 * of { message_type, subject_line, body, usage, cost, ... } objects in the
 * order they were generated. Persists each row to generated_playbooks.
 *
 * Idempotency: if existing rows exist for (change_id, user_id), we update
 * those rows in place (incrementing regenerated_count) instead of inserting
 * duplicates.
 */
async function generatePlaybooksForChange(changeId, options = {}) {
  const db = getDb();
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY not configured', variants: [] };
  }

  const change = db.prepare(`
    SELECT ch.*, c.user_id, c.name AS competitor_name, c.url AS competitor_url
    FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
    WHERE ch.id = ?
  `).get(changeId);

  if (!change) return { ok: false, error: 'change not found', variants: [] };
  const userId = change.user_id;
  const competitor = { id: change.competitor_id, name: change.competitor_name, url: change.competitor_url };

  // Skip non-meaningful or low-threat changes (the task is explicit:
  // playbooks only for meaningful + high/medium threat changes).
  const isMeaningful = change.is_meaningful === null || change.is_meaningful === undefined ? 1 : change.is_meaningful;
  if (!isMeaningful) return { ok: false, error: 'change is not meaningful', variants: [] };
  if (!['high', 'medium'].includes(change.threat_level)) {
    return { ok: false, error: `playbooks only generated for high/medium threats (got ${change.threat_level})`, variants: [] };
  }

  const voiceProfile = getProfileWithDefaults(userId);
  let userContext = null;
  try { userContext = getUserContext(userId); } catch (_) {}

  let historyText = '';
  try {
    const hist = getCompetitorHistory(competitor.id, { userId });
    historyText = hist.formatted || '';
  } catch (_) { /* degrade silently */ }

  const variants = options.variants && Array.isArray(options.variants)
    ? options.variants
    : pickVariantsForUser(userContext);

  console.log(`  📝 Playbooks: generating ${variants.join(', ')} for change#${changeId} (user#${userId}, threat=${change.threat_level})`);

  const results = [];
  for (const variantKey of variants) {
    const temperature = options.temperature ?? 0.7;
    let row;
    try {
      const r = await generateOneVariant({
        change, competitor, voiceProfile, userContext, historyText,
        variantKey, temperature,
        prospectHint: options.prospectHint,
      });
      const cost = estimateCostUsd(r.usage);
      row = {
        change_id: changeId, user_id: userId, message_type: variantKey,
        subject_line: r.subject || null, body: r.body,
        ai_input_tokens: r.usage.input_tokens, ai_output_tokens: r.usage.output_tokens,
        estimated_cost_usd: cost,
        generation_status: (r.quality.avoid_phrase_hits.length === 0
                            && r.quality.dash_hits_after_strip === 0
                            && (r.quality.plus_hits_after_strip || []).length === 0)
          ? 'ok' : 'ok_with_warnings',
        generation_error: [
          r.quality.avoid_phrase_hits.length ? `avoid_phrase_hits: ${r.quality.avoid_phrase_hits.join(', ')}` : null,
          r.quality.dash_hits_after_strip   > 0 ? `dash_hits_after_strip: ${r.quality.dash_hits_after_strip}` : null,
          (r.quality.plus_hits_after_strip || []).length ? `plus_connector_hits: ${r.quality.plus_hits_after_strip.join(' | ')}` : null,
        ].filter(Boolean).join('; ') || null,
        quality: r.quality,
      };
      const retryMark = r.quality.attempts > 1 ? ' (retried)' : '';
      const warn = [
        r.quality.avoid_phrase_hits.length ? `avoid=${r.quality.avoid_phrase_hits.join('|')}` : null,
        r.quality.dash_hits_after_strip   > 0 ? `dashes=${r.quality.dash_hits_after_strip}`  : null,
        (r.quality.plus_hits_after_strip || []).length ? `plus=${r.quality.plus_hits_after_strip.length}` : null,
      ].filter(Boolean).join(' ');
      console.log(`  ✓ ${variantKey}: in=${r.usage.input_tokens} out=${r.usage.output_tokens} ≈$${cost.toFixed(4)}${retryMark}${warn ? `  ⚠️  ${warn}` : ''}`);
    } catch (err) {
      console.error(`  ✗ ${variantKey} failed: ${err.message}`);
      row = {
        change_id: changeId, user_id: userId, message_type: variantKey,
        subject_line: null, body: '',
        ai_input_tokens: err.usage?.input_tokens ?? null,
        ai_output_tokens: err.usage?.output_tokens ?? null,
        estimated_cost_usd: 0,
        generation_status: err.code || 'failed',
        generation_error: err.message?.slice(0, 500) || 'unknown error',
        quality: null,
      };
    }

    // Upsert: if a row already exists for (change_id, user_id, message_type),
    // update it and bump regenerated_count. Otherwise insert fresh.
    const existing = db.prepare(`
      SELECT id, regenerated_count FROM generated_playbooks
      WHERE change_id = ? AND user_id = ? AND message_type = ?
    `).get(changeId, userId, variantKey);

    if (existing) {
      db.prepare(`
        UPDATE generated_playbooks
        SET subject_line = ?, body = ?,
            ai_input_tokens = ?, ai_output_tokens = ?, estimated_cost_usd = ?,
            generation_status = ?, generation_error = ?,
            regenerated_count = regenerated_count + 1,
            generated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        row.subject_line, row.body,
        row.ai_input_tokens, row.ai_output_tokens, row.estimated_cost_usd,
        row.generation_status, row.generation_error,
        existing.id,
      );
      row.id = existing.id;
      row.regenerated_count = (existing.regenerated_count || 0) + 1;
    } else {
      const res = db.prepare(`
        INSERT INTO generated_playbooks
          (change_id, user_id, message_type, subject_line, body,
           ai_input_tokens, ai_output_tokens, estimated_cost_usd,
           generation_status, generation_error, regenerated_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        row.change_id, row.user_id, row.message_type, row.subject_line, row.body,
        row.ai_input_tokens, row.ai_output_tokens, row.estimated_cost_usd,
        row.generation_status, row.generation_error,
      );
      row.id = res.lastInsertRowid;
      row.regenerated_count = 0;
    }

    results.push(row);

    // Small inter-call delay so a transient rate limit on one variant doesn't
    // immediately cascade into the next.
    await new Promise(r => setTimeout(r, 500));
  }

  return { ok: true, variants: results };
}

/**
 * Regenerate ONE specific playbook row. Caller has already confirmed user
 * ownership. Uses a slightly higher temperature than the initial generation
 * so the re-roll actually differs.
 */
async function regenerateSinglePlaybook(playbookId, { temperature = 0.95, prospectHint } = {}) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM generated_playbooks WHERE id = ?
  `).get(playbookId);
  if (!row) return { ok: false, error: 'playbook not found' };

  const result = await generatePlaybooksForChange(row.change_id, {
    variants: [row.message_type],
    temperature,
    prospectHint,
  });
  if (!result.ok) return result;
  const updated = result.variants.find(v => v.message_type === row.message_type);
  return { ok: true, variant: updated };
}

function getPlaybooksForChange(changeId, userId) {
  if (!Number.isInteger(changeId) || !Number.isInteger(userId)) return [];
  return getDb().prepare(`
    SELECT id, change_id, user_id, message_type, subject_line, body,
           ai_input_tokens, ai_output_tokens, estimated_cost_usd,
           generation_status, generation_error,
           generated_at, regenerated_count
    FROM generated_playbooks
    WHERE change_id = ? AND user_id = ?
    ORDER BY
      CASE message_type
        WHEN 'slack_to_team'      THEN 1
        WHEN 'email_to_prospect'  THEN 2
        WHEN 'followup_email'     THEN 3
        ELSE 4
      END
  `).all(changeId, userId);
}

function getRecentPlaybooksForUser(userId, limit = 5) {
  if (!Number.isInteger(userId)) return [];
  return getDb().prepare(`
    SELECT p.id, p.change_id, p.message_type, p.subject_line,
           p.generated_at, p.regenerated_count,
           ch.headline AS change_headline, ch.threat_level,
           c.id AS competitor_id, c.name AS competitor_name
    FROM generated_playbooks p
    JOIN changes ch     ON p.change_id = ch.id
    JOIN competitors c  ON ch.competitor_id = c.id
    WHERE p.user_id = ?
      AND p.generation_status IN ('ok', 'ok_with_warnings')
    ORDER BY p.generated_at DESC
    LIMIT ?
  `).all(userId, Math.max(1, Math.min(20, limit)));
}

module.exports = {
  generatePlaybooksForChange,
  regenerateSinglePlaybook,
  getPlaybooksForChange,
  getRecentPlaybooksForUser,
  pickVariantsForUser,
  // exported for tests
  VARIANTS,
  SYSTEM_PROMPT_HEADER,
  buildVariantPrompt,
  applyVoiceFilters,
  stripDashes,
  stripPlusConnectors,
  detectPlusConnectors,
  applyContractions,
  expandContractions,
  parseJsonResponse,
  estimateCostUsd,
  scanForbidden,
  scanViolations,
  postGenerationCheck: scanViolations,
  buildCorrectionPrompt,
  safeWrap,
};
