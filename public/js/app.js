// ─── Skeleton Templates ────────────────────────────────────────────────────────
const Skeleton = {
  dashboard: () => `
    <div class="skel-wrap">
      <div class="skel-stats">
        <div class="skeleton skel-stat"></div>
        <div class="skeleton skel-stat"></div>
        <div class="skeleton skel-stat"></div>
        <div class="skeleton skel-stat"></div>
      </div>
      <div class="skel-grid">
        <div class="skeleton skel-card-a"></div>
        <div class="skeleton skel-card-b"></div>
      </div>
    </div>`,
  table: () => `
    <div class="skel-wrap">
      <div class="skeleton skel-hdr"></div>
      <div class="skeleton skel-full"></div>
    </div>`,
  cards: (n = 4) => `
    <div class="skel-wrap">
      <div class="skeleton skel-hdr"></div>
      <div class="skel-rows">${Array(n).fill('<div class="skeleton skel-row"></div>').join('')}</div>
    </div>`,
};

// ─── Theme System ──────────────────────────────────────────────────────────────

const Theme = {
  key: 'cs-theme',

  init() {
    const saved = localStorage.getItem(Theme.key) || 'dark';
    Theme.apply(saved);
    Theme.wireBtns();

    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if ((localStorage.getItem(Theme.key) || 'dark') === 'system') Theme.apply('system');
    });
  },

  apply(val) {
    const root = document.documentElement;
    if (val === 'system') {
      root.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    } else {
      root.setAttribute('data-theme', val);
    }
    localStorage.setItem(Theme.key, val);
    Theme.wireBtns();
  },

  wireBtns() {
    const saved = localStorage.getItem(Theme.key) || 'dark';
    document.querySelectorAll('.theme-btn').forEach(btn => {
      const on = btn.dataset.val === saved;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  },
};

document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => Theme.apply(btn.dataset.val));
});

// ─── Avatar utility ────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  ['#6366F1','#4F46E5'], ['#06B6D4','#0891B2'], ['#10B981','#059669'],
  ['#F59E0B','#D97706'], ['#EF4444','#DC2626'], ['#A855F7','#9333EA'],
  ['#EC4899','#DB2777'], ['#14B8A6','#0D9488'],
];

function avatarHtml(name, size = 36) {
  const initials = (name || '?').trim().split(/\s+/).map(w => w[0]).join('').substring(0, 2).toUpperCase();
  const idx = [...(name || 'A')].reduce((acc, c) => acc + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
  const [from, to] = AVATAR_COLORS[idx];
  return `<div class="comp-avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px;background:linear-gradient(135deg,${from},${to})">${initials}</div>`;
}

// ─── Animated counter ─────────────────────────────────────────────────────────

function animateCounter(element, target, duration = 900) {
  const start = performance.now();
  const isFloat = target % 1 !== 0;
  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(target * ease);
    element.textContent = isFloat ? current.toFixed(0) : current;
    if (progress < 1) requestAnimationFrame(tick);
    else element.textContent = isFloat ? target.toFixed(0) : target;
  }
  requestAnimationFrame(tick);
}

// ─── Focus management helpers (Phase I) ──────────────────────────────────────
// Shared by the drawer and the modal. A "focus trap" keeps Tab / Shift+Tab
// cycling inside an open overlay so keyboard and external-keyboard-on-tablet
// users can't tab out to the page behind it. Callers restore focus to the
// triggering element themselves on close.
const FOCUSABLE_SEL =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(container) {
  if (!container) return [];
  // Visible only — a display:none / off-canvas element can't take focus, and a
  // hidden first item would otherwise swallow the initial focus() call.
  return Array.from(container.querySelectorAll(FOCUSABLE_SEL))
    .filter(elm => elm.offsetWidth > 0 || elm.offsetHeight > 0 || elm === document.activeElement);
}

// Call from a keydown handler when the overlay is open. Wraps focus at both ends
// and pulls focus back inside if it has somehow escaped the container.
function trapTab(e, container) {
  if (e.key !== 'Tab' || !container) return;
  const items = focusableWithin(container);
  if (!items.length) return;
  const first = items[0];
  const last  = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !container.contains(active)) { e.preventDefault(); last.focus(); }
  } else {
    if (active === last || !container.contains(active)) { e.preventDefault(); first.focus(); }
  }
}

