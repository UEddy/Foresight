// Outbound — buyer-size gate.
//
// The ICP brief catches the right CATEGORIES (crowded market, /compare page,
// competitive hire) but says nothing about company SIZE, so discovery happily
// surfaced Ramp-scale fintechs and a two-billion-dollar CRM. Those companies
// feel real competitor pain, they are simply Crayon's and Klue's customers, not
// Nivaria's. This module estimates each company's size and stage and decides
// whether it is still a small-team buyer.
//
// This is a SEPARATE gate from the peer classifier (provider.classifyCompany)
// and from the AI-first exclusions in the brief. A company can be a perfect
// category and pain fit and still be far too big to buy, so the gates never
// share a decision or a counter.
//
// Bands (BAND_RANK orders them, worst wins when two signals disagree). Only
// too_large is DROPPED; fits, borderline, and unknown are all kept:
//   fits       small team, indie or bootstrapped, pre-seed to Series A
//   borderline the grey zone (Series B, roughly 100 to 250 people, up to $150M
//              raised): kept, flagged
//   unknown    the evidence does not support an estimate: KEPT and flagged,
//              never dropped, because a missing number is not a big company
//   too_large  the clearly enterprise tier only: Series C and beyond, unicorn
//              valuation, public, thousands of employees, a named enterprise logo
//
// The gate is tuned to exclude Crayon's and Klue's buyers, NOT everyone above a
// startup. Anything short of that evidence has to be kept, because a lead we
// keep and flag costs a glance and a lead we drop is gone.
//
// Crypto exception (source_kind 'crypto'): raise size is NOT a size signal. A
// protocol that raised $40M is routinely five people in a Discord, so for those
// candidates the round, the funding total, and the token valuation are all
// ignored and the decision rests on headcount and go-to-market maturity alone.
//
// estimateCompanySize() takes its provider as an argument (never imports one),
// so the whole gate is testable with a stub and no network.

const { structuredCall } = require('./ai');
const { sanitizeCopy } = require('../lib/sanitizeText');
const { normalizeCompanyName, matchKnownName } = require('./companyName');

// Worst band wins when signals disagree. 'unknown' ranks lowest so a real
// estimate from either source always beats "we could not tell".
const BAND_RANK = { unknown: 0, fits: 1, borderline: 2, too_large: 3 };

// Headcount thresholds. The buyer is "roughly under 50 to 100 people", so 100 is
// a clean fit; 100 to 250 is the grey zone we keep and flag; past 250 the
// company is buying enterprise competitive intelligence, not Nivaria.
const EMPLOYEES_FIT_MAX = 100;
const EMPLOYEES_EXCLUDE_MIN = 250;

// Funding and valuation thresholds (never applied to crypto candidates).
//
// These are deliberately set ABOVE normal Series B territory. The old ceiling
// ($25M borderline, $75M exclude, $250M valuation) contradicted the round rule
// directly: a Series B company is routinely $40M to $60M raised at a $300M to
// $600M valuation, so the money test hard-excluded the exact companies the round
// test was keeping, and the gate returned near-zero leads. The exclusion line is
// now drawn at the clearly-enterprise tier instead: past-Series-B money, and a
// unicorn valuation.
const FUNDING_BORDERLINE_USD = 50e6;
const FUNDING_EXCLUDE_USD = 150e6;
const VALUATION_EXCLUDE_USD = 1e9;

