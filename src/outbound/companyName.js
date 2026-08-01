// Outbound — company-name matching against a known-vendor list.
//
// Three gates screen a discovered company by NAME against a hardcoded list:
// the buyer-size gate (sizeGate.KNOWN_TOO_LARGE), the peer classifier
// (provider.KNOWN_PEER_VENDORS), and the crypto peer screen
// (cryptoDiscovery.CRYPTO_PEER_NAMES). All three used to match on a word
// boundary inside the name, which is wrong in the same way in all three places:
// a large share of those entries are ordinary English words or common nouns
// ('block', 'box', 'circle', 'segment', 'wise', 'drift', 'gong', 'elliptic',
// 'dune', 'artemis', 'parsec'), so real prospects were silently dropped for free
// before any research ran. "Wise Systems" is not Wise, "Elliptic Labs" is not
// Elliptic, and "Dune Security" is not Dune.
//
// The rule here is that the name must BE the listed company, not merely contain
// its name. Matching is therefore on the whole normalized name.
//
// The name gate is only ever the CHEAP first pass. Each caller keeps its other
// layers (the size gate researches anything the name check does not place; the
// peer classifier still screens the category and the trigger's ship verbs), so
// tightening this one does not leave a vendor unscreened, it just stops the
// screen from firing on a company that merely shares a word with one.

// Legal suffixes only. Descriptive words ("Labs", "Group", "Technologies",
// "Data", "Analytics") are deliberately NOT stripped: they are exactly what
// distinguishes "Segment Labs" from Segment and "Crayon Data" from Crayon.
const LEGAL_SUFFIX_RE = /[\s,]+(?:inc|llc|l\.l\.c|ltd|limited|corp|corporation|plc|gmbh|bv|nv|sa|srl|ab|oy|pte|pty)\.?$/i;

// Bare commercial TLDs, dropped so "Salesforce.com" and "Salesforce" are one
// name and a list entry may carry the TLD ('monday.com', 'gong.io') or not.
const BARE_TLD_RE = /\.(?:com|io|ai|co|app|dev|xyz|fi|so)$/i;

// A company name reduced to the form the lists are written in: lowercased,
// quotes and trailing punctuation removed, legal suffix stripped, bare TLD
// dropped. Returns '' for a nameless company, which never matches.
function normalizeCompanyName(name) {
  let s = String(name || '')
    .toLowerCase()
    .replace(/['’`"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]+$/, '');
  let prev;
  do { prev = s; s = s.replace(LEGAL_SUFFIX_RE, '').trim(); } while (s !== prev);
  return s.replace(BARE_TLD_RE, '');
}

// The list entry this name IS, or null. Both sides are normalized, so
// "HubSpot, Inc." matches 'hubspot' and "Monday" matches 'monday.com', while
// "Boxcast", "Circle Medical", and "Elliptic Labs" match nothing.
function matchKnownName(name, list) {
  const n = normalizeCompanyName(name);
  if (!n) return null;
  for (const entry of list || []) {
    if (n === normalizeCompanyName(entry)) return entry;
  }
  return null;
}

module.exports = { normalizeCompanyName, matchKnownName };