// ─── Mobile drawer (Phase B) ─────────────────────────────────────────────────
// Builds on the existing #sidebar + #menu-toggle markup. Layers on every close
// path the audit found missing: tap toggle, tap scrim, X button, Escape key,
// swipe-left gesture, route change (hashchange), and resize past the tablet
// breakpoint. Owns the ARIA state (aria-expanded on toggle, aria-modal on the
// open drawer, aria-hidden on the closed sidebar so screen readers don't
// announce a phantom landmark), and remembers/restores focus around open/close.
// At 768px+ the sidebar is permanent and every Drawer method silently no-ops.
const Drawer = {
  _lastTrigger: null,
  _scrollY: 0,

  isMobile() { return window.matchMedia('(max-width: 767px)').matches; },
  isOpen()   { return document.getElementById('sidebar')?.classList.contains('open'); },

  // Background scroll lock. overflow:hidden alone leaks on iOS Safari, so we pin
  // the body with position:fixed and offset it by the current scroll position
  // (the CSS reads --drawer-scroll-lock for `top`). Restored exactly on unlock.
  _lockScroll() {
    Drawer._scrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.setProperty('--drawer-scroll-lock', `-${Drawer._scrollY}px`);
    document.body.classList.add('drawer-open');
  },
  _unlockScroll() {
    if (!document.body.classList.contains('drawer-open')) return;
    document.body.classList.remove('drawer-open');
    document.body.style.removeProperty('--drawer-scroll-lock');
    window.scrollTo(0, Drawer._scrollY);
  },

  open() {
    if (!Drawer.isMobile()) return;
    const sb = document.getElementById('sidebar');
    const sc = document.getElementById('sidebar-scrim');
    const tb = document.getElementById('menu-toggle');
    if (!sb) return;
    Drawer._lastTrigger = document.activeElement || tb;
    sb.classList.add('open');
    sb.setAttribute('aria-modal', 'true');
    sb.removeAttribute('aria-hidden');
    sc?.classList.add('visible');
    tb?.setAttribute('aria-expanded', 'true');
    tb?.setAttribute('aria-label', 'Close menu');
    Drawer._lockScroll();
    // Move focus to the first nav item for keyboard / screen-reader users.
    requestAnimationFrame(() => sb.querySelector('.nav-item')?.focus());
  },

  close() {
    const sb = document.getElementById('sidebar');
    const sc = document.getElementById('sidebar-scrim');
    const tb = document.getElementById('menu-toggle');
    if (!sb) return;
    sb.classList.remove('open');
    sb.removeAttribute('aria-modal');
    if (Drawer.isMobile()) sb.setAttribute('aria-hidden', 'true');
    sc?.classList.remove('visible');
    tb?.setAttribute('aria-expanded', 'false');
    tb?.setAttribute('aria-label', 'Open menu');
    Drawer._unlockScroll();
    if (Drawer._lastTrigger && document.contains(Drawer._lastTrigger)) {
      Drawer._lastTrigger.focus();
    }
    Drawer._lastTrigger = null;
  },

  toggle() { Drawer.isOpen() ? Drawer.close() : Drawer.open(); },

  init() {
    const sb = document.getElementById('sidebar');
    const sc = document.getElementById('sidebar-scrim');
    const tb = document.getElementById('menu-toggle');
    const xb = document.getElementById('sidebar-close');
    if (!sb || !tb) return;

    if (Drawer.isMobile()) sb.setAttribute('aria-hidden', 'true');
    tb.setAttribute('aria-expanded', 'false');

    tb.addEventListener('click', (e) => { e.stopPropagation(); Drawer.toggle(); });
    xb?.addEventListener('click', Drawer.close);
    sc?.addEventListener('click', Drawer.close);

    document.addEventListener('keydown', (e) => {
      if (!Drawer.isOpen()) return;
      if (e.key === 'Escape') Drawer.close();
      else if (e.key === 'Tab') trapTab(e, sb); // cycle within the open drawer
    });

    // Auto-close on any route navigation — nav-items are real anchors so hash
    // changes fire here, and so does navigate() elsewhere in the app.
    window.addEventListener('hashchange', () => { if (Drawer.isOpen()) Drawer.close(); });

    // Reset every state when crossing the drawer breakpoint in either direction.
    const mql = window.matchMedia('(max-width: 767px)');
    const onBreakpointChange = (e) => {
      sb.classList.remove('open');
      sc?.classList.remove('visible');
      tb.setAttribute('aria-expanded', 'false');
      tb.setAttribute('aria-label', 'Open menu');
      Drawer._unlockScroll();
      if (e.matches) sb.setAttribute('aria-hidden', 'true');
      else { sb.removeAttribute('aria-hidden'); sb.removeAttribute('aria-modal'); }
    };
    mql.addEventListener('change', onBreakpointChange);

    // Swipe-left to close. Only tracks touches that begin inside the sidebar so
    // we never hijack page scrolling. dx must dominate dy to avoid stealing a
    // vertical scroll near the edge.
    let tx = 0, ty = 0, tracking = false;
    sb.addEventListener('touchstart', (e) => {
      if (!Drawer.isOpen()) return;
      tx = e.touches[0].clientX; ty = e.touches[0].clientY; tracking = true;
    }, { passive: true });
    sb.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - tx;
      const dy = e.touches[0].clientY - ty;
      if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.5) { tracking = false; Drawer.close(); }
    }, { passive: true });
    sb.addEventListener('touchend',    () => { tracking = false; });
    sb.addEventListener('touchcancel', () => { tracking = false; });
  },
};
window.Drawer = Drawer;

