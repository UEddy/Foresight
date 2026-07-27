// Silent-baseline test harness.
//
// Verifies that the FIRST scrape of a newly monitored page establishes a
// baseline instead of reporting the page's pre-existing content as a change,
// and that real changes are still detected from that baseline onward.
//
// Covered:
//   1. First scrape of a new page whose content includes an OLD-dated post →
//      baseline row only, no change, no alert, no email, no AI call
//   2. The baseline is visible (feed row) but counts as zero changes
//   3. Second scrape with a real edit → a change IS detected, dated now,
//      diffed against the baseline, alert fired
//   4. Second scrape with no edit → nothing new
//   5. An already-monitored page keeps its old behavior and its history
//   6. Every page under a grouped competitor gets its own baseline
//
// No network, no Anthropic tokens: the scraper and analyzer are stubbed.

process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-do-not-call';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// Throwaway DB so this never touches the real one.
const TEST_DB_DIR = path.join(__dirname, 'data');
const REAL_DB     = path.join(TEST_DB_DIR, 'competitor-shadow.db');
const SAVED_DB    = path.join(TEST_DB_DIR, 'competitor-shadow.db.baseline-savepoint');

if (fs.existsSync(REAL_DB)) fs.copyFileSync(REAL_DB, SAVED_DB);
try { fs.unlinkSync(REAL_DB); } catch (_) {}

const results = [];
function pass(name, detail) { results.push({ name, ok: true,  detail }); console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, err)    { results.push({ name, ok: false, detail: err?.message || String(err) }); console.log(`  ❌ ${name} — ${err?.message || err}`); }

function restoreDb() {
  if (fs.existsSync(SAVED_DB)) {
    fs.copyFileSync(SAVED_DB, REAL_DB);
    fs.unlinkSync(SAVED_DB);
  } else {
    try { fs.unlinkSync(REAL_DB); } catch (_) {}
  }
}

