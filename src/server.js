require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const session = require('express-session');
const helmet  = require('helmet');
const path    = require('path');
const crypto  = require('crypto');

const { initDb, getDb }      = require('./db');
const { startScheduler }     = require('./scheduler');
const limits                 = require('./middleware/rateLimits');
const { csrfProtect, requestLogger, productionErrorHandler } = require('./middleware/security');

const authRouter        = require('./routes/auth');
const competitorsRouter = require('./routes/competitors');
const changesRouter     = require('./routes/changes');
const settingsRouter    = require('./routes/settings');
const userContextRouter = require('./routes/userContext');
const voiceProfileRouter = require('./routes/voiceProfile');
const playbooksRouter    = require('./routes/playbooks');
const calendarRouter    = require('./routes/calendar');
const dealsRouter        = require('./routes/deals');
const roiRouter          = require('./routes/roi');
const slackRouter        = require('./routes/slack');
// Phase 10 — billing, waitlist, GDPR account routes + webhook handler.
const billingRouter      = require('./routes/billing');
const waitlistRouter     = require('./routes/waitlist');
const accountRouter      = require('./routes/account');
const { handleLemonSqueezyWebhook } = require('./lemonSqueezyWebhook');
const { getUserCurrentWorkspace } = require('./lib/workspace');
// Phase 11C — public legal pages (Privacy / Terms / Cookies).
const { registerLegalRoutes } = require('./routes/legal');
const { registerContentRoutes, register404 } = require('./routes/content');
// Phase 12 — developer-only admin views (waitlist), gated by ADMIN_EMAILS.
const { registerAdminRoutes } = require('./routes/admin');
// Outbound — admin-only lead-gen. API router + the single access gate.
const outboundRouter = require('./routes/outbound');
const { requireOutboundAccess } = require('./outbound/access');

// ── DB-backed session store ────────────────────────────────────────────────────

class SqlJsSessionStore extends session.Store {
  constructor() { super(); }

  get(sid, cb) {
    try {
      const row = getDb().prepare(
        "SELECT data FROM sessions WHERE sid = ? AND expires_at > datetime('now')"
      ).get(sid);
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires instanceof Date
        ? sess.cookie.expires.toISOString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      getDb().prepare('INSERT OR REPLACE INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

const sessionStore = new SqlJsSessionStore();

// ── App ────────────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── Production env validation — fail fast on missing critical secrets ──────────
// A predictable SESSION_SECRET lets anyone forge session cookies, so there is no
// safe fallback in production: we refuse to boot without a real one. Other
// integrations (Anthropic, Lemon Squeezy, Resend) either degrade gracefully or
// are wired up in later Phase 12 sub-steps, so they are not hard requirements here.
const DEV_SESSION_SECRET = 'cs-dev-secret-CHANGE-THIS-IN-PRODUCTION';
if (IS_PRODUCTION) {
  const missing = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === DEV_SESSION_SECRET) {
    missing.push('SESSION_SECRET (set it to a strong random value)');
  }
  if (missing.length) {
    console.error('❌ Refusing to start in production — missing or invalid env:\n  - ' + missing.join('\n  - '));
    process.exit(1);
  }
}

// ── Trust the Railway reverse proxy ────────────────────────────────────────────
// Railway terminates TLS at its edge and forwards to the app over HTTP with
// X-Forwarded-* headers. Trusting the first proxy hop makes req.protocol,
// req.secure, and req.ip reflect the real client connection — required for
// secure-cookie emission (production cookies are secure:true) and for correct
// IP-based rate limiting.
app.set('trust proxy', 1);

// ── Health check (Railway monitoring) ──────────────────────────────────────────
// Registered first, before logging/session/static, so it stays cheap and
// dependency-free: no DB query, no session cookie, not written to the request
// log. Railway polls this to decide the container is live, so it must answer
// even while the DB is still initializing.
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

// ── Security headers (helmet) ──────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      // 'unsafe-inline' required for the anti-flash theme snippet in static HTML files.
      // A nonce-based CSP would remove this; tracked as a known limitation.
      // Phase 10: Lemon Squeezy overlay (lemon.js) is loaded from app.lemonsqueezy.com.
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://app.lemonsqueezy.com', 'https://assets.lemonsqueezy.com'],
      // Helmet's default for script-src-attr is 'none', which blocks all inline
      // event handlers (onclick, oninput, etc.). The SPA uses inline handlers
      // throughout for view switching, OTP submit, password eye toggles, etc.
      // Refactoring to addEventListener is a planned hardening step.
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:         ["'self'", 'data:', 'https:'],
      // Lemon Squeezy overlay posts to / loads assets from *.lemonsqueezy.com.
      connectSrc:     ["'self'", 'https://*.lemonsqueezy.com'],
      // player.vimeo.com hosts the lazy-loaded landing-page demo embed.
      frameSrc:       ["'self'", 'https://*.lemonsqueezy.com', 'https://player.vimeo.com'],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
    },
    // upgradeInsecureRequests in production only
    reportOnly: false,
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 63072000, // 2 years
    includeSubDomains: true,
    preload: true,
  },
}));

