// Parity test: the in-app Plans page must show the same plans as the landing page.
//
// The two surfaces are authored separately (public/index.html renders the marketing
// cards, Pricing.render in public/js/app.js renders the logged-in ones), so they
// drift silently. This test pins them together: same price, seat line, waitlist
// banner, description, bullets (text AND "Planned" pill, in order), "Everything
// in ..." line and waitlist note.
//
// Two differences are intentional and asserted as such:
//   1. Free is not a selectable card in the app (only Pro, Team, Business).
//   2. Pro's landing note is trial framing ("14 days free, then $99/month"), which
//      never renders for a logged-in user, so the app card carries no note.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const check = (name, cond, detail = '') => {
  assert.ok(cond, name + (detail ? ' — ' + detail : ''));
  console.log('  ✓ ' + name);
  passed++;
};

const decode = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&times;/g, '×')
  .replace(/\s+/g, ' ').trim();

// ── Landing page cards (public/index.html) ────────────────────────────────────
function landingPlans() {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const section = html.slice(html.indexOf('<div class="lp-pricing-grid">'), html.indexOf('id="lp-compare"'));
  const chunks = section.split('<div class="lp-plan-card').slice(1);
  const one = (re, s) => { const m = s.match(re); return m ? decode(m[1]) : null; };

  return chunks.map((c) => ({
    name:    one(/<div class="lp-plan-name">([^<]+)<\/div>/, c),
    price:   one(/<span class="lp-plan-amount">\$([\d,]+)<\/span>/, c),
    seat:    one(/<p class="lp-plan-seat">([^<]*)<\/p>/, c),
    banner:  one(/<p class="lp-plan-banner">([^<]*)<\/p>/, c),
    desc:    one(/<p class="lp-plan-desc">([^<]*)<\/p>/, c),
    inherit: one(/<p class="lp-plan-inherit">([^<]*)<\/p>/, c),
    note:    one(/<p class="lp-plan-waitnote">([^<]*)<\/p>/, c),
    features: (c.match(/<li class="lp-plan-feat">[\s\S]*?<\/li>/g) || []).map((li) => ({
      text: decode((li.match(/<span>([^<]*)<\/span>/) || [])[1] || ''),
      planned: /lp-plan-pill-planned/.test(li),
    })),
  }));
}

// ── In-app cards (the `plans` literal inside Pricing.render) ──────────────────
// app.js is a browser file with no exports, and Pricing.render is async and
// DOM-bound, so we lift out the plan data block and evaluate just that.
function appPlans() {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');
  const start = src.indexOf('const feat = (text, planned)');
  assert.ok(start !== -1, 'could not find the plan data block in public/js/app.js');
  const end = src.indexOf('\n    ];', src.indexOf('const plans = [', start));
  assert.ok(end !== -1, 'could not find the end of the plans array in public/js/app.js');
  const block = src.slice(start, end + '\n    ];'.length);
  return vm.runInNewContext(block + '\nplans;');
}

const landing = landingPlans();
const app = appPlans();

console.log('\n── Plan set ──');
check('landing renders Pro, Team, Business',
  landing.map(p => p.name).join(',') === 'Pro,Team,Business', landing.map(p => p.name).join(','));
check('app renders the same three plans, in the same order',
  app.map(p => p.name).join(',') === landing.map(p => p.name).join(','), app.map(p => p.name).join(','));

for (const lp of landing) {
  const ap = app.find(p => p.name === lp.name);
  console.log(`\n── ${lp.name} ──`);
  check(`${lp.name}: card exists in the app`, !!ap);

  check(`${lp.name}: same price`, String(ap.price) === lp.price.replace(/,/g, ''), `landing $${lp.price}, app $${ap.price}`);
  check(`${lp.name}: same description`, ap.desc === lp.desc, `landing "${lp.desc}" / app "${ap.desc}"`);
  check(`${lp.name}: same seat line`, (ap.seat || null) === lp.seat, `landing "${lp.seat}" / app "${ap.seat || null}"`);
  check(`${lp.name}: same waitlist banner`, (ap.banner || null) === lp.banner);
  check(`${lp.name}: same "Everything in ..." line`, (ap.inherit || null) === lp.inherit, `landing "${lp.inherit}" / app "${ap.inherit || null}"`);

  check(`${lp.name}: same number of bullets`, ap.features.length === lp.features.length,
    `landing ${lp.features.length}, app ${ap.features.length}`);
  lp.features.forEach((lf, i) => {
    const af = ap.features[i] || {};
    check(`${lp.name}: bullet ${i + 1} text matches`, af.text === lf.text, `landing "${lf.text}" / app "${af.text}"`);
    check(`${lp.name}: bullet ${i + 1} Planned pill matches`, !!af.planned === lf.planned,
      `landing planned=${lf.planned}, app planned=${!!af.planned}`);
  });

  // Pro's landing note is trial framing that never applies to a logged-in user.
  if (lp.name === 'Pro') {
    check('Pro: app card carries no note (trial framing is landing-only)', !ap.note);
  } else {
    check(`${lp.name}: same waitlist note`, (ap.note || null) === lp.note, `landing "${lp.note}" / app "${ap.note || null}"`);
  }
}

console.log(`\n✅ All ${passed} assertions passed.`);