// Companies that are unambiguously past the buyer size. This is a free
// exclusion that costs no search and no model call. Every entry here is large by
// HEADCOUNT as well as by funding, so the list applies to crypto candidates too
// without breaking the crypto rule.
//
// Matched on the WHOLE company name, not on a word inside it (see
// companyName.js): a third of these entries are ordinary English words
// ('block', 'box', 'square', 'circle', 'drift', 'segment', 'notion', 'wise',
// 'lattice', 'elastic'), and word-boundary matching was silently hard-dropping
// small companies like "Wise Systems" or "Segment Labs" before they ever reached
// research. A name that merely CONTAINS an entry now costs one search and is
// sized up on its own evidence.
const KNOWN_TOO_LARGE = [
  // Fintech and payments
  'ramp', 'brex', 'stripe', 'plaid', 'adyen', 'revolut', 'wise', 'chime', 'block',
  'square', 'marqeta', 'checkout.com', 'klarna', 'affirm', 'toast', 'gusto',
  // CRM, sales, and marketing suites
  'salesforce', 'hubspot', 'zendesk', 'freshworks', 'zoho', 'pipedrive', 'intercom',
  'klaviyo', 'braze', 'mailchimp', 'activecampaign', 'outreach.io', 'salesloft',
  'gong.io', 'clari', 'apollo.io', 'zoominfo', 'sixsense', '6sense', 'drift',
  // Work, design, and collaboration
  'atlassian', 'asana', 'monday.com', 'notion', 'figma', 'canva', 'airtable',
  'miro', 'smartsheet', 'clickup', 'slack', 'zoom', 'dropbox', 'box',
  // Data, infra, and devtools
  'datadog', 'snowflake', 'databricks', 'mongodb', 'elastic', 'confluent',
  'hashicorp', 'gitlab', 'github', 'vercel', 'retool', 'twilio', 'sendgrid',
  'segment', 'amplitude', 'mixpanel', 'new relic', 'pagerduty', 'okta', 'auth0',
  // Commerce and marketplaces
  'shopify', 'bigcommerce', 'squarespace', 'wix', 'webflow', 'wordpress',
  'automattic', 'doordash', 'instacart', 'airbnb', 'uber', 'lyft',
  // HR and ops
  'deel', 'rippling', 'remote.com', 'personio', 'workday', 'bamboohr', 'lattice',
  // Crypto companies that are large by headcount (not by raise)
  'coinbase', 'binance', 'kraken', 'crypto.com', 'circle', 'ripple', 'consensys',
  'gemini', 'bitmex', 'okx', 'bybit', 'ledger', 'fireblocks', 'blockchain.com',
];

// Round labels, mapped to a band. Order matters: the later-stage patterns are
// tested before the earlier ones so "Series A extension" is not read as an IPO.
const ROUND_TOO_LARGE_RE = /\b(?:series\s*[c-z]\b|growth\s*equity|private\s*equity|mezzanine|pre[\s-]?ipo|post[\s-]?ipo|ipo\b|publicly\s*traded|public\s*company|nasdaq|nyse|listed\s*company)/i;
const ROUND_BORDERLINE_RE = /\bseries\s*b\b/i;
const ROUND_FITS_RE = /\b(?:bootstrap\w*|self[\s-]?funded|indie|solo|angel|grant|accelerator|incubat\w*|friends\s*and\s*family|pre[\s-]?seed|seed\b|series\s*a\b)/i;

// Applied ONLY to the model's structured last_round field, where a bare
// "Public" or "Acquired" is unambiguous. It is deliberately not used on free
// text, where "public beta" and "public sector" are not size signals.
const ROUND_LABEL_TOO_LARGE_RE = /^\s*(?:public|listed|ipo|acquired|late[\s-]?stage|pre[\s-]?ipo)\b/i;

// Text that names an enterprise-scale outcome regardless of the round label.
const SCALE_TOO_LARGE_RE = /\b(?:unicorn|decacorn|fortune\s*500|multinational|publicly\s*listed|acquired\s*by\s*(?:salesforce|adobe|oracle|sap|microsoft|google|cisco|ibm))\b/i;

// "valued at $2B", "$1.4 billion valuation".
const VALUATION_TEXT_RE = /(?:valu\w*\s*(?:at|of)?\s*\$?\s*([\d.,]+)\s*(k|m|b|thousand|million|billion)\b)|(?:\$?\s*([\d.,]+)\s*(k|m|b|thousand|million|billion)\s*valuation)/i;

// Does this company name BE one of the known-large companies (rather than merely
// contain one)? See companyName.js for why the whole name has to match.
function matchKnownTooLarge(name) {
  return matchKnownName(name, KNOWN_TOO_LARGE);
}

// The worse (higher-ranked) of two bands. Used to combine the free field-based
// read with the researched estimate: neither one can soften the other.
function worseBand(a, b) {
  const ra = BAND_RANK[a] == null ? 0 : BAND_RANK[a];
  const rb = BAND_RANK[b] == null ? 0 : BAND_RANK[b];
  return ra >= rb ? (a || 'unknown') : (b || 'unknown');
}

// Is this candidate from the crypto raises source? Those are exempt from every
// money-based signal (see the crypto exception at the top of this file).
function isCryptoCandidate(company) {
  return String(company?.source_kind || '').toLowerCase() === 'crypto';
}

