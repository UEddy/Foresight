// Outbound — admin page body. Rendered inside admin.js's renderShell (which
// supplies the <head>, base styles, Plus Jakarta Sans, and the indigo accent),
// so this file only returns the inner HTML for the /admin/outbound page.
//
// The page is a thin client over /api/admin/outbound/*: it starts runs, polls
// the run row while it processes, and renders a ranked, expandable leads table
// with row actions (copy draft, open profile, status, redraft, notes). The CSRF
// token is passed via a data attribute (the API is behind csrfProtect, same
// session token requireAdmin already set). The client script avoids template
// literals so it nests cleanly here; all API/AI text is inserted via textContent
// to avoid XSS.

// escaped by the caller? No — token is hex from crypto.randomBytes, but escape
// defensively anyway.
function escAttr(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderOutboundBody(csrfToken) {
  return `
    <div class="admin-head"><h1>Outbound</h1></div>
    <p class="admin-sub">Discover, score, and draft outreach to companies that feel competitor-monitoring pain. Review and send yourself. Nothing is sent automatically and no contact is fabricated.</p>

    <style>
      .ob-grid { display: grid; grid-template-columns: 340px 1fr; gap: 24px; align-items: start; }
      @media (max-width: 860px) { .ob-grid { grid-template-columns: 1fr; } }
      textarea { width: 100%; min-height: 120px; padding: 10px 12px; border-radius: 9px; background: var(--bg-card); border: 1.5px solid var(--border); color: var(--txt); font-family: inherit; font-size: 0.9rem; line-height: 1.5; resize: vertical; }
      textarea:focus { outline: none; border-color: var(--accent); }
      .ob-runs { list-style: none; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .ob-run { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; font-size: 0.8125rem; cursor: pointer; }
      .ob-run.active { border-color: var(--accent); }
      .ob-run .ob-run-meta { color: var(--txt-2); font-size: 0.75rem; }
      .pill-run { background: rgba(129,140,248,0.16); color: #A5B4FC; }
      .pill-done { background: rgba(16,185,129,0.16); color: #34D399; }
      .pill-error { background: rgba(239,68,68,0.16); color: #F87171; }
      .pill-pending { background: rgba(255,255,255,0.06); color: var(--txt-2); }
      .pill-new { background: rgba(129,140,248,0.16); color: #A5B4FC; }
      .pill-contacted { background: rgba(245,158,11,0.18); color: #FBBF24; }
      .pill-replied { background: rgba(16,185,129,0.16); color: #34D399; }
      .pill-skipped { background: rgba(255,255,255,0.06); color: var(--txt-3); }
      .pill-manual { background: rgba(245,158,11,0.18); color: #FBBF24; }
      .pill-verified { background: rgba(16,185,129,0.16); color: #34D399; }
      .score-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 40px; height: 28px; padding: 0 8px; border-radius: 8px; font-weight: 800; font-size: 0.9rem; background: rgba(129,140,248,0.16); color: #A5B4FC; }
      .score-hi { background: rgba(16,185,129,0.16); color: #34D399; }
      .score-lo { background: rgba(255,255,255,0.06); color: var(--txt-2); }
      .ob-expand td { background: rgba(255,255,255,0.02); }
      .ob-draft { white-space: pre-wrap; font-family: inherit; font-size: 0.85rem; line-height: 1.55; background: var(--bg-2); border: 1px solid var(--border); border-radius: 9px; padding: 12px 14px; margin: 0 0 12px; color: var(--txt); }
      .ob-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .ob-btn { height: 34px; padding: 0 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-card); color: var(--txt); font-weight: 600; font-size: 0.8rem; font-family: inherit; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
      .ob-btn:hover { border-color: var(--accent); text-decoration: none; }
      .ob-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
      .ob-notes { width: 100%; min-height: 54px; margin-top: 8px; }
      .ob-caret { color: var(--txt-3); font-size: 0.75rem; }
      .why-now { color: var(--txt-2); font-size: 0.8125rem; }
      #ob-error { display: none; }
      .ob-inline-note { font-size: 0.75rem; color: var(--txt-3); margin-top: 6px; }
      .ob-funnel { border: 1px solid var(--border); border-radius: 12px; background: var(--bg-2); padding: 14px 16px; margin: 0 0 16px; }
      .ob-funnel-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--txt-3); font-weight: 700; margin-bottom: 12px; }
      .ob-funnel-row { display: flex; flex-wrap: wrap; gap: 10px; }
      .ob-stat { flex: 1 1 92px; min-width: 92px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px; }
      .ob-stat-v { font-size: 1.15rem; font-weight: 800; color: var(--txt); line-height: 1.1; }
      .ob-stat.kept .ob-stat-v { color: #34D399; }
      .ob-stat.drop .ob-stat-v { color: #FBBF24; }
      .ob-stat-l { font-size: 0.7rem; color: var(--txt-3); margin-top: 3px; }
      .ob-funnel-break { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
      .ob-break-chip { font-size: 0.72rem; color: var(--txt-2); background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); border-radius: 999px; padding: 3px 9px; }
    </style>

    <div id="ob-error" class="note note-err"></div>

    <div class="ob-grid">
      <div>
        <form id="ob-form" class="admin-form" style="max-width:none">
          <div class="field">
            <label for="ob-brief">ICP brief and signals</label>
            <textarea id="ob-brief" placeholder="Who is a great fit and why now? e.g. Series A SaaS in crowded categories with a /compare page, a recently opened Competitive Intelligence or Product Marketing role, or a founder describing manual competitor tracking."></textarea>
          </div>
          <div class="field">
            <label for="ob-count">Target lead count</label>
            <input type="number" id="ob-count" min="1" max="25" value="10">
            <div class="ob-inline-note">Hard cap 25 per run.</div>
          </div>
          <div class="field">
            <label for="ob-region">Region hints (optional)</label>
            <input type="text" id="ob-region" placeholder="e.g. US, UK, remote-first">
          </div>
          <div class="field">
            <label for="ob-segment">Discovery segment</label>
            <select id="ob-segment">
              <option value="">Web search only (default)</option>
              <option value="web3">Web search and crypto raises (web3)</option>
            </select>
            <div class="ob-inline-note">Web3 adds projects that raised in the last 6 months, from DeFiLlama and CryptoRank, ranked alongside the search leads.</div>
          </div>
          <button type="submit" class="submit" id="ob-start">Find leads</button>
          <div class="warn">Discovery needs SERPER_API_KEY set in Railway. The web3 segment also needs DEFILLAMA_API_KEY (raises moved to the paid plan), and CRYPTORANK_API_KEY is optional. Contacts come back as a profile link to grab manually. No email is fabricated.</div>
        </form>

        <div class="stat-section-title" style="margin-top:24px">Recent runs</div>
        <ul class="ob-runs" id="ob-runs"><li class="muted" style="padding:8px">Loading…</li></ul>
      </div>

      <div>
        <div class="admin-head"><h1 style="font-size:1.05rem" id="ob-leads-title">Leads</h1></div>
        <div id="ob-funnel"></div>
        <div id="ob-leads-wrap">
          <p class="empty">Start a run to see ranked leads here.</p>
        </div>
      </div>
    </div>

    <a class="back" href="/admin/stats">&larr; Back to admin</a>

    <div id="outbound-app" data-csrf="${escAttr(csrfToken)}"></div>
    <script>
    (function () {
      var CSRF = document.getElementById('outbound-app').dataset.csrf;
      var BASE = '/api/admin/outbound';
      var pollTimer = null;
      var activeRunId = null;
      var runsById = {};

      function el(id) { return document.getElementById(id); }
      function showError(msg) { var e = el('ob-error'); e.textContent = msg; e.style.display = 'block'; }
      function clearError() { var e = el('ob-error'); e.textContent = ''; e.style.display = 'none'; }

      function api(method, path, body) {
        var opts = { method: method, headers: { 'x-csrf-token': CSRF } };
        if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
        return fetch(BASE + path, opts).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (data) {
            if (!r.ok) throw new Error(data.error || ('Request failed (' + r.status + ')'));
            return data;
          });
        });
      }

      function statusPill(status) {
        var span = document.createElement('span');
        span.className = 'pill pill-' + status;
        span.textContent = status;
        return span;
      }

      // ── Runs ──────────────────────────────────────────────────────────────────
      function loadRuns() {
        return api('GET', '/runs').then(function (data) { renderRuns(data.runs || []); return data.runs || []; });
      }

      function renderRuns(runs) {
        var ul = el('ob-runs');
        ul.textContent = '';
        runsById = {};
        runs.forEach(function (run) { runsById[run.id] = run; });
        if (!runs.length) { var li = document.createElement('li'); li.className = 'muted'; li.style.padding = '8px'; li.textContent = 'No runs yet.'; ul.appendChild(li); return; }
        runs.forEach(function (run) {
          var li = document.createElement('li');
          li.className = 'ob-run' + (run.id === activeRunId ? ' active' : '');
          var left = document.createElement('div');
          var kept = (run.status === 'done') ? (' · ' + run.total_kept + '/' + run.total_found + ' kept') : '';
          var brief = (run.params && run.params.brief) ? run.params.brief : '';
          var title = document.createElement('div');
          title.textContent = 'Run #' + run.id;
          var meta = document.createElement('div');
          meta.className = 'ob-run-meta';
          meta.textContent = (brief ? brief.slice(0, 46) + (brief.length > 46 ? '…' : '') : 'run') + kept;
          left.appendChild(title); left.appendChild(meta);
          li.appendChild(left);
          li.appendChild(statusPill(run.status));
          li.addEventListener('click', function () { selectRun(run.id, run.status); });
          ul.appendChild(li);
        });
      }

      function selectRun(runId, status) {
        activeRunId = runId;
        el('ob-leads-title').textContent = 'Leads · Run #' + runId;
        loadRuns();
        if (status === 'running' || status === 'pending') { renderFunnel(null); startPolling(runId); renderLeadsLoading(); }
        else { stopPolling(); renderFunnel(runsById[runId]); loadLeads(runId); }
      }

      function startPolling(runId) {
        stopPolling();
        pollTimer = setInterval(function () {
          api('GET', '/runs/' + runId).then(function (data) {
            var run = data.run;
            loadRuns();
            if (run.status === 'done' || run.status === 'error') {
              stopPolling();
              if (run.status === 'error') { renderFunnel(null); renderLeadsError(run.error_message || 'Run failed.'); }
              else { renderFunnel(run); loadLeads(runId); }
            }
          }).catch(function (e) { stopPolling(); showError(e.message); });
        }, 2500);
      }
      function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

      // ── Funnel ────────────────────────────────────────────────────────────────
      // Per-run funnel summary: where candidates died on their way to a lead.
      var REJ_LABELS = {
        not_in_hits: 'Profile not in results',
        employment_unverified: 'Employment not verified',
        former_employee: 'Former employee',
        company_match_false: 'Company not affirmed',
        employer_mismatch: 'Employer name mismatch',
        x_not_in_hits: 'X profile not in results',
        x_employment_unverified: 'X role not verified',
        x_former_employee: 'X bio reads as former founder',
        x_company_match_false: 'X project not affirmed',
        x_employer_mismatch: 'X bio named another project',
        x_project_account: 'X account is the project'
      };
      var REJ_ORDER = [
        'not_in_hits', 'employment_unverified', 'former_employee', 'company_match_false', 'employer_mismatch',
        'x_not_in_hits', 'x_employment_unverified', 'x_former_employee', 'x_company_match_false',
        'x_employer_mismatch', 'x_project_account'
      ];

      function funnelStat(label, value, cls) {
        var s = document.createElement('div'); s.className = 'ob-stat' + (cls ? ' ' + cls : '');
        var v = document.createElement('div'); v.className = 'ob-stat-v'; v.textContent = (value == null ? 0 : value);
        var l = document.createElement('div'); l.className = 'ob-stat-l'; l.textContent = label;
        s.appendChild(v); s.appendChild(l); return s;
      }

      function renderFunnel(run) {
        var wrap = el('ob-funnel');
        wrap.textContent = '';
        if (!run || !run.funnel) return;
        var f = run.funnel;
        var rej = f.rejected || {};
        var rejTotal = REJ_ORDER.reduce(function (n, k) { return n + (rej[k] || 0); }, 0);

        var panel = document.createElement('div'); panel.className = 'ob-funnel';
        var title = document.createElement('div'); title.className = 'ob-funnel-title'; title.textContent = 'Run funnel';
        panel.appendChild(title);

        var row = document.createElement('div'); row.className = 'ob-funnel-row';
        row.appendChild(funnelStat('Discovered (raw)', f.discovered_raw));
        row.appendChild(funnelStat('After dedupe', f.after_dedupe));
        // Web3 segment stats, shown only when crypto discovery actually ran.
        if (f.crypto_raises_fetched) {
          row.appendChild(funnelStat('Raises fetched', f.crypto_raises_fetched));
          row.appendChild(funnelStat('Crypto candidates', f.crypto_candidates));
          row.appendChild(funnelStat('Analytics peers', f.crypto_peer, 'drop'));
          row.appendChild(funnelStat('Unfit category', f.crypto_unfit_category, 'drop'));
        }
        row.appendChild(funnelStat('Peers', f.peer, 'drop'));
        row.appendChild(funnelStat('No person', f.no_person, 'drop'));
        row.appendChild(funnelStat('People rejected', rejTotal, 'drop'));
        if (f.x_fallback_used) row.appendChild(funnelStat('Found on X', f.x_fallback_used, 'kept'));
        row.appendChild(funnelStat('No contact', f.no_contact, 'drop'));
        row.appendChild(funnelStat('Below score', f.below_threshold, 'drop'));
        row.appendChild(funnelStat('Over target', f.capped, 'drop'));
        row.appendChild(funnelStat('Kept', f.kept, 'kept'));
        panel.appendChild(row);

        // Honest notes about any source that could not be reached, so an empty
        // web3 run reads as "DeFiLlama needs a key", not as "no leads exist".
        if (f.notes && f.notes.length) {
          var nb = document.createElement('div'); nb.className = 'ob-funnel-break';
          f.notes.forEach(function (n) {
            var chip = document.createElement('span'); chip.className = 'ob-break-chip';
            chip.textContent = n;
            nb.appendChild(chip);
          });
          panel.appendChild(nb);
        }

        if (rejTotal) {
          var br = document.createElement('div'); br.className = 'ob-funnel-break';
          REJ_ORDER.forEach(function (k) {
            if (!rej[k]) return;
            var chip = document.createElement('span'); chip.className = 'ob-break-chip';
            chip.textContent = REJ_LABELS[k] + ': ' + rej[k];
            br.appendChild(chip);
          });
          panel.appendChild(br);
        }
        wrap.appendChild(panel);
      }

      // ── Leads ─────────────────────────────────────────────────────────────────
      function renderLeadsLoading() { el('ob-leads-wrap').innerHTML = '<p class="empty">Finding leads… this can take a minute.</p>'; }
      function renderLeadsError(msg) { var w = el('ob-leads-wrap'); w.textContent = ''; var p = document.createElement('p'); p.className = 'note note-err'; p.textContent = msg; w.appendChild(p); }

      function loadLeads(runId) {
        api('GET', '/runs/' + runId + '/leads').then(function (data) { renderLeads(data.leads || []); })
          .catch(function (e) { showError(e.message); });
      }

      function scoreClass(s) { if (s >= 80) return 'score-badge score-hi'; if (s < 60) return 'score-badge score-lo'; return 'score-badge'; }

      function renderLeads(leads) {
        var wrap = el('ob-leads-wrap');
        wrap.textContent = '';
        if (!leads.length) { var p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No leads cleared the score threshold for this run.'; wrap.appendChild(p); return; }

        var table = document.createElement('table');
        var thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>Score</th><th>Company</th><th>Why now</th><th>Person</th><th>Channel</th><th></th></tr>';
        table.appendChild(thead);
        var tbody = document.createElement('tbody');

        leads.forEach(function (lead) {
          var tr = document.createElement('tr');

          var tdScore = document.createElement('td');
          var badge = document.createElement('span'); badge.className = scoreClass(lead.score); badge.textContent = lead.score;
          tdScore.appendChild(badge);

          var tdCo = document.createElement('td');
          var co = document.createElement('div'); co.style.fontWeight = '700'; co.textContent = lead.company || '(unknown)';
          var sub = document.createElement('div'); sub.className = 'ob-run-meta';
          sub.textContent = [lead.category, lead.region].filter(Boolean).join(' · ');
          tdCo.appendChild(co); tdCo.appendChild(sub);

          var tdWhy = document.createElement('td');
          var why = document.createElement('div'); why.className = 'why-now'; why.textContent = lead.why_now || lead.trigger || '';
          tdWhy.appendChild(why);

          var tdPerson = document.createElement('td');
          var pn = document.createElement('div'); pn.textContent = lead.person_name || 'No name found';
          var pt = document.createElement('div'); pt.className = 'ob-run-meta'; pt.textContent = lead.person_title || '';
          tdPerson.appendChild(pn); tdPerson.appendChild(pt);

          var tdChan = document.createElement('td');
          tdChan.appendChild(statusPill(lead.status));

          var tdCaret = document.createElement('td');
          var caret = document.createElement('span'); caret.className = 'ob-caret'; caret.textContent = '▶ expand';
          tdCaret.appendChild(caret);

          tr.appendChild(tdScore); tr.appendChild(tdCo); tr.appendChild(tdWhy); tr.appendChild(tdPerson); tr.appendChild(tdChan); tr.appendChild(tdCaret);

          var expand = buildExpandRow(lead);
          expand.style.display = 'none';
          tr.style.cursor = 'pointer';
          tr.addEventListener('click', function (ev) {
            if (ev.target.closest('a,button,select,textarea,input')) return;
            var open = expand.style.display !== 'none';
            expand.style.display = open ? 'none' : '';
            caret.textContent = open ? '▶ expand' : '▼ collapse';
          });

          tbody.appendChild(tr);
          tbody.appendChild(expand);
        });

        table.appendChild(tbody);
        wrap.appendChild(table);
      }

      function buildExpandRow(lead) {
        var tr = document.createElement('tr'); tr.className = 'ob-expand';
        var td = document.createElement('td'); td.colSpan = 6;

        // Contact status + trigger link
        var meta = document.createElement('div'); meta.style.marginBottom = '10px'; meta.className = 'ob-actions';
        var cs = document.createElement('span'); cs.className = 'pill pill-' + (lead.contact_status || 'manual');
        cs.textContent = 'contact: ' + (lead.contact_status || 'manual');
        meta.appendChild(cs);
        if (lead.channel) { var ch = document.createElement('span'); ch.className = 'ob-run-meta'; ch.textContent = 'via ' + lead.channel; meta.appendChild(ch); }
        // Say plainly when no LinkedIn was verified. The lead reached this point
        // on a verified X profile instead, and no LinkedIn URL was invented.
        if (lead.linkedin_status === 'unavailable') {
          var ls = document.createElement('span'); ls.className = 'ob-run-meta'; ls.textContent = 'LinkedIn: unavailable, verified on X';
          meta.appendChild(ls);
        }
        if (lead.source) { var sp = document.createElement('span'); sp.className = 'ob-run-meta'; sp.textContent = 'source: ' + lead.source; meta.appendChild(sp); }
        if (lead.confidence) { var cf = document.createElement('span'); cf.className = 'ob-run-meta'; cf.textContent = 'confidence ' + lead.confidence; meta.appendChild(cf); }
        if (lead.trigger_url) { var tl = document.createElement('a'); tl.className = 'ob-btn'; tl.href = lead.trigger_url; tl.target = '_blank'; tl.rel = 'noopener'; tl.textContent = 'Trigger source ↗'; meta.appendChild(tl); }
        td.appendChild(meta);

        // Draft
        var draft = document.createElement('div'); draft.className = 'ob-draft'; draft.textContent = lead.draft || '(no draft generated)';
        td.appendChild(draft);

        // Actions
        var actions = document.createElement('div'); actions.className = 'ob-actions';

        var copyBtn = document.createElement('button'); copyBtn.className = 'ob-btn primary'; copyBtn.type = 'button'; copyBtn.textContent = 'Copy draft';
        copyBtn.addEventListener('click', function () {
          navigator.clipboard.writeText(lead.draft || '').then(function () { copyBtn.textContent = 'Copied ✓'; setTimeout(function () { copyBtn.textContent = 'Copy draft'; }, 1500); });
        });
        actions.appendChild(copyBtn);

        if (lead.handle_or_email) {
          var open = document.createElement('a'); open.className = 'ob-btn'; open.target = '_blank'; open.rel = 'noopener';
          open.href = /^https?:/i.test(lead.handle_or_email) ? lead.handle_or_email : ('mailto:' + lead.handle_or_email);
          open.textContent = 'Open profile ↗';
          actions.appendChild(open);
        }

        var redraft = document.createElement('button'); redraft.className = 'ob-btn'; redraft.type = 'button'; redraft.textContent = 'Redraft';
        redraft.addEventListener('click', function () {
          redraft.disabled = true; redraft.textContent = 'Redrafting…';
          api('POST', '/leads/' + lead.id + '/redraft', {}).then(function (data) {
            lead.draft = data.lead.draft; draft.textContent = data.lead.draft || '(no draft)';
          }).catch(function (e) { showError(e.message); }).then(function () { redraft.disabled = false; redraft.textContent = 'Redraft'; });
        });
        actions.appendChild(redraft);

        var sel = document.createElement('select'); sel.style.width = 'auto'; sel.style.height = '34px';
        ['new', 'contacted', 'replied', 'skipped'].forEach(function (s) {
          var o = document.createElement('option'); o.value = s; o.textContent = s; if (s === lead.status) o.selected = true; sel.appendChild(o);
        });
        sel.addEventListener('change', function () {
          api('PATCH', '/leads/' + lead.id, { status: sel.value }).then(function (data) { lead.status = data.lead.status; loadRuns(); }).catch(function (e) { showError(e.message); });
        });
        actions.appendChild(sel);
        td.appendChild(actions);

        // Notes
        var notes = document.createElement('textarea'); notes.className = 'ob-notes'; notes.placeholder = 'Notes (saved on blur)'; notes.value = lead.notes || '';
        notes.addEventListener('blur', function () {
          if (notes.value === (lead.notes || '')) return;
          api('PATCH', '/leads/' + lead.id, { notes: notes.value }).then(function (data) { lead.notes = data.lead.notes; }).catch(function (e) { showError(e.message); });
        });
        td.appendChild(notes);

        tr.appendChild(td);
        return tr;
      }

      // ── Start-run form ──────────────────────────────────────────────────────────
      el('ob-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        clearError();
        var brief = el('ob-brief').value.trim();
        if (!brief) { showError('Add a brief describing your ICP and the signals to look for.'); return; }
        var btn = el('ob-start'); btn.disabled = true; btn.textContent = 'Starting…';
        api('POST', '/runs', {
          brief: brief,
          targetCount: parseInt(el('ob-count').value, 10) || 10,
          regionHints: el('ob-region').value.trim(),
          segment: el('ob-segment').value
        }).then(function (data) {
          activeRunId = data.id;
          el('ob-leads-title').textContent = 'Leads · Run #' + data.id;
          renderFunnel(null);
          renderLeadsLoading();
          loadRuns();
          startPolling(data.id);
        }).catch(function (e) { showError(e.message); })
          .then(function () { btn.disabled = false; btn.textContent = 'Find leads'; });
      });

      // ── Init ────────────────────────────────────────────────────────────────────
      loadRuns().then(function (runs) {
        var running = runs.filter(function (r) { return r.status === 'running' || r.status === 'pending'; })[0];
        if (running) { selectRun(running.id, running.status); }
      }).catch(function (e) { showError(e.message); });
    })();
    </script>
  `;
}

module.exports = { renderOutboundBody };
