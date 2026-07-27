const cron = require('node-cron');
const { getDb } = require('./db');
const { fetchPageContent, generateDiff, classifyScrapeError } = require('./scraper');
const { analyzeChange, buildBaselineRecord, buildFallbackAnalysis, estimateCostUsd } = require('./analyzer');
const { getTrialInfo } = require('./lib/trial');
const { TRIAL_REMINDER_DAYS_LEFT } = require('./config');
const { classifyChange } = require('./changeGate');
const { sendAlerts, sendPatternAlert } = require('./webhooks');
const { sendBriefEmail, sendTrialEmail } = require('./email');
const { canWorkspaceAccess } = require('./lib/tierLimits');
const { classifyChangeTypes, PATTERN_TYPES, TYPE_LABEL, runNightlyForAllUsers } = require('./correlationEngine');
const { getCompetitorHistory, invalidateCompetitorHistory } = require('./historicalContext');
const { getUserContext, formatContextForPrompt, hasMeaningfulContext } = require('./userContext');
const { generatePlaybooksForChange } = require('./playbooks');

// Thin adapter over the scraper's central classifier. Kept (and exported) so the
// scheduler has one call site and the error vocabulary lives in exactly one place
// (src/scraper.js). `url` lets the classifier put the offending URL in the log.
function fetchErrorToStatus(err, url) {
  return classifyScrapeError(err, url);
}