// ── parsing helpers ───────────────────────────────────────────────────────────

// A money string or number to USD. Accepts 3500000, "$3.5M", "2.1 billion",
// "750k". Returns null when there is no number to read.
function parseMoneyUsd(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').trim();
  const m = /(-?[\d.]+)\s*(k|m|b|thousand|million|billion|bn)?/i.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = String(m[2] || '').toLowerCase();
  if (unit === 'k' || unit === 'thousand') return n * 1e3;
  if (unit === 'm' || unit === 'million') return n * 1e6;
  if (unit === 'b' || unit === 'bn' || unit === 'billion') return n * 1e9;
  return n;
}

// An employee count or band to a single number for gating. A RANGE returns its
// UPPER bound ("51-200" -> 200): the top of the band is the size we have to be
// able to afford being wrong about. Accepts 40, "40", "11-50", "1,000+",
// "about 20", "51 to 200".
function parseEmployeeCount(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const s = String(v).replace(/,/g, '');
  const range = /(\d+)\s*(?:-|to|and)\s*(\d+)/i.exec(s);
  if (range) return parseInt(range[2], 10);
  const single = /(\d+)/.exec(s);
  return single ? parseInt(single[1], 10) : null;
}

// The largest headcount stated in free text ("about 5,000 employees", "10,000+
// staff", "a team of 8"). Returns null when the text never talks about people.
function employeesFromText(text) {
  const t = String(text || '');
  const re = /(?:team\s+of\s+)?([\d,]+)\s*(?:\+|plus)?\s*(?:-|to)?\s*([\d,]+)?\s*(?:\+|plus)?\s*(?:employees|people|staff|headcount|team\s*members|engineers)/gi;
  let best = null, m;
  while ((m = re.exec(t)) !== null) {
    const n = parseEmployeeCount(m[2] || m[1]);
    if (Number.isFinite(n) && (best == null || n > best)) best = n;
  }
  return best;
}

// A valuation stated in free text, in USD, or null.
function valuationFromText(text) {
  const m = VALUATION_TEXT_RE.exec(String(text || ''));
  if (!m) return null;
  const num = m[1] || m[3];
  const unit = m[2] || m[4] || '';
  return parseMoneyUsd(String(num) + unit);
}

// ── the free, deterministic read ──────────────────────────────────────────────

// Size read from the fields discovery already gave us, with no search and no
// model call: the company name against the known-too-large list, then the
// stage_size / category text, then a narrow set of self-referential phrases in
// the trigger. Returns { band, reason, signals }.
//
// Deliberately conservative: it exists to drop the obvious enterprise names for
// free, so anything it cannot place comes back 'unknown' and goes on to the
// researched estimate.
function classifySizeFromFields(company) {
  const name = String(company?.company || '');
  const stage = String(company?.stage_size || '');
  const category = String(company?.category || '');
  const trigger = String(company?.trigger || '');
  const crypto = isCryptoCandidate(company);
  const signals = {};
  const reasons = [];
  let band = 'unknown';
  const bump = (b, why) => { band = worseBand(band, b); if (why) reasons.push(why); };

  const known = matchKnownTooLarge(name);
  if (known) {
    signals.known_large = known;
    return { band: 'too_large', reason: 'known large company (' + known + ')', signals };
  }

  // stage_size and category are the discovery model's own words about size, so
  // they are read in full. The trigger is not: it often describes somebody else
  // (a customer, an acquirer), so only self-referential scale phrasing counts.
  const sizeText = stage + ' ' + category;
  const emp = employeesFromText(sizeText) ?? parseEmployeeCountFromStage(stage);
  if (Number.isFinite(emp)) {
    signals.employees = emp;
    if (emp > EMPLOYEES_EXCLUDE_MIN) bump('too_large', 'about ' + emp + ' employees');
    else if (emp > EMPLOYEES_FIT_MAX) bump('borderline', 'about ' + emp + ' employees');
    else bump('fits', 'about ' + emp + ' employees');
  }

  if (SCALE_TOO_LARGE_RE.test(sizeText) || SCALE_TOO_LARGE_RE.test(trigger)) {
    signals.scale_phrase = true;
    bump('too_large', 'described at enterprise scale');
  }

  // Money signals never apply to crypto candidates.
  if (!crypto) {
    if (ROUND_TOO_LARGE_RE.test(sizeText)) { signals.round = 'late'; bump('too_large', 'late stage: ' + stage.trim()); }
    else if (ROUND_BORDERLINE_RE.test(sizeText)) { signals.round = 'series b'; bump('borderline', 'Series B'); }
    else if (ROUND_FITS_RE.test(sizeText)) { signals.round = 'early'; bump('fits', 'early stage: ' + stage.trim()); }

    // Trigger phrasing that can only be about this company.
    if (/\braise[ds]?\b[^.]{0,60}?\bseries\s*[c-z]\b/i.test(trigger)) {
      signals.trigger_round = true; bump('too_large', 'raised a Series C or later round');
    }
    const val = valuationFromText(sizeText) ?? valuationFromText(trigger);
    if (Number.isFinite(val)) {
      signals.valuation_usd = val;
      if (val >= VALUATION_EXCLUDE_USD) bump('too_large', 'valued at ' + formatUsdShort(val));
    }
  }

  return { band, reason: reasons.length ? reasons.join(', ') : null, signals };
}

