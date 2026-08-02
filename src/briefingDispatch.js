// Phase 7 — pre-meeting briefing dispatch service.
//
// Runs on a 5-minute cron. Selects tracked_meetings that fall inside the
// briefing window (start_time within [now+lead-5, now+lead+5] for each user's
// configured lead, default 30 min), look up the competitor's most recent
// meaningful change, call Haiku to condense the existing battle-card talking
// points into pre-meeting punchiness, and push to Slack/Discord.
//
// Idempotency: rows are flipped to 'sent' on success, 'failed' (with error
// detail) on retryable failures. We never re-send 'sent' rows.
//
// Tenant safety: every query joins through user_id; the AI call only sees
// content the user already owns.

const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { getDb } = require('./db');
const { sanitizeCopy } = require('./lib/sanitizeText');

const BRIEFING_WINDOW_MINUTES   = 5;        // ±5 around the user's configured lead
const RECENT_CHANGE_LOOKBACK_DAYS = 14;
const MAX_BRIEFING_RETRIES      = 1;        // we already retry inside the cron tick implicitly
const HAIKU_MODEL               = 'claude-haiku-4-5-20251001';

let anthropic;
function getAnthropic() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

// Haiku-priced (Jan 2026): $1.00 / 1M input, $5.00 / 1M output
function estimateHaikuCostUsd(usage) {
  if (!usage) return 0;
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  return (inp * 1 + out * 5) / 1_000_000;
}

// ── Haiku call: condense battle card into pre-meeting talking points ────────

async function condenseTalkingPoints({ competitorName, meetingTitle, headline, summary, talkingPoints }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    // Fallback: just slice the existing talking_points array
    return {
      talkingPoints: (talkingPoints || []).slice(0, 3).map(p => sanitizeCopy(String(p).trim())).filter(Boolean),
      usage: null,
      source: 'fallback',
    };
  }

  const userPrompt =
`You're prepping a sales representative who walks into "${meetingTitle}" in 30 minutes.
The competitor in this meeting is "${competitorName}".

Their most recent material move:
HEADLINE: ${headline}
SUMMARY:  ${summary}

Battle-card talking points the team already has:
${(talkingPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n')}

Condense to 2-3 ultra-punchy talking points (max ~110 chars each) framed for
a sales representative who has 30 minutes to walk in. Lead with the most pointed line.
Return ONLY a JSON array of strings, no prose, no markdown fences.`;

  const resp = await getAnthropic().messages.create({
    model: HAIKU_MODEL,
    max_tokens: 400,
    system:
`You write tight, factual pre-meeting prep for B2B sales representatives. No fluff.

STYLE GUIDELINES (apply to every talking point you write):
- Never use em-dashes (—), en-dashes (–), or the "+" character as a connector between words or phrases. Write "and" instead, or use commas, periods, colons, or parentheses. Ordinary hyphens in compound words ("pre-meeting") are fine. The ONLY time you may write "+" is when quoting a competitor's literal product name, plan name, or pricing string exactly as it appears on their site.
- Do not use the terms "battlecards" or "battle cards." Use "competitive briefings," "sales positioning notes," or "competitor playbooks" instead.
- Write naturally and concisely. Avoid AI-tells like "leverage," "delve," "robust," "seamless," "In summary," or "It's worth noting that."
- When listing items, use "and" or commas between them, never the "+" character, em-dashes, or en-dashes.`,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = resp.content?.[0]?.text || '';
  let parsed;
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch (_) { parsed = null; }

  // Strip any em/en dashes and connector-plus the model slipped in (punctuation
  // convention, CLAUDE.md).
  const points = (Array.isArray(parsed)
    ? parsed.map(p => String(p).trim()).filter(Boolean).slice(0, 3)
    : (talkingPoints || []).slice(0, 3)
  ).map(sanitizeCopy);

  return {
    talkingPoints: points,
    usage: resp.usage
      ? { input_tokens: resp.usage.input_tokens || 0, output_tokens: resp.usage.output_tokens || 0 }
      : null,
    source: parsed ? 'haiku' : 'fallback_parse_error',
  };
}

// ── Webhook formatters ──────────────────────────────────────────────────────

const THREAT_EMOJI = { low: '🟢', medium: '🟡', high: '🔴' };

function formatSlackPayload({ competitor, meeting, change, points, matchReason, appUrl }) {
  const startStr = new Date(meeting.start_time).toLocaleString();
  const matchLabel = {
    title:  'matched on meeting title',
    domain: 'attendee from competitor domain',
    manual: 'manually tagged',
  }[matchReason] || 'auto-detected';

  if (!change) {
    return {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `📅 Heads up: ${competitor.name} mentioned in your next meeting` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${meeting.title}*\n${startStr} · ${matchLabel}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `No material changes detected for ${competitor.name} in the last ${RECENT_CHANGE_LOOKBACK_DAYS} days. <${appUrl}/app#/competitors|View their full timeline>.` } },
      ],
    };
  }

  const emoji = THREAT_EMOJI[change.threat_level] || '⚪';
  const changeDate = String(change.detected_at || '').slice(0, 10);
  const pointBlock = points.length > 0
    ? `*Talking points (${points.length})*\n${points.map(p => `• ${p}`).join('\n')}`
    : '_No talking points available._';

  return {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📅 Heads up: competitive context for your meeting' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${meeting.title}*\n${startStr} · ${matchLabel}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${competitor.name}*, most recent change (${changeDate}):\n${emoji} *${change.headline || 'Change detected'}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: pointBlock } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Nivaria · <${appUrl}/app#/history/${change.id}|Full brief>` }] },
    ],
  };
}