// ─── App — router, state, utilities ───────────────────────────────────────────

const App = {
  user:      null,
  stats:     null,
  csrfToken: null, // populated from /api/auth/me; sent as X-CSRF-Token on mutations

  async init() {
    Theme.init();

    try {
      [App.user, App.stats, App.subscription] = await Promise.all([
        API.getMe(),
        API.getStats(),
        API.getSubscription().catch(() => null), // Phase 10: workspace tier for the sidebar chip
      ]);
    } catch (e) {
      console.warn('Init fetch failed:', e.message);
    }

    // If getMe returned null (redirect in progress), stop here
    if (!App.user) return;

    // Phase 13: snapshot first-visit state NOW, before the dashboard greeting
    // reads and flips has_visited_dashboard during render. Tour.maybeAutoStart
    // keys the one-time product tour off this.
    App.isNewUser = !App.user.has_visited_dashboard;

    // Store CSRF token for all subsequent mutation requests (see api.js)
    if (App.user.csrfToken) {
      App.csrfToken = App.user.csrfToken;
      delete App.user.csrfToken; // keep user object clean
    }

    App.backfillTimezone();
    App.updateUserUI();
    App.renderTrialBanner();
    App.updateBadges();
    window.addEventListener('hashchange', App.route);
    App.route();
  },

  // Trial banner: "X days left in your trial" with an upgrade button, shown for
  // the whole trial. From day 10 onward the copy also names the fallback so the
  // downgrade is never a surprise. Data comes from /api/billing/subscription
  // (trial overlay computed server-side; trialDays mirrors config TRIAL_DAYS).
  renderTrialBanner() {
    const t = App.subscription?.trial;
    if (!t || !t.onTrial || App.subscription?.hasSubscription) return;
    const wrap = document.querySelector('.main-wrapper');
    const topbar = document.querySelector('.main-wrapper .topbar');
    if (!wrap || !topbar || el('trial-banner')) return;

    const n = t.daysLeft;
    const dayWord = n === 1 ? 'day' : 'days';
    const nearEnd = typeof t.trialDays === 'number' && n <= (t.trialDays - 10);
    const msg = nearEnd
      ? `${n} ${dayWord} left. After that you stay on Free with 1 competitor.`
      : `${n} ${dayWord} left in your trial`;

    const banner = document.createElement('div');
    banner.className = 'trial-banner' + (nearEnd ? ' trial-banner--urgent' : '');
    banner.id = 'trial-banner';
    const span = document.createElement('span');
    span.className = 'trial-banner-text';
    span.textContent = msg;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = 'Upgrade to Pro';
    btn.addEventListener('click', () => Billing.subscribe(btn));
    banner.appendChild(span);
    banner.appendChild(btn);
    topbar.insertAdjacentElement('afterend', banner);
  },

  // Silent timezone backfill. Timezone is captured at signup and never shown in
  // the UI; greetings band by it. Accounts created before signup captured a zone
  // (or any account whose browser reported nothing) default to 'UTC', which mis-
  // bands the greeting. On every app load, if the stored zone is missing or
  // 'UTC' and the browser reports a real IANA zone, adopt it: update App.user
  // immediately so this session's greeting bands correctly, and persist it in the
  // background for future sessions. Best-effort and entirely invisible.
  backfillTimezone() {
    const u = App.user;
    if (!u) return;
    if (u.timezone && u.timezone !== 'UTC') return; // already has a real zone
    let detected = 'UTC';
    try { detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) {}
    if (!detected || detected === 'UTC') return; // nothing better to offer
    u.timezone = detected;
    try { sessionStorage.removeItem('cs-greeting'); } catch (_) {}
    try { API.updateProfile({ timezone: detected }).catch(() => {}); } catch (_) {}
  },

  updateUserUI() {
    const u = App.user;
    if (!u) return;
    // Populate the real authenticated identity and clear the neutral loading
    // skeletons. Until this runs, the sidebar shows blank shimmer bars, never a
    // demo/placeholder user.
    const nameEl = el('user-name');
    const emailEl = el('user-email');
    const avatarEl = el('user-avatar');
    nameEl.textContent = u.name;
    emailEl.textContent = u.email;
    avatarEl.textContent = u.name?.[0]?.toUpperCase() || 'U';
    nameEl.classList.remove('skeleton');
    emailEl.classList.remove('skeleton');
    avatarEl.classList.remove('user-avatar--loading');
    nameEl.removeAttribute('aria-hidden');
    emailEl.removeAttribute('aria-hidden');
    avatarEl.removeAttribute('aria-hidden');
    // Phase 10: tier is workspace-driven (App.subscription.effectiveTier), not the
    // deprecated user.tier.
    const tier = App.subscription?.effectiveTier || 'free';
    el('plan-name').textContent = { free: 'Free Plan', pro: 'Pro Plan', team: 'Team Plan', business: 'Business Plan' }[tier] || tier;

    const chip = el('plan-chip');
    if (chip) {
      chip.className = 'plan-chip plan-chip--' + tier;
    }
  },

  async logout() {
    try { await API.logout(); } catch (_) {}
    window.location.href = '/login?loggedout=1';
  },

  updateBadges() {
    const s = App.stats;
    if (!s) return;
    const cc = el('nav-competitor-count');
    const ac = el('nav-alert-count');
    if (cc) cc.textContent = (s.competitor_count ?? s.total_competitors) || '';
    if (ac) ac.textContent = s.high_threats > 0 ? s.high_threats : '';
  },

  route() {
    // A hash fragment can carry a query string (e.g. /app#/profile/integrations?calendar_connected=google
    // landing from the OAuth callback). Split path from query before parsing,
    // and pass the parsed query down to renders that opt in. Without this
    // split, "profile/integrations?calendar_connected=google" would be treated as
    // a page name and fall through to the 404 branch.
    const rawHash = (window.location.hash || '#').slice(1) || '/';
    const qIdx = rawHash.indexOf('?');
    const pathPart  = qIdx === -1 ? rawHash : rawHash.slice(0, qIdx);
    const queryStr  = qIdx === -1 ? ''      : rawHash.slice(qIdx + 1);
    const routeQuery = new URLSearchParams(queryStr);

    const [base, ...rest] = pathPart.split('/').filter(Boolean);
    const page = base || 'dashboard';

    document.querySelectorAll('.nav-item').forEach(a => {
      const p = a.dataset.page;
      a.classList.toggle('active', p === page
        || (p === 'dashboard' && page === '')
        || (p === 'deals' && page === 'roi')); // ROI route highlights the Deals nav item
    });

    const root = el('page-root');
    el('topbar-actions').innerHTML = '';

    const id = rest[0];
    const transition = () => window.pageTransitionIn?.(root);

    if (page === '' || page === 'dashboard') {
      el('page-title').textContent = 'Dashboard';
      el('page-sub').textContent = 'Your competitive intelligence overview';
      root.innerHTML = Skeleton.dashboard();
      Dashboard.render().then(transition).then(() => window.Tour?.maybeAutoStart());
      // One-time welcome after a successful Pro checkout (set by billing.js).
      try {
        if (sessionStorage.getItem('cs-welcome-pro')) {
          sessionStorage.removeItem('cs-welcome-pro');
          setTimeout(() => toast('You\'re on Pro: all features unlocked. 🎉', 'success'), 600);
        }
      } catch (_) {}
    } else if (page === 'competitors') {
      if (id) {
        el('page-title').textContent = 'Competitor Timeline';
        el('page-sub').textContent = 'All detected changes for this competitor';
        root.innerHTML = Skeleton.cards(5);
        CompetitorDetail.render(id).then(transition);
      } else {
        el('page-title').textContent = 'Competitors';
        el('page-sub').textContent = 'Manage the pages you track';
        root.innerHTML = Skeleton.table();
        Competitors.render().then(transition);
      }
    } else if (page === 'history') {
      if (id) {
        el('page-title').textContent = 'Brief';
        el('page-sub').textContent = 'Detailed competitive analysis';
        root.innerHTML = Skeleton.cards(5);
        BattleCard.render(id).then(transition);
      } else {
        el('page-title').textContent = 'Change Feed';
        el('page-sub').textContent = 'All detected changes, analyzed by AI';
        root.innerHTML = Skeleton.cards(6);
        History.render().then(transition);
      }
    } else if (page === 'deals') {
      if (id) {
        el('page-title').textContent = 'Deal';
        el('page-sub').textContent = 'Outcome and competitor activity at close';
        root.innerHTML = Skeleton.cards(3);
        Deals.renderDetail(id).then(transition);
      } else {
        el('page-title').textContent = 'Deals & ROI';
        el('page-sub').textContent = 'Log win/loss outcomes and see what they cost you';
        root.innerHTML = Skeleton.cards(4);
        Deals.render(routeQuery).then(transition);
      }
    } else if (page === 'roi') {
      // ROI lives as a tab inside the Deals page; this route opens it directly.
      el('page-title').textContent = 'Deals & ROI';
      el('page-sub').textContent = 'Estimated revenue impact of competitor activity';
      root.innerHTML = Skeleton.cards(4);
      routeQuery.set('tab', 'roi');
      Deals.render(routeQuery).then(transition);
    } else if (page === 'settings') {
      el('page-title').textContent = 'Settings';
      el('page-sub').textContent = 'Workspace, notifications, and billing';
      // rest[0] is the section (#/settings/notifications). Only show the skeleton
      // on a fresh entry — when the settings shell is already mounted we're just
      // switching sections, and Settings.render() re-paints from cache without a
      // flash.
      if (!document.getElementById('settings-shell')) root.innerHTML = Skeleton.cards(4);
      Settings.render(routeQuery, id).then(transition);
    } else if (page === 'profile') {
      el('page-title').textContent = 'Profile';
      el('page-sub').textContent = 'Your personal details, integrations, and voice';
      // rest[0] is the section (#/profile/integrations). Only show the skeleton on
      // a fresh entry — when the profile shell is already mounted we're just
      // switching sections, and Profile.render() re-paints from cache without a
      // flash.
      if (!document.getElementById('profile-shell')) root.innerHTML = Skeleton.cards(3);
      Profile.render(routeQuery, id).then(transition);
    } else if (page === 'pricing' || page === 'plans') {
      el('page-title').textContent = 'Plans & Pricing';
      el('page-sub').textContent = 'Choose the plan that fits your team';
      root.innerHTML = Skeleton.cards(3);
      Pricing.render().then(transition);
    } else if (page === 'onboarding') {
      el('page-title').textContent = 'Welcome to Nivaria';
      el('page-sub').textContent = 'One quick step to personalize your analyses';
      root.innerHTML = Skeleton.cards(3);
      Onboarding.render().then(transition);
    } else {
      root.innerHTML = `<div class="empty-state">
        <div class="empty-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </div>
        <div class="empty-title">Page not found</div>
        <div class="empty-desc">The page you're looking for doesn't exist.</div>
        <a class="btn btn-primary" href="#/">Go to Dashboard</a>
      </div>`;
      transition();
    }
  },
};
window.App = App;

