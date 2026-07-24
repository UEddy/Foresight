// App-wide configuration constants.
//
// TRIAL_DAYS is the single source of truth for the free-trial length. Every
// piece of trial logic (workspace bootstrap, tier resolution via trial_ends_at,
// the reminder-email sweep, the API payload the in-app banner reads, admin
// views) derives from this constant. Never hardcode the trial length anywhere
// else; static marketing copy that spells out "14-day" is copy, not logic, and
// must be updated by hand if this ever changes.
const TRIAL_DAYS = 14;

// Trial reminder-email send days (day N of the trial), per the lifecycle spec:
// a heads-up on day 10, a final notice on day 13, and the expiry notice when
// the trial ends. Expressed as days-remaining thresholds derived from
// TRIAL_DAYS so the schedule tracks the trial length.
const TRIAL_REMINDER_DAYS_LEFT = {
  day10: TRIAL_DAYS - 10,   // 4 days left
  day13: TRIAL_DAYS - 13,   // 1 day left
};

module.exports = { TRIAL_DAYS, TRIAL_REMINDER_DAYS_LEFT };