function formatDiscordPayload({ competitor, meeting, change, points, matchReason, appUrl }) {
  const startStr = new Date(meeting.start_time).toLocaleString();
  const matchLabel = {
    title:  'matched on meeting title',
    domain: 'attendee from competitor domain',
    manual: 'manually tagged',
  }[matchReason] || 'auto-detected';

  if (!change) {
    return {
      username: 'Nivaria',
      embeds: [{
        title: `📅 ${competitor.name} mentioned in your next meeting`,
        description: `**${meeting.title}**\n${startStr} · ${matchLabel}\n\nNo material changes in the last ${RECENT_CHANGE_LOOKBACK_DAYS} days.`,
        url: `${appUrl}/app#/competitors`,
        color: 0x6366f1,
        footer: { text: 'Nivaria · pre-meeting briefing' },
        timestamp: new Date().toISOString(),
      }],
    };
  }

  return {
    username: 'Nivaria',
    embeds: [{
      title: `📅 ${competitor.name}: pre-meeting briefing`,
      description: `**${meeting.title}**\n${startStr} · ${matchLabel}\n\n**${change.headline || 'Change detected'}**`,
      url: `${appUrl}/app#/history/${change.id}`,
      color: { low: 0x10b981, medium: 0xf59e0b, high: 0xef4444 }[change.threat_level] || 0x6366f1,
      fields: [
        { name: 'Threat', value: (change.threat_level || 'low').toUpperCase(), inline: true },
        { name: 'Detected', value: String(change.detected_at || '').slice(0, 10), inline: true },
        { name: 'Talking points', value: points.length > 0 ? points.map(p => `• ${p}`).join('\n') : 'None', inline: false },
      ],
      footer: { text: 'Nivaria · pre-meeting briefing' },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

async function pushBriefing(settings, payloadBuilder, args) {
  const sent = [];
  if (settings.slack_webhook) {
    try {
      await axios.post(settings.slack_webhook, formatSlackPayload(args), { timeout: 10000 });
      sent.push('slack');
    } catch (e) {
      console.error(`[briefing] slack push failed: ${e.message}`);
    }
  }
  if (settings.discord_webhook) {
    try {
      await axios.post(settings.discord_webhook, formatDiscordPayload(args), { timeout: 10000 });
      sent.push('discord');
    } catch (e) {
      console.error(`[briefing] discord push failed: ${e.message}`);
    }
  }
  return sent;
}

async function dispatchOne(meeting) {
  const db = getDb();
  const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(meeting.user_id);
  if (!settings || settings.briefings_enabled === 0) {
    db.prepare("UPDATE tracked_meetings SET briefing_status = 'skipped', briefing_error = 'briefings disabled or no settings' WHERE id = ?").run(meeting.id);
    return { id: meeting.id, status: 'skipped', reason: 'briefings_disabled_or_no_settings' };
  }
  if (!settings.slack_webhook && !settings.discord_webhook) {
    db.prepare("UPDATE tracked_meetings SET briefing_status = 'skipped', briefing_error = 'no webhook configured' WHERE id = ?").run(meeting.id);
    return { id: meeting.id, status: 'skipped', reason: 'no_webhook' };
  }

  const competitor = db.prepare('SELECT id, name, url FROM competitors WHERE id = ? AND user_id = ?')
    .get(meeting.matched_competitor_id, meeting.user_id);
  if (!competitor) {
    db.prepare("UPDATE tracked_meetings SET briefing_status = 'skipped', briefing_error = 'competitor missing' WHERE id = ?").run(meeting.id);
    return { id: meeting.id, status: 'skipped', reason: 'competitor_missing' };
  }

  // Most recent meaningful change in the last N days. The baseline snapshot is
  // excluded: a pre-meeting briefing is about what moved, and nothing moved
  // when the page was first captured.
  const change = db.prepare(`
    SELECT id, headline, threat_level, analysis, talking_points, detected_at
    FROM changes
    WHERE competitor_id = ?
      AND (is_meaningful IS NULL OR is_meaningful = 1)
      AND COALESCE(is_baseline, 0) = 0
      AND detected_at >= datetime('now', ?)
    ORDER BY detected_at DESC LIMIT 1
  `).get(competitor.id, `-${RECENT_CHANGE_LOOKBACK_DAYS} days`);

  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  let points = [];
  let aiUsage = null;
  let aiSource = null;

  if (change) {
    let analysis = {};
    try { analysis = JSON.parse(change.analysis || '{}'); } catch (_) { analysis = {}; }
    let existingPoints = [];
    try { existingPoints = JSON.parse(change.talking_points || '[]'); } catch (_) { existingPoints = []; }
    if (!Array.isArray(existingPoints)) existingPoints = [];

    try {
      const condensed = await condenseTalkingPoints({
        competitorName: competitor.name,
        meetingTitle:   meeting.title,
        headline:       change.headline || analysis.headline || '',
        summary:        analysis.summary || '',
        talkingPoints:  existingPoints,
      });
      points = condensed.talkingPoints;
      aiUsage = condensed.usage;
      aiSource = condensed.source;
    } catch (e) {
      // Haiku failed — fall back to existing points so the briefing still goes out.
      console.warn(`[briefing] Haiku failed for meeting ${meeting.id}: ${e.message}`);
      points = existingPoints.slice(0, 3);
      aiSource = 'fallback_haiku_error';
    }
  }

  try {
    const sent = await pushBriefing(settings, null, {
      competitor,
      meeting,
      change,
      points,
      matchReason: meeting.match_reason,
      appUrl,
    });
    if (sent.length === 0) {
      db.prepare("UPDATE tracked_meetings SET briefing_status = 'failed', briefing_error = 'all configured webhooks failed' WHERE id = ?").run(meeting.id);
      return { id: meeting.id, status: 'failed', reason: 'all_webhooks_failed' };
    }
    db.prepare("UPDATE tracked_meetings SET briefing_status = 'sent', briefing_sent_at = CURRENT_TIMESTAMP, briefing_error = NULL WHERE id = ?").run(meeting.id);
    const cost = aiUsage ? estimateHaikuCostUsd(aiUsage) : 0;
    console.log(`[briefing] ✅ sent meeting=${meeting.id} competitor=${competitor.name} channels=${sent.join('+')} ai=${aiSource}${aiUsage ? ` in=${aiUsage.input_tokens} out=${aiUsage.output_tokens} ≈$${cost.toFixed(5)}` : ''}`);
    return { id: meeting.id, status: 'sent', channels: sent, ai_usage: aiUsage, ai_cost_usd: cost };
  } catch (e) {
    db.prepare("UPDATE tracked_meetings SET briefing_status = 'failed', briefing_error = ? WHERE id = ?").run(e.message.slice(0, 500), meeting.id);
    return { id: meeting.id, status: 'failed', reason: e.message };
  }
}

async function runScheduledDispatch() {
  const db = getDb();
  // Compute the dispatch window per-user since lead time is configurable.
  // We pull all pending meetings in the next ~75 min, then filter in JS.
  const candidates = db.prepare(`
    SELECT m.*, s.briefing_lead_minutes
    FROM tracked_meetings m
    LEFT JOIN settings s ON s.user_id = m.user_id
    WHERE m.briefing_status = 'pending'
      AND m.matched_competitor_id IS NOT NULL
      AND m.start_time >= datetime('now')
      AND m.start_time <= datetime('now', '+75 minutes')
  `).all();

  const nowMs = Date.now();
  const due = candidates.filter(m => {
    const lead = Number.isInteger(m.briefing_lead_minutes) ? m.briefing_lead_minutes : 30;
    const targetMs = nowMs + lead * 60 * 1000;
    const startMs  = new Date(m.start_time).getTime();
    return Math.abs(startMs - targetMs) <= BRIEFING_WINDOW_MINUTES * 60 * 1000;
  });

  if (due.length === 0) return;
  console.log(`[briefing] ⏰ Dispatch tick: ${due.length} meeting(s) due`);
  for (const m of due) {
    try { await dispatchOne(m); }
    catch (e) { console.error(`[briefing] dispatch failed for ${m.id}: ${e.message}`); }
  }
}

module.exports = {
  runScheduledDispatch,
  dispatchOne,
  condenseTalkingPoints, // exported for tests
  formatSlackPayload,
  formatDiscordPayload,
  estimateHaikuCostUsd,
};
