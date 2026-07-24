// Outbound — lead data provider.
//
// The pipeline talks to a LeadDataProvider, never to a vendor directly, so a
// paid enrichment provider (Apollo, People Data Labs) can be dropped in for
// Phase 2 without touching the pipeline. Interface:
//
//   discoverCompanies(brief, opts) -> CompanyCandidate[]
//   findPeople(company, roles)     -> Person[]
//   findContact(person)            -> Contact
//
// Phase-1 concrete implementation: SearchFirstProvider. It uses a web-search API
// (Serper.dev) for discovery and people-finding, the Anthropic API to turn raw
// search results into structured candidates, and NEVER fabricates a contact:
// email finding is out of scope for Phase 1, so every contact comes back
// { contact_status: 'manual', profileUrl } for me to grab via the Chrome
// extension.
//
// A missing SERPER_API_KEY raises OutboundConfigError, which the pipeline turns
// into a clean run error (the app still boots and runs without the key).

const axios = require('axios');
const { structuredCall } = require('./ai');
const { recordRejection } = require('./funnel');
const { withRetry, sleep } = require('../lib/retry');

// Pause between consecutive Serper searches in the discovery loop so one run
// does not burst past the provider's per-minute limit.
const SEARCH_GAP_MS = 400;

// Over-discovery. The people, company-match, contact, and score gates each shed
// candidates, so discovering exactly targetCount companies leaves near zero
// survivors after the gates run. Instead we discover a pool several times larger
// than targetCount and let the pipeline apply the targetCount cap LAST, to the
// survivors. DISCOVERY_MULTIPLIER is configurable (env override), default 8.
const DISCOVERY_MULTIPLIER = Math.max(1, Number(process.env.OUTBOUND_DISCOVERY_MULTIPLIER) || 8);

// Upper bound on the discovered pool (and therefore on companies processed and
// on the extraction token budget), so a large targetCount cannot blow up cost.
const MAX_POOL = 50;

// Cap on Serper searches per run, raised to feed the larger pool. The inter-call
// delay (SEARCH_GAP_MS) and the withRetry backoff are unchanged.
const MAX_SEARCHES_PER_RUN = 12;

// Cap on raw search results gathered and handed to the extraction model.
const MAX_RAW_RESULTS = 120;

// Size the discovered pool for a requested targetCount: multiplied up, then
// bounded by MAX_POOL.
function poolSizeFor(targetCount) {
  const t = Number.isFinite(targetCount) && targetCount > 0 ? targetCount : 10;
  return Math.min(t * DISCOVERY_MULTIPLIER, MAX_POOL);
}

class OutboundConfigError extends Error {
  constructor(message) { super(message); this.name = 'OutboundConfigError'; }
}

// Stage -> the role we hunt for at that company size (from the agent spec).
const ROLE_MAP = {
  tiny:   ['Founder', 'CEO', 'Co-founder'],
  small:  ['Head of Product Marketing', 'Product Marketing', 'Founder'],
  growth: ['Competitive Intelligence', 'Product Marketing Manager', 'RevOps', 'Sales Enablement'],
  large:  ['Competitive Intelligence', 'Product Marketing Director', 'Revenue Operations'],
};

function rolesForStage(stage) {
  const key = String(stage || '').toLowerCase();
  if (/found|seed|pre-seed|tiny|1-10/.test(key)) return ROLE_MAP.tiny;
  if (/small|11-50|series a/.test(key)) return ROLE_MAP.small;
  if (/large|enterprise|500|series [d-z]/.test(key)) return ROLE_MAP.large;
  return ROLE_MAP.growth;
}

class SearchFirstProvider {
  constructor() {
    this.serperKey = process.env.SERPER_API_KEY || '';
    this.endpoint = 'https://google.serper.dev/search';
  }

  ensureConfigured() {
    if (!this.serperKey) {
      throw new OutboundConfigError(
        'Discovery is not configured. Set SERPER_API_KEY in Railway to enable lead discovery.'
      );
    }
  }

