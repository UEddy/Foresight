// Outbound — web3 discovery segment.
//
// Turns crypto funding rounds (see cryptoSources.js) into CompanyCandidate
// objects in exactly the shape provider.discoverCompanies already returns, so
// they flow through the unchanged pipeline: peer gate, people finder, contact
// gate, scoring, freshness ranking, dedupe, and the targetCount cap.
//
// The filter is a funnel, cheapest test first:
//
//   1. Window       raised within the last WINDOW_DAYS (6 months).
//   2. Peer         hard deny for crypto analytics / intelligence / monitoring
//                   tooling. This is the existing peer rule applied to the
//                   crypto vocabulary, and the model can never overturn it.
//   3. Category     deterministic allow list for categories where competitor
//                   monitoring obviously matters, deny list for plumbing with
//                   no GTM motion.
//   4. GTM judgment one batched model call over whatever categories 3 could not
//                   settle. Falls back to the deterministic verdict when the
//                   model is unavailable, so discovery still works without a
//                   key.
//
// Candidates carry two extra fields the generic pipeline does not set:
//   source_kind: 'crypto'    marks them eligible for the X/Twitter people
//                            fallback (crypto founders are often not on
//                            LinkedIn at all, see provider.findPeopleOnX)
//   x_handle                 the project's X handle when the source had one,
//                            used only as a search hint, never as a contact.

const {
  fetchDefiLlamaRaises, fetchCryptoRankRounds, dedupeRaises,
  formatUsd, CryptoSourceError, DEFILLAMA_RAISES_PAGE,
} = require('./cryptoSources');
const { structuredCall } = require('./ai');

// Six months, matching the freshness window the rest of the pipeline uses
// (store.freshnessRank treats a trigger older than 180 days as stale).
const WINDOW_DAYS = 180;

// Ceiling on crypto candidates handed to the pipeline, before the shared pool
// cap applies. Six months of crypto rounds can be several hundred rows and each
// surviving candidate costs a search plus model calls downstream.
const MAX_CRYPTO_CANDIDATES = 40;

// Batch size for the GTM judgment call, so one oversized prompt cannot truncate.
const GTM_BATCH_SIZE = 25;

// ── Rule 2: peers (crypto flavour) ────────────────────────────────────────────
// The existing peer rule says never pitch a company that itself builds
// competitor monitoring or analytics tooling. In crypto that is the on-chain
// data and intelligence layer, so it gets its own vocabulary.

const CRYPTO_PEER_CATEGORY_RE = new RegExp(
  '(?:on[\\s-]?chain|blockchain|crypto|wallet|token|market)[\\s-]*'
    + '(?:analytics|intelligence|data|research|monitoring|tracking|dashboards?)'
  + '|\\banalytics\\b|\\bdata analytics\\b|\\bbusiness intelligence\\b'
  + '|\\bmarket intelligence\\b|\\bsocial listening\\b'
  + '|\\b(?:dune|nansen|arkham|messari)\\b',
  'i',
);

// Named crypto data/intelligence products. Matched on a word boundary against
// the project name, in the same spirit as provider.KNOWN_PEER_VENDORS.
const CRYPTO_PEER_NAMES = [
  'nansen', 'dune', 'arkham', 'messari', 'kaito', 'token terminal',
  'glassnode', 'santiment', 'chainalysis', 'elliptic', 'trm labs', 'nansen ai',
  'defillama', 'defi llama', 'artemis', 'parsec', 'dappradar', 'footprint analytics',
  'lunarcrush', 'coingecko', 'coinmarketcap', 'cryptorank', 'rootdata',
];

