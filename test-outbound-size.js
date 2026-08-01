// Unit tests for the buyer-size gate:
//   src/outbound/sizeGate.js   parsing, the free field read, the band decision
//   src/outbound/pipeline.js   the gate's position and accounting in buildLead
//
// The gate exists because the ICP brief catches the right CATEGORIES but not the
// right company SIZE: enterprise companies (Ramp scale, a two-billion-dollar
// CRM) feel real competitor pain, they are simply Crayon's and Klue's customers
// rather than Nivaria's buyer. It is a SEPARATE gate from the peer classifier:
// a perfect category and pain fit can still be too big to buy.
//
// Pure, no DB and no network. Run with `node test-outbound-size.js`.

// The size estimator calls the model only when a key is present. Clearing it
// keeps the suite offline and exercises the degraded path (no research means
// 'unknown', which is KEPT and flagged, never dropped).
delete process.env.ANTHROPIC_API_KEY;

const assert = require('assert');
const {
  classifySizeFromFields, decideSize, normalizeEstimate, formatSizeEstimate,
  estimateCompanySize, parseMoneyUsd, parseEmployeeCount, employeesFromText,
  valuationFromText, worseBand, formatUsdShort, sizeQuery, matchKnownTooLarge,
} = require('./src/outbound/sizeGate');
const { buildLead } = require('./src/outbound/pipeline');
const { makeFunnel } = require('./src/outbound/funnel');

