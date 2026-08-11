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

  // ── Table ────────────────────────────────────────────────────────────────
  // Each row is an enquiry log; the CRM view shows a fixed subset of columns.
  // Status is the enquiry STAGE (prospect → lead → …), which is ACHI's own CRM
  // pipeline — not the open/closed `status`.
  const COLS = [
    { k: 'ref',      h: 'Ref',         w: 90 },
    { k: 'when',     h: 'Date / Time', w: 150 },
    { k: 'category', h: 'Category',    w: 150 },
    { k: 'contact',  h: 'Contact',     w: 170 },
    { k: 'company',  h: 'Company',     w: 170 },
    { k: 'type',     h: 'Log Type',    w: 130 },
    { k: 'subject',  h: 'Subject',     w: 240 },
    { k: 'assigned', h: 'Assigned',    w: 140 },
    { k: 'status',   h: 'Status',      w: 130 },
  ];

  let ROWS = [];
  let searchTerm = '';

  const dash = v => (v != null && String(v).trim() ? esc(v) : '<span class="mt">—</span>');
  const pretty = v => (v ? String(v).replace(/_/g, ' ') : '');

  function fmtDateTime(v) {
    if (!v) return '<span class="mt">—</span>';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return dash(v);
    const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `<span class="dt">${esc(date)}<span class="mt"> · ${esc(time)}</span></span>`;
  }

  // Status = the enquiry stage, shown as the Log page's pill badge
  // (b-prospect / b-lead / …).
  function badge(s) {
    if (!s) return '<span class="mt">—</span>';
    const cls = 'b-' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return `<span class="badge ${cls}">${esc(pretty(s))}</span>`;
  }

  function cellHTML(k, r) {
    switch (k) {
      case 'ref':      return dash(r.reference);
      case 'when':     return fmtDateTime(r.occurred_at || r.created_at);
      case 'category': return dash(pretty(r.category));
      case 'contact':  return r.contact_name ? `<span class="name">${esc(r.contact_name)}</span>` : '<span class="mt">—</span>';
      case 'company':  return dash(r.company_name);
      case 'type':     return dash(pretty(r.log_type));
      case 'subject':  return dash(r.subject);
      case 'assigned': return dash(r.assigned_name || r.assigned);
      case 'status':   return badge(r.stage);
      default:         return '';
    }
  }

  function renderHead() {
    $('thead').innerHTML = COLS.map(c => `<th>${esc(c.h)}</th>`).join('');
  }

  function visibleRows() {
    if (!searchTerm) return ROWS;
    return ROWS.filter(r => [
      r.reference, r.category, r.contact_name, r.company_name,
      r.log_type, r.subject, r.assigned_name, r.stage,
    ].some(v => String(v || '').toLowerCase().includes(searchTerm)));
  }

  function stateRow(text) {
    return `<tr><td class="empty" colspan="${COLS.length}">${esc(text)}</td></tr>`;
  }

  function renderRows() {
    const rows = visibleRows();
    const total = $('crm-total');
    if (total) total.textContent = `${ROWS.length} record${ROWS.length === 1 ? '' : 's'}`;
    const body = $('rows');
    if (!rows.length) { body.innerHTML = stateRow(searchTerm ? 'No records match your search.' : 'No CRM records yet.'); return; }
    body.innerHTML = rows.map(r =>
      `<tr class="data">${COLS.map(c => `<td class="${c.k === 'subject' ? 'wide' : ''}">${cellHTML(c.k, r)}</td>`).join('')}</tr>`,
    ).join('');
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

  // ── New Prospect ───────────────────────────────────────────────────────────
  // Manual add. Posts to the SAME /logs/ endpoint the Log page uses, so the new
  // prospect is created as an enquiry (stage=prospect) + its first log — which
  // means it shows up in both the CRM table and the Log page, guaranteed.
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
      stage: 'prospect',
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
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeProspect(); });
  load();
})();
