// Unit tests for the peer/competitor classifier in src/outbound/provider.js.
// The test is CAPABILITY, not category: any company that builds or ships
// competitor monitoring (core product, a feature of a different core business,
// or an adjacent monitoring product) is a peer and must never become a lead. A
// company that does competitor tracking manually, hires for it, or loses deals
// to rivals is a prospect. Pure, no DB/network — run with
// `node test-outbound-peers.js`.

const assert = require('assert');
const { classifyCompany } = require('./src/outbound/provider');

let pass = 0, fail = 0;
function is(company, expected, label) {
  const got = classifyCompany(company).classification;
  try { assert.strictEqual(got, expected); console.log(`✅ ${label}`); pass++; }
  catch { console.log(`❌ ${label}\n     got:      ${got} (reason: ${JSON.stringify(classifyCompany(company).reason)})\n     expected: ${expected}`); fail++; }
}

// ── PEERS: they build or ship competitor monitoring ───────────────────────────

// Required case: a POS company shipping a competitor-analysis feature (the Lavu
// miss). A different core business, but it ships the capability.
is({ company: 'Lavu', category: 'Restaurant POS',
     trigger: 'Lavu shipped an AI competitor-analysis feature for restaurants' },
   'peer', 'POS shipping competitor analysis is a peer');

// Required case: an e-commerce tool with a price-monitoring feature.
is({ company: 'ShopFlow', category: 'E-commerce platform',
     trigger: 'Added a price-monitoring feature to track rival prices across marketplaces' },
   'peer', 'e-commerce price-monitoring feature is a peer');

// Feature framed as a capability the product now includes.
is({ company: 'BrandHub', category: 'Marketing suite',
     trigger: 'Launched competitor dashboards for social teams' },
   'peer', 'marketing suite shipping competitor dashboards is a peer');

// Core CI product, by vendor name (trigger says nothing about the capability).
is({ company: 'Crayon', category: 'Marketing technology',
     trigger: 'Crayon raised a Series C round' },
   'peer', 'known CI vendor (Crayon) is a peer');

// Adjacent monitoring product by vendor name.
is({ company: 'Semrush', category: 'SEO',
     trigger: 'Quarterly product update' },
   'peer', 'SEO/traffic competitor tool (Semrush) is a peer');

// The category itself is a monitoring product line.
is({ company: 'Acme', category: 'Competitive Intelligence',
     trigger: 'Grew ARR to 10M' },
   'peer', 'company whose category is competitive intelligence is a peer');

// Adjacent price-monitoring product by vendor name.
is({ company: 'Prisync', category: 'Retail',
     trigger: 'New integration announced' },
   'peer', 'price-tracking vendor (Prisync) is a peer');

// ── PROSPECTS: they need competitor monitoring ────────────────────────────────

// Required case: a POS company with NO CI feature, doing it by hand.
is({ company: 'BistroPay', category: 'Restaurant POS',
     trigger: 'Founder manually tracks competitor menus and prices in a spreadsheet' },
   'prospect', 'POS with no CI feature (manual tracking) is a valid lead');

// Hiring for competitive intelligence is a prospect signal, not a product.
is({ company: 'DataCorp', category: 'B2B SaaS',
     trigger: 'Opened a Competitive Intelligence Analyst role' },
   'prospect', 'hiring a CI analyst is a prospect');

// A /compare page positions against rivals; it is marketing, not a product.
is({ company: 'FlowApp', category: 'B2B SaaS',
     trigger: 'Launched a /compare page against three competitors' },
   'prospect', 'a /compare page is a prospect');

// Shopping for a tool is the opposite of selling one.
is({ company: 'GrowthCo', category: 'SaaS',
     trigger: 'Evaluating tools for competitor price tracking after losing deals' },
   'prospect', 'evaluating CI tools is a prospect');

// Losing deals to a rival is pain, not a shipped feature.
is({ company: 'SaaSly', category: 'SaaS',
     trigger: 'Losing deals to a competitor and tracking them by hand' },
   'prospect', 'losing deals to a competitor is a prospect');

// A pricing-page relaunch must not be read as price monitoring.
is({ company: 'TierUp', category: 'SaaS',
     trigger: 'Relaunched their pricing page with a new Starter tier' },
   'prospect', 'a pricing-page relaunch is a prospect');

// ── the vendor NAME check matches the whole name, never a word inside it ──────
// Several entries on the known-vendor list are ordinary words or common company
// names ('gong', 'wiser', 'elliptic', 'nektar', 'crayon'). Substring matching
// filtered these real prospects as peers before they reached any other check.

is({ company: 'Elliptic Labs', category: 'Sensor software',
     trigger: 'Founder tracks rival sensor vendors in a spreadsheet' },
   'prospect', 'Elliptic Labs is not Elliptic');

is({ company: 'Gong Labs', category: 'B2B SaaS',
     trigger: 'Opened a product marketing role' },
   'prospect', 'Gong Labs is not Gong');

is({ company: 'Crayon Data', category: 'Personalization AI',
     trigger: 'Losing deals to a rival and comparing them by hand' },
   'prospect', 'Crayon Data is not Crayon');

is({ company: 'Wiser Systems', category: 'Indoor location tracking',
     trigger: 'Launched a new pricing page' },
   'prospect', 'Wiser Systems is not Wiser');

// The real vendors are still caught, including the forms they go by.
is({ company: 'Gong.io', category: 'Revenue intelligence', trigger: 'Quarterly update' },
   'peer', 'Gong.io is still the vendor Gong');
is({ company: 'Semrush, Inc.', category: 'SEO', trigger: 'Quarterly update' },
   'peer', 'a legal suffix does not hide a vendor');
is({ company: 'Arkham Intelligence', category: 'Crypto', trigger: 'Raised a round' },
   'peer', 'the vendor full name is listed too');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
