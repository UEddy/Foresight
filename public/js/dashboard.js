const Dashboard = {
  async render() {
    try {
      const [stats, changesData, competitors, ctxData, meetingsData, playbookData, roiSummary] = await Promise.all([
        API.getStats(),
        API.getChanges({ limit: 6 }),
        API.getCompetitors(),
        API.getUserContext().catch(() => null), // never block dashboard on context fetch
        API.getUpcomingMeetings().catch(() => ({ meetings: [] })), // never block dashboard on calendar
        API.getRecentPlaybooks(5).catch(() => ({ playbooks: [] })),
        API.getRoiSummary().catch(() => null), // never block dashboard on ROI
      ]);
      App.stats = stats;
      App.updateBadges();
      el('page-root').innerHTML = Dashboard.html(stats, changesData.changes, competitors, ctxData, meetingsData, playbookData, roiSummary);
      Dashboard.animateStats(stats);
      window.staggerIn?.('.feed-item', 80, 70);
      window.staggerIn?.('.competitor-mini', 120, 55);
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <div class="empty-title">Could not load dashboard</div>
          <div class="empty-desc">${esc(e.message)}</div>
        </div>`;
    }
  },

  // ── Time-aware greeting ─────────────────────────────────────────────────────
  // Greets the user by name, banded by the local time in THEIR timezone. A
  // first-ever dashboard visit gets a "welcome" variant; every later session
  // gets a returning-user pool (which includes "welcome back"). The chosen
  // greeting is picked once per browser session and cached in sessionStorage so
  // it stays stable across in-app navigation (doesn't re-roll on every render).
  GREETING_KEY: 'cs-greeting',

  greetingPools(name) {
    const n = name ? `, ${name}` : '';
    return {
      welcome:   [`Welcome${n}`, `Welcome to Nivaria${n}`, `Glad you're here${n}`],
      morning:   [`Good morning${n}`, `Morning${n}`, `Hello${n}`, `Welcome back${n}`, `Good to see you${n}`],
      afternoon: [`Good afternoon${n}`, `Hello${n}`, `Welcome back${n}`, `Hey${n}`],
      evening:   [`Good evening${n}`, `Hello${n}`, `Welcome back${n}`, `Hey${n}`],
      night:     [`Hello${n}`, `Welcome back${n}`, `Hey${n}`],
    };
  },

  // Map the current hour in the user's timezone to a time band.
  //   Morning 05:00–11:59 · Afternoon 12:00–16:59 · Evening 17:00–20:59 · Night 21:00–04:59
  greetingBand(tz) {
    let hour;
    try {
      hour = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()), 10);
    } catch (_) {
      hour = new Date().getHours(); // invalid tz — fall back to device-local time
    }
    if (!Number.isFinite(hour)) hour = new Date().getHours();
    if (hour === 24) hour = 0; // some engines render midnight as "24" under hour12:false
    if (hour >= 5  && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  },

  resolveGreeting() {
    try {
      const cached = sessionStorage.getItem(Dashboard.GREETING_KEY);
      if (cached) return cached;
    } catch (_) { /* sessionStorage unavailable — recompute each render */ }

    const u = App.user || {};
    const name = (u.first_name || '').trim();
    const firstTime = !u.has_visited_dashboard;
    const pools = Dashboard.greetingPools(name);
    const pool = firstTime ? pools.welcome : pools[Dashboard.greetingBand(u.timezone || 'UTC')];
    const greeting = pool[Math.floor(Math.random() * pool.length)];

    try { sessionStorage.setItem(Dashboard.GREETING_KEY, greeting); } catch (_) {}

    if (firstTime) {
      // Optimistically flip locally so a same-session re-render is "returning",
      // and persist server-side for future sessions (best-effort).
      u.has_visited_dashboard = 1;
      try { API.markDashboardVisited().catch(() => {}); } catch (_) {}
    }
    return greeting;
  },

  greetingHtml() {
    return `<div class="dash-greeting">${esc(Dashboard.resolveGreeting())}</div>`;
  },

  // Phase 6: soft, dismissible banner that nudges users who haven't filled in
  // their business context. Reappears every 14 days. Stored in localStorage
  // — never sent to the server.
  CTX_BANNER_KEY: 'cs-ctx-banner-dismissed',
  CTX_BANNER_REAPPEAR_MS: 14 * 24 * 60 * 60 * 1000,

  contextBannerHtml(ctxData) {
    if (!ctxData) return ''; // fetch failed; stay silent
    if (ctxData.exists) {
      // Treat fully-empty rows the same as missing — same semantics as
      // hasMeaningfulContext on the server.
      const c = ctxData.context || {};
      const anyText = ['company_name','what_we_sell','target_icp','our_positioning'].some(k => c[k] && String(c[k]).trim());
      const anyEnum = !!(c.typical_deal_size || c.sales_motion);
      if (anyText || anyEnum) return '';
    }

    // Dismissed within the last 14 days? Stay hidden.
    try {
      const ts = parseInt(localStorage.getItem(Dashboard.CTX_BANNER_KEY) || '0', 10);
      if (ts && (Date.now() - ts) < Dashboard.CTX_BANNER_REAPPEAR_MS) return '';
    } catch (_) { /* localStorage unavailable — show banner */ }

    return `
      <div class="ctx-banner" id="ctx-banner">
        <span class="ctx-banner-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
        </span>
        <span class="ctx-banner-text">
          <strong>Add your business context</strong> to get sharper competitor analysis tailored to your ICP, positioning, and deal size.
        </span>
        <span class="ctx-banner-actions">
          <a href="#/onboarding" class="btn btn-primary btn-sm">Add now</a>
          <button class="btn btn-ghost btn-sm" onclick="Dashboard.dismissContextBanner()" title="Dismiss for 14 days">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>
      </div>
    `;
  },

  dismissContextBanner() {
    try { localStorage.setItem(Dashboard.CTX_BANNER_KEY, String(Date.now())); } catch (_) {}
    const node = document.getElementById('ctx-banner');
    if (node) node.remove();
  },

  // One-time, dismissible nudge for accounts that pre-date the signup name field
  // (first_name empty). Lets them add a name so greetings get personal. Unlike
  // the context banner this does NOT reappear once dismissed — it's a one-off.
  NAME_PROMPT_KEY: 'cs-name-prompt-dismissed',

  namePromptHtml() {
    const name = (App.user?.first_name || '').trim();
    if (name) return ''; // already have a name — nothing to prompt
    try { if (localStorage.getItem(Dashboard.NAME_PROMPT_KEY)) return ''; } catch (_) {}

    return `
      <div class="ctx-banner" id="name-prompt">
        <span class="ctx-banner-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </span>
        <span class="ctx-banner-text">
          <strong>What should we call you?</strong> Add your name so Nivaria can greet you properly.
        </span>
        <span class="ctx-banner-actions">
          <a href="#/profile" class="btn btn-primary btn-sm">Add name</a>
          <button class="btn btn-ghost btn-sm" onclick="Dashboard.dismissNamePrompt()" title="Dismiss">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>
      </div>`;
  },

  dismissNamePrompt() {
    try { localStorage.setItem(Dashboard.NAME_PROMPT_KEY, '1'); } catch (_) {}
    const node = document.getElementById('name-prompt');
    if (node) node.remove();
  },

  // Phase 7 — upcoming competitor-relevant meetings. Stays hidden when the
  // user hasn't connected a calendar (the meetings array is empty AND we don't
  // want to advertise the feature on the dashboard — that's the Settings card's
  // job). Once they connect, we show up to 5 next meetings with matches first.
  upcomingMeetingsHtml(meetingsData, competitors) {
    const meetings = meetingsData?.meetings || [];
    if (meetings.length === 0) return '';

    const matched = meetings.filter(m => m.matched_competitor_id);
    const unmatched = meetings.filter(m => !m.matched_competitor_id);
    const visible = [...matched, ...unmatched].slice(0, 5);
    if (visible.length === 0) return '';

    const compOptions = (competitors || []).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

    return `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <div>
            <div class="card-title">Upcoming competitor-relevant meetings</div>
            <div class="card-sub">Next ${visible.length} on your calendar · briefings fire ~30 min before</div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px">
          ${visible.map(m => {
            const when  = new Date(m.start_time);
            const whenStr = when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
            const matchBadge = m.matched_competitor_id
              ? `<span class="pattern-tag pattern-tag-sm" style="background:rgba(99,102,241,0.15);color:var(--accent)">${esc(m.competitor_name)} · ${esc(m.match_reason)}</span>`
              : `<span class="pattern-tag pattern-tag-sm" style="background:var(--bg-hover);color:var(--txt-3)">unmatched</span>`;
            const statusBadge = m.matched_competitor_id
              ? `<span class="text-sm" style="color:${m.briefing_status === 'sent' ? 'var(--green)' : m.briefing_status === 'failed' ? 'var(--red)' : 'var(--txt-3)'}">${esc(m.briefing_status)}</span>`
              : '';

            return `
              <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px">
                <div style="flex:1;min-width:0">
                  <div style="font-weight:500">${esc(m.title || '(untitled)')}</div>
                  <div class="text-muted text-sm">${esc(whenStr)} · ${matchBadge}</div>
                </div>
                ${statusBadge}
                ${!m.matched_competitor_id ? `
                  <select id="tag-meeting-${m.id}" class="form-input" style="max-width:180px;font-size:12px;padding:6px 34px 6px 8px">
                    <option value="">Tag manually…</option>
                    ${compOptions}
                  </select>
                  <button class="btn btn-ghost btn-sm" onclick="Dashboard.tagMeeting(${m.id})">Tag</button>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  },

  async tagMeeting(meetingId) {
    const sel = document.getElementById(`tag-meeting-${meetingId}`);
    const competitorId = parseInt(sel?.value, 10);
    if (!Number.isInteger(competitorId)) {
      toast('Pick a competitor first', 'error'); return;
    }
    try {
      await API.tagMeeting(meetingId, competitorId);
      toast('Meeting tagged. Briefing queued.', 'success');
      Dashboard.render();
    } catch (e) { toast(e.message, 'error'); }
  },

  animateStats(stats) {
    const score = stats.total_competitors > 0
      ? Math.min(100, Math.round((stats.total_changes / Math.max(1, stats.total_competitors)) * 12 + stats.active_competitors * 8))
      : 0;

    const targets = {
      'stat-val-competitors': stats.competitor_count ?? stats.total_competitors,
      'stat-val-changes': stats.changes_this_week,
      'stat-val-threats': stats.high_threats,
      'stat-val-score': score,
    };

    Object.entries(targets).forEach(([id, target]) => {
      const node = document.getElementById(id);
      if (node) animateCounter(node, target, 900);
    });
  },

  // Phase 8 — "Recent outreach generated" widget. Stays hidden until the user
  // has at least one generated playbook (otherwise it's just noise during
  // onboarding).
  recentPlaybooksHtml(playbookData) {
    const playbooks = playbookData?.playbooks || [];
    if (playbooks.length === 0) return '';

    const typeLabels = {
      slack_to_team:     'Slack to team',
      email_to_prospect: 'Email to prospect',
      followup_email:    'Follow-up email',
    };

    return `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <div>
            <div class="card-title">Recent outreach generated</div>
            <div class="card-sub">AI-drafted messages waiting for you to send · click to jump to the brief</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${playbooks.map(p => `
            <div class="playbook-row" onclick="navigate('/history/${p.change_id}')" style="cursor:pointer">
              <div class="playbook-row-pip ${p.threat_level || 'low'}"></div>
              <div class="playbook-row-body">
                <div class="playbook-row-headline">${esc(p.change_headline || 'Change detected')}</div>
                <div class="playbook-row-meta">
                  <span>${esc(p.competitor_name)}</span>
                  <span class="feed-dot-sep">·</span>
                  <span class="playbook-row-type">${esc(typeLabels[p.message_type] || p.message_type)}</span>
                  ${p.subject_line ? `<span class="feed-dot-sep">·</span><span class="playbook-row-subject">"${esc(p.subject_line.slice(0, 60))}${p.subject_line.length > 60 ? '…' : ''}"</span>` : ''}
                  <span class="feed-dot-sep">·</span>
                  <span>${timeAgo(p.generated_at)}</span>
                </div>
              </div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--txt-3);flex-shrink:0"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  },

  // Phase 9 — small ROI widget. Hidden until the user has logged a deal, so it
  // doesn't add noise during onboarding. Shows the headline revenue-at-risk
  // figure when medium+ patterns exist, otherwise nudges toward more logging.
  roiWidgetHtml(roiSummary) {
    if (!roiSummary || !roiSummary.total_deals) return '';
    const fmtBig = (n) => {
      n = Number(n || 0);
      if (n >= 1e6) return '$' + (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
      if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
      return '$' + n;
    };
    const hasFigure = roiSummary.strong_pattern_count > 0 && roiSummary.revenue_at_risk_usd > 0;
    return `
      <div class="card" style="margin-bottom:24px">
        <div class="roi-widget">
          <div>
            <div class="hero-stat-label" style="margin-bottom:6px">Revenue at risk from competitors</div>
            <div class="roi-widget-figure">${hasFigure ? fmtBig(roiSummary.revenue_at_risk_usd) : '-'}</div>
          </div>
          <div class="roi-widget-body">
            <div class="text-muted text-sm">
              ${hasFigure
                ? `Across ${roiSummary.strong_pattern_count} medium or higher confidence pattern${roiSummary.strong_pattern_count === 1 ? '' : 's'} from ${roiSummary.total_deals} logged deals.`
                : `${roiSummary.total_deals} deal${roiSummary.total_deals === 1 ? '' : 's'} logged. Keep logging losses tagged to competitors to surface revenue patterns.`}
            </div>
          </div>
          <a href="#/deals?tab=roi" class="section-link">Open ROI</a>
        </div>
      </div>`;
  },

  html(stats, changes, competitors, ctxData, meetingsData, playbookData, roiSummary) {
    const score = stats.total_competitors > 0
      ? Math.min(100, Math.round((stats.total_changes / Math.max(1, stats.total_competitors)) * 12 + stats.active_competitors * 8))
      : 0;

    // The billable unit is a PAGE. The page cap comes from the server
    // (stats.max_pages), derived from the workspace's authoritative effective
    // tier (getWorkspaceTier), NOT the deprecated App.user.tier. -1 means
    // unlimited; null means a not-yet-configured (TODO) tier cap (team/business),
    // also shown as no enforced cap. If the field is somehow absent (stale cached
    // stats), fall back to the same app-wide effectiveTier the sidebar/Settings
    // use rather than the most restrictive Free cap of 1. Mirrors server
    // TIER_LIMITS page caps (team/business intentionally uncapped-for-now).
    const CAP_BY_TIER = { free: 1, pro: 15, team: -1, business: -1 };
    const pagesUsed = stats.pages_used ?? stats.total_competitors ?? 0;
    const rawCap = (stats.max_pages !== undefined && stats.max_pages !== null)
      ? stats.max_pages
      : (CAP_BY_TIER[App.subscription?.effectiveTier] ?? CAP_BY_TIER.free);
    const slotMax = (rawCap === -1 || rawCap === null) ? null : rawCap;
    const slotPct = slotMax ? Math.min(100, (pagesUsed / slotMax) * 100) : 20;
    const slotWarn = slotMax && pagesUsed / slotMax > 0.8;

    return `
      ${Dashboard.greetingHtml()}
      ${Dashboard.namePromptHtml()}
      ${Dashboard.contextBannerHtml(ctxData)}
      <!-- Hero Stats -->
      <div class="hero-stats">
        <div class="hero-stat stat-indigo">
          <div class="hero-stat-label">Competitors Tracked</div>
          <div class="hero-stat-value" id="stat-val-competitors">0</div>
          <div class="hero-stat-sub">${stats.active_competitors} active right now</div>
        </div>
        <div class="hero-stat stat-cyan">
          <div class="hero-stat-label">Changes This Week</div>
          <div class="hero-stat-value" id="stat-val-changes">0</div>
          <div class="hero-stat-sub">${stats.total_changes} total detected</div>
        </div>
        <div class="hero-stat stat-red">
          <div class="hero-stat-label">High Threat Alerts</div>
          <div class="hero-stat-value" id="stat-val-threats">0</div>
          <div class="hero-stat-sub">${stats.medium_threats} medium priority</div>
        </div>
        <div class="hero-stat stat-green">
          <div class="hero-stat-label">Intelligence Score</div>
          <div class="hero-stat-value" id="stat-val-score">0</div>
          <div class="hero-stat-sub">out of 100 possible</div>
        </div>
      </div>

      ${stats.high_threats > 0 ? `
        <div class="alert-banner">
          <div class="alert-banner-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <div>
            <div class="alert-banner-title">${stats.high_threats} high-threat change${stats.high_threats > 1 ? 's' : ''} require attention</div>
            <div class="alert-banner-sub">Review the latest changes and prepare your sales team response</div>
          </div>
          <a href="#/history?threat=high" class="btn btn-danger btn-sm" style="margin-left:auto;flex-shrink:0">Review Now</a>
        </div>
      ` : ''}

      <!-- Radar / Monitoring Status -->
      <div class="radar-widget" data-tour="monitoring">
        <div class="radar-visual">
          <div class="radar-ring"></div>
          <div class="radar-ring"></div>
          <div class="radar-ring"></div>
          <div class="radar-core"></div>
        </div>
        <div class="radar-body">
          <div class="radar-label">Intelligence Radar</div>
          <div class="radar-status">
            ${stats.active_competitors > 0
              ? `Actively monitoring ${stats.active_competitors} competitor${stats.active_competitors !== 1 ? 's' : ''}`
              : 'No competitors being monitored'
            }
          </div>
          <div class="radar-meta">
            ${stats.total_changes === 0 && stats.baselined_pages > 0
              ? `Baseline captured for ${stats.baselined_pages} page${stats.baselined_pages !== 1 ? 's' : ''}. Watching for changes against it.`
              : `${stats.total_changes} change${stats.total_changes !== 1 ? 's' : ''} detected all-time
                 · ${stats.changes_this_week} this week`
            }
          </div>
        </div>
        <div class="radar-next">09:00 daily</div>
      </div>

      ${Dashboard.roiWidgetHtml(roiSummary)}

      ${Dashboard.upcomingMeetingsHtml(meetingsData, competitors)}

      ${Dashboard.recentPlaybooksHtml(playbookData)}

      <!-- Main grid -->
      <div class="dashboard-grid">

        <!-- Recent Changes -->
        <div class="card" data-tour="briefs">
          <div class="card-header">
            <div>
              <div class="card-title">Recent Changes</div>
              <div class="card-sub">Latest competitor intelligence</div>
            </div>
            <a href="#/history" class="section-link">View all</a>
          </div>
          ${changes.length === 0
            ? `<div class="empty-state" style="padding:40px 0">
                <div class="empty-icon">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                </div>
                <div class="empty-title">No changes detected yet</div>
                <div class="empty-desc">Add competitors and run your first check to see intelligence here.</div>
                <a href="#/competitors" class="btn btn-primary btn-sm">Add Competitor</a>
               </div>`
            : changes.map(c => `
                <div class="feed-item ${c.is_baseline === 1 ? 'feed-item--baseline' : ''}" onclick="navigate('/history/${c.id}')" style="cursor:pointer">
                  <div class="feed-pip ${c.is_baseline === 1 ? 'baseline' : (c.threat_level || 'low')}"></div>
                  <div class="feed-body">
                    ${c.is_baseline === 1 ? `
                      <div class="feed-headline">Monitoring started, baseline captured</div>
                      <div class="feed-meta">
                        <span>${esc(c.competitor_name)}</span>
                        <span class="feed-dot-sep">·</span>
                        <span>Snapshot taken ${formatShortDate(c.detected_at)}</span>
                        <span class="badge badge-baseline">BASELINE</span>
                      </div>
                    ` : `
                      <div class="feed-headline">${esc(c.headline || 'Change detected')}</div>
                      <div class="feed-meta">
                        <span>${esc(c.competitor_name)}</span>
                        <span class="feed-dot-sep">·</span>
                        <span>${timeAgo(c.detected_at)}</span>
                        ${threatBadge(c.threat_level)}
                      </div>
                    `}
                  </div>
                  <a class="feed-link" href="#/history/${c.id}" onclick="event.stopPropagation()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                  </a>
                </div>
              `).join('')
          }
        </div>

        <!-- Active Competitors -->
        <div class="card" data-tour="add-competitor">
          <div class="card-header">
            <div>
              <div class="card-title">Active Competitors</div>
              <div class="card-sub">${competitors.filter(c => c.active).length} being monitored</div>
            </div>
            <a href="#/competitors" class="section-link">Manage</a>
          </div>
          ${competitors.length === 0
            ? `<div class="empty-state" style="padding:32px 0">
                <div class="empty-icon">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <div class="empty-title">No competitors yet</div>
                <div class="empty-desc">Add your first competitor to start receiving AI briefs.</div>
                <a href="#/competitors" class="btn btn-primary btn-sm">Add First</a>
               </div>`
            : competitors.slice(0, 8).map(c => `
                <div class="competitor-mini">
                  ${avatarHtml(c.name, 34)}
                  <div class="comp-mini-body">
                    <div class="comp-mini-name">${esc(c.name)}</div>
                    <div class="comp-mini-url">${esc(c.url.replace(/^https?:\/\//, '').substring(0, 40))}${c.url.length > 46 ? '…' : ''}</div>
                  </div>
                  <div class="comp-mini-right">
                    ${c.last_threat ? threatBadge(c.last_threat) : ''}
                    <span class="comp-mini-status ${c.active ? 'status-active' : 'status-paused'}">${c.active ? 'Active' : 'Paused'}</span>
                  </div>
                </div>
              `).join('')
          }
          ${competitors.length > 0 ? `
            <div class="usage-wrap">
              <div class="usage-label">
                <span>Pages monitored</span>
                <span>${pagesUsed} / ${slotMax === null ? '∞' : slotMax}</span>
              </div>
              <div class="usage-bar">
                <div class="usage-fill ${slotWarn ? 'warn' : ''}" style="width:${slotPct}%"></div>
              </div>
            </div>
          ` : ''}
        </div>

      </div>
    `;
  },
};
window.Dashboard = Dashboard;