// ─── Utilities ─────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// SQLite CURRENT_TIMESTAMP yields "YYYY-MM-DD HH:MM:SS" in UTC with no zone
// marker. Browsers parse that bare form as *local* time, so a value written
// "now" by the server reads as the user's UTC offset in the past — e.g. a
// just-checked competitor shows "1h ago" for a UTC+1 user. Normalize the bare
// SQLite form to explicit UTC; ISO strings (which carry their own T/Z) match
// neither branch of the guard and pass through untouched.
function parseDbDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return new Date(s.replace(' ', 'T') + 'Z');
  }
  return new Date(s);
}

function timeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const diff = Date.now() - parseDbDate(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return parseDbDate(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return parseDbDate(dateStr).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function formatShortDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function threatBadge(level) {
  if (!level) return '';
  return `<span class="badge badge-${level}">${level.toUpperCase()}</span>`;
}

// Element focus was on before the modal opened — restored on close so keyboard
// users land back where they were (Phase I).
let _modalLastTrigger = null;

function openModal(contentHtml, wide = false) {
  _modalLastTrigger = document.activeElement;
  el('modal-content').innerHTML = contentHtml;
  const box = el('modal-box');
  box.style.maxWidth = wide ? '760px' : '540px';
  // Clear any leftover swipe transform from the previous open.
  box.style.transform = '';
  box.style.transition = '';
  // ARIA: name the dialog from its injected title, and label the icon-only
  // close (×) button. Every modal builder ships a .modal-title + .modal-close.
  const title = box.querySelector('.modal-title');
  if (title) box.setAttribute('aria-label', title.textContent.trim());
  else box.removeAttribute('aria-label');
  box.querySelector('.modal-close')?.setAttribute('aria-label', 'Close');
  el('modal-overlay').classList.add('open');
  // Move focus into the dialog: the first real field if there is one, otherwise
  // the close button. Skip the close button as the default so a form opens with
  // the cursor in its first input.
  requestAnimationFrame(() => {
    const items = focusableWithin(box);
    (items.find(x => !x.classList.contains('modal-close')) || items[0])?.focus();
  });
}

function closeModal(e) {
  if (!e || e.target === el('modal-overlay')) {
    el('modal-overlay').classList.remove('open');
    el('modal-content').innerHTML = '';
    // Reset any in-flight swipe transform.
    const box = el('modal-box');
    if (box) { box.style.transform = ''; box.style.transition = ''; box.removeAttribute('aria-label'); }
    // Return focus to whatever opened the modal.
    if (_modalLastTrigger && document.contains(_modalLastTrigger)) _modalLastTrigger.focus();
    _modalLastTrigger = null;
  }
}
window.closeModal = closeModal;

// ── Phase G: modal dismiss wiring ──────────────────────────────────────────
// Escape key closes the modal (any viewport). Swipe-down dismiss on the modal
// box at <=639px: drag tracks finger, releases past 25% of sheet height (or a
// fast-flick velocity) into close; otherwise springs back to origin.
(function () {
  const SHEET_BP = 639;
  let dragStartY = 0, dragStartT = 0, dragDy = 0, dragging = false, dragBox = null;

  // Escape closes (any viewport — restores the X-button-only dismiss for
  // physical-keyboard users on a mobile-sized window); Tab is trapped inside the
  // open dialog so focus can't wander to the page behind it (Phase I).
  window.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('modal-overlay');
    if (!overlay || !overlay.classList.contains('open')) return;
    if (e.key === 'Escape') closeModal();
    else if (e.key === 'Tab') trapTab(e, document.getElementById('modal-box'));
  });

  function inSheetMode() { return window.innerWidth <= SHEET_BP; }

  function onTouchStart(e) {
    if (!inSheetMode()) return;
    const box = e.currentTarget;
    // Don't intercept drags that originate inside scrolled content — let the
    // user keep scrolling the body. Only the top of the sheet (header /
    // top-of-scroll) triggers dismiss.
    if (box.scrollTop > 1) return;
    dragBox = box;
    dragStartY = e.touches[0].clientY;
    dragStartT = performance.now();
    dragDy = 0;
    dragging = true;
    box.style.transition = 'none';
  }

  function onTouchMove(e) {
    if (!dragging) return;
    const dy = e.touches[0].clientY - dragStartY;
    if (dy < 0) {
      // Upward swipe — abandon and let the body scroll resume.
      dragging = false;
      if (dragBox) { dragBox.style.transition = ''; dragBox.style.transform = ''; }
      return;
    }
    dragDy = dy;
    dragBox.style.transform = `translateY(${dy}px)`;
    // Soften the scrim as the sheet drops — visual cue that release dismisses.
    const overlay = document.getElementById('modal-overlay');
    if (overlay) {
      const k = Math.max(0, 1 - dy / dragBox.offsetHeight);
      overlay.style.background = `rgba(0,0,0,${0.65 * k})`;
    }
  }

  function onTouchEnd() {
    if (!dragging) return;
    dragging = false;
    const box = dragBox;
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.style.background = '';
    if (!box) return;
    const dt = performance.now() - dragStartT;
    const velocity = dragDy / Math.max(dt, 1); // px per ms
    const distanceThreshold = box.offsetHeight * 0.25;
    const flick = velocity > 0.6 && dragDy > 40;
    box.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)';
    if (dragDy > distanceThreshold || flick) {
      // Close: animate fully off-screen first so the dismissal feels physical,
      // then call closeModal which resets state.
      box.style.transform = `translateY(${box.offsetHeight}px)`;
      setTimeout(() => closeModal(), 200);
    } else {
      box.style.transform = '';
    }
  }

  // Wire once on DOM ready (modal-box is in the static shell).
  document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('modal-box');
    if (!box) return;
    box.addEventListener('touchstart', onTouchStart, { passive: true });
    box.addEventListener('touchmove',  onTouchMove,  { passive: true });
    box.addEventListener('touchend',   onTouchEnd);
    box.addEventListener('touchcancel', onTouchEnd);
  });
})();

