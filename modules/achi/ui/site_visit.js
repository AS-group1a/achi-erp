(function () {
  'use strict';

  // ACHI Site Visit page. A site visit is a SiteSurvey row: opened automatically
  // when an enquiry moves into the Site visit stage (CRM), or added here by hand.
  // Data: GET/POST /site-visits/, PATCH /surveys/{id} (status), DELETE /surveys/{id}.

  const API = '/api/v1/achi';
  // The workspace for one visit: /survey/ui?id=… (survey.html).
  const WORKSPACE_URL = `${API}/survey/ui`;
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

  // ── Auth: the OCE shell's bearer token, refreshed on 401 (as in crm.js) ────
  const isJwt = value => typeof value === 'string' && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value);
  function jwtPayload(token) {
    try {
      let payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (payload.length % 4) payload += '=';
      return JSON.parse(atob(payload));
    } catch (_error) {
      return null;
    }
  }
  const isAccessJwt = value => isJwt(value) && (jwtPayload(value) || {}).type !== 'refresh';
  function scanStorage(match) {
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const value = storage.getItem(storage.key(index));
        if (match(value)) return value;
        if (value && value[0] === '{') {
          try {
            const parsed = JSON.parse(value);
            const candidates = [
              parsed.access_token, parsed.refresh_token, parsed.token,
              parsed.state && parsed.state.access_token,
              parsed.state && parsed.state.refresh_token,
              parsed.state && parsed.state.token,
            ];
            for (const candidate of candidates) if (match(candidate)) return candidate;
          } catch (_error) { /* ignore unrelated storage entries */ }
        }
      }
    }
    return null;
  }
  function getAccessToken() {
    const direct = localStorage.getItem('oe_access_token');
    return isAccessJwt(direct) ? direct : scanStorage(isAccessJwt);
  }
  function getRefreshToken() {
    const direct = localStorage.getItem('oe_refresh_token');
    if (isJwt(direct)) return direct;
    return scanStorage(value => isJwt(value) && (jwtPayload(value) || {}).type === 'refresh');
  }
  let accessToken = getAccessToken();
  let refreshPromise = null;
  async function refreshAccessToken() {
    if (refreshPromise) return refreshPromise;
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    refreshPromise = fetch('/api/v1/users/auth/refresh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
      .then(response => (response.ok ? response.json() : null))
      .then(payload => {
        if (!payload || !payload.access_token) return false;
        accessToken = payload.access_token;
        localStorage.setItem('oe_access_token', accessToken);
        if (payload.refresh_token) localStorage.setItem('oe_refresh_token', payload.refresh_token);
        return true;
      })
      .catch(() => false)
      .finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  async function request(path, options = {}, retried = false) {
    const headers = { Authorization: `Bearer ${accessToken || ''}`, ...(options.headers || {}) };
    const init = { ...options, headers };
    if (init.body && typeof init.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const response = await fetch(path, init);
    if (response.status === 401 && !retried && await refreshAccessToken()) return request(path, options, true);
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = Array.isArray(body.detail)
        ? body.detail.map(item => item.msg || String(item)).join('; ')
        : body.detail;
      throw new Error(detail || `Request failed (${response.status})`);
    }
    return body;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(message, isError) {
    const toast = $('toast');
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('is-error', Boolean(isError));
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3200);
  }

  // ── Domain ─────────────────────────────────────────────────────────────────
  // Site visit statuses (schemas.SURVEY_STATUSES), with the CRM status pill colours.
  const STATUSES = ['Draft', 'Scheduled', 'In Progress', 'Completed', 'Cancelled'];
  const STATUS_STYLE = {
    Draft:         'background-color:#e5eeff;color:#1f3f80',
    Scheduled:     'background-color:#fff4e0;color:#8a5a08',
    'In Progress': 'background-color:#f3edfb;color:#5b21b6',
    Completed:     'background-color:#dcefe2;color:#14532d',
    Cancelled:     'background-color:#fbeaea;color:#b91c1c',
  };
  // Quick views in the second line.
  const TABS = {
    all: () => true,
    todo: v => v.status === 'Draft' || v.status === 'Scheduled',
    progress: v => v.status === 'In Progress',
    done: v => v.status === 'Completed',
  };
  // Mobile / WA icons — same as the CRM's column.
  const PHONE_ICON = {
    whatsapp: '<svg class="ph-ic is-wa" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>',
    mobile: '<svg class="ph-ic is-mob" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
  };

  const fmtDMY = ymd => {
    if (!ymd) return '';
    const [y, m, d] = String(ymd).slice(0, 10).split('-');
    return d && m && y ? `${d}/${m}/${y}` : String(ymd);
  };

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    rows: [],
    tab: 'all',
    q: '',
    fStatus: '',            // Status column filter
    sel: new Set(),         // selected visit ids (for Delete)
  };

  function visibleRows() {
    const q = state.q;
    return state.rows.filter(v => TABS[state.tab](v)
      && (!state.fStatus || v.status === state.fStatus)
      && (!q || [v.code, v.survey_number, v.enq_code, v.contact_name, v.company, v.site, v.mobile, v.assigned_to, v.status]
        .join(' ').toLowerCase().includes(q)));
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderTabs() {
    document.querySelectorAll('#sv-tabs [data-tab]').forEach(button => {
      button.classList.toggle('on', button.dataset.tab === state.tab);
    });
    document.querySelectorAll('#sv-tabs [data-count]').forEach(badge => {
      badge.textContent = state.rows.filter(TABS[badge.dataset.count]).length;
    });
  }

  function renderHead() {
    const options = ['<option value="">All statuses</option>']
      .concat(STATUSES.map(s => `<option value="${esc(s)}"${state.fStatus === s ? ' selected' : ''}>${esc(s)}</option>`))
      .join('');
    $('sv-hd').innerHTML =
      '<span><button type="button" class="sv-all" data-act="select-all" aria-label="Select all shown site visits" title="Select all"></button>Code</span>'
      + '<span>Visit date</span>'
      + `<span class="flt${state.fStatus ? ' on' : ''}">Status <i class="farr">▾</i>`
      + `<select class="stover" data-act="fstatus" title="Filter by status">${options}</select></span>`
      + '<span>ENQ</span>'
      + '<span>Contact</span>'
      + '<span>Site</span>'
      + '<span>Mobile / WA</span>'
      + '<span>Surveyor</span>'
      + '<span>Captured</span>';
  }

  function statusCell(v) {
    // A status outside the five (a legacy value) keeps its name as the selected entry.
    const current = STATUSES.includes(v.status) ? ''
      : `<option value="" selected disabled>${esc(v.status || '')}</option>`;
    const options = STATUSES.map(s =>
      `<option value="${esc(s)}"${s === v.status ? ' selected' : ''}>${esc(s.toUpperCase())}</option>`).join('');
    return `<span class="stw"><select class="stover stsel-status" style="${STATUS_STYLE[v.status] || STATUS_STYLE.Draft}" `
      + `data-act="status" data-id="${esc(v.id)}" aria-label="Status">${current}${options}</select></span>`;
  }

  function capturedCell(v) {
    const parts = [];
    if (v.measurement_count) parts.push(`${v.measurement_count} meas.`);
    if (v.has_drawing) parts.push('sketch');
    if (v.photo_count) parts.push(`${v.photo_count} photo${v.photo_count === 1 ? '' : 's'}`);
    return parts.length ? `<div class="sv-cap">${parts.map(p => `<span>${esc(p)}</span>`).join('')}</div>` : '';
  }

  function phoneCell(v) {
    if (!v.mobile) return '';
    const kind = v.mobile_kind === 'whatsapp' ? 'whatsapp' : 'mobile';
    return `<span class="ph-cell" title="${esc((kind === 'whatsapp' ? 'WhatsApp: ' : 'Mobile: ') + v.mobile)}">`
      + `${PHONE_ICON[kind]}<span class="ph-num">${esc(v.mobile)}</span></span>`;
  }

  function rowHTML(v) {
    const contact = v.contact_name || '';
    const sub = v.company && v.company !== contact ? `<div class="nm-sub">${esc(v.company)}</div>` : '';
    return `<div class="row${state.sel.has(v.id) ? ' sel' : ''}" data-id="${esc(v.id)}">`
      + `<div class="sv-codecell"><button type="button" class="sv-check" data-act="select" aria-label="Select ${esc(v.code)}" title="Select"></button>`
      + `<a class="code sv-open" href="${WORKSPACE_URL}?id=${encodeURIComponent(v.id)}" title="Open ${esc(v.code)}">${esc(v.code)}</a></div>`
      + `<div class="mut num c2">${esc(fmtDMY(v.survey_date))}</div>`
      + `<div>${statusCell(v)}</div>`
      + `<div>${v.enq_code ? `<span class="code">${esc(v.enq_code)}</span>` : ''}</div>`
      + `<div style="line-height:1.15"><span class="nm-main">${esc(contact)}</span>${sub}</div>`
      + `<div class="mut c2" title="${esc(v.site || '')}">${esc(v.site || '')}</div>`
      + `<div class="mut num c2">${phoneCell(v)}</div>`
      + `<div class="mut c2" title="${esc(v.assigned_to || '')}">${esc(v.assigned_to || '')}</div>`
      + `<div>${capturedCell(v)}</div>`
      + '</div>';
  }

  function renderRows() {
    const list = visibleRows();
    const body = $('sv-rows');
    if (!state.rows.length) {
      body.innerHTML = '<div class="row"><div class="empty">No site visits yet — move an enquiry to Site visit in the CRM, or add one with New visit.</div></div>';
    } else if (!list.length) {
      body.innerHTML = '<div class="row"><div class="empty">No site visits match the current filters.</div></div>';
    } else {
      body.innerHTML = list.map(rowHTML).join('');
    }
    $('sv-foot').innerHTML = `<span>${list.length} of ${state.rows.length} site visits</span>`
      + '<span style="flex:1"></span><span>click a code to open the visit — tick the box to select it</span>';
    syncSelectAll();                                // shown rows changed: re-check the header box
  }

  function renderDelete() {
    const n = state.sel.size;
    $('sv-delete').hidden = n === 0;
    $('sv-del-count').textContent = n;
    syncSelectAll();
  }

  // Header checkbox: ticked when every shown row is selected, a dash when only
  // some are. It works on the rows shown (search, quick view, status filter).
  function syncSelectAll() {
    const box = $('sv-hd').querySelector('.sv-all');
    if (!box) return;
    const shown = visibleRows();
    const picked = shown.filter(v => state.sel.has(v.id)).length;
    const all = shown.length > 0 && picked === shown.length;
    box.classList.toggle('on', all);
    box.classList.toggle('mixed', picked > 0 && !all);
    box.setAttribute('aria-pressed', all ? 'true' : picked ? 'mixed' : 'false');
    box.disabled = shown.length === 0;
  }

  function toggleSelectAll() {
    const shown = visibleRows();
    const all = shown.length > 0 && shown.every(v => state.sel.has(v.id));
    shown.forEach(v => { if (all) state.sel.delete(v.id); else state.sel.add(v.id); });
    renderRows();
    renderDelete();
  }

  function renderAll() {
    renderTabs();
    renderHead();
    renderRows();
    renderDelete();
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load({ quiet = false } = {}) {
    if (!quiet) $('sv-rows').innerHTML = '<div class="row"><div class="empty">Loading…</div></div>';
    try {
      const rows = await request(`${API}/site-visits/`);
      state.rows = Array.isArray(rows) ? rows : [];
      const ids = new Set(state.rows.map(v => v.id));
      state.sel.forEach(id => { if (!ids.has(id)) state.sel.delete(id); });
      renderAll();
    } catch (error) {
      if (quiet) { showToast(error.message || 'Could not refresh.', true); return; }
      $('sv-rows').innerHTML = `<div class="row"><div class="empty">Couldn’t load site visits: ${esc(error.message || 'error')}</div></div>`;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function setStatus(id, status, select) {
    if (select) select.setAttribute('style', STATUS_STYLE[status] || STATUS_STYLE.Draft);   // recolour at once
    try {
      await request(`${API}/surveys/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
      const row = state.rows.find(v => v.id === id);
      if (row) row.status = status;
      renderAll();
      showToast('Status updated.');
    } catch (error) {
      renderAll();                                  // back to the saved status
      showToast(error.message || 'Could not update the status.', true);
    }
  }

  async function deleteSelected() {
    const ids = [...state.sel];
    if (!ids.length) return;
    const codes = state.rows.filter(v => state.sel.has(v.id)).map(v => v.code).join(', ');
    if (!window.confirm(`Delete ${ids.length} site visit${ids.length === 1 ? '' : 's'} (${codes})? This cannot be undone.`)) return;
    const button = $('sv-delete');
    button.disabled = true;
    let failed = 0;
    for (const id of ids) {                         // one at a time, like the other pages
      try {
        await request(`${API}/surveys/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.sel.delete(id);
      } catch (_error) {
        failed += 1;
      }
    }
    button.disabled = false;
    await load({ quiet: true });
    showToast(failed ? `${failed} could not be deleted.` : `Deleted ${ids.length} site visit${ids.length === 1 ? '' : 's'}.`, Boolean(failed));
  }

  // ── + New visit ────────────────────────────────────────────────────────────
  // Create the visit first (Draft, next SV code from the backend), then fill it
  // in the workspace — no form up front.
  // Opens an empty, unsaved form; the visit is only created when Save is pressed.
  function createVisit() {
    window.location.href = `${WORKSPACE_URL}?id=new`;
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  document.addEventListener('change', event => {
    const sel = event.target.closest('select.stover');
    if (!sel) return;
    if (sel.dataset.act === 'status') setStatus(sel.dataset.id, sel.value, sel);
    else if (sel.dataset.act === 'fstatus') { state.fStatus = sel.value; renderHead(); renderRows(); }
  });

  $('sv-rows').addEventListener('click', event => {
    const pick = event.target.closest('[data-act="select"]');
    if (!pick) return;
    const row = pick.closest('.row[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    if (state.sel.has(id)) state.sel.delete(id); else state.sel.add(id);
    row.classList.toggle('sel', state.sel.has(id));
    renderDelete();
  });

  $('sv-hd').addEventListener('click', event => {
    if (event.target.closest('[data-act="select-all"]')) toggleSelectAll();
  });

  $('sv-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    state.tab = button.dataset.tab;
    renderTabs();
    renderRows();
  });

  $('sv-search').addEventListener('input', event => {
    state.q = event.target.value.trim().toLowerCase();
    renderRows();
  });

  $('sv-refresh').addEventListener('click', () => load().then(() => showToast('Site visits refreshed.')));
  $('sv-delete').addEventListener('click', deleteSelected);
  $('sv-new').addEventListener('click', createVisit);

  // ── Boot ───────────────────────────────────────────────────────────────────
  if (!accessToken) {
    $('sv-rows').innerHTML = '<div class="row"><div class="empty">Open the main ERP, sign in, then reload this page.</div></div>';
  } else {
    renderHead();
    load();
  }
})();
