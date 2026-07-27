const History = {
  currentFilter: 'all',         // threat filter: all | low | medium | high
  currentPage: 1,

  async render(filter, page) {
    History.currentFilter = filter || new URLSearchParams(window.location.hash.split('?')[1]).get('threat') || 'all';
    History.currentPage = page || 1;

    try {
      // Trivial (AI-downgraded / pre-AI-gated) changes are never requested here
      // — they're hidden from customer-facing views. The server also excludes
      // them by default, so this is defense in depth.
      const params = { page: History.currentPage, limit: 15 };
      if (History.currentFilter !== 'all') params.threat = History.currentFilter;

      const data = await API.getChanges(params);
      el('page-root').innerHTML = History.html(data);
      window.staggerIn?.('.change-card', 40, 60);
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Error loading changes</div>
          <div class="empty-desc">${esc(e.message)}</div>
        </div>`;
    }
  },

  html({ changes, total, page, pages }) {
    const filters = [
      { val: 'all', label: 'All Threats' },
      { val: 'high', label: 'High' },
      { val: 'medium', label: 'Medium' },
      { val: 'low', label: 'Low' },
    ];

    return `
      <div class="filter-row">
        ${filters.map(f => `
          <button class="filter-btn ${History.currentFilter === f.val ? 'active' : ''}" onclick="History.render('${f.val}', 1)">
            ${f.val !== 'all' ? `<span class="filter-dot filter-dot-${f.val}"></span>` : ''}
            ${f.label}
          </button>
        `).join('')}
        <span class="text-muted text-sm" style="margin-left:auto;align-self:center">${total} result${total !== 1 ? 's' : ''}</span>
      </div>

      ${changes.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <div class="empty-title">No changes ${History.currentFilter !== 'all' ? `with ${History.currentFilter} threat` : 'detected yet'}</div>
          <div class="empty-desc">
            ${History.currentFilter !== 'all'
              ? 'Try viewing all changes or a different threat level.'
              : 'Add competitors and run a check to start seeing intelligence here.'}
          </div>
          ${History.currentFilter !== 'all'
            ? `<button class="btn btn-secondary" onclick="History.render('all', 1)">View All Changes</button>`
            : `<a href="#/competitors" class="btn btn-primary">Add Competitor</a>`
          }
        </div>
      ` : `
        <div class="change-list">
          ${changes.map(c => History.changeCard(c)).join('')}
        </div>
        ${pages > 1 ? History.pagination(page, pages) : ''}
      `}
    `;
  },

  changeCard(c) {
    const analysis = c.analysis || {};
    if (c.is_baseline === 1) return History.baselineCard(c, analysis);
    return `
      <div class="change-card" onclick="navigate('/history/${c.id}')">
        <div class="change-threat-stripe ${c.threat_level || 'low'}"></div>
        <div class="change-main">
          <div class="change-top">
            <div class="change-comp">
              ${avatarHtml(c.competitor_name, 26)}
              <span>${esc(c.competitor_name)}</span>
            </div>
            ${threatBadge(c.threat_level)}
            <span class="change-date">${timeAgo(c.detected_at)}</span>
          </div>
          <div class="change-headline">${esc(c.headline || 'Change detected')}</div>
          ${analysis.summary
            ? `<div class="change-summary">${esc(analysis.summary.substring(0, 180))}${analysis.summary.length > 180 ? '…' : ''}</div>`
            : ''
          }
          <div class="change-actions">
            <a href="#/history/${c.id}" class="btn btn-primary btn-sm" onclick="event.stopPropagation()">
              View Brief
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            </a>
            <a href="${esc(c.competitor_url)}" target="_blank" class="btn btn-ghost btn-sm" onclick="event.stopPropagation()">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Open Page
            </a>
            <span class="text-muted text-sm" style="margin-left:auto">${formatDate(c.detected_at)}</span>
          </div>
        </div>
      </div>
    `;
  },

  // The monitoring baseline: the first snapshot of a page, shown so a new
  // account is not staring at an empty feed. It is deliberately styled apart
  // from a change card, carries no threat badge, and its date is described as
  // when the SNAPSHOT was taken. Nothing on the page changed at that moment.
  baselineCard(c, analysis) {
    return `
      <div class="change-card change-card--baseline" onclick="navigate('/history/${c.id}')">
        <div class="change-threat-stripe baseline"></div>
        <div class="change-main">
          <div class="change-top">
            <div class="change-comp">
              ${avatarHtml(c.competitor_name, 26)}
              <span>${esc(c.competitor_name)}</span>
            </div>
            <span class="badge badge-baseline">BASELINE</span>
            <span class="change-date">Snapshot taken ${formatShortDate(c.detected_at)}</span>
          </div>
          <div class="change-headline">Monitoring started, baseline captured</div>
          <div class="change-summary">
            ${analysis.summary
              ? `${esc(analysis.summary.substring(0, 180))}${analysis.summary.length > 180 ? '…' : ''}`
              : 'This page as it stands now. Nothing has changed yet: briefs start when it differs from this snapshot.'}
          </div>
          <div class="change-actions">
            <a href="#/history/${c.id}" class="btn btn-secondary btn-sm" onclick="event.stopPropagation()">
              View Baseline
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            </a>
            <a href="${esc(c.competitor_url)}" target="_blank" class="btn btn-ghost btn-sm" onclick="event.stopPropagation()">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Open Page
            </a>
            <span class="text-muted text-sm" style="margin-left:auto">Monitoring is live</span>
          </div>
        </div>
      </div>
    `;
  },

  pagination(page, pages) {
    return `
      <div class="pagination">
        <button class="btn btn-secondary btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="History.render(History.currentFilter, ${page - 1})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          Prev
        </button>
        <span class="text-muted text-sm">Page ${page} of ${pages}</span>
        <button class="btn btn-secondary btn-sm" ${page >= pages ? 'disabled' : ''} onclick="History.render(History.currentFilter, ${page + 1})">
          Next
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
    `;
  },
};
window.History = History;