  // One Serper web search. Returns a compact array of { title, link, snippet }
  // on success (possibly empty when Serper genuinely found nothing), or NULL
  // when the request itself failed, so callers can tell "no results" apart from
  // "no response". A 429 is retried with backoff (1s, 2s, 4s) before giving up.
  // opts.debug additionally logs the raw HTTP status and the first ~500 chars
  // of the response body (used for the first query of a discovery run).
  async search(query, { num = 10, gl, debug = false } = {}) {
    this.ensureConfigured();
    try {
      const body = { q: query, num };
      if (gl) body.gl = gl; // country bias, e.g. 'us'
      const resp = await withRetry(() => axios.post(this.endpoint, body, {
        headers: { 'X-API-KEY': this.serperKey, 'Content-Type': 'application/json' },
        timeout: 15000,
      }), { label: 'serper search' });
      if (debug) {
        console.log('[outbound.discovery] first serper response: status=' + resp.status
          + ' body=' + JSON.stringify(resp.data).slice(0, 500));
      }
      const organic = Array.isArray(resp.data?.organic) ? resp.data.organic : [];
      if (!organic.length) {
        // A 200 with no organic results is worth seeing: it distinguishes
        // "Serper answered but found nothing" from a request failure.
        console.warn('[outbound.provider] serper returned 0 organic results for', JSON.stringify(query));
      }
      return organic.map(r => ({ title: r.title || '', link: r.link || '', snippet: r.snippet || '' }));
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        throw new OutboundConfigError('Serper rejected the API key (check SERPER_API_KEY).');
      }
      // Request-level failure (429 after retries, 400, quota exhaustion,
      // network error). Log the real status and body so the failure is never
      // silent, and return null so the caller can count it as failed rather
      // than as an empty result.
      const status = err.response?.status ?? 'no-response';
      const bodySlice = err.response?.data !== undefined
        ? JSON.stringify(err.response.data).slice(0, 500)
        : String(err?.message || err).slice(0, 500);
      console.error('[outbound.provider] search FAILED for ' + JSON.stringify(query)
        + ' status=' + status + ' body=' + bodySlice);
      return null;
    }
  }

  // ── Discover ─────────────────────────────────────────────────────────────────
  // Returns a POOL of up to poolSizeFor(targetCount) candidates, deliberately
  // larger than targetCount. The pipeline runs the gates over the whole pool and
  // applies the targetCount cap last (see runPipeline). Do NOT truncate to
  // targetCount here.
  async discoverCompanies(brief, { targetCount = 10, regionHints = '', funnel = null } = {}) {
    this.ensureConfigured();
    const gl = regionHintToGl(regionHints);
    const poolSize = poolSizeFor(targetCount);

    // 1) Ask the model to expand the brief into concrete ICP/pain search queries.
    const queries = await this.buildQueries(brief, regionHints);

    // Diagnostic: state the search budget and the EXACT queries before any is
    // sent, so a zero-candidate run is attributable at a glance. If the
    // intended count is ever 0 the bug is in the budget math, not in Serper.
    console.log('[outbound.discovery] budget: poolSize=' + poolSize
      + ' maxSearches=' + MAX_SEARCHES_PER_RUN + ' intendedQueries=' + queries.length);
    console.log('[outbound.discovery] queries: ' + JSON.stringify(queries));
    if (!queries.length) {
      console.error('[outbound.discovery] BUG: zero intended queries; buildQueries returned an empty list');
      return [];
    }

    // 2) Run the searches and aggregate results (deduped by link). Bounded by
    //    MAX_SEARCHES_PER_RUN searches and MAX_RAW_RESULTS raw hits.
    const seen = new Set();
    const results = [];
    let searchCount = 0;
    let failedSearches = 0;
    for (const q of queries) {
      if (searchCount >= MAX_SEARCHES_PER_RUN) break;
      if (searchCount > 0) await sleep(SEARCH_GAP_MS);
      searchCount += 1;
      // First query of the run logs its raw HTTP status and response body so a
      // silent auth/quota/shape failure is visible in the run log.
      const hits = await this.search(q, { num: 10, gl, debug: searchCount === 1 });
      if (hits === null) failedSearches += 1;
      for (const h of (hits || [])) {
        if (!h.link || seen.has(h.link)) continue;
        seen.add(h.link);
        results.push(h);
      }
      if (results.length >= MAX_RAW_RESULTS) break; // enough raw material
    }
    console.log('[outbound.discovery] searches sent=' + searchCount
      + ' failed=' + failedSearches + ' rawResults=' + results.length);
    if (!results.length) {
      console.error('[outbound.discovery] zero raw results across ' + searchCount
        + ' searches (' + failedSearches + ' failed). Check the first-response log above for the reason.');
      return [];
    }

    // 3) Extract structured company candidates with a real trigger + source URL.
    const system = 'You are a B2B lead researcher for Nivaria, a competitor-intelligence '
      + 'app for SaaS sales and product-marketing teams. From raw web-search results, extract '
      + 'companies that plausibly feel competitor / market-monitoring pain (crowded category, '
      + 'active /compare or /alternatives pages, a competitive role recently opened, fresh funding, '
      + 'or a founder describing manual competitor tracking). Never use em-dashes, en-dashes, or a '
      + 'connecting "+"; write "and" instead. Return JSON only.';
    const user = 'ICP brief:\n' + String(brief || '').slice(0, 2000)
      + '\n\nRegion hints: ' + (regionHints || 'none')
      + '\n\nToday is ' + new Date().toISOString().slice(0, 10) + '.'
      + '\n\nSearch results (JSON):\n' + JSON.stringify(results.slice(0, MAX_RAW_RESULTS))
      + `\n\nReturn up to ${poolSize} candidates as JSON:`
      + '\n{ "candidates": [ { "company": string, "domain": string|null, "category": string, '
      + '"stage_size": string, "region": string, "trigger": string (the ONE specific reason now), '
      + '"trigger_url": string (MUST be one of the result links above), '
      + '"trigger_date": string|null (ISO YYYY-MM-DD when the trigger happened, inferred from the '
      + 'result; null if the result gives no date) } ] }'
      + '\nOnly include a candidate if you can point to a real trigger_url from the results. '
      + 'Triggers up to 6 months old are acceptable: prefer the freshest (this week, this month) '
      + 'over older ones, but do NOT discard a candidate just because its trigger is a few months '
      + 'old. Do not invent companies, URLs, or dates.'
      + '\n\nEXCLUDE peers: never include a company that BUILDS, SHIPS, or SELLS '
      + 'competitor-monitoring capability in any form. That covers core products (competitive '
      + 'intelligence, competitor price tracking, market or media intelligence, SEO and traffic '
      + 'tools, social listening) AND a monitoring FEATURE inside a product with a different core '
      + 'business, in any vertical (for example a POS or an e-commerce platform that ships '
      + 'competitor price or menu tracking, or a marketing suite with competitor dashboards). A '
      + 'company launching, announcing, or marketing such a feature is a peer, not a prospect: it '
      + 'will not buy what it already builds. A company that does competitor tracking MANUALLY, '
      + 'hires for it, keeps a /compare page, or loses deals to competitors IS a prospect and '
      + 'should be included.';

    // Budget enough output tokens for the larger pool so the JSON is not
    // truncated (a truncated response fails to parse and yields zero candidates).
    // wantRaw so a zero-candidate extraction can show the model's literal output.
    const { parsed, raw } = await structuredCall({ system, user, maxTokens: 8000, wantRaw: true });
    const list = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    // Diagnostic: separates "search found nothing" (logged above) from "model
    // extracted nothing" (logged here, with the raw output when empty).
    console.log('[outbound.discovery] extraction: fed ' + results.length
      + ' raw results, model returned ' + list.length + ' candidates');
    if (!list.length) {
      console.error('[outbound.discovery] extraction produced no candidates. Raw model output: '
        + (raw == null ? '(null: missing ANTHROPIC_API_KEY or the call failed)' : JSON.stringify(raw.slice(0, 2000))));
    }
    if (funnel) funnel.discovered_raw = list.length; // raw, pre-dedupe

    // 4) Keep only candidates whose trigger_url actually appeared in results.
    const validLinks = seen;
    const out = [];
    const byDomain = new Set();
    for (const c of list) {
      if (!c || !c.company || !c.trigger_url || !validLinks.has(c.trigger_url)) continue;
      const domain = (c.domain || domainFromUrl(c.trigger_url) || '').toLowerCase();
      const dedupeKey = domain || c.company.toLowerCase();
      if (byDomain.has(dedupeKey)) continue;
      byDomain.add(dedupeKey);
      out.push({
        company: c.company,
        domain: domain || null,
        category: c.category || null,
        stage_size: c.stage_size || null,
        region: c.region || null,
        trigger: c.trigger || null,
        trigger_url: c.trigger_url,
        trigger_date: normalizeTriggerDate(c.trigger_date),
      });
    }
    if (funnel) funnel.after_dedupe = out.length; // survivors of dedupe + exclusion rules
    // Freshness first: surface the companies with the newest triggers before the
    // older ones, then cap to the POOL size (not targetCount). Undated triggers
    // sort after dated ones. Ranking and stale down-weighting happen again at
    // persist/query time (see store.js).
    out.sort((a, b) => triggerRecencyRank(a.trigger_date) - triggerRecencyRank(b.trigger_date));
    return out.slice(0, poolSize);
  }

  // Model-expanded search queries, with a static fallback if the model is
  // unavailable so discovery still works without an Anthropic key.
  async buildQueries(brief, regionHints) {
    const region = regionHints ? ` ${regionHints}` : '';
    const fallback = [
      `SaaS "competitive intelligence" OR "product marketing" hiring${region}`,
      `"/compare" OR "/alternatives" page SaaS pricing${region}`,
      `SaaS startup raised seed funding crowded market${region}`,
      `founder "tracking competitors" spreadsheet manual${region}`,
      `B2B SaaS "battlecard" OR "win/loss" competitive teardown${region}`,
      `SaaS "Series A" OR "Series B" launched competitor to${region}`,
      `SaaS pricing page relaunch OR repositioning crowded category${region}`,
      `product marketing manager "competitive analysis" SaaS hiring${region}`,
    ];
    const system = `Turn an ICP brief into up to ${MAX_SEARCHES_PER_RUN} concise, varied Google `
      + 'search queries that surface companies feeling competitor-monitoring pain. Vary the angle '
      + '(hiring signals, compare/alternatives pages, funding, founder pain, repositioning) so the '
      + 'queries do not overlap. Return JSON only. No em-dashes, en-dashes, or connecting "+".';
    const user = 'Brief:\n' + String(brief || '').slice(0, 1500)
      + '\nRegion hints: ' + (regionHints || 'none')
      + `\n\nReturn: { "queries": [ up to ${MAX_SEARCHES_PER_RUN} short query strings ] }`;
    const parsed = await structuredCall({ system, user, maxTokens: 800 });
    const qs = Array.isArray(parsed?.queries) ? parsed.queries.filter(q => typeof q === 'string' && q.trim()) : [];
    return (qs.length ? qs : fallback).slice(0, MAX_SEARCHES_PER_RUN);
  }

  // ── People ────────────────────────────────────────────────────────────────────
  // opts.funnel (optional) is a per-run counter object (see funnel.js). When
  // present, this records why a company yields no person: no search hits or a
  // model that named no one (no_person), or a candidate that failed a specific
  // gate in classifyPersonResult (rejected.<reason>).
  async findPeople(company, roles, { funnel = null } = {}) {
    this.ensureConfigured();
    const roleTerms = (roles && roles.length ? roles : ['Founder', 'Product Marketing']).slice(0, 4);
    const q = `"${company}" (${roleTerms.map(r => `"${r}"`).join(' OR ')}) site:linkedin.com/in`;
    const hits = await this.search(q, { num: 10 });
    if (!hits || !hits.length) { if (funnel) funnel.no_person += 1; return []; }

    const system = 'From LinkedIn search results, identify the single best CURRENT contact at the '
      + 'named company for competitor-intelligence outreach, preferring the given roles. Two '
      + 'separate checks must BOTH pass. (1) Employment is current: the result shows the role as '
      + 'present (present tense, no end date, and the headline is not prefixed "Ex-", "former", '
      + '"formerly", or "previously"), or a recent source ties them to the company today. (2) The '
      + 'company is the RIGHT one: the employer named on the person\'s own profile must be the '
      + 'target company. A matching job title at some OTHER company is never enough. Report '
      + 'current_employer exactly as it appears on the profile, and set company_match=true ONLY '
      + 'when that employer is the target company (allowing casing, domain forms, and legal-entity '
      + 'variants like "Labs", "Association", or "Inc"). If the only matches have left the company '
      + 'or work somewhere else, return { "person": null }. When in doubt, return null rather than '
      + 'guess. Never invent a person, an employer, or a profile URL: use only what appears in the '
      + 'results. Never use em-dashes, en-dashes, or a connecting "+"; write "and" instead. Return '
      + 'JSON only.';
    const user = `Company: ${company}\nPreferred roles: ${roleTerms.join(', ')}\n\n`
      + 'Results (JSON):\n' + JSON.stringify(hits)
      + '\n\nReturn: { "person": { "person_name": string, "person_title": string (their CURRENT '
      + 'title at the company), "person_seniority": string, "profileUrl": string (must be one of the '
      + 'result links), "channel": "linkedin", "current_employer": string (the employer named on '
      + 'their profile, exactly as written), "company_match": boolean (true only if current_employer '
      + 'is the target company), "employment_verified": boolean (true only if the results show they '
      + 'currently work at the company), "employment_evidence": string (the exact phrase from the '
      + 'result that shows current employment) } } or { "person": null } if no verified current '
      + 'employee of THIS company fits.';
    const parsed = await structuredCall({ system, user, maxTokens: 800 });
    const p = parsed?.person;
    // Model named no one at this company: no candidate to even evaluate.
    if (!p) { if (funnel) funnel.no_person += 1; return []; }

    const { person, reason } = classifyPersonResult(company, p, hits);
    if (!person) {
      recordRejection(funnel, reason);
      // Log the target company and the employer the model returned, so a bad
      // name match (right title, wrong company) is visible at a glance.
      console.warn('[outbound.provider] rejected person for ' + JSON.stringify(company)
        + ': gate=' + reason
        + ' current_employer=' + JSON.stringify(p.current_employer || null));
      return [];
    }
    return [person];
  }

  // ── Contact ────────────────────────────────────────────────────────────────────
  // Phase 1: no email finder. Always manual, with the profile URL preserved so it
  // can be grabbed via the Apollo/Hunter Chrome extension. Never fabricated.
  async findContact(person) {
    return {
      contact_status: 'manual',
      channel: person?.channel || 'linkedin',
      handle_or_email: person?.profileUrl || null,
      backup_channel: person?.profileUrl ? 'linkedin' : null,
      profileUrl: person?.profileUrl || null,
    };
  }
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when the text reads as a PAST employee of this specific company, e.g.
// "Ex-Acme", "formerly at Acme", "previously Acme", "left Acme". Tied to the
// company name within a short window so an unrelated "formerly at Google" on
// someone who now works at Acme does not trip it.
function looksFormerAtCompany(text, company) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const c = String(company || '').toLowerCase().trim();
  if (!c) return false;
  const cq = escapeRegex(c);
  return (
    new RegExp(`\\bex[-\\s]?${cq}\\b`).test(t) ||
    new RegExp(`\\b(former|formerly|previously)\\b[^.;|]{0,40}\\b${cq}\\b`).test(t) ||
    new RegExp(`\\b(left|no longer (?:at|with))\\b[^.;|]{0,20}\\b${cq}\\b`).test(t)
  );
}