// ── Core middleware ────────────────────────────────────────────────────────────

app.use(cors({ origin: false }));

// ── Lemon Squeezy webhook (RAW body — MUST precede express.json) ────────────────
// The HMAC-SHA256 signature is verified against the exact raw bytes; parsing the
// JSON first would alter the body and break verification. No CSRF/session auth —
// authenticity is established solely by the signature.
app.post('/api/webhooks/lemonsqueezy', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const { statusCode, body } = handleLemonSqueezyWebhook(req.body, req.headers['x-signature'], req);
  res.status(statusCode).json(body);
});

app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);

app.use(session({
  name:             'cs.sid',
  // In production the env guard above guarantees SESSION_SECRET is set, so this
  // fallback only ever applies in local dev.
  secret:           process.env.SESSION_SECRET || DEV_SESSION_SECRET,
  resave:           false,
  saveUninitialized: false,
  store:            sessionStore,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    // 'lax' (not 'strict') so the session cookie is sent on top-level
    // cross-site navigations like Google's OAuth 302 back to
    // /api/calendar/google/callback. CSRF is still protected: csrfProtect
    // middleware enforces a double-submit token on every POST/PUT/DELETE,
    // and 'lax' continues to block cookies on cross-site POST/iframe loads.
    sameSite: 'lax',
    // No maxAge by default = session cookie (browser-close expiry).
    // Login route sets maxAge = 30 days when "Remember me" is checked.
  },
}));

// ── Guard /app ─────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.path === '/app' || req.path.startsWith('/app/')) {
    if (!req.session?.userId) {
      if (req.method === 'GET') {
        return res.redirect('/login?returnTo=' + encodeURIComponent(req.originalUrl));
      }
      return res.redirect('/login');
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

// ── Auth middleware ────────────────────────────────────────────────────────────

// Phase 10 — resolve the user's current workspace onto the request so every
// protected route can scope/gate by workspace. Phase 10: always the user's own
// personal workspace (role 'owner'). Phase 10.5: session-based active workspace.
function attachWorkspace(req) {
  try {
    const ws = getUserCurrentWorkspace(req.userId);
    req.workspaceId   = ws ? ws.id : null;
    req.workspace     = ws || null;
    req.workspaceRole = ws ? 'owner' : null;
  } catch (_) {
    req.workspaceId = null; req.workspace = null; req.workspaceRole = null;
  }
}

function requireAuth(req, res, next) {
  const db = getDb();

  // API-key auth (programmatic access)
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const user = db.prepare('SELECT * FROM users WHERE api_key = ?').get(apiKey);
    if (!user) return res.status(401).json({ error: 'Invalid API key' });
    req.userId = user.id;
    req.user   = user;
    attachWorkspace(req);
    return next();
  }

  // Session auth
  if (req.session?.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    // Reject sessions that predate a password change
    if (req.session.sessionVersion !== undefined &&
        req.session.sessionVersion !== user.session_version) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    // Ensure every authenticated session has a CSRF token
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      req.session.save(() => {}); // async, fire-and-forget
    }

    req.userId = user.id;
    req.user   = user;
    attachWorkspace(req);
    return next();
  }

  return res.status(401).json({ error: 'Not authenticated' });
}

// ── Rate-limited API routes ────────────────────────────────────────────────────

// Auth endpoints: individual limits applied per-route in auth.js
app.use('/api/auth', authRouter);

// Protected endpoints: general rate limit + auth + CSRF
app.use('/api/competitors',  limits.api, requireAuth, csrfProtect, competitorsRouter);
app.use('/api/changes',      limits.api, requireAuth, csrfProtect, changesRouter);
app.use('/api/settings',     limits.api, requireAuth, csrfProtect, settingsRouter);
app.use('/api/user/context',       limits.api, requireAuth, csrfProtect, userContextRouter);
app.use('/api/user/voice-profile', limits.api, requireAuth, csrfProtect, voiceProfileRouter);
app.use('/api/playbooks',          limits.api, requireAuth, csrfProtect, playbooksRouter);

// Phase 9 — win/loss deals + ROI dashboard. Standard protected mounting.
app.use('/api/deals', limits.api, requireAuth, csrfProtect, dealsRouter);
app.use('/api/roi',   limits.api, requireAuth, csrfProtect, roiRouter);

