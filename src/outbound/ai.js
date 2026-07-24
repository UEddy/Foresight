// Outbound — Anthropic helpers.
//
// Mirrors src/analyzer.js: one lazily-constructed client keyed off
// ANTHROPIC_API_KEY, the same model, and safe JSON parsing (strip code fences,
// retry once). Two call shapes:
//   structuredCall() — strict JSON out, parsed with one retry (extract + score)
//   draftCall()      — free-text out, system prompt = the outbound agent (draft)
//
// Every call is capped on max_tokens and never throws past the caller: the
// pipeline wraps each lead in try/catch, so a single bad call degrades that lead
// rather than failing the run. Both shapes go through withRetry(), so a 429 or a
// 529 overload backs off (1s, 2s, 4s) instead of degrading the lead on the first
// rate-limit blip.

const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('../lib/retry');

// Matches the model used elsewhere in the app (src/analyzer.js).
const MODEL = 'claude-sonnet-4-6';

let client;
function getClient() {
  if (!client) {
    // maxRetries: 0 because withRetry() owns the backoff for these calls. Left
    // at the SDK default the two schemes would compound into a much longer,
    // harder-to-reason-about wait.
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  }
  return client;
}

function hasKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Pull the first JSON value out of a model response, tolerating ```json fences
// and surrounding prose.
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // Strip a leading/trailing code fence if present.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Fall back to the first {...} or [...] block.
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  const slice = s.slice(start, end + 1);
  try { return JSON.parse(slice); } catch (_) { return null; }
}

// Ask the model for strict JSON and parse it. Retries once (with a terser
// reminder) on a parse failure. Returns the parsed value, or null if both
// attempts fail. Never throws.
//
// wantRaw: return { parsed, raw } instead, where raw is the model's literal
// text output (last attempt). Used by diagnostics to show WHAT the model said
// when it produced no usable JSON or an empty result. Default callers are
// unaffected.
async function structuredCall({ system, user, maxTokens = 2000, wantRaw = false }) {
  if (!hasKey()) return wantRaw ? { parsed: null, raw: null } : null;
  const attempt = async (extra) => {
    const resp = await withRetry(() => getClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: extra ? `${user}\n\n${extra}` : user }],
    }), { label: 'anthropic structuredCall' });
    const text = resp?.content?.map(b => b.text || '').join('') || '';
    return { text, parsed: extractJson(text) };
  };
  try {
    const first = await attempt();
    if (first.parsed != null) return wantRaw ? { parsed: first.parsed, raw: first.text } : first.parsed;
    const second = await attempt('Respond with valid JSON only. No prose, no code fences.');
    return wantRaw ? { parsed: second.parsed, raw: second.text } : second.parsed;
  } catch (err) {
    console.warn('[outbound.ai] structuredCall failed:', err?.message || err);
    return wantRaw ? { parsed: null, raw: null } : null;
  }
}

// Free-text drafting call. system = the outbound agent prompt. Returns the raw
// text (caller sanitizes), or null on failure.
async function draftCall({ system, user, maxTokens = 700 }) {
  if (!hasKey()) return null;
  try {
    const resp = await withRetry(() => getClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }), { label: 'anthropic draftCall' });
    return resp?.content?.map(b => b.text || '').join('').trim() || null;
  } catch (err) {
    console.warn('[outbound.ai] draftCall failed:', err?.message || err);
    return null;
  }
}

module.exports = { getClient, hasKey, extractJson, structuredCall, draftCall, MODEL };