// Decide whether the model's person result is a real, attach-able lead for THIS
// company, and report WHICH gate it failed. Two independent checks must BOTH
// pass — "has the right title" and "actually works at this company" are
// separate, and a title match alone is never enough. Returns
// { person, reason }: on acceptance person is the normalized object and reason
// is null; on rejection person is null and reason is one of funnel.js's
// REJECTION_REASONS. Keep the reason strings in sync with that list.
function classifyPersonResult(company, p, hits) {
  const list = Array.isArray(hits) ? hits : [];
  // Must be a real result the search actually returned (no fabricated profile).
  if (!p || !p.profileUrl || !list.some(h => h.link === p.profileUrl)) {
    return { person: null, reason: 'not_in_hits' };
  }

  // Check 1 — employment is current. Require the model's present-tense
  // confirmation, and reject anyone whose own result still reads as a former
  // employee of THIS company (a backstop for model slips).
  if (p.employment_verified !== true) return { person: null, reason: 'employment_unverified' };
  const matched = list.find(h => h.link === p.profileUrl);
  const evidence = `${p.person_title || ''} ${matched?.title || ''} ${matched?.snippet || ''}`;
  if (looksFormerAtCompany(evidence, company)) return { person: null, reason: 'former_employee' };

  // Check 2 — the company is the RIGHT one. The model must both claim a match
  // and hand back the employer it read off the profile; the programmatic
  // backstop then confirms that employer normalizes to the target company. A
  // missing or mismatched employer is a rejection, no matter how good the title.
  if (p.company_match !== true) return { person: null, reason: 'company_match_false' };
  if (!companyNamesMatch(p.current_employer, company)) return { person: null, reason: 'employer_mismatch' };

  return {
    reason: null,
    person: {
      person_name: p.person_name || null,
      person_title: p.person_title || null,
      person_seniority: p.person_seniority || null,
      profileUrl: p.profileUrl,
      channel: p.channel || 'linkedin',
      employment_verified: true,
      current_employer: p.current_employer || null,
      company_match: true,
    },
  };
}