// The page a user adds today. Its newest post is dated 6 weeks ago: pre-existing
// content that must never be reported as a change detected today.
const OLD_POST = 'Why pricing transparency wins, posted June 12, 2026';
function pageContent(extraBody) {
  return {
    title: 'Acme Blog', metaDescription: 'Acme writes about pricing', ogTitle: '',
    headings: ['Acme Blog', OLD_POST],
    pricing: 'Pro $49/mo',
    features: 'Reporting, SSO',
    bodyText: `${OLD_POST}. ${extraBody || ''}`.trim(),
    scope: null,
  };
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Silent baseline on first scrape');
  console.log('══════════════════════════════════════════════════════════');

  const { initDb, getDb } = require('./src/db');
  await initDb();
  const db = getDb();

  const analyzer = require('./src/analyzer');
  const scraper  = require('./src/scraper');
  const webhooks = require('./src/webhooks');
  const email    = require('./src/email');

  // ── Instrumentation: nothing here should fire for a baseline.
  // The scheduler destructures these at require time, so every stub must be in
  // place BEFORE ./src/scheduler is required, and per-case behavior swaps via
  // `nextFetch` rather than by reassigning the function.
  let aiCalls = 0, alertCalls = 0, emailCalls = 0;
  let nextFetch = null;
  scraper.fetchPageContent = async (...args) => nextFetch(...args);
  analyzer.analyzeChange = async () => {
    aiCalls++;
    return {
      analysis: {
        is_meaningful: true,
        changed_what: 'Acme added a Teams plan at $99/mo',
        why_it_matters: 'New mid-market tier lands between our two plans.',
        threat_level: 'high',
        threat_reasoning: 'Direct overlap with our core segment.',
        recommended_response: 'Refresh the mid-market comparison sheet.',
        talking_points: ['Their Teams plan omits SSO.'],
        headline: 'Acme launched a Teams plan at $99/mo',
        summary: 'A new Teams tier appeared on the pricing page.',
        key_changes: [{ category: 'pricing', description: 'Teams $99/mo added', impact: 'New mid-market entry point' }],
        opportunity: '',
        historical_context: '',
        pattern_tags: ['pricing_change'],
      },
      usage: { input_tokens: 100, output_tokens: 50 },
      promptUsed: '',
    };
  };
  webhooks.sendAlerts     = async () => { alertCalls++; };
  webhooks.sendPatternAlert = async () => { alertCalls++; };
  email.sendBriefEmail    = async () => { emailCalls++; };

  const { checkCompetitor } = require('./src/scheduler');

  // Demo user from initDb is id=1. Give it a workspace-backed Pro state by
  // reusing whatever initDb seeded; these tests call checkCompetitor directly,
  // so tier gating (which only guards the scheduler sweep) is not in play.
  const newPageId = db.prepare(
    "INSERT INTO competitors (user_id, name, url, description, render_mode) VALUES (1, 'Acme', 'https://acme.test/blog', 'fixture', 'fetch')"
  ).run().lastInsertRowid;

  // ── 1. First scrape → silent baseline
  console.log('\n── First scrape of a newly added page ──');
  try {
    nextFetch = async () => ({
      content: pageContent(), hash: 'hash-v1',
      url: 'https://acme.test/blog', renderMode: 'fetch', renderDuration: 4,
    });

    const comp = db.prepare('SELECT * FROM competitors WHERE id = ?').get(newPageId);
    const r = await checkCompetitor(comp, db);

    assert.strictEqual(r.ok, true, 'first check should succeed');
    assert.strictEqual(r.baseline, true, 'first check must report a baseline');
    assert.strictEqual(r.changed, false, 'first check must not report a change');

    const rows = db.prepare('SELECT * FROM changes WHERE competitor_id = ?').all(newPageId);
    assert.strictEqual(rows.length, 1, 'exactly one row should exist after the first scrape');
    const row = rows[0];
    assert.strictEqual(row.is_baseline, 1, 'the row must be marked as a baseline');
    assert.strictEqual(row.threat_level, null, 'a baseline carries no threat level');
    assert.strictEqual(row.headline, 'Monitoring started, baseline captured', 'baseline headline');
    assert.strictEqual(row.content_before, null, 'a baseline has no prior state');

    // The pre-existing post is stored as the snapshot to diff against, but is
    // never described as something that changed.
    const storedSnapshot = JSON.parse(row.content_after);
    assert.ok(storedSnapshot.bodyText.includes(OLD_POST), 'snapshot must store the page content');
    const analysis = JSON.parse(row.analysis);
    assert.ok(!/\bchanged\b/i.test(analysis.headline), 'baseline headline must not say anything changed');
    assert.ok(!analysis.summary.includes(OLD_POST), 'baseline summary must not surface pre-existing content as news');
    assert.ok(/not a change/i.test(analysis.summary), 'baseline summary must state it is not a change');
    assert.strictEqual(analysis.threat_level, null, 'baseline analysis carries no threat level');

    assert.strictEqual(aiCalls, 0, 'no AI call may be made for a baseline');
    assert.strictEqual(alertCalls, 0, 'no alert may fire for a baseline');
    assert.strictEqual(emailCalls, 0, 'no email may be sent for a baseline');

    const after = db.prepare('SELECT last_content_hash, last_check_status FROM competitors WHERE id = ?').get(newPageId);
    assert.strictEqual(after.last_content_hash, 'hash-v1', 'baseline must advance the stored hash');
    assert.strictEqual(after.last_check_status, 'ok', 'baseline must leave the page in an ok state');

    pass('first scrape stores a baseline, no change / alert / brief for pre-existing content');
  } catch (e) { fail('first scrape silent baseline', e); }

  // ── 2. The baseline is visible, but is not counted as a change
  console.log('\n── Visibility and counters ──');
  try {
    // Scoped to the page under test: initDb seeds demo data for user 1, which
    // has its own (untouched) change history.
    const feedRows = db.prepare(`
      SELECT ch.id, ch.headline, ch.is_baseline, ch.threat_level FROM changes ch
      JOIN competitors c ON ch.competitor_id = c.id
      WHERE c.user_id = 1 AND ch.competitor_id = ? AND (ch.is_meaningful IS NULL OR ch.is_meaningful = 1)
    `).all(newPageId);
    assert.ok(feedRows.some(r => r.is_baseline === 1), 'the baseline must be returned to the feed (dashboard is not blank)');

    const counted = db.prepare(`
      SELECT COUNT(*) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
      WHERE c.user_id = 1 AND ch.competitor_id = ? AND (ch.is_meaningful IS NULL OR ch.is_meaningful = 1) AND COALESCE(ch.is_baseline, 0) = 0
    `).get(newPageId).n;
    assert.strictEqual(counted, 0, 'a baseline must not count as a detected change');

    const baselined = db.prepare(`
      SELECT COUNT(DISTINCT ch.competitor_id) AS n FROM changes ch JOIN competitors c ON ch.competitor_id = c.id
      WHERE c.user_id = 1 AND COALESCE(ch.is_baseline, 0) = 1
    `).get().n;
    assert.strictEqual(baselined, 1, 'the dashboard must be able to report a captured baseline');

    // A baseline must never reach an AI prompt as prior history.
    const { getCompetitorHistory, _clearCacheForTests } = require('./src/historicalContext');
    _clearCacheForTests();
    const hist = getCompetitorHistory(newPageId, { userId: 1 });
    assert.strictEqual(hist.count, 0, 'baseline must not appear as prior history');
    assert.strictEqual(hist.formatted, '', 'baseline must not enter the AI prompt');

    // The timeline explicitly asks for it, so the detail page is not empty.
    _clearCacheForTests();
    const timeline = getCompetitorHistory(newPageId, { userId: 1, includeBaseline: true });
    assert.strictEqual(timeline.changes.length, 1, 'timeline shows the baseline entry');
    assert.strictEqual(timeline.changes[0].is_baseline, true, 'timeline entry is labelled as a baseline');
    assert.strictEqual(timeline.count, 0, 'timeline still reports zero changes');

    pass('baseline is visible in the feed and timeline, counted as zero changes, never sent to the AI');
  } catch (e) { fail('baseline visibility and counters', e); }

  // ── 3. Second scrape with no edit → nothing new
  console.log('\n── Second scrape, page unchanged ──');
  try {
    const comp = db.prepare('SELECT * FROM competitors WHERE id = ?').get(newPageId);
    const r = await checkCompetitor(comp, db);
    assert.strictEqual(r.changed, false, 'an unchanged page must not report a change');
    const n = db.prepare('SELECT COUNT(*) AS n FROM changes WHERE competitor_id = ?').get(newPageId).n;
    assert.strictEqual(n, 1, 'no new row for an unchanged page');
    assert.strictEqual(aiCalls, 0, 'no AI call for an unchanged page');
    pass('unchanged page produces nothing new');
  } catch (e) { fail('second scrape unchanged', e); }

  // ── 4. Second scrape with a real edit → a change IS detected
  console.log('\n── Third scrape, page actually changed ──');
  let realChangeId = null;
  try {
    nextFetch = async () => ({
      content: pageContent('New: Teams plan $99/mo.'), hash: 'hash-v2',
      url: 'https://acme.test/blog', renderMode: 'fetch', renderDuration: 4,
    });

    const comp = db.prepare('SELECT * FROM competitors WHERE id = ?').get(newPageId);
    const r = await checkCompetitor(comp, db);

    assert.strictEqual(r.changed, true, 'a real edit must be detected as a change');
    assert.ok(aiCalls >= 1, 'a real change must be analyzed');

    const row = db.prepare('SELECT * FROM changes WHERE competitor_id = ? ORDER BY id DESC LIMIT 1').get(newPageId);
    realChangeId = row.id;
    assert.strictEqual(row.is_baseline, 0, 'a real change must not be marked as a baseline');
    assert.strictEqual(row.threat_level, 'high', 'a real change carries its analyzed threat level');
    assert.ok(row.headline.includes('Teams plan'), 'the brief describes the actual change');

    // It was diffed against the BASELINE, not against nothing: the pre-existing
    // post is in content_before, so it can never be re-reported as new.
    const before = JSON.parse(row.content_before);
    assert.ok(before.bodyText.includes(OLD_POST), 'the change must be measured against the baseline snapshot');
    assert.ok(!before.bodyText.includes('Teams plan'), 'the baseline predates the new content');
    assert.strictEqual(row.gate_category !== 'first_seen', true, 'the second scrape is not treated as a first observation');

    // Dated when it was actually detected (now), not backdated to the content.
    const ageMinutes = db.prepare(
      "SELECT (julianday('now') - julianday(detected_at)) * 1440 AS m FROM changes WHERE id = ?"
    ).get(row.id).m;
    assert.ok(ageMinutes >= 0 && ageMinutes < 5, `change must be dated now (got ${ageMinutes} minutes old)`);

    assert.ok(alertCalls >= 1, 'a real change must fire alerts');
    pass('real change against the baseline is detected, analyzed, dated now, and alerted');
  } catch (e) { fail('third scrape real change', e); }

  // ── 5. Already-monitored pages are untouched
  console.log('\n── Existing monitored page ──');
  try {
    const existingId = db.prepare(
      "INSERT INTO competitors (user_id, name, url, render_mode, last_content_hash) VALUES (1, 'Legacy', 'https://legacy.test/pricing', 'fetch', 'legacy-hash')"
    ).run().lastInsertRowid;
    // Pre-existing history from before this feature shipped.
    db.prepare(`
      INSERT INTO changes (competitor_id, content_after, threat_level, headline, detected_at)
      VALUES (?, ?, 'medium', 'Legacy pricing moved', datetime('now', '-10 days'))
    `).run(existingId, JSON.stringify({ title: 'Pricing', headings: ['Pricing'], pricing: 'Pro $39/mo', features: '', bodyText: 'Pro $39/mo', metaDescription: '' }));

    const before = db.prepare('SELECT id, headline, threat_level, is_baseline, detected_at FROM changes WHERE competitor_id = ?').all(existingId);

    nextFetch = async () => ({
      content: { title: 'Pricing', metaDescription: '', ogTitle: '', headings: ['Pricing'], pricing: 'Pro $59/mo', features: '', bodyText: 'Pro $59/mo', scope: null },
      hash: 'legacy-hash-2', url: 'https://legacy.test/pricing', renderMode: 'fetch', renderDuration: 3,
    });

    const comp = db.prepare('SELECT * FROM competitors WHERE id = ?').get(existingId);
    const r = await checkCompetitor(comp, db);

    assert.strictEqual(r.baseline, undefined, 'an already-monitored page must not be re-baselined');
    assert.strictEqual(r.changed, true, 'an already-monitored page still detects changes normally');

    const after = db.prepare('SELECT id, headline, threat_level, is_baseline, detected_at FROM changes WHERE competitor_id = ? ORDER BY id ASC').all(existingId);
    assert.deepStrictEqual(after[0], before[0], 'existing history rows must be left exactly as they were');
    assert.strictEqual(after.filter(x => x.is_baseline === 1).length, 0, 'no baseline row is retro-inserted');
    pass('already-monitored page keeps its history and its change behavior');
  } catch (e) { fail('existing monitored page', e); }

  // ── 6. Every page under a grouped competitor gets its own baseline
  console.log('\n── Grouped competitor, multiple pages ──');
  try {
    const groupId = db.prepare(
      "INSERT INTO competitor_groups (user_id, name) VALUES (1, 'Globex')"
    ).run().lastInsertRowid;

    const pageIds = ['pricing', 'blog', 'changelog'].map(slug => db.prepare(
      "INSERT INTO competitors (user_id, group_id, page_label, name, url, render_mode) VALUES (1, ?, ?, 'Globex', ?, 'fetch')"
    ).run(groupId, slug, `https://globex.test/${slug}`).lastInsertRowid);

    for (const id of pageIds) {
      nextFetch = async () => ({
        content: pageContent(`Globex page ${id}`), hash: `globex-hash-${id}`,
        url: `https://globex.test/${id}`, renderMode: 'fetch', renderDuration: 2,
      });
      const comp = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id);
      const r = await checkCompetitor(comp, db);
      assert.strictEqual(r.baseline, true, `page ${id} must be baselined on its first scrape`);
    }

    for (const id of pageIds) {
      const rows = db.prepare('SELECT * FROM changes WHERE competitor_id = ?').all(id);
      assert.strictEqual(rows.length, 1, `page ${id} has exactly one row`);
      assert.strictEqual(rows[0].is_baseline, 1, `page ${id}'s row is a baseline`);
      assert.strictEqual(rows[0].threat_level, null, `page ${id}'s baseline has no threat level`);
    }
    pass('every page under a grouped competitor is baselined uniformly');
  } catch (e) { fail('grouped competitor pages', e); }

  // ── Summary
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════════════');
  if (failed) {
    console.log('\nFailures:');
    for (const r of results.filter(x => !x.ok)) console.log(`  • ${r.name}: ${r.detail}`);
  }

  restoreDb();
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('Harness crashed:', err);
  restoreDb();
  process.exit(1);
});
