// Phase 10 — client-side billing: checkout overlay, upgrade-gate modal,
// Team/Business waitlist modals, and GDPR account controls. Subscription state
// is owned by the server (webhook-driven); this file only triggers flows and
// renders responses.
//
// The payment provider is reached through exactly one function, startCheckout()
// below, so swapping providers later is a one-line change confined to it.

const X_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

// ── Checkout overlay ───────────────────────────────────────────────────────────
function initLemon() {
  if (window.__lemonInited) return;
  if (typeof window.createLemonSqueezy === 'function') window.createLemonSqueezy();
  if (window.LemonSqueezy && typeof window.LemonSqueezy.Setup === 'function') {
    window.LemonSqueezy.Setup({ eventHandler: onLemonEvent });
    window.__lemonInited = true;
  }
}

// ── Checkout entry point ───────────────────────────────────────────────────────
// The SINGLE place the app hands a paid plan to the payment provider. Everything
// that starts a purchase (pricing page, Settings, upgrade gate) calls this, so
// switching the provider later means rewriting only this function's body. Pro is
// the only purchasable plan today; Team and Business are waitlist-only and never
// reach here.
async function startCheckout(planId) {
  const plan = planId || 'pro';
  const { checkoutUrl } = await API.checkout(plan);
  if (!checkoutUrl) throw new Error('No checkout URL returned');
  initLemon();
  if (window.LemonSqueezy?.Url?.Open) {
    window.LemonSqueezy.Url.Open(checkoutUrl);
  } else {
    // Overlay script blocked or unavailable: fall back to a hosted checkout tab.
    window.open(checkoutUrl, '_blank', 'noopener');
  }
}
window.startCheckout = startCheckout;

// lemon.js emits e.g. { event: 'Checkout.Success', data: {...} } (older builds
// used 'PaymentSuccess'); match any success signal defensively.
function onLemonEvent(event) {
  const name = (event && (event.event || event.type)) || '';
  if (/success/i.test(name)) {
    try { sessionStorage.setItem('cs-welcome-pro', '1'); } catch (_) {}
    try { window.LemonSqueezy?.Url?.Close?.(); } catch (_) {}
    toast('Welcome to Pro! 🎉', 'success');
    // Safety net: if the subscription_created webhook hasn't flipped the
    // workspace to Pro within 5s, reconcile directly against the payment
    // provider so the user never sits in a "paid but shows Free" state.
    setTimeout(async () => {
      try {
        const s = await API.getSubscription();
        if (s.effectiveTier !== 'pro') { try { await API.reconcile(); } catch (_) {} }
      } catch (_) {}
    }, 5000);
    // Give the webhook a beat, then land on the dashboard (welcome banner).
    setTimeout(() => { navigate('/'); }, 900);
  }
}

