// Outbound — crypto funding-round sources (DeFiLlama, CryptoRank).
//
// These are the raw data clients for the web3 discovery segment. They fetch
// funding rounds, normalize both vendors onto one RaiseRecord shape, and
// deduplicate across them. They do NOT decide whether a project is a lead: that
// judgment lives in cryptoDiscovery.js, which consumes this module.
//
// ── Endpoint reality (verified 2026-07-27) ────────────────────────────────────
// The raises data is NOT on a free public endpoint any more. The old
// https://api.llama.fi/raises now answers 402 "Upgrade to the paid API plan",
// and https://defillama.com/raises answers 403 to non-browser clients. The
// documented home of the data is the Pro API:
//
//   GET https://pro-api.llama.fi/{API_KEY}/api/raises   ->  { raises: [ ... ] }
//
// so DEFILLAMA_API_KEY is required for this source. Scraping the HTML page was
// ruled out (the brief asked for the JSON endpoint, and the page blocks us).
//
// CryptoRank is the secondary source and also needs a key:
//
//   GET https://api.cryptorank.io/v3/funding-rounds/list  (X-Api-Key header)
//   GET https://api.cryptorank.io/v3/currencies/map       (X-Api-Key header)
//
// The rounds feed identifies a project only by numeric currencyId, so the
// currencies map is fetched once and cached to resolve ids to project names.
// The feed is a Pro-tier endpoint: a Sandbox or Basic key gets 403, which we
// treat as "source unavailable", never as a run failure. Both sources are
// optional and independent: a missing or rejected key disables that source and
// leaves the rest of discovery working.
//
// Nothing here reads a page behind a login, and no field is ever invented: a
// value the vendor did not supply comes back null.

const axios = require('axios');
const { withRetry } = require('../lib/retry');

const DEFILLAMA_RAISES_BASE = 'https://pro-api.llama.fi';
const CRYPTORANK_BASE = 'https://api.cryptorank.io/v3';

// The DeFiLlama raises dashboard, used as the provenance link when a raise
// record carries no announcement URL of its own.
const DEFILLAMA_RAISES_PAGE = 'https://defillama.com/raises';

const HTTP_TIMEOUT_MS = 20000;

// CryptoRank pages at 50 items. Six months of crypto rounds is roughly 400 to
// 900 rows, so cap the walk rather than paging forever on a bad filter.
const CRYPTORANK_PAGE_SIZE = 50;
const CRYPTORANK_MAX_PAGES = 12;

// Process-lifetime cache for the CryptoRank id -> project map. It is a large,
// slow-changing reference list and costs a credit per fetch.
let cryptoRankCurrencyMap = null;

function defiLlamaKey() { return process.env.DEFILLAMA_API_KEY || ''; }
function cryptoRankKey() { return process.env.CRYPTORANK_API_KEY || ''; }

// ── Shared normalization helpers ──────────────────────────────────────────────

// Hosts that publish funding news. A raise's "source" link points at one of
// these, so it must never be mistaken for the project's own domain: doing that
// would give every project the same domain and collapse them all into one
// entry at dedupe time.
const NEWS_HOSTS = [
  'techcrunch.com', 'coindesk.com', 'theblock.co', 'cointelegraph.com',
  'fortune.com', 'bloomberg.com', 'axios.com', 'reuters.com', 'businesswire.com',
  'prnewswire.com', 'globenewswire.com', 'medium.com', 'substack.com',
  'blockworks.co', 'decrypt.co', 'theinformation.com', 'defillama.com',
  'cryptorank.io', 'x.com', 'twitter.com', 'linkedin.com', 'crunchbase.com',
];

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_) { return null; }
}