// Outbound (admin-only) — standard protected mounting plus the single access
// gate. requireOutboundAccess runs after requireAuth (so req.user is set) and is
// the ONLY place the admin-only policy is enforced for these APIs; non-admins
// get a JSON 403. See src/outbound/access.js to open this to the public later.
app.use('/api/admin/outbound', limits.api, requireAuth, csrfProtect, requireOutboundAccess, outboundRouter);

// Phase 10 — billing + GDPR account routes (protected). Per-endpoint rate
// limits live inside the routers. The public email-link restore is registered
// BEFORE the protected /api/account mount so the unauthenticated GET resolves
// first (the in-app POST /delete/cancel still routes to the protected router).
app.get('/api/account/delete/cancel', accountRouter.restoreByToken);
app.use('/api/billing', limits.api, requireAuth, csrfProtect, billingRouter);
app.use('/api/account', limits.api, requireAuth, csrfProtect, accountRouter);

// Phase 10 — Team/Business waitlist (PUBLIC, IP rate-limited).
app.use('/api/waitlist', limits.waitlist, waitlistRouter);

// Phase 9 — Slack. The router does its own auth internally: the slash command
// + interactions endpoints are authenticated by Slack's request signature (not
// a session) and need the raw body, so they cannot use requireAuth+csrfProtect.
// The OAuth start/callback/disconnect routes enforce session auth themselves.
app.use('/api/slack', limits.slack, slackRouter);

// Phase 7 — calendar router does its own auth + CSRF internally because OAuth
// callback + the navigational /connect redirect cannot use the standard
// requireAuth+csrfProtect mounting (callback has no session-cookie path tied
// to the API CSRF token, and the redirect is a top-level GET).
app.use('/api/calendar', limits.api, calendarRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ── Auth pages ─────────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  // A signed-in user is normally bounced to the app, but the in-app Profile
  // "Change password" action deep-links here with ?forgot=1 to reuse the
  // password-reset flow. Let that case through so the reset screen can render.
  if (req.session?.userId && !req.query.forgot) return res.redirect('/app');
  res.sendFile(path.join(__dirname, '../public/auth/index.html'));
});

app.get('/register', (req, res) => {
  if (req.session?.userId) return res.redirect('/app');
  res.sendFile(path.join(__dirname, '../public/auth/index.html'));
});

// ── Public legal pages (Phase 11C) ───────────────────────────────────────────────
// /privacy, /terms, /cookies — no auth, registered before the SPA catch-all.
registerLegalRoutes(app);

// ── Admin pages (Phase 12) ────────────────────────────────────────────────────────
// /admin, /admin/waitlist — session auth + ADMIN_EMAILS gate (enforced inside the
// router). Registered before the SPA catch-all so /admin/* resolves here.
registerAdminRoutes(app);

// ── Dashboard SPA ──────────────────────────────────────────────────────────────

app.get('/app',   (req, res) => res.sendFile(path.join(__dirname, '../public/app/index.html')));
app.get('/app/*', (req, res) => res.sendFile(path.join(__dirname, '../public/app/index.html')));

// ── Content pages + generated sitemap (Module 2) ───────────────────────────────
// Markdown-driven /for, /blog, /glossary, /alternatives, /compare pages. MUST be
// registered here: after the specific routes above (so /app, /login, legal and
// admin win) and before the 404 handler. The homepage catch-all that used to
// live here served /for/sales-teams as the homepage (a soft 404 to search
// engines); it is gone. The landing page is served by express.static at '/'.
registerContentRoutes(app);

// Real 404 for every genuinely unmatched path (replaces the homepage catch-all).
register404(app);

// ── Production error handler ───────────────────────────────────────────────────

app.use(productionErrorHandler);

// ── Start ──────────────────────────────────────────────────────────────────────

function logAnthropicKeyStatus() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.warn('⚠️  ANTHROPIC_API_KEY is not set — change analysis will use rule-based fallback');
    return;
  }
  const prefix = key.slice(0, 10);
  const shapeOk = /^sk-ant-[a-z0-9-]+/i.test(key) && key.length > 30;
  if (shapeOk) {
    console.log(`✅ ANTHROPIC_API_KEY present (prefix: ${prefix}…, length: ${key.length}) — AI analysis enabled`);
  } else {
    console.warn(`⚠️  ANTHROPIC_API_KEY is set (prefix: ${prefix}…, length: ${key.length}) but shape looks unusual — AI calls may fail`);
  }
}

initDb().then(() => {
  // Purge expired sessions hourly
  setInterval(() => {
    try { getDb().prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run(); } catch (_) {}
  }, 60 * 60 * 1000);

  logAnthropicKeyStatus();
  startScheduler();
  app.listen(PORT, () => {
    console.log(`\n🔍 Nivaria — http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
