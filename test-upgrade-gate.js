// Unit test for the tier-aware upgrade-gate modal (public/js/billing.js).
//
// billing.js is a browser file (no module.exports). We load it into a Node `vm`
// context with minimal DOM/globals stubbed, then exercise two surfaces:
//   1. gateConfigForTier(tier) — the pure tier→config resolver.
//   2. showUpgradeModal(info)  — the actual rendered modal HTML per tier, by
//      stubbing App.subscription.effectiveTier and capturing openModal()'s HTML.
//
// This proves the reported bug is fixed: a Pro user hitting the cap no longer
// sees "Upgrade to Pro" — they see the Team waitlist.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'public', 'js', 'billing.js'), 'utf8');

// Build a sandbox that captures the HTML passed to openModal(), and lets us
// swap the current tier between renders.
function makeSandbox() {
  let lastModalHtml = null;
  const sandbox = {
    window: {},
    document: { getElementById: () => null },
    // esc is a global helper in the app (public/js/app.js). Reproduce its core
    // behaviour so the rendered HTML matches what the browser would produce.
    esc: (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    openModal: (html) => { lastModalHtml = html; },
    closeModal: () => {},
    toast: () => {},
    navigate: () => {},
    App: { subscription: null, user: { email: 'pro@example.com' } },
    console,
  };
  sandbox.window.App = sandbox.App;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'billing.js' });
  return {
    sandbox,
    getModalHtml: () => lastModalHtml,
    setTier: (t) => { sandbox.App.subscription = t ? { effectiveTier: t } : null; },
  };
}

let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓ ' + name);
  passed++;
};

console.log('\n── gateConfigForTier (pure resolver) ──');
{
  const { sandbox } = makeSandbox();
  const cfg = sandbox.window.gateConfigForTier;
  check("free  → title 'Upgrade to Pro'",          cfg('free').title === 'Upgrade to Pro');
  check("pro   → title 'Join the Team Waitlist'",   cfg('pro').title === 'Join the Team Waitlist');
  check("team  → title 'Join the Business Waitlist'", cfg('team').title === 'Join the Business Waitlist');
  check("business → title 'Contact Us About Enterprise'", cfg('business').title === 'Contact Us About Enterprise');
  check('unknown tier falls back to Free pitch',    cfg('enterprise').title === 'Upgrade to Pro');
  check('undefined tier falls back to Free pitch',  cfg(undefined).title === 'Upgrade to Pro');
  check('free  CTA opens Pro checkout',             cfg('free').cta.onclick === 'Billing.upgradeFromGate()');
  check("pro   CTA opens Team waitlist",            cfg('pro').cta.onclick === "Billing.openWaitlist('team')");
  check("team  CTA opens Business waitlist",        cfg('team').cta.onclick === "Billing.openWaitlist('business')");
  check('business CTA is a support mailto',         cfg('business').cta.href === 'mailto:support@nivaria.app');
  check('business has no upgrade/onclick button',   cfg('business').cta.onclick === undefined);
  check('free  price is $49/month',                 cfg('free').price === '$49/month');
  check('pro   price is $149/month (waitlist)',      cfg('pro').price === '$149/month (waitlist)');
  check('team  price is $349/month (waitlist)',     cfg('team').price === '$349/month (waitlist)');
  check('business has no price',                    cfg('business').price === null);
}

console.log('\n── showUpgradeModal rendered HTML (per current tier) ──');
{
  const t = makeSandbox();
  const render = (tier, info) => { t.setTier(tier); t.sandbox.window.showUpgradeModal(info || {}); return t.getModalHtml(); };

  // Free user hits cap → Upgrade to Pro
  let html = render('free', { error: 'upgrade_required', message: "You've reached your plan's competitor limit. Upgrade to Pro to track more." });
  check('free: title is Upgrade to Pro',            /modal-title">Upgrade to Pro</.test(html));
  check('free: uses backend feature message',        html.includes("reached your plan&#39;s competitor limit"));
  check('free: shows Pro checkout CTA',               html.includes('Billing.upgradeFromGate()'));
  check('free: shows $49/month',                      html.includes('$49/month'));
  check('free: has Maybe later dismiss',              html.includes('Maybe later'));

  // Pro user hits 10-competitor cap → Team waitlist (the reported bug)
  html = render('pro', { error: 'upgrade_required', message: "You've reached your plan's competitor limit. Upgrade to Pro to track more." });
  check('pro: title is Join the Team Waitlist',       /modal-title">Join the Team Waitlist</.test(html));
  check('pro: does NOT say Upgrade to Pro',           !/Upgrade to Pro/.test(html));
  check('pro: ignores tier-wrong backend message',    !html.includes('competitor limit. Upgrade to Pro to track more'));
  check('pro: tier-aware Pro-plan-limit copy',        html.includes("reached your Pro plan"));
  check('pro: lists multi-user workspace',            html.includes('Multi-user workspace'));
  check('pro: Team gate uses neutral higher-page-volume copy (no committed number)', html.includes('A higher page volume with automatic monitoring'));
  check('pro: Team gate commits to no specific page/competitor number', !/\b\d+\s+(competitors|pages)\b/i.test(html));
  check('pro: Team gate lists Everything in Pro',     html.includes('Everything in Pro'));
  check('pro: Team gate never says "unlimited"',      !/unlimited/i.test(html));
  check('pro: CTA opens Team waitlist',               html.includes("Billing.openWaitlist('team')"));
  check('pro: shows $149/month (waitlist)',            html.includes('$149/month (waitlist)'));
  check('pro: has Maybe later dismiss',               html.includes('Maybe later'));

  // Team user hits cap → Business waitlist
  html = render('team', {});
  check('team: title is Join the Business Waitlist',  /modal-title">Join the Business Waitlist</.test(html));
  check('team: lists bot-protected site coverage',    html.includes('bot-protected sites fully covered'));
  check('team: lists hourly monitoring',              html.includes('Hourly monitoring'));
  check('team: lists entire competitive landscape',   html.includes('Monitor your entire competitive landscape'));
  check('team: Business gate lists API access bullet', html.includes('API access and advanced webhook delivery'));
  check('team: Business gate has no "custom integration"', !/custom integration/i.test(html));
  check('team: Business gate never says "unlimited"', !/unlimited/i.test(html));
  check('team: CTA opens Business waitlist',          html.includes("Billing.openWaitlist('business')"));
  check('team: shows $349/month (waitlist)',          html.includes('$349/month (waitlist)'));

  // Business user → contact enterprise, no upgrade button
  html = render('business', {});
  check('business: title is Contact Us About Enterprise', /modal-title">Contact Us About Enterprise</.test(html));
  check('business: CTA is support mailto',            html.includes('href="mailto:support@nivaria.app"'));
  check('business: no waitlist/checkout button',      !html.includes('Billing.openWaitlist') && !html.includes('upgradeFromGate'));
  check('business: still has Maybe later dismiss',    html.includes('Maybe later'));

  // No subscription loaded at all → safe Free default
  html = render(null, {});
  check('missing subscription → Free default',        /modal-title">Upgrade to Pro</.test(html));
}

console.log(`\n✅ All ${passed} assertions passed.\n`);