let pass = 0, fail = 0;
// Async checks are collected so the summary waits for them instead of racing a
// timer. Sync checks still report in source order.
const pending = [];
function check(label, fn) {
  const done = (err) => {
    if (err) { console.log('❌ ' + label + '\n     ' + String(err.message).split('\n')[0]); fail++; }
    else { console.log('✅ ' + label); pass++; }
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(() => done(), done));
    else done();
  } catch (err) { done(err); }
}
function eq(got, expected, what) {
  assert.deepStrictEqual(got, expected,
    (what ? what + ': ' : '') + 'got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(expected));
}

// ── parsing ───────────────────────────────────────────────────────────────────

check('money parses numbers, suffixes, and words', () => {
  eq(parseMoneyUsd(3500000), 3500000);
  eq(parseMoneyUsd('$3.5M'), 3500000);
  eq(parseMoneyUsd('2.1 billion'), 2100000000);
  eq(parseMoneyUsd('750k'), 750000);
  eq(parseMoneyUsd('$1,200,000'), 1200000);
  eq(parseMoneyUsd(null), null);
  eq(parseMoneyUsd('unknown'), null);
});

check('headcount takes the TOP of a stated range', () => {
  eq(parseEmployeeCount(40), 40);
  eq(parseEmployeeCount('11-50'), 50, 'range upper bound');
  eq(parseEmployeeCount('51 to 200'), 200);
  eq(parseEmployeeCount('1,000+'), 1000);
  eq(parseEmployeeCount('about 20'), 20);
  eq(parseEmployeeCount(null), null);
});

check('headcount read out of free text picks the largest claim', () => {
  eq(employeesFromText('a team of 8 engineers'), 8);
  eq(employeesFromText('grew to 5,000 employees worldwide'), 5000);
  eq(employeesFromText('11-50 employees'), 50);
  eq(employeesFromText('raised a Series A'), null, 'no headcount claim');
});

check('valuation read out of free text', () => {
  eq(valuationFromText('valued at $2B after the round'), 2e9);
  eq(valuationFromText('a $1.4 billion valuation'), 1.4e9);
  eq(valuationFromText('raised $8M seed'), null, 'a raise is not a valuation');
});

check('worse band wins, and a real read beats unknown', () => {
  eq(worseBand('fits', 'too_large'), 'too_large');
  eq(worseBand('borderline', 'fits'), 'borderline');
  eq(worseBand('unknown', 'fits'), 'fits', 'unknown must never mask a real read');
  eq(worseBand('unknown', 'unknown'), 'unknown');
});

// ── the free field read (no search, no model call) ─────────────────────────────

check('a known large company is excluded for free', () => {
  const r = classifySizeFromFields({ company: 'Ramp', category: 'Spend management', trigger: 'Hiring a PMM' });
  eq(r.band, 'too_large');
  assert.ok(/ramp/i.test(r.reason), 'reason names the match: ' + r.reason);
});

check('the known-large list matches the WHOLE name, not a word inside it', () => {
  eq(classifySizeFromFields({ company: 'Rampart Labs', category: 'Dev tools' }).band, 'unknown',
    'Rampart is not Ramp');
  eq(classifySizeFromFields({ company: 'Blockstream', category: 'Bitcoin infra' }).band, 'unknown',
    'Block is not Blockstream');
  // A third of the list is ordinary English words. Word-boundary matching used
  // to hard-drop these small companies for free, before any research ran.
  eq(classifySizeFromFields({ company: 'Wise Systems', category: 'Logistics' }).band, 'unknown',
    'Wise Systems is not Wise');
  eq(classifySizeFromFields({ company: 'Segment Labs', category: 'Analytics' }).band, 'unknown',
    'Segment Labs is not Segment');
  eq(classifySizeFromFields({ company: 'Circle Medical', category: 'Health' }).band, 'unknown',
    'Circle Medical is not Circle');
  eq(classifySizeFromFields({ company: 'Drift Studio', category: 'Design agency' }).band, 'unknown',
    'Drift Studio is not Drift');
  eq(classifySizeFromFields({ company: 'Lattice Coffee', category: 'Commerce' }).band, 'unknown');
});

check('a legal suffix or a bare TLD does not hide a known large company', () => {
  eq(matchKnownTooLarge('HubSpot, Inc.'), 'hubspot');
  eq(matchKnownTooLarge('Salesforce.com'), 'salesforce');
  eq(matchKnownTooLarge('Monday'), 'monday.com', 'the entry carries the TLD, the name may not');
  eq(matchKnownTooLarge('Stripe Ltd'), 'stripe');
  eq(matchKnownTooLarge('New Relic'), 'new relic');
  eq(matchKnownTooLarge('Boxcast'), null);
  eq(matchKnownTooLarge('Notionally'), null);
});

check('a late-stage stage_size is excluded (the $2B CRM case)', () => {
  const r = classifySizeFromFields({
    company: 'MegaCRM', category: 'CRM',
    stage_size: 'Series D, 800 employees', trigger: 'Launched a new pricing page',
  });
  eq(r.band, 'too_large');
});

check('a unicorn or public company is excluded on the scale phrase alone', () => {
  eq(classifySizeFromFields({ company: 'BigCo', stage_size: 'unicorn' }).band, 'too_large');
  eq(classifySizeFromFields({ company: 'BigCo', stage_size: 'publicly traded SaaS' }).band, 'too_large');
});

check('a Series C raise stated in the trigger is excluded', () => {
  const r = classifySizeFromFields({
    company: 'ScaleCo', category: 'HR software',
    trigger: 'ScaleCo raised a $90M Series C led by Insight',
  });
  eq(r.band, 'too_large');
});

check('an early-stage small team fits', () => {
  const r = classifySizeFromFields({
    company: 'TinySaaS', category: 'Scheduling', stage_size: 'seed, 8 employees',
    trigger: 'Founder posted about tracking competitors in a spreadsheet',
  });
  eq(r.band, 'fits');
});

check('Series B lands in the borderline zone, kept and flagged', () => {
  eq(classifySizeFromFields({ company: 'MidCo', stage_size: 'Series B' }).band, 'borderline');
});

check('an unplaceable company is unknown, not large', () => {
  eq(classifySizeFromFields({ company: 'Obscure Tools', category: 'Analytics' }).band, 'unknown');
});

// ── the band decision ─────────────────────────────────────────────────────────

const est = (o) => normalizeEstimate(o);

check('a small headcount and an early round fits', () => {
  eq(decideSize(est({ employees: 12, last_round: 'Seed', total_funding_usd: 2500000 })).band, 'fits');
});

check('100 to 250 people is borderline, past 250 is excluded', () => {
  eq(decideSize(est({ employees: 150 })).band, 'borderline');
  eq(decideSize(est({ employees: 400 })).band, 'too_large');
  eq(decideSize(est({ employees: 95 })).band, 'fits');
});

check('Series C and beyond is excluded', () => {
  eq(decideSize(est({ last_round: 'Series C' })).band, 'too_large');
  eq(decideSize(est({ last_round: 'Public' })).band, 'too_large');
  eq(decideSize(est({ last_round: 'Series A' })).band, 'fits');
});

check('mega funding and unicorn valuations are excluded', () => {
  eq(decideSize(est({ total_funding_usd: 150000000 })).band, 'too_large');
  eq(decideSize(est({ valuation_usd: 2000000000 })).band, 'too_large');
  eq(decideSize(est({ total_funding_usd: 60000000 })).band, 'borderline', '$60M is the grey zone');
});

// The ceiling used to sit at $25M borderline, $75M exclude, $250M valuation,
// which hard-excluded ordinary Series B companies the round rule was keeping.
// Money now only excludes past-Series-B raises and unicorn valuations.
check('normal Series B money is KEPT, not excluded', () => {
  eq(decideSize(est({ total_funding_usd: 40000000 })).band, 'fits', '$40M is a Series B raise');
  eq(decideSize(est({ valuation_usd: 600000000 })).band, 'unknown',
    'a $600M valuation is not a unicorn and is not a size signal on its own');
  eq(decideSize(est({
    last_round: 'Series B', employees: 180, total_funding_usd: 55000000, valuation_usd: 500000000,
  })).band, 'borderline', 'the whole Series B profile is kept and flagged');
});

check('the enterprise tier is still excluded', () => {
  eq(decideSize(est({ valuation_usd: 1200000000 })).band, 'too_large', 'a unicorn');
  eq(decideSize(est({ employees: 4000 })).band, 'too_large', 'thousands of employees');
  eq(decideSize(est({ last_round: 'Series D', employees: 30 })).band, 'too_large');
});

check('a small team at a big company is still excluded (worst signal wins)', () => {
  eq(decideSize(est({ employees: 20, last_round: 'Series E' })).band, 'too_large');
});

check('nothing findable is unknown, which the pipeline keeps', () => {
  eq(decideSize(est({})).band, 'unknown');
  eq(decideSize(est({ confidence: 'low', basis: 'no size information found' })).band, 'unknown');
});

// ── the crypto exception ──────────────────────────────────────────────────────
// Rule: never gate a crypto candidate on raise size. A well-funded protocol can
// still be a scrappy team, so only headcount and go-to-market maturity count.

check('a well-funded crypto project with a tiny team is KEPT', () => {
  const e = normalizeEstimate(
    { employees: 6, last_round: 'Series B', total_funding_usd: 45000000, valuation_usd: 400000000 },
    { crypto: true });
  eq(decideSize(e, { crypto: true }).band, 'fits', 'raise size must not gate crypto');
});

check('the same numbers OUTSIDE crypto are flagged, and unicorn money still excludes', () => {
  const e = normalizeEstimate({ employees: 6, last_round: 'Series B', total_funding_usd: 45000000, valuation_usd: 400000000 });
  eq(decideSize(e).band, 'borderline', 'Series B money flags a non-crypto company, it no longer drops it');
  const big = normalizeEstimate({ employees: 6, total_funding_usd: 200000000, valuation_usd: 3000000000 });
  eq(decideSize(big).band, 'too_large', 'unicorn money still excludes a non-crypto company');
  eq(decideSize(big, { crypto: true }).band, 'fits', 'the same money never excludes a crypto team');
});

check('crypto headcount still excludes', () => {
  const e = normalizeEstimate({ employees: 3000 }, { crypto: true });
  eq(decideSize(e, { crypto: true }).band, 'too_large', 'team size is the crypto test');
});

check('a scaled crypto go-to-market org is flagged borderline', () => {
  const e = normalizeEstimate({ gtm_maturity: 'scaled' }, { crypto: true });
  eq(decideSize(e, { crypto: true }).band, 'borderline');
});

check('a crypto raise with no team signal is unknown, so it is kept', () => {
  const e = normalizeEstimate({ total_funding_usd: 40000000, last_round: 'Series A' }, { crypto: true });
  eq(decideSize(e, { crypto: true }).band, 'unknown');
});

check('the crypto field read ignores money too', () => {
  eq(classifySizeFromFields({
    company: 'ProtocolX', stage_size: 'large', source_kind: 'crypto',
    trigger: 'ProtocolX raised a $60M Series C led by Paradigm',
  }).band, 'unknown', 'a crypto round label is not a size signal');
});

check('the crypto size query asks about the team, not the raise', () => {
  assert.ok(/team size/.test(sizeQuery({ company: 'ProtocolX', source_kind: 'crypto' })));
  assert.ok(/employees/.test(sizeQuery({ company: 'AcmeSaaS' })));
});

// ── display ───────────────────────────────────────────────────────────────────

check('the size line reads as a short human summary', () => {
  eq(formatSizeEstimate(est({ last_round: 'Seed', employees: 12, total_funding_usd: 3200000 })),
    'Seed, about 12 people, $3.2M raised');
  eq(formatSizeEstimate(est({ employees_band: '11-50' })), '11-50 people');
  eq(formatSizeEstimate(est({})), 'Size unknown', 'unknown says so plainly');
});

check('the size line carries no em-dash, en-dash, or connecting plus', () => {
  const line = formatSizeEstimate(est({
    last_round: 'Series A', employees_band: '11-50', total_funding_usd: 9000000, valuation_usd: 60000000,
  }));
  assert.ok(!/[–—]/.test(line), 'dash found in ' + JSON.stringify(line));
  assert.ok(!/\w \+ \w/.test(line), 'connector plus found in ' + JSON.stringify(line));
});

check('short USD formatting', () => {
  eq(formatUsdShort(3200000), '$3.2M');
  eq(formatUsdShort(2000000000), '$2B');
  eq(formatUsdShort(750000), '$750k');
});

// ── estimateCompanySize, with a stub provider ─────────────────────────────────

function stubProvider(hits) {
  const calls = [];
  return {
    calls,
    async search(q) { calls.push(q); return hits || []; },
    async findPeople() { calls.push('findPeople'); return []; },
    async findContact() { return null; },
  };
}

check('a known large company is excluded WITHOUT spending a search', async () => {
  const p = stubProvider();
  const r = await estimateCompanySize(p, { company: 'Salesforce', category: 'CRM' });
  eq(r.band, 'too_large');
  eq(p.calls.length, 0, 'no search should be spent on an obvious exclusion');
  eq(r.researched, false);
});

check('an unplaceable company is researched and kept as unknown', async () => {
  const p = stubProvider([{ title: 'Obscure Tools', link: 'https://x.test', snippet: 'a tool' }]);
  const r = await estimateCompanySize(p, { company: 'Obscure Tools', category: 'Analytics' });
  eq(p.calls.length, 1, 'exactly one size search per researched company');
  eq(r.band, 'unknown', 'no model available means unknown, never large');
  eq(r.display, 'Size unknown');
});

check('a failing search degrades to unknown rather than throwing', async () => {
  const p = { async search() { throw new Error('serper down'); } };
  const r = await estimateCompanySize(p, { company: 'Whoever' });
  eq(r.band, 'unknown');
});

// ── the gate inside buildLead ─────────────────────────────────────────────────

check('a too-large company is dropped before any people call', async () => {
  const funnel = makeFunnel();
  const p = stubProvider();
  const lead = await buildLead(p, 'brief', {
    company: 'HubSpot', category: 'CRM', trigger: 'Hiring a competitive intelligence manager',
  }, funnel, []);
  eq(lead, null, 'too large is not a lead');
  eq(funnel.too_large, 1);
  eq(funnel.peer, 0, 'the size gate is separate from the peer gate');
  eq(p.calls.includes('findPeople'), false, 'people, contact, score, and draft are never spent');
});

check('a peer is still counted as a peer, not as too large', async () => {
  const funnel = makeFunnel();
  const lead = await buildLead(stubProvider(), 'brief', {
    company: 'Crayon', category: 'Marketing technology', trigger: 'Raised a Series C',
  }, funnel, []);
  eq(lead, null);
  eq(funnel.peer, 1);
  eq(funnel.too_large, 0, 'the peer gate runs first and owns its own counter');
});

check('an unknown-size company is KEPT, flagged, and carries its estimate', async () => {
  const funnel = makeFunnel();
  const provider = {
    async search() { return []; },
    async findPeople() {
      return [{ person_name: 'Ada Bloom', person_title: 'Founder', person_seniority: 'founder',
        profileUrl: 'https://linkedin.com/in/adabloom', channel: 'linkedin' }];
    },
    async findContact() {
      return { channel: 'linkedin', handle_or_email: 'https://linkedin.com/in/adabloom', contact_status: 'manual' };
    },
  };
  const lead = await buildLead(provider, 'brief', {
    company: 'Obscure Tools', category: 'Scheduling', trigger: 'Founder described manual competitor tracking',
  }, funnel, []);
  assert.ok(lead, 'an unknown size must not drop the lead');
  eq(lead.size_band, 'unknown');
  eq(lead.size_estimate, 'Size unknown');
  eq(funnel.size_unknown, 1, 'flagged in the funnel');
  eq(funnel.too_large, 0);
  assert.ok(lead.size_details && typeof lead.size_details === 'object', 'raw estimate is persisted too');
});

// ── summary ───────────────────────────────────────────────────────────────────

Promise.all(pending).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
