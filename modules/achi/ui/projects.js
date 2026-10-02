/* Projects: the tech teams' projects and tasks, per company (Achi or ARARA).
 *
 * One task list, three views: Board (drag cards between status columns),
 * Table (grouped by status, status changed in place) and Gantt (simple weekly
 * bars). Tasks are assigned to HR employees of the selected company. The
 * company comes from the sidebar's dropdown (chrome.js), which reloads the page
 * when it changes.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = '/api/v1/achi';
  const COMPANIES = { achi: 'Achi Scaffolding', arara: 'ARARA' };
  const STATUSES = [
    { k: 'backlog', label: 'Backlog' }, { k: 'todo', label: 'To do' },
    { k: 'in_progress', label: 'In progress' }, { k: 'review', label: 'Review' }, { k: 'done', label: 'Done' },
  ];
  const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.k, s.label]));
  const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
  const COLORS = ['blue', 'teal', 'green', 'amber', 'red', 'purple', 'slate'];
  const VIEW_KEY = 'arara_projects_view';

  const company = (() => {
    try { if (typeof window.araraCompany === 'function') return window.araraCompany(); } catch (_) {}
    try { const c = localStorage.getItem('arara_company'); if (COMPANIES[c]) return c; } catch (_) {}
    return 'achi';
  })();

  const state = {
    projects: [], tasks: [], people: [], access: { can_write: false, can_manage: false },
    view: 'board', project: 'all', person: '', query: '',
    editingTask: null, editingProject: null, dragging: null,
  };
  try { const v = localStorage.getItem(VIEW_KEY); if (['board', 'table', 'gantt'].includes(v)) state.view = v; } catch (_) {}

  // ── helpers ───────────────────────────────────────────────────────────────
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
  const msg = text => { const n = $('pj-msg'); n.textContent = text || ''; n.hidden = !text; };
  const parseDay = s => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); })();
  const fmtDay = s => s ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(parseDay(s)) : '';
  const isLate = t => t.due_date && t.status !== 'done' && parseDay(t.due_date) < today;
  const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  const avatar = t => t.assignee_name
    ? `<span class="pj-av" title="${esc(t.assignee_name)}">${esc(initials(t.assignee_name))}</span>`
    : '<span class="pj-av none" title="Unassigned">–</span>';
  const pri = p => `<span class="pj-pri ${esc(p)}" title="${esc(PRIORITY_LABEL[p] || p)} priority"><i></i><i></i><i></i></span>`;
  const chip = t => `<span class="pj-chip" style="--c:var(--c-${esc(t.project_color)})" title="${esc(t.project_name)}">${esc(t.project_code)}</span>`;
  const due = t => t.due_date ? `<span class="pj-due${isLate(t) ? ' late' : ''}" title="${isLate(t) ? 'Overdue' : 'Due'}">${esc(fmtDay(t.due_date))}</span>` : '';
  const byOrder = (a, b) => (a.position - b.position) || (a.number - b.number);

  function visibleTasks() {
    const q = state.query;
    return state.tasks.filter(t => {
      if (state.project !== 'all' && t.project_id !== state.project) return false;
      if (state.person === 'none' && t.assignee_employee_id) return false;
      if (state.person && state.person !== 'none' && t.assignee_employee_id !== state.person) return false;
      if (q && ![t.title, t.code, t.description, t.assignee_name, t.project_name].some(v => String(v || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  // ── loading ───────────────────────────────────────────────────────────────
  async function load() {
    msg('');
    try {
      const [projects, tasks, people, access] = await Promise.all([
        api(`/projects/?company=${company}`),
        api(`/projects/tasks?company=${company}`),
        api(`/hr/employees?company=${company}`),
        api('/projects/me'),
      ]);
      Object.assign(state, { projects, tasks, people, access });
      if (state.project !== 'all' && !projects.some(p => p.id === state.project)) state.project = 'all';
    } catch (error) {
      msg(error.message || 'Could not load projects.');
    }
    render();
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function render() {
    $('pj-company-name').textContent = COMPANIES[company];
    $('pj-new-project').hidden = !state.access.can_write;
    $('pj-new-task').hidden = !state.access.can_write;
    document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
    renderPeopleFilter();
    renderSide();
    if (!state.projects.length) { renderNoProjects(); return; }
    if (state.view === 'table') renderTable();
    else if (state.view === 'gantt') renderGantt();
    else renderBoard();
  }

  function renderPeopleFilter() {
    const sel = $('pj-person');
    const current = state.person;
    sel.innerHTML = '<option value="">Everyone</option><option value="none">Unassigned</option>'
      + state.people.map(p => `<option value="${esc(p.id)}">${esc(p.full_name)}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === current) ? current : '';
  }

  function renderSide() {
    const all = state.tasks.length, allDone = state.tasks.filter(t => t.status === 'done').length;
    const row = (id, name, color, total, done, extra = '') => {
      const pct = total ? Math.round(done / total * 100) : 0;
      return `<div class="pj-proj${state.project === id ? ' is-on' : ''}" role="button" tabindex="0" data-project="${esc(id)}" style="--c:var(--c-${esc(color)})">
        <span class="dot"></span><span class="nm">${esc(name)}</span><span class="ct">${done}/${total}</span>
        <span class="bar" title="${pct}% done"><i style="width:${pct}%"></i></span>${extra}</div>`;
    };
    $('pj-project-list').innerHTML = state.projects.length
      ? row('all', 'All projects', 'slate', all, allDone)
        + state.projects.map(p => row(p.id, `${p.code} · ${p.name}`, p.color, p.task_count, p.done_count,
          state.access.can_write ? `<button class="edit" type="button" data-edit-project="${esc(p.id)}">Edit project</button>` : '')).join('')
      : '<p class="pj-side-empty">No projects yet.</p>';
  }

  function renderNoProjects() {
    $('pj-view').innerHTML = `<div class="pj-empty"><b>No projects yet for ${esc(COMPANIES[company])}</b>
      <span>Create a project, then add its tasks. Tasks are assigned to people from HR.</span>
      ${state.access.can_write ? '<button class="pj-primary" type="button" data-action="new-project">+ Create the first project</button>' : ''}</div>`;
  }

  function renderBoard() {
    const tasks = visibleTasks();
    const canDrag = state.access.can_write;
    $('pj-view').innerHTML = `<div class="pj-board">${STATUSES.map(s => {
      const list = tasks.filter(t => t.status === s.k).sort(byOrder);
      return `<section class="pj-col" data-status="${s.k}" aria-label="${esc(s.label)}">
        <div class="pj-col-head"><span class="pj-status" style="--s:var(--s-${s.k})">${esc(s.label)}</span><span class="n">${list.length}</span>
          ${canDrag ? `<button class="add" type="button" data-add-status="${s.k}" aria-label="Add a task to ${esc(s.label)}">+</button>` : ''}</div>
        ${list.map(t => `<button type="button" class="pj-card" data-task="${esc(t.id)}" draggable="${canDrag}">
          <span class="top"><span class="pj-code">${esc(t.code)}</span>${pri(t.priority)}</span>
          <span class="ttl">${esc(t.title)}</span>
          <span class="foot">${chip(t)}${due(t)}${avatar(t)}</span></button>`).join('')}
      </section>`;
    }).join('')}</div>`;
  }

  function renderTable() {
    const tasks = visibleTasks();
    const canEdit = state.access.can_write;
    let rows = '';
    STATUSES.forEach(s => {
      const list = tasks.filter(t => t.status === s.k).sort(byOrder);
      if (!list.length) return;
      rows += `<tr class="grp"><td colspan="8"><span class="pj-status" style="--s:var(--s-${s.k})">${esc(s.label)}</span><span class="n">${list.length}</span></td></tr>`;
      rows += list.map(t => `<tr class="row" data-task="${esc(t.id)}">
        <td><span class="pj-code">${esc(t.code)}</span></td>
        <td class="ttl">${esc(t.title)}</td>
        <td>${chip(t)}</td>
        <td><span class="pj-who">${pri(t.priority)} ${esc(PRIORITY_LABEL[t.priority])}</span></td>
        <td><span class="pj-who">${avatar(t)} ${esc(t.assignee_name || 'Unassigned')}</span></td>
        <td><span class="pj-due">${esc(fmtDay(t.start_date))}</span></td>
        <td>${due(t)}</td>
        <td>${canEdit
          ? `<select data-status-of="${esc(t.id)}" aria-label="Status of ${esc(t.code)}">${STATUSES.map(o => `<option value="${o.k}"${o.k === t.status ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
          : esc(STATUS_LABEL[t.status])}</td></tr>`).join('');
    });
    $('pj-view').innerHTML = rows
      ? `<div class="pj-table-wrap"><table class="pj-table"><thead><tr><th>Code</th><th>Task</th><th>Project</th><th>Priority</th><th>Assignee</th><th>Start</th><th>Due</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="pj-empty"><b>No tasks match</b><span>Change the filters, or add a task.</span></div>';
  }

  function renderGantt() {
    const tasks = visibleTasks();
    const projects = state.projects.filter(p => state.project === 'all' || p.id === state.project);
    const dates = [today];
    projects.forEach(p => [p.start_date, p.end_date].forEach(d => d && dates.push(parseDay(d))));
    tasks.forEach(t => [t.start_date, t.due_date].forEach(d => d && dates.push(parseDay(d))));
    const min = new Date(Math.min(...dates)), max = new Date(Math.max(...dates, today.getTime() + 28 * 864e5));
    const start = new Date(min); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));   // Monday
    const weeks = Math.min(52, Math.max(6, Math.ceil(((max - start) / 864e5 + 1) / 7)));
    const totalDays = weeks * 7;
    const pct = d => Math.max(0, Math.min(100, ((d - start) / 864e5) / totalDays * 100));
    const span = (a, b) => { const s = parseDay(a || b), e = parseDay(b || a); return { left: pct(s), width: Math.max(pct(new Date(e.getTime() + 864e5)) - pct(s), 0.6) }; };
    const todayLine = `<span class="pj-g-today" style="left:${pct(today)}%" aria-hidden="true"></span>`;
    const weekLabel = i => { const d = new Date(start); d.setDate(d.getDate() + i * 7); return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(d); };
    let html = `<div class="pj-g" style="--wk:calc(100% / ${weeks})">
      <div class="pj-g-corner">Project / task</div>
      <div class="pj-g-weeks" style="grid-template-columns:repeat(${weeks},1fr)">${Array.from({ length: weeks }, (_, i) => `<span>${esc(weekLabel(i))}</span>`).join('')}</div>`;
    let any = false;
    projects.forEach(p => {
      const own = tasks.filter(t => t.project_id === p.id).sort((a, b) => (a.start_date || a.due_date || '9').localeCompare(b.start_date || b.due_date || '9') || a.number - b.number);
      if (!own.length && (state.person || state.query)) return;
      any = true;
      const taskDays = own.flatMap(t => [t.start_date, t.due_date]).filter(Boolean).sort();
      const pStart = p.start_date || taskDays[0], pEnd = p.end_date || taskDays[taskDays.length - 1];
      html += `<div class="pj-g-label proj"><span class="pj-chip" style="--c:var(--c-${esc(p.color)})">${esc(p.code)}</span><span class="ttl">${esc(p.name)}</span></div>
        <div class="pj-g-track">${todayLine}${pStart ? (() => { const s = span(pStart, pEnd); return `<span class="pj-g-bar proj" style="--c:var(--c-${esc(p.color)});left:${s.left}%;width:${s.width}%" title="${esc(p.name)}"></span>`; })() : ''}</div>`;
      own.forEach(t => {
        const dated = t.start_date || t.due_date;
        const s = dated ? span(t.start_date, t.due_date) : null;
        html += `<div class="pj-g-label task" data-task="${esc(t.id)}"><span class="pj-code">${esc(t.code)}</span><span class="ttl">${esc(t.title)}</span></div>
          <div class="pj-g-track">${todayLine}${s
            ? `<span class="pj-g-bar${t.status === 'done' ? ' done' : ''}" data-task="${esc(t.id)}" style="--c:var(--s-${esc(t.status)});left:${s.left}%;width:${s.width}%" title="${esc(t.code)} · ${esc(STATUS_LABEL[t.status])}${t.assignee_name ? ' · ' + esc(t.assignee_name) : ''}">${s.width >= 6 && t.assignee_name ? esc(t.assignee_name.split(' ')[0]) : ''}</span>`
            : '<span class="pj-g-nodate">No dates yet</span>'}</div>`;
      });
    });
    $('pj-view').innerHTML = any ? `<div class="pj-gantt">${html}</div></div>` : '<div class="pj-empty"><b>Nothing to show</b><span>No tasks match the filters.</span></div>';
  }

  // ── task dialog ───────────────────────────────────────────────────────────
  function fillSelect(sel, options, value) {
    sel.innerHTML = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
    sel.value = value ?? '';
  }
  function setReadOnly(form, readOnly) {
    form.querySelectorAll('input,select,textarea').forEach(el => { el.disabled = readOnly; });
  }
  function formError(id, text) { const n = $(id); n.textContent = text || ''; n.hidden = !text; }

  function openTask(task, preset = {}) {
    state.editingTask = task || null;
    const t = task || {};
    $('pj-task-code').textContent = task ? `${task.code} · ${task.project_code}` : 'NEW TASK';
    $('pj-task-title').textContent = task ? 'Edit task' : 'New task';
    $('pj-t-title').value = t.title || '';
    const projectId = t.project_id || preset.project_id || (state.project !== 'all' ? state.project : (state.projects[0] || {}).id);
    fillSelect($('pj-t-project'), state.projects.map(p => [p.id, `${p.code} · ${p.name}`]), projectId);
    const people = state.people.slice();
    if (t.assignee_employee_id && !people.some(p => p.id === t.assignee_employee_id)) people.push({ id: t.assignee_employee_id, full_name: t.assignee_name || 'Former employee' });
    fillSelect($('pj-t-assignee'), [['', 'Unassigned'], ...people.map(p => [p.id, p.full_name])], t.assignee_employee_id || preset.assignee || '');
    $('pj-t-status').value = t.status || preset.status || 'todo';
    $('pj-t-priority').value = t.priority || 'normal';
    $('pj-t-start').value = t.start_date || '';
    $('pj-t-due').value = t.due_date || '';
    $('pj-t-desc').value = t.description || '';
    formError('pj-t-error', '');
    const canWrite = state.access.can_write;
    setReadOnly($('pj-task-form'), !canWrite);
    $('pj-t-save').hidden = !canWrite;
    $('pj-t-delete').hidden = !(task && canWrite);
    $('pj-task-dialog').showModal();
    if (canWrite) $('pj-t-title').focus();
  }

  async function saveTask(event) {
    event.preventDefault();
    const body = {
      title: $('pj-t-title').value.trim(), project_id: $('pj-t-project').value,
      assignee_employee_id: $('pj-t-assignee').value || null, status: $('pj-t-status').value,
      priority: $('pj-t-priority').value, start_date: $('pj-t-start').value || null,
      due_date: $('pj-t-due').value || null, description: $('pj-t-desc').value,
    };
    if (!body.title) { formError('pj-t-error', 'Give the task a title.'); return; }
    if (body.start_date && body.due_date && body.due_date < body.start_date) { formError('pj-t-error', 'The due date cannot be before the start date.'); return; }
    try {
      if (state.editingTask) await api(`/projects/tasks/${state.editingTask.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/projects/tasks', { method: 'POST', body: JSON.stringify({ ...body, company }) });
      $('pj-task-dialog').close();
      await load();
    } catch (error) { formError('pj-t-error', error.message); }
  }

  async function deleteTask() {
    const t = state.editingTask;
    if (!t || !window.confirm(`Delete ${t.code} "${t.title}"?`)) return;
    try { await api(`/projects/tasks/${t.id}`, { method: 'DELETE' }); $('pj-task-dialog').close(); await load(); }
    catch (error) { formError('pj-t-error', error.message); }
  }

  // ── project dialog ────────────────────────────────────────────────────────
  function openProject(project) {
    state.editingProject = project || null;
    const p = project || {};
    $('pj-project-code').textContent = project ? project.code : 'NEW PROJECT';
    $('pj-project-title').textContent = project ? 'Edit project' : 'New project';
    $('pj-p-name').value = p.name || '';
    const color = p.color || COLORS[state.projects.length % COLORS.length];
    $('pj-p-colors').innerHTML = COLORS.map(c => `<label class="pj-swatch" title="${c}"><input type="radio" name="pj-color" value="${c}"${c === color ? ' checked' : ''}><span style="--c:var(--c-${c})"></span><span class="sr-only">${c}</span></label>`).join('');
    $('pj-p-status').value = p.status || 'active';
    fillSelect($('pj-p-lead'), [['', 'No lead'], ...state.people.map(x => [x.id, x.full_name])], p.lead_employee_id || '');
    $('pj-p-start').value = p.start_date || '';
    $('pj-p-end').value = p.end_date || '';
    $('pj-p-desc').value = p.description || '';
    formError('pj-p-error', '');
    $('pj-p-delete').hidden = !(project && state.access.can_manage);
    $('pj-project-dialog').showModal();
    $('pj-p-name').focus();
  }

  async function saveProject(event) {
    event.preventDefault();
    const body = {
      name: $('pj-p-name').value.trim(), color: (document.querySelector('input[name="pj-color"]:checked') || {}).value || 'blue',
      status: $('pj-p-status').value, lead_employee_id: $('pj-p-lead').value || null,
      start_date: $('pj-p-start').value || null, end_date: $('pj-p-end').value || null, description: $('pj-p-desc').value,
    };
    if (!body.name) { formError('pj-p-error', 'Give the project a name.'); return; }
    if (body.start_date && body.end_date && body.end_date < body.start_date) { formError('pj-p-error', 'The end date cannot be before the start date.'); return; }
    try {
      if (state.editingProject) await api(`/projects/${state.editingProject.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else {
        const made = await api('/projects/', { method: 'POST', body: JSON.stringify({ ...body, company }) });
        state.project = made.id;
      }
      $('pj-project-dialog').close();
      await load();
    } catch (error) { formError('pj-p-error', error.message); }
  }

  async function deleteProject() {
    const p = state.editingProject;
    if (!p || !window.confirm(`Delete ${p.code} "${p.name}" and its ${p.task_count} task${p.task_count === 1 ? '' : 's'}?`)) return;
    try { await api(`/projects/${p.id}`, { method: 'DELETE' }); state.project = 'all'; $('pj-project-dialog').close(); await load(); }
    catch (error) { formError('pj-p-error', error.message); }
  }

  // ── board drag and drop ───────────────────────────────────────────────────
  function dropSlot(col, y) {
    const cards = [...col.querySelectorAll('.pj-card:not(.is-dragging)')];
    const index = cards.findIndex(card => { const r = card.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return { cards, index: index < 0 ? cards.length : index };
  }
  function clearDropMarks() {
    document.querySelectorAll('.pj-drop-mark').forEach(n => n.remove());
    document.querySelectorAll('.pj-col.is-over').forEach(n => n.classList.remove('is-over'));
  }

  document.addEventListener('dragstart', event => {
    const card = event.target.closest('.pj-card[draggable="true"]');
    if (!card) return;
    state.dragging = state.tasks.find(t => t.id === card.dataset.task) || null;
    card.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.task);
  });
  document.addEventListener('dragover', event => {
    const col = event.target.closest('.pj-col');
    if (!col || !state.dragging) return;
    event.preventDefault();
    clearDropMarks();
    col.classList.add('is-over');
    const { cards, index } = dropSlot(col, event.clientY);
    const mark = document.createElement('div'); mark.className = 'pj-drop-mark';
    if (cards[index]) col.insertBefore(mark, cards[index]); else col.appendChild(mark);
  });
  document.addEventListener('drop', async event => {
    const col = event.target.closest('.pj-col');
    const task = state.dragging;
    if (!col || !task) return;
    event.preventDefault();
    const { cards, index } = dropSlot(col, event.clientY);
    clearDropMarks();
    const ordered = cards.map(c => state.tasks.find(t => t.id === c.dataset.task)).filter(Boolean);
    const prev = ordered[index - 1], next = ordered[index];
    const position = prev && next ? (prev.position + next.position) / 2 : prev ? prev.position + 1 : next ? next.position - 1 : 1;
    const status = col.dataset.status;
    Object.assign(task, { status, position });   // optimistic: the card lands now
    renderBoard();
    try { await api(`/projects/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status, position }) }); await load(); }
    catch (error) { msg(error.message); await load(); }
  });
  document.addEventListener('dragend', () => {
    clearDropMarks();
    document.querySelectorAll('.pj-card.is-dragging').forEach(n => n.classList.remove('is-dragging'));
    state.dragging = null;
  });

  // ── events ────────────────────────────────────────────────────────────────
  document.addEventListener('click', event => {
    const closer = event.target.closest('[data-close]');
    if (closer) { closer.closest('dialog').close(); return; }
    const edit = event.target.closest('[data-edit-project]');
    if (edit) { openProject(state.projects.find(p => p.id === edit.dataset.editProject)); return; }
    const proj = event.target.closest('[data-project]');
    if (proj) { state.project = proj.dataset.project; render(); return; }
    if (event.target.closest('[data-action="new-project"]')) { openProject(null); return; }
    const add = event.target.closest('[data-add-status]');
    if (add) { openTask(null, { status: add.dataset.addStatus }); return; }
    const view = event.target.closest('[data-view]');
    if (view) { state.view = view.dataset.view; try { localStorage.setItem(VIEW_KEY, state.view); } catch (_) {} render(); return; }
    if (event.target.closest('select')) return;
    const item = event.target.closest('[data-task]');
    if (item) openTask(state.tasks.find(t => t.id === item.dataset.task));
  });
  document.addEventListener('keydown', event => {
    const proj = event.target.closest && event.target.closest('.pj-proj[data-project]');
    if (proj && (event.key === 'Enter' || event.key === ' ') && !event.target.closest('button')) { event.preventDefault(); state.project = proj.dataset.project; render(); }
  });
  document.addEventListener('change', async event => {
    const sel = event.target.closest('[data-status-of]');
    if (!sel) return;
    try { await api(`/projects/tasks/${sel.dataset.statusOf}`, { method: 'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); }
    catch (error) { msg(error.message); await load(); }
  });
  $('pj-person').addEventListener('change', e => { state.person = e.target.value; render(); });
  $('pj-search').addEventListener('input', e => { state.query = e.target.value.trim().toLowerCase(); render(); });
  $('pj-new-task').addEventListener('click', () => {
    if (!state.projects.length) { openProject(null); return; }
    openTask(null);
  });
  $('pj-new-project').addEventListener('click', () => openProject(null));
  $('pj-task-form').addEventListener('submit', saveTask);
  $('pj-project-form').addEventListener('submit', saveProject);
  $('pj-t-delete').addEventListener('click', deleteTask);
  $('pj-p-delete').addEventListener('click', deleteProject);

  load();
})();