const Billing = {
  // Open the Pro checkout. Used by the pricing page, Settings, and the
  // upgrade-gate modal. Delegates to the single startCheckout() choke point.
  async subscribe(btn) {
    const restore = btn ? startBtn(btn, 'Opening…') : null;
    try {
      await startCheckout('pro');
    } catch (e) {
      if (e.error !== 'upgrade_required') toast(e.message || 'Could not start checkout', 'error');
    } finally {
      restore && restore();
    }
  },

  async openPortal(btn) {
    const restore = btn ? startBtn(btn, 'Opening…') : null;
    try {
      const { portalUrl } = await API.billingPortal();
      if (!portalUrl) throw new Error('No portal URL');
      window.location.href = portalUrl;
    } catch (e) {
      toast(e.message || 'Could not open the billing portal', 'error');
      restore && restore();
    }
  },

  confirmCancel() {
    openModal(`
      <div class="modal-header"><div class="modal-title">Cancel Pro?</div>
        <button class="modal-close" onclick="closeModal()">${X_ICON}</button></div>
      <div class="modal-body"><p style="color:var(--txt-2);line-height:1.7">
        Your Pro features stay active until the end of the current billing period. You won't lose access immediately. You can resume any time before then.</p></div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Keep Pro</button>
        <button class="btn btn-danger" onclick="Billing.doCancel(this)">Cancel at period end</button>
      </div>`);
  },
  async doCancel(btn) {
    const restore = startBtn(btn, 'Cancelling…');
    try {
      await API.cancelSubscription();
      closeModal();
      toast('Cancellation scheduled. Pro stays active until your period ends.', 'success');
      if (window.Settings) Settings.render();
    } catch (e) { toast(e.message, 'error'); restore(); }
  },
  async resume(btn) {
    const restore = startBtn(btn, 'Resuming…');
    try {
      await API.resumeSubscription();
      toast('Subscription resumed.', 'success');
      if (window.Settings) Settings.render();
    } catch (e) { toast(e.message, 'error'); restore(); }
  },

  // ── Upgrade-gate modal (shown centrally on any 402 upgrade_required) ──────────
  upgradeFromGate() { closeModal(); Billing.subscribe(); },

  // Manual reconcile from Settings ("Subscription not showing correctly?").
  async reconcile(linkEl) {
    if (linkEl) linkEl.textContent = 'Checking…';
    try {
      const r = await API.reconcile();
      toast(r.reconciled ? 'Subscription synced.' : (r.message || 'Your subscription is already up to date.'),
        r.reconciled ? 'success' : 'info');
      if (window.Settings) Settings.render();
    } catch (e) {
      toast(e.message || 'Could not sync your subscription', 'error');
      if (linkEl) linkEl.textContent = 'Subscription not showing correctly?';
    }
  },

  // ── Waitlist (Team / Business) ────────────────────────────────────────────────
  openWaitlist(tier) {
    const isTeam = tier === 'team';
    const label = isTeam ? 'Team' : 'Business';
    const blurb = isTeam
      ? 'Team adds shared workspaces and multi-user seats. Launching soon. Waitlist members get 10% off their first 2 months. Leave your email and we’ll notify you first.'
      : 'Business adds advanced monitoring, API access and advanced webhook delivery, and priority support. Launching soon. Waitlist members get 10% off their first 2 months. Tell us about your use case and we’ll be in touch.';
    const field = isTeam
      ? `<div class="form-group">
           <label class="form-label" for="wl-size">Team size</label>
           <select class="form-input" id="wl-size">
             <option value="">Select…</option>
             <option value="3">1 to 5 people</option>
             <option value="10">6 to 15 people</option>
             <option value="30">16 to 50 people</option>
             <option value="75">50+ people</option>
           </select>
         </div>`
      : `<div class="form-group">
           <label class="form-label" for="wl-usecase">What would you use Nivaria for?</label>
           <textarea class="form-input form-textarea" id="wl-usecase" rows="4" maxlength="2000"
             placeholder="Industry, team size, special requirements."></textarea>
         </div>`;
    openModal(`
      <div class="modal-header"><div class="modal-title">Join the ${label} waitlist</div>
        <button class="modal-close" onclick="closeModal()">${X_ICON}</button></div>
      <div class="modal-body" id="wl-body">
        <p style="color:var(--txt-3);font-size:13px;line-height:1.6;margin-bottom:4px">${blurb}</p>
        <div class="form-group">
          <label class="form-label" for="wl-email">Email</label>
          <input class="form-input" id="wl-email" type="email" inputmode="email" autocomplete="email"
            placeholder="you@company.com" value="${esc(App.user?.email || '')}" />
        </div>
        ${field}
      </div>
      <div class="modal-footer" id="wl-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="Billing.submitWaitlist('${tier}', this)">Notify me</button>
      </div>`);
  },

  async submitWaitlist(tier, btn) {
    const email = (el('wl-email')?.value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Enter a valid email address', 'error');
    const payload = { email, tier };
    if (tier === 'team') {
      const v = el('wl-size')?.value;
      if (v) payload.teamSizeEstimate = parseInt(v, 10);
    } else {
      const uc = (el('wl-usecase')?.value || '').trim();
      if (uc) payload.useCase = uc;
    }
    const restore = startBtn(btn, 'Submitting…');
    try {
      const r = await API.joinWaitlist(payload);
      const label = tier === 'team' ? 'Team' : 'Business';
      const msg = r.alreadySignedUp
        ? `You’re already on the ${label} waitlist. We’ll be in touch.`
        : `You’re on the ${label} waitlist! We’ll email ${esc(email)} when it’s ready.`;
      el('wl-body').innerHTML = `
        <div class="wl-success">
          <div class="wl-success__icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div class="wl-success__text">${msg}</div>
        </div>`;
      const footer = el('wl-footer');
      if (footer) footer.innerHTML = `<button class="btn btn-primary" onclick="closeModal()">Done</button>`;
    } catch (e) {
      toast(e.message || 'Could not join the waitlist', 'error');
      restore();
    }
  },

  // ── GDPR ────────────────────────────────────────────────────────────────────
  exportData(btn) {
    toast('Preparing your data export…', 'info');
    // GET with the session cookie; Content-Disposition triggers the download.
    window.location.href = '/api/account/export';
  },

  confirmDeleteAccount() {
    const email = (window.App && App.user && App.user.email) || '';
    openModal(`
      <div class="modal-header"><div class="modal-title">Delete your Nivaria account?</div>
        <button class="modal-close" onclick="closeModal()">${X_ICON}</button></div>
      <div class="modal-body" id="del-body">
        <p style="color:var(--txt-2);line-height:1.6;margin-bottom:10px">This is <strong style="color:var(--red-2)">immediate and permanent</strong>. There is no recovery. The following are erased:</p>
        <ul class="del-list">
          <li>Your account and login credentials</li>
          <li>All competitors and briefs you've created</li>
          <li>Your workspace and all associated data</li>
          <li>Any active subscription (cancelled at the end of the current billing period)</li>
          <li>Calendar and Slack integrations</li>
        </ul>
        <div class="form-group">
          <label class="form-label" for="del-email">Type your email address to confirm</label>
          <input class="form-input" id="del-email" type="email" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${esc(email)}" oninput="Billing._syncDeleteBtn()" />
        </div>
        <div class="form-group">
          <label class="form-label" for="del-pw">Confirm your password</label>
          <input class="form-input" id="del-pw" type="password" autocomplete="current-password" placeholder="Your password" oninput="Billing._syncDeleteBtn()" />
          <span class="form-hint" id="del-err" style="color:var(--red)"></span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" id="del-confirm-btn" onclick="Billing.doDeleteAccount(this)" disabled>Delete Account Permanently</button>
      </div>`);
  },

  // The confirm button stays disabled until the typed email matches the account
  // email (case-insensitive) AND a password has been entered.
  _syncDeleteBtn() {
    const btn = el('del-confirm-btn');
    if (!btn) return;
    const accountEmail = ((window.App && App.user && App.user.email) || '').trim().toLowerCase();
    const typed = (el('del-email')?.value || '').trim().toLowerCase();
    const pw    = el('del-pw')?.value || '';
    btn.disabled = !(accountEmail && typed === accountEmail && pw.length > 0);
  },

  async doDeleteAccount(btn) {
    const confirmEmail = (el('del-email')?.value || '').trim();
    const pw = el('del-pw')?.value || '';
    const errEl = el('del-err');
    if (errEl) errEl.textContent = '';
    if (!confirmEmail || !pw) { if (errEl) errEl.textContent = 'Type your email and password to continue.'; return; }
    const restore = startBtn(btn, 'Deleting…');
    try {
      const r = await API.deleteAccount(pw, confirmEmail);
      el('del-body').innerHTML = `
        <div class="wl-success">
          <div class="wl-success__icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div class="wl-success__text">${esc(r.message || 'Your account has been permanently deleted.')}</div>
        </div>`;
      const f = btn.closest('.modal-footer');
      if (f) f.innerHTML = '';
      // The session is already destroyed server-side; land on the landing page.
      setTimeout(() => { window.location.href = (r && r.redirect) || '/'; }, 1400);
    } catch (e) {
      if (errEl) errEl.textContent = e.message || 'Could not process the request.';
      restore();
    }
  },
};
window.Billing = Billing;

// ── Tier-aware upgrade-gate content ───────────────────────────────────────────
// Pure map: a workspace's CURRENT tier → the modal that pitches the NEXT step up
// the ladder (Free→Pro purchase, Pro→Team waitlist, Team→Business waitlist,
// Business→contact). Kept as a plain object + pure resolver so the tier logic is
// unit-testable without a DOM (see test-upgrade-gate.js). is_developer users
// bypass every cap server-side, so this modal never renders for them.
const GATE_BY_TIER = {
  free: {
    title: 'Upgrade to Pro',
    desc: "You’ve reached your Free plan’s limit. Upgrade to Pro to monitor up to 15 pages with automatic daily monitoring.",
    features: [
      'Monitor up to 15 pages',
      'Group pages under each competitor',
      'Automatic daily monitoring',
      'Slack & Discord alerts',
      'Calendar briefings',
      'AI outreach playbooks',
      'Win/loss correlation',
    ],
    price: '$99/month',
    cta: { label: 'Upgrade ($99/month)', onclick: 'Billing.upgradeFromGate()' },
  },
  pro: {
    title: 'Join the Team Waitlist',
    desc: "You’ve reached your Pro plan’s page limit. Join the Team waitlist to be notified when team features launch.",
    features: [
      'A higher page volume with automatic monitoring',
      'Multi-user workspace with shared competitive intelligence',
      "Outreach drafts in each team member's own voice",
      'Role permissions and team collaboration',
      'Everything in Pro',
    ],
    price: '$299/month (waitlist)',
    cta: { label: 'Join Waitlist', onclick: "Billing.openWaitlist('team')" },
  },
  team: {
    title: 'Join the Business Waitlist',
    desc: "You’ve reached your Team plan’s limit. Join the Business waitlist for protected-site monitoring and priority support.",
    features: [
      "Monitor the competitors others can't: bot-protected sites fully covered",
      'Monitor your entire competitive landscape',
      'Hourly monitoring',
      'API access and advanced webhook delivery',
      '24-month change history',
      'Priority support',
      'Everything in Team',
    ],
    price: '$999/month (waitlist)',
    cta: { label: 'Join Waitlist', onclick: "Billing.openWaitlist('business')" },
  },
  business: {
    title: 'Contact Us About Enterprise',
    desc: "You’re on our highest tier. For larger needs, please contact us about enterprise options.",
    features: [],
    price: null,
    cta: { label: 'Contact us', href: 'mailto:support@nivaria.app' },
  },
};

// Resolve a tier string to its gate config. Unknown/missing tiers fall back to
// the Free pitch (safest default — points to the only purchasable tier).
function gateConfigForTier(tier) {
  return GATE_BY_TIER[tier] || GATE_BY_TIER.free;
}
window.gateConfigForTier = gateConfigForTier;

// Central upgrade-gate modal — invoked by api.js on any 402 upgrade_required.
// Tier-aware: a Pro user who hits the 15-page cap sees the Team waitlist,
// not a nonsensical "Upgrade to Pro".
function showUpgradeModal(info) {
  // Authoritative tier is workspace-driven (App.subscription.effectiveTier), not
  // the deprecated App.user.tier.
  const tier = (window.App && App.subscription && App.subscription.effectiveTier) || 'free';
  const cfg = gateConfigForTier(tier);

  // Free gates are feature-specific (webhooks, calendar, playbooks, …) and the
  // backend message correctly points to Pro, so prefer it. For paid tiers the
  // backend message wrongly says "upgrade to Pro" (the reported bug), so we use
  // the tier-aware copy instead.
  const desc = (tier === 'free' && info && info.message) ? info.message : cfg.desc;

  const features = cfg.features.length
    ? `<ul class="upgrade-list">${cfg.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`
    : '';
  const price = cfg.price
    ? `<p style="margin-top:14px;color:var(--txt-2);font-size:13px;font-weight:600">${esc(cfg.price)}</p>`
    : '';
  const cta = cfg.cta.href
    ? `<a class="btn btn-primary" href="${cfg.cta.href}">${esc(cfg.cta.label)}</a>`
    : `<button class="btn btn-primary" onclick="${cfg.cta.onclick}">${esc(cfg.cta.label)}</button>`;

  openModal(`
    <div class="modal-header"><div class="modal-title">${esc(cfg.title)}</div>
      <button class="modal-close" onclick="closeModal()">${X_ICON}</button></div>
    <div class="modal-body">
      <p style="color:var(--txt);font-size:14.5px;font-weight:600;margin-bottom:10px">${esc(desc)}</p>
      ${features}
      ${price}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Maybe later</button>
      ${cta}
    </div>`);
}
window.showUpgradeModal = showUpgradeModal;

// Small helper: disable a button + show a transient label, returning a restore fn.
function startBtn(btn, label) {
  if (!btn) return () => {};
  const orig = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = label;
  return () => { btn.disabled = wasDisabled; btn.innerHTML = orig; };
}
window.startBtn = startBtn;
