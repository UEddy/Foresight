const axios   = require('axios');
const cheerio = require('cheerio');
const crypto  = require('crypto');
const dns     = require('dns').promises;
const net     = require('net');

// Lazy require — Playwright is heavy and we don't want to pay the cost in fetch-only
// deployments. require('playwright') still triggers a binary lookup.
let _playwright = null;
function loadPlaywright() {
  if (!_playwright) _playwright = require('playwright');
  return _playwright;
}

class BlockedPageError extends Error {
  constructor(reason, url) {
    super(`Blocked page detected: ${reason}`);
    this.name = 'BlockedPageError';
    this.code = 'BLOCKED_PAGE';
    this.reason = reason;
    this.url = url;
  }
}

class EmptyContentError extends Error {
  constructor(reason, url) {
    super(`Empty content: ${reason}`);
    this.name = 'EmptyContentError';
    this.code = 'EMPTY_CONTENT';
    this.reason = reason;
    this.url = url;
  }
}

class SelectorNotFoundError extends Error {
  constructor(selector, url) {
    super(`Selector "${selector}" matched no elements on the page`);
    this.name = 'SelectorNotFoundError';
    this.code = 'SELECTOR_NOT_FOUND';
    this.selector = selector;
    this.url = url;
  }
}

class SsrfBlockedError extends Error {
  constructor(reason, url) {
    super(`SSRF blocked: ${reason}`);
    this.name = 'SsrfBlockedError';
    this.code = 'SSRF_BLOCKED';
    this.reason = reason;
    this.url = url;
  }
}

// A name-resolution failure (NXDOMAIN, no records, temporary SERVFAIL). This is
// explicitly NOT an SsrfBlockedError — the host simply doesn't resolve, which is
// a user typo / dead domain, not a security event. Keeping them distinct is the
// whole point of the error-categorization work: a non-existent subdomain must
// never be reported to the user as "blocked for security reasons".
class DnsError extends Error {
  constructor(hostname, dnsCode) {
    super(`DNS resolution failed for ${hostname} (${dnsCode})`);
    this.name = 'DnsError';
    this.code = 'DNS_NXDOMAIN';
    this.hostname = hostname;
    this.dnsCode = dnsCode;
  }
}

class RenderError extends Error {
  constructor(reason, url) {
    super(`Render failed: ${reason}`);
    this.name = 'RenderError';
    this.code = 'RENDER_FAILED';
    this.reason = reason;
    this.url = url;
  }
}

const EMPTY_BODY_THRESHOLD = 200;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Phase 3: cap concurrent Playwright contexts so a flood of checks can't exhaust memory.
const PLAYWRIGHT_MAX_CONCURRENT_CONTEXTS = 3;
const PLAYWRIGHT_NAV_TIMEOUT_MS         = 30_000;
const PLAYWRIGHT_NETWORKIDLE_TIMEOUT_MS = 5_000;