function isNewsHost(host) {
  if (!host) return false;
  return NEWS_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

// A project's own domain, or null. Deliberately refuses news/aggregator hosts:
// an announcement URL is provenance, not identity.
function projectDomain(url) {
  const host = hostOf(url);
  if (!host || isNewsHost(host)) return null;
  return host;
}

// Pull a bare X/Twitter handle out of whatever the vendor supplied: a full
// profile URL, an "@name", or a bare name. Returns the handle without the "@",
// or null. Rejects non-profile paths (x.com/i/..., /home, /search) so a
// navigation link never becomes someone's handle.
const X_RESERVED_PATHS = new Set([
  'i', 'home', 'search', 'explore', 'notifications', 'messages', 'settings',
  'intent', 'share', 'hashtag', 'compose', 'login', 'signup', 'privacy', 'tos',
]);

function normalizeXHandle(value) {
  if (!value) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^(?:www\.)?(?:x|twitter)\.com\//i.test(s)) {
    const host = hostOf(s.startsWith('http') ? s : 'https://' + s);
    if (host !== 'x.com' && host !== 'twitter.com' && host !== 'mobile.twitter.com') return null;
    try {
      const path = new URL(s.startsWith('http') ? s : 'https://' + s).pathname;
      s = path.split('/').filter(Boolean)[0] || '';
    } catch (_) { return null; }
  }
  s = s.replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) return null;
  if (X_RESERVED_PATHS.has(s.toLowerCase())) return null;
  return s;
}

function xProfileUrl(handle) {
  const h = normalizeXHandle(handle);
  return h ? 'https://x.com/' + h : null;
}

// ISO YYYY-MM-DD from a unix timestamp (seconds or milliseconds) or a date
// string. Returns null when the value is missing or unparseable.
function isoDate(value) {
  if (value == null || value === '') return null;
  let ms;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Under ~10^11 the value is seconds, above it is milliseconds.
    ms = n < 1e11 ? n * 1000 : n;
  } else {
    ms = Date.parse(String(value));
  }
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// DeFiLlama reports round sizes in MILLIONS of USD ("amount": 12 means $12M).
// The heuristic guards against the vendor switching units under us: no real
// round is $12, and none is $12,000,000 million, so a value below the cutoff is
// millions and anything above it is already USD.
const MILLIONS_CUTOFF = 100000;

function usdFromLlamaAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < MILLIONS_CUTOFF ? Math.round(n * 1e6) : Math.round(n);
}

// "$12M", "$850K", or null. Used to build the human trigger line.
function formatUsd(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (usd >= 1e9) return '$' + trimZeros(usd / 1e9) + 'B';
  if (usd >= 1e6) return '$' + trimZeros(usd / 1e6) + 'M';
  if (usd >= 1e3) return '$' + trimZeros(usd / 1e3) + 'K';
  return '$' + Math.round(usd);
}

function trimZeros(n) {
  return String(Math.round(n * 10) / 10).replace(/\.0$/, '');
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function stringList(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of arr) {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim()) out.push(v.name.trim());
  }
  return out;
}

// ── DeFiLlama ─────────────────────────────────────────────────────────────────

// One raise row -> RaiseRecord, or null when the row has no usable project name.
//
// Field names are read defensively (several spellings accepted per value)
// because the Pro API documents this endpoint only as "Returns: {raises}",
// without a field schema. Anything absent stays null rather than being guessed.
function normalizeLlamaRaise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = firstString(raw.name, raw.project, raw.projectName);
  if (!name) return null;

  const date = isoDate(raw.date ?? raw.timestamp ?? raw.raisedAt);
  const sourceUrl = firstString(raw.source, raw.sourceUrl, raw.link, raw.announcement);
  // The project's own site, if the row carries one. Never the announcement host.
  const siteUrl = firstString(raw.website, raw.projectUrl, raw.url, raw.homepage);
  const domain = projectDomain(siteUrl) || projectDomain(sourceUrl);

  const leads = stringList(raw.leadInvestors ?? raw.leadInvestor ?? raw.leads);
  const others = stringList(raw.otherInvestors ?? raw.investors);

  return {
    source: 'defillama',
    name,
    date,
    amount_usd: usdFromLlamaAmount(raw.amount ?? raw.amountRaised ?? raw.raised),
    round: firstString(raw.round, raw.roundType, raw.stage),
    category: firstString(raw.category, raw.sector, raw.categoryGroup),
    chains: stringList(raw.chains),
    lead_investors: leads,
    other_investors: others,
    source_url: sourceUrl,
    project_url: siteUrl && projectDomain(siteUrl) ? siteUrl : null,
    domain,
    x_handle: normalizeXHandle(raw.twitter ?? raw.twitterHandle ?? raw.x),
  };
}

