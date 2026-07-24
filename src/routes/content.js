// Content routes: the markdown-driven marketing pages, the generated sitemap,
// and the real 404 handler that replaces the old homepage catch-all.
//
// registerContentRoutes(app) MUST be called after the specific page routes
// (/login, /app, legal, admin) and BEFORE any wildcard, because Express matches
// in registration order. The 404 handler is registered last so it only fires for
// genuinely unmatched paths.

const { loadPage } = require('../content/loader');
const { renderContentPage, render404 } = require('../content/render');
const { buildSitemapXml } = require('../content/sitemap');

function registerContentRoutes(app) {
  // Generated sitemap. Registered as a route (the old static public/sitemap.xml
  // is removed) so it always reflects the files that actually exist.
  app.get('/sitemap.xml', (_req, res) => {
    res.type('application/xml').send(buildSitemapXml());
  });

  // One route for every content section: /:section/:slug. loadPage returns null
  // for an unknown section, a malformed slug, or a missing file, in which case
  // we fall through (next) to the 404 handler rather than serving anything.
  app.get('/:section/:slug', (req, res, next) => {
    const page = loadPage(req.params.section, req.params.slug);
    if (!page) return next();
    res.type('html').send(renderContentPage(page.meta, page.body));
  });
}

// Real 404. Registered LAST (after every other route). API paths get a JSON 404
// so programmatic clients are not handed an HTML page; everything else gets the
// branded 404 document. Either way the status is 404, never a 200 homepage.
function register404(app) {
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(404).type('html').send(render404());
  });
}

module.exports = { registerContentRoutes, register404 };