// stage_size sometimes carries a bare band with no noun ("11-50", "1000+").
function parseEmployeeCountFromStage(stage) {
  const s = String(stage || '').trim();
  if (!/^\s*[\d,]+\s*(?:\+|plus)?\s*(?:-|to)?\s*[\d,]*\s*(?:\+|plus)?\s*$/.test(s)) return null;
  return parseEmployeeCount(s);
}

// ── the decision ──────────────────────────────────────────────────────────────

// Turn a normalized estimate into a band. Pure: same estimate in, same band out,
// so the thresholds are calibratable and unit-testable.
//
// opts.crypto skips every money signal (round, total funding, valuation) and
// leaves headcount and go-to-market maturity as the only tests, because a large
// raise says nothing about how big a crypto team is.
function decideSize(estimate, { crypto = false } = {}) {
  const est = estimate || {};
  const reasons = [];
  let band = 'unknown';
  const bump = (b, why) => { band = worseBand(band, b); if (why) reasons.push(why); };

  const emp = Number.isFinite(est.employees_max) ? est.employees_max : null;
  if (emp != null) {
    if (emp > EMPLOYEES_EXCLUDE_MIN) bump('too_large', 'about ' + emp + ' employees');
    else if (emp > EMPLOYEES_FIT_MAX) bump('borderline', 'about ' + emp + ' employees');
    else bump('fits', 'about ' + emp + ' employees');
  }

  // Go-to-market maturity applies to everyone, and it is the main non-headcount
  // test left for a crypto candidate.
  const gtm = String(est.gtm_maturity || '').toLowerCase();
  if (gtm === 'scaled') bump('borderline', 'a scaled go-to-market org');
  else if (gtm === 'founder-led' || gtm === 'small-team') bump('fits', gtm === 'founder-led' ? 'founder-led go to market' : 'small go-to-market team');

  if (!crypto) {
    const round = String(est.last_round || '');
    if (ROUND_TOO_LARGE_RE.test(round) || ROUND_LABEL_TOO_LARGE_RE.test(round)) bump('too_large', 'last round ' + round.trim());
    else if (ROUND_BORDERLINE_RE.test(round)) bump('borderline', 'last round Series B');
    else if (ROUND_FITS_RE.test(round)) bump('fits', 'last round ' + round.trim());

    const funding = Number.isFinite(est.total_funding_usd) ? est.total_funding_usd : null;
    if (funding != null) {
      if (funding >= FUNDING_EXCLUDE_USD) bump('too_large', formatUsdShort(funding) + ' raised');
      else if (funding >= FUNDING_BORDERLINE_USD) bump('borderline', formatUsdShort(funding) + ' raised');
      else bump('fits', formatUsdShort(funding) + ' raised');
    }

    const val = Number.isFinite(est.valuation_usd) ? est.valuation_usd : null;
    if (val != null && val >= VALUATION_EXCLUDE_USD) bump('too_large', 'valued at ' + formatUsdShort(val));
  }

  // Only the reasons that argue for the band we landed on are worth reporting.
  return { band, reason: reasons.length ? reasons.join(', ') : null };
}

// ── the estimate ──────────────────────────────────────────────────────────────

const GTM_VALUES = ['founder-led', 'small-team', 'scaled', 'unknown'];

