const BattleCard = {
  _playbookCache: {}, // change_id → { playbooks: [...] }

  async render(id) {
    el('topbar-actions').innerHTML = `
      <a href="#/history" class="btn btn-ghost btn-sm">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        Back to Feed
      </a>`;

    try {
      const c = await API.getChange(id);
      // Fetch playbooks in parallel after rendering so the battle card paints
      // immediately without waiting on the playbook table query.
      el('page-root').innerHTML = BattleCard.html(c);
      if (['high', 'medium'].includes(c.threat_level) && (c.is_meaningful === null || c.is_meaningful === undefined || c.is_meaningful === 1)) {
        BattleCard.loadPlaybooks(id);
      }
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Brief not found</div>
          <div class="empty-desc">${esc(e.message)}</div>
          <a href="#/history" class="btn btn-secondary">← Back to Feed</a>
        </div>`;
    }
  },

  // Initial baseline view. Deliberately NOT a battle card: no threat level, no
  // talking points, no outreach. It states what was captured and when the
  // SNAPSHOT was taken, and says plainly that none of it is a change. Anything
  // on the page may well predate monitoring, so nothing here is dated as new.
  baselineHtml(c, a) {
    let snap = {};
    try { snap = c.content_after ? JSON.parse(c.content_after) : {}; } catch (_) { snap = {}; }
    const headings = Array.isArray(snap.headings) ? snap.headings.filter(Boolean).slice(0, 8) : [];
    const hasPricing  = Boolean((snap.pricing  || '').trim());
    const hasFeatures = Boolean((snap.features || '').trim());

    return `
      <div class="bc-wrap bc-wrap--baseline">

        <div class="bc-header">
          <div class="bc-left">
            ${avatarHtml(c.competitor_name, 52)}
            <div>
              <div class="bc-comp-name">${esc(c.competitor_name)}</div>
              <a href="${esc(c.competitor_url)}" target="_blank" class="bc-comp-url">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                ${esc(c.competitor_url.replace(/^https?:\/\//, '').substring(0, 50))}
              </a>
            </div>
          </div>
          <div class="bc-threat bc-threat--baseline">
            <div class="bc-threat-label">INITIAL BASELINE</div>
            <div class="bc-threat-date">Snapshot taken ${formatDate(c.detected_at)}</div>
          </div>
        </div>

        <div class="bc-headline-wrap">
          <h2 class="bc-headline">Monitoring started, baseline captured</h2>
          <div class="bc-headline-actions">
            <span class="badge badge-baseline">BASELINE</span>
          </div>
        </div>

        <div class="bc-section bc-summary">
          <div class="bc-section-label">What this is</div>
          <div class="bc-section-body">
            ${esc(a.summary || `Baseline snapshot of ${c.competitor_url} recorded. This is the page as it stands now, not a change.`)}
          </div>
          <div class="bc-reasoning">
            <strong>Not a change:</strong> everything captured here was already on the page when you
            started monitoring it, whenever it was published. Nothing here happened today. You get a
            brief the next time this page differs from this snapshot.
          </div>
        </div>

        <div class="bc-section bc-full">
          <div class="bc-section-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
            Current state at baseline
          </div>
          ${snap.title ? `<div class="bc-section-body"><strong>Page title:</strong> ${esc(String(snap.title).slice(0, 160))}</div>` : ''}
          ${snap.metaDescription ? `<div class="bc-section-body">${esc(String(snap.metaDescription).slice(0, 300))}</div>` : ''}
          ${headings.length > 0 ? `
            <ul class="talking-points">
              ${headings.map(h => `
                <li class="talking-point">
                  <span class="talking-point-check">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </span>
                  ${esc(String(h).slice(0, 160))}
                </li>`).join('')}
            </ul>` : ''}
          <div class="bc-section-body text-muted text-sm">
            ${hasPricing ? 'A pricing section was captured and is being tracked. ' : ''}${hasFeatures ? 'A features section was captured and is being tracked. ' : ''}${(!snap.title && headings.length === 0 && !hasPricing && !hasFeatures) ? 'The snapshot is stored and will be compared against the next check.' : ''}
          </div>
        </div>

        <div class="bc-footer">
          <a href="#/history" class="btn btn-ghost btn-sm">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
            All Changes
          </a>
          <a href="#/competitors/${c.competitor_id}" class="btn btn-ghost btn-sm">
            View ${esc(c.competitor_name)} timeline
          </a>
          <a href="${esc(c.competitor_url)}" target="_blank" class="btn btn-secondary btn-sm" style="margin-left:auto">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            View Live Page
          </a>
        </div>
      </div>
    `;
  },

  html(c) {
    const a = c.analysis || {};
    // A baseline is the starting snapshot of a page, not a brief about a move
    // the competitor made, so it gets its own view instead of the battle card.
    if (c.is_baseline === 1) return BattleCard.baselineHtml(c, a);
    const talkingPoints = Array.isArray(c.talking_points) ? c.talking_points : (a.talking_points || []);
    const keyChanges = Array.isArray(a.key_changes) ? a.key_changes : [];
    const threat = c.threat_level || 'low';
    // Phase 6: "Analyzed for: [Company]" label shown only when the AI actually
    // saw the user's business context (context_used flag set at insert time)
    // AND a company name is on file. If either is missing, render generic.
    const analyzedFor = (c.context_used === 1 && c.user_company_name && c.user_company_name.trim())
      ? c.user_company_name.trim()
      : null;
    // Phase 5: historical context + recent prior changes for this competitor.
    // historical_context lives either on the change row directly (post-Phase 5)
    // or, for older Phase-4 rows, never — guard for both.
    const historicalContext = (typeof c.historical_context === 'string' && c.historical_context.trim())
      ? c.historical_context.trim()
      : (typeof a.historical_context === 'string' ? a.historical_context.trim() : '');
    const patternTags = Array.isArray(c.pattern_tags) ? c.pattern_tags
                       : (Array.isArray(a.pattern_tags) ? a.pattern_tags : []);
    const recentChanges = Array.isArray(c.recent_changes) ? c.recent_changes : [];

    const threatMeta = {
      high:   { color: 'var(--red)',    label: 'HIGH THREAT',   bg: 'var(--red-dim)',    border: 'rgba(239,68,68,0.25)' },
      medium: { color: 'var(--yellow)', label: 'MEDIUM THREAT', bg: 'var(--yellow-dim)', border: 'rgba(245,158,11,0.2)' },
      low:    { color: 'var(--green)',  label: 'LOW THREAT',    bg: 'var(--green-dim)',  border: 'rgba(16,185,129,0.2)' },
    };
    const tm = threatMeta[threat] || threatMeta.low;

    return `
      <div class="bc-wrap">

        ${analyzedFor ? `
          <div class="bc-analyzed-for" title="This brief was personalized using your saved business context. Edit in Settings.">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            Analyzed for: ${esc(analyzedFor)}
          </div>
        ` : ''}

        <!-- Header -->
        <div class="bc-header">
          <div class="bc-left">
            ${avatarHtml(c.competitor_name, 52)}
            <div>
              <div class="bc-comp-name">${esc(c.competitor_name)}</div>
              <a href="${esc(c.competitor_url)}" target="_blank" class="bc-comp-url">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                ${esc(c.competitor_url.replace(/^https?:\/\//, '').substring(0, 50))}
              </a>
            </div>
          </div>
          <div class="bc-threat" style="background:${tm.bg};border-color:${tm.border};color:${tm.color}">
            <div class="bc-threat-label">${tm.label}</div>
            <div class="bc-threat-date">${formatDate(c.detected_at)}</div>
          </div>
        </div>

        <!-- Headline -->
        <div class="bc-headline-wrap">
          <h2 class="bc-headline">${esc(c.headline || 'Change detected')}</h2>
          <div class="bc-headline-actions">
            ${threatBadge(threat)}
            <button class="btn btn-ghost btn-sm" onclick="BattleCard.copy(${c.id})">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy Brief
            </button>
          </div>
        </div>

        <!-- Summary -->
        ${a.summary ? `
          <div class="bc-section bc-summary">
            <div class="bc-section-label">Executive Summary</div>
            <div class="bc-section-body">${esc(a.summary)}</div>
          </div>
        ` : ''}

        <!-- Pattern context (Phase 5) -->
        ${historicalContext ? `
          <div class="bc-section bc-pattern-context">
            <div class="bc-section-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 12 8 12 11 5 14 19 17 12 21 12"/></svg>
              Pattern context
            </div>
            <div class="bc-section-body">${esc(historicalContext)}</div>
            ${patternTags.length > 0 ? `
              <div class="bc-pattern-tags">
                ${patternTags.map(t => `<span class="pattern-tag">${esc(t.replace(/_/g, ' '))}</span>`).join('')}
              </div>` : ''}
          </div>
        ` : ''}

        <!-- Grid -->
        <div class="bc-grid">

          <!-- Recommended Response -->
          <div class="bc-section bc-response">
            <div class="bc-section-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Recommended Response
            </div>
            <div class="bc-section-body">${esc(a.recommended_response || c.recommended_response || 'Review changes manually.')}</div>
            ${a.threat_reasoning ? `
              <div class="bc-reasoning">
                <strong>Why this level:</strong> ${esc(a.threat_reasoning)}
              </div>` : ''}
          </div>

          <!-- Opportunity -->
          ${a.opportunity ? `
            <div class="bc-section bc-opportunity">
              <div class="bc-section-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                Opportunity
              </div>
              <div class="bc-section-body">${esc(a.opportunity)}</div>
            </div>
          ` : '<div></div>'}

          <!-- Talking Points -->
          <div class="bc-section bc-full">
            <div class="bc-section-header">
              <div class="bc-section-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Sales Talking Points
              </div>
              <button class="btn btn-ghost btn-sm" onclick="BattleCard.copyPoints(this)">Copy All</button>
            </div>
            ${talkingPoints.length > 0
              ? `<ul class="talking-points">
                  ${talkingPoints.map(p => `
                    <li class="talking-point">
                      <span class="talking-point-check">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      </span>
                      ${esc(p)}
                    </li>`).join('')}
                </ul>`
              : '<p class="text-muted text-sm">No talking points generated.</p>'
            }
          </div>

          <!-- Key Changes -->
          ${keyChanges.length > 0 ? `
            <div class="bc-section bc-full">
              <div class="bc-section-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                Key Changes Detected
              </div>
              <div class="key-changes">
                ${keyChanges.map(kc => `
                  <div class="key-change">
                    <span class="key-change-cat">${esc(kc.category || 'other')}</span>
                    <div class="key-change-body">
                      <div class="key-change-desc">${esc(kc.description || '')}</div>
                      ${kc.impact ? `<div class="key-change-impact">${esc(kc.impact)}</div>` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

        </div>

        <!-- Outreach (Phase 8) — placeholder; filled by loadPlaybooks() -->
        ${(['high', 'medium'].includes(threat) && (c.is_meaningful === null || c.is_meaningful === undefined || c.is_meaningful === 1)) ? `
          <div class="bc-section bc-outreach" id="bc-outreach-${c.id}">
            <div class="bc-section-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
              Outreach
              <span class="bc-section-sub">AI-drafted messages in your voice. Copy, regenerate, or tweak before sending.</span>
            </div>
            <div class="outreach-loading">
              <div class="spinner spinner--sm"></div>
              <span>Generating outreach drafts…</span>
            </div>
          </div>
        ` : ''}

        <!-- Recent changes from this competitor (Phase 5) -->
        ${recentChanges.length > 0 ? `
          <div class="bc-section bc-recent">
            <div class="bc-section-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              Recent changes from this competitor
            </div>
            <ul class="recent-changes-list">
              ${recentChanges.map(r => `
                <li class="recent-change-item" onclick="navigate('/history/${r.id}')">
                  <span class="recent-change-date">${esc(formatShortDate(r.detected_at))}</span>
                  ${threatBadge(r.threat_level)}
                  <span class="recent-change-headline">${esc(r.headline || 'Change detected')}</span>
                  ${(r.pattern_tags && r.pattern_tags.length) ? `<span class="recent-change-tags">${r.pattern_tags.slice(0, 2).map(t => `<span class="pattern-tag pattern-tag-sm">${esc(t.replace(/_/g, ' '))}</span>`).join('')}</span>` : ''}
                </li>
              `).join('')}
            </ul>
            <div class="recent-changes-footer">
              <a href="#/competitors/${c.competitor_id}" class="btn btn-ghost btn-sm">
                View full timeline
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
              </a>
            </div>
          </div>
        ` : ''}

        <!-- Footer -->
        <div class="bc-footer">
          <a href="#/history" class="btn btn-ghost btn-sm">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
            All Changes
          </a>
          <a href="#/history?competitor_id=${c.competitor_id}" class="btn btn-ghost btn-sm">
            All ${esc(c.competitor_name)} Changes
          </a>
          <a href="${esc(c.competitor_url)}" target="_blank" class="btn btn-secondary btn-sm" style="margin-left:auto">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            View Live Page
          </a>
        </div>

      </div>
    `;
  },

  async copy(id) {
    try {
      const c = await API.getChange(id);
      const a = c.analysis || {};
      const points = Array.isArray(c.talking_points) ? c.talking_points : (a.talking_points || []);

      // Guard against copying an empty/pending brief. Without this, a brief whose
      // analysis hasn't been generated yet collapses to just the "Source: … | url"
      // footer, so the clipboard would end up holding only the competitor URL.
      // Detect that the brief has no real body and tell the user to wait instead.
      const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
      const isPending = c.analysis_status && c.analysis_status !== 'ok';
      const hasBody = nonEmpty(c.headline) || nonEmpty(a.summary) ||
        nonEmpty(a.recommended_response) || nonEmpty(c.recommended_response) ||
        nonEmpty(a.opportunity) || points.length > 0;
      if (isPending || !hasBody) {
        toast('Brief not yet generated. Try again in a few minutes.', 'info');
        return;
      }

      const text = [
        `BRIEF: ${c.competitor_name}`,
        `Date: ${formatDate(c.detected_at)}`,
        `Threat Level: ${(c.threat_level || 'unknown').toUpperCase()}`,
        '',
        `HEADLINE: ${c.headline}`,
        '',
        `SUMMARY: ${a.summary || ''}`,
        '',
        `RECOMMENDED RESPONSE: ${a.recommended_response || c.recommended_response || ''}`,
        '',
        'TALKING POINTS:',
        ...points.map((p, i) => `${i + 1}. ${p}`),
        '',
        `OPPORTUNITY: ${a.opportunity || ''}`,
        '',
        `Source: Nivaria | ${c.competitor_url}`,
      ].join('\n');

      // Write the brief text straight to the clipboard. We deliberately do NOT
      // route the brief through the OS share sheet (shareOrCopy): on desktop
      // browsers that implement the Web Share API (e.g. Edge on Windows),
      // selecting the share sheet's "Copy" target writes the originating *page
      // URL* — the app host, e.g. "https://railway.com/" — to the clipboard
      // instead of our text payload, so users ended up with a bare URL rather
      // than the brief. Writing the string ourselves keeps the clipboard
      // contents deterministic: it's always the brief we just built.
      await navigator.clipboard.writeText(text);
      toast('Brief copied to clipboard', 'success');
    } catch (e) {
      toast('Could not copy: ' + e.message, 'error');
    }
  },

  // ── Outreach playbooks (Phase 8) ───────────────────────────────────────────

  async loadPlaybooks(changeId) {
    const container = document.getElementById(`bc-outreach-${changeId}`);
    if (!container) return;
    try {
      const data = await API.getPlaybooksForChange(changeId);
      BattleCard._playbookCache[changeId] = data;
      BattleCard.renderPlaybooks(changeId, data.playbooks || []);
    } catch (e) {
      container.innerHTML = `
        <div class="bc-section-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          Outreach
        </div>
        <div class="outreach-empty">
          <p class="text-muted text-sm">Could not load outreach drafts: ${esc(e.message)}</p>
        </div>`;
    }
  },

  renderPlaybooks(changeId, playbooks) {
    const container = document.getElementById(`bc-outreach-${changeId}`);
    if (!container) return;

    if (!playbooks || playbooks.length === 0) {
      container.innerHTML = `
        <div class="bc-section-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          Outreach
          <span class="bc-section-sub">AI-drafted messages in your voice</span>
        </div>
        <div class="outreach-empty">
          <p class="text-muted text-sm">No drafts yet for this change.</p>
          <button class="btn btn-primary btn-sm" onclick="BattleCard.generatePlaybooks(${changeId}, this)">Generate outreach drafts</button>
        </div>`;
      return;
    }

    const labels = {
      slack_to_team:     { label: 'Slack to team',    icon: 'slack' },
      email_to_prospect: { label: 'Email to prospect',icon: 'mail' },
      followup_email:    { label: 'Follow-up email',  icon: 'mail' },
    };

    const order = ['slack_to_team', 'email_to_prospect', 'followup_email'];
    const ordered = order.map(t => playbooks.find(p => p.message_type === t)).filter(Boolean);

    const tabs = ordered.map((p, idx) => `
      <button class="outreach-tab ${idx === 0 ? 'outreach-tab--active' : ''}" data-tab="${p.message_type}"
        onclick="BattleCard.switchTab(${changeId}, '${p.message_type}')">
        ${esc(labels[p.message_type]?.label || p.message_type)}
        ${p.regenerated_count > 0 ? `<span class="outreach-regen-count" title="Regenerated ${p.regenerated_count}×">↻${p.regenerated_count}</span>` : ''}
      </button>
    `).join('');

    const panels = ordered.map((p, idx) => BattleCard.renderPlaybookPanel(changeId, p, idx === 0)).join('');

    container.innerHTML = `
      <div class="bc-section-label">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        Outreach
        <span class="bc-section-sub">AI-drafted messages in your voice. Copy, regenerate, or tweak before sending.</span>
      </div>
      <div class="outreach-tabs">${tabs}</div>
      <div class="outreach-panels" id="outreach-panels-${changeId}">${panels}</div>
    `;
  },

  renderPlaybookPanel(changeId, p, isActive) {
    const hasSubject = !!p.subject_line && p.message_type !== 'slack_to_team';
    const body = p.body || '';
    const safeId = `pb-${p.id}`;

    if (p.generation_status && !['ok', 'ok_with_warnings'].includes(p.generation_status)) {
      return `
        <div class="outreach-panel ${isActive ? 'outreach-panel--active' : ''}" data-panel="${p.message_type}">
          <div class="outreach-error">
            <strong>Generation failed:</strong> ${esc(p.generation_error || p.generation_status)}
            <div style="margin-top:10px"><button class="btn btn-secondary btn-sm" onclick="BattleCard.regeneratePlaybook(${p.id}, this)">Try again</button></div>
          </div>
        </div>`;
    }

    return `
      <div class="outreach-panel ${isActive ? 'outreach-panel--active' : ''}" data-panel="${p.message_type}" id="panel-${safeId}">
        ${hasSubject ? `
          <div class="outreach-subject-row">
            <label class="outreach-subject-label">Subject</label>
            <div class="outreach-subject-box">
              <span class="outreach-subject-value" id="${safeId}-subject">${esc(p.subject_line)}</span>
              <button class="btn btn-ghost btn-sm" onclick="BattleCard.copyText('${safeId}-subject', this)" title="Copy subject">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Copy
              </button>
            </div>
          </div>
        ` : ''}

        <div class="outreach-body-wrap">
          <div class="outreach-body" id="${safeId}-body" data-original="${esc(body)}">${esc(body).replace(/\n/g, '<br>')}</div>
          <textarea class="outreach-edit-area" id="${safeId}-edit" style="display:none" rows="10">${esc(body)}</textarea>
        </div>

        ${p.generation_status === 'ok_with_warnings' && p.generation_error ? `
          <div class="outreach-warning">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            ${esc(p.generation_error)}
          </div>` : ''}

        <div class="outreach-actions">
          <button class="btn btn-primary btn-sm" onclick="BattleCard.copyPlaybookBody('${safeId}', this)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          </button>
          <button class="btn btn-secondary btn-sm" onclick="BattleCard.toggleEdit('${safeId}', this)" id="${safeId}-edit-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="btn btn-ghost btn-sm" onclick="BattleCard.regeneratePlaybook(${p.id}, this)" title="Generate a fresh draft">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            Regenerate
          </button>
          <span class="outreach-meta">
            ${p.regenerated_count > 0 ? `Regenerated ${p.regenerated_count}× · ` : ''}
            ${esc(formatShortDate(p.generated_at) || '')}
          </span>
        </div>
      </div>`;
  },

  switchTab(changeId, messageType) {
    const root = document.getElementById(`bc-outreach-${changeId}`);
    if (!root) return;
    root.querySelectorAll('.outreach-tab').forEach(t => {
      t.classList.toggle('outreach-tab--active', t.dataset.tab === messageType);
    });
    root.querySelectorAll('.outreach-panel').forEach(p => {
      p.classList.toggle('outreach-panel--active', p.dataset.panel === messageType);
    });
  },

  async copyText(elementId, btn) {
    const node = document.getElementById(elementId);
    if (!node) return;
    const text = node.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.innerHTML;
      btn.innerHTML = '<span style="color:var(--green)">✓ Copied</span>';
      setTimeout(() => { btn.innerHTML = original; }, 1600);
      toast('Copied to clipboard', 'success');
    } catch (e) {
      toast('Could not copy: ' + e.message, 'error');
    }
  },

  async copyPlaybookBody(safeId, btn) {
    // Copy from the edit textarea if it's open (so edits are honored);
    // otherwise from the rendered body.
    const editArea = document.getElementById(`${safeId}-edit`);
    let text = '';
    if (editArea && editArea.style.display !== 'none') {
      text = editArea.value || '';
    } else {
      const body = document.getElementById(`${safeId}-body`);
      text = body?.dataset.original || body?.textContent || '';
    }
    try {
      const result = await shareOrCopy({ text });
      const original = btn.innerHTML;
      // Inline button feedback runs regardless of method — confirms the action
      // even when no toast appears (e.g. share-sheet was active).
      btn.innerHTML = result === 'share' ? '<span style="color:var(--green)">✓ Shared</span>'
                                         : '<span style="color:var(--green)">✓ Copied</span>';
      setTimeout(() => { btn.innerHTML = original; }, 1600);
      if (result === 'share')     toast('Message shared', 'success');
      else if (result === 'clipboard') toast('Message copied to clipboard', 'success');
    } catch (e) {
      toast('Could not copy: ' + e.message, 'error');
    }
  },

  toggleEdit(safeId, btn) {
    const body  = document.getElementById(`${safeId}-body`);
    const edit  = document.getElementById(`${safeId}-edit`);
    if (!body || !edit) return;

    if (edit.style.display === 'none') {
      // Switch to edit mode
      edit.value = body.dataset.original || body.textContent || '';
      body.style.display = 'none';
      edit.style.display = 'block';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>Done editing';
      edit.focus();
    } else {
      // Switch back — keep the edited text shown
      body.dataset.original = edit.value;
      body.innerHTML = esc(edit.value).replace(/\n/g, '<br>');
      body.style.display = '';
      edit.style.display = 'none';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Edit';
    }
  },

  async generatePlaybooks(changeId, btn) {
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = '<div class="spinner spinner--sm"></div> Generating…';
    try {
      const data = await API.generatePlaybooks(changeId);
      BattleCard._playbookCache[changeId] = data;
      BattleCard.renderPlaybooks(changeId, data.playbooks || []);
      toast('Outreach drafts generated', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = original;
      toast(e.message, 'error');
    }
  },

  async regeneratePlaybook(playbookId, btn) {
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = '<div class="spinner spinner--sm"></div> Regenerating…';
    try {
      const { playbook } = await API.regeneratePlaybook(playbookId);
      // Find the change_id for this playbook from the cache, then re-render.
      const changeId = playbook?.change_id;
      if (changeId) {
        // Refresh the whole list so order + regen counts update cleanly.
        const data = await API.getPlaybooksForChange(changeId);
        BattleCard._playbookCache[changeId] = data;
        BattleCard.renderPlaybooks(changeId, data.playbooks || []);
        // Keep focus on the same variant tab the user was on.
        BattleCard.switchTab(changeId, playbook.message_type);
      }
      toast('Regenerated. Fresh draft below.', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = original;
      toast(e.message, 'error');
    }
  },

  async copyPoints(btn) {
    const pts = Array.from(document.querySelectorAll('.talking-point')).map(li => li.textContent.trim());
    if (pts.length === 0) return toast('No talking points to copy', 'error');
    try {
      const result = await shareOrCopy({ title: 'Talking points', text: pts.join('\n') });
      btn.textContent = result === 'share' ? '✓ Shared!' : '✓ Copied!';
      if (result === 'share')     toast('Talking points shared', 'success');
      else if (result === 'clipboard') toast('Talking points copied', 'success');
      setTimeout(() => { btn.textContent = 'Copy All'; }, 2000);
    } catch (e) {
      toast('Could not copy', 'error');
    }
  },
};
window.BattleCard = BattleCard;