// Fingerprints of common bot-challenge / JS-wall pages. (Phase 2)
const BLOCK_FINGERPRINTS = [
  { label: 'Cloudflare challenge',  test: h => /cf-browser-verification|cf-chl-bypass|cf_chl_opt|cdn-cgi\/challenge-platform/i.test(h) },
  { label: 'Cloudflare challenge',  test: h => /just a moment\.{0,3}/i.test(h) && /cloudflare/i.test(h) },
  { label: 'Cloudflare challenge',  test: h => /checking your browser before accessing/i.test(h) },
  { label: 'DataDome challenge',    test: h => /captcha-delivery\.com/i.test(h) },
  { label: 'DataDome challenge',    test: h => /<script[^>]+(?:datadome|dd\.js)/i.test(h) },
  { label: 'DataDome challenge',    test: h => /datadome[_-]?(?:cookie|block|tags)|window\.ddjskey/i.test(h) },
  { label: 'DataDome block',        test: h => /sorry, you have been blocked/i.test(h) },
  { label: 'DataDome block',        test: h => /please enable js and disable any ad ?blocker/i.test(h) },
  { label: 'PerimeterX challenge',  test: h => /window\._pxAppId|_pxhd|px-captcha|\/_px_\//i.test(h) },
  { label: 'Akamai bot manager',    test: h => /access denied/i.test(h) && /reference\s*#?\s*\d{6,}/i.test(h) },
];

function detectBlockPage(rawHtml) {
  const html = String(rawHtml || '');
  for (const fp of BLOCK_FINGERPRINTS) {
    if (fp.test(html)) return fp.label;
  }
  return null;
}

function detectJsWall(rawHtml, content) {
  const html = String(rawHtml || '');
  const jsWallSignal = /you need to enable javascript|please enable javascript|enable javascript to (continue|run|view)/i.test(html);
  if (jsWallSignal && content.bodyText.length < 500) {
    return 'JavaScript-required wall (rendered shell only)';
  }
  return null;
}

function detectEmptyContent(content) {
  if (content.bodyText.length < EMPTY_BODY_THRESHOLD && content.headings.length === 0) {
    return `bodyText=${content.bodyText.length} chars, headings=${content.headings.length}, title="${content.title || ''}"`;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// SSRF guard — used by both render paths but critical for the Playwright path,
// where a real browser will follow redirects and load subresources. Checks
// against the *resolved* IP (not just the hostname) so DNS rebinding can't
// bypass it.
// ──────────────────────────────────────────────────────────────────────────────

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0)                              return true; // 0.0.0.0/8 unspecified
    if (a === 127)                            return true; // 127.0.0.0/8 loopback
    if (a === 10)                             return true; // 10.0.0.0/8
    if (a === 169 && b === 254)               return true; // link-local
    if (a === 172 && b >= 16 && b <= 31)      return true; // 172.16.0.0/12
    if (a === 192 && b === 168)               return true; // 192.168.0.0/16
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::')    return true;
    if (lower.startsWith('fe80:'))            return true; // link-local
    // fc00::/7  → first byte 0xfc or 0xfd
    if (/^f[cd][0-9a-f]{0,2}:/i.test(lower))  return true;
    // IPv4-mapped (::ffff:x.x.x.x)
    const m = lower.match(/^::ffff:([\d.]+)$/);
    if (m && net.isIPv4(m[1])) return isPrivateIp(m[1]);
    return false;
  }
  return false;
}

async function assertHostIsPublic(hostname) {
  if (!hostname) throw new SsrfBlockedError('empty hostname', hostname);
  if (hostname === 'localhost') {
    throw new SsrfBlockedError('hostname "localhost" not allowed', hostname);
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SsrfBlockedError(`IP literal ${hostname} is private / reserved`, hostname);
    }
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (err) {
    // A failed lookup is a DNS problem, not an SSRF attempt. NXDOMAIN / no
    // records / transient DNS errors surface as DnsError so the user sees
    // "this domain doesn't exist" instead of a scary (and wrong) security block.
    // Security is unaffected: we still throw and never proceed to fetch a host
    // we couldn't resolve and vet.
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'EAI_AGAIN') {
      throw new DnsError(hostname, err.code);
    }
    // Any other resolver failure stays conservative: treat as a block rather
    // than risk fetching a host we couldn't fully evaluate.
    throw new SsrfBlockedError(`DNS lookup failed for ${hostname}: ${err.message}`, hostname);
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new SsrfBlockedError(`${hostname} resolves to private IP ${a.address}`, hostname);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// FETCH path (axios + cheerio) — unchanged behavior from Phase 2
// ──────────────────────────────────────────────────────────────────────────────

async function fetchPageContentHttp(url, opts = {}) {
  const cssSelector = opts.cssSelector ? String(opts.cssSelector).trim() : null;

  const response = await axios.get(url, {
    timeout: 30000,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
    maxRedirects: 5,
  });

  const rawHtml = response.data;

  const blockLabel = detectBlockPage(rawHtml);
  if (blockLabel) throw new BlockedPageError(blockLabel, url);

  const $ = cheerio.load(rawHtml);

  $('script, style, noscript, svg, [aria-hidden="true"], .sr-only').remove();
  $('nav, footer, header').remove();
  $('[class*="cookie"], [id*="cookie"], [class*="banner"], [class*="popup"]').remove();

  const title           = $('title').text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const ogTitle         = $('meta[property="og:title"]').attr('content') || '';

  let scope;
  let scopeLabel;
  if (cssSelector) {
    let matched;
    try {
      matched = $(cssSelector);
    } catch {
      throw new SelectorNotFoundError(cssSelector, url);
    }
    if (!matched || matched.length === 0) throw new SelectorNotFoundError(cssSelector, url);
    scope = matched;
    scopeLabel = cssSelector;
  } else {
    scope = $('body');
    scopeLabel = null;
  }

  const headings = [];
  scope.find('h1, h2, h3').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > 2 && text.length < 200) headings.push(text);
  });
  scope.filter('h1, h2, h3').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > 2 && text.length < 200) headings.push(text);
  });

  const pricing  = extractByKeywords($, scope, ['pricing', 'price', 'plan', 'subscription', 'tier']);
  const features = extractByKeywords($, scope, ['feature', 'capability', 'solution', 'product']);
  const bodyText = scope.text().replace(/\s+/g, ' ').trim().substring(0, 40000);

  const content = {
    title,
    metaDescription,
    ogTitle,
    headings: headings.slice(0, 60),
    pricing:  pricing.substring(0, 8000),
    features: features.substring(0, 8000),
    bodyText,
    scope: scopeLabel,
  };

  const jsWall = detectJsWall(rawHtml, content);
  if (jsWall) throw new BlockedPageError(jsWall, url);

  const emptyReason = detectEmptyContent(content);
  if (emptyReason) throw new EmptyContentError(emptyReason, url);

  const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { content, hash, url };
}

