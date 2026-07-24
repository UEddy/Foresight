// Phase 12 — developer-only admin views, gated by the ADMIN_EMAILS env var
// (comma-separated). A deliberately minimal stand-in for a real role system.
//
// Pages:
//   GET  /admin                 → redirect to /admin/waitlist
//   GET  /admin/waitlist        → Team/Business waitlist table
//   GET  /admin/users           → user list with is_developer status
//   GET  /admin/set-developer   → form to toggle a user's is_developer flag
//   POST /admin/set-developer   → apply the toggle (CSRF-protected, audited)
//
// Mounted directly on the app (not as a sub-router) so paths stay /admin*,
// registered BEFORE the SPA catch-all in server.js.

const crypto  = require('crypto');
const express = require('express');
const { getDb } = require('../db');
const { logAudit } = require('../lib/audit');
// Authoritative effective-tier source (same one the dashboard/sidebar/Settings
// read). Tallied per workspace for the stats breakdown so every surface agrees.
const { getWorkspaceTier } = require('../lib/tierLimits');
const { getTrialInfo } = require('../lib/trial');
// Admin identification (ADMIN_EMAILS) now lives in lib/ so the tier-limit layer
// can share the exact same gate. Re-exported below to keep this module's API.
const { getAdminEmails, isAdminEmail } = require('../lib/adminEmails');
// Outbound admin page body (rendered inside renderShell below). The API lives in
// routes/outbound.js; this is just the server-rendered page shell + client JS.
const { renderOutboundBody } = require('../outbound/adminPage');

// Minimal HTML escaper for user-controlled values rendered into pages.
function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Constant-time string compare for the CSRF token.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Guard: must be logged in (else → /login) AND an admin email (else → 403).
// Resolves req.adminUser and ensures the session carries a CSRF token (used by
// the set-developer form). Redirects rather than returning JSON 401 because
// these are browser-facing pages.
function requireAdmin(req, res, next) {
  if (!req.session?.userId) return res.redirect('/login');
  const user = getDb().prepare('SELECT id, email FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.redirect('/login');
  if (!isAdminEmail(user.email)) return res.status(403).type('html').send(renderDenied());
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    req.session.save(() => {});
  }
  req.adminUser = user;
  next();
}

function navHtml(active) {
  const links = [
    ['/admin/stats', 'Stats'],
    ['/admin/outbound', 'Outbound'],
    ['/admin/waitlist', 'Waitlist'],
    ['/admin/users', 'Users'],
    ['/admin/set-tier', 'Grant Pro'],
    ['/admin/set-developer', 'Set developer'],
  ];
  return `<nav class="admin-nav">${links
    .map(([href, label]) => `<a href="${href}"${active === href ? ' class="active"' : ''}>${label}</a>`)
    .join('')}</nav>`;
}