// Coerce a model response into the stored estimate shape. Everything is
// optional: a model that could not find a number returns nulls and the gate
// treats the company as unknown (kept, flagged), never as large.
function normalizeEstimate(raw, { crypto = false } = {}) {
  const r = raw || {};
  const employees = parseEmployeeCount(r.employees);
  const range = r.employees_band || r.employees_range || null;
  const fromRange = parseEmployeeCount(range);
  // Gate on the larger of the point estimate and the top of the stated band.
  const known = [employees, fromRange].filter(n => Number.isFinite(n));
  const employees_max = known.length ? Math.max(...known) : null;
  const gtm = String(r.gtm_maturity || '').toLowerCase();
  return {
    employees: Number.isFinite(employees) ? employees : null,
    employees_band: range ? sanitizeCopy(String(range)).slice(0, 40) : null,
    employees_max: Number.isFinite(employees_max) ? employees_max : null,
    // Money fields are still RECORDED for a crypto candidate (they are useful
    // context on the lead), they are simply not allowed to decide the band.
    total_funding_usd: parseMoneyUsd(r.total_funding_usd ?? r.total_funding),
    last_round: r.last_round ? sanitizeCopy(String(r.last_round)).slice(0, 60) : null,
    valuation_usd: parseMoneyUsd(r.valuation_usd ?? r.valuation),
    gtm_maturity: GTM_VALUES.includes(gtm) ? gtm : 'unknown',
    confidence: ['high', 'medium', 'low'].includes(String(r.confidence || '').toLowerCase())
      ? String(r.confidence).toLowerCase() : 'low',
    basis: r.basis ? sanitizeCopy(String(r.basis)).slice(0, 240) : null,
    crypto: Boolean(crypto),
  };
}

// Short USD for display: $8.5M, $1.2B, $750k.
function formatUsdShort(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e9) return '$' + trimNum(n / 1e9) + 'B';
  if (n >= 1e6) return '$' + trimNum(n / 1e6) + 'M';
  if (n >= 1e3) return '$' + trimNum(n / 1e3) + 'k';
  return '$' + Math.round(n);
}
function trimNum(x) {
  return String(Math.round(x * 10) / 10).replace(/\.0$/, '');
}

// One short human line for the leads table, so the gate can be calibrated by
// eye: "Seed, 11-50 people, $4M raised". Returns "Size unknown" when nothing
// was findable, which is exactly what the flagged-but-kept leads should read as.
function formatSizeEstimate(estimate) {
  const est = estimate || {};
  const parts = [];
  if (est.last_round) parts.push(est.last_round);
  if (Number.isFinite(est.employees)) parts.push('about ' + est.employees + ' people');
  else if (est.employees_band) parts.push(est.employees_band + ' people');
  if (Number.isFinite(est.total_funding_usd) && est.total_funding_usd > 0) {
    parts.push(formatUsdShort(est.total_funding_usd) + ' raised');
  }
  if (Number.isFinite(est.valuation_usd) && est.valuation_usd > 0) {
    parts.push('valued at ' + formatUsdShort(est.valuation_usd));
  }
  if (!parts.length && est.gtm_maturity && est.gtm_maturity !== 'unknown') {
    parts.push(est.gtm_maturity === 'founder-led' ? 'founder-led' : est.gtm_maturity.replace(/-/g, ' '));
  }
  if (!parts.length) return 'Size unknown';
  return sanitizeCopy(parts.join(', '));
}

// The search we run to size a company up. Kept to one query per company, and
// only for candidates the free field read could not already place.
function sizeQuery(company) {
  const name = String(company?.company || '').trim();
  const domain = String(company?.domain || '').trim();
  const who = domain ? `"${name}" ${domain}` : `"${name}"`;
  return isCryptoCandidate(company)
    ? `${who} team size how many people core contributors`
    : `${who} employees headcount funding raised series valuation`;
}

const ESTIMATE_SYSTEM = 'You size up companies for Nivaria, a competitor-intelligence app whose '
  + 'buyer is a SMALL team: bootstrapped and indie software companies, agencies, and startups from '
  + 'pre-seed through Series B, up to roughly 200 to 250 people. Only the clearly enterprise tier '
  + 'is out of scope: Series C and beyond, unicorns, public companies, and companies with '
  + 'thousands of employees, which can already afford enterprise competitive-intelligence tools. '
  + 'Estimate size and stage from the evidence provided. NEVER invent a number: if the evidence '
  + 'does not support an estimate, return null for that field and set confidence to "low". A '
  + 'company you cannot size is UNKNOWN, not big: most small companies have thin public data, so '
  + 'never guess a large headcount, round, or valuation to fill a gap. Return JSON only. Never use '
  + 'em-dashes, en-dashes, or a connecting "+"; write "and" instead.';

