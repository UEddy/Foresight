// Renders a content page (and the 404) as a full, self-contained branded HTML
// document. No view engine: this codebase renders HTML strings (see
// routes/legal.js and routes/admin.js), so the content template follows the same
// pattern. Everything the template needs comes from frontmatter (the contract),
// never from parsing rendered HTML.
//
// The 9-part order in renderContentPage is deliberate and must not be reordered:
// H1, then the extractable answer paragraph directly under it, then the visible
// updated date, table of contents, body, FAQ, CTA, and both JSON-LD blocks. That
// order is what makes a passage extractable by AI answer engines.

const { marked } = require('marked');
const { isoDate, displayDate } = require('./loader');

const ORIGIN = 'https://nivaria.app';
const ORG_ID = 'https://nivaria.app/#organization';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Decode the handful of HTML entities `marked` emits in its rendered output, so
// text extracted FROM that HTML (the TOC heading labels) holds real characters
// again. Without this the extracted "don&#39;t" would be escaped a second time
// by escapeHtml into "don&amp;#39;t", which a browser shows as the literal
// "don&#39;t". Decode &amp; last so an already-escaped "&amp;#39;" is not turned
// into an apostrophe. Only used for plain-text extraction, never on markup.
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Slug for a heading id derived from its text. Lowercase, alphanumerics only,
// hyphen-joined.
function slugify(s) {
  return String(s).toLowerCase().replace(/<[^>]*>/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

// Render the markdown body to HTML and collect the table of contents. Adds an
// id to every h2/h3 (honoring an explicit Kramdown-style "{#id}" suffix, else
// slugifying the text) and strips any HTML comments so editorial notes in a
// source file never reach the public page. Returns { html, toc } where toc is
// the list of h2 headings, in order.
function renderBody(markdown) {
  const withoutComments = String(markdown || '').replace(/<!--[\s\S]*?-->/g, '');
  let html = marked.parse(withoutComments);
  const toc = [];

  html = html.replace(/<(h[23])(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g, (_m, tag, inner) => {
    let explicitId = null;
    let cleanInner = inner;
    const idMatch = inner.match(/\s*\{#([a-zA-Z0-9_-]+)\}\s*$/);
    if (idMatch) { explicitId = idMatch[1]; cleanInner = inner.slice(0, idMatch.index); }
    const plain = decodeEntities(cleanInner.replace(/<[^>]*>/g, '').trim());
    const id = explicitId || slugify(plain);
    if (tag === 'h2') toc.push({ id, text: plain });
    return `<${tag} id="${escapeAttr(id)}">${cleanInner.trim()}</${tag}>`;
  });

  return { html, toc };
}

// JSON-LD, safe to embed in a <script>: escape "<" so a "</script>" inside any
// string can never break out of the block.
function jsonLd(obj) {
  return JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
}

function articleSchema(meta, canonical) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: meta.h1 || meta.title || '',
    description: meta.description || meta.answer || '',
    datePublished: isoDate(meta.published),
    dateModified: isoDate(meta.updated),
    author: { '@type': 'Person', name: meta.author || 'Nivaria' },
    publisher: { '@id': ORG_ID },
    mainEntityOfPage: canonical,
  };
}

// FAQPage schema from frontmatter, or null when there are no faqs (so the block
// is only emitted when present and non-empty, per the spec).
function faqSchema(meta) {
  const faqs = Array.isArray(meta.faqs) ? meta.faqs.filter(f => f && f.q && f.a) : [];
  if (!faqs.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

function tocHtml(toc, hasFaqs) {
  const items = toc.map(h => `<li><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>`);
  if (hasFaqs) items.push('<li><a href="#faq">Frequently asked questions</a></li>');
  if (!items.length) return '';
  return `
    <nav class="content-toc" aria-label="On this page">
      <div class="content-toc-title">On this page</div>
      <ul>${items.join('')}</ul>
    </nav>`;
}

function faqHtml(meta) {
  const faqs = Array.isArray(meta.faqs) ? meta.faqs.filter(f => f && f.q && f.a) : [];
  if (!faqs.length) return '';
  const items = faqs.map(f => `
      <div class="faq-item">
        <h3 class="faq-q">${escapeHtml(f.q)}</h3>
        <p class="faq-a">${escapeHtml(f.a)}</p>
      </div>`).join('');
  return `
    <section class="content-faq" aria-labelledby="faq">
      <h2 id="faq">Frequently asked questions</h2>
      ${items}
    </section>`;
}

function ctaHtml() {
  return `
    <aside class="content-cta">
      <h2 class="content-cta-title">See it on your own competitors</h2>
      <p class="content-cta-sub">Start a 14-day free trial. No credit card required.</p>
      <a class="content-cta-btn" href="/register">Start free trial</a>
    </aside>`;
}

const HEAD_STYLE = `
  <style>
    :root {
      --c-bg:#000; --c-bg-2:#0A0A0A; --c-border:rgba(255,255,255,0.08);
      --c-txt:#E8ECF4; --c-txt-2:#94A3B8; --c-txt-3:#64748B; --c-accent:#818CF8;
      --c-accent-solid:#4338CA; --c-nav-h:64px; color-scheme:dark;
    }
    [data-theme="light"] {
      --c-bg:#FFF; --c-bg-2:#F4F4F8; --c-border:rgba(0,0,0,0.10);
      --c-txt:#0C0C14; --c-txt-2:#475569; --c-txt-3:#64748B; --c-accent:#4F46E5;
      --c-accent-solid:#4338CA; color-scheme:light;
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html{scroll-behavior:smooth;scroll-padding-top:calc(var(--c-nav-h) + 16px)}
    body{font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,sans-serif;
      background:var(--c-bg);color:var(--c-txt);-webkit-font-smoothing:antialiased;
      display:flex;flex-direction:column;min-height:100vh;line-height:1.6}
    a{color:var(--c-accent);text-decoration:none}
    .c-nav{height:var(--c-nav-h);border-bottom:1px solid var(--c-border);display:flex;
      align-items:center;position:sticky;top:0;z-index:10;
      background:color-mix(in srgb,var(--c-bg) 88%,transparent);backdrop-filter:blur(12px)}
    .c-nav-inner{width:100%;max-width:820px;margin:0 auto;padding:0 24px;display:flex;
      align-items:center;justify-content:space-between;gap:16px}
    .c-logo{display:flex;align-items:center;gap:10px;color:var(--c-txt);text-decoration:none}
    .c-logo-icon{width:32px;height:32px;border-radius:9px;background:var(--c-accent-solid);
      display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .c-logo-name{font-size:16px;font-weight:700;letter-spacing:-0.3px}
    .c-nav-cta{font-size:13.5px;font-weight:700;color:#fff;background:var(--c-accent-solid);
      padding:8px 16px;border-radius:9px;text-decoration:none}
    .c-main{flex:1;padding:48px 24px 72px}
    .content{max-width:720px;margin:0 auto;font-size:16px;color:var(--c-txt-2)}
    .content h1{font-size:2.1rem;line-height:1.15;color:var(--c-txt);letter-spacing:-0.8px;margin:0 0 1rem}
    .content-answer{font-size:1.15rem;line-height:1.6;color:var(--c-txt);margin:0 0 1rem}
    .content-updated{font-size:0.8125rem;color:var(--c-txt-3);margin:0 0 1.75rem}
    .content-toc{border:1px solid var(--c-border);border-radius:12px;padding:16px 20px;
      margin:0 0 2rem;background:var(--c-bg-2)}
    .content-toc-title{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;
      color:var(--c-txt-3);font-weight:700;margin-bottom:10px}
    .content-toc ul{list-style:none;display:flex;flex-direction:column;gap:8px}
    .content-toc a{font-size:0.9375rem;color:var(--c-txt-2)}
    .content-toc a:hover{color:var(--c-accent)}
    .content-body h2,.content-faq h2{font-size:1.4rem;color:var(--c-txt);letter-spacing:-0.3px;
      margin:2.6rem 0 0.7rem;line-height:1.25}
    .content-body h3,.faq-q{font-size:1.08rem;color:var(--c-txt);margin:1.6rem 0 0.4rem}
    .content-body p,.content-body li{margin:0.7rem 0}
    .content-body ul,.content-body ol{padding-left:1.4rem;margin:0.6rem 0}
    .content-body strong{color:var(--c-txt);font-weight:700}
    .content-body em{color:var(--c-txt)}
    .content-body a{text-decoration:underline;text-underline-offset:2px}
    .content-body a:hover{text-decoration:none}
    .content-body code{background:var(--c-bg-2);border:1px solid var(--c-border);
      border-radius:5px;padding:1px 6px;font-size:0.9em}
    .content-body blockquote{border-left:3px solid var(--c-border);padding-left:16px;
      margin:1rem 0;color:var(--c-txt-2)}
    .content-body hr{border:none;border-top:1px solid var(--c-border);margin:2rem 0}
    .content-faq{margin-top:2.4rem}
    .faq-item{padding:16px 0;border-top:1px solid var(--c-border)}
    .faq-q{margin:0 0 0.35rem}
    .faq-a{margin:0}
    .content-cta{margin-top:2.8rem;border:1px solid var(--c-border);border-radius:14px;
      padding:28px 24px;text-align:center;background:var(--c-bg-2)}
    .content-cta-title{font-size:1.3rem;color:var(--c-txt);margin:0 0 0.4rem;letter-spacing:-0.3px}
    .content-cta-sub{color:var(--c-txt-2);margin:0 0 16px;font-size:0.95rem}
    .content-cta-btn{display:inline-block;background:var(--c-accent-solid);color:#fff;
      font-weight:700;font-size:0.95rem;padding:11px 24px;border-radius:10px;text-decoration:none}
    .c-footer{border-top:1px solid var(--c-border);padding:28px 24px}
    .c-footer-inner{max-width:820px;margin:0 auto;display:flex;align-items:center;
      justify-content:space-between;gap:16px;flex-wrap:wrap}
    .c-footer-copy{font-size:0.8125rem;color:var(--c-txt-3)}
    .c-footer-links{display:flex;gap:22px;flex-wrap:wrap}
    .c-footer-links a{font-size:0.8125rem;color:var(--c-txt-2)}
    .c-footer-links a:hover{color:var(--c-accent)}
    @media (max-width:600px){
      .c-main{padding:32px 20px 56px}
      .content h1{font-size:1.7rem}
      .content-answer{font-size:1.05rem}
      .c-footer-inner{flex-direction:column;align-items:flex-start;gap:14px}
    }
  </style>`;

// Anti-flash theme script, mirrors legal/auth/app (same 'cs-theme' key).
const THEME_SCRIPT = `
  <script>
  (function(){var v=localStorage.getItem('cs-theme')||'system';
   var r=v==='system'?(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):v;
   document.documentElement.setAttribute('data-theme',r);})();
  </script>`;

const FONT_LINKS = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet">`;

function navHtml() {
  return `
  <nav class="c-nav">
    <div class="c-nav-inner">
      <a href="/" class="c-logo" aria-label="Nivaria home">
        <span class="c-logo-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </span>
        <span class="c-logo-name">Nivaria</span>
      </a>
      <a href="/register" class="c-nav-cta">Start free trial</a>
    </div>
  </nav>`;
}

function footerHtml() {
  return `
  <footer class="c-footer" role="contentinfo">
    <div class="c-footer-inner">
      <span class="c-footer-copy">&copy; 2026 Nivaria</span>
      <nav class="c-footer-links" aria-label="Footer">
        <a href="/#pricing">Pricing</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="mailto:support@nivaria.app">support@nivaria.app</a>
      </nav>
    </div>
  </footer>`;
}

// Full HTML document for a content page. `meta` is the parsed frontmatter,
// `body` is the raw markdown body (FAQ and answer live in frontmatter, not here).
function renderContentPage(meta, body) {
  const slug = typeof meta.slug === 'string' && meta.slug.startsWith('/') ? meta.slug : '/';
  const canonical = ORIGIN + slug;
  const title = meta.title || meta.h1 || 'Nivaria';
  const description = meta.description || meta.answer || '';
  const { html: bodyHtml, toc } = renderBody(body);
  const hasFaqs = Array.isArray(meta.faqs) && meta.faqs.some(f => f && f.q && f.a);

  const article = articleSchema(meta, canonical);
  const faq = faqSchema(meta);
  const faqBlock = faq ? `\n  <script type="application/ld+json">\n${jsonLd(faq)}\n  </script>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttr(description)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="${escapeAttr(canonical)}">
  <meta property="og:title" content="${escapeAttr(title)}">
  <meta property="og:description" content="${escapeAttr(description)}">
  <meta property="og:url" content="${escapeAttr(canonical)}">
  <meta property="og:type" content="article">
  <meta property="og:image" content="${ORIGIN}/assets/og-image.png">
  <meta property="og:site_name" content="Nivaria">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttr(title)}">
  <meta name="twitter:description" content="${escapeAttr(description)}">
  <meta name="twitter:image" content="${ORIGIN}/assets/og-image.png">
  ${THEME_SCRIPT}
  ${FONT_LINKS}
  <link rel="icon" href="/assets/monogram-solid.svg">
  ${HEAD_STYLE}
  <script type="application/ld+json">
${jsonLd(article)}
  </script>${faqBlock}
</head>
<body>
  ${navHtml()}
  <main class="c-main">
    <article class="content">
      <h1>${escapeHtml(meta.h1 || title)}</h1>
      ${meta.answer ? `<p class="content-answer">${escapeHtml(meta.answer)}</p>` : ''}
      ${meta.updated ? `<p class="content-updated">Last updated: ${escapeHtml(displayDate(meta.updated))}</p>` : ''}
      ${tocHtml(toc, hasFaqs)}
      <div class="content-body">${bodyHtml}</div>
      ${faqHtml(meta)}
      ${ctaHtml()}
    </article>
  </main>
  ${footerHtml()}
</body>
</html>`;
}

// Real 404 page (status set by the caller). Branded, noindex.
function render404() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page not found | Nivaria</title>
  <meta name="robots" content="noindex, follow">
  ${THEME_SCRIPT}
  ${FONT_LINKS}
  <link rel="icon" href="/assets/monogram-solid.svg">
  ${HEAD_STYLE}
  <style>
    .nf-wrap{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
      text-align:center;padding:64px 24px;gap:14px}
    .nf-code{font-size:3.4rem;font-weight:800;letter-spacing:-2px;color:var(--c-txt)}
    .nf-msg{color:var(--c-txt-2);font-size:1rem;max-width:420px}
    .nf-btn{margin-top:8px;display:inline-block;background:var(--c-accent-solid);color:#fff;
      font-weight:700;padding:11px 24px;border-radius:10px;text-decoration:none}
  </style>
</head>
<body>
  ${navHtml()}
  <main class="nf-wrap">
    <div class="nf-code">404</div>
    <div class="nf-msg">We could not find that page. It may have moved, or the link may be wrong.</div>
    <a class="nf-btn" href="/">Back to home</a>
  </main>
  ${footerHtml()}
</body>
</html>`;
}

module.exports = { renderContentPage, render404, renderBody, slugify, articleSchema, faqSchema };
