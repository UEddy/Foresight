// Phase 5 — competitor detail page.
//
// Vertical timeline of all detected changes for a single competitor, with
// 0-3 auto-derived pattern callouts above the timeline. Wired to the new
// /api/competitors/:id, /api/competitors/:id/history, and
// /api/competitors/:id/patterns endpoints.

const CompetitorDetail = {
  async render(id) {
    el('topbar-actions').innerHTML = `
      <a href="#/competitors" class="btn btn-ghost btn-sm">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        Back to Competitors
      </a>`;

    try {
      // Parallel: competitor row, history, patterns, upcoming meetings.
      // Server-side scoping on user_id means a wrong id returns 404 before
      // any data leaks. Calendar fetch may 401 if not connected — we
      // swallow that so the rest of the page still renders.
      const [comp, hist, pat, meetings] = await Promise.all([
        API.getCompetitor(id),
        API.getCompetitorHistory(id),
        API.getCompetitorPatterns(id),
        API.getMeetingsByCompetitor(id).catch(() => ({ meetings: [] })),
      ]);
      el('page-root').innerHTML = CompetitorDetail.html(comp, hist, pat, meetings);
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Competitor not found</div>
          <div class="empty-desc">${esc(e.message)}</div>
          <a href="#/competitors" class="btn btn-secondary">← Back to Competitors</a>
        </div>`;
    }
  },

  html(comp, hist, pat, meetingsData) {
    const callouts = pat.callouts || [];
    // hist.changes includes the monitoring baseline as its starting point.
    // `changes` is what actually changed; the baseline is rendered separately
    // and never counted as one.
    const entries = hist.changes || [];
    const changes = entries.filter(c => !c.is_baseline);
    const meetings = meetingsData?.meetings || [];

    return `
      <div class="cd-wrap">

        <!-- Header -->
        <div class="cd-header">
          ${avatarHtml(comp.name, 48)}
          <div class="cd-header-text">
            <div class="cd-name">${esc(comp.name)}</div>
            <a href="${esc(comp.url)}" target="_blank" class="cd-url">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              ${esc(comp.url.replace(/^https?:\/\//, ''))}
            </a>
            ${comp.description ? `<div class="cd-desc">${esc(comp.description)}</div>` : ''}
          </div>
        </div>

        <!-- Pattern callouts -->
        ${callouts.length > 0
          ? `<div class="cd-callouts">${callouts.map(CompetitorDetail.calloutHtml).join('')}</div>`
          : (changes.length > 1
              ? `<div class="cd-empty-callouts">No patterns detected yet. Needs more tagged changes over the last ${hist.days} days.</div>`
              : '')
        }

        ${meetings.length > 0 ? `
          <div class="cd-timeline" style="margin-bottom:16px">
            <div class="cd-timeline-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              Upcoming meetings mentioning ${esc(comp.name)}
              <span class="text-muted text-sm" style="margin-left:auto">${meetings.length} in next 14 days</span>
            </div>
            <ul class="cd-feed">
              ${meetings.map(m => {
                const whenStr = new Date(m.start_time).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                return `
                  <li class="cd-feed-item">
                    <div class="cd-feed-row">
                      <span class="cd-feed-date">${esc(whenStr)}</span>
                      <span class="pattern-tag pattern-tag-sm">${esc(m.match_reason || 'auto')}</span>
                      <span class="cd-feed-headline">${esc(m.title || '(untitled)')}</span>
                      <span class="text-muted text-sm" style="margin-left:auto">briefing ${esc(m.briefing_status)}</span>
                    </div>
                  </li>
                `;
              }).join('')}
            </ul>
          </div>
        ` : ''}

        <!-- Timeline -->
        <div class="cd-timeline">
          <div class="cd-timeline-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Change timeline · last ${hist.days} days
            <span class="text-muted text-sm" style="margin-left:auto">${changes.length} change${changes.length === 1 ? '' : 's'}</span>
          </div>

          ${changes.length === 0 && entries.length === 0
            ? `<div class="empty-desc" style="padding:16px 4px">No changes detected for this competitor in the last ${hist.days} days. The next scheduled check runs daily at 9 AM.</div>`
            : `<ul class="cd-feed">
                ${entries.map(c => (c.is_baseline
                  ? `
                  <li class="cd-feed-item cd-feed-item--baseline" onclick="navigate('/history/${c.id}')">
                    <div class="cd-feed-row">
                      <span class="cd-feed-date">${esc(formatShortDate(c.detected_at))}</span>
                      <span class="badge badge-baseline">BASELINE</span>
                      <span class="cd-feed-headline">Monitoring started, baseline captured. Changes are measured from here.</span>
                    </div>
                  </li>`
                  : `
                  <li class="cd-feed-item threat-${esc(c.threat_level)}" onclick="navigate('/history/${c.id}')">
                    <div class="cd-feed-row">
                      <span class="cd-feed-date">${esc(formatShortDate(c.detected_at))}</span>
                      ${threatBadge(c.threat_level)}
                      <span class="cd-feed-headline">${esc(c.summary || 'Change detected')}</span>
                    </div>
                    ${(c.pattern_tags && c.pattern_tags.length) ? `
                      <div class="cd-feed-tags">
                        ${c.pattern_tags.map(t => `<span class="pattern-tag pattern-tag-sm">${esc(t.replace(/_/g, ' '))}</span>`).join('')}
                      </div>` : ''}
                  </li>`)).join('')}
              </ul>
              ${changes.length === 0
                ? `<div class="empty-desc" style="padding:12px 4px">No changes yet against this baseline. The next scheduled check runs daily at 9 AM.</div>`
                : ''}`
          }
        </div>
      </div>
    `;
  },

  calloutHtml(c) {
    const icons = {
      repeat:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
      trend:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
      severity: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    };
    return `
      <div class="cd-callout cd-callout-${esc(c.kind)}">
        <span class="cd-callout-icon">${icons[c.kind] || icons.trend}</span>
        <span class="cd-callout-label">${esc(c.label)}</span>
      </div>
    `;
  },
};
window.CompetitorDetail = CompetitorDetail;