// All DeFiLlama raises on or after sinceIso. Throws CryptoSourceError when the
// key is missing or rejected so the caller can report the source as
// unconfigured; returns [] when the source simply has nothing in the window.
async function fetchDefiLlamaRaises({ sinceIso } = {}) {
  const key = defiLlamaKey();
  if (!key) {
    throw new CryptoSourceError('defillama',
      'DeFiLlama raises needs DEFILLAMA_API_KEY (the free api.llama.fi/raises endpoint now returns 402).');
  }
  const url = `${DEFILLAMA_RAISES_BASE}/${encodeURIComponent(key)}/api/raises`;
  let data;
  try {
    const resp = await withRetry(() => axios.get(url, { timeout: HTTP_TIMEOUT_MS }),
      { label: 'defillama raises' });
    data = resp.data;
  } catch (err) {
    const status = err.response?.status ?? 'no-response';
    // DeFiLlama answers a bad key with 500 {"error":"API Key is wrong"}, and an
    // unsubscribed free key with 402, so both are treated as config problems.
    if (status === 401 || status === 402 || status === 403
        || /api key/i.test(JSON.stringify(err.response?.data || ''))) {
      throw new CryptoSourceError('defillama',
        'DeFiLlama rejected DEFILLAMA_API_KEY or the plan does not include /api/raises.');
    }
    console.error('[outbound.crypto] defillama raises FAILED status=' + status
      + ' body=' + String(JSON.stringify(err.response?.data || err.message || '')).slice(0, 300));
    return [];
  }

  const rows = Array.isArray(data?.raises) ? data.raises : (Array.isArray(data) ? data : []);
  if (!rows.length) {
    console.warn('[outbound.crypto] defillama returned no raises rows (response keys: '
      + Object.keys(data || {}).join(', ') + ')');
    return [];
  }
  const out = [];
  for (const row of rows) {
    const rec = normalizeLlamaRaise(row);
    if (!rec) continue;
    if (sinceIso && (!rec.date || rec.date < sinceIso)) continue;
    out.push(rec);
  }
  console.log('[outbound.crypto] defillama: ' + rows.length + ' raises total, '
    + out.length + ' within the window since ' + (sinceIso || 'any date'));
  return out;
}

// ── CryptoRank ────────────────────────────────────────────────────────────────

async function cryptoRankGet(path, params) {
  const key = cryptoRankKey();
  const resp = await withRetry(() => axios.get(CRYPTORANK_BASE + path, {
    params,
    headers: { 'X-Api-Key': key },
    timeout: HTTP_TIMEOUT_MS,
  }), { label: 'cryptorank ' + path });
  return resp.data;
}

// id -> { name, slug, symbol } for every tracked coin, fetched once per process.
// The rounds feed carries only currencyId, so without this map a CryptoRank
// round has no project name and cannot be deduplicated against DeFiLlama.
async function loadCryptoRankCurrencyMap() {
  if (cryptoRankCurrencyMap) return cryptoRankCurrencyMap;
  const data = await cryptoRankGet('/currencies/map');
  const rows = Array.isArray(data?.data) ? data.data : [];
  const map = new Map();
  for (const r of rows) {
    if (r && r.id != null && r.name) {
      map.set(Number(r.id), { name: String(r.name), slug: r.slug || null, symbol: r.symbol || null });
    }
  }
  cryptoRankCurrencyMap = map;
  console.log('[outbound.crypto] cryptorank currency map: ' + map.size + ' projects');
  return map;
}