function extractByKeywords($, scope, keywords) {
  const found = new Set();
  keywords.forEach(kw => {
    scope.find(`[class*="${kw}"], [id*="${kw}"]`).each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > 30) found.add(text.substring(0, 3000));
    });
    scope.filter(`[class*="${kw}"], [id*="${kw}"]`).each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > 30) found.add(text.substring(0, 3000));
    });
  });
  return Array.from(found).join('\n\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// PLAYWRIGHT path — single shared browser, fresh isolated context per check.
// ──────────────────────────────────────────────────────────────────────────────

let _browserPromise = null;
async function getBrowser() {
  if (_browserPromise) return _browserPromise;
  _browserPromise = (async () => {
    const { chromium } = loadPlaywright();
    const b = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ],
    });
    b.on('disconnected', () => { _browserPromise = null; });
    return b;
  })();
  try {
    return await _browserPromise;
  } catch (err) {
    _browserPromise = null;
    throw err;
  }
}

async function closeBrowser() {
  if (!_browserPromise) return;
  try {
    const b = await _browserPromise;
    await b.close();
  } catch { /* ignore */ }
  _browserPromise = null;
}

// Semaphore — caps concurrent Playwright contexts at 3 globally.
let _active = 0;
const _waiters = [];
function _activeContexts() { return _active; }
async function acquireSlot() {
  if (_active < PLAYWRIGHT_MAX_CONCURRENT_CONTEXTS) { _active++; return; }
  await new Promise(resolve => _waiters.push(resolve));
  _active++;
}
function releaseSlot() {
  _active--;
  const next = _waiters.shift();
  if (next) next();
}