// Thin wrapper: the accepted person object, or null. Kept for callers/tests that
// only care about the decision, not the rejection reason.
function evaluatePersonResult(company, p, hits) {
  return classifyPersonResult(company, p, hits).person;
}

// Normalize a company name for comparison: lowercase, drop a domain's TLD, strip
// punctuation and common legal/entity suffix words (Inc, Labs, Foundation,
// Association, Ltd, and friends), then remove whitespace. So "Morpho",
// "Morpho Labs", "Morpho Association", "MORPHO", and "morpho.org" all collapse to
// "morpho", while "Aware, Inc." collapses to "aware".
function normalizeCompanyName(name) {
  let s = String(name || '').toLowerCase().trim();
  if (!s) return '';
  // Domain / URL form: strip protocol, www, and any path, then drop the TLD.
  // Split on "/" only (a URL path), never on whitespace, so a multi-word company
  // name like "Morpho Genetics" is not truncated to its first word.
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();
  if (/\.[a-z]{2,}$/.test(s)) s = s.replace(/\.[a-z.]+$/, '');
  // Keep only letters, digits, and spaces.
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  // Strip common legal / entity suffix words wherever they appear as whole words.
  s = s.replace(/\b(inc|incorporated|llc|ltd|limited|labs?|foundation|association|corp|corporation|co|company|gmbh|ag|sa|plc|group|holdings?)\b/g, ' ');
  // Collapse to a single token for a lenient, order-preserving comparison.
  return s.replace(/\s+/g, '');
}

