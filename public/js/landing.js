/* Landing page — scroll effects, theme toggle, animations */

(function () {
  const THEME_KEY = 'lp-theme';

  // ── Theme ──────────────────────────────────────────────────
  function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(val) {
    const resolved = val === 'system' ? getSystemTheme() : val;
    document.documentElement.setAttribute('data-lp-theme', resolved);
    localStorage.setItem(THEME_KEY, val);
    updateThemeIcon(resolved);
  }

  function updateThemeIcon(resolved) {
    const btn = document.getElementById('lp-theme-btn');
    if (!btn) return;
    btn.innerHTML = resolved === 'light'
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'system';
    applyTheme(saved);

    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme('system');
    });

    const btn = document.getElementById('lp-theme-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        const current = localStorage.getItem(THEME_KEY) || 'system';
        const resolved = current === 'system' ? getSystemTheme() : current;
        applyTheme(resolved === 'light' ? 'dark' : 'light');
      });
    }
  }

  // ── Navbar scroll ──────────────────────────────────────────
  function initNavScroll() {
    const nav = document.getElementById('lp-nav');
    if (!nav) return;
    let ticking = false;
    function update() {
      nav.classList.toggle('scrolled', window.scrollY > 20);
      ticking = false;
    }
    window.addEventListener('scroll', () => {
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  }

  // ── Scroll animations ─────────────────────────────────────
  function initScrollAnimations() {
    const targets = document.querySelectorAll('.lp-animate');
    if (!targets.length) return;

    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('lp-visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });

    targets.forEach(t => io.observe(t));
  }

  // ── Mobile menu ────────────────────────────────────────────
  function initMobileMenu() {
    const btn = document.getElementById('lp-mobile-menu-btn');
    const menu = document.getElementById('lp-mobile-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', () => {
      const open = menu.style.display === 'flex';
      menu.style.display = open ? 'none' : 'flex';
    });
  }

  // ── Hero video fallback ────────────────────────────────────
  // Also honours prefers-reduced-motion: the loop is indefinite background
  // motion, so for those visitors we hold it on the first frame rather than
  // playing it. The overlay gradient still reads the same either way.
  function initVideo() {
    const video = document.getElementById('lp-hero-video');
    if (!video) return;
    video.addEventListener('error', () => {
      video.style.display = 'none';
    });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      video.removeAttribute('autoplay');
      video.autoplay = false;
      video.pause();
    }
  }

  // ── Demo video (lazy Vimeo embed) ──────────────────────────
  // Nothing is requested from Vimeo until the visitor clicks the facade, so the
  // initial page render is never blocked by the player. On click we build the
  // iframe with a clean parameter set (no title/byline/portrait) and autoplay it,
  // which is allowed because the click is a user gesture.
  function initDemoVideo() {
    const btn = document.getElementById('lp-demo-play');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-vimeo-id');
      if (!id) return;
      const iframe = document.createElement('iframe');
      // Official Vimeo embed params (badge/autopause/player_id/app_id) plus a clean
      // chrome set (no title/byline/portrait) and autoplay, allowed under the click.
      iframe.src = 'https://player.vimeo.com/video/' + encodeURIComponent(id) +
        '?badge=0&autopause=0&player_id=0&app_id=58479' +
        '&autoplay=1&title=0&byline=0&portrait=0&dnt=1';
      iframe.title = 'Nivaria product demo';
      iframe.loading = 'lazy';
      iframe.allow = 'autoplay; fullscreen; picture-in-picture';
      iframe.setAttribute('allowfullscreen', '');
      const frame = btn.closest('.lp-video-frame');
      if (!frame) return;
      frame.replaceChildren(iframe);
    }, { once: true });
  }

  // ── Waitlist modal (Team / Business) ───────────────────────
  function initWaitlist() {
    const overlay = document.getElementById('lp-wl-overlay');
    const modal   = document.getElementById('lp-wl-modal');
    const form    = document.getElementById('lp-wl-form');
    const email   = document.getElementById('lp-wl-email');
    const msg     = document.getElementById('lp-wl-msg');
    const submit  = document.getElementById('lp-wl-submit');
    const closeBtn = document.getElementById('lp-wl-close');
    const titleEl = document.getElementById('lp-wl-title');
    const descEl  = document.getElementById('lp-wl-desc');
    const triggers = document.querySelectorAll('[data-waitlist], [data-trial]');
    if (!overlay || !modal || !form || !triggers.length) return;

    // Copy per mode. 'trial' reuses the same modal/endpoint as the waitlist but is
    // a manual-access contact capture for the 14-day Pro trial (no automated trial
    // yet). It posts tier_interest='trial' so admins can tell it apart.
    const COPY = {
      team: {
        title: 'Get notified when Team is available',
        desc: "We'll email you when the Team tier launches. Waitlist members get 10% off their first 2 months.",
        button: 'Join Waitlist',
        success: "You're on the list. We'll email you when Team is available.",
        already: "You're already on the waitlist for Team.",
      },
      business: {
        title: 'Get notified when Business is available',
        desc: "We'll email you when the Business tier launches. Waitlist members get 10% off their first 2 months.",
        button: 'Join Waitlist',
        success: "You're on the list. We'll email you when Business is available.",
        already: "You're already on the waitlist for Business.",
      },
      trial: {
        title: 'Start your free trial',
        desc: "Enter your email and we'll get your 14-day Pro trial set up. We'll be in touch shortly to get you started.",
        button: 'Start free trial',
        success: "Thanks. We'll reach out shortly to set up your trial.",
        already: "You've already requested a trial. We'll be in touch shortly.",
      },
    };

    let currentTier = 'team';
    let lastFocused = null;
    let submitting = false;

    function setMsg(text, type) {
      msg.textContent = text || '';
      msg.className = 'lp-modal-msg' + (type ? ' ' + type : '');
    }

    function open(tier) {
      currentTier = COPY[tier] ? tier : 'team';
      const c = COPY[currentTier];
      titleEl.textContent = c.title;
      descEl.textContent  = c.desc;
      form.reset();
      setMsg('');
      submitting = false;
      submit.disabled = false;
      email.disabled = false;
      submit.textContent = c.button;
      lastFocused = document.activeElement;
      overlay.hidden = false;
      document.body.style.overflow = 'hidden';
      // Focus the input on the next frame (after the element is visible).
      requestAnimationFrame(() => email.focus());
    }

    function close() {
      overlay.hidden = true;
      document.body.style.overflow = '';
      if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    }

    // Keep Tab focus inside the modal while it's open.
    function trapFocus(e) {
      if (e.key !== 'Tab') return;
      const f = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const items = Array.prototype.filter.call(f, el => !el.disabled && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last  = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    triggers.forEach(btn => {
      // data-trial → trial mode; data-waitlist="team|business" → waitlist mode.
      btn.addEventListener('click', () =>
        open(btn.hasAttribute('data-trial') ? 'trial' : btn.getAttribute('data-waitlist')));
    });

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (overlay.hidden) return;
      if (e.key === 'Escape') close();
      else trapFocus(e);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitting) return;
      if (!email.checkValidity()) { email.reportValidity(); return; }

      submitting = true;
      submit.disabled = true;
      email.disabled = true;
      setMsg('Submitting…');

      try {
        const res = await fetch('/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.value.trim(), tier_interest: currentTier }),
        });
        let data = {};
        try { data = await res.json(); } catch (_) {}

        if (res.ok) {
          // Success — leave the form disabled to prevent double-submit.
          submit.textContent = 'Done';
          const c = COPY[currentTier] || COPY.team;
          setMsg(data.already_signed_up ? c.already : c.success, 'success');
        } else {
          // Recoverable — re-enable so the user can retry.
          submitting = false;
          submit.disabled = false;
          email.disabled = false;
          if (res.status === 429) {
            setMsg('Too many requests right now. Please try again in a little while.', 'error');
          } else if (res.status === 400) {
            setMsg(data.error || 'Please enter a valid email address.', 'error');
          } else {
            setMsg('Something went wrong. Please try again.', 'error');
          }
        }
      } catch (_) {
        submitting = false;
        submit.disabled = false;
        email.disabled = false;
        setMsg('Network error. Please check your connection and try again.', 'error');
      }
    });
  }

  // ── Pricing comparison table ───────────────────────────────
  // The full table sits below the cards. Under 768px it is collapsed behind a
  // toggle; at wider widths it is always shown. Every "See all features" link
  // scrolls to it and opens it (so it is visible on mobile too).
  function initPricingCompare() {
    const compare = document.getElementById('lp-compare');
    const toggle  = document.getElementById('lp-compare-toggle');
    if (!compare) return;

    function open() {
      compare.classList.add('is-open');
      if (toggle) { toggle.setAttribute('aria-expanded', 'true'); toggle.textContent = 'Hide full comparison'; }
    }
    function close() {
      compare.classList.remove('is-open');
      if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = 'Show full comparison'; }
    }

    if (toggle) {
      toggle.addEventListener('click', () => {
        compare.classList.contains('is-open') ? close() : open();
      });
    }
    document.querySelectorAll('.lp-plan-seeall').forEach((a) => a.addEventListener('click', open));
  }

  // ── Init ──────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initNavScroll();
    initScrollAnimations();
    initMobileMenu();
    initVideo();
    initDemoVideo();
    initWaitlist();
    initPricingCompare();
  });
})();
