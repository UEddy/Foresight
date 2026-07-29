// Outbound — per-run funnel counters.
//
// A run can end with zero leads for many different reasons, and until now there
// was no way to tell where the candidates died. The funnel records the count at
// every stage of the pipeline so a dry run is diagnosable at a glance, both in
// the server log (formatFunnel) and in the admin UI (see adminPage.js). The
// shape is persisted as JSON on the outbound_runs row (store.updateRun /
// hydrateRun).

// The gates a candidate person can be rejected at inside
// provider.classifyPersonResult, in the order they are checked. Kept in sync
// with that function.
//
// The x_ prefixed gates belong to the X/Twitter fallback finder
// (provider.classifyXPersonResult), used only for crypto candidates whose
// founder has no verifiable LinkedIn. They mirror the LinkedIn gates one for
// one, plus x_project_account: the search found the project's own account
// rather than a person.
const LINKEDIN_REJECTION_REASONS = [
  'not_in_hits',
  'employment_unverified',
  'former_employee',
  'company_match_false',
  'employer_mismatch',
];

const X_REJECTION_REASONS = [
  'x_not_in_hits',
  'x_employment_unverified',
  'x_former_employee',
  'x_company_match_false',
  'x_employer_mismatch',
  'x_project_account',
];

const REJECTION_REASONS = [...LINKEDIN_REJECTION_REASONS, ...X_REJECTION_REASONS];

// Human-readable labels for the log and the admin UI. No em-dashes, en-dashes,
// or connecting "+": these strings surface in user-facing admin output.
const REJECTION_LABELS = {
  not_in_hits: 'Profile not in search results',
  employment_unverified: 'Employment not verified',
  former_employee: 'Former employee of the company',
  company_match_false: 'Company match not affirmed',
  employer_mismatch: 'Employer name did not match',
  x_not_in_hits: 'X profile not in search results',
  x_employment_unverified: 'X bio did not verify current role',
  x_former_employee: 'X bio reads as a former founder',
  x_company_match_false: 'X company match not affirmed',
  x_employer_mismatch: 'X bio named a different project',
  x_project_account: 'X account is the project, not a person',
};

// A fresh, all-zero funnel for one run.
function makeFunnel() {
  const rejected = {};
  for (const r of REJECTION_REASONS) rejected[r] = 0;
  return {
    discovered_raw: 0,     // candidates the model proposed, before dedupe
    after_dedupe: 0,       // survivors of dedupe and the exclusion rules
    peer: 0,               // companies filtered as peers (they sell competitor monitoring)
    too_large: 0,          // companies dropped by the buyer-size gate (see sizeGate.js)
    size_unknown: 0,       // companies KEPT with no findable size, flagged not dropped
    no_person: 0,          // companies where findPeople returned no person at all
    rejected,              // people rejected, counted per gate (see REJECTION_REASONS)
    no_contact: 0,         // companies dropped for no usable contact
    below_threshold: 0,    // leads dropped below the score threshold
    capped: 0,             // gate survivors dropped only by the targetCount cap
    kept: 0,               // leads persisted

    // ── web3 segment only (zero on every other run) ──────────────────────────
    crypto_raises_fetched: 0,      // raise rows pulled from DeFiLlama and CryptoRank
    crypto_after_dedupe: 0,        // unique projects after the cross-source dedupe
    crypto_cross_source_dupes: 0,  // rows folded into an already-seen project
    crypto_peer: 0,                // projects dropped as analytics or intelligence vendors
    crypto_unfit_category: 0,      // projects dropped as plumbing with no GTM motion
    crypto_candidates: 0,          // crypto candidates handed to the merge
    merged_cross_source_dupes: 0,  // crypto projects Serper had already discovered
    x_fallback_used: 0,            // people found on X after LinkedIn found nobody

    // Plain sentences about anything that could not be reached (a source
    // missing its key, a plan that excludes an endpoint). Surfaced in the admin
    // funnel panel so a thin run is explained rather than just small.
    notes: [],
  };
}