// True when two company names refer to the same company after normalization.
// Exact normalized equality only — never substring/containment, so "Morpho"
// does not falsely match an unrelated "Morpho Genetics". An empty side (e.g. no
// verifiable employer) never matches.
function companyNamesMatch(a, b) {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  return Boolean(na) && Boolean(nb) && na === nb;
}

// ── Peer / competitor classification ──────────────────────────────────────────
// Nivaria must never pitch a company that itself SELLS competitor monitoring.
// The test is CAPABILITY, not category: any company that BUILDS OR SHIPS
// competitor-monitoring in any form is a peer, whether that is its core product
// (Crayon, Klue), a FEATURE bolted onto a product with a different core business
// (a POS that tracks rival menus and prices, an e-commerce platform with rival
// price monitoring, a marketing suite with competitor dashboards), or an
// adjacent monitoring product (price tracking, SEO/traffic, social listening,
// market/media intelligence). The question is "does this company sell competitor
// monitoring to anyone?", not "is it their main business?".
//
// The opposite is a PROSPECT: a company that does competitor tracking MANUALLY,
// HIRES for it, has a /compare page, or LOSES deals to rivals. They need the
// product. Shipping the capability is the disqualifier, not the pain.

// Companies whose product is (or includes) competitor monitoring. Matched on a
// word boundary against the company name so a prospect is not tripped by a
// coincidental substring.
const KNOWN_PEER_VENDORS = [
  // core competitive-intelligence products
  'crayon', 'klue', 'kompyte', 'contify', 'nektar', 'gong', 'cluedin',
  // competitor price tracking
  'prisync', 'competera', 'price2spy', 'wiser', 'intelligence node', 'dealavo',
  // SEO / traffic / market intelligence
  'semrush', 'ahrefs', 'similarweb', 'spyfu',
  // social listening / media intelligence
  'brandwatch', 'meltwater', 'sprout social', 'sprinklr', 'talkwalker',
];

