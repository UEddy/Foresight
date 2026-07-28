// Unit tests for email subject drafting (src/outbound/pipeline.js).
//   - isEmailChannel: only email carries a subject; linkedin/x/reddit do not.
//   - cleanSubjectLine: strips the "Subject:" prefix, wrapping quotes, newlines.
//   - splitSubject: separates the drafted subject from the body so each is stored
//     in its own column (outbound_leads.draft_subject / draft).
// Pure, no DB/network — run with `node test-outbound-subject.js`.

const assert = require('assert');
const { splitSubject, cleanSubjectLine, isEmailChannel } = require('./src/outbound/pipeline');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  try { assert.strictEqual(actual, expected); console.log(`✅ ${label}`); pass++; }
  catch { console.log(`❌ ${label}\n     got:      ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`); fail++; }
}
function deq(actual, expected, label) {
  try { assert.deepStrictEqual(actual, expected); console.log(`✅ ${label}`); pass++; }
  catch { console.log(`❌ ${label}\n     got:      ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`); fail++; }
}

// ── isEmailChannel ────────────────────────────────────────────────────────────
eq(isEmailChannel('email'), true, 'email carries a subject');
eq(isEmailChannel('Email'), true, 'channel check is case-insensitive');
eq(isEmailChannel('mail'), true, 'mail is treated as email');
eq(isEmailChannel('linkedin'), false, 'linkedin carries no subject');
eq(isEmailChannel('x'), false, 'x carries no subject');
eq(isEmailChannel(null), false, 'missing channel carries no subject');

// ── cleanSubjectLine ──────────────────────────────────────────────────────────
eq(cleanSubjectLine('Subject: your new PMM hire'), 'your new PMM hire', 'strips the Subject: prefix');
eq(cleanSubjectLine('subject:   spaced out  '), 'spaced out', 'tolerates lowercase prefix and padding');
eq(cleanSubjectLine('"quoted subject"'), 'quoted subject', 'strips wrapping straight quotes');
eq(cleanSubjectLine('“curly quoted”'), 'curly quoted', 'strips wrapping curly quotes');
eq(cleanSubjectLine('two\nlines'), 'two lines', 'collapses a stray newline into one line');
eq(cleanSubjectLine('   '), null, 'a blank subject is null, not an empty string');
eq(cleanSubjectLine(null), null, 'null in, null out');
eq(cleanSubjectLine('x'.repeat(400)).length, 200, 'subject is capped at 200 chars');

// ── splitSubject ──────────────────────────────────────────────────────────────
deq(
  splitSubject('Subject: that competitive hire\n\nHi Dana, you posted a CI role last week.\n\nWorth a quick look?'),
  { subject: 'that competitive hire', body: 'Hi Dana, you posted a CI role last week.\n\nWorth a quick look?' },
  'splits subject from body and keeps the body blank lines'
);
deq(
  splitSubject('Hi Dana, you posted a CI role last week.'),
  { subject: null, body: 'Hi Dana, you posted a CI role last week.' },
  'a body-only draft (linkedin, x) yields no subject and an untouched body'
);
deq(splitSubject(''), { subject: null, body: '' }, 'empty draft yields empty body');
deq(splitSubject(null), { subject: null, body: '' }, 'null draft yields empty body');
deq(
  splitSubject('Subject: only a subject'),
  { subject: 'only a subject', body: '' },
  'subject with no body still parses (caller falls back to the raw text)'
);
deq(
  splitSubject('  Subject: leading whitespace\n\nBody here.'),
  { subject: 'leading whitespace', body: 'Body here.' },
  'leading whitespace before the subject line is tolerated'
);
deq(
  splitSubject('Subject: crlf endings\r\n\r\nBody here.'),
  { subject: 'crlf endings', body: 'Body here.' },
  'CRLF line endings split the same way'
);
deq(
  splitSubject('We loved your Subject: line joke.'),
  { subject: null, body: 'We loved your Subject: line joke.' },
  'a mid-line "Subject:" in a body is not treated as a subject line'
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
