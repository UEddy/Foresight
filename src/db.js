const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { removePhase9DemoData } = require('./db/migrations/remove-phase9-demo-data');
const { removeDemoUser } = require('./db/migrations/remove-demo-user');

let db;       // DatabaseWrapper
let sqlDb;    // raw sql.js Database
let dbPath;

// ─── sql.js compatibility adapter ─────────────────────────────────────────────
// Wraps sql.js to provide a better-sqlite3-style synchronous API.

// When true, saveDb() is a no-op. Set during a transaction/savepoint because
// sql.js's export() (used by saveDb) drops any open SAVEPOINT and can disturb an
// open transaction — so we suppress intermediate saves and persist exactly once
// at the outermost boundary.
let suppressSave = false;
let savepointCounter = 0;

function saveDb() {
  if (suppressSave) return;
  if (!sqlDb || !dbPath) return;
  const data = sqlDb.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

class Statement {
  constructor(sql) {
    this._sql = sql;
  }

  run(...args) {
    sqlDb.run(this._sql, args.length ? args : undefined);
    const rowid = sqlDb.exec('SELECT last_insert_rowid()');
    const lastInsertRowid = Number(rowid[0]?.values[0][0] ?? 0);
    saveDb();
    return { lastInsertRowid };
  }

  get(...args) {
    const stmt = sqlDb.prepare(this._sql);
    try {
      if (args.length) stmt.bind(args);
      if (!stmt.step()) return undefined;
      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  all(...args) {
    const stmt = sqlDb.prepare(this._sql);
    const rows = [];
    try {
      if (args.length) stmt.bind(args);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }
}

class DatabaseWrapper {
  exec(sql) {
    sqlDb.exec(sql);
    saveDb();
    return this;
  }

  prepare(sql) {
    return new Statement(sql);
  }

  // Run fn() inside a SAVEPOINT — atomic and nestable (safe whether or not a
  // transaction is already open). Intermediate saveDb() calls are suppressed (a
  // mid-savepoint export() would drop the savepoint); the DB is persisted once
  // when the outermost savepoint/transaction completes.
  savepoint(fn) {
    const name = 'sp_' + (++savepointCounter);
    const prevSuppress = suppressSave;
    suppressSave = true;
    sqlDb.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      sqlDb.exec(`RELEASE ${name}`);
      return result;
    } catch (e) {
      sqlDb.exec(`ROLLBACK TO ${name}`);
      sqlDb.exec(`RELEASE ${name}`);
      throw e;
    } finally {
      suppressSave = prevSuppress;
      if (!suppressSave) saveDb(); // persist once, at the outermost level
    }
  }
}

// Internal: let the migration suppress intermediate saves around its own raw
// BEGIN/COMMIT (same rationale as savepoint()). Exposed only within this module.
function setSuppressSave(v) { suppressSave = v; }

// ─── Schema & seeding ──────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    -- Friendly display name captured at signup ("What should we call you?").
    -- Required at the application layer for new signups (1-50 chars, no XSS
    -- vectors); nullable here so the additive migration on an existing DB can
    -- backfill it on next login. Drives the time-aware dashboard greeting.
    first_name TEXT,
    -- IANA timezone captured from the browser at signup
    -- (Intl.DateTimeFormat().resolvedOptions().timeZone). Used to band the
    -- dashboard greeting (morning/afternoon/evening/night) in the user's local
    -- time. Existing users without one fall back to 'UTC'; editable in settings.
    timezone TEXT DEFAULT 'UTC',
    -- First-visit flag: 0 until the user opens the dashboard for the first time,
    -- which switches the greeting from a "welcome" variant to "welcome back".
    has_visited_dashboard INTEGER DEFAULT 0,
    -- DEPRECATED (Phase 10): tier is now workspace-driven. The source of truth
    -- for all gating is workspaces.subscription_tier (see src/lib/tierLimits.js).
    -- Retained for backward-compatible reads only; no Phase 10+ code path writes
    -- it. Scheduled for removal in a post-launch cleanup (Phase 13).
    tier TEXT DEFAULT 'free' CHECK(tier IN ('free', 'pro', 'team')),
    api_key TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    email_verified INTEGER DEFAULT 0,
    last_login DATETIME,
    session_version INTEGER DEFAULT 1,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    -- GDPR-style opt-in consent audit trail. consent_given_at is the timestamp the
    -- user affirmatively accepted the Terms of Use, Privacy Policy, and Cookie
    -- Policy at signup (captured on the email-entry step, enforced server-side in
    -- routes/auth.register/request). consent_policy_versions is a JSON identifier of
    -- which policy set/version was accepted, so the record is defensible if audited.
    -- NULL for accounts created before this column (pre-consent-feature).
    consent_given_at DATETIME,
    consent_policy_versions TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('register','reset')),
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    verified_token TEXT,
    -- Wrong-guess counter for the per-email verification lockout. The code is
    -- burned (used=1) once this reaches the cap; see routes/auth.verifyOtp.
    failed_attempts INTEGER DEFAULT 0,
    -- Consent audit on the signup ATTEMPT (register OTPs only). Recorded when the
    -- user opts in on the email-entry step; copied onto the users row when the
    -- account is created. consent_at is the moment of opt-in; consent_policy_versions
    -- is the JSON policy-set/version identifier. See routes/auth.register/request.
    consent_given INTEGER DEFAULT 0,
    consent_at DATETIME,
    consent_policy_versions TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Grouped-competitor model: a competitor (company) is a NAME that groups one
  -- or more monitored pages. Each monitored page is a row in the competitors
  -- table below (that table is the per-PAGE unit: it carries the URL, selector,
  -- render mode, and baseline hash, and is scraped/briefed individually). A
  -- group is purely organizational: pages, not groups, count toward the plan
  -- limit (see src/lib/tierLimits.js). One group has at most
  -- MAX_PAGES_PER_COMPETITOR pages.
  CREATE TABLE IF NOT EXISTS competitor_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    workspace_id INTEGER,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  );
  CREATE INDEX IF NOT EXISTS idx_competitor_groups_user ON competitor_groups(user_id);

  CREATE TABLE IF NOT EXISTS competitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    -- group_id links this page to its competitor (company). page_label is an
    -- optional per-page label ("Pricing", "Changelog"). name mirrors the group's
    -- company name so every existing consumer that reads competitors.name keeps
    -- showing the company, unchanged, after grouping.
    group_id INTEGER,
    page_label TEXT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    css_selector TEXT,
    render_mode TEXT NOT NULL DEFAULT 'fetch',
    active INTEGER DEFAULT 1,
    last_checked DATETIME,
    last_content_hash TEXT,
    last_check_status TEXT,
    last_check_error TEXT,
    last_check_at DATETIME,
    check_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (group_id) REFERENCES competitor_groups(id)
  );
  -- NOTE: the index on competitors(group_id) is intentionally NOT defined here.
  -- On an existing database this CREATE TABLE is a no-op (the table predates the
  -- grouped-page model and lacks group_id), so indexing group_id at schema time
  -- would throw "no such column: group_id". The index is created in initDb's
  -- migration block AFTER the ALTER that adds the column. See idx_competitors_group.

  CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competitor_id INTEGER NOT NULL,
    content_before TEXT,
    content_after TEXT,
    diff_summary TEXT,
    analysis TEXT,
    threat_level TEXT CHECK(threat_level IN ('low', 'medium', 'high')),
    recommended_response TEXT,
    talking_points TEXT,
    headline TEXT,
    analysis_status TEXT DEFAULT 'ok',
    analysis_error TEXT,
    is_meaningful INTEGER DEFAULT 1,
    gate_category TEXT,
    gate_reason TEXT,
    ai_input_tokens INTEGER,
    ai_output_tokens INTEGER,
    pattern_tags TEXT,
    historical_context TEXT,
    -- 1 = this row is the monitoring BASELINE for the page (the first snapshot
    -- taken when the page was added), not a detected change. Baseline rows exist
    -- so change detection has something to diff against, and so the dashboard is
    -- not blank on day one. They never alert, never email, and are excluded from
    -- every change counter. threat_level is NULL on a baseline row.
    is_baseline INTEGER DEFAULT 0,
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (competitor_id) REFERENCES competitors(id)
  );

  CREATE INDEX IF NOT EXISTS idx_changes_competitor_detected
    ON changes(competitor_id, detected_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    slack_webhook TEXT,
    discord_webhook TEXT,
    notification_email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Phase 6: per-user business context fed into every AI analysis prompt so
  -- battle cards reflect the user's ICP, positioning, and deal size instead of
  -- generic outside-observer analysis. All fields nullable — context is
  -- entirely optional and the AI degrades gracefully without it.
  CREATE TABLE IF NOT EXISTS user_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    company_name TEXT,
    what_we_sell TEXT,
    target_icp TEXT,
    our_positioning TEXT,
    typical_deal_size TEXT CHECK(typical_deal_size IN ('small','mid','large','enterprise') OR typical_deal_size IS NULL),
    sales_motion TEXT CHECK(sales_motion IN ('plg','slg','hybrid') OR sales_motion IS NULL),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Phase 7: calendar OAuth connections. Tokens are AES-256-GCM encrypted by
  -- src/calendarTokens.js before storage. UNIQUE(user_id, provider) means
  -- re-connecting the same provider updates in-place rather than orphaning rows.
  CREATE TABLE IF NOT EXISTS calendar_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
    account_email TEXT,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT,
    expires_at DATETIME,
    scope TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked')),
    last_synced_at DATETIME,
    last_sync_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, provider)
  );

  -- Phase 7: per-meeting state cached from the calendar provider, plus the
  -- match against tracked competitors and the briefing dispatch state.
  -- UNIQUE(user_id, provider, external_event_id) makes sync idempotent.
  CREATE TABLE IF NOT EXISTS tracked_meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    connection_id INTEGER,
    provider TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    title TEXT,
    start_time DATETIME NOT NULL,
    end_time DATETIME,
    attendees TEXT,
    matched_competitor_id INTEGER,
    match_reason TEXT CHECK(match_reason IN ('title','domain','manual','none') OR match_reason IS NULL),
    briefing_status TEXT DEFAULT 'pending' CHECK(briefing_status IN ('pending','sent','skipped','failed')),
    briefing_sent_at DATETIME,
    briefing_error TEXT,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (matched_competitor_id) REFERENCES competitors(id),
    UNIQUE(user_id, provider, external_event_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tracked_meetings_dispatch
    ON tracked_meetings(briefing_status, start_time);
  CREATE INDEX IF NOT EXISTS idx_tracked_meetings_user_start
    ON tracked_meetings(user_id, start_time);
  CREATE INDEX IF NOT EXISTS idx_tracked_meetings_competitor
    ON tracked_meetings(matched_competitor_id, start_time);

  -- Phase 8: per-user voice calibration profile. One row per user. All fields
  -- nullable; the playbook generator falls back to sensible defaults when a
  -- row is missing or partially filled. voice_sample and avoid_phrases are
  -- free-text user input — the playbook module sanitizes them before feeding
  -- to the AI prompt to defuse prompt-injection.
  CREATE TABLE IF NOT EXISTS user_voice_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    formality TEXT CHECK(formality IN ('casual','balanced','formal') OR formality IS NULL),
    contraction_style TEXT CHECK(contraction_style IN ('always','sometimes','never') OR contraction_style IS NULL),
    opener_style TEXT CHECK(opener_style IN ('direct','warm','context-first') OR opener_style IS NULL),
    sentence_rhythm TEXT CHECK(sentence_rhythm IN ('short_punchy','mixed','measured') OR sentence_rhythm IS NULL),
    sign_off_examples TEXT,
    voice_sample TEXT,
    avoid_phrases TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Phase 8: ready-to-send outreach messages generated per meaningful change,
  -- tied to the user who owns the underlying change. Lookup is keyed by
  -- (change_id, user_id) so the battle-card render fetches all variants in
  -- one indexed read.
  CREATE TABLE IF NOT EXISTS generated_playbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    message_type TEXT NOT NULL CHECK(message_type IN ('email_to_prospect','slack_to_team','followup_email')),
    subject_line TEXT,
    body TEXT NOT NULL,
    ai_input_tokens INTEGER,
    ai_output_tokens INTEGER,
    estimated_cost_usd REAL,
    generation_status TEXT DEFAULT 'ok',
    generation_error TEXT,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    regenerated_count INTEGER DEFAULT 0,
    FOREIGN KEY (change_id) REFERENCES changes(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_playbooks_change_user
    ON generated_playbooks(change_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_playbooks_user_recent
    ON generated_playbooks(user_id, generated_at DESC);

  -- Phase 9: logged deal outcomes (the raw signal the ROI dashboard correlates
  -- against competitor activity). competitor_id is nullable: it's required for
  -- 'lost'/'stalled' (validated in the route + Slack handler, not by the DB,
  -- so legacy/edge rows never break inserts) and irrelevant for 'won'.
  -- deal_value_usd is sensitive financial data: masked in logs, only ever
  -- returned to the owning user. close_date defaults to today, editable.
  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    deal_name TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('won','lost','stalled')),
    competitor_id INTEGER,
    deal_value_usd INTEGER,
    close_date DATE NOT NULL DEFAULT (date('now')),
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual_form' CHECK(source IN ('manual_form','slack_command','api')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (competitor_id) REFERENCES competitors(id)
  );

  CREATE INDEX IF NOT EXISTS idx_deals_user_outcome_date ON deals(user_id, outcome, close_date);
  CREATE INDEX IF NOT EXISTS idx_deals_user_competitor   ON deals(user_id, competitor_id);

  -- Phase 9: computed correlation patterns, regenerated nightly (or on-demand
  -- when the ROI dashboard is opened and the cache is stale). Pure data
  -- analysis, no AI. supporting_deal_ids / supporting_change_ids are JSON
  -- arrays. estimated_impact_usd is the summed value of supporting deals that
  -- recorded a value (nullable when none did).
  CREATE TABLE IF NOT EXISTS correlations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    competitor_id INTEGER,
    pattern_type TEXT NOT NULL,
    pattern_description TEXT NOT NULL,
    confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
    supporting_deal_ids TEXT,
    supporting_change_ids TEXT,
    estimated_impact_usd INTEGER,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (competitor_id) REFERENCES competitors(id)
  );

  CREATE INDEX IF NOT EXISTS idx_correlations_user_conf ON correlations(user_id, confidence DESC);

  -- Phase 9: forward-looking "alert me when this competitor repeats this kind
  -- of move" subscriptions, created from a pattern card on the ROI dashboard.
  -- The scheduler fires a webhook when a future meaningful change for the
  -- competitor matches the subscribed pattern_type.
  CREATE TABLE IF NOT EXISTS pattern_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    competitor_id INTEGER NOT NULL,
    pattern_type TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (competitor_id) REFERENCES competitors(id),
    UNIQUE(user_id, competitor_id, pattern_type)
  );

  -- Phase 9: Slack workspace installs from the "Add to Slack" OAuth flow. One
  -- row per (user, team). bot_token_enc is AES-256-GCM encrypted at rest by
  -- src/calendarTokens.js (the same generic token vault used for calendar
  -- tokens). slack_user_id is the installing Slack user, used to resolve an
  -- incoming slash command back to this Nivaria account.
  CREATE TABLE IF NOT EXISTS slack_installations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    slack_team_id TEXT NOT NULL,
    slack_team_name TEXT,
    slack_user_id TEXT NOT NULL,
    bot_token_enc TEXT,
    bot_user_id TEXT,
    scope TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
    installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(slack_team_id, slack_user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_slack_install_lookup ON slack_installations(slack_team_id, slack_user_id);
  CREATE INDEX IF NOT EXISTS idx_slack_install_user   ON slack_installations(user_id);

  -- ── Phase 10: workspace-based billing model ─────────────────────────────────
  -- A workspace is the unit that owns data and carries a subscription. For
  -- Phase 10 every user owns exactly one personal workspace (user_id ↔
  -- workspace_id is 1:1). Phase 10.5 turns this into real multi-member teams;
  -- this schema is forward-compatible so that work is purely additive.
  -- subscription_* fields are driven SOLELY by Lemon Squeezy webhooks — the
  -- app never writes tier/status directly except via the verified webhook.
  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL,
    subscription_id TEXT,
    subscription_status TEXT CHECK(subscription_status IN ('active','past_due','cancelled','expired','paused') OR subscription_status IS NULL),
    subscription_tier TEXT NOT NULL DEFAULT 'free' CHECK(subscription_tier IN ('free','pro','team','business')),
    subscription_current_period_end DATETIME,
    subscription_cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    -- Pre-launch manual Pro grant bookkeeping (admin /admin/set-tier). Records
    -- WHEN an admin manually granted the current tier, so that once a real
    -- payment processor is live we can see who was comped and when, to manage
    -- their transition to paid. NULL for tiers set by a real subscription or
    -- never granted. This is bookkeeping only: the authoritative tier remains
    -- subscription_tier, which a future payment webhook overwrites directly.
    tier_granted_at DATETIME,
    lemon_squeezy_customer_id TEXT,
    lemon_squeezy_subscription_variant_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_subscription ON workspaces(subscription_id);

  -- Membership join table. Phase 10: exactly one role='owner' row per workspace.
  -- Phase 10.5 adds 'admin'/'member' rows via the invite flow.
  CREATE TABLE IF NOT EXISTS workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','admin','member')),
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    invited_by_user_id INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id),
    UNIQUE(workspace_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_members_ws   ON workspace_members(workspace_id);

  -- Waitlist captures for the not-yet-active Team and Business tiers, plus
  -- manual-access requests for the 14-day Pro trial (tier='trial'), which reuses
  -- this table until a payment processor and automated trial are live.
  -- notified_at is reserved for a future "your tier is now live" mailout (NULL
  -- until that email is sent). A user may request multiple tiers but not the same
  -- tier twice, enforced by UNIQUE(email, tier).
  CREATE TABLE IF NOT EXISTS waitlist_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    tier TEXT NOT NULL CHECK(tier IN ('team','business','trial')),
    team_size_estimate INTEGER,
    use_case TEXT,
    signed_up_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notified_at DATETIME,
    UNIQUE(email, tier)
  );
  CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist_signups(email);

  -- Webhook audit + idempotency. lemon_squeezy_event_id UNIQUE is the DB-level
  -- guarantee a replayed webhook can never be processed twice. Rows are RETAINED
  -- (anonymized: workspace_id set NULL) even after account deletion, for
  -- accounting/tax record-keeping.
  CREATE TABLE IF NOT EXISTS payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER,
    lemon_squeezy_event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','processed','failed','duplicate')),
    error TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  );
  CREATE INDEX IF NOT EXISTS idx_payment_events_ws ON payment_events(workspace_id);

  -- Security-relevant event log. Append-only BY CONVENTION (the app never issues
  -- UPDATE/DELETE against this table). IPs are stored as a SHA-256 hash, never
  -- raw, for GDPR data-minimization; user agents truncated to 100 chars.
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER,
    user_id INTEGER,
    event_type TEXT NOT NULL,
    event_data TEXT,
    ip_hash TEXT,
    user_agent_short TEXT,
    occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_ws_time   ON audit_log(workspace_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_log_user_time ON audit_log(user_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_log_type      ON audit_log(event_type, occurred_at DESC);

  -- ── Outbound (admin-only lead-generation feature) ────────────────────────────
  -- A single discovery/scoring/drafting run and the leads it produced. Phase 1 is
  -- admin-gated (see src/outbound/access.js); the tables are user-scoped via
  -- created_by so opening the feature to all users later needs no schema change.
  -- Runs are processed in a background task; the UI polls the run row for status.
  CREATE TABLE IF NOT EXISTS outbound_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_by INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | error
    params TEXT,                              -- JSON: { brief, targetCount, regionHints, segment }
    error_message TEXT,
    total_found INTEGER DEFAULT 0,
    total_kept INTEGER DEFAULT 0,
    funnel TEXT,                              -- JSON: per-stage rejection counters (see src/outbound/funnel.js)
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_outbound_runs_creator ON outbound_runs(created_by, created_at DESC);

  -- One ranked lead. "trigger" is a SQLite keyword, so it is always double-quoted
  -- in queries (see src/outbound/store.js). contact_status is never 'verified' in
  -- Phase 1 (no email finder): every lead is 'manual' with a profile URL. No
  -- contact is ever fabricated.
  CREATE TABLE IF NOT EXISTS outbound_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    company TEXT,
    domain TEXT,
    category TEXT,
    stage_size TEXT,
    region TEXT,
    "trigger" TEXT,
    trigger_url TEXT,
    trigger_at DATETIME,                      -- when the trigger happened; drives freshness-first ranking
    score INTEGER DEFAULT 0,
    score_breakdown TEXT,                     -- JSON: { fit, pain, reachability, timing }
    why_now TEXT,
    person_name TEXT,
    person_title TEXT,
    person_seniority TEXT,
    channel TEXT,                             -- linkedin | x | email
    handle_or_email TEXT,
    contact_status TEXT DEFAULT 'manual',     -- verified | unverified | guessed | manual
    backup_channel TEXT,
    linkedin_status TEXT,                     -- found | unavailable; 'unavailable' means LinkedIn was searched and verified nobody, so the lead fell back to a verified X profile
    source TEXT,                              -- discovery source: serper | defillama | cryptorank (comma-joined when more than one found it)
    draft TEXT,
    confidence TEXT,                          -- high | medium | low
    status TEXT NOT NULL DEFAULT 'new',       -- new | contacted | replied | skipped
    notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES outbound_runs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_outbound_leads_run    ON outbound_leads(run_id, score DESC);
  CREATE INDEX IF NOT EXISTS idx_outbound_leads_status ON outbound_leads(status, created_at DESC);
`;

async function initDb() {
  // DATABASE_PATH lets the deploy target point the SQLite file at a mounted
  // volume; it falls back to the in-repo ./data dir for local dev. On Railway's
  // ephemeral filesystem (no volume on the Trial plan) this still works — the DB
  // simply resets on container restart, which is acceptable for the Phase 12A
  // test deploy.
  dbPath = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(__dirname, '../data', 'competitor-shadow.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(buf);
  } else {
    sqlDb = new SQL.Database();
  }

  db = new DatabaseWrapper();

  sqlDb.exec(SCHEMA);

  // Migrate existing users table if columns are missing
  const userCols = (sqlDb.exec('PRAGMA table_info(users)')[0]?.values || []).map(v => v[1]);
  if (!userCols.includes('password_hash'))   sqlDb.run('ALTER TABLE users ADD COLUMN password_hash TEXT');
  if (!userCols.includes('email_verified'))  sqlDb.run('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0');
  if (!userCols.includes('last_login'))      sqlDb.run('ALTER TABLE users ADD COLUMN last_login DATETIME');
  if (!userCols.includes('session_version')) sqlDb.run('ALTER TABLE users ADD COLUMN session_version INTEGER DEFAULT 1');
  // Phase 12: emergency per-user override granting unlimited Pro feature access
  // regardless of subscription state (see src/lib/tierLimits.js). Admin-set only.
  if (!userCols.includes('is_developer'))    sqlDb.run('ALTER TABLE users ADD COLUMN is_developer INTEGER DEFAULT 0');
  // Friendly name + timezone + first-visit flag (signup personalization). Added
  // nullable/defaulted so existing rows migrate cleanly; first_name is enforced
  // NOT NULL at the application layer for new signups only.
  if (!userCols.includes('first_name'))            sqlDb.run('ALTER TABLE users ADD COLUMN first_name TEXT');
  if (!userCols.includes('timezone'))              sqlDb.run("ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'UTC'");
  if (!userCols.includes('has_visited_dashboard')) sqlDb.run('ALTER TABLE users ADD COLUMN has_visited_dashboard INTEGER DEFAULT 0');
  // GDPR-style signup consent audit trail (additive; existing DBs created the users
  // table before these columns existed). consent_given_at + consent_policy_versions
  // persist the timestamp and policy set/version a user accepted at signup, so the
  // record can be produced for a compliance audit. Enforced in routes/auth.
  if (!userCols.includes('consent_given_at'))        sqlDb.run('ALTER TABLE users ADD COLUMN consent_given_at DATETIME');
  if (!userCols.includes('consent_policy_versions')) sqlDb.run('ALTER TABLE users ADD COLUMN consent_policy_versions TEXT');
  // "Sign in with Google": the Google account's stable subject id ("sub" claim),
  // recorded to link a Nivaria account to a Google identity. Nullable (email/
  // password accounts never have one); set the first time a user authenticates
  // with Google, either on a brand-new signup or when linking Google to an
  // existing account matched by verified email. UNIQUE so one Google identity
  // maps to at most one account.
  if (!userCols.includes('google_id')) {
    sqlDb.run('ALTER TABLE users ADD COLUMN google_id TEXT');
    sqlDb.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL');
  }

  // Security: per-email OTP verification lockout counter (additive; existing DBs
  // created the otp_codes table before this column existed).
  const otpCols = (sqlDb.exec('PRAGMA table_info(otp_codes)')[0]?.values || []).map(v => v[1]);
  if (otpCols.length && !otpCols.includes('failed_attempts')) {
    sqlDb.run('ALTER TABLE otp_codes ADD COLUMN failed_attempts INTEGER DEFAULT 0');
  }
  // Consent audit on the signup attempt (additive; mirrors the users columns above).
  // Recorded on the register OTP row at opt-in, then copied onto the account.
  if (otpCols.length && !otpCols.includes('consent_given'))           sqlDb.run('ALTER TABLE otp_codes ADD COLUMN consent_given INTEGER DEFAULT 0');
  if (otpCols.length && !otpCols.includes('consent_at'))              sqlDb.run('ALTER TABLE otp_codes ADD COLUMN consent_at DATETIME');
  if (otpCols.length && !otpCols.includes('consent_policy_versions')) sqlDb.run('ALTER TABLE otp_codes ADD COLUMN consent_policy_versions TEXT');

  // Migrate competitors table for P0 check-status tracking
  const compCols = (sqlDb.exec('PRAGMA table_info(competitors)')[0]?.values || []).map(v => v[1]);
  if (!compCols.includes('last_check_status')) sqlDb.run('ALTER TABLE competitors ADD COLUMN last_check_status TEXT');
  if (!compCols.includes('last_check_error'))  sqlDb.run('ALTER TABLE competitors ADD COLUMN last_check_error TEXT');
  if (!compCols.includes('last_check_at'))     sqlDb.run('ALTER TABLE competitors ADD COLUMN last_check_at DATETIME');
  // Phase 2: per-competitor CSS selector override for noise reduction
  if (!compCols.includes('css_selector'))      sqlDb.run('ALTER TABLE competitors ADD COLUMN css_selector TEXT');
  // Phase 3: per-competitor render mode — 'fetch' (axios+cheerio) or 'js' (Playwright)
  if (!compCols.includes('render_mode'))       sqlDb.run("ALTER TABLE competitors ADD COLUMN render_mode TEXT NOT NULL DEFAULT 'fetch'");

  // Migrate changes table to support analyzer-failure backfill
  const changeCols = (sqlDb.exec('PRAGMA table_info(changes)')[0]?.values || []).map(v => v[1]);
  if (!changeCols.includes('analysis_status')) sqlDb.run("ALTER TABLE changes ADD COLUMN analysis_status TEXT DEFAULT 'ok'");
  if (!changeCols.includes('analysis_error'))  sqlDb.run('ALTER TABLE changes ADD COLUMN analysis_error TEXT');
  // Phase 4: meaningful-change gate + AI token tracking
  if (!changeCols.includes('is_meaningful'))    sqlDb.run('ALTER TABLE changes ADD COLUMN is_meaningful INTEGER DEFAULT 1');
  if (!changeCols.includes('gate_category'))    sqlDb.run('ALTER TABLE changes ADD COLUMN gate_category TEXT');
  if (!changeCols.includes('gate_reason'))      sqlDb.run('ALTER TABLE changes ADD COLUMN gate_reason TEXT');
  if (!changeCols.includes('ai_input_tokens'))  sqlDb.run('ALTER TABLE changes ADD COLUMN ai_input_tokens INTEGER');
  if (!changeCols.includes('ai_output_tokens')) sqlDb.run('ALTER TABLE changes ADD COLUMN ai_output_tokens INTEGER');
  // Phase 5: historical pattern analysis — tag each change for cross-time grouping,
  // and persist the AI's narrative on how the change fits the competitor's trajectory.
  if (!changeCols.includes('pattern_tags'))       sqlDb.run('ALTER TABLE changes ADD COLUMN pattern_tags TEXT');
  if (!changeCols.includes('historical_context')) sqlDb.run('ALTER TABLE changes ADD COLUMN historical_context TEXT');

  // Silent-baseline model: mark the first snapshot of a newly monitored page so
  // it is never counted or alerted as a change. Existing rows default to 0 and
  // keep their current meaning, so already-monitored pages keep their history
  // exactly as it is. Older first-snapshot briefs are deliberately NOT
  // backfilled: relabelling live history would disrupt those accounts.
  if (!changeCols.includes('is_baseline')) sqlDb.run('ALTER TABLE changes ADD COLUMN is_baseline INTEGER DEFAULT 0');

  // Phase 6: audit flag — did the AI have user business context to work from?
  // Lets us measure context coverage and surface "Analyzed for: …" in the UI.
  if (!changeCols.includes('context_used')) sqlDb.run('ALTER TABLE changes ADD COLUMN context_used INTEGER DEFAULT 0');

  // Phase 7: bare domain ("acme.com") on each competitor for attendee-email
  // matching. Backfilled from URL below for any rows that pre-date this column.
  if (!compCols.includes('domain')) {
    sqlDb.run('ALTER TABLE competitors ADD COLUMN domain TEXT');
    try {
      const rows = (sqlDb.exec('SELECT id, url FROM competitors')[0]?.values || []);
      for (const [id, url] of rows) {
        const domain = extractDomainFromUrl(url);
        if (domain) sqlDb.run('UPDATE competitors SET domain = ? WHERE id = ?', [domain, id]);
      }
    } catch (e) {
      console.warn('Phase 7 domain backfill failed (non-fatal):', e.message);
    }
  }

  // Grouped-competitor model: add the new columns here (nullable, so the ALTER
  // is safe on an existing DB), THEN create the group_id index. This ordering is
  // load-bearing: on an existing prod DB the competitors table predates the
  // grouped-page model, so the column must be added by ALTER before anything
  // indexes or queries it (the index was previously in SCHEMA, which runs before
  // this migration and crashed with "no such column: group_id"). Wrapped so a
  // migration hiccup degrades gracefully instead of taking the whole app down.
  // The DATA backfill that places each existing flat competitor into its own
  // one-page group runs at the END of initDb via backfillCompetitorGroups(),
  // after the Phase 10 workspace migration has populated workspace_id and after
  // any dev seeding. Loss-free and idempotent (only touches group_id IS NULL).
  try {
    if (!compCols.includes('group_id'))   sqlDb.run('ALTER TABLE competitors ADD COLUMN group_id INTEGER');
    if (!compCols.includes('page_label')) sqlDb.run('ALTER TABLE competitors ADD COLUMN page_label TEXT');
    // Idempotent (IF NOT EXISTS) and safe now that group_id is guaranteed to exist.
    sqlDb.run('CREATE INDEX IF NOT EXISTS idx_competitors_group ON competitors(group_id)');
  } catch (e) {
    console.warn('Grouped-competitor column migration issue (non-fatal):', e.message);
  }

  // Phase 7: per-user briefing preferences. Lives on the existing settings
  // table to avoid duplicating webhook config — slack_webhook/discord_webhook
  // already exist here and are reused as the briefing delivery channel.
  const settingsCols = (sqlDb.exec('PRAGMA table_info(settings)')[0]?.values || []).map(v => v[1]);
  if (!settingsCols.includes('briefings_enabled'))     sqlDb.run('ALTER TABLE settings ADD COLUMN briefings_enabled INTEGER DEFAULT 1');
  if (!settingsCols.includes('briefing_lead_minutes')) sqlDb.run('ALTER TABLE settings ADD COLUMN briefing_lead_minutes INTEGER DEFAULT 30');

  // Brief-notification email preference. Controls whether a generated brief is
  // emailed to the user's notification address (or account email fallback) when
  // a meaningful competitor change is detected. Defaults ON so the feature is
  // live for existing rows without an explicit opt-in.
  if (!settingsCols.includes('brief_email_enabled'))   sqlDb.run('ALTER TABLE settings ADD COLUMN brief_email_enabled INTEGER DEFAULT 1');

  // Phase 12: waitlist notification tracking (additive; existing DBs created the
  // table before this column existed). Index speeds up admin/dup-check lookups.
  const waitlistCols = (sqlDb.exec('PRAGMA table_info(waitlist_signups)')[0]?.values || []).map(v => v[1]);
  if (waitlistCols.length && !waitlistCols.includes('notified_at')) {
    sqlDb.run('ALTER TABLE waitlist_signups ADD COLUMN notified_at DATETIME');
  }
  // Widen the tier CHECK constraint to allow 'trial' (14-day Pro trial requests).
  // SQLite cannot ALTER a CHECK constraint, so rebuild the table when an existing
  // DB still has the old ('team','business')-only definition. Rows are preserved.
  const waitlistDdl = (sqlDb.exec(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='waitlist_signups'"
  )[0]?.values?.[0]?.[0]) || '';
  if (waitlistDdl && !waitlistDdl.includes("'trial'")) {
    sqlDb.run(`
      BEGIN TRANSACTION;
      CREATE TABLE waitlist_signups__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        tier TEXT NOT NULL CHECK(tier IN ('team','business','trial')),
        team_size_estimate INTEGER,
        use_case TEXT,
        signed_up_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        notified_at DATETIME,
        UNIQUE(email, tier)
      );
      INSERT INTO waitlist_signups__new (id, email, tier, team_size_estimate, use_case, signed_up_at, notified_at)
        SELECT id, email, tier, team_size_estimate, use_case, signed_up_at, notified_at FROM waitlist_signups;
      DROP TABLE waitlist_signups;
      ALTER TABLE waitlist_signups__new RENAME TO waitlist_signups;
      COMMIT;
    `);
  }
  sqlDb.run('CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist_signups(email)');

  // Pre-launch: manual Pro grant timestamp on workspaces (additive; existing DBs
  // created the workspaces table before this column existed). The workspaces
  // table may not exist yet on a brand-new DB (it is created by the Phase 10
  // migration below), so guard on the table being present.
  const wsCols = (sqlDb.exec('PRAGMA table_info(workspaces)')[0]?.values || []).map(v => v[1]);
  if (wsCols.length && !wsCols.includes('tier_granted_at')) {
    sqlDb.run('ALTER TABLE workspaces ADD COLUMN tier_granted_at DATETIME');
  }

  // Phase 5: speed up per-competitor reverse-chronological lookups used by
  // historicalContext.getCompetitorHistory and the new timeline endpoints.
  sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_changes_competitor_detected ON changes(competitor_id, detected_at DESC);');

  // Outbound leads: trigger recency for freshness-first ranking (additive; existing
  // DBs created the table before this column existed). Nullable, so leads whose
  // trigger could not be dated sort below dated-fresh leads (see store.js
  // freshnessRank). The table may not exist on a brand-new DB until SCHEMA runs
  // above, so guard on it being present.
  const outboundLeadCols = (sqlDb.exec('PRAGMA table_info(outbound_leads)')[0]?.values || []).map(v => v[1]);
  if (outboundLeadCols.length && !outboundLeadCols.includes('trigger_at')) {
    sqlDb.run('ALTER TABLE outbound_leads ADD COLUMN trigger_at DATETIME');
  }

  // Outbound leads: honesty and provenance markers for the web3 discovery
  // segment (additive, nullable). linkedin_status is 'unavailable' when the
  // people finder searched LinkedIn, verified nobody, and fell back to a
  // verified X profile, so a crypto founder without a LinkedIn is recorded as
  // such instead of getting a fabricated one. source names the discovery source
  // that produced the lead. Both are NULL on leads that predate the columns.
  if (outboundLeadCols.length && !outboundLeadCols.includes('linkedin_status')) {
    sqlDb.run('ALTER TABLE outbound_leads ADD COLUMN linkedin_status TEXT');
  }
  if (outboundLeadCols.length && !outboundLeadCols.includes('source')) {
    sqlDb.run('ALTER TABLE outbound_leads ADD COLUMN source TEXT');
  }

  // Outbound runs: per-stage funnel counters (additive; existing DBs created the
  // table before this column existed). Nullable JSON text; null on older runs
  // that predate funnel tracking. Guard on the table being present.
  const outboundRunCols = (sqlDb.exec('PRAGMA table_info(outbound_runs)')[0]?.values || []).map(v => v[1]);
  if (outboundRunCols.length && !outboundRunCols.includes('funnel')) {
    sqlDb.run('ALTER TABLE outbound_runs ADD COLUMN funnel TEXT');
  }

  // 14-day Pro trial (see src/config.js TRIAL_DAYS). trial_ends_at is set at
  // workspace creation for NEW signups; NULL on pre-trial workspaces means "no
  // trial" (existing users keep their current tier, nothing changes for them).
  // trial_notices is a JSON array of reminder markers already sent ("day10",
  // "day13", "expiry") so the daily sweep never double-sends.
  const wsTrialCols = (sqlDb.exec('PRAGMA table_info(workspaces)')[0]?.values || []).map(v => v[1]);
  if (wsTrialCols.length && !wsTrialCols.includes('trial_ends_at')) {
    sqlDb.run('ALTER TABLE workspaces ADD COLUMN trial_ends_at DATETIME');
  }
  if (wsTrialCols.length && !wsTrialCols.includes('trial_notices')) {
    sqlDb.run("ALTER TABLE workspaces ADD COLUMN trial_notices TEXT DEFAULT '[]'");
  }

  // Trial expiry keeps data: competitors above the Free limit are ARCHIVED
  // (read-only, excluded from page counts and monitoring), never deleted, and
  // restored on upgrade. 0 = live, 1 = archived.
  const compArchCols = (sqlDb.exec('PRAGMA table_info(competitors)')[0]?.values || []).map(v => v[1]);
  if (compArchCols.length && !compArchCols.includes('archived')) {
    sqlDb.run('ALTER TABLE competitors ADD COLUMN archived INTEGER DEFAULT 0');
  }

  saveDb();

  // Demo account (seeded login + sample data) is a DEV-ONLY convenience. It must
  // never be created in production: shipping a known email/password pair to a
  // public deployment is an open door. In production the DB boots empty and the
  // first real signup becomes user #1. The Phase 9 demo-deal seed below is also
  // implicitly skipped in production because it keys off this user existing.
  if (process.env.NODE_ENV !== 'production') {
    const existingUser = db.prepare('SELECT id FROM users WHERE id = 1').get();
    if (!existingUser) {
      const apiKey = 'cs-' + uuidv4().replace(/-/g, '');
      db.prepare('INSERT INTO users (email, name, tier, api_key) VALUES (?, ?, ?, ?)')
        .run('demo@nivaria.app', 'Demo User', 'pro', apiKey);
      db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(1);
      seedDemoData();
      // Never log the API key value — it persists forever in deployment logs.
      // The key lives only in the DB and is shown in the UI at creation time.
      console.log('\n✅ Demo account created.\n');
    }

    // Ensure demo user has a password for testing
    const demoUser = db.prepare('SELECT id, password_hash FROM users WHERE id = 1').get();
    if (demoUser && !demoUser.password_hash) {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync('Demo1234!', 12);
      db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = 1').run(hash);
      saveDb();
      // Don't log the password value — credentials must not appear in any log stream.
      console.log('✅ Demo credentials configured for demo@nivaria.app');
    }
  }

  // Phase 9: seed a populated win/loss dataset for the demo user so the ROI
  // dashboard renders a real, medium-confidence pattern on first run. Idempotent
  // — only seeds when the demo user has zero deals.
  try {
    const demoDeals = db.prepare('SELECT COUNT(*) AS n FROM deals WHERE user_id = 1').get().n;
    if (demoDeals === 0 && db.prepare('SELECT id FROM users WHERE id = 1').get()) {
      seedPhase9DemoData();
    }
  } catch (e) {
    console.warn('Phase 9 demo seed skipped (non-fatal):', e.message);
  }

  // Phase 10: migrate to the workspace-based model (idempotent, transactional).
  runPhase10WorkspaceMigration();
  // DEV-ONLY: promote the developer's own workspace to Pro for build/testing.
  // No-op when NODE_ENV==='production'.
  seedDevProWorkspace();

  // One-time PRODUCTION cleanup of the Phase 9 demo-data leak (see the migration
  // for the safety model). No-op in dev/test and idempotent in production — once
  // the demo rows are gone, subsequent boots match nothing and delete nothing.
  try {
    removePhase9DemoData(db);
  } catch (e) {
    console.warn('[CLEANUP] Phase 9 demo-data cleanup skipped (non-fatal):', e.message);
  }

  // One-time PRODUCTION cleanup of a leaked demo-USER account (defensive safety
  // net; see the migration for the signature/ambiguity model). No-op in dev/test
  // and idempotent in production — once the demo account is gone, or if it never
  // existed, subsequent boots match nothing and delete nothing.
  try {
    removeDemoUser(db);
  } catch (e) {
    console.warn('[CLEANUP] Demo-user cleanup skipped (non-fatal):', e.message);
  }

  // Grouped-competitor data backfill. Runs last so it sees workspace_id (set by
  // the Phase 10 migration) and any dev-seeded competitors. Each competitor row
  // still lacking a group is placed into its own one-page group named after it.
  try {
    backfillCompetitorGroups(db);
  } catch (e) {
    console.warn('Grouped-competitor backfill skipped (non-fatal):', e.message);
  }

  saveDb();
  console.log('✅ Database initialized');
  return db;
}

// Place every competitor row that has no group_id into its OWN competitor_groups
// row (named after the competitor), then link it. Loss-free and idempotent: it
// only touches rows where group_id IS NULL, so re-running never merges, deletes,
// or duplicates. This is the migration path for pre-grouping flat competitors and
// the safety net for any competitor created outside the grouped-add route.
function backfillCompetitorGroups(db) {
  const orphans = db.prepare(
    'SELECT id, user_id, workspace_id, name FROM competitors WHERE group_id IS NULL'
  ).all();
  let created = 0;
  for (const o of orphans) {
    const g = db.prepare(
      'INSERT INTO competitor_groups (user_id, workspace_id, name) VALUES (?, ?, ?)'
    ).run(o.user_id, o.workspace_id, o.name);
    db.prepare('UPDATE competitors SET group_id = ? WHERE id = ?').run(g.lastInsertRowid, o.id);
    created++;
  }
  if (created > 0) {
    console.log(`✅ Grouped-competitor migration: ${created} competitor(s) each migrated into a one-page group (no data removed)`);
  }
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEV-ONLY SEED — never runs in production (guarded by NODE_ENV).
// Gives the developer's personal workspace a Pro subscription so the full app
// is usable during the Phase 10 build without running a live Lemon Squeezy
// checkout. The demo workspace is intentionally LEFT on 'free' so both tier
// states exist for testing. Idempotent and safe: only promotes a workspace that
// is still 'free' with NO real subscription linked, so a genuine Lemon Squeezy
// subscription (set only via verified webhook) can never be clobbered by this.
// ─────────────────────────────────────────────────────────────────────────────
function seedDevProWorkspace() {
  if (process.env.NODE_ENV === 'production') return;
  const DEV_PRO_EMAIL = 'eddyhamezz@gmail.com';
  const ws = db.prepare(`
    SELECT w.id, w.subscription_tier, w.subscription_id
    FROM workspaces w JOIN users u ON u.id = w.owner_user_id
    WHERE u.email = ?`).get(DEV_PRO_EMAIL);
  if (!ws) return;
  // Don't overwrite a real Lemon Squeezy subscription or an already-seeded Pro.
  if (ws.subscription_tier !== 'free' || ws.subscription_id) return;

  const periodEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19); // ~1 year out
  db.prepare(`
    UPDATE workspaces
    SET subscription_tier = 'pro',
        subscription_status = 'active',
        subscription_current_period_end = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(periodEnd, ws.id);
  saveDb();
  console.log(`🧪 [DEV-ONLY] Seeded Pro on ${DEV_PRO_EMAIL}'s workspace #${ws.id} (period end ${periodEnd}). Never runs in production.`);
}