// One /funding-rounds/list item -> RaiseRecord, or null when the project id
// cannot be resolved to a name (an unnamed round is not actionable).
//
// The list DTO has no project URL and no X handle, so those stay null here and
// are filled in by a DeFiLlama match at dedupe time when one exists.
function normalizeCryptoRankRound(raw, currencyMap) {
  if (!raw || typeof raw !== 'object') return null;
  const entry = currencyMap && currencyMap.get ? currencyMap.get(Number(raw.currencyId)) : null;
  const name = entry?.name || null;
  if (!name) return null;

  // dateAccuracy 'year' means only the year is known, so the day-level value is
  // a placeholder (Jan 1) and must not be presented as a real trigger date.
  const date = raw.dateAccuracy === 'year' ? null : isoDate(raw.date);
  const raised = Number(raw.raised);

  return {
    source: 'cryptorank',
    name,
    date,
    amount_usd: Number.isFinite(raised) && raised > 0 ? Math.round(raised) : null,
    round: firstString(raw.type),
    category: firstString(raw.category?.name, raw.category?.slug),
    chains: [],
    // The feed does not split lead from other investors (that needs the
    // per-round detail call), so every investor is recorded as "other".
    lead_investors: [],
    other_investors: stringList(raw.allInvestors),
    source_url: entry?.slug ? 'https://cryptorank.io/ico/' + entry.slug : 'https://cryptorank.io/funding-rounds',
    project_url: null,
    domain: null,
    x_handle: null,
  };
}

// CryptoRank rounds since sinceIso. Secondary source: any failure (missing key,
// wrong plan, network) returns { records: [], note } instead of throwing, so it
// can never take a run down.
async function fetchCryptoRankRounds({ sinceIso } = {}) {
  if (!cryptoRankKey()) {
    return { records: [], note: 'CryptoRank skipped: no CRYPTORANK_API_KEY set.' };
  }
  let currencyMap;
  try {
    currencyMap = await loadCryptoRankCurrencyMap();
  } catch (err) {
    return { records: [], note: cryptoRankNote(err, 'currencies map') };
  }

  const records = [];
  try {
    for (let page = 1; page <= CRYPTORANK_MAX_PAGES; page += 1) {
      const data = await cryptoRankGet('/funding-rounds/list', {
        page,
        sortBy: 'date',
        sortOrder: 'desc',
        ...(sinceIso ? { from: sinceIso } : {}),
      });
      const rows = Array.isArray(data?.data) ? data.data : [];
      for (const row of rows) {
        const rec = normalizeCryptoRankRound(row, currencyMap);
        if (!rec) continue;
        if (sinceIso && (!rec.date || rec.date < sinceIso)) continue;
        records.push(rec);
      }
      if (!data?.meta?.hasNextPage || rows.length < CRYPTORANK_PAGE_SIZE) break;
    }
  } catch (err) {
    return { records, note: cryptoRankNote(err, 'funding rounds feed') };
  }
  console.log('[outbound.crypto] cryptorank: ' + records.length + ' rounds within the window since '
    + (sinceIso || 'any date'));
  return { records, note: null };
}

// A short, honest reason a CryptoRank call did not produce data.
function cryptoRankNote(err, what) {
  const status = err.response?.status;
  if (status === 401) return `CryptoRank ${what} unavailable: CRYPTORANK_API_KEY is missing or invalid.`;
  if (status === 403) return `CryptoRank ${what} unavailable: the endpoint is not included in this API plan (the rounds feed needs the Pro tier).`;
  if (status === 429) return `CryptoRank ${what} unavailable: rate or credit limit reached.`;
  return `CryptoRank ${what} unavailable: ${String(err?.message || err).slice(0, 160)}`;
}

// ── Cross-source dedupe ───────────────────────────────────────────────────────

