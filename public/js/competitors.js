const Competitors = {
  // Cached so the add-page modal can offer "attach to an existing competitor".
  _groups: [],
  _stats: null,

  async render() {
    el('topbar-actions').innerHTML = `
      <button class="btn btn-primary btn-sm" onclick="Competitors.showAddModal()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Page
      </button>`;

    try {
      // Pages (flat) plus stats so we can show pages-used vs the plan limit.
      const [competitors, stats] = await Promise.all([API.getCompetitors(), API.getStats().catch(() => null)]);
      Competitors._stats = stats;
      Competitors._groups = Competitors.buildGroups(competitors);
      el('page-root').innerHTML = Competitors.html(Competitors._groups, stats);
      window.staggerIn?.('.comp-group', 30, 50);
    } catch (e) {
      el('page-root').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div class="empty-title">Error loading competitors</div>
          <div class="empty-desc">${esc(e.message)}</div>
        </div>`;
    }
  },

  // Group the flat page rows by competitor (company). Each returned group has an
  // id (competitor_groups.id, or null for an unmigrated solo page), a name, and
  // its list of page rows.
  buildGroups(pages) {
    const byId = new Map();
    for (const p of pages) {
      const key = p.group_id != null ? `g${p.group_id}` : `solo-${p.id}`;
      if (!byId.has(key)) {
        byId.set(key, { id: p.group_id ?? null, name: p.group_name || p.name, pages: [] });
      }
      byId.get(key).pages.push(p);
    }
    return Array.from(byId.values())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  },

  // Human label for one page: explicit page_label wins; else derive from the URL
  // path ("/pricing" → "Pricing", root → "Homepage").
  pageLabel(p) {
    if (p.page_label && p.page_label.trim()) return p.page_label.trim();
    try {
      const path = new URL(p.url).pathname.replace(/\/+$/, '');
      if (!path || path === '') return 'Homepage';
      const last = path.split('/').filter(Boolean).pop() || 'Homepage';
      return last.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    } catch (_) { return 'Page'; }
  },

  // Pages-used vs plan-limit banner. Transparent counting so the user always
  // sees that pages, not competitors, are what count toward the limit.
  usageBannerHtml(stats) {
    if (!stats) return '';
    const used = stats.pages_used ?? stats.total_competitors ?? 0;
    const max  = stats.max_pages;
    const comps = stats.competitor_count ?? 0;
    // max === null/undefined (TODO tier) or -1 means no enforced cap.
    const unlimited = max === null || max === undefined || max === -1;
    const limitText = unlimited ? '∞' : max;
    const over = !unlimited && used > max;
    // Bar is always capped at 100% so an over-limit count can never render a
    // bar that overflows its track or implies a broken value.
    const pct = unlimited ? 12 : Math.min(100, Math.round((used / Math.max(1, max)) * 100));
    const warn = !unlimited && used / Math.max(1, max) > 0.8;
    return `
      <div class="comp-usage" style="margin-bottom:18px;padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--bg-2)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
          <div style="font-weight:600;color:var(--txt)">
            ${used} of ${limitText} pages monitored
          </div>
          <div class="text-sm text-muted">${comps} competitor${comps === 1 ? '' : 's'}. Each page counts toward your plan limit.</div>
        </div>
        <div style="height:6px;border-radius:4px;background:var(--bg-3, rgba(148,163,184,.18));margin-top:10px;overflow:hidden">
          <div style="height:100%;width:${pct}%;border-radius:4px;background:${warn ? 'var(--red, #ef4444)' : 'var(--accent, #6366f1)'};transition:width .3s"></div>
        </div>
        ${over ? `<div class="text-sm" style="margin-top:8px;color:var(--red, #ef4444);font-weight:500">You are over your plan limit. <a href="#/pricing" style="color:inherit;text-decoration:underline">Upgrade</a> to keep monitoring every page.</div>` : ''}
      </div>`;
  },

  html(groups, stats) {
    if (!groups || groups.length === 0) {
      return `
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div class="empty-title">No competitors yet</div>
          <div class="empty-desc">Add your first page to monitor. Group several pages (pricing, blog, changelog) under one competitor to track a company end to end.</div>
          <div class="empty-desc" style="max-width:520px;margin-top:8px;">Nivaria monitors and analyzes publicly available information such as website content, pricing pages, product announcements, and messaging changes. We do not access private accounts, bypass authentication, or collect non-public data.</div>
          <button class="btn btn-primary" onclick="Competitors.showAddModal()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add First Page
          </button>
        </div>
      `;
    }

    return `
      ${Competitors.usageBannerHtml(stats)}
      <div class="comp-groups">
        ${groups.map((g, i) => Competitors.groupHtml(g, i)).join('')}
      </div>
      <p class="text-muted text-sm mt-16 comp-footnote">
        ${Competitors.footnote(stats)}
      </p>
    `;
  },

  // Plan-aware footnote. Reads in PAGES to match the enforced limit.
  footnote(stats) {
    const tier = (App.subscription?.effectiveTier || 'free');
    if (tier === 'free') {
      return `Free plan: 1 page. <a href="#/pricing" style="color:var(--accent-2)">Upgrade to Pro to monitor up to 15 pages</a>.`;
    }
    if (tier === 'pro') {
      return `Pro plan: up to 15 pages, and up to 5 pages per competitor. <a href="#/pricing" style="color:var(--accent-2)">Higher volumes are coming with Team</a>.`;
    }
    return `Team plan: higher page volume. Up to 5 pages per competitor.`;
  },

  // One competitor (company) as an expandable section. Expanded by default so
  // pages are visible; the header toggles collapse.
  groupHtml(g, index) {
    const gid = g.id != null ? `g${g.id}` : `solo-${g.pages[0].id}`;
    const activeCount = g.pages.filter(p => p.active).length;
    const canAddMore = g.id != null && g.pages.length < 5;
    return `
      <section class="comp-group" data-group="${esc(gid)}" style="border:1px solid var(--border);border-radius:12px;margin-bottom:14px;overflow:hidden;background:var(--bg-2)">
        <header class="comp-group-head" style="display:flex;align-items:center;gap:12px;padding:14px 16px;cursor:pointer" onclick="Competitors.toggleGroup('${esc(gid)}')">
          <button class="comp-group-chevron" aria-label="Expand or collapse" style="background:none;border:none;color:var(--txt-3);display:flex;padding:0" data-chevron="${esc(gid)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transition:transform .2s"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          ${avatarHtml(g.name, 34)}
          <div style="flex:1;min-width:0">
            <div class="td-primary" style="font-weight:600">${esc(g.name)}</div>
            <div class="td-sub text-sm text-muted">${g.pages.length} page${g.pages.length === 1 ? '' : 's'}${activeCount !== g.pages.length ? ` (${activeCount} active)` : ''}</div>
          </div>
          <button class="btn btn-secondary btn-sm" title="${canAddMore ? 'Add another page to this competitor' : 'This competitor is at the 5-page limit'}"
                  ${canAddMore ? '' : 'disabled'}
                  onclick="event.stopPropagation();Competitors.showAddModal(${g.id == null ? 'null' : g.id})">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add page
          </button>
        </header>
        <div class="comp-group-body" data-body="${esc(gid)}">
          <div class="table-wrap cards-sm">
            <table>
              <thead>
                <tr>
                  <th>Page</th><th>URL</th><th>Status</th><th>Last Checked</th><th>Changes</th><th>Last Alert</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${g.pages.map(p => Competitors.pageRowHtml(p)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </section>`;
  },

  pageRowHtml(c) {
    const label = Competitors.pageLabel(c);
    return `
      <tr>
        <td class="cell-title" data-label="Page">
          <div class="td-primary">
            <a href="#/competitors/${c.id}" style="color:inherit;text-decoration:none">${esc(label)}</a>
            ${c.css_selector ? `<span class="scoped-badge" title="Monitoring scoped to: ${esc(c.css_selector)}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
              scoped
            </span>` : ''}
          </div>
        </td>
        <td class="cell-full" data-label="URL">
          <a href="${esc(c.url)}" target="_blank" class="comp-url-link" title="${esc(c.url)}">
            <span class="comp-url-text">${esc(c.url.replace(/^https?:\/\//, '').substring(0, 42))}${c.url.length > 48 ? '…' : ''}</span>
            <svg class="comp-url-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        </td>
        <td data-label="Status">${Competitors.statusPill(c)}</td>
        <td class="text-muted text-sm" data-label="Last checked">${c.last_checked ? timeAgo(c.last_checked) : 'Pending first check'}</td>
        <td data-label="Changes">
          ${c.change_count > 0
            ? `<a href="#/history?competitor_id=${c.id}" class="change-count-link">${c.change_count}</a>`
            : `<span class="text-muted">0</span>`}
        </td>
        <td data-label="Last alert">
          ${c.last_threat ? `
            <div style="display:flex;flex-direction:column;gap:4px">
              ${threatBadge(c.last_threat)}
              <span class="text-sm" style="color:var(--txt-3)">${timeAgo(c.last_change_at)}</span>
            </div>`
          : c.baseline_at ? `
            <div style="display:flex;flex-direction:column;gap:4px" title="The first snapshot of this page. Nothing has changed against it yet.">
              <span class="badge badge-baseline">BASELINE</span>
              <span class="text-sm" style="color:var(--txt-3)">captured ${formatShortDate(c.baseline_at)}</span>
            </div>`
          : '<span class="text-muted">-</span>'}
        </td>
        <td class="cell-full" data-label="Actions">
          <div class="td-actions">
            <button class="btn btn-secondary btn-sm" onclick="Competitors.check(${c.id}, this)" title="Check now">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Check
            </button>
            <button class="btn btn-ghost btn-sm" onclick="Competitors.showEditModal(${c.id})" title="Edit">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn btn-ghost btn-sm" onclick="Competitors.toggle(${c.id}, this)" title="${c.active ? 'Pause' : 'Resume'}">
              ${c.active
                ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
                : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`}
            </button>
            <button class="btn btn-danger btn-sm" onclick="Competitors.remove(${c.id}, '${esc(label)}')" title="Delete page">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
  },

  toggleGroup(gid) {
    const body = document.querySelector(`[data-body="${gid}"]`);
    const chev = document.querySelector(`[data-chevron="${gid}"] svg`);
    if (!body) return;
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? '' : 'none';
    if (chev) chev.style.transform = collapsed ? '' : 'rotate(-90deg)';
  },

  statusPill(c) {
    // Trial expiry archives pages above the Free limit: kept read-only, never
    // deleted, restored automatically on upgrade.
    if (c.archived) {
      return `<span class="status-pill status-pill--paused" title="Archived on the Free plan. Upgrade to restore."><span class="status-dot"></span>Archived</span>`;
    }
    if (!c.active) {
      return `<span class="status-pill status-pill--paused"><span class="status-dot"></span>Paused</span>`;
    }
    const s = c.last_check_status || '';
    const tip = c.last_check_error ? ` title="${esc(c.last_check_error)}"` : '';
    const pill = (cls, label) =>
      `<span class="status-pill status-pill--${cls}"${tip}><span class="status-dot"></span>${label}</span>`;
    const PILL = {
      ssrf_blocked:       ['blocked',          'Private address'],
      access_denied:      ['blocked',          'Access denied'],
      anti_bot:           ['blocked',          'Anti-bot'],
      blocked:            ['blocked',          'Blocked'],
      dns_nxdomain:       ['fetch-error',      'DNS error'],
      connection_failed:  ['fetch-error',      "Can't connect"],
      server_error:       ['fetch-error',      'Server error'],
      http_error:         ['fetch-error',      'HTTP error'],
      render_failed:      ['fetch-error',      'Render error'],
      fetch_failed:       ['fetch-error',      'Fetch error'],
      empty_content:      ['empty',            'Empty'],
      selector_not_found: ['selector-missing', 'Selector not found'],
    };
    if (PILL[s]) { const [cls, label] = PILL[s]; return pill(cls, label); }
    if (s.startsWith('ok_')) return pill('ai-down', 'AI down');
    return `<span class="status-pill status-pill--active"><span class="status-dot"></span>Active</span>`;
  },

  // Add a monitored page. If preselectGroupId is a number, the page attaches to
  // that existing competitor; otherwise the user picks an existing competitor or
  // creates a new one.
  showAddModal(preselectGroupId) {
    const groups = (Competitors._groups || []).filter(g => g.id != null);
    const preId = (typeof preselectGroupId === 'number') ? preselectGroupId : null;
    const groupOpts = groups.map(g =>
      `<option value="${g.id}" ${g.id === preId ? 'selected' : ''} ${g.pages.length >= 5 ? 'disabled' : ''}>${esc(g.name)}${g.pages.length >= 5 ? ' (full: 5 pages)' : ` (${g.pages.length}/5)`}</option>`
    ).join('');

    openModal(`
      <div class="modal-header">
        <div class="modal-title">Add Page to Monitor</div>
        <button class="modal-close" onclick="closeModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Competitor <span style="color:var(--red)">*</span></label>
          <select class="form-input" id="comp-group" onchange="Competitors.onGroupChange()">
            <option value="__new__" ${groups.length === 0 || preId === null ? 'selected' : ''}>New competitor</option>
            ${groupOpts}
          </select>
          <span class="form-hint">Attach this page to a competitor you already track, or create a new one. Each page is monitored and briefed on its own. Up to 5 pages per competitor.</span>
        </div>
        <div class="form-group" id="comp-name-group" style="${preId === null ? '' : 'display:none'}">
          <label class="form-label">New competitor name <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="comp-name" placeholder="e.g. Acme Corp" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">Page URL to Monitor <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="comp-url" placeholder="acme.com/pricing" type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" />
          <span class="form-hint" id="comp-url-preview" aria-live="polite"></span>
          <span class="form-hint">Just type the domain and path, no "https://" needed. Pricing pages, changelogs, and blogs work best.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Page label <span style="color:var(--txt-3);font-weight:400">(optional)</span></label>
          <input class="form-input" id="comp-page-label" placeholder="e.g. Pricing, Changelog, Blog" maxlength="100" />
          <span class="form-hint">Helps you tell this competitor's pages apart. Defaults to the page path.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Internal Notes <span style="color:var(--txt-3);font-weight:400">(optional)</span></label>
          <input class="form-input" id="comp-desc" placeholder="e.g. Primary rival in the SMB market" />
        </div>
        <div class="form-group">
          <label class="form-label">CSS selector <span style="color:var(--txt-3);font-weight:400">(optional)</span></label>
          <input class="form-input" id="comp-selector" placeholder=".pricing-table or #features" maxlength="200" />
          <span class="form-hint">Advanced. Monitor only a specific section of the page. Leave blank to watch the whole page.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Rendering mode</label>
          ${Competitors.renderModeRadios('comp-render-mode', 'fetch')}
          <span class="form-hint">Switch to JavaScript mode if Fast mode shows "no content found" or the page is built with React, Vue, Webflow, or similar.</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="Competitors.submitAdd(this)">Add Page</button>
      </div>
    `);

    setTimeout(() => el(preId === null ? 'comp-name' : 'comp-url')?.focus(), 50);
    const urlInput = el('comp-url');
    urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.querySelector('.modal-footer .btn-primary').click();
    });
    urlInput.addEventListener('input', () => Competitors.updateUrlPreview('comp-url', 'comp-url-preview'));
  },

  // Show/hide the "new competitor name" field based on the competitor select.
  onGroupChange() {
    const sel = el('comp-group');
    const nameGroup = el('comp-name-group');
    if (!sel || !nameGroup) return;
    nameGroup.style.display = (sel.value === '__new__') ? '' : 'none';
  },

  updateUrlPreview(inputId, previewId) {
    const raw     = (el(inputId)?.value || '').trim();
    const preview = el(previewId);
    if (!preview) return;
    if (!raw) { preview.textContent = ''; return; }
    const resolved = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
      ? raw
      : 'https://' + raw.replace(/^\/+/, '');
    preview.textContent = `Monitoring: ${resolved}`;
  },

  renderModeRadios(fieldName, current) {
    const c = current === 'js' ? 'js' : 'fetch';
    return `
      <div class="render-mode-group" style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
        <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
          <input type="radio" name="${fieldName}" value="fetch" ${c === 'fetch' ? 'checked' : ''} style="margin-top:3px"/>
          <span>
            <span style="display:block;color:var(--txt);font-weight:500">Fast (HTML fetch)</span>
            <span style="display:block;color:var(--txt-3);font-size:12px;margin-top:2px">Default, recommended for most sites</span>
          </span>
        </label>
        <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
          <input type="radio" name="${fieldName}" value="js" ${c === 'js' ? 'checked' : ''} style="margin-top:3px"/>
          <span>
            <span style="display:block;color:var(--txt);font-weight:500">JavaScript (slower)</span>
            <span style="display:block;color:var(--txt-3);font-size:12px;margin-top:2px">For modern SaaS pages where content loads dynamically</span>
          </span>
        </label>
      </div>
    `;
  },

  selectedRenderMode(fieldName) {
    const chosen = document.querySelector(`input[name="${fieldName}"]:checked`);
    return chosen?.value === 'js' ? 'js' : 'fetch';
  },

  async submitAdd(btn) {
    const groupSel   = el('comp-group')?.value || '__new__';
    const isNew      = groupSel === '__new__';
    const name       = el('comp-name')?.value.trim() || '';
    const url        = el('comp-url').value.trim();
    const pageLabel  = el('comp-page-label')?.value.trim() || '';
    const desc       = el('comp-desc').value.trim();
    const selector   = el('comp-selector')?.value.trim() || '';
    const renderMode = Competitors.selectedRenderMode('comp-render-mode');

    if (isNew && !name) { toast('Competitor name is required', 'error'); return; }
    if (!url)  { toast('URL is required', 'error'); return; }
    if (selector.length > 200) { toast('CSS selector must be 200 characters or fewer', 'error'); return; }

    btn.disabled = true;
    btn.textContent = 'Adding…';

    const payload = {
      url,
      page_label: pageLabel || undefined,
      description: desc || undefined,
      css_selector: selector || undefined,
      render_mode: renderMode,
    };
    if (isNew) payload.name = name;
    else payload.group_id = parseInt(groupSel, 10);

    try {
      await API.addCompetitor(payload);
      closeModal();
      toast(`Page added${isNew ? ` under ${name}` : ''}`, 'success');
      Competitors.render();
      const stats = await API.getStats();
      App.stats = stats;
      App.updateBadges();
    } catch (e) {
      // A 402 upgrade_required is surfaced centrally by api.js (tier-aware gate).
      if (e.error === 'upgrade_required') return;
      btn.disabled = false;
      btn.textContent = 'Add Page';
      toast(e.message, 'error');
    }
  },

  async showEditModal(id) {
    let c;
    try {
      const all = await API.getCompetitors();
      c = all.find(x => x.id === id);
    } catch (e) { toast(e.message, 'error'); return; }
    if (!c) { toast('Page not found', 'error'); return; }

    const currentMode = c.render_mode === 'js' ? 'js' : 'fetch';
    const showJsHint = currentMode === 'fetch'
      && (c.last_check_status === 'selector_not_found' || c.last_check_status === 'empty_content');

    openModal(`
      <div class="modal-header">
        <div class="modal-title">Edit Page</div>
        <button class="modal-close" onclick="closeModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        ${showJsHint ? `
          <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.35);border-radius:6px;padding:10px 12px;margin-bottom:14px;color:var(--txt-2);font-size:13px;line-height:1.5">
            <strong style="color:var(--txt)">Try switching to JavaScript rendering.</strong>
            The last check failed (${esc(c.last_check_status === 'selector_not_found' ? 'selector not found' : 'empty content')}) while using Fast mode. If this page is built with React, Vue, Webflow, or similar, content loads after the initial HTML and Fast mode can't see it.
          </div>` : ''}
        <div class="form-group">
          <label class="form-label">Competitor Name <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="edit-comp-name" value="${esc(c.group_name || c.name)}" autocomplete="off" />
          <span class="form-hint">Renaming updates every page grouped under this competitor.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Page label <span style="color:var(--txt-3);font-weight:400">(optional)</span></label>
          <input class="form-input" id="edit-comp-page-label" value="${esc(c.page_label || '')}" placeholder="e.g. Pricing, Changelog" maxlength="100" />
        </div>
        <div class="form-group">
          <label class="form-label">Page URL to Monitor <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="edit-comp-url" value="${esc(c.url)}" type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" />
          <span class="form-hint">You can enter just the domain, no "https://" needed. Changing the URL resets the baseline so the next check captures the new page.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Internal Notes <span style="color:var(--txt-3);font-weight:400">(optional)</span></label>
          <input class="form-input" id="edit-comp-desc" value="${esc(c.description || '')}" />
        </div>
        <div class="form-group">
          <label class="form-label">CSS selector <span style="color:var(--txt-3);font-weight:400">(optional)</span></label>
          <input class="form-input" id="edit-comp-selector" value="${esc(c.css_selector || '')}" placeholder=".pricing-table or #features" maxlength="200" />
          <span class="form-hint">Advanced. Monitor only a specific section of the page. Clear this field to revert to full-page monitoring. Changing it resets the baseline.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Rendering mode</label>
          ${Competitors.renderModeRadios('edit-comp-render-mode', currentMode)}
          <span class="form-hint">Switch to JavaScript mode if Fast mode shows "no content found" or the page is built with React, Vue, Webflow, or similar. Changing this resets the baseline.</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="Competitors.submitEdit(${id}, this)">Save Changes</button>
      </div>
    `);
    setTimeout(() => el('edit-comp-name').focus(), 50);
  },

  async submitEdit(id, btn) {
    const name       = el('edit-comp-name').value.trim();
    const pageLabel  = el('edit-comp-page-label')?.value.trim() || '';
    const url        = el('edit-comp-url').value.trim();
    const desc       = el('edit-comp-desc').value.trim();
    const selector   = el('edit-comp-selector').value.trim();
    const renderMode = Competitors.selectedRenderMode('edit-comp-render-mode');

    if (!name) { toast('Name is required', 'error'); return; }
    if (!url)  { toast('URL is required', 'error'); return; }
    if (selector.length > 200) { toast('CSS selector must be 200 characters or fewer', 'error'); return; }

    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      await API.updateCompetitor(id, {
        name,
        page_label: pageLabel, // empty string clears it server-side
        url,
        description: desc,
        css_selector: selector,
        render_mode: renderMode,
      });
      closeModal();
      toast('Saved', 'success');
      Competitors.render();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
      toast(e.message, 'error');
    }
  },

  async check(id, btn) {
    btn.disabled = true;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Checking…`;
    try {
      await API.checkCompetitor(id);
      toast('Check complete. Refreshing…', 'info');
      setTimeout(() => Competitors.render(), 2500);
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Check`;
    }
  },

  // Pause / resume a single page. Updates the row in place (status pill + button)
  // instead of re-rendering the whole list, so the change is instant with no
  // page-wide reflow or refresh flicker. Optimistic: the UI flips immediately,
  // reconciles with the server's authoritative value, and reverts on error.
  async toggle(id, btn) {
    const c = Competitors._findPage(id);
    const row = btn.closest('tr');
    const prev = c ? (c.active ? 1 : 0) : (btn.title === 'Pause' ? 1 : 0);
    const next = prev ? 0 : 1;

    Competitors._applyRowActive(row, btn, c, next);
    btn.disabled = true;
    try {
      const res = await API.toggleCompetitor(id);
      const server = res && typeof res.active === 'boolean' ? (res.active ? 1 : 0) : next;
      if (server !== next) Competitors._applyRowActive(row, btn, c, server);
    } catch (e) {
      Competitors._applyRowActive(row, btn, c, prev); // revert
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  // Find one page (competitor row) across the cached groups by id.
  _findPage(id) {
    for (const g of Competitors._groups) {
      const p = g.pages.find(x => x.id === id);
      if (p) return p;
    }
    return null;
  },

  // Reflect an active/paused state on a single row: refresh the status pill from
  // the (mutated) competitor object and swap the pause/resume button glyph.
  _applyRowActive(row, btn, c, active) {
    if (c) c.active = active;
    if (row && c) {
      const cell = row.querySelector('[data-label="Status"]');
      if (cell) cell.innerHTML = Competitors.statusPill(c);
    }
    btn.title = active ? 'Pause' : 'Resume';
    btn.innerHTML = active
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  },

  async remove(id, label) {
    openModal(`
      <div class="modal-header">
        <div class="modal-title">Delete Page</div>
        <button class="modal-close" onclick="closeModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <p style="color:var(--txt-2);line-height:1.7">
          Are you sure you want to delete the <strong style="color:var(--txt)">${esc(label)}</strong> page?
          This permanently removes all tracked changes and briefs for this page. Other pages under the same competitor are unaffected.
        </p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="Competitors.confirmDelete(${id})">Delete Permanently</button>
      </div>
    `);
  },

  async confirmDelete(id) {
    try {
      await API.deleteCompetitor(id);
      closeModal();
      toast('Page deleted', 'success');
      Competitors.render();
      const stats = await API.getStats();
      App.stats = stats;
      App.updateBadges();
    } catch (e) {
      toast(e.message, 'error');
    }
  },
};
window.Competitors = Competitors;
