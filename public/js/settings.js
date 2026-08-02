// Settings — Pattern 2 sidebar layout. A left vertical nav switches between three
// independent section panels (no long-scroll single page). Sections:
//   workspace · notifications · billing
// Per-user identity (name, password, voice profile), the integrations (calendar,
// Slack, alert webhooks), and the account danger zone all live on the separate
// Profile page (public/js/profile.js), NOT here.
//
// Each section is a real hash sub-route (#/settings/<section>) so deep links,
// browser back/forward, and the upgrade return redirect all work. The fetched
// data bundle is cached on Settings._ctx; tab switches re-render the active
// panel from cache (no skeleton flash), while a bare Settings.render() call
// (e.g. after a billing mutation) refetches fresh data and stays on the
// current section.

const Settings = {
  _ctx: null,            // cached { settings, user, ctxData, subData }
  _activeSection: 'workspace',

  SECTIONS: [
    { id: 'workspace',     label: 'Workspace',     icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/></svg>` },
    { id: 'notifications', label: 'Notifications',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>` },
    { id: 'billing',       label: 'Billing',        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>` },
  ],

  // Resolve which section to show from an explicit id, then from the upgrade
  // return param (so an old #/settings?upgraded=1 link lands on Billing), then
  // the last active section, then the workspace default.
  _resolveSection(section, routeQuery) {
    if (section) return section;
    if (routeQuery instanceof URLSearchParams && routeQuery.has('upgraded')) return 'billing';
    return Settings._activeSection || 'workspace';
  },

  async render(routeQuery, section) {
    const fromRouter = arguments.length > 0; // bare Settings.render() == mutation re-render
    const target = Settings._resolveSection(section, routeQuery);
    Settings._activeSection = target;

    const shellExists = !!document.getElementById('settings-shell');
    // Refetch when: no cache, mutation re-render, or we're (re)entering settings
    // fresh (no shell mounted).
    const needFetch = !Settings._ctx || !fromRouter || !shellExists;

    if (needFetch) {
      try {
        const [{ settings, user }, ctxData, subData] = await Promise.all([
          API.getSettings(),
          API.getUserContext().catch(() => null),
          API.getSubscription().catch(() => null),
        ]);
        Settings._ctx = { settings: settings || {}, user, ctxData, subData };
      } catch (e) {
        el('page-root').innerHTML = `
          <div class="empty-state">
            <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
            <div class="empty-title">Error loading settings</div>
            <div class="empty-desc">${esc(e.message)}</div>
          </div>`;
        return;
      }
    }

    el('page-root').innerHTML = Settings.shellHtml(Settings._ctx, target);
    Settings._wireDirty();
  },

  // Navigate to a section. Anchors already carry the href; this is the keyboard/
  // programmatic path and keeps the URL the single source of truth.
  go(section) { navigate('/settings/' + section); },

  // ── Shell: identity header + left nav + active panel ────────────────────────

  shellHtml(ctx, active) {
    const { user, subData } = ctx;
    const tier = (subData && subData.effectiveTier) || 'free';
    const tierLabel = { free: 'Free', pro: 'Pro', team: 'Team', business: 'Business' }[tier] || tier;
    const section = Settings.SECTIONS.find(x => x.id === active) || Settings.SECTIONS[0];

    const nav = Settings.SECTIONS.map(sx => {
      const on = sx.id === active;
      return `
        <a href="#/settings/${sx.id}" class="settings-nav__item ${on ? 'is-active' : ''}"
           data-section="${sx.id}" aria-current="${on ? 'page' : 'false'}">
          <span class="settings-nav__icon">${sx.icon}</span>
          <span class="settings-nav__label">${sx.label}</span>
        </a>`;
    }).join('');

    return `
      <div class="settings-page settings-page--split">
        <div class="settings-page-header">
          <div>
            <div class="settings-page-title">Settings</div>
            <div class="settings-page-subtitle">Workspace configuration, billing, and company context</div>
          </div>
          <div class="settings-identity">
            <span>${esc(user?.email || '')}</span>
            <span class="dot-sep">·</span>
            <span class="plan-badge plan-badge--${tier}">${tierLabel} Plan</span>
          </div>
        </div>
        <div class="settings-page-divider"></div>

        <div class="settings-shell" id="settings-shell">
          <nav class="settings-nav" aria-label="Settings sections">${nav}</nav>
          <div class="settings-panel" id="settings-panel" role="region" aria-label="${esc(section.label)} settings">
            <div class="settings-stack">${Settings.panelHtml(active, ctx)}</div>
          </div>
        </div>
      </div>`;
  },

  panelHtml(section, ctx) {
    const { settings: s, user, ctxData, subData } = ctx;
    const c = ctxData?.context || {};

    switch (section) {
      case 'workspace':
        return Settings.businessContextHtml(c);
      case 'notifications':
        return Settings.notificationsHtml(s, user?.email);
      case 'billing':
        return Settings.billingHtml(subData);
      default:
        return Settings.businessContextHtml(c);
    }
  },

  // ── Plan & billing (Phase 10) ───────────────────────────────────────────────

  billingHtml(sub) {
    const tier   = (sub && sub.effectiveTier) || 'free';
    const status = sub && sub.status;
    const cancel = sub && sub.cancelAtPeriodEnd;
    const periodEnd = sub && sub.currentPeriodEnd;
    const fmt = (d) => (d ? formatShortDate(d) : '-');
    const badgeTier = tier === 'business' ? 'team' : tier; // reuse team gradient
    const badge = `<span class="plan-badge plan-badge--${badgeTier}">${tier.charAt(0).toUpperCase() + tier.slice(1)}</span>`;

    let body;
    if (tier === 'free') {
      body = `
        <div class="set-plan-row">
          ${badge}
          <span class="set-plan-meta">1 page · manual checks</span>
          <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="Billing.subscribe(this)">Upgrade to Pro ($99/mo)</button>
        </div>
        <span class="form-hint">Unlock 15 monitored pages, daily monitoring, alerts, calendar briefings, outreach playbooks, and win/loss correlation.</span>`;
    } else if (status === 'past_due') {
      body = `
        <div class="set-plan-row">
          ${badge}
          <span class="set-plan-meta" style="color:var(--red)">Payment failed. Update your card to keep Pro.</span>
          <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="Billing.openPortal(this)">Update payment</button>
        </div>`;
    } else if (cancel) {
      body = `
        <div class="set-plan-row">
          ${badge}
          <span class="set-plan-meta">Your Pro access ends ${fmt(periodEnd)}.</span>
          <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="Billing.resume(this)">Resume subscription</button>
        </div>
        <span class="form-hint">You keep Pro until then. Resume any time to stay subscribed.</span>`;
    } else if (status === 'paused') {
      body = `
        <div class="set-plan-row">
          ${badge}
          <span class="set-plan-meta">Subscription paused.</span>
          <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="Billing.openPortal(this)">Manage</button>
        </div>`;
    } else {
      body = `
        <div class="set-plan-row">
          ${badge}
          <span class="set-plan-meta">Next billing ${fmt(periodEnd)}.</span>
          <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="Billing.openPortal(this)">Manage subscription</button>
        </div>
        <div style="display:flex">
          <button class="set-linkbtn set-linkbtn--danger" onclick="Billing.confirmCancel()">Cancel subscription</button>
        </div>`;
    }

    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Plan &amp; billing</div>
          <div class="set-card__desc">Your current plan and subscription. Billing and card details are handled securely by our payment processor.</div>
        </div>
        <div class="set-card__body">
          ${body}
          <div>
            <button class="set-linkbtn" style="padding-left:0" onclick="Billing.reconcile(this)">Subscription not showing correctly?</button>
          </div>
        </div>
      </div>`;
  },

  // ── Business context (Phase 6) — Workspace section ──────────────────────────

  businessContextHtml(c) {
    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Business context</div>
          <div class="set-card__desc">This data is fed into every brief so future analyses reflect your ICP, positioning, and deal size. Updates apply to future analyses only; past briefs will not be regenerated.</div>
        </div>
        <div class="set-card__body" data-dirty-group>
          <div class="form-group">
            <label class="form-label">Company name</label>
            <input class="form-input" id="ctx-company-name" maxlength="200"
              placeholder="What's your company called?" value="${esc(c.company_name || '')}" />
          </div>

          <div class="form-group">
            <label class="form-label">What we sell</label>
            <textarea class="form-input form-textarea" id="ctx-what-we-sell" rows="3" maxlength="5000"
              placeholder="Example: We sell project management software to mid-market engineering teams.">${esc(c.what_we_sell || '')}</textarea>
          </div>

          <div class="form-group">
            <label class="form-label">Target ICP</label>
            <textarea class="form-input form-textarea" id="ctx-target-icp" rows="3" maxlength="5000"
              placeholder="Example: Mid-market engineering teams of 50 to 500 people. The buyer is usually the VP of Engineering.">${esc(c.target_icp || '')}</textarea>
          </div>

          <div class="form-group">
            <label class="form-label">Our positioning</label>
            <textarea class="form-input form-textarea" id="ctx-our-positioning" rows="3" maxlength="5000"
              placeholder="Example: We win on reliability and lose on advanced filtering. Our main competitors are Linear and Asana.">${esc(c.our_positioning || '')}</textarea>
          </div>

          <div class="set-row-2">
            <div class="form-group">
              <label class="form-label">Typical deal size</label>
              <select class="form-input" id="ctx-deal-size">
                <option value=""           ${!c.typical_deal_size ? 'selected' : ''}>Select</option>
                <option value="small"      ${c.typical_deal_size === 'small' ? 'selected' : ''}>Small ($5K to $25K ACV)</option>
                <option value="mid"        ${c.typical_deal_size === 'mid' ? 'selected' : ''}>Mid-market ($25K to $100K ACV)</option>
                <option value="large"      ${c.typical_deal_size === 'large' ? 'selected' : ''}>Large ($100K+ ACV)</option>
                <option value="enterprise" ${c.typical_deal_size === 'enterprise' ? 'selected' : ''}>Enterprise ($250K+ ACV)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Sales motion</label>
              <select class="form-input" id="ctx-sales-motion">
                <option value=""       ${!c.sales_motion ? 'selected' : ''}>Select</option>
                <option value="plg"    ${c.sales_motion === 'plg' ? 'selected' : ''}>PLG (product-led / self-serve)</option>
                <option value="slg"    ${c.sales_motion === 'slg' ? 'selected' : ''}>SLG (sales-led)</option>
                <option value="hybrid" ${c.sales_motion === 'hybrid' ? 'selected' : ''}>Hybrid (PLG and SLG)</option>
              </select>
            </div>
          </div>

          <div class="set-card__footer">
            <button class="btn btn-primary btn-sm" data-save-btn onclick="Settings.saveContext(this)">Save changes</button>
          </div>
        </div>
      </div>
    `;
  },

  // ── Notifications — email + briefing prefs ──────────────────────────────────
  // The alert webhooks live on the Profile page (Integrations). This save only
  // writes the briefing prefs (briefings_enabled, briefing_lead_minutes); webhook
  // columns are omitted from the body so the server keeps them intact.

  notificationsHtml(s, accountEmail) {
    const emailAddr     = s.notification_email || accountEmail || '';
    const usingAccount  = !s.notification_email;
    const briefEmailOn  = (s?.brief_email_enabled ?? 1) === 1;
    const briefOn       = (s?.briefings_enabled ?? 1) === 1;
    const lead          = s?.briefing_lead_minutes ?? 30;

    const mailIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>`;
    const checkIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

    return `
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Notifications</div>
          <div class="set-card__desc">Where Nivaria delivers briefings and change alerts, and when.</div>
        </div>
        <div class="set-card__body" data-dirty-group>

          <!-- Brief notification email (delivery target + on/off) -->
          <div class="set-integration-block">
            <div class="set-integration">
              <div class="set-integration__icon">${mailIcon}</div>
              <div class="set-integration__text">
                <div class="set-integration__name">Brief notification email
                  ${briefEmailOn
                    ? `<span class="set-pill set-pill--active">${checkIcon} Active</span>`
                    : `<span class="set-pill set-pill--off">Off</span>`}
                </div>
                <div class="set-integration__meta">${emailAddr ? esc(emailAddr) : 'No address on file'}${usingAccount && emailAddr ? ' (your account email)' : ''}</div>
              </div>
            </div>
            <span class="form-hint">${briefEmailOn
              ? 'We email this address whenever a brief is generated for a tracked competitor.'
              : 'Brief emails are off. Turn them on below to get each brief in your inbox.'} Set a different address in <a href="#/profile" class="link-accent">Profile</a>, or leave it blank to use your account email. Add Slack or Discord webhooks in the <a href="#/profile/integrations" class="link-accent">Profile Integrations</a> tab.</span>
          </div>

          <!-- Brief email on/off -->
          <label class="set-switch-row" for="brief-email-enabled">
            <span class="set-switch-text">
              <span class="set-switch-label">Email me when a brief is generated</span>
              <span class="set-switch-help">Each time we detect a meaningful change for a tracked competitor, send the full brief to your notification address. Available on Pro.</span>
            </span>
            <input type="checkbox" role="switch" id="brief-email-enabled" class="set-switch"
              ${briefEmailOn ? 'checked' : ''} aria-label="Email me when a brief is generated" />
          </label>

          <!-- Pre-meeting briefing preferences -->
          <label class="set-switch-row" for="briefings-enabled">
            <span class="set-switch-text">
              <span class="set-switch-label">Send pre-meeting briefings</span>
              <span class="set-switch-help">When a meeting on your calendar mentions a tracked competitor, push a brief to your configured webhooks. Requires a connected calendar.</span>
            </span>
            <input type="checkbox" role="switch" id="briefings-enabled" class="set-switch"
              ${briefOn ? 'checked' : ''} aria-label="Send pre-meeting briefings" />
          </label>

          <div class="form-group">
            <label class="form-label" for="briefing-lead">Lead time</label>
            <select id="briefing-lead" class="form-input" style="max-width:220px">
              <option value="15" ${lead === 15 ? 'selected' : ''}>15 minutes before</option>
              <option value="30" ${lead === 30 ? 'selected' : ''}>30 minutes before</option>
              <option value="60" ${lead === 60 ? 'selected' : ''}>60 minutes before</option>
            </select>
          </div>

          <div class="set-card__footer">
            <span id="notif-save-feedback" class="set-feedback"></span>
            <button class="btn btn-primary btn-sm" data-save-btn onclick="Settings.saveNotifications(this)">Save changes</button>
          </div>
        </div>
      </div>
    `;
  },

  // ── Save handlers ───────────────────────────────────────────────────────────

  async saveContext(btn) {
    const payload = {
      company_name:      document.getElementById('ctx-company-name').value.trim(),
      what_we_sell:      document.getElementById('ctx-what-we-sell').value.trim(),
      target_icp:        document.getElementById('ctx-target-icp').value.trim(),
      our_positioning:   document.getElementById('ctx-our-positioning').value.trim(),
      typical_deal_size: document.getElementById('ctx-deal-size').value || null,
      sales_motion:      document.getElementById('ctx-sales-motion').value || null,
    };

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      await API.saveUserContext(payload);
      // The dashboard banner uses localStorage to gate visibility; a save
      // means the banner shouldn't reappear, so clear any prior dismissal.
      try { localStorage.removeItem('cs-ctx-banner-dismissed'); } catch (_) {}
      if (Settings._ctx) Settings._ctx.ctxData = { context: payload };
      btn.textContent = original;
      Settings._flashSaved(btn);
      toast('Business context saved. Applies to future analyses.', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      toast(e.message, 'error');
    }
  },

  async saveNotifications(btn) {
    const enabledEl    = document.getElementById('briefings-enabled');
    const leadEl       = document.getElementById('briefing-lead');
    const briefEmailEl = document.getElementById('brief-email-enabled');
    const feedback     = document.getElementById('notif-save-feedback');

    const setFeedback = (msg, isErr) => {
      if (!feedback) return;
      feedback.textContent = msg;
      feedback.style.color = isErr ? 'var(--red)' : 'var(--txt-3)';
    };

    // Only briefing prefs — webhooks live on the Profile page and are omitted
    // here so the partial-update-safe endpoint leaves them in place.
    const payload = {
      briefings_enabled:     enabledEl    ? (enabledEl.checked ? 1 : 0)    : undefined,
      briefing_lead_minutes: leadEl       ? parseInt(leadEl.value, 10)     : undefined,
      brief_email_enabled:   briefEmailEl ? (briefEmailEl.checked ? 1 : 0) : undefined,
    };

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    setFeedback('', false);
    try {
      await API.saveSettings(payload);
      if (Settings._ctx) {
        Settings._ctx.settings = { ...Settings._ctx.settings, briefings_enabled: payload.briefings_enabled, briefing_lead_minutes: payload.briefing_lead_minutes, brief_email_enabled: payload.brief_email_enabled };
      }
      btn.textContent = original;
      Settings._flashSaved(btn);
      toast('Notification settings saved', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      setFeedback(e.message, true);
      toast(e.message, 'error');
    }
  },

  // Save-success micro-interaction: swap the button to a check + "Saved" for
  // 1.5s, then restore. Save buttons stay disabled afterward (no pending
  // changes) until the user edits a field again (see _wireDirty). Shared with
  // the Profile page.
  _flashSaved(btn, label = 'Saved') {
    if (!btn) return;
    if (btn._restoreTimer) clearTimeout(btn._restoreTimer);
    if (btn.dataset.origHtml === undefined) btn.dataset.origHtml = btn.innerHTML;
    btn.classList.add('is-saved');
    btn.disabled = true;
    btn.innerHTML = `<span class="set-save-check"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span> ${label}`;
    btn._restoreTimer = setTimeout(() => {
      btn.classList.remove('is-saved');
      btn.innerHTML = btn.dataset.origHtml;
      btn.disabled = btn.hasAttribute('data-save-btn'); // clean = disabled until next edit
      delete btn.dataset.origHtml;
    }, 1500);
  },

  // Arm each card's Save button only when one of its fields changes, so a
  // pristine card shows a disabled (no-op) Save. Presentational only. Shared
  // with the Profile page.
  _wireDirty() {
    document.querySelectorAll('[data-dirty-group]').forEach(group => {
      const btn = group.querySelector('[data-save-btn]');
      if (!btn) return;
      // Start clean (disabled). A locked, free-tier webhook card has disabled
      // fields, so the :not([disabled]) selector below attaches no listeners and
      // its Save stays disabled — exactly the prior behavior.
      btn.disabled = true;
      const arm = () => { if (btn.disabled && !btn.classList.contains('is-saved')) btn.disabled = false; };
      group.querySelectorAll('input:not([disabled]), textarea:not([disabled]), select:not([disabled])').forEach(field => {
        field.addEventListener('input', arm);
        field.addEventListener('change', arm);
      });
    });
  },
};
window.Settings = Settings;