async function fetchPageContentJs(url, opts = {}) {
  const cssSelector = opts.cssSelector ? String(opts.cssSelector).trim() : null;

  // Pre-flight SSRF check — fail fast before launching a context.
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(`disallowed protocol ${parsed.protocol}`, url);
  }
  await assertHostIsPublic(parsed.hostname);

  await acquireSlot();

  let context, page;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      permissions: [],          // explicit empty — no geo, camera, mic, notifications, clipboard
      acceptDownloads: false,
      bypassCSP: false,
      ignoreHTTPSErrors: false,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.5',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    // SSRF enforcement at navigation time — every request (incl. redirects and
    // subresources) is resolved and aborted if it lands on a private IP. Catches
    // DNS rebinding, meta-refresh into a private host, and image/script SSRF.
    await context.route('**/*', async (route, request) => {
      try {
        const u = new URL(request.url());
        if (u.protocol === 'data:' || u.protocol === 'about:') return route.continue();
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.abort('blockedbyclient');
        await assertHostIsPublic(u.hostname);
        return route.continue();
      } catch {
        return route.abort('blockedbyclient');
      }
    });

    page = await context.newPage();

    // Block popups / new tabs. The handler must be attached AFTER newPage so
    // the page-event for our own primary page doesn't trip it.
    context.on('page', popup => {
      if (popup !== page) popup.close().catch(() => {});
    });

    // Auto-dismiss alert/confirm/prompt/beforeunload dialogs.
    page.on('dialog', d => d.dismiss().catch(() => {}));
    // Belt-and-braces: cancel any download that slips through.
    page.on('download', d => d.cancel().catch(() => {}));

    let response;
    try {
      response = await page.goto(url, {
        timeout: PLAYWRIGHT_NAV_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      });
    } catch (err) {
      // The route() handler aborts SSRF-blocked navigations, which surfaces as
      // "net::ERR_BLOCKED_BY_CLIENT". Re-resolve to confirm and throw the right error.
      if (/ERR_BLOCKED_BY_CLIENT/.test(err.message)) {
        try { await assertHostIsPublic(parsed.hostname); } catch (ssrfErr) { throw ssrfErr; }
        throw new SsrfBlockedError('navigation blocked by client', url);
      }
      throw new RenderError(err.message, url);
    }

    if (response && response.status() >= 400) {
      const err = new Error(`HTTP ${response.status()}`);
      err.response = { status: response.status() };
      throw err;
    }

    // After DOMContentLoaded, give scripts up to 5s to settle. Many SaaS pages
    // never reach networkidle because of analytics beacons / long-poll WS, so
    // a timeout here is normal and not an error.
    try {
      await page.waitForLoadState('networkidle', { timeout: PLAYWRIGHT_NETWORKIDLE_TIMEOUT_MS });
    } catch { /* expected — proceed with whatever is rendered */ }

    // Defense in depth: re-check the *final* URL host (after any client-side
    // navigation / meta-refresh) before we trust the rendered DOM.
    const finalUrl = page.url();
    try {
      const finalParsed = new URL(finalUrl);
      await assertHostIsPublic(finalParsed.hostname);
    } catch (ssrfErr) {
      throw ssrfErr;
    }

    const extracted = await page.evaluate(({ selector }) => {
      function clean(node) {
        const copy = node.cloneNode(true);
        copy.querySelectorAll(
          'script, style, noscript, svg, [aria-hidden="true"], .sr-only, nav, footer, header,' +
          '[class*="cookie"], [id*="cookie"], [class*="banner"], [class*="popup"]'
        ).forEach(n => n.remove());
        return copy;
      }
      function textOf(node) {
        return (node.textContent || '').replace(/\s+/g, ' ').trim();
      }

      const title           = (document.querySelector('title')?.textContent || '').trim();
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const ogTitle         = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';

      let scopeNode = null;
      let selectorMatched = true;
      let selectorThrew = false;
      if (selector) {
        try {
          scopeNode = document.querySelector(selector);
        } catch {
          scopeNode = null;
          selectorThrew = true;
        }
        if (!scopeNode) selectorMatched = false;
      } else {
        scopeNode = document.body;
      }
      if (!scopeNode) {
        return { title, metaDescription, ogTitle, selectorMatched, selectorThrew, headings: [], pricing: '', features: '', bodyText: '' };
      }

      const cleanedScope = clean(scopeNode);

      const headings = [];
      cleanedScope.querySelectorAll('h1, h2, h3').forEach(h => {
        const t = textOf(h);
        if (t.length > 2 && t.length < 200) headings.push(t);
      });
      if (cleanedScope.matches && cleanedScope.matches('h1, h2, h3')) {
        const t = textOf(cleanedScope);
        if (t.length > 2 && t.length < 200) headings.push(t);
      }

      function extractByKeywords(keywords) {
        const found = new Set();
        for (const kw of keywords) {
          const sel = `[class*="${kw}"], [id*="${kw}"]`;
          cleanedScope.querySelectorAll(sel).forEach(el => {
            const t = textOf(el);
            if (t.length > 30) found.add(t.substring(0, 3000));
          });
          if (cleanedScope.matches && cleanedScope.matches(sel)) {
            const t = textOf(cleanedScope);
            if (t.length > 30) found.add(t.substring(0, 3000));
          }
        }
        return Array.from(found).join('\n\n');
      }

      const pricing  = extractByKeywords(['pricing', 'price', 'plan', 'subscription', 'tier']).substring(0, 8000);
      const features = extractByKeywords(['feature', 'capability', 'solution', 'product']).substring(0, 8000);
      const bodyText = textOf(cleanedScope).substring(0, 40000);

      return { title, metaDescription, ogTitle, selectorMatched, selectorThrew, headings: headings.slice(0, 60), pricing, features, bodyText };
    }, { selector: cssSelector });

    if (cssSelector && !extracted.selectorMatched) {
      throw new SelectorNotFoundError(cssSelector, url);
    }

    const content = {
      title:           extracted.title,
      metaDescription: extracted.metaDescription,
      ogTitle:         extracted.ogTitle,
      headings:        extracted.headings,
      pricing:         extracted.pricing,
      features:        extracted.features,
      bodyText:        extracted.bodyText,
      scope:           cssSelector || null,
    };

    const emptyReason = detectEmptyContent(content);
    if (emptyReason) throw new EmptyContentError(emptyReason, url);

    const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
    return { content, hash, url };
  } finally {
    if (page)    { try { await page.close();    } catch { /* ignore */ } }
    if (context) { try { await context.close(); } catch { /* ignore */ } }
    releaseSlot();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Dispatcher — selects fetch vs js path based on competitor.render_mode
// ──────────────────────────────────────────────────────────────────────────────

async function fetchPageContent(url, opts = {}) {
  const mode = opts.renderMode === 'js' ? 'js' : 'fetch';
  const t0   = Date.now();
  const result = mode === 'js'
    ? await fetchPageContentJs(url, opts)
    : await fetchPageContentHttp(url, opts);
  return { ...result, renderMode: mode, renderDuration: Date.now() - t0 };
}

function generateDiff(before, after) {
  if (!before) {
    return {
      isFirstCheck: true,
      added: [],
      removed: [],
      beforeHeadings: [],
      afterHeadings: after?.headings || [],
      beforePricing: '',
      afterPricing: after?.pricing || '',
      beforeFeatures: '',
      afterFeatures: after?.features || '',
      beforeTitle: '',
      afterTitle: after?.title || '',
    };
  }

  const beforeWords = new Set((before.bodyText || '').toLowerCase().split(/\W+/).filter(w => w.length > 4));
  const afterWords  = new Set((after.bodyText  || '').toLowerCase().split(/\W+/).filter(w => w.length > 4));

  const added   = [...afterWords].filter(w => !beforeWords.has(w)).slice(0, 80);
  const removed = [...beforeWords].filter(w => !afterWords.has(w)).slice(0, 80);

  return {
    isFirstCheck: false,
    added,
    removed,
    beforeHeadings: before.headings || [],
    afterHeadings:  after.headings  || [],
    beforePricing:  before.pricing  || '',
    afterPricing:   after.pricing   || '',
    beforeFeatures: before.features || '',
    afterFeatures:  after.features  || '',
    beforeTitle:    before.title    || '',
    afterTitle:     after.title     || '',
    beforeMeta:     before.metaDescription || '',
    afterMeta:      after.metaDescription  || '',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Error categorization — single source of truth for turning any thrown scrape
// error into a structured result the API/UI can act on. Returns:
//   error_type — stable machine code (e.g. DNS_NXDOMAIN) for logs/branching
//   status     — snake_case form stored in competitors.last_check_status and
//                matched by the frontend to pick a status pill
//   technical  — engineer-facing reason, written to logs only (never shown raw)
//   human      — the message the user actually sees
// The point is to stop lumping distinct failures (DNS typo, anti-bot wall,
// connection refused, real SSRF block) under one generic/misleading message.
// ──────────────────────────────────────────────────────────────────────────────
function classifyScrapeError(err, url) {
  const code       = err && err.code;
  const message    = (err && err.message) || String(err);
  const httpStatus = err && err.response && err.response.status;
  // Playwright wraps the underlying Chromium net error in the message, e.g.
  // "net::ERR_NAME_NOT_RESOLVED" / "net::ERR_CONNECTION_REFUSED".
  const netHint    = code === 'RENDER_FAILED' ? message : '';

  const make = (error_type, status, human) => ({
    error_type,
    status,
    human,
    technical: `${error_type}${url ? ` [${url}]` : ''}: ${message}`,
  });

  // 1. Real SSRF security block — a public-facing target resolved to a private
  //    / reserved address. This is the ONLY case that should mention security.
  if (code === 'SSRF_BLOCKED') {
    return make('SSRF_BLOCKED', 'ssrf_blocked',
      'This URL points to a private network address and cannot be monitored for security reasons.');
  }

  // 2. DNS / NXDOMAIN — dead domain or typo. Covers our DnsError, raw Node/axios
  //    getaddrinfo failures, and Playwright's ERR_NAME_NOT_RESOLVED.
  if (code === 'DNS_NXDOMAIN' || code === 'ENOTFOUND' || code === 'ENODATA' ||
      code === 'EAI_AGAIN' || /ERR_NAME_NOT_RESOLVED/i.test(netHint)) {
    return make('DNS_NXDOMAIN', 'dns_nxdomain',
      "This domain doesn't exist. Check the URL for typos.");
  }

  // 3. Connection refused / timeout / host unreachable — domain resolves but we
  //    can't establish a usable connection.
  const CONN_CODES = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET',
    'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_FAIL'];
  const isPlaywrightTimeout = err && (err.name === 'TimeoutError' || /Timeout.*exceeded/i.test(message));
  const isNetConnError = /ERR_CONNECTION_(REFUSED|TIMED_OUT|CLOSED|RESET)|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE/i.test(netHint);
  if (CONN_CODES.includes(code) || isPlaywrightTimeout || isNetConnError ||
      (code === 'RENDER_FAILED' && !httpStatus)) {
    return make('CONNECTION_FAILED', 'connection_failed',
      "Couldn't connect to this site. The server may be down or blocking us.");
  }

  // 4. HTTP status responses.
  if (httpStatus) {
    if (httpStatus === 401 || httpStatus === 403) {
      return make('ACCESS_DENIED', 'access_denied',
        'This site rejected our request. It may require login or have access restrictions.');
    }
    if (httpStatus >= 500) {
      return make('SERVER_ERROR', 'server_error',
        'The target site returned a server error. Try again later.');
    }
    if (httpStatus === 404) {
      return make('HTTP_ERROR', 'http_error',
        "We couldn't find that page (HTTP 404). Check the URL path.");
    }
    if (httpStatus === 429) {
      return make('HTTP_ERROR', 'http_error',
        'This site is rate-limiting us (HTTP 429). Try again later.');
    }
    return make('HTTP_ERROR', 'http_error', `This site returned HTTP ${httpStatus}.`);
  }

  // 5. Anti-bot challenge / bot-defense wall (Cloudflare, DataDome, etc.).
  //    A JavaScript-required shell is a different beast — it's JS-heavy content,
  //    not an active defense, so it falls through to EMPTY_CONTENT below.
  if (code === 'BLOCKED_PAGE' && !/javascript/i.test(err.reason || message)) {
    return make('ANTI_BOT', 'anti_bot',
      "This site has anti-bot protection. Nivaria can't monitor sites with active bot defense systems on your current plan. Business tier (coming soon) will support these.");
  }

  // 6. Selector matched nothing — page loaded, the user's CSS selector didn't.
  if (code === 'SELECTOR_NOT_FOUND') {
    return make('SELECTOR_NOT_FOUND', 'selector_not_found',
      `We loaded the page but your CSS selector ("${err.selector}") matched nothing. The page structure may have changed.`);
  }

  // 7. Empty / unextractable content, including JS-required walls.
  if (code === 'EMPTY_CONTENT' || code === 'BLOCKED_PAGE') {
    return make('EMPTY_CONTENT', 'empty_content',
      "Couldn't extract content from this site. The page may be JavaScript-heavy.");
  }

  // 8. Anything else — keep the legacy generic status so older pills still map.
  return make('UNKNOWN', 'fetch_failed',
    "Something went wrong fetching this site. We'll retry on the next check.");
}

module.exports = {
  fetchPageContent,
  generateDiff,
  detectBlockPage,
  detectJsWall,
  detectEmptyContent,
  isPrivateIp,
  assertHostIsPublic,
  classifyScrapeError,
  closeBrowser,
  _activeContexts,
  BlockedPageError,
  EmptyContentError,
  SelectorNotFoundError,
  SsrfBlockedError,
  DnsError,
  RenderError,
  EMPTY_BODY_THRESHOLD,
  PLAYWRIGHT_MAX_CONCURRENT_CONTEXTS,
};