// Collapse a project name to a comparison key. Mirrors the intent of
// provider.normalizeCompanyName but is kept local because crypto naming carries
// its own noise: a trailing ticker ("Ethena (ENA)"), a "Protocol"/"Network"/
// "Finance" suffix, and 0x prefixes.
function raiseKey(rec) {
  if (rec.domain) return 'd:' + rec.domain;
  let s = String(rec.name || '').toLowerCase().trim();
  s = s.replace(/\([^)]*\)/g, ' ');                       // drop "(ENA)" style tickers
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  s = s.replace(/\b(protocol|network|finance|labs?|foundation|dao|xyz|io|fi|inc|ltd|limited|llc)\b/g, ' ');
  s = s.replace(/\s+/g, '');
  return 'n:' + s;
}

// Merge two records for the same project, preferring the richer value per
// field. DeFiLlama wins ties because it carries the announcement URL and the
// X handle; CryptoRank fills the gaps (investors, category, amount).
function mergeRaiseRecords(a, b) {
  const primary = a.source === 'defillama' ? a : b;
  const secondary = primary === a ? b : a;
  const pick = (field) => (primary[field] != null && primary[field] !== '' ? primary[field] : secondary[field]);
  const pickList = (field) => (primary[field]?.length ? primary[field] : (secondary[field] || []));
  const sources = Array.from(new Set([...(a.sources || [a.source]), ...(b.sources || [b.source])]));
  return {
    ...primary,
    sources,
    // Keep the earlier-known, more precise date when only one side has one.
    date: pick('date'),
    amount_usd: pick('amount_usd'),
    round: pick('round'),
    category: pick('category'),
    chains: pickList('chains'),
    lead_investors: pickList('lead_investors'),
    other_investors: pickList('other_investors'),
    source_url: pick('source_url'),
    project_url: pick('project_url'),
    domain: pick('domain'),
    x_handle: pick('x_handle'),
  };
}

// Deduplicate records across sources by project domain, else by normalized
// name. Returns { records, duplicates } where duplicates is how many rows were
// folded into an existing project.
//
// A project that raised twice in the window collapses to its most recent round,
// because the freshest raise is the trigger worth reaching out about.
function dedupeRaises(records) {
  const byKey = new Map();
  let duplicates = 0;
  for (const rec of records) {
    if (!rec || !rec.name) continue;
    const key = raiseKey(rec);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...rec, sources: rec.sources || [rec.source] });
      continue;
    }
    duplicates += 1;
    const merged = mergeRaiseRecords(existing, rec);
    // Keep whichever round is more recent as the headline trigger.
    if (rec.date && (!existing.date || rec.date > existing.date)) {
      merged.date = rec.date;
      merged.round = rec.round || merged.round;
      merged.amount_usd = rec.amount_usd != null ? rec.amount_usd : merged.amount_usd;
      if (rec.source_url) merged.source_url = rec.source_url;
    }
    byKey.set(key, merged);
  }
  return { records: Array.from(byKey.values()), duplicates };
}

// Error raised when a source is not usable at all (no key, key rejected). The
// caller decides whether that is fatal (primary source) or a note (secondary).
class CryptoSourceError extends Error {
  constructor(source, message) {
    super(message);
    this.name = 'CryptoSourceError';
    this.source = source;
  }
}

module.exports = {
  fetchDefiLlamaRaises, fetchCryptoRankRounds,
  normalizeLlamaRaise, normalizeCryptoRankRound,
  dedupeRaises, raiseKey, mergeRaiseRecords,
  normalizeXHandle, xProfileUrl, projectDomain, isNewsHost,
  usdFromLlamaAmount, formatUsd, isoDate,
  CryptoSourceError, DEFILLAMA_RAISES_PAGE,
  // test seam: lets a unit test install a fake currency map without a key
  __setCryptoRankCurrencyMap(map) { cryptoRankCurrencyMap = map; },
};