// ── Phase H: native share with clipboard fallback ─────────────────────────
// Tries navigator.share first (iOS Safari, Chrome Android, modern Edge), which
// surfaces the native OS share sheet — instantly available to email, Slack,
// SMS, Notes, etc. Falls back to navigator.clipboard.writeText on platforms
// without share support (most desktop browsers as of 2026) so the existing
// flow keeps working everywhere.
//
// Returns: 'share' | 'clipboard' | 'cancelled' so callers can show appropriate
// feedback ("shared" vs "copied to clipboard" vs no message).
async function shareOrCopy({ title, text, url } = {}) {
  const payload = url ? `${text || title || ''}\n\n${url}`.trim() : (text || title || '');

  if (navigator.share) {
    const args = {};
    if (title) args.title = title;
    if (text)  args.text  = text;
    if (url)   args.url   = url;
    // canShare exists on Chrome Android + iOS Safari 16+; on older Safari just
    // try share() and catch.
    const canShare = !navigator.canShare || navigator.canShare(args);
    if (canShare) {
      try {
        await navigator.share(args);
        return 'share';
      } catch (e) {
        if (e.name === 'AbortError') return 'cancelled';
        // Fall through to clipboard on any other error (e.g. permission denied
        // when called outside a user gesture, network share failed, etc.)
      }
    }
  }

  await navigator.clipboard.writeText(payload);
  return 'clipboard';
}
window.shareOrCopy = shareOrCopy;