async function checkCompetitor(competitor, db) {
  const renderMode = competitor.render_mode === 'js' ? 'js' : 'fetch';
  console.log(`  Checking: ${competitor.name} (${competitor.url}) [render=${renderMode}]`);

  db.prepare(`UPDATE competitors SET last_checked = CURRENT_TIMESTAMP, check_count = check_count + 1 WHERE id = ?`)
    .run(competitor.id);

  // ── FETCH ────────────────────────────────────────────────────────────────────
  let content, hash, renderDuration;
  try {
    const r = await fetchPageContent(competitor.url, {
      cssSelector: competitor.css_selector || null,
      renderMode,
    });
    content        = r.content;
    hash           = r.hash;
    renderDuration = r.renderDuration;
    console.log(`  ⏱  render=${renderMode} duration=${renderDuration}ms`);
  } catch (err) {
    const { error_type, status, human, technical } = fetchErrorToStatus(err, competitor.url);
    // Log the engineer-facing reason (error_type + URL); store the user-facing
    // message so the UI never has to surface a raw code or a stack-trace string.
    console.error(`  ✗ Fetch failed [${error_type}] ${competitor.name} (render=${renderMode}) — ${technical}`);
    db.prepare(`UPDATE competitors SET last_check_status = ?, last_check_error = ?, last_check_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(status, human.slice(0, 500), competitor.id);
    return { ok: false, status, error_type, error: human };
  }

  // ── SILENT BASELINE (first check of a newly monitored page) ────────────────
  // A page with no last_content_hash has never been captured, so nothing on it
  // can have changed yet. Whatever it shows right now, including content that
  // predates the user adding it, is the STARTING STATE. We record it as the
  // baseline the next scrape diffs against, and we do NOT alert, email, or brief
  // on it. This is unconditional: every newly added page behaves the same way,
  // whether it came from the add route, a manual check, a page added under an
  // existing grouped competitor, or the nightly scheduler picking it up first.
  if (!competitor.last_content_hash) {
    return await recordBaseline(competitor, db, content, hash);
  }

  // ── CHANGE DETECTION ─────────────────────────────────────────────────────────
  const hashChanged = competitor.last_content_hash && competitor.last_content_hash !== hash;
  let changeRowId   = null;
  let analysisStatus = 'ok';
  let analysisError  = null;

  let isMeaningful = 1;
  let gateCategory = null;
  let gateReason   = null;
  let aiInputTokens  = null;
  let aiOutputTokens = null;
  let patternTagsJson      = null;
  let historicalContextStr = null;
  let contextUsed = 0;

  if (hashChanged) {
    console.log(`  ⚡ Change detected: ${competitor.name}`);

    // The most recent stored snapshot is what we diff against. For a page on its
    // second scrape that row is the silent baseline, so the very first brief a
    // user gets describes what moved SINCE the baseline, never the content that
    // was already sitting there when they added the page. id DESC breaks ties
    // when two rows share a timestamp.
    const previousChange = db.prepare(
      `SELECT content_after FROM changes WHERE competitor_id = ? ORDER BY detected_at DESC, id DESC LIMIT 1`
    ).get(competitor.id);

    const before = previousChange ? JSON.parse(previousChange.content_after) : null;
    const diff = generateDiff(before, content);

    // ── GATE: classify cheaply before spending an AI call ───────────────────
    const gate = classifyChange(before, content, diff);
    gateCategory = gate.category;
    gateReason   = gate.reason;
    console.log(`  🚪 Gate: ${gate.meaningful ? 'MEANINGFUL' : 'trivial'} (${gate.category}) — ${gate.reason}`);

    let analysis;
    if (!gate.meaningful) {
      // Skip the AI entirely. Persist a thin record so the user can still
      // see what was gated if they enable the trivial filter, but no
      // webhook is fired and no tokens are spent.
      isMeaningful = 0;
      analysis = buildTrivialAnalysis(competitor, gate);
      analysisStatus = 'trivial';
    } else if (!process.env.ANTHROPIC_API_KEY) {
      analysis = buildFallbackAnalysis(competitor, diff);
      analysisStatus = 'no_ai_key';
      analysisError  = 'ANTHROPIC_API_KEY not configured';
    } else {
      // Phase 5: pull the competitor's recent history so the AI can reference
      // patterns ("third pricing change this quarter") instead of analyzing
      // each diff in isolation. Failures here must NEVER block the AI call —
      // we degrade silently to a history-less prompt.
      let historyText = '';
      let historyMeta = { count: 0, cacheHit: false, included: false, skipReason: null };
      // Phase 10: historical pattern context is a Pro feature. For a Free
      // workspace we omit the "PRIOR CHANGES (last 90 days)" section ENTIRELY
      // from the prompt (no stub, no placeholder) so the AI produces
      // single-change analysis as if no history exists — historical_context
      // stays empty in the brief. This is a real, defensible tier differentiator.
      const historyAllowed = canWorkspaceAccess(competitor.workspace_id, 'historical_context');
      if (!historyAllowed) {
        historyMeta.skipReason = 'free_tier';
      } else {
        try {
          const hist = getCompetitorHistory(competitor.id, { userId: competitor.user_id });
          historyText = hist.formatted;
          historyMeta = {
            count: hist.count,
            cacheHit: hist.cacheHit,
            included: hist.count > 0,
            skipReason: hist.count === 0 ? 'no_prior_changes' : null,
          };
        } catch (histErr) {
          historyMeta.skipReason = `history_fetch_failed: ${histErr.message}`;
          console.warn(`  ⚠️  History fetch failed for ${competitor.name}: ${histErr.message}`);
        }
      }
      console.log(`  📜 History: ${historyMeta.included
        ? `${historyMeta.count} prior changes included${historyMeta.cacheHit ? ' (cached)' : ''}`
        : `skipped (${historyMeta.skipReason})`}`);

      // Phase 6: pull the user's business context so the AI can frame the
      // analysis from their perspective (ICP, positioning, deal size). Same
      // degradation rule as history — a fetch failure must never block the
      // AI call; we fall back to a context-less generic prompt.
      let userContextText = '';
      let contextMeta = { included: false, skipReason: 'no_user_context' };
      try {
        const userCtx = getUserContext(competitor.user_id);
        if (hasMeaningfulContext(userCtx)) {
          userContextText = formatContextForPrompt(userCtx);
          contextMeta = { included: true, skipReason: null, companyName: userCtx.company_name || null };
          contextUsed = 1;
        }
      } catch (ctxErr) {
        contextMeta.skipReason = `context_fetch_failed: ${ctxErr.message}`;
        console.warn(`  ⚠️  User-context fetch failed for ${competitor.name}: ${ctxErr.message}`);
      }
      console.log(`  👤 User context: ${contextMeta.included
        ? `included${contextMeta.companyName ? ` (${contextMeta.companyName})` : ''}`
        : `skipped (${contextMeta.skipReason})`}`);

      try {
        const result = await analyzeChange(competitor, before, content, diff, historyText, userContextText);
        analysis = result.analysis;
        analysisStatus = 'ok';
        if (result.usage) {
          aiInputTokens  = result.usage.input_tokens;
          aiOutputTokens = result.usage.output_tokens;
          const cost = estimateCostUsd(result.usage);
          console.log(`  💰 AI usage: in=${aiInputTokens} out=${aiOutputTokens} ≈$${cost.toFixed(4)}${historyMeta.included ? ` [+history: ${historyMeta.count} rows]` : ''}`);
        }
        // Persist Phase 5 fields if the AI produced them.
        if (Array.isArray(analysis.pattern_tags) && analysis.pattern_tags.length > 0) {
          patternTagsJson = JSON.stringify(analysis.pattern_tags);
        }
        if (typeof analysis.historical_context === 'string' && analysis.historical_context.trim()) {
          historicalContextStr = analysis.historical_context.trim().slice(0, 1000);
        }
        // Post-hoc downgrade: AI looked at the diff and decided there was
        // nothing of strategic significance. Treat exactly like a gated row —
        // record stays for transparency, but no webhook fires.
        if (analysis.is_meaningful === false) {
          isMeaningful = 0;
          gateCategory = 'ai_downgraded';
          gateReason   = analysis.why_it_matters || 'AI judged change as non-meaningful';
          console.log(`  🚪 AI post-hoc downgrade: ${gateReason}`);
        }
      } catch (aiErr) {
        const code = aiErr.code || 'ai_error';
        const msg  = aiErr.message || String(aiErr);
        console.error(`  ⚠️  AI analysis failed (${code}) for ${competitor.name}: ${msg}`);
        analysis = buildFallbackAnalysis(competitor, diff);
        analysisStatus = code;
        analysisError  = msg.slice(0, 500);
      }
    }

    const insertResult = db.prepare(`
      INSERT INTO changes (competitor_id, content_before, content_after, diff_summary, analysis, threat_level, recommended_response, talking_points, headline, analysis_status, analysis_error, is_meaningful, gate_category, gate_reason, ai_input_tokens, ai_output_tokens, pattern_tags, historical_context, context_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      competitor.id,
      previousChange?.content_after || null,
      JSON.stringify(content),
      JSON.stringify(diff),
      JSON.stringify(analysis),
      analysis.threat_level,
      analysis.recommended_response,
      JSON.stringify(analysis.talking_points || []),
      analysis.headline,
      analysisStatus === 'ok' ? 'ok' : (analysisStatus === 'trivial' ? 'trivial' : 'failed'),
      analysisError,
      isMeaningful,
      gateCategory,
      gateReason ? gateReason.slice(0, 500) : null,
      aiInputTokens,
      aiOutputTokens,
      patternTagsJson,
      historicalContextStr,
      contextUsed,
    );
    changeRowId = insertResult.lastInsertRowid;

    // Phase 5: drop cached history for this competitor so the next analysis
    // (manual or scheduled) picks up this change instead of serving stale data.
    invalidateCompetitorHistory(competitor.id);

    // Alert only when (a) AI analysis succeeded, AND (b) the change is
    // meaningful (gate + AI both agree it's worth a sales team's attention).
    if (analysisStatus === 'ok' && isMeaningful === 1) {
      const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(competitor.user_id);

      // Brief-notification email. Unlike the Slack/Discord webhooks below, the
      // email is NOT tier-gated: the Free plan's stated fallback is "AI briefs
      // by email", so every meaningful brief is emailed regardless of tier,
      // gated only on the brief_email_enabled preference (default ON).
      // Recipient rule: the configured notification_email if set, otherwise the
      // account email. Best effort: sendBriefEmail never throws and logs
      // failures itself; the lookup is wrapped so nothing here can disrupt the
      // pipeline. No email address or brief content is logged.
      if (settings && settings.brief_email_enabled !== 0) {
        try {
          const account = db.prepare('SELECT email FROM users WHERE id = ?').get(competitor.user_id);
          const recipient = settings.notification_email || account?.email;
          if (recipient) {
            await sendBriefEmail(recipient, { competitor, analysis, changeId: changeRowId });
          }
        } catch (emailErr) {
          console.error('[EMAIL_DELIVERY_FAILED]', { error: emailErr.message, purpose: 'brief_notification' });
        }
      }

      if (settings && canWorkspaceAccess(competitor.workspace_id, 'webhooks')) {
        try {
          await sendAlerts(settings, competitor, analysis, changeRowId);
        } catch (alertErr) {
          console.error(`  ⚠️  Alert delivery failed for ${competitor.name}: ${alertErr.message}`);
        }

        // Phase 9: forward-looking pattern alerts. If the user subscribed to
        // "tell me when this competitor repeats this kind of move", and this
        // change classifies as that move type, fire a terse heads-up. Best
        // effort — never blocks the pipeline.
        try {
          const changeTypes = classifyChangeTypes({
            pattern_tags: patternTagsJson,
            analysis: JSON.stringify(analysis),
            gate_category: gateCategory,
          });
          for (const t of changeTypes) {
            const patternType = PATTERN_TYPES[t];
            const sub = db.prepare(
              'SELECT 1 FROM pattern_alerts WHERE user_id = ? AND competitor_id = ? AND pattern_type = ?'
            ).get(competitor.user_id, competitor.id, patternType);
            if (sub) {
              console.log(`  🔔 Pattern alert match: ${competitor.name} ${patternType}`);
              await sendPatternAlert(settings, competitor, analysis, changeRowId, TYPE_LABEL[t]);
            }
          }
        } catch (patErr) {
          console.error(`  ⚠️  Pattern alert check failed for ${competitor.name}: ${patErr.message}`);
        }
      }
    }

    // Phase 8: generated response playbooks. Fire-and-forget — must NOT block
    // the change-detection pipeline. Only runs when (a) analysis succeeded,
    // (b) the change is meaningful, and (c) threat is high or medium. We
    // intentionally do not await this — the next scheduled check should run
    // even if playbook generation is slow or rate-limited.
    if (analysisStatus === 'ok' && isMeaningful === 1
        && ['high', 'medium'].includes(analysis.threat_level)) {
      generatePlaybooksForChange(changeRowId).catch(err => {
        console.error(`  ⚠️  Playbook generation failed for change#${changeRowId}: ${err.message}`);
      });
    }
  }

  // ── ALWAYS advance baseline + check status on a successful fetch ────────────
  // Gated-trivial counts as 'ok' for the competitor's check status — the
  // pipeline ran exactly as intended; we just chose not to call the AI.
  const finalStatus = !hashChanged
    ? 'ok'
    : (analysisStatus === 'ok' || analysisStatus === 'trivial')
      ? 'ok'
      : `ok_${analysisStatus}`; // e.g. ok_ai_out_of_credits, ok_no_ai_key
  const finalError = (analysisStatus === 'ok' || analysisStatus === 'trivial') ? null : analysisError;

  db.prepare(`UPDATE competitors SET last_content_hash = ?, last_check_status = ?, last_check_error = ?, last_check_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(hash, finalStatus, finalError, competitor.id);

  return { ok: true, status: finalStatus, changed: !!hashChanged, changeRowId };
}

// ── Silent baseline (first snapshot of a newly monitored page) ────────────────
// Called from checkCompetitor on the first-ever successful fetch of a page.
// Nothing has changed yet, so this is deliberately SILENT: no AI call, no
// threat level, no webhook, no email, no playbooks. It does two things:
//
//   1. Stores the snapshot as the anchor every later diff is measured against.
//   2. Leaves one clearly-labelled "Monitoring started, baseline captured" row
//      so the dashboard shows that monitoring is live instead of sitting blank.
//
// The row is marked is_baseline = 1 and carries a NULL threat level, so every
// change counter, threat filter, alert path, and AI history prompt skips it. It
// records when the SNAPSHOT was taken, never a claim that the page changed.
async function recordBaseline(competitor, db, content, hash) {
  console.log(`  🌱 Baseline captured (no alert): ${competitor.name}`);

  const analysis = buildBaselineRecord(competitor, content);

  const insertResult = db.prepare(`
    INSERT INTO changes (competitor_id, content_before, content_after, diff_summary, analysis, threat_level, recommended_response, talking_points, headline, analysis_status, analysis_error, is_meaningful, is_baseline, gate_category, gate_reason, ai_input_tokens, ai_output_tokens, pattern_tags, historical_context, context_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    competitor.id,
    null,                                   // no prior state: this IS the baseline
    JSON.stringify(content),                // the anchor the next scrape diffs against
    JSON.stringify({ baseline: true }),
    JSON.stringify(analysis),
    null,                                   // no threat level: a baseline is not a threat
    analysis.recommended_response,
    JSON.stringify([]),
    analysis.headline,
    'ok',
    null,
    1,                                      // visible, so the dashboard is not blank
    1,                                      // is_baseline: never counted or alerted as a change
    'baseline',
    'first snapshot of a newly monitored page, not a change',
    null,
    null,
    null,
    null,
    0,
  );
  const changeRowId = insertResult.lastInsertRowid;
  invalidateCompetitorHistory(competitor.id);

  db.prepare(`UPDATE competitors SET last_content_hash = ?, last_check_status = 'ok', last_check_error = NULL, last_check_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(hash, competitor.id);

  return { ok: true, status: 'ok', changed: false, baseline: true, changeRowId };
}

async function runScheduledChecks() {
  const db = getDb();
  // Phase 10: daily monitoring is a Pro feature, gated by the workspace's
  // EFFECTIVE tier (honours cancellation grace periods). Free workspaces are
  // excluded — the scheduler never runs for them. Archived competitors (trial
  // expiry keeps them read-only above the Free cap) are never checked.
  const active = db.prepare(`
    SELECT c.* FROM competitors c
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.active = 1 AND COALESCE(c.archived, 0) = 0
  `).all();
  const competitors = active.filter(c => canWorkspaceAccess(c.workspace_id, 'daily_monitoring'));

  if (competitors.length === 0) {
    console.log('⏰ Scheduled check: no eligible competitors');
    return;
  }

  console.log(`\n🔄 Scheduled check: ${competitors.length} competitor(s)...`);

  for (const competitor of competitors) {
    try {
      await checkCompetitor(competitor, db);
    } catch (err) {
      // checkCompetitor now handles its own errors and writes status to DB.
      // Anything reaching here is a true programmer bug or DB failure.
      console.error(`  ✗ Unexpected failure for ${competitor.name}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  console.log('✅ Scheduled check complete\n');
}

// ── Trial lifecycle sweep ──────────────────────────────────────────────────────
// Runs daily. For every workspace on the trial overlay (trial_ends_at set, no
// paid subscription) it sends the day-10 and day-13 reminder emails and, on
// expiry, the "account still active" notice plus the Free-limit archive.
// Reminder markers are recorded in workspaces.trial_notices (JSON array) so a
// sweep is idempotent: each notice fires exactly once per workspace.
//
// Expiry never locks anything. Tier gating already fell back to Free the moment
// trial_ends_at passed (see getWorkspaceTier); this sweep only handles the
// side effects: archive competitors above the Free page limit (read-only,
// restored on upgrade, never deleted) and send the expiry email.
async function runTrialSweep() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT w.*, u.email AS owner_email
    FROM workspaces w
    JOIN users u ON u.id = w.owner_user_id
    WHERE w.trial_ends_at IS NOT NULL
      AND w.subscription_id IS NULL
      AND w.subscription_tier = 'free'
  `).all();
  if (!rows.length) return;

  for (const ws of rows) {
    let notices;
    try { notices = JSON.parse(ws.trial_notices || '[]'); } catch (_) { notices = []; }
    if (!Array.isArray(notices)) notices = [];
    if (notices.includes('expiry')) continue; // lifecycle complete

    const info = getTrialInfo(ws);
    const daysLeft = info.daysLeft ?? 0;
    const send = async (variant) => {
      try {
        await sendTrialEmail(ws.owner_email, { variant, daysLeft });
        notices.push(variant);
        db.prepare('UPDATE workspaces SET trial_notices = ? WHERE id = ?').run(JSON.stringify(notices), ws.id);
        console.log(`⏳ Trial ${variant} notice sent (workspace ${ws.id}, ${daysLeft} day(s) left)`);
      } catch (err) {
        console.error('[EMAIL_DELIVERY_FAILED]', { error: err.message, purpose: `trial_${variant}` });
      }
    };

    if (!info.onTrial) {
      // Expired: archive above the Free limit, then notify. Archive first so
      // the email's "what you keep" statement is already true when it lands.
      try { archiveOverFreeLimit(db, ws.id); }
      catch (err) { console.error(`[trial] archive failed for workspace ${ws.id}:`, err.message); }
      await send('expiry');
    } else if (daysLeft <= TRIAL_REMINDER_DAYS_LEFT.day13 && !notices.includes('day13')) {
      await send('day13');
    } else if (daysLeft <= TRIAL_REMINDER_DAYS_LEFT.day10 && !notices.includes('day10')) {
      await send('day10');
    }
  }
}

// Free keeps 1 competitor page: the oldest stays live, everything else is
// archived (read-only, excluded from monitoring and page counts). Nothing is
// deleted; the add route and the competitors list restore archived rows the
// moment the workspace is entitled again.
function archiveOverFreeLimit(db, workspaceId) {
  const keep = db.prepare(
    'SELECT id FROM competitors WHERE workspace_id = ? AND COALESCE(archived, 0) = 0 ORDER BY id ASC LIMIT 1'
  ).get(workspaceId);
  if (!keep) return 0;
  const r = db.prepare(
    'UPDATE competitors SET archived = 1 WHERE workspace_id = ? AND COALESCE(archived, 0) = 0 AND id != ?'
  ).run(workspaceId, keep.id);
  if (r.changes > 0) console.log(`📦 Archived ${r.changes} competitor page(s) over the Free limit (workspace ${workspaceId})`);
  return r.changes;
}

function startScheduler() {
  // Daily at 9 AM server time
  cron.schedule('0 9 * * *', () => {
    runScheduledChecks().catch(err => console.error('Scheduler error:', err));
  });

  // Phase 7: calendar sync every 15 min, briefing dispatch every 5 min.
  // Lazy-require so the scheduler still boots if the new modules have a
  // syntax issue (we'd rather lose Phase 7 than the whole change pipeline).
  try {
    const { runScheduledSync }     = require('./calendarSync');
    const { runScheduledDispatch } = require('./briefingDispatch');
    cron.schedule('*/15 * * * *', () => {
      runScheduledSync().catch(err => console.error('[calendar] sync error:', err.message));
    });
    cron.schedule('*/5 * * * *', () => {
      runScheduledDispatch().catch(err => console.error('[briefing] dispatch error:', err.message));
    });
    console.log('⏰ Phase 7 calendar sync (15m) + briefing dispatch (5m) scheduled');
  } catch (e) {
    console.warn('Phase 7 scheduler hooks not loaded:', e.message);
  }

  // Phase 9: nightly win/loss correlation recompute for every user with deals.
  // Pure data analysis (no AI), runs at 2:30 AM server time when the change
  // pipeline is idle. On-demand recompute also happens when a user opens the
  // ROI dashboard, so this is a backstop that keeps the dashboard widget warm.
  cron.schedule('30 2 * * *', () => {
    try { runNightlyForAllUsers(); }
    catch (err) { console.error('[correlations] nightly error:', err.message); }
  });
  console.log('⏰ Phase 9 nightly win/loss correlation scheduled (2:30 AM)');

  // Trial lifecycle: reminders (day 10, day 13) and expiry handling, daily at
  // 8:00 AM so the expiry email lands before the day's scheduled checks run.
  cron.schedule('0 8 * * *', () => {
    runTrialSweep().catch(err => console.error('[trial] sweep error:', err.message));
  });
  console.log('⏰ Trial lifecycle sweep scheduled (8:00 AM)');

  console.log('⏰ Scheduler started — daily checks at 9:00 AM');
}

// Stub analysis returned when the gate classifies a diff as trivial. We never
// call Anthropic, but we still write a row so users can audit gating decisions
// from the UI via the "Trivial" filter.
function buildTrivialAnalysis(competitor, gate) {
  return {
    is_meaningful: false,
    changed_what: `${competitor.name} page changed in a way that did not require analysis`,
    why_it_matters: `Gated as trivial: ${gate.reason}`,
    threat_level: 'low',
    threat_reasoning: `Pre-AI gate classified this change as "${gate.category}".`,
    recommended_response: 'No action needed.',
    talking_points: [],
    headline: `${competitor.name}: trivial change skipped`,
    summary: `Change detected but classified by the pre-AI gate as "${gate.category}": ${gate.reason}. No brief generated.`,
    key_changes: [{ category: 'other', description: gate.reason, impact: 'None. Gated as trivial.' }],
    opportunity: '',
  };
}

module.exports = {
  startScheduler, checkCompetitor, runScheduledChecks, fetchErrorToStatus, buildTrivialAnalysis,
  runTrialSweep, archiveOverFreeLimit,
};