const CRYPTO_SIZE_NOTE = '\n\nThis is a crypto and web3 project. Judge its size by TEAM HEADCOUNT '
  + 'and go-to-market maturity ONLY. A large raise does not mean a large company: well funded '
  + 'protocols are routinely run by a handful of people. Do not treat the raise amount, the round, '
  + 'or a token valuation as evidence of size. Still report the funding figures you find, but base '
  + 'gtm_maturity and the headcount estimate on the team itself.';

// Research one company's size: one web search, one structured model call.
//
// Returns { band, reason, estimate, display, researched }. Never throws: a
// failed search or a missing model key yields an 'unknown' band, which the
// pipeline KEEPS and flags rather than drops.
async function estimateCompanySize(provider, company) {
  const crypto = isCryptoCandidate(company);
  const fromFields = classifySizeFromFields(company);

  // Free exclusion: a name on the known-large list or an explicit late-stage
  // field needs no research, and skipping it saves a search plus a model call.
  if (fromFields.band === 'too_large') {
    const estimate = normalizeEstimate({
      last_round: fromFields.signals.round === 'late' ? String(company?.stage_size || '') : null,
      employees: fromFields.signals.employees ?? null,
      valuation_usd: fromFields.signals.valuation_usd ?? null,
      confidence: 'medium',
      basis: fromFields.reason,
    }, { crypto });
    return {
      band: 'too_large', reason: fromFields.reason, estimate,
      display: formatSizeEstimate(estimate), researched: false,
    };
  }

  let hits = [];
  try {
    hits = (await provider.search(sizeQuery(company), { num: 8 })) || [];
  } catch (err) {
    console.warn('[outbound.sizeGate] size search failed:', company?.company, '-',
      String(err?.message || err).slice(0, 200));
  }

  const user = 'Company: ' + JSON.stringify({
    company: company?.company || null,
    domain: company?.domain || null,
    category: company?.category || null,
    stage_size_guess: company?.stage_size || null,
    trigger: company?.trigger || null,
  })
    + (crypto ? CRYPTO_SIZE_NOTE : '')
    + '\n\nSearch results (JSON):\n' + JSON.stringify(hits.slice(0, 8))
    + '\n\nReturn: { "employees": int|null (best point estimate), "employees_band": string|null '
    + '(for example "1-10", "11-50", "51-200", "201-500", "1000+"), "total_funding_usd": '
    + 'number|null, "last_round": string|null (for example "Bootstrapped", "Pre-seed", "Seed", '
    + '"Series A", "Series C", "Public"), "valuation_usd": number|null, "gtm_maturity": '
    + '"founder-led"|"small-team"|"scaled"|"unknown", "confidence": "high"|"medium"|"low", '
    + '"basis": string (one short sentence naming the evidence you used) }';

  const parsed = await structuredCall({ system: ESTIMATE_SYSTEM, user, maxTokens: 500 });
  const estimate = normalizeEstimate(parsed, { crypto });
  const decided = decideSize(estimate, { crypto });

  // Neither read can soften the other: the free field read and the researched
  // estimate combine to the worse band.
  const band = worseBand(fromFields.band, decided.band);
  const reason = band === fromFields.band && fromFields.reason
    ? (decided.reason ? fromFields.reason + ', ' + decided.reason : fromFields.reason)
    : (decided.reason || fromFields.reason);

  return {
    band, reason, estimate, display: formatSizeEstimate(estimate),
    researched: Boolean(parsed),
  };
}

module.exports = {
  estimateCompanySize, classifySizeFromFields, decideSize, normalizeEstimate,
  formatSizeEstimate, formatUsdShort, worseBand, isCryptoCandidate, sizeQuery,
  parseMoneyUsd, parseEmployeeCount, employeesFromText, valuationFromText,
  normalizeCompanyName, matchKnownTooLarge,
  BAND_RANK, KNOWN_TOO_LARGE,
  EMPLOYEES_FIT_MAX, EMPLOYEES_EXCLUDE_MIN,
  FUNDING_BORDERLINE_USD, FUNDING_EXCLUDE_USD, VALUATION_EXCLUDE_USD,
};