function toast(msg, type = 'info') {
  const icons = { success: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`, error: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`, info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` };
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${esc(msg)}</span>`;
  el('toast-container').appendChild(t);
  // Errors stay longer than info / success because they often contain
  // text the user actually needs to read before dismissing the toast.
  const duration = type === 'error' ? 8000 : type === 'info' ? 5000 : 4100;
  setTimeout(() => t.remove(), duration);
}

function navigate(path) {
  window.location.hash = path;
}

// ─── Plans & Pricing page (Phase 10) ───────────────────────────────────────────
const Pricing = {
  async render() {
    // Authoritative tier comes from the billing subscription (workspace-driven),
    // not App.user.tier (deprecated). Degrade gracefully if the call fails.
    let sub = { effectiveTier: 'free', status: null, cancelAtPeriodEnd: false };
    try { sub = await API.getSubscription(); } catch (_) {}
    const current = sub.effectiveTier || 'free';

    // Tier content is kept identical to the landing page cards (public/index.html);
    // only the CTAs differ, because these users are already logged in. Free is no
    // longer a public offering, so it is not shown as a selectable card. Existing
    // free accounts are still handled gracefully by the banner below.
    const plans = [
      {
        id: 'pro', name: 'Pro', price: 20, desc: 'For active sales teams', popular: true,
        features: [
          'Monitor up to 15 pages, across as many competitors as you like',
          'Automatic daily monitoring',
          'AI briefs with sales talking points and recommended responses',
          'AI outreach playbook drafts in your voice',
          'Email brief delivery',
          'Win/loss correlation and historical pattern analysis',
          'Revenue Impact Dashboard',
        ],
      },
      {
        id: 'team', name: 'Team', price: 49, desc: 'For collaborative teams', badge: 'Launching soon',
        features: [
          'A higher page volume with automatic monitoring',
          'Multi-user workspace with shared competitive intelligence',
          "Outreach drafts in each team member's own voice",
          'Role permissions and team collaboration',
          'Everything in Pro',
        ],
      },
      {
        id: 'business', name: 'Business', price: 149, desc: 'For enterprise needs', badge: 'Launching soon',
        features: [
          "Monitor the competitors others can't: bot-protected sites fully covered",
          'Monitor your entire competitive landscape',
          'Hourly monitoring',
          'API access and advanced webhook delivery',
          '12-month change history',
          'Priority support',
          'Everything in Team',
        ],
      },
    ];

    const cta = (p) => {
      if (current === p.id) {
        return `<button class="btn btn-secondary w-full" disabled>Current plan</button>`;
      }
      if (p.id === 'pro') {
        // Logged-in users have already started, so this is a direct subscribe
        // action. We never surface the landing page's "start trial" framing here.
        return `<button class="btn btn-primary w-full" onclick="Billing.subscribe(this)">Subscribe to Pro</button>`;
      }
      // team / business are waitlist-only until launch
      return `<button class="btn btn-secondary w-full" onclick="Billing.openWaitlist('${p.id}')">Join waitlist</button>`;
    };

    const tierLabel = { free: 'Free', pro: 'Pro', team: 'Team', business: 'Business' }[current] || current;
    const banner = current === 'free'
      ? `You're on the <strong style="color:var(--txt)">Free</strong> plan. Subscribe to Pro to unlock automatic monitoring and AI briefs.`
      : `You're on <strong style="color:var(--txt)">${tierLabel}</strong>${sub.cancelAtPeriodEnd ? ' (cancels at period end)' : ''}.`;

    el('page-root').innerHTML = `
      <div class="pricing-wrap">
        <div class="pricing-intro"><p class="text-muted">${banner}</p></div>
        <div class="pricing-grid">
          ${plans.map(p => `
            <div class="pricing-card ${p.popular ? 'featured' : ''} ${current === p.id ? 'is-current' : ''}">
              ${p.popular ? '<div class="pricing-popular">Most Popular</div>' : ''}
              ${p.badge ? `<div class="pricing-soon">${p.badge}</div>` : ''}
              <div class="pricing-header">
                <div class="pricing-plan">${p.name}</div>
                <div class="pricing-price"><span class="price-amount">$${p.price}</span><span class="price-period">/mo</span></div>
                <div class="pricing-desc">${p.desc}</div>
              </div>
              <ul class="pricing-features">
                ${p.features.map(f => `<li class="pricing-feature">${esc(f)}</li>`).join('')}
              </ul>
              ${cta(p)}
            </div>`).join('')}
        </div>
        <p class="text-muted text-sm" style="text-align:center;margin-top:22px">
          Healthcare or government compliance needs? Contact us at <a href="mailto:support@nivaria.app" class="link-accent">support@nivaria.app</a> for details.
        </p>
      </div>`;
  },
};
window.Pricing = Pricing;

document.addEventListener('DOMContentLoaded', () => { Drawer.init(); App.init(); });