// Fold the person-stage counts of a scratch funnel into the real one.
//
// The X fallback needs this: findPeople records its own rejection the moment it
// gives up, but for a crypto candidate that rejection is not final, because the
// X finder may still verify someone. So each attempt counts into a throwaway
// funnel, and the counts are merged back only once both attempts have failed.
// Without it a lead found on X would still be tallied as "no person".
//
// opts.noPerson=false merges the per-gate rejections but NOT the no_person
// count. Two failed routes for one company are still one company with no
// person, so only the first route's no_person is merged and the second route
// contributes its gate detail alone. That keeps the funnel's company-level
// buckets summing to the number of companies processed.
function mergePersonCounts(target, scratch, { noPerson = true } = {}) {
  if (!target || !scratch) return;
  if (noPerson) target.no_person += scratch.no_person || 0;
  for (const r of REJECTION_REASONS) {
    if (scratch.rejected && scratch.rejected[r]) target.rejected[r] += scratch.rejected[r];
  }
}

// Increment one rejection gate. A no-op for an unknown reason or a missing
// funnel, so callers never have to guard.
function recordRejection(funnel, reason) {
  if (funnel && funnel.rejected && Object.prototype.hasOwnProperty.call(funnel.rejected, reason)) {
    funnel.rejected[reason] += 1;
  }
}

// Total people rejected across all gates.
function totalRejectedPeople(funnel) {
  if (!funnel || !funnel.rejected) return 0;
  return REJECTION_REASONS.reduce((n, r) => n + (funnel.rejected[r] || 0), 0);
}

// Multi-line summary for the server log at the end of a run.
function formatFunnel(funnel, runId) {
  const f = funnel || makeFunnel();
  const pad = (label) => (label + ':').padEnd(26);
  const lines = [];
  lines.push('[outbound.pipeline] run ' + (runId != null ? '#' + runId + ' ' : '') + 'funnel');
  lines.push('  ' + pad('discovered (raw)') + f.discovered_raw);
  lines.push('  ' + pad('after dedupe/exclusion') + f.after_dedupe);
  lines.push('  ' + pad('peers filtered') + (f.peer || 0));
  lines.push('  ' + pad('too large (buyer size)') + (f.too_large || 0));
  // Crypto discovery block, printed only for a web3 run so every other run's
  // log is unchanged.
  if (f.crypto_raises_fetched) {
    lines.push('  ' + pad('crypto raises fetched') + f.crypto_raises_fetched);
    lines.push('  ' + pad('crypto unique projects') + (f.crypto_after_dedupe || 0));
    lines.push('    ' + 'cross-source duplicates:'.padEnd(34) + (f.crypto_cross_source_dupes || 0));
    lines.push('    ' + 'analytics peers:'.padEnd(34) + (f.crypto_peer || 0));
    lines.push('    ' + 'unfit category:'.padEnd(34) + (f.crypto_unfit_category || 0));
    lines.push('  ' + pad('crypto candidates') + (f.crypto_candidates || 0));
    lines.push('  ' + pad('already found by search') + (f.merged_cross_source_dupes || 0));
  }
  lines.push('  ' + pad('no person found') + f.no_person);
  lines.push('  ' + pad('people rejected') + totalRejectedPeople(f));
  for (const r of REJECTION_REASONS) {
    lines.push('    ' + (REJECTION_LABELS[r] + ':').padEnd(34) + (f.rejected[r] || 0));
  }
  if (f.x_fallback_used) lines.push('  ' + pad('found on X (no LinkedIn)') + f.x_fallback_used);
  if (f.size_unknown) lines.push('  ' + pad('size unknown (kept)') + f.size_unknown);
  lines.push('  ' + pad('no usable contact') + f.no_contact);
  lines.push('  ' + pad('below score threshold') + f.below_threshold);
  lines.push('  ' + pad('capped (over target)') + (f.capped || 0));
  lines.push('  ' + pad('kept (leads)') + f.kept);
  return lines.join('\n');
}

module.exports = {
  makeFunnel, recordRejection, totalRejectedPeople, formatFunnel, mergePersonCounts,
  REJECTION_REASONS, REJECTION_LABELS,
  LINKEDIN_REJECTION_REASONS, X_REJECTION_REASONS,
};