// ─── Phase 10: workspace migration ───────────────────────────────────────────
// Gives every existing user a personal workspace they own, records the owner
// membership, and backfills workspace_id onto every workspace-scoped data table
// from the row's existing user_id. Idempotent — safe to run on every boot.
//
// SQLite cannot add a NOT NULL column to an already-populated table without a
// full table rebuild, so workspace_id is added nullable and the NOT NULL
// invariant is upheld three ways: (1) the backfill populates every existing
// row, (2) a post-backfill integrity assertion rolls the whole migration back
// if any row is left NULL, and (3) all application-layer inserts set it
// explicitly. The create+backfill runs inside a single transaction.
function runPhase10WorkspaceMigration() {
  // The workspace-scoped data tables. NOTE: the real Slack table is
  // `slack_installations` (an earlier spec draft called it `slack_workspaces`).
  // `correlations` and `pattern_alerts` are included (checkpoint-1 decision #2):
  // adding workspace_id now — backfilled from the owning user, same pattern as
  // the rest — avoids a second migration in Phase 10.5. Every table here has a
  // `user_id` column, so the owner→workspace mapping backfills all of them.
  // `changes` is deliberately NOT here: it stays joined through
  // competitor_id → competitors.workspace_id (no denormalized column).
  const MIGRATED_TABLES = [
    'competitors', 'generated_playbooks', 'deals',
    'tracked_meetings', 'calendar_connections', 'slack_installations',
    'correlations', 'pattern_alerts',
  ];

  // Nothing to do if there are no users yet (brand-new empty DB).
  const userRows = sqlDb.exec('SELECT id, email, name FROM users')[0]?.values || [];
  if (!userRows.length) return;

  // One-time safety backup before the very first migration run on this DB file.
  const alreadyMigrated = (sqlDb.exec('SELECT COUNT(*) FROM workspaces')[0]?.values[0][0] || 0) > 0;
  if (!alreadyMigrated && dbPath && fs.existsSync(dbPath)) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${dbPath}.pre-phase10-${stamp}.bak`;
      fs.copyFileSync(dbPath, backup);
      console.log(`🛟  Pre-migration backup written: ${path.basename(backup)}`);
    } catch (e) {
      console.warn('Pre-migration backup failed (continuing):', e.message);
    }
  }

  // 1. Add nullable workspace_id columns + supporting indexes. ALTER auto-commits
  //    in SQLite, so this is done outside the transaction.
  for (const t of MIGRATED_TABLES) {
    const cols = (sqlDb.exec(`PRAGMA table_info(${t})`)[0]?.values || []).map(v => v[1]);
    if (!cols.includes('workspace_id')) {
      sqlDb.run(`ALTER TABLE ${t} ADD COLUMN workspace_id INTEGER`);
    }
  }
  // GDPR: account-deletion bookkeeping columns on users.
  const userCols = (sqlDb.exec('PRAGMA table_info(users)')[0]?.values || []).map(v => v[1]);
  if (!userCols.includes('deletion_requested_at')) sqlDb.run('ALTER TABLE users ADD COLUMN deletion_requested_at DATETIME');
  if (!userCols.includes('deletion_scheduled_at')) sqlDb.run('ALTER TABLE users ADD COLUMN deletion_scheduled_at DATETIME');
  if (!userCols.includes('deletion_cancel_token')) sqlDb.run('ALTER TABLE users ADD COLUMN deletion_cancel_token TEXT');

  // 2. Transactional: create workspaces + owner memberships, then backfill.
  // Per-user workspace bootstrap is delegated to the shared helper (also used by
  // the registration route) so the two paths can never drift. Required lazily to
  // avoid a circular require (lib/workspace.js requires this module's getDb).
  const { createPersonalWorkspace } = require('./lib/workspace');
  const wsCountBefore = Number(sqlDb.exec('SELECT COUNT(*) FROM workspaces')[0].values[0][0]);
  // Suppress intermediate saves for the whole migration transaction (export()
  // mid-transaction is unsafe); persist once after the index/trigger step below.
  setSuppressSave(true);
  sqlDb.exec('BEGIN');
  try {
    for (const [uid, email, name] of userRows) {
      createPersonalWorkspace(Number(uid), name, email); // idempotent, SAVEPOINT-atomic
    }
    const workspacesCreated = Number(sqlDb.exec('SELECT COUNT(*) FROM workspaces')[0].values[0][0]) - wsCountBefore;

    // 3. Backfill workspace_id on every workspace-scoped table from the owner.
    for (const t of MIGRATED_TABLES) {
      sqlDb.run(
        `UPDATE ${t} SET workspace_id = (SELECT id FROM workspaces WHERE owner_user_id = ${t}.user_id) WHERE workspace_id IS NULL`,
      );
    }

    // 4. Integrity assertion — abort the whole migration if any row is orphaned.
    for (const t of MIGRATED_TABLES) {
      const nulls = Number(sqlDb.exec(`SELECT COUNT(*) FROM ${t} WHERE workspace_id IS NULL`)[0].values[0][0]);
      if (nulls > 0) {
        throw new Error(`integrity check failed: ${nulls} row(s) in "${t}" still have NULL workspace_id (orphaned user_id?)`);
      }
    }

    sqlDb.exec('COMMIT');
    if (workspacesCreated) {
      console.log(`✅ Phase 10 migration: ${workspacesCreated} personal workspace(s) created; workspace_id backfilled across ${MIGRATED_TABLES.length} tables`);
    }
  } catch (e) {
    sqlDb.exec('ROLLBACK');
    console.error('❌ Phase 10 workspace migration FAILED — rolled back, no changes applied:', e.message);
    throw e;
  } finally {
    setSuppressSave(false); // re-enable saves; final saveDb() below persists once
  }

  // Add workspace_id indexes + a safety trigger per table (outside txn; cheap,
  // idempotent). The trigger auto-populates workspace_id from the owning user on
  // any INSERT that leaves it NULL — so existing Phase 1-9 insert code keeps
  // working unchanged while the "every row has a workspace" invariant holds at
  // the DB layer (the closest we can get to NOT NULL without a table rebuild).
  // In Phase 10.5, inserts that set workspace_id explicitly bypass the trigger
  // (WHEN NEW.workspace_id IS NULL), so cross-workspace writes are unaffected.
  for (const t of MIGRATED_TABLES) {
    sqlDb.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_workspace ON ${t}(workspace_id)`);
    sqlDb.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${t}_ws_backfill
      AFTER INSERT ON ${t}
      WHEN NEW.workspace_id IS NULL
      BEGIN
        UPDATE ${t} SET workspace_id = (SELECT id FROM workspaces WHERE owner_user_id = NEW.user_id)
        WHERE id = NEW.id;
      END;`);
  }

  saveDb();
}

// Phase 9 — seed a believable win/loss history for the demo user (id 1) tied to
// the already-seeded competitors (Acme=1, NovaTech=2, Horizon=3). Produces:
//   • two backdated Acme changes (a pricing change ~28d ago, a plan
//     restructure ~14d ago) so each Acme loss has a pricing move inside its
//     30-day pre-close window — the engine then surfaces a real pattern;
//   • ~10 lost deals against Acme spread across the last 27 days;
//   • a couple of stalled deals against NovaTech (which has a feature launch);
//   • several won deals (no competitor) for a realistic win rate.
function seedPhase9DemoData() {
  // Demo win/loss data is a DEV-ONLY convenience, same policy as seedDemoData().
  // It must NEVER seed in production: this function hardcodes competitor_id 1/2/3
  // for its backdated changes/deals, so in production (where the first real
  // signup is user #1 and their first competitor is id 1) it would staple
  // "Acme"/"NovaTech" demo briefs and 18 fake deals onto whatever REAL competitor
  // happens to occupy those ids. See remove-phase9-demo-data.js for the cleanup.
  if (process.env.NODE_ENV === 'production') {
    return; // Demo data is dev-only; never seed in production
  }
  const now = new Date();
  const dateOffset = (days) => {
    const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  };
  const tsOffset = (days) => {
    const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  };

  // Backdated Acme changes that create the 30-day correlation windows. These are
  // "meaningful" pricing-type changes, tagged so the engine classifies them.
  const acmePricing = JSON.stringify({
    is_meaningful: true,
    changed_what: 'Acme Corp cut Pro plan pricing and added a cheaper Starter tier',
    threat_level: 'high',
    headline: 'Acme Corp restructured pricing with an aggressive Pro discount',
    summary: 'Acme reduced Pro pricing and introduced a low-cost entry tier.',
    recommended_response: 'Brief the sales team on competitive pricing rebuttals.',
    talking_points: ['Our Pro tier includes SSO and audit logs at no extra cost'],
    key_changes: [{ category: 'pricing', description: 'Pro plan repriced', impact: 'Direct pressure on our core tier' }],
    opportunity: '',
  });
  const acmePlan = JSON.stringify({
    is_meaningful: true,
    changed_what: 'Acme Corp removed seat limits from the Pro plan',
    threat_level: 'high',
    headline: 'Acme Corp removed Pro seat caps',
    summary: 'Acme dropped the per-seat ceiling on Pro.',
    recommended_response: 'Emphasize total cost of ownership in active deals.',
    talking_points: ['Unlimited seats often hides usage-based overage costs'],
    key_changes: [{ category: 'pricing', description: 'Seat limit removed', impact: 'Removes a common objection' }],
    opportunity: '',
  });
  const novaFeature = JSON.stringify({
    is_meaningful: true,
    changed_what: 'NovaTech launched an AI writing assistant in beta',
    threat_level: 'medium',
    headline: 'NovaTech launched an AI writing assistant',
    summary: 'NovaTech entered our core feature territory with a beta launch.',
    recommended_response: 'Accelerate differentiation messaging.',
    talking_points: ['18 months of production AI maturity vs a fresh beta'],
    key_changes: [{ category: 'features', description: 'AI assistant launched', impact: 'Feature-parity attempt' }],
    opportunity: '',
  });

  const insertChange = db.prepare(`
    INSERT INTO changes (competitor_id, diff_summary, analysis, threat_level, recommended_response,
      talking_points, headline, analysis_status, is_meaningful, gate_category, pattern_tags, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', 1, ?, ?, ?)
  `);
  const acmePricingChangeId = insertChange.run(
    1, JSON.stringify({ added: ['$34'], removed: ['$49'] }), acmePricing, 'high',
    'Brief the sales team on competitive pricing rebuttals.',
    JSON.stringify(['Our Pro tier includes SSO and audit logs at no extra cost']),
    'Acme Corp restructured pricing with an aggressive Pro discount',
    'pricing_pattern', JSON.stringify(['pricing_change']), tsOffset(28),
  ).lastInsertRowid;
  const acmePlanChangeId = insertChange.run(
    1, JSON.stringify({ added: ['unlimited seats'], removed: ['per seat'] }), acmePlan, 'high',
    'Emphasize total cost of ownership in active deals.',
    JSON.stringify(['Unlimited seats often hides usage-based overage costs']),
    'Acme Corp removed Pro seat caps',
    'headings_changed', JSON.stringify(['plan_restructure']), tsOffset(14),
  ).lastInsertRowid;
  insertChange.run(
    2, JSON.stringify({ added: ['AI', 'beta'], removed: [] }), novaFeature, 'medium',
    'Accelerate differentiation messaging.',
    JSON.stringify(['18 months of production AI maturity vs a fresh beta']),
    'NovaTech launched an AI writing assistant',
    'content_change', JSON.stringify(['feature_launch']), tsOffset(20),
  );

  const insertDeal = db.prepare(`
    INSERT INTO deals (user_id, deal_name, outcome, competitor_id, deal_value_usd, close_date, notes, source, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const mk = (name, outcome, competitorId, value, daysAgo, notes, source) =>
    insertDeal.run(name, outcome, competitorId, value, dateOffset(daysAgo), notes || null, source || 'manual_form', tsOffset(daysAgo), tsOffset(daysAgo));

  // 10 losses against Acme inside the pricing-change windows.
  mk('Northwind Traders', 'lost', 1, 42000, 2,  'Went with Acme on price', 'manual_form');
  mk('Globex Logistics',  'lost', 1, 38000, 4,  'Lost on Pro pricing', 'slack_command');
  mk('Initech Platform',  'lost', 1, 55000, 6,  'Acme undercut us late in the cycle', 'manual_form');
  mk('Soylent Foods',     'lost', 1, 27000, 9,  null, 'manual_form');
  mk('Umbrella Health',   'lost', 1, 61000, 11, 'Budget pressure, Acme cheaper', 'manual_form');
  mk('Vandelay Imports',  'lost', 1, null,  13, 'No value recorded', 'slack_command');
  mk('Stark Solutions',   'lost', 1, 48000, 17, 'Acme removed seat caps, killed our objection', 'manual_form');
  mk('Wayne Manufacturing','lost',1, 33000, 20, null, 'manual_form');
  mk('Hooli Cloud',       'lost', 1, 72000, 24, 'Lost to Acme pricing again', 'manual_form');
  mk('Pied Piper Data',   'lost', 1, 29000, 27, null, 'slack_command');

  // 2 stalled against NovaTech (feature launch window) + 1 lost vs Horizon.
  mk('Cyberdyne Systems', 'stalled', 2, 36000, 8,  'Stalled after NovaTech AI demo', 'manual_form');
  mk('Tyrell Corp',       'stalled', 2, 45000, 15, 'Evaluating NovaTech beta', 'manual_form');
  mk('Oscorp Labs',       'lost',    3, 31000, 18, 'Chose Horizon on enterprise references', 'manual_form');

  // 5 wins (no competitor) for a believable win rate.
  mk('Contoso Corp',   'won', null, 25000, 3,  'Closed clean', 'manual_form');
  mk('Fabrikam Inc',   'won', null, 40000, 7,  null, 'slack_command');
  mk('Adventure Works','won', null, 52000, 12, 'Beat Acme on support SLA', 'manual_form');
  mk('Litware Group',  'won', null, 18000, 16, null, 'manual_form');
  mk('Proseware',      'won', null, 33000, 22, 'Renewal expansion', 'manual_form');

  saveDb();
  console.log(`✅ Phase 9 demo data seeded: 18 deals, backdated changes #${acmePricingChangeId}/#${acmePlanChangeId} for correlation`);
}

function seedDemoData() {
  const now = new Date();
  const ts = (offsetMs) => new Date(now - offsetMs).toISOString().replace('T', ' ').slice(0, 19);

  const c1 = db.prepare('INSERT INTO competitors (user_id, name, url, description, last_checked, last_content_hash, check_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, 'Acme Corp', 'https://acmecorp.com/pricing', 'Primary competitor in our core market segment', ts(3600000), 'hash_acme_001', 24).lastInsertRowid;
  const c2 = db.prepare('INSERT INTO competitors (user_id, name, url, description, last_checked, last_content_hash, check_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, 'NovaTech', 'https://novatech.io/features', 'Fast-growing startup targeting our SMB customers', ts(7200000), 'hash_nova_001', 18).lastInsertRowid;
  const c3 = db.prepare('INSERT INTO competitors (user_id, name, url, description, last_checked, last_content_hash, check_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, 'Horizon AI', 'https://horizonai.com', 'AI-first competitor, recently raised Series B', ts(21600000), 'hash_horizon_001', 31).lastInsertRowid;

  const highAnalysis = JSON.stringify({
    headline: 'Acme Corp slashed Pro plan pricing by 30%, an aggressive market move',
    summary: 'Acme Corp reduced their Pro plan from $49/mo to $34/mo and removed the seat limit. This is a significant pricing response likely targeting our recent customer wins. They also added a new "Starter" tier at $9/mo.',
    threat_level: 'high',
    threat_reasoning: 'Direct price undercut on our core plan with unlimited seats threatens our mid-market positioning.',
    recommended_response: 'Immediate sales team briefing required. Prepare competitive pricing rebuttals and emphasize superior support and integrations.',
    talking_points: [
      'Our platform includes enterprise SSO and audit logs at the Pro level. Acme charges extra for these',
      'We offer 99.9% SLA with dedicated support; Acme Pro only includes email support',
      'Our API rate limits are 10x higher than Acme at equivalent tiers',
      'Migration from Acme takes 2-3 weeks; we offer free white-glove onboarding'
    ],
    key_changes: [
      { category: 'pricing', description: 'Pro plan reduced from $49 to $34/mo', impact: 'Direct competitive threat to our primary revenue tier' },
      { category: 'pricing', description: 'New $9/mo Starter tier added', impact: 'Now competes in the SMB entry market we currently own' },
      { category: 'features', description: 'Seat limits removed from Pro plan', impact: 'Eliminates a key objection prospects previously raised against Acme' }
    ],
    opportunity: 'Aggressive pricing signals margin pressure. Emphasize stability and longevity in enterprise deals.'
  });

  const medAnalysis = JSON.stringify({
    headline: 'NovaTech launches AI writing assistant: enters our core feature territory',
    summary: 'NovaTech has quietly launched an AI-powered content generation feature that directly competes with our core offering. Currently in beta but prominently featured on their homepage.',
    threat_level: 'medium',
    threat_reasoning: 'Feature parity in a differentiated area, but NovaTech lacks our integrations ecosystem and enterprise credibility.',
    recommended_response: 'Accelerate roadmap items that further differentiate our AI capabilities. Brief sales team with comparison talking points.',
    talking_points: [
      'Our AI has been in production for 18 months with 500M+ documents processed. NovaTech is just starting',
      'We offer fine-tuning on company data; NovaTech uses generic models only',
      'Our compliance certifications (SOC2, HIPAA) cover AI features, critical for enterprise',
      'We integrate with 150+ tools; NovaTech supports 12'
    ],
    key_changes: [
      { category: 'features', description: 'AI writing assistant launched in beta', impact: 'Enters our primary differentiation area' },
      { category: 'messaging', description: 'Homepage now leads with AI messaging', impact: 'Repositioning toward our target buyer' }
    ],
    opportunity: 'Their beta launch gives us time to showcase production maturity. Create case studies highlighting AI ROI.'
  });

  const lowAnalysis = JSON.stringify({
    headline: 'Horizon AI updates case studies and adds two Fortune 500 logos',
    summary: 'Horizon AI refreshed their customer evidence page with two new Fortune 500 case studies and updated their ROI calculator. No product or pricing changes detected.',
    threat_level: 'low',
    threat_reasoning: 'Social proof improvements are positive for them but do not represent immediate competitive threat.',
    recommended_response: 'Update our own case study page if any similar wins are available. Ensure sales team is aware Horizon is targeting enterprise accounts.',
    talking_points: [
      'We have 3x more enterprise case studies across more industries',
      'Our G2 rating is 4.8 vs Horizon\'s 4.2 with significantly more reviews',
      'Our implementation timeline is 4 weeks vs Horizon\'s 12-week average'
    ],
    key_changes: [
      { category: 'messaging', description: 'Two new Fortune 500 logos added', impact: 'Improves enterprise credibility' },
      { category: 'features', description: 'ROI calculator updated', impact: 'Better sales enablement tool for their reps' }
    ],
    opportunity: 'If they are closing Fortune 500 deals, the market is validating enterprise demand. Ensure compelling enterprise proof points are ready.'
  });

  db.prepare('INSERT INTO changes (competitor_id, diff_summary, analysis, threat_level, recommended_response, talking_points, headline, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c1, JSON.stringify({ added: ['$34', 'Starter', 'unlimited seats'], removed: ['$49', 'per seat'] }),
      highAnalysis, 'high', 'Immediate sales team briefing required.',
      JSON.stringify(['Enterprise SSO included', 'Our 99.9% SLA', 'API rate limits 10x higher']),
      'Acme Corp slashed Pro plan pricing by 30%, an aggressive market move', ts(86400000));

  db.prepare('INSERT INTO changes (competitor_id, diff_summary, analysis, threat_level, recommended_response, talking_points, headline, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c2, JSON.stringify({ added: ['AI', 'writing assistant', 'beta'], removed: [] }),
      medAnalysis, 'medium', 'Accelerate roadmap AI differentiation.',
      JSON.stringify(['18 months production history', 'Fine-tuning on company data', 'SOC2/HIPAA certified']),
      'NovaTech launches AI writing assistant: enters our core feature territory', ts(259200000));

  db.prepare('INSERT INTO changes (competitor_id, diff_summary, analysis, threat_level, recommended_response, talking_points, headline, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c3, JSON.stringify({ added: ['Fortune 500', 'case study'], removed: [] }),
      lowAnalysis, 'low', 'Update our own case study page.',
      JSON.stringify(['3x more enterprise case studies', 'G2 rating 4.8 vs 4.2', '4-week implementation']),
      'Horizon AI updates case studies and adds two Fortune 500 logos', ts(86400000));

  saveDb();
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

// Phase 7 helper — extract bare domain from a URL (used by the migration and
// re-used by routes/competitors when a competitor row is created/updated).
function extractDomainFromUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch (_) { return null; }
}

module.exports = { initDb, getDb, extractDomainFromUrl };