function renderShell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Nivaria Admin: ${esc(title)}</title>
  <style>
    :root {
      --bg: #000000; --bg-2: #0A0A0A; --bg-card: rgba(255,255,255,0.04);
      --border: rgba(255,255,255,0.10); --txt: #F0F0F8; --txt-2: #888899;
      --txt-3: #555566; --accent: #818CF8;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      background: var(--bg); color: var(--txt); line-height: 1.6;
      -webkit-font-smoothing: antialiased; padding: 40px 24px;
    }
    .admin-wrap { max-width: 1080px; margin: 0 auto; }
    .admin-nav { display: flex; gap: 6px; margin-bottom: 28px; flex-wrap: wrap; }
    .admin-nav a {
      font-size: 0.8125rem; font-weight: 600; color: var(--txt-2);
      text-decoration: none; padding: 6px 12px; border-radius: 8px;
      border: 1px solid var(--border);
    }
    .admin-nav a:hover { color: var(--txt); background: var(--bg-card); }
    .admin-nav a.active { color: #fff; background: var(--accent); border-color: var(--accent); }
    .admin-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
    h1 { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; }
    .admin-sub { color: var(--txt-2); font-size: 0.875rem; margin-bottom: 28px; }
    .admin-count { color: var(--accent); font-weight: 700; }
    table { width: 100%; border-collapse: collapse; background: var(--bg-2); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; font-size: 0.875rem; }
    thead th { text-align: left; padding: 12px 16px; background: var(--bg-card); color: var(--txt-2); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.6875rem; border-bottom: 1px solid var(--border); }
    tbody td { padding: 12px 16px; border-bottom: 1px solid var(--border); color: var(--txt); vertical-align: top; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: rgba(255,255,255,0.02); }
    .pill { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
    .pill-team { background: rgba(129,140,248,0.16); color: #A5B4FC; }
    .pill-business { background: rgba(16,185,129,0.16); color: #34D399; }
    .pill-trial { background: rgba(236,72,153,0.16); color: #F472B6; }
    .pill-dev { background: rgba(245,158,11,0.18); color: #FBBF24; }
    .pill-off { background: rgba(255,255,255,0.06); color: var(--txt-3); }
    .muted { color: var(--txt-3); }
    .empty { padding: 40px 16px; text-align: center; color: var(--txt-2); }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 28px; }
    .stat-card { background: var(--bg-2); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; }
    .stat-num { font-size: 2rem; font-weight: 800; letter-spacing: -0.02em; color: var(--txt); }
    .stat-label { font-size: 0.75rem; color: var(--txt-2); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; margin-top: 4px; }
    .stat-section-title { font-size: 0.8125rem; font-weight: 700; color: var(--txt-2); text-transform: uppercase; letter-spacing: 0.06em; margin: 4px 0 12px; }
    .stat-card .pill { margin-top: 8px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .back { display: inline-block; margin-top: 24px; font-size: 0.8125rem; color: var(--txt-2); }
    form.admin-form { max-width: 460px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
    .field { margin-bottom: 18px; }
    label { display: block; font-size: 0.8125rem; font-weight: 600; color: var(--txt-2); margin-bottom: 6px; }
    input[type=email], input[type=text], select {
      width: 100%; height: 42px; padding: 0 12px; border-radius: 9px;
      background: var(--bg-card); border: 1.5px solid var(--border);
      color: var(--txt); font-size: 0.9rem; font-family: inherit;
    }
    input:focus, select:focus { outline: none; border-color: var(--accent); }
    /* Shared refined dropdown chevron, matches the app design system:
       muted secondary tone, 18px, ~1.75px stroke, centred with right padding.
       Brightens to the accent and flips up on focus (the open affordance). */
    select {
      appearance: none; -webkit-appearance: none; -moz-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%23888899' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 14px center; background-size: 18px 18px;
      padding-right: 40px; transition: border-color 0.15s, background-image 0.15s ease;
    }
    select:hover { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%23818CF8' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); }
    select:focus { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%23818CF8' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m18 15-6-6-6 6'/%3E%3C/svg%3E"); }
    button.submit {
      height: 42px; padding: 0 22px; border: none; border-radius: 9px;
      background: var(--accent); color: #fff; font-weight: 700; font-size: 0.875rem;
      font-family: inherit; cursor: pointer;
    }
    button.submit:hover { filter: brightness(1.08); }
    .note { padding: 12px 14px; border-radius: 9px; font-size: 0.85rem; margin-bottom: 20px; }
    .note-ok  { background: rgba(16,185,129,0.12); color: #34D399; border: 1px solid rgba(16,185,129,0.3); }
    .note-err { background: rgba(239,68,68,0.12); color: #F87171; border: 1px solid rgba(239,68,68,0.3); }
    .warn { font-size: 0.8rem; color: var(--txt-3); margin-top: 14px; }
  </style>
</head>
<body>
  <div class="admin-wrap">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function renderDenied() {
  return renderShell('Access denied', `
    <div class="admin-head"><h1>403: Access denied</h1></div>
    <p class="admin-sub">Your account is not authorized to view this page.</p>
    <a class="back" href="/app">&larr; Back to app</a>`);
}

function devPill(on) {
  return on
    ? '<span class="pill pill-dev">developer</span>'
    : '<span class="pill pill-off">no</span>';
}

// All inputs are integer aggregate counts (no per-user data). num() formats
// them with thousands separators for readability.
function renderStats(s) {
  const num = n => Number(n || 0).toLocaleString('en-US');
  const statCard = (value, label) =>
    `<div class="stat-card"><div class="stat-num">${num(value)}</div><div class="stat-label">${esc(label)}</div></div>`;

  return renderShell('Stats', `
    ${navHtml('/admin/stats')}
    <div class="admin-head"><h1>Stats</h1></div>
    <p class="admin-sub">Aggregate counts only. No individual user data is shown or logged.</p>

    <div class="stat-grid">
      ${statCard(s.totalUsers, 'Total users')}
      ${statCard(s.newUsers7d, 'New users (7 days)')}
      ${statCard(s.activeCompetitors, 'Pages monitored')}
    </div>

    <p class="stat-section-title">Workspaces by tier</p>
    <p class="admin-sub">Effective tier from getWorkspaceTier, the same source the in-app plan display uses. Tallied across all ${num(s.workspaceCount)} workspaces.</p>
    <div class="stat-grid">
      ${statCard(s.tierCounts.free, 'Free')}
      ${statCard(s.tierCounts.pro, 'Pro')}
      ${statCard(s.tierCounts.team, 'Team')}
      ${statCard(s.tierCounts.business, 'Business')}
    </div>

    <p class="stat-section-title">Waitlist by interest</p>
    <p class="admin-sub">Team and Business tier interest plus 14-day Pro trial requests (tier_interest='trial').</p>
    <div class="stat-grid">
      ${statCard(s.waitlistCounts.team, 'Team')}
      ${statCard(s.waitlistCounts.business, 'Business')}
      ${statCard(s.waitlistCounts.trial, 'Trial')}
    </div>

    <a class="back" href="/app">&larr; Back to app</a>`);
}

function renderWaitlist(rows) {
  const body = rows.length
    ? rows.map(r => `
        <tr>
          <td class="muted">${esc(r.id)}</td>
          <td>${esc(r.email)}</td>
          <td><span class="pill pill-${esc(r.tier_interest)}">${esc(r.tier_interest)}</span></td>
          <td>${esc(r.created_at)}</td>
          <td>${r.notified_at ? esc(r.notified_at) : '<span class="muted">-</span>'}</td>
        </tr>`).join('')
    : `<tr><td class="empty" colspan="5">No waitlist signups yet.</td></tr>`;

  return renderShell('Waitlist', `
    ${navHtml('/admin/waitlist')}
    <div class="admin-head">
      <h1>Waitlist signups</h1>
      <span class="admin-sub"><span class="admin-count">${rows.length}</span> total</span>
    </div>
    <p class="admin-sub">Team and Business tier interest plus 14-day Pro trial requests (tier_interest='trial'), captured from the marketing site and in-app upgrade gate. Trial requests are granted manually until a payment processor is live.</p>
    <table>
      <thead><tr><th>id</th><th>email</th><th>tier_interest</th><th>created_at</th><th>notified_at</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <a class="back" href="/app">&larr; Back to app</a>`);
}

// Trial cell: "on trial" while active (with days remaining and the downgrade
// date, which is simply trial_ends_at), "expired" after, blank for paid or
// pre-trial accounts. Paid subscriptions supersede trial state entirely.
function trialCells(r) {
  if (r.subscription_id || (r.subscription_tier && r.subscription_tier !== 'free')) {
    return `<td><span class="pill pill-done">${esc(r.subscription_tier || 'paid')}</span></td><td class="muted">-</td><td class="muted">-</td>`;
  }
  const info = getTrialInfo({
    subscription_tier: r.subscription_tier, subscription_id: r.subscription_id, trial_ends_at: r.trial_ends_at,
  });
  if (info.onTrial) {
    return `<td><span class="pill pill-trial">on trial</span></td><td>${esc(info.daysLeft)}</td><td class="muted">${esc(String(r.trial_ends_at).slice(0, 10))}</td>`;
  }
  if (info.expired) {
    return `<td><span class="pill pill-pending">expired</span></td><td class="muted">0</td><td class="muted">${esc(String(r.trial_ends_at).slice(0, 10))}</td>`;
  }
  return `<td class="muted">-</td><td class="muted">-</td><td class="muted">-</td>`;
}

function renderUsers(rows) {
  const devCount = rows.filter(r => r.is_developer).length;
  const onTrialCount = rows.filter(r => getTrialInfo({
    subscription_tier: r.subscription_tier, subscription_id: r.subscription_id, trial_ends_at: r.trial_ends_at,
  }).onTrial).length;
  const body = rows.length
    ? rows.map(r => `
        <tr>
          <td class="muted">${esc(r.id)}</td>
          <td>${esc(r.email)}</td>
          <td>${esc(r.name)}</td>
          <td>${devPill(!!r.is_developer)}</td>
          ${trialCells(r)}
          <td>${esc(r.created_at)}</td>
        </tr>`).join('')
    : `<tr><td class="empty" colspan="8">No users.</td></tr>`;

  return renderShell('Users', `
    ${navHtml('/admin/users')}
    <div class="admin-head">
      <h1>Users</h1>
      <span class="admin-sub"><span class="admin-count">${onTrialCount}</span> on trial, <span class="admin-count">${devCount}</span> with developer access</span>
    </div>
    <p class="admin-sub">Developer accounts have an emergency override granting full Pro features regardless of subscription. Manage via <a href="/admin/set-developer">Set developer</a>. Downgrade date is the trial end; expired accounts fall back to Free automatically.</p>
    <table>
      <thead><tr><th>id</th><th>email</th><th>name</th><th>developer</th><th>trial</th><th>days left</th><th>downgrade date</th><th>created_at</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <a class="back" href="/app">&larr; Back to app</a>`);
}

// note: { type: 'ok'|'err', text } | null. prefillEmail: pre-populate the field.
function renderSetDeveloperForm(csrfToken, note, prefillEmail) {
  const noteHtml = note
    ? `<div class="note note-${note.type === 'ok' ? 'ok' : 'err'}">${esc(note.text)}</div>`
    : '';
  return renderShell('Set developer', `
    ${navHtml('/admin/set-developer')}
    <div class="admin-head"><h1>Set developer flag</h1></div>
    <p class="admin-sub">Grant or revoke the emergency Pro override for a specific user by email.</p>
    ${noteHtml}
    <form class="admin-form" method="POST" action="/admin/set-developer">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <div class="field">
        <label for="email">User email</label>
        <input type="email" id="email" name="email" required placeholder="user@example.com" value="${esc(prefillEmail || '')}">
      </div>
      <div class="field">
        <label for="is_developer">Developer access</label>
        <select id="is_developer" name="is_developer">
          <option value="true">Enable (grant unlimited Pro)</option>
          <option value="false">Disable (normal tier behaviour)</option>
        </select>
      </div>
      <button class="submit" type="submit">Apply</button>
      <p class="warn">This override grants full Pro features regardless of subscription state. It does not change billing or the user's actual paid tier.</p>
    </form>
    <a class="back" href="/admin/users">&larr; Back to users</a>`);
}

// Pre-launch manual Pro grant form. note: { type, text } | null. prefillEmail
// pre-populates the field. grantedRows: workspaces currently carrying a manual
// grant (tier_granted_at set), shown so the admin can track who was comped and
// when, ahead of the payment-processor transition.
function renderSetTierForm(csrfToken, note, prefillEmail, grantedRows) {
  const noteHtml = note
    ? `<div class="note note-${note.type === 'ok' ? 'ok' : 'err'}">${esc(note.text)}</div>`
    : '';

  const rows = grantedRows || [];
  const grantedBody = rows.length
    ? rows.map(r => `
        <tr>
          <td class="muted">${esc(r.workspace_id)}</td>
          <td>${esc(r.email)}</td>
          <td><span class="pill pill-team">${esc(r.subscription_tier)}</span></td>
          <td>${esc(r.tier_granted_at)}</td>
        </tr>`).join('')
    : `<tr><td class="empty" colspan="4">No manual grants yet.</td></tr>`;

  return renderShell('Grant Pro', `
    ${navHtml('/admin/set-tier')}
    <div class="admin-head"><h1>Grant Pro access</h1></div>
    <p class="admin-sub">Manually set a user's workspace tier during the pre-launch window. Look up a user by email and grant Pro (or revert to Free). New signups always default to Free.</p>
    ${noteHtml}
    <form class="admin-form" method="POST" action="/admin/set-tier">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <div class="field">
        <label for="tier-email">User email</label>
        <input type="email" id="tier-email" name="email" required placeholder="user@example.com" value="${esc(prefillEmail || '')}">
      </div>
      <div class="field">
        <label for="tier">Tier</label>
        <select id="tier" name="tier">
          <option value="pro">Grant Pro (15 pages, daily monitoring, full features)</option>
          <option value="free">Revert to Free</option>
        </select>
      </div>
      <button class="submit" type="submit">Apply</button>
      <p class="warn">This sets the workspace's authoritative subscription tier, the same field a payment webhook will later drive. Grant time is recorded so comped accounts can be transitioned to paid once billing is live. It does not charge the user or create a real subscription.</p>
    </form>

    <p class="stat-section-title" style="margin-top:32px">Currently granted</p>
    <p class="admin-sub">Workspaces carrying a manual Pro grant, with the time it was granted.</p>
    <table>
      <thead><tr><th>workspace</th><th>email</th><th>tier</th><th>granted_at</th></tr></thead>
      <tbody>${grantedBody}</tbody>
    </table>
    <a class="back" href="/admin/users">&larr; Back to users</a>`);
}

// Workspaces currently carrying a manual grant (tier_granted_at set), joined to
// the owner's email for display. Admin-only surface, so email is acceptable
// here (consistent with the Users and Waitlist tables).
function getGrantedWorkspaces(db) {
  return db.prepare(`
    SELECT w.id AS workspace_id, w.subscription_tier, w.tier_granted_at, u.email
    FROM workspaces w JOIN users u ON u.id = w.owner_user_id
    WHERE w.tier_granted_at IS NOT NULL
    ORDER BY w.tier_granted_at DESC, w.id DESC
  `).all();
}

function registerAdminRoutes(app) {
  const urlencoded = express.urlencoded({ extended: false });

  app.get('/admin', requireAdmin, (_req, res) => res.redirect('/admin/stats'));

  app.get('/admin/stats', requireAdmin, (req, res) => {
    const db = getDb();

    const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const newUsers7d = db.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE created_at >= datetime('now', '-7 days')`
    ).get().n;
    // "Being monitored" = active competitors (active=1), the rows the scheduler
    // actually checks. A rough cross-account activity signal.
    const activeCompetitors = db.prepare(
      'SELECT COUNT(*) AS n FROM competitors WHERE active = 1'
    ).get().n;

    // Tier breakdown from the authoritative effective-tier source. Resolve each
    // workspace through getWorkspaceTier (honours cancellation grace periods),
    // so this matches what the app shows the user, not the deprecated
    // users.tier column.
    const wsIds = db.prepare('SELECT id FROM workspaces').all();
    const tierCounts = { free: 0, pro: 0, team: 0, business: 0 };
    for (const { id } of wsIds) {
      const t = getWorkspaceTier(id);
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    }

    // Waitlist counts by tier_interest, reusing the existing waitlist data.
    const waitlistCounts = { team: 0, business: 0, trial: 0 };
    for (const r of db.prepare('SELECT tier, COUNT(*) AS n FROM waitlist_signups GROUP BY tier').all()) {
      waitlistCounts[r.tier] = r.n;
    }

    // Audit the view with aggregate counts only — no emails or per-user data.
    logAudit({ userId: req.adminUser.id, workspaceId: req.workspaceId || null,
      eventType: 'admin_view_stats',
      eventData: { total_users: totalUsers, workspaces: wsIds.length }, req });

    res.type('html').send(renderStats({
      totalUsers, newUsers7d, activeCompetitors,
      tierCounts, waitlistCounts, workspaceCount: wsIds.length,
    }));
  });

  // Outbound — admin-only lead-gen. Server-rendered page; all data flows through
  // the /api/admin/outbound/* JSON API (see routes/outbound.js), which enforces
  // the same admin gate. requireAdmin guarantees req.session.csrfToken for the
  // page's fetch calls.
  app.get('/admin/outbound', requireAdmin, (req, res) => {
    logAudit({ userId: req.adminUser.id, workspaceId: req.workspaceId || null,
      eventType: 'admin_view_outbound', eventData: {}, req });
    res.type('html').send(
      renderShell('Outbound', navHtml('/admin/outbound') + renderOutboundBody(req.session.csrfToken))
    );
  });

  app.get('/admin/waitlist', requireAdmin, (req, res) => {
    // Column aliases map storage names (tier, signed_up_at) onto the display
    // contract (tier_interest, created_at).
    const rows = getDb().prepare(`
      SELECT id, email, tier AS tier_interest, signed_up_at AS created_at, notified_at
      FROM waitlist_signups
      ORDER BY signed_up_at DESC, id DESC
    `).all();
    logAudit({ userId: req.adminUser.id, workspaceId: req.workspaceId || null,
      eventType: 'admin_view_waitlist', eventData: { count: rows.length }, req });
    res.type('html').send(renderWaitlist(rows));
  });

  app.get('/admin/users', requireAdmin, (req, res) => {
    const rows = getDb().prepare(`
      SELECT u.id, u.email, u.name, u.is_developer, u.created_at,
             w.subscription_tier, w.subscription_id, w.trial_ends_at
      FROM users u
      LEFT JOIN workspaces w ON w.owner_user_id = u.id
      ORDER BY u.id ASC
    `).all();
    logAudit({ userId: req.adminUser.id, workspaceId: req.workspaceId || null,
      eventType: 'admin_view_users', eventData: { count: rows.length }, req });
    res.type('html').send(renderUsers(rows));
  });

  app.get('/admin/set-developer', requireAdmin, (req, res) => {
    res.type('html').send(renderSetDeveloperForm(req.session.csrfToken, null, req.query.email));
  });

  app.post('/admin/set-developer', urlencoded, requireAdmin, (req, res) => {
    const token = req.body?._csrf;
    if (!safeEqual(token, req.session.csrfToken)) {
      return res.status(403).type('html').send(
        renderSetDeveloperForm(req.session.csrfToken, { type: 'err', text: 'Invalid request token. Please reload and try again.' })
      );
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    const value = String(req.body?.is_developer || '') === 'true' ? 1 : 0;

    if (!email) {
      return res.status(400).type('html').send(
        renderSetDeveloperForm(req.session.csrfToken, { type: 'err', text: 'An email address is required.' }, email)
      );
    }

    const db = getDb();
    const user = db.prepare('SELECT id, email, is_developer FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(404).type('html').send(
        renderSetDeveloperForm(req.session.csrfToken, { type: 'err', text: `No user found with email ${email}.` }, email)
      );
    }

    db.prepare('UPDATE users SET is_developer = ? WHERE id = ?').run(value, user.id);

    // Audit every change: which admin set what value on which target.
    logAudit({
      userId: req.adminUser.id,
      workspaceId: req.workspaceId || null,
      eventType: 'set_developer_flag',
      eventData: {
        target_user_id: user.id,
        target_email: user.email,
        is_developer: !!value,
        previous: !!user.is_developer,
        set_by: req.adminUser.email,
      },
      req,
    });

    const text = value
      ? `Developer access ENABLED for ${user.email}. They now have unlimited Pro features.`
      : `Developer access DISABLED for ${user.email}. Normal tier behaviour applies.`;
    res.type('html').send(renderSetDeveloperForm(req.session.csrfToken, { type: 'ok', text }, email));
  });

  app.get('/admin/set-tier', requireAdmin, (req, res) => {
    res.type('html').send(
      renderSetTierForm(req.session.csrfToken, null, req.query.email, getGrantedWorkspaces(getDb()))
    );
  });

  // Manually set a user's workspace tier during the pre-launch window. Writes
  // the AUTHORITATIVE source (workspaces.subscription_tier and the related
  // subscription_* fields read by getWorkspaceTier), so the grant reflects
  // everywhere consistently (hamburger, Settings, slot counter) and a future
  // payment webhook overwrites the exact same field with no parallel system to
  // reconcile. No automated trial/expiry is created. This is purely an admin
  // set, the same shape as the existing set-developer handler.
  app.post('/admin/set-tier', urlencoded, requireAdmin, (req, res) => {
    const db = getDb();
    const reform = (note, prefill) =>
      renderSetTierForm(req.session.csrfToken, note, prefill, getGrantedWorkspaces(db));

    const token = req.body?._csrf;
    if (!safeEqual(token, req.session.csrfToken)) {
      return res.status(403).type('html').send(
        reform({ type: 'err', text: 'Invalid request token. Please reload and try again.' })
      );
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    const tier = String(req.body?.tier || '').trim().toLowerCase();

    if (!email) {
      return res.status(400).type('html').send(
        reform({ type: 'err', text: 'An email address is required.' }, email)
      );
    }
    if (tier !== 'pro' && tier !== 'free') {
      return res.status(400).type('html').send(
        reform({ type: 'err', text: 'Tier must be either Pro or Free.' }, email)
      );
    }

    const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(404).type('html').send(
        reform({ type: 'err', text: `No user found with email ${email}.` }, email)
      );
    }

    const ws = db.prepare(
      'SELECT id, subscription_tier, subscription_id FROM workspaces WHERE owner_user_id = ?'
    ).get(user.id);
    if (!ws) {
      return res.status(404).type('html').send(
        reform({ type: 'err', text: `No workspace found for ${user.email}.` }, email)
      );
    }

    // Safety: never clobber a workspace already linked to a real payment-processor
    // subscription. Once billing is live, real subscriptions own the tier and must
    // be changed through the billing portal, not this manual override, so the two
    // tier sources can never fight. (During the pre-launch window no workspace has
    // a subscription_id, so this never blocks a legitimate grant.)
    if (ws.subscription_id) {
      return res.status(409).type('html').send(
        reform({ type: 'err', text: `${user.email} has a live subscription. Manage their tier through the billing portal, not a manual grant.` }, email)
      );
    }

    const previousTier = getWorkspaceTier(ws.id);

    if (tier === 'pro') {
      // Grant a real Pro experience via the authoritative fields: active status,
      // no end date, no pending cancellation. tier_granted_at records WHEN, for
      // the future paid transition. getWorkspaceTier now returns 'pro' for this
      // workspace, so every surface shows Pro / 15 pages.
      db.prepare(`
        UPDATE workspaces SET
          subscription_tier = 'pro',
          subscription_status = 'active',
          subscription_current_period_end = NULL,
          subscription_cancel_at_period_end = 0,
          tier_granted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(ws.id);
    } else {
      // Revert to Free: clear the manual grant and its subscription_* fields.
      db.prepare(`
        UPDATE workspaces SET
          subscription_tier = 'free',
          subscription_status = NULL,
          subscription_current_period_end = NULL,
          subscription_cancel_at_period_end = 0,
          tier_granted_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(ws.id);
    }

    // Audit every grant/revert: which admin set which tier on which workspace.
    // Consistent with set_developer_flag (admin-only surface, target email kept).
    logAudit({
      userId: req.adminUser.id,
      workspaceId: ws.id,
      eventType: 'admin_grant_tier',
      eventData: {
        target_user_id: user.id,
        target_email: user.email,
        tier,
        previous_tier: previousTier,
        set_by: req.adminUser.email,
      },
      req,
    });

    const text = tier === 'pro'
      ? `Pro access GRANTED to ${user.email}. Their workspace now has full Pro: 15 pages, daily monitoring, and all features.`
      : `Reverted ${user.email} to Free. Pro features no longer apply.`;
    res.type('html').send(reform({ type: 'ok', text }, email));
  });
}

module.exports = { registerAdminRoutes, isAdminEmail, getAdminEmails };
