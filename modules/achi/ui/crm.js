(function () {
  'use strict';

  const API = '/api/v1/achi';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

  // ── Auth (kept from the previous CRM app) ──────────────────────────────────
  // The page has no server session; it reads the bearer token the OCE shell
  // stashed in storage and refreshes it on a 401. request() is the single fetch
  // wrapper every call goes through.
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
      const error = new Error(detail || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
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

  // ── Domain: the enquiry stage pipeline + the document pills ─────────────────
  const STAGES = [
    { k: 'enquiry',     label: 'Enquiry',     color: '#2563eb' },
    { k: 'site_survey', label: 'Site Visit', color: '#0891b2' },
    { k: 'takeoff',     label: 'Takeoff',     color: '#0ea5e9' },
    { k: 'boq',         label: 'BOQ',         color: '#7c3aed' },
    { k: 'costing',     label: 'Costing',     color: '#ea580c' },
    { k: 'quotation',   label: 'Quotation',   color: '#2563eb' },
  ];
  const STAGE_INDEX = {};
  STAGES.forEach((s, i) => { STAGE_INDEX[s.k] = i; });
  // Rows created before the pipeline change still carry legacy stage values.
  const LEGACY_STAGE = { prospect: 'enquiry', lead: 'enquiry', site_survey: 'site_survey', measurements: 'takeoff' };
  const normStage = s => {
    const k = LEGACY_STAGE[s] || s;
    return STAGE_INDEX[k] != null ? k : 'enquiry';
  };
  const DOCS = [['srv', 'SURV'], ['dwg', 'DWG'], ['mt', 'M/T'], ['boq', 'BOQ'], ['cst', 'CST'], ['qte', 'QTE']];

  // ── Table ────────────────────────────────────────────────────────────────
  // One row per enquiry log from /logs/ — the same data the Log page shows, so
  // anything added there appears here automatically.
  const COLS = [
    { k: 'num',      h: '#',           w: 48 },
    { k: 'ref',      h: 'ENQ Ref',     w: 132 },
    { k: 'when',     h: 'Date / Time', w: 150 },
    { k: 'owner',    h: 'Owner',       w: 92 },
    { k: 'name',     h: 'Name',        w: 190 },
    { k: 'phone',    h: 'Phone',       w: 150 },
    { k: 'location', h: 'Location',    w: 230 },
    { k: 'desc',     h: 'Description', w: 320 },
    { k: 'stage',    h: 'Stage',       w: 200 },
    { k: 'docs',     h: 'Docs',        w: 250 },
    { k: 'followup', h: 'Follow-up',   w: 128 },
  ];

  let ROWS = [];
  let searchTerm = '';

  const dash = v => (v != null && String(v).trim() ? esc(v) : '<span class="mt">—</span>');

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function fmtDate(v) {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return {
      date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    };
  }

  function stageCell(r) {
    const cur = normStage(r.stage);
    const idx = STAGE_INDEX[cur];
    const s = STAGES[idx];
    const segs = STAGES.map((_, i) =>
      `<span class="seg${i <= idx ? ' on' : ''}" style="${i <= idx ? `background:${s.color}` : ''}"></span>`).join('');
    return (
      `<div class="stage-cell" data-file="${esc(r.file_id)}" data-stage="${esc(cur)}">`
      + '<button type="button" class="stage-btn">'
      + `<span class="dot" style="background:${s.color}"></span>`
      + `<span class="stage-label" style="color:${s.color}">${esc(s.label)}</span>`
      + '<svg viewBox="0 0 24 24" class="chev"><path d="m6 9 6 6 6-6"/></svg>'
      + '</button>'
      + `<div class="stage-bar">${segs}</div>`
      + '</div>'
    );
  }

  function docsCell(r) {
    const d = r.docs || {};
    return `<div class="docs">${DOCS.map(([k, label]) =>
      `<span class="doc${d[k] ? ' on' : ''}">${label}</span>`).join('')}</div>`;
  }

  function cellHTML(k, r, i) {
    switch (k) {
      case 'num':  return `<span class="rn">${i + 1}</span>`;
      case 'ref':  return r.file_number ? `<a class="enq-ref">${esc(r.file_number)}</a>` : '<span class="mt">—</span>';
      case 'when': {
        const t = fmtDate(r.occurred_at || r.created_at);
        return t ? `<div class="dt"><span class="dt-date">${esc(t.date)}</span><span class="dt-time">${esc(t.time)}</span></div>` : '<span class="mt">—</span>';
      }
      case 'owner': return `<span class="owner" title="${esc(r.owner_name || '')}"><span class="ava">${esc(initials(r.owner_name))}</span><svg viewBox="0 0 24 24" class="chev"><path d="m6 9 6 6 6-6"/></svg></span>`;
      case 'name': {
        if (!r.contact_name && !r.company_name) return '<span class="mt">—</span>';
        return `<div class="nm"><span class="nm-main">${esc(r.contact_name || r.company_name)}</span>${r.contact_name && r.company_name ? `<span class="nm-sub">${esc(r.company_name)}</span>` : ''}</div>`;
      }
      case 'phone':    return r.mobile ? `<span class="ph">${esc(r.mobile)}</span>` : '<span class="mt">—</span>';
      case 'location': return dash(r.site_location || [r.city, r.district, r.country].filter(Boolean).join(', '));
      case 'desc':     return dash(r.description);
      case 'stage':    return stageCell(r);
      case 'docs':     return docsCell(r);
      case 'followup': {
        const t = fmtDate(r.follow_up_date);
        return t ? `<span class="fu">${esc(t.date)} <b>!</b></span>` : '<span class="mt">—</span>';
      }
      default: return '';
    }
  }

  function renderHead() {
    $('thead').innerHTML = COLS.map(c => `<th style="width:${c.w}px">${esc(c.h)}</th>`).join('');
  }

  function visibleRows() {
    if (!searchTerm) return ROWS;
    return ROWS.filter(r => [
      r.file_number, r.contact_name, r.company_name, r.mobile,
      r.site_location, r.city, r.description, r.subject, normStage(r.stage), r.owner_name,
    ].some(v => String(v || '').toLowerCase().includes(searchTerm)));
  }

  function stateRow(text) {
    return `<tr><td class="empty" colspan="${COLS.length}">${esc(text)}</td></tr>`;
  }

  function renderRows() {
    closeStageMenu();
    const rows = visibleRows();
    const total = $('crm-total');
    if (total) total.textContent = `${ROWS.length} record${ROWS.length === 1 ? '' : 's'}`;
    const body = $('rows');
    if (!rows.length) { body.innerHTML = stateRow(searchTerm ? 'No records match your search.' : 'No CRM records yet.'); return; }
    body.innerHTML = rows.map((r, i) =>
      `<tr class="data">${COLS.map(c => `<td class="col-${c.k}">${cellHTML(c.k, r, i)}</td>`).join('')}</tr>`).join('');
  }

  async function load() {
    $('rows').innerHTML = stateRow('Loading…');
    try {
      const data = await request(`${API}/logs/`);
      ROWS = Array.isArray(data) ? data : [];
      renderRows();
    } catch (error) {
      $('rows').innerHTML = stateRow(`Couldn’t load records: ${error.message || 'error'}`);
    }
  }

  // ── Stage dropdown: change an enquiry's stage inline (PATCH /files/{id}) ─────
  let stageMenu = null;
  function closeStageMenu() { if (stageMenu) { stageMenu.remove(); stageMenu = null; } }

  async function setStage(fileId, key) {
    closeStageMenu();
    try {
      await request(`${API}/files/${encodeURIComponent(fileId)}`, { method: 'PATCH', body: { stage: key } });
      ROWS.forEach(r => { if (r.file_id === fileId) r.stage = key; });
      renderRows();
      showToast('Stage updated.');
    } catch (error) {
      showToast(error.message || 'Could not update stage.', true);
    }
  }

  function openStageMenu(cell) {
    closeStageMenu();
    const fileId = cell.dataset.file;
    const cur = cell.dataset.stage;
    const menu = document.createElement('div');
    menu.className = 'stage-menu';
    menu.innerHTML = STAGES.map(s =>
      `<button type="button" class="stage-opt${s.k === cur ? ' on' : ''}" data-stage="${s.k}"><span class="dot" style="background:${s.color}"></span>${esc(s.label)}</button>`).join('');
    document.body.appendChild(menu);
    const rect = cell.getBoundingClientRect();
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
    menu.style.left = `${rect.left + window.scrollX}px`;
    menu.addEventListener('click', e => {
      const opt = e.target.closest('.stage-opt');
      if (opt) setStage(fileId, opt.dataset.stage);
    });
    stageMenu = menu;
  }

  // ── New Prospect ───────────────────────────────────────────────────────────
  // Manual add. Posts to the SAME /logs/ endpoint the Log page uses, so the new
  // prospect is created as an enquiry (stage=enquiry) + its first log — showing
  // up in both the CRM table and the Log page, guaranteed.
  function openProspect() {
    const modal = $('prospect-modal');
    if (!modal) return;
    $('prospect-form').reset();
    $('prospect-error').textContent = '';
    modal.hidden = false;
    const first = $('prospect-form').elements.first_name;
    if (first) first.focus();
  }

  function closeProspect() {
    const modal = $('prospect-modal');
    if (modal) modal.hidden = true;
  }

  async function submitProspect(event) {
    event.preventDefault();
    const form = $('prospect-form');
    const val = name => (form.elements[name] ? form.elements[name].value.trim() : '');
    const first = val('first_name'), last = val('last_name'), company = val('company_name');
    if (!first && !last && !company) {
      $('prospect-error').textContent = 'Enter at least a name or a company.';
      return;
    }
    const payload = {
      person: {
        first_name: first || null,
        last_name: last || null,
        company_name: company || null,
        mobile: val('mobile') || null,
        email: val('email') || null,
        is_company: !first && !last && Boolean(company),
      },
      subject: val('subject'),
      category: val('category') || null,
      stage: 'enquiry',
      status: 'open',
      log_type: 'General',
      occurred_at: new Date().toISOString(),
    };
    const save = $('prospect-save');
    save.disabled = true;
    const label = save.textContent;
    save.textContent = 'Adding…';
    try {
      await request(`${API}/logs/`, { method: 'POST', body: payload });
      closeProspect();
      showToast('Prospect added.');
      await load();
    } catch (error) {
      $('prospect-error').textContent = error.message || 'Could not add prospect.';
    } finally {
      save.disabled = false;
      save.textContent = label;
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  renderHead();
  const search = $('crm-search');
  if (search) search.addEventListener('input', event => { searchTerm = event.target.value.trim().toLowerCase(); renderRows(); });
  const refresh = $('refresh-button');
  if (refresh) refresh.addEventListener('click', () => load().then(() => showToast('CRM refreshed.')));
  const newBtn = $('new-prospect-button');
  if (newBtn) newBtn.addEventListener('click', openProspect);
  const prospectClose = $('prospect-close');
  if (prospectClose) prospectClose.addEventListener('click', closeProspect);
  const prospectCancel = $('prospect-cancel');
  if (prospectCancel) prospectCancel.addEventListener('click', closeProspect);
  const prospectForm = $('prospect-form');
  if (prospectForm) prospectForm.addEventListener('submit', submitProspect);
  const prospectModal = $('prospect-modal');
  if (prospectModal) prospectModal.addEventListener('click', event => { if (event.target === prospectModal) closeProspect(); });

  // Stage dropdown opens on its button; a click anywhere else closes it.
  $('rows').addEventListener('click', event => {
    const btn = event.target.closest('.stage-btn');
    if (btn) { event.stopPropagation(); openStageMenu(btn.closest('.stage-cell')); }
  });
  document.addEventListener('click', () => closeStageMenu());
  window.addEventListener('resize', closeStageMenu);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeProspect(); closeStageMenu(); } });
  load();
})();