function escapeRegexWord(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when a raise record is a data / analytics / monitoring vendor, i.e. a
// peer that would never buy competitor monitoring because it sells the genre.
function isCryptoPeer(rec) {
  const name = String(rec?.name || '').toLowerCase();
  for (const v of CRYPTO_PEER_NAMES) {
    if (new RegExp('\\b' + escapeRegexWord(v) + '\\b', 'i').test(name)) {
      return { peer: true, reason: 'crypto data or intelligence vendor (' + v + ')' };
    }
  }
  const category = String(rec?.category || '');
  if (category && CRYPTO_PEER_CATEGORY_RE.test(category)) {
    return { peer: true, reason: 'category is analytics or intelligence tooling: ' + category };
  }
  return { peer: false, reason: null };
}

// ── Rule 3: category fit ──────────────────────────────────────────────────────
// Competitive categories where a project fights other projects for the same
// TVL, users, or developers, and therefore needs marketing and BD early.

const FIT_CATEGORY_RE = new RegExp(
  '\\b(?:defi|dex|amm|perp\\w*|derivativ\\w*|lending|borrow\\w*|money market'
  + '|lst|lsd|liquid[\\s-]?staking|restaking|yield|vault\\w*|stablecoin\\w*'
  + '|rwa|real[\\s-]?world[\\s-]?asset\\w*|exchange|cex|trading|brokerage'
  + '|wallet\\w*|l1|l2|layer[\\s-]?[12]|rollup\\w*|blockchain[\\s-]?service'
  + '|chain|bridge\\w*|interoperability|nft|marketplace|gaming|gamefi|metaverse'
  + '|social|socialfi|creator|prediction[\\s-]?market\\w*|launchpad|payments?'
  + '|neobank|depin|ai[\\s-]?agent\\w*|consumer|app\\w*)\\b',
  'i',
);

// Deep plumbing: sold to a handful of integrators through direct relationships,
// with no user-facing product competing for attention. Not a Nivaria fit.
const PLUMBING_CATEGORY_RE = new RegExp(
  '\\b(?:mining|miner\\w*|hardware|asic|node[\\s-]?(?:hosting|operator\\w*)'
  + '|validator[\\s-]?service\\w*|rpc|indexing|middleware|zk[\\s-]?prov\\w*'
  + '|proving|cryptograph\\w*|mpc|key[\\s-]?management|hsm|audit\\w*|formal[\\s-]?verification'
  + '|compliance|kyc|aml|tax|accounting|custody[\\s-]?tech|settlement[\\s-]?rail\\w*'
  + '|oracle[\\s-]?infrastructure|sequencer|da[\\s-]?layer|data[\\s-]?availability)\\b',
  'i',
);

// Deterministic verdict on a category string:
//   'fit'     clearly a competitive, GTM-driven category
//   'unfit'   clearly deep plumbing
//   'unknown' no opinion, hand it to the model
// A category that matches both (for example "ZK rollup") is a fit: the rollup
// is competing publicly for developers even though the proving layer is
// plumbing, so the competitive signal wins.
function categoryVerdict(category) {
  const c = String(category || '').trim();
  if (!c) return 'unknown';
  if (FIT_CATEGORY_RE.test(c)) return 'fit';
  if (PLUMBING_CATEGORY_RE.test(c)) return 'unfit';
  return 'unknown';
}

// ── Rule 4: GTM judgment ──────────────────────────────────────────────────────

// Ask the model, in one batched call, which of the ambiguous projects competes
// for TVL, users, or developers and would need marketing and BD early. Returns
// a Map of index -> boolean. An unavailable model yields an empty map and the
// caller keeps its deterministic verdict.
async function judgeGtmFit(records) {
  if (!records.length) return new Map();
  const verdicts = new Map();

  for (let start = 0; start < records.length; start += GTM_BATCH_SIZE) {
    const batch = records.slice(start, start + GTM_BATCH_SIZE);
    const system = 'You screen recently funded crypto projects as outbound prospects for Nivaria, '
      + 'a competitor-intelligence app. KEEP a project when it has a token or a user-facing product '
      + 'and competes publicly for TVL, users, traders, or developers, so it needs marketing and '
      + 'business development early: DeFi lending, DEXs, perps, liquid staking, restaking, yield, '
      + 'stablecoins, L1s, L2s, rollups, bridges, exchanges, wallets, NFT or gaming platforms, '
      + 'consumer apps, payments. DROP deep infrastructure plumbing sold quietly to a few '
      + 'integrators with no public go-to-market: mining hardware, node hosting, proving systems, '
      + 'key management, compliance and KYC middleware, audit firms. DROP any project that itself '
      + 'BUILDS analytics, on-chain data, market intelligence, or competitor-monitoring tooling: it '
      + 'sells what Nivaria sells and will never buy it. Return JSON only. Never use em-dashes, '
      + 'en-dashes, or a connecting "+"; write "and" instead.';
    const user = 'Projects (JSON):\n'
      + JSON.stringify(batch.map((r, i) => ({
        i: start + i,
        name: r.name,
        category: r.category || null,
        round: r.round || null,
        amount_usd: r.amount_usd || null,
        chains: r.chains || [],
      })))
      + '\n\nReturn: { "verdicts": [ { "i": int (the index given above), "keep": boolean, '
      + '"reason": string (at most 12 words) } ] }'
      + '\nJudge every project in the list. When genuinely unsure, keep it.';

    const parsed = await structuredCall({ system, user, maxTokens: 2000 });
    const list = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
    for (const v of list) {
      const idx = Number(v?.i);
      if (Number.isInteger(idx) && typeof v?.keep === 'boolean') verdicts.set(idx, v.keep);
    }
  }
  return verdicts;
}

// ── Candidate construction ────────────────────────────────────────────────────

// Human trigger line for the lead card and the draft prompt. Deterministic, so
// it never needs sanitizing: no em-dashes, no en-dashes, no connector plus.
function buildTrigger(rec) {
  const amount = formatUsd(rec.amount_usd);
  const round = rec.round ? String(rec.round).trim() : null;
  let s = 'Raised';
  if (amount) s += ' ' + amount;
  if (round) s += ' in a ' + round + ' round';
  else s += ' a new funding round';
  const leads = (rec.lead_investors || []).slice(0, 2);
  if (leads.length) s += ', led by ' + leads.join(' and ');
  else {
    const others = (rec.other_investors || []).slice(0, 2);
    if (others.length) s += ', with ' + others.join(' and ') + ' participating';
  }
  if (rec.category) s += '. Category: ' + rec.category + '.';
  else s += '.';
  return s;
}

// Round label -> the stage_size vocabulary provider.rolesForStage understands,
// so a seed-stage project hunts for a founder and a later-stage one hunts for a
// marketing lead, exactly as in the generic path.
function stageFromRound(round, amountUsd) {
  const r = String(round || '').toLowerCase();
  if (/pre[\s-]?seed|angel|grant|incubation|presale/.test(r)) return 'pre-seed';
  if (/\bseed\b/.test(r)) return 'seed';
  if (/series a/.test(r)) return 'small';
  if (/series b/.test(r)) return 'growth';
  if (/series [c-h]|ipo|pipe|post-ipo/.test(r)) return 'large';
  // Strategic, private token sale, undisclosed, and friends carry no stage, so
  // fall back to round size: crypto rounds under $10M are founder-led.
  if (Number.isFinite(amountUsd) && amountUsd >= 5e7) return 'large';
  if (Number.isFinite(amountUsd) && amountUsd >= 1.5e7) return 'growth';
  return 'seed';
}

// RaiseRecord -> CompanyCandidate, in the shape the pipeline consumes.
function toCandidate(rec) {
  return {
    company: rec.name,
    domain: rec.domain || null,
    category: rec.category || null,
    stage_size: stageFromRound(rec.round, rec.amount_usd),
    region: null,                              // neither source reports a region
    trigger: buildTrigger(rec),
    trigger_url: rec.source_url || rec.project_url || DEFILLAMA_RAISES_PAGE,
    trigger_date: rec.date || null,
    // Crypto-only extras, read by the pipeline and the people finder.
    source_kind: 'crypto',
    discovery_source: (rec.sources || [rec.source]).join(','),
    x_handle: rec.x_handle || null,
    raise_amount_usd: rec.amount_usd || null,
    raise_round: rec.round || null,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Discover recently funded crypto projects that fit Nivaria. Returns
// { candidates, notes } where notes are honest, user-facing sentences about any
// source that could not be reached. Never throws for a secondary-source
// failure; a DeFiLlama config error propagates as CryptoSourceError so the
// caller can decide (the pipeline reports it as a note, not a run failure,
// because Serper discovery still ran).
async function discoverCryptoRaises({ funnel = null, windowDays = WINDOW_DAYS } = {}) {
  const sinceIso = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const notes = [];
  let records = [];

  // Primary source.
  try {
    records = await fetchDefiLlamaRaises({ sinceIso });
  } catch (err) {
    if (err instanceof CryptoSourceError) notes.push(err.message);
    else notes.push('DeFiLlama raises unavailable: ' + String(err?.message || err).slice(0, 160));
  }

  // Secondary source, never fatal.
  const cr = await fetchCryptoRankRounds({ sinceIso });
  if (cr.note) notes.push(cr.note);
  records = records.concat(cr.records);

  if (funnel) funnel.crypto_raises_fetched = records.length;
  if (!records.length) {
    console.warn('[outbound.crypto] no raises fetched. ' + (notes.join(' ') || 'Both sources returned empty.'));
    return { candidates: [], notes };
  }

  // Cross-source dedupe by domain, else normalized project name.
  const { records: unique, duplicates } = dedupeRaises(records);
  if (funnel) {
    funnel.crypto_after_dedupe = unique.length;
    funnel.crypto_cross_source_dupes = duplicates;
  }

  // Rule 2 + 3: peer deny, then the deterministic category verdict.
  const kept = [];
  const ambiguous = [];
  let peers = 0;
  let unfit = 0;
  for (const rec of unique) {
    const peer = isCryptoPeer(rec);
    if (peer.peer) {
      peers += 1;
      console.log('[outbound.crypto] peer (filtered): ' + JSON.stringify(rec.name) + ' - ' + peer.reason);
      continue;
    }
    const verdict = categoryVerdict(rec.category);
    if (verdict === 'fit') kept.push(rec);
    else if (verdict === 'unfit') { unfit += 1; ambiguous.push({ rec, deterministic: false }); }
    else ambiguous.push({ rec, deterministic: true });
  }

  // Rule 4: one batched model judgment over everything rule 3 could not settle
  // outright. The deterministic verdict is the fallback when the model is
  // unavailable ('unknown' keeps the project, 'unfit' drops it).
  const judged = await judgeGtmFit(ambiguous.map(a => a.rec));
  let modelDropped = 0;
  ambiguous.forEach((a, i) => {
    const decided = judged.has(i) ? judged.get(i) : a.deterministic;
    if (decided) kept.push(a.rec);
    else modelDropped += 1;
  });

  if (funnel) {
    funnel.crypto_peer = peers;
    funnel.crypto_unfit_category = modelDropped;
  }
  console.log('[outbound.crypto] filter: ' + unique.length + ' unique projects, '
    + peers + ' peers, ' + modelDropped + ' unfit category (' + unfit
    + ' flagged as plumbing deterministically), ' + kept.length + ' fit');

  // Freshest raise first, then largest round, then cap.
  kept.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.amount_usd || 0) - (a.amount_usd || 0));
  const candidates = kept.slice(0, MAX_CRYPTO_CANDIDATES).map(toCandidate);
  if (funnel) funnel.crypto_candidates = candidates.length;
  return { candidates, notes };
}

module.exports = {
  discoverCryptoRaises,
  isCryptoPeer, categoryVerdict, stageFromRound, buildTrigger, toCandidate, judgeGtmFit,
  WINDOW_DAYS, MAX_CRYPTO_CANDIDATES, CRYPTO_PEER_NAMES,
};