// The monitoring capability itself, in its many phrasings.
const CAPABILITY_RE = new RegExp(
  '(?:competitor|competitors|competitive|rival|rivals)[\\s-]*'
    + '(?:analysis|analytics|intelligence|tracking|track|monitoring|monitor|insights?|benchmark\\w*|price\\w*|pricing|menu\\w*|dashboards?)'
  + '|(?:price|pricing)[\\s-]*(?:monitoring|monitor|tracking|track|intelligence)'
  + '|(?:market|media)[\\s-]*intelligence'
  + '|social[\\s-]*listening',
  'i',
);

// Nouns that mark a capability as a SHIPPED thing (a product or a feature).
const PRODUCT_NOUN_RE = /\b(?:features?|tools?|toolkit|products?|platform|modules?|suite|dashboards?|capabilit(?:y|ies)|functionality|add[\s-]?ons?|integration|software|apps?|solutions?|offering|service)\b/i;

// Nouns that mark a capability as an INTERNAL role/team/hire, i.e. a prospect
// that does it by hand or is staffing up for it, not one that sells it.
const ROLE_NOUN_RE = /\b(?:analysts?|hire|hires|hiring|roles?|managers?|teams?|leads?|directors?|specialists?|headcount|positions?|functions?|departments?|staff)\b/i;

