// Content loader for the markdown-driven marketing pages (Module 2 architecture).
//
// Every page is a markdown file under /content/<section>/<slug>.md with YAML
// frontmatter (the frontmatter contract). The directory name maps to the URL
// segment: /content/for/sales-teams.md serves at /for/sales-teams. The loader
// reads a file, parses its frontmatter, and hands the raw markdown body back to
// the renderer. It NEVER trusts the URL as a path: the slug is validated against
// a strict pattern before it is joined to the content directory.

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const CONTENT_DIR = path.join(__dirname, '../../content');
const SECTIONS = ['for', 'blog', 'glossary', 'alternatives', 'compare'];

// The security control. A slug is lowercase words joined by single hyphens and
// nothing else, so "../../config" or "foo/bar" can never resolve to a file
// outside the section directory.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

// Load one page. Returns { meta, body } (raw markdown body, rendered by the
// template so the table of contents can be built from it), or null when the
// section is unknown, the slug is malformed, or the file does not exist. A null
// return is how the route falls through to the 404 handler.
function loadPage(section, slug) {
  if (!SECTIONS.includes(section)) return null;
  if (!isValidSlug(slug)) return null;

  const filePath = path.join(CONTENT_DIR, section, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const { data, content } = matter(fs.readFileSync(filePath, 'utf8'));
  return { meta: data, body: content };
}

// Every published page's frontmatter, for the sitemap. Reads frontmatter only.
function listPages() {
  const out = [];
  for (const section of SECTIONS) {
    const dir = path.join(CONTENT_DIR, section);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const slug = file.slice(0, -3);
      if (!isValidSlug(slug)) continue; // ignore stray/unsafe filenames
      try {
        const { data } = matter(fs.readFileSync(path.join(dir, file), 'utf8'));
        out.push({ section, slug, meta: data });
      } catch (_) { /* skip an unreadable/malformed file rather than crash */ }
    }
  }
  return out;
}

// Normalize a frontmatter date (a YAML date is parsed by gray-matter into a JS
// Date; a quoted string stays a string) to an ISO YYYY-MM-DD string. Returns ''
// when absent or unparseable. Uses UTC so a YAML date (UTC midnight) never
// shifts a day under the server timezone.
function isoDate(v) {
  if (!v) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Human display of a frontmatter date, e.g. "23 July 2026". Built from the ISO
// parts so it never drifts a day across timezones. Returns '' when absent.
function displayDate(v) {
  const iso = isoDate(v);
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

module.exports = { loadPage, listPages, isValidSlug, isoDate, displayDate, CONTENT_DIR, SECTIONS, SLUG_PATTERN };
