/* HR: employees of the company picked in the sidebar (Achi Scaffolding or
 * ARARA). Everyone can read the list; managers and admins can change it.
 * Projects (projects.js) assigns tasks to these people.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = '/api/v1/achi';
  const COMPANIES = { achi: 'Achi Scaffolding', arara: 'ARARA' };
  const company = (() => {
    try { if (typeof window.araraCompany === 'function') return window.araraCompany(); } catch (_) {}
    try { const c = localStorage.getItem('arara_company'); if (COMPANIES[c]) return c; } catch (_) {}
    return 'achi';
  })();
  const state = { people: [], users: [], canManage: false, query: '', inactive: false, editing: null };

  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const token = () => { try { return localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token') || ''; } catch (_) { return ''; } };
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const t = token(); if (t) headers.set('Authorization', `Bearer ${t}`);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(API + path, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const d = data.detail;
      throw new Error(Array.isArray(d) ? d.map(x => x.msg).join(' ') : (d || `Request failed (${response.status})`));
    }
    return data;
  }
  const msg = text => { const n = $('hr-msg'); n.textContent = text || ''; n.hidden = !text; };
  const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  const formError = text => { const n = $('hr-error'); n.textContent = text || ''; n.hidden = !text; };

  async function load() {
    msg('');
    try {
      const [people, me] = await Promise.all([
        api(`/hr/employees?company=${company}&include_inactive=${state.inactive}`),
        api('/hr/me'),
      ]);
      state.people = people; state.canManage = !!me.can_manage;
      if (state.canManage && !state.users.length) state.users = await api('/hr/users').catch(() => []);
    } catch (error) { msg(error.message || 'Could not load employees.'); }
    render();
  }

  function render() {
    $('hr-company-name').textContent = COMPANIES[company];
    $('hr-company-sub').textContent = COMPANIES[company];
    $('hr-new').hidden = !state.canManage;
    const q = state.query;
    const rows = state.people.filter(p => !q || [p.full_name, p.job_title, p.team, p.email].some(v => String(v || '').toLowerCase().includes(q)));
    $('hr-teams').innerHTML = [...new Set(state.people.map(p => p.team).filter(Boolean))].map(t => `<option value="${esc(t)}">`).join('');
    if (!state.people.length) {
      $('hr-view').innerHTML = `<div class="pj-empty"><b>No employees yet for ${esc(COMPANIES[company])}</b>
        <span>Add the people of this company so Projects can assign them tasks.</span>
        ${state.canManage ? '<button class="pj-primary" type="button" data-action="new">+ Add the first employee</button>' : ''}</div>`;
      return;
    }
    $('hr-view').innerHTML = rows.length ? `<div class="pj-table-wrap"><table class="pj-table hr-table">
      <thead><tr><th>Name</th><th>Job title</th><th>Team</th><th>Email</th><th>Phone</th><th>Login account</th><th>Open tasks</th><th>Status</th></tr></thead>
      <tbody>${rows.map(p => `<tr class="row" data-employee="${esc(p.id)}">
        <td><span class="pj-who"><span class="pj-av">${esc(initials(p.full_name))}</span><b>${esc(p.full_name)}</b></span></td>
        <td>${esc(p.job_title) || '<span class="muted">—</span>'}</td>
        <td>${esc(p.team) || '<span class="muted">—</span>'}</td>
        <td>${esc(p.email) || '<span class="muted">—</span>'}</td>
        <td>${esc(p.phone) || '<span class="muted">—</span>'}</td>
        <td>${esc(p.user_name) || '<span class="muted">Not linked</span>'}</td>
        <td style="font-variant-numeric:tabular-nums">${p.open_tasks}</td>
        <td><span class="hr-badge${p.active ? '' : ' off'}">${p.active ? 'Active' : 'Inactive'}</span></td>
      </tr>`).join('')}</tbody></table></div>`
      : '<div class="pj-empty"><b>No one matches</b><span>Try another search.</span></div>';
  }

  function open(person) {
    state.editing = person || null;
    const p = person || {};
    $('hr-dialog-company').textContent = COMPANIES[company].toUpperCase();
    $('hr-dialog-title').textContent = person ? person.full_name : 'New employee';
    $('hr-name').value = p.full_name || '';
    $('hr-title').value = p.job_title || '';
    $('hr-team').value = p.team || '';
    $('hr-email').value = p.email || '';
    $('hr-phone').value = p.phone || '';
    $('hr-notes').value = p.notes || '';
    $('hr-active').value = p.active === false ? '0' : '1';
    const users = state.users.slice();
    if (p.user_id && !users.some(u => u.user_id === p.user_id)) users.push({ user_id: p.user_id, name: p.user_name || 'Linked account' });
    $('hr-user').innerHTML = '<option value="">Not linked</option>' + users.map(u => `<option value="${esc(u.user_id)}">${esc(u.name)}${u.email ? ' · ' + esc(u.email) : ''}</option>`).join('');
    $('hr-user').value = p.user_id || '';
    formError('');
    $('hr-form').querySelectorAll('input,select,textarea').forEach(el => { el.disabled = !state.canManage; });
    $('hr-save').hidden = !state.canManage;
    $('hr-delete').hidden = !(person && state.canManage);
    $('hr-dialog').showModal();
  }

  async function save(event) {
    event.preventDefault();
    const body = {
      full_name: $('hr-name').value.trim(), job_title: $('hr-title').value.trim(), team: $('hr-team').value.trim(),
      email: $('hr-email').value.trim(), phone: $('hr-phone').value.trim(), notes: $('hr-notes').value,
      user_id: $('hr-user').value || null, active: $('hr-active').value === '1',
    };
    if (!body.full_name) { formError('Enter the person\'s full name.'); return; }
    try {
      if (state.editing) await api(`/hr/employees/${state.editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/hr/employees', { method: 'POST', body: JSON.stringify({ ...body, company }) });
      $('hr-dialog').close();
      await load();
    } catch (error) { formError(error.message); }
  }

  async function remove() {
    const p = state.editing;
    if (!p || !window.confirm(`Delete ${p.full_name} from HR?`)) return;
    try { await api(`/hr/employees/${p.id}`, { method: 'DELETE' }); $('hr-dialog').close(); await load(); }
    catch (error) { formError(error.message); }
  }

  document.addEventListener('click', event => {
    const closer = event.target.closest('[data-close]');
    if (closer) { closer.closest('dialog').close(); return; }
    if (event.target.closest('[data-action="new"]')) { open(null); return; }
    const row = event.target.closest('[data-employee]');
    if (row) open(state.people.find(p => p.id === row.dataset.employee));
  });
  $('hr-new').addEventListener('click', () => open(null));
  $('hr-search').addEventListener('input', e => { state.query = e.target.value.trim().toLowerCase(); render(); });
  $('hr-inactive').addEventListener('change', e => { state.inactive = e.target.checked; load(); });
  $('hr-form').addEventListener('submit', save);
  $('hr-delete').addEventListener('click', remove);
  load();
})();
