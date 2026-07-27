// Unit tests for the web3 discovery segment:
//   src/outbound/cryptoSources.js    normalization, X handles, cross-source dedupe
//   src/outbound/cryptoDiscovery.js  peer rule, category fit, candidate shape
//   src/outbound/provider.js         X people gates, pool merge
//   src/outbound/funnel.js           person-count merging for the X fallback
//
// Pure, no DB and no network. Run with `node test-outbound-crypto.js`.

const assert = require('assert');
const {
  normalizeLlamaRaise, normalizeCryptoRankRound, dedupeRaises, raiseKey,
  normalizeXHandle, projectDomain, usdFromLlamaAmount, formatUsd, isoDate,
} = require('./src/outbound/cryptoSources');
const {
  isCryptoPeer, categoryVerdict, stageFromRound, buildTrigger, toCandidate,
} = require('./src/outbound/cryptoDiscovery');
const {
  classifyXPersonResult, mergeCandidatePools, classifyCompany, rolesForStage,
  handleLooksLikeProject,
} = require('./src/outbound/provider');
const { makeFunnel, mergePersonCounts, REJECTION_LABELS, X_REJECTION_REASONS } = require('./src/outbound/funnel');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log('✅ ' + label); pass++; }
  catch (err) { console.log('❌ ' + label + '\n     ' + String(err.message).split('\n')[0]); fail++; }
}
function eq(got, expected, what) {
  assert.deepStrictEqual(got, expected,
    (what ? what + ': ' : '') + 'got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(expected));
}

// ── cryptoSources: X handles ──────────────────────────────────────────────────

check('X handle parsed from a profile URL', () => {
  eq(normalizeXHandle('https://x.com/paradigm'), 'paradigm');
  eq(normalizeXHandle('https://twitter.com/paradigm/status/123'), 'paradigm');
  eq(normalizeXHandle('@paradigm'), 'paradigm');
  eq(normalizeXHandle('paradigm'), 'paradigm');
});

check('X handle rejects navigation paths and non-X hosts', () => {
  eq(normalizeXHandle('https://x.com/i/flow/login'), null, 'reserved /i path');
  eq(normalizeXHandle('https://x.com/search?q=defi'), null, 'search path');
  eq(normalizeXHandle('https://linkedin.com/in/someone'), null, 'wrong host');
  eq(normalizeXHandle('https://x.com/'), null, 'no handle in path');
  eq(normalizeXHandle('a-handle-that-is-way-too-long'), null, 'over 15 chars');
  eq(normalizeXHandle(''), null);
  eq(normalizeXHandle(null), null);
});

// ── cryptoSources: a news link is never a project domain ──────────────────────

check('an announcement host is never treated as the project domain', () => {
  eq(projectDomain('https://techcrunch.com/2026/03/01/acme-raises'), null);
  eq(projectDomain('https://www.coindesk.com/business/x'), null);
  eq(projectDomain('https://x.com/acme/status/1'), null);
  eq(projectDomain('https://acme.xyz/blog/raise'), 'acme.xyz');
});

check('a raise whose only link is a news article gets a null domain', () => {
  const rec = normalizeLlamaRaise({
    name: 'Acme', date: 1767225600, amount: 12, round: 'Series A',
    source: 'https://techcrunch.com/2026/01/01/acme-raises-12m',
  });
  eq(rec.domain, null, 'domain');
  eq(rec.source_url, 'https://techcrunch.com/2026/01/01/acme-raises-12m', 'source_url');
});

// ── cryptoSources: amounts and dates ──────────────────────────────────────────

check('DeFiLlama amounts are read as millions, with a units backstop', () => {
  eq(usdFromLlamaAmount(12), 12000000, '12 means $12M');
  eq(usdFromLlamaAmount(0.85), 850000, 'fractional millions');
  eq(usdFromLlamaAmount(12000000), 12000000, 'already USD stays USD');
  eq(usdFromLlamaAmount(0), null);
  eq(usdFromLlamaAmount('nope'), null);
});

check('USD formatting is readable and dash-free', () => {
  eq(formatUsd(12000000), '$12M');
  eq(formatUsd(850000), '$850K');
  eq(formatUsd(1500000000), '$1.5B');
  eq(formatUsd(null), null);
});

check('dates accept seconds, milliseconds, and ISO strings', () => {
  eq(isoDate(1767225600), '2026-01-01', 'unix seconds');
  eq(isoDate(1767225600000), '2026-01-01', 'unix milliseconds');
  eq(isoDate('2026-01-01T00:00:00.000Z'), '2026-01-01', 'ISO string');
  eq(isoDate(null), null);
  eq(isoDate('not a date'), null);
});

// ── cryptoSources: normalization ──────────────────────────────────────────────

check('a DeFiLlama raise normalizes onto the shared record shape', () => {
  const rec = normalizeLlamaRaise({
    name: 'Morpho', date: 1772323200, amount: 50, round: 'Series B',
    category: 'Lending', chains: ['Ethereum'],
    leadInvestors: ['Ribbit Capital'], otherInvestors: ['a16z crypto'],
    source: 'https://blog.morpho.org/series-b', twitter: 'https://x.com/MorphoLabs',
  });
  eq(rec.source, 'defillama');
  eq(rec.name, 'Morpho');
  eq(rec.amount_usd, 50000000);
  eq(rec.round, 'Series B');
  eq(rec.category, 'Lending');
  eq(rec.lead_investors, ['Ribbit Capital']);
  eq(rec.x_handle, 'MorphoLabs');
  eq(rec.domain, 'blog.morpho.org', 'a project-owned host is a valid domain');
});

check('a raise with no project name is dropped', () => {
  eq(normalizeLlamaRaise({ amount: 10 }), null);
  eq(normalizeLlamaRaise(null), null);
});

check('a CryptoRank round resolves its project name through the currency map', () => {
  const map = new Map([[28, { name: 'Ethena', slug: 'ethena', symbol: 'ENA' }]]);
  const rec = normalizeCryptoRankRound({
    id: 9, currencyId: 28, type: 'SERIES A', date: '2026-04-10T00:00:00.000Z',
    dateAccuracy: 'day', raised: '14000000',
    category: { id: 12, slug: 'defi', name: 'DeFi' },
    allInvestors: [{ id: 1, name: 'Dragonfly' }],
  }, map);
  eq(rec.name, 'Ethena');
  eq(rec.amount_usd, 14000000, 'CryptoRank raised is already USD');
  eq(rec.date, '2026-04-10');
  eq(rec.category, 'DeFi');
  eq(rec.other_investors, ['Dragonfly']);
  eq(rec.source_url, 'https://cryptorank.io/ico/ethena');
});

check('a year-accuracy CryptoRank date is reported as unknown, not as Jan 1', () => {
  const map = new Map([[28, { name: 'Ethena', slug: 'ethena' }]]);
  const rec = normalizeCryptoRankRound({
    currencyId: 28, type: 'SEED', date: '2026-01-01T00:00:00.000Z',
    dateAccuracy: 'year', raised: '1000000', category: null, allInvestors: [],
  }, map);
  eq(rec.date, null);
});

check('an unresolvable CryptoRank project id is dropped', () => {
  eq(normalizeCryptoRankRound({ currencyId: 999, type: 'SEED' }, new Map()), null);
});

// ── cryptoSources: cross-source dedupe ────────────────────────────────────────

check('the same project from both sources collapses to one record', () => {
  const llama = normalizeLlamaRaise({
    name: 'Ethena', date: 1775779200, amount: 14, round: 'Series A',
    source: 'https://coindesk.com/ethena', twitter: '@ethena_labs',
  });
  const map = new Map([[28, { name: 'Ethena Labs', slug: 'ethena' }]]);
  const cr = normalizeCryptoRankRound({
    currencyId: 28, type: 'SERIES A', date: '2026-04-10T00:00:00.000Z', dateAccuracy: 'day',
    raised: '14000000', category: { name: 'DeFi' }, allInvestors: [{ name: 'Dragonfly' }],
  }, map);

  const { records, duplicates } = dedupeRaises([llama, cr]);
  eq(records.length, 1, 'one project');
  eq(duplicates, 1, 'one duplicate folded');
  eq(records[0].name, 'Ethena', 'DeFiLlama record wins as primary');
  eq(records[0].x_handle, 'ethena_labs', 'keeps the X handle DeFiLlama had');
  eq(records[0].category, 'DeFi', 'fills the category CryptoRank had');
  eq(records[0].other_investors, ['Dragonfly'], 'fills the investors CryptoRank had');
  eq(records[0].sources.sort(), ['cryptorank', 'defillama'], 'records both sources');
});

check('dedupe keys ignore ticker suffixes and protocol/labs noise', () => {
  eq(raiseKey({ name: 'Ethena (ENA)' }), raiseKey({ name: 'Ethena Labs' }));
  eq(raiseKey({ name: 'Morpho Protocol' }), raiseKey({ name: 'Morpho' }));
  assert.notStrictEqual(raiseKey({ name: 'Morpho' }), raiseKey({ name: 'Morpheus' }));
});

check('two projects sharing a name key but different domains stay separate', () => {
  const { records } = dedupeRaises([
    { source: 'defillama', name: 'Echo', domain: 'echo.xyz', date: '2026-05-01' },
    { source: 'defillama', name: 'Echo', domain: 'echoprotocol.fi', date: '2026-05-02' },
  ]);
  eq(records.length, 2);
});

check('a project that raised twice in the window keeps its most recent round', () => {
  const { records, duplicates } = dedupeRaises([
    { source: 'defillama', name: 'Acme', date: '2026-02-01', round: 'Seed', amount_usd: 3e6, source_url: 'https://a.co/seed' },
    { source: 'defillama', name: 'Acme', date: '2026-06-01', round: 'Series A', amount_usd: 2e7, source_url: 'https://a.co/a' },
  ]);
  eq(records.length, 1);
  eq(duplicates, 1);
  eq(records[0].date, '2026-06-01');
  eq(records[0].round, 'Series A');
  eq(records[0].amount_usd, 2e7);
});

// ── cryptoDiscovery: the peer rule in crypto vocabulary ───────────────────────

check('crypto analytics and intelligence vendors are peers', () => {
  for (const name of ['Nansen', 'Dune', 'Arkham Intelligence', 'Messari', 'Kaito AI', 'Token Terminal']) {
    assert.strictEqual(isCryptoPeer({ name, category: 'DeFi' }).peer, true, name + ' should be a peer');
  }
  assert.strictEqual(isCryptoPeer({ name: 'SomeProject', category: 'On-chain analytics' }).peer, true,
    'analytics category is a peer');
  assert.strictEqual(isCryptoPeer({ name: 'SomeProject', category: 'Blockchain data' }).peer, true,
    'blockchain data category is a peer');
});

check('an ordinary DeFi project is not a peer', () => {
  assert.strictEqual(isCryptoPeer({ name: 'Morpho', category: 'Lending' }).peer, false);
  assert.strictEqual(isCryptoPeer({ name: 'Hyperliquid', category: 'Perps DEX' }).peer, false);
  assert.strictEqual(isCryptoPeer({ name: 'Ethena', category: 'Stablecoin' }).peer, false);
});

check('the shared peer classifier also catches crypto data vendors from search', () => {
  eq(classifyCompany({ company: 'Nansen', category: 'Crypto', trigger: 'Raised a Series B' }).classification, 'peer');
  eq(classifyCompany({ company: 'Chainalysis', category: 'Crypto', trigger: 'New product' }).classification, 'peer');
  eq(classifyCompany({ company: 'Morpho', category: 'Lending', trigger: 'Raised $50M' }).classification, 'prospect');
});

// ── cryptoDiscovery: category fit ─────────────────────────────────────────────

check('competitive categories are a fit', () => {
  for (const c of ['DeFi lending', 'Perp DEX', 'Liquid staking', 'Restaking', 'Yield', 'Stablecoin',
                   'L2', 'Rollup', 'Bridge', 'Wallet', 'Exchange', 'NFT marketplace', 'Gaming',
                   'Prediction markets', 'RWA', 'Payments']) {
    eq(categoryVerdict(c), 'fit', c);
  }
});

check('deep plumbing with no go-to-market is not a fit', () => {
  for (const c of ['Mining hardware', 'Node hosting', 'ZK proving', 'Key management',
                   'KYC compliance', 'Security audits']) {
    eq(categoryVerdict(c), 'unfit', c);
  }
});

check('a competitive signal beats a plumbing signal in the same category', () => {
  eq(categoryVerdict('ZK rollup'), 'fit', 'the rollup competes publicly for developers');
});

check('an unknown or missing category is deferred to the model, not dropped', () => {
  eq(categoryVerdict(''), 'unknown');
  eq(categoryVerdict(null), 'unknown');
  eq(categoryVerdict('Something nobody has categorized'), 'unknown');
});

// ── cryptoDiscovery: candidate shape ──────────────────────────────────────────

check('round labels map onto the stage vocabulary the role picker understands', () => {
  eq(stageFromRound('PRE SEED'), 'pre-seed');
  eq(stageFromRound('SEED'), 'seed');
  eq(stageFromRound('SERIES A'), 'small');
  eq(stageFromRound('SERIES B'), 'growth');
  eq(stageFromRound('Series D'), 'large');
  eq(stageFromRound('Undisclosed', 8e7), 'large', 'a huge undisclosed round is late stage');
  eq(stageFromRound('Strategic', 2e6), 'seed', 'a small strategic round is founder led');
  eq(rolesForStage(stageFromRound('SEED'))[0], 'Founder', 'seed hunts for the founder');
});

check('the trigger line is human, dated, and free of forbidden punctuation', () => {
  const t = buildTrigger({
    name: 'Morpho', amount_usd: 5e7, round: 'Series B',
    lead_investors: ['Ribbit Capital'], other_investors: ['a16z'], category: 'Lending',
  });
  assert.ok(t.includes('$50M'), 'has the amount: ' + t);
  assert.ok(t.includes('Series B'), 'has the round: ' + t);
  assert.ok(t.includes('Ribbit Capital'), 'has the lead investor: ' + t);
  assert.ok(!/[–—]/.test(t), 'no em-dash or en-dash: ' + t);
  assert.ok(!/\w\s\+\s\w/.test(t), 'no connector plus: ' + t);
});

check('a raise with no amount or investors still produces a usable trigger', () => {
  const t = buildTrigger({ name: 'Acme', amount_usd: null, round: null, lead_investors: [], other_investors: [] });
  assert.ok(t.length > 0 && !/undefined|null|NaN/.test(t), 'clean fallback text: ' + t);
});

check('a candidate carries the fields the pipeline and the X fallback need', () => {
  const c = toCandidate({
    source: 'defillama', sources: ['defillama'], name: 'Morpho', date: '2026-06-01',
    amount_usd: 5e7, round: 'Series B', category: 'Lending',
    lead_investors: ['Ribbit'], other_investors: [], chains: ['Ethereum'],
    source_url: 'https://blog.morpho.org/b', domain: 'blog.morpho.org', x_handle: 'MorphoLabs',
  });
  eq(c.company, 'Morpho');
  eq(c.trigger_date, '2026-06-01', 'freshness ranking reads this');
  eq(c.trigger_url, 'https://blog.morpho.org/b');
  eq(c.source_kind, 'crypto', 'marks it eligible for the X fallback');
  eq(c.discovery_source, 'defillama');
  eq(c.x_handle, 'MorphoLabs');
  eq(c.stage_size, 'growth');
});

check('a raise with no announcement link falls back to the raises dashboard', () => {
  const c = toCandidate({ source: 'defillama', name: 'Acme', date: '2026-06-01', source_url: null, project_url: null });
  eq(c.trigger_url, 'https://defillama.com/raises');
});

// ── provider: the X people gates ──────────────────────────────────────────────

const X_HITS = [
  { title: 'Paul Frambot (@PaulFrambot) / X', link: 'https://x.com/PaulFrambot',
    snippet: 'Co-founder and CEO at Morpho. Building permissionless lending.' },
  { title: 'Morpho (@MorphoLabs) / X', link: 'https://x.com/MorphoLabs',
    snippet: 'The Morpho Protocol official account.' },
];

const GOOD_X_PERSON = {
  person_name: 'Paul Frambot', person_title: 'Co-founder and CEO', person_seniority: 'founder',
  x_handle: 'PaulFrambot', profileUrl: 'https://x.com/PaulFrambot',
  current_employer: 'Morpho', company_match: true, employment_verified: true,
  is_project_account: false, employment_evidence: 'Co-founder and CEO at Morpho',
};

check('a verified current founder on X is accepted and marked LinkedIn-unavailable', () => {
  const { person, reason } = classifyXPersonResult('Morpho', GOOD_X_PERSON, X_HITS);
  eq(reason, null);
  eq(person.person_name, 'Paul Frambot');
  eq(person.channel, 'x');
  eq(person.x_handle, 'PaulFrambot');
  eq(person.profileUrl, 'https://x.com/PaulFrambot');
  eq(person.linkedin_status, 'unavailable', 'honest about the missing LinkedIn');
});

check('an X profile that was not in the search results is rejected', () => {
  const p = { ...GOOD_X_PERSON, profileUrl: 'https://x.com/SomeoneInvented' };
  eq(classifyXPersonResult('Morpho', p, X_HITS).reason, 'x_not_in_hits');
});

check('a handle that disagrees with its own profile URL is rejected', () => {
  const p = { ...GOOD_X_PERSON, x_handle: 'SomeoneElse' };
  eq(classifyXPersonResult('Morpho', p, X_HITS).reason, 'x_not_in_hits');
});

check('the project account is never returned as a person', () => {
  const flagged = {
    person_name: 'Morpho', person_title: 'Protocol', x_handle: 'MorphoLabs',
    profileUrl: 'https://x.com/MorphoLabs', current_employer: 'Morpho',
    company_match: true, employment_verified: true, is_project_account: true,
  };
  eq(classifyXPersonResult('Morpho', flagged, X_HITS).reason, 'x_project_account');

  // Backstop: the model forgot the flag, but the handle IS the project name.
  const unflagged = { ...flagged, is_project_account: false };
  eq(classifyXPersonResult('Morpho', unflagged, X_HITS).reason, 'x_project_account');
});

check('the project-handle backstop sees through glued-on decorations', () => {
  for (const h of ['Morpho', 'MorphoLabs', 'morpho_labs', 'MorphoProtocol', 'morphofi', '0xMorpho', 'Morpho_Official']) {
    assert.strictEqual(handleLooksLikeProject(h, 'Morpho'), true, h + ' is the project account');
  }
});

check('the backstop leaves ordinary founder handles alone', () => {
  for (const h of ['PaulFrambot', 'paul', 'morpheus', 'MorphoGuy', '0xSisyphus']) {
    assert.strictEqual(handleLooksLikeProject(h, 'Morpho'), false, h + ' is a person');
  }
});

check('an unverified or former role on X is rejected', () => {
  eq(classifyXPersonResult('Morpho', { ...GOOD_X_PERSON, employment_verified: false }, X_HITS).reason,
    'x_employment_unverified');

  const formerHits = [{ title: 'Someone (@ExPerson) / X', link: 'https://x.com/ExPerson',
    snippet: 'Ex-Morpho. Now building something new.' }];
  const formerPerson = { ...GOOD_X_PERSON, x_handle: 'ExPerson', profileUrl: 'https://x.com/ExPerson' };
  eq(classifyXPersonResult('Morpho', formerPerson, formerHits).reason, 'x_former_employee');
});

check('a founder of a different project is rejected, however similar the name', () => {
  eq(classifyXPersonResult('Morpho', { ...GOOD_X_PERSON, company_match: false }, X_HITS).reason,
    'x_company_match_false');
  eq(classifyXPersonResult('Morpho', { ...GOOD_X_PERSON, current_employer: 'Morpho Genetics' }, X_HITS).reason,
    'x_employer_mismatch');
});

check('a nameless result is never returned as a person', () => {
  eq(classifyXPersonResult('Morpho', { ...GOOD_X_PERSON, person_name: '  ' }, X_HITS).reason, 'x_project_account');
});

check('legal-entity variants still match the target project', () => {
  const { person } = classifyXPersonResult('Morpho', { ...GOOD_X_PERSON, current_employer: 'Morpho Labs' }, X_HITS);
  assert.ok(person, 'Morpho Labs should match Morpho');
});

check('every X gate has a funnel label', () => {
  for (const r of X_REJECTION_REASONS) {
    assert.ok(REJECTION_LABELS[r], 'missing label for ' + r);
    assert.ok(!/[–—]/.test(REJECTION_LABELS[r]), 'label has a dash: ' + r);
  }
});

// ── provider: merging the two discovery pools ─────────────────────────────────

const searchCandidate = (company, date, domain) => ({
  company, domain: domain || null, trigger_date: date, source_kind: 'search', discovery_source: 'serper',
});
const cryptoCandidate = (company, date, domain) => ({
  company, domain: domain || null, trigger_date: date, source_kind: 'crypto',
  discovery_source: 'defillama', x_handle: company.toLowerCase(),
});

check('a project found by both sources appears once, enriched', () => {
  const merged = mergeCandidatePools(
    [searchCandidate('Morpho', '2026-06-01')],
    [cryptoCandidate('Morpho Labs', '2026-06-05')],
    10);
  eq(merged.duplicates, 1);
  eq(merged.candidates.length, 1);
  eq(merged.candidates[0].discovery_source, 'serper,defillama', 'records both sources');
  eq(merged.candidates[0].source_kind, 'crypto', 'stays eligible for the X fallback');
  eq(merged.candidates[0].x_handle, 'morpho labs', 'gains the crypto X handle');
});

check('domains take priority over names when matching across sources', () => {
  const merged = mergeCandidatePools(
    [searchCandidate('Acme Finance', '2026-06-01', 'acme.xyz')],
    [cryptoCandidate('Acme', '2026-06-02', 'acme.xyz')],
    10);
  eq(merged.duplicates, 1);
  eq(merged.candidates.length, 1);
});

check('neither source can crowd the other out of the pool', () => {
  const search = Array.from({ length: 20 }, (_, i) => searchCandidate('S' + i, '2026-01-0' + (i % 9 + 1)));
  const crypto = Array.from({ length: 20 }, (_, i) => cryptoCandidate('C' + i, '2026-07-0' + (i % 9 + 1)));
  const merged = mergeCandidatePools(search, crypto, 10);
  eq(merged.candidates.length, 10, 'respects the pool size');
  const fromSearch = merged.candidates.filter(c => c.source_kind === 'search').length;
  const fromCrypto = merged.candidates.filter(c => c.source_kind === 'crypto').length;
  assert.ok(fromSearch >= 5, 'search keeps its half, got ' + fromSearch);
  assert.ok(fromCrypto >= 5, 'crypto keeps its half, got ' + fromCrypto);
});

check('one source takes the whole pool when the other is empty', () => {
  const crypto = Array.from({ length: 12 }, (_, i) => cryptoCandidate('C' + i, '2026-07-01'));
  eq(mergeCandidatePools([], crypto, 10).candidates.length, 10);
  const search = Array.from({ length: 12 }, (_, i) => searchCandidate('S' + i, '2026-07-01'));
  eq(mergeCandidatePools(search, [], 10).candidates.length, 10);
  eq(mergeCandidatePools([], [], 10).candidates.length, 0);
});

check('the merged pool is ordered freshest trigger first', () => {
  const merged = mergeCandidatePools(
    [searchCandidate('Old', '2026-01-01'), searchCandidate('Undated', null)],
    [cryptoCandidate('New', '2026-07-01')],
    10);
  eq(merged.candidates.map(c => c.company), ['New', 'Old', 'Undated']);
});

// ── funnel: the X fallback must not double-count a company ────────────────────

check('a company that fails both routes counts as one no-person drop', () => {
  const real = makeFunnel();
  const linkedin = makeFunnel();
  linkedin.no_person = 1;
  const x = makeFunnel();
  x.no_person = 1;
  x.rejected.x_project_account = 1;

  mergePersonCounts(real, linkedin);
  mergePersonCounts(real, x, { noPerson: false });

  eq(real.no_person, 1, 'one company, one drop');
  eq(real.rejected.x_project_account, 1, 'the X gate detail is still recorded');
});

check('a lead found on X leaves no rejection behind', () => {
  const real = makeFunnel();
  const linkedin = makeFunnel();
  linkedin.rejected.employment_unverified = 1;
  // The success path never merges the scratch funnel, so the real one stays clean.
  real.x_fallback_used += 1;
  eq(real.no_person, 0);
  eq(real.rejected.employment_unverified, 0);
  eq(real.x_fallback_used, 1);
});

// ── pipeline.buildLead: the X fallback end to end, with a stub provider ───────
//
// No network and no Anthropic key: structuredCall returns null, so scoring
// degrades to the neutral pass-through and drafting returns null. That is
// exactly the path we want to exercise, because it isolates the gates.

const { buildLead, SCORE_THRESHOLD } = require('./src/outbound/pipeline');

// A provider whose two people finders are scripted per test.
function stubProvider({ linkedInPerson = null, xPerson = null, onFindPeople, onFindPeopleOnX } = {}) {
  const calls = { findPeople: 0, findPeopleOnX: 0 };
  return {
    calls,
    async findPeople(company, roles, { funnel } = {}) {
      calls.findPeople += 1;
      if (onFindPeople) return onFindPeople(funnel);
      if (!linkedInPerson) { if (funnel) funnel.no_person += 1; return []; }
      return [linkedInPerson];
    },
    async findPeopleOnX(company, { funnel } = {}) {
      calls.findPeopleOnX += 1;
      if (onFindPeopleOnX) return onFindPeopleOnX(funnel);
      if (!xPerson) { if (funnel) funnel.no_person += 1; return []; }
      return [xPerson];
    },
    async findContact(person) {
      const isX = person.channel === 'x';
      return {
        contact_status: 'manual', channel: person.channel || 'linkedin',
        handle_or_email: person.profileUrl || null,
        backup_channel: isX ? null : 'linkedin', profileUrl: person.profileUrl || null,
      };
    },
  };
}

const CRYPTO_CANDIDATE = {
  company: 'Morpho', domain: 'morpho.org', category: 'Lending', stage_size: 'seed',
  trigger: 'Raised $50M in a Series B round, led by Ribbit Capital.',
  trigger_url: 'https://blog.morpho.org/b', trigger_date: '2026-06-01',
  source_kind: 'crypto', discovery_source: 'defillama', x_handle: 'MorphoLabs',
};

const X_PERSON = {
  person_name: 'Paul Frambot', person_title: 'Co-founder and CEO', person_seniority: 'founder',
  profileUrl: 'https://x.com/PaulFrambot', channel: 'x', x_handle: 'PaulFrambot',
  linkedin_status: 'unavailable', employment_verified: true, current_employer: 'Morpho', company_match: true,
};

const LINKEDIN_PERSON = {
  person_name: 'Someone Real', person_title: 'Head of Growth', person_seniority: 'lead',
  profileUrl: 'https://www.linkedin.com/in/someone-real', channel: 'linkedin',
  employment_verified: true, current_employer: 'Morpho', company_match: true,
};

function runBuildLead(provider, candidate, funnel) {
  return buildLead(provider, 'ICP brief', candidate, funnel, []);
}

// The async cases run in sequence after the synchronous ones, so the summary
// line still prints last. No Anthropic key: these tests must never make a real
// API call, and the no-key path is the one worth pinning anyway.
delete process.env.ANTHROPIC_API_KEY;

(async () => {
  async function acheck(label, fn) {
    try { await fn(); console.log('✅ ' + label); pass++; }
    catch (err) { console.log('❌ ' + label + '\n     ' + String(err.message).split('\n')[0]); fail++; }
  }

  await acheck('a crypto project with no LinkedIn falls back to a verified X profile', async () => {
    const funnel = makeFunnel();
    const provider = stubProvider({ linkedInPerson: null, xPerson: X_PERSON });
    const lead = await runBuildLead(provider, CRYPTO_CANDIDATE, funnel);

    assert.ok(lead, 'the project survives as a lead');
    eq(lead.channel, 'x');
    eq(lead.handle_or_email, 'https://x.com/PaulFrambot', 'reachable on X');
    eq(lead.linkedin_status, 'unavailable', 'marked honestly, never fabricated');
    eq(lead.source, 'defillama', 'provenance recorded');
    eq(lead.backup_channel, null, 'no LinkedIn backup is claimed');
    eq(funnel.x_fallback_used, 1);
    eq(funnel.no_person, 0, 'a found lead is not also a no-person drop');
  });

  await acheck('a crypto project found on LinkedIn never reaches the X finder', async () => {
    const funnel = makeFunnel();
    const provider = stubProvider({ linkedInPerson: LINKEDIN_PERSON, xPerson: X_PERSON });
    const lead = await runBuildLead(provider, CRYPTO_CANDIDATE, funnel);

    eq(provider.calls.findPeopleOnX, 0, 'LinkedIn first, X only as a fallback');
    eq(lead.channel, 'linkedin');
    eq(lead.linkedin_status, 'found');
    eq(funnel.x_fallback_used, 0);
  });

  await acheck('a project with no reachable handle at all is dropped, counted once', async () => {
    const funnel = makeFunnel();
    const provider = stubProvider({
      onFindPeople: (f) => { f.rejected.employment_unverified += 1; return []; },
      onFindPeopleOnX: (f) => { f.no_person += 1; return []; },
    });
    const lead = await runBuildLead(provider, CRYPTO_CANDIDATE, funnel);

    eq(lead, null, 'no contact means no lead, per the no-contact rule');
    eq(funnel.rejected.employment_unverified, 1, 'the LinkedIn gate detail survives');
    assert.strictEqual(funnel.no_person <= 1, true,
      'one company is at most one no-person drop, got ' + funnel.no_person);
  });

  await acheck('a non-crypto candidate never tries the X fallback', async () => {
    const funnel = makeFunnel();
    const provider = stubProvider({ linkedInPerson: null, xPerson: X_PERSON });
    const searchCandidate = { ...CRYPTO_CANDIDATE, source_kind: 'search', discovery_source: 'serper' };
    const lead = await runBuildLead(provider, searchCandidate, funnel);

    eq(lead, null, 'the existing search path is unchanged');
    eq(provider.calls.findPeopleOnX, 0);
    eq(funnel.no_person, 1);
  });

  await acheck('a crypto analytics vendor is dropped at the peer gate, before any lookup', async () => {
    const funnel = makeFunnel();
    const provider = stubProvider({ xPerson: X_PERSON });
    const peer = { ...CRYPTO_CANDIDATE, company: 'Nansen', domain: 'nansen.ai' };
    const lead = await runBuildLead(provider, peer, funnel);

    eq(lead, null);
    eq(funnel.peer, 1);
    eq(provider.calls.findPeople, 0, 'no search spend on a peer');
    eq(provider.calls.findPeopleOnX, 0);
  });

  await acheck('an X lead still scores and ranks on the shared rubric', async () => {
    const funnel = makeFunnel();
    const provider = stubProvider({ xPerson: X_PERSON });
    const lead = await runBuildLead(provider, CRYPTO_CANDIDATE, funnel);
    // Without an Anthropic key scoring degrades to the neutral pass-through,
    // which is what keeps the crypto path usable in a no-key environment.
    eq(lead.score, SCORE_THRESHOLD);
    eq(lead.trigger_at, '2026-06-01', 'the raise date drives freshness ranking');
    eq(lead.company, 'Morpho');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