// Verbs that mean the company put the capability into market.
const SHIP_VERB_RE = /\b(?:launch\w*|announc\w*|introduc\w*|unveil\w*|ship\w*|releas\w*|roll(?:ing|ed|s)?\s*out|debut\w*|add(?:s|ed|ing)?|built|build\w*|offer\w*|provid\w*|sell\w*|sold|power\w*|bring\w*|new)\b/i;

function escapeRegexWord(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Does this trigger text describe the company SHIPPING competitor-monitoring
// capability (the inverted signal)? Returns the matched capability phrase, or
// null. A capability that is productized (a product noun in or right after the
// phrase) or introduced by a ship verb is shipping; a capability attached to a
// role/team/hire is an internal prospect signal, not shipping.
function shipsCapability(text) {
  const t = String(text || '').toLowerCase();
  const m = CAPABILITY_RE.exec(t);
  if (!m) return null;
  const end = m.index + m[0].length;
  const before = t.slice(Math.max(0, m.index - 24), m.index);
  const after = t.slice(end, end + 35);
  // Productized: a product noun inside the matched phrase ("competitor
  // dashboards") or immediately after it ("price-monitoring feature").
  if (PRODUCT_NOUN_RE.test(m[0]) || PRODUCT_NOUN_RE.test(after)) return m[0].trim();
  // Role/team/hire after the capability -> prospect, not a shipped product.
  if (ROLE_NOUN_RE.test(after)) return null;
  // Otherwise a ship verb introducing the capability means they built it.
  if (SHIP_VERB_RE.test(before)) return m[0].trim();
  return null;
}

// Classify a discovered company as a 'peer' (sells competitor monitoring, must
// never be pitched) or a 'prospect' (a valid lead). Pure and deterministic so it
// is cheap and testable; the discovery prompt also excludes peers at the source.
// Returns { classification, reason }.
function classifyCompany(company) {
  const name = String(company?.company || '');
  const category = String(company?.category || '');
  const trigger = String(company?.trigger || '');

  // 1) Known vendor whose product is competitor monitoring.
  const nameL = name.toLowerCase();
  for (const v of KNOWN_PEER_VENDORS) {
    if (new RegExp('\\b' + escapeRegexWord(v) + '\\b', 'i').test(nameL)) {
      return { classification: 'peer', reason: 'known competitor-monitoring vendor (' + v + ')' };
    }
  }

  // 2) The category itself names a monitoring product line.
  if (CAPABILITY_RE.test(category)) {
    return { classification: 'peer', reason: 'category is a competitor-monitoring product: ' + category };
  }

  // 3) Inverted signal: the trigger says the company BUILDS or SHIPS the
  //    capability (as a product or a feature). Building it is proof they will
  //    not buy it, so it disqualifies rather than signalling pain.
  const shipped = shipsCapability(trigger);
  if (shipped) {
    return { classification: 'peer', reason: 'ships competitor-monitoring capability: "' + shipped + '"' };
  }

  return { classification: 'prospect', reason: null };
}

// Normalize a model-supplied trigger date to an ISO YYYY-MM-DD string, or null.
// Rejects unparseable, future (beyond today), or absurdly old (>10 years) values
// so a hallucinated date cannot masquerade as fresh intel.
function normalizeTriggerDate(v) {
  if (!v) return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) return null;
  const now = Date.now();
  if (t > now + 86400000) return null;                 // future
  if (t < now - 10 * 365 * 86400000) return null;      // older than ~10 years
  return new Date(t).toISOString().slice(0, 10);
}

// Sort key for freshness-first ordering: newer dates rank lower (come first),
// undated triggers rank last.
function triggerRecencyRank(dateStr) {
  const t = Date.parse(dateStr || '');
  return Number.isFinite(t) ? -t : Infinity;
}

// Very light region -> Serper country-code hint.
function regionHintToGl(hint) {
  const h = String(hint || '').toLowerCase();
  if (/\b(us|usa|united states|north america)\b/.test(h)) return 'us';
  if (/\b(uk|united kingdom|britain|england)\b/.test(h)) return 'gb';
  if (/\b(canada)\b/.test(h)) return 'ca';
  if (/\b(australia)\b/.test(h)) return 'au';
  if (/\b(germany|dach)\b/.test(h)) return 'de';
  return undefined;
}

// Default Phase-1 provider. Swap this factory for an enrichment provider in
// Phase 2; the pipeline only depends on the interface.
function getProvider() {
  return new SearchFirstProvider();
}

module.exports = {
  SearchFirstProvider, getProvider, OutboundConfigError, rolesForStage,
  classifyPersonResult, evaluatePersonResult, normalizeCompanyName, companyNamesMatch,
  looksFormerAtCompany, classifyCompany, poolSizeFor,
  DISCOVERY_MULTIPLIER, MAX_POOL, MAX_SEARCHES_PER_RUN, MAX_RAW_RESULTS,
};
