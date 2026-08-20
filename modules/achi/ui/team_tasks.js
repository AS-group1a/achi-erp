(function () {
  'use strict';

  const API = '/api/v1/achi/tasks';
  const PAGE_SIZE = 200;

  const $ = id => document.getElementById(id);

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  };

  const STATUS_LABELS = {
    unassigned: 'Unassigned',
    to_do: 'To Do',
    in_progress: 'In Progress',
    blocked: 'Blocked',
    ready_for_review: 'Ready for Review',
    completed: 'Done',
    cancelled: 'Cancelled',
  };

  const PRIORITY_LABELS = {
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    urgent: 'Urgent',
  };

  const TASK_TYPE_LABELS = {
    task: 'Task',
    feature: 'Feature',
    issue: 'Issue',
    bug: 'Bug',
    chore: 'Chore',
  };

  const COLUMN_STATUSES = {
    unassigned: ['unassigned'],
    'to-do': ['to_do'],
    'in-progress': ['in_progress'],
    blocked: ['blocked'],
    'ready-for-review': ['ready_for_review'],
    done: ['completed'],
  };

  const BOARD_MOVE_TARGETS = {
    to_do: ['in_progress', 'blocked'],
    in_progress: ['to_do', 'blocked', 'ready_for_review'],
    blocked: ['in_progress'],
    ready_for_review: ['in_progress'],
    completed: ['ready_for_review', 'in_progress'],
  };

  const TASK_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
  const TASK_ATTACHMENT_ALLOWED_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'webp',
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
  ]);

  const state = {
    access: null,
    assignees: [],
    tasks: [],
    total: 0,
    offset: 0,
    requestVersion: 0,
    currentTaskId: null,
    currentTask: null,
    actionTaskId: null,
    actionName: null,
    dialogTrigger: null,
    searchTimer: null,
    toastTimer: null,
    dragTaskId: null,
    dragAllowedStatuses: [],
    movingTaskId: null,
    suppressCardClickUntil: 0,
    actionOpenTaskAfterSave: true,
    actionTargetStatus: null,
    pendingAttachments: [],
    currentAttachments: [],
  };

  function isJwt(value) {
    return typeof value === 'string' &&
      /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value);
  }

  function jwtPayload(token) {
    try {
      let payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (payload.length % 4) payload += '=';
      return JSON.parse(atob(payload));
    } catch (_error) {
      return null;
    }
  }

  function isAccessJwt(value) {
    const payload = jwtPayload(value);
    return isJwt(value) && (!payload || payload.type !== 'refresh');
  }

  function scanStorage() {
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const value = storage.getItem(storage.key(index));

        if (isAccessJwt(value)) return value;

        if (!value || value[0] !== '{') continue;

        try {
          const parsed = JSON.parse(value);
          const candidates = [
            parsed.access_token,
            parsed.token,
            parsed.state && parsed.state.access_token,
            parsed.state && parsed.state.token,
          ];

          for (const candidate of candidates) {
            if (isAccessJwt(candidate)) return candidate;
          }
        } catch (_error) {
          /* Ignore unrelated browser storage. */
        }
      }
    }

    return null;
  }

  function getAccessToken() {
    try {
      const direct = localStorage.getItem('oe_access_token') ||
        sessionStorage.getItem('oe_access_token');

      return isAccessJwt(direct) ? direct : scanStorage();
    } catch (_error) {
      return null;
    }
  }

  function errorMessage(body, fallback) {
    if (Array.isArray(body && body.detail)) {
      return body.detail
        .map(item => item.msg || item.message || String(item))
        .join('; ');
    }

    return (body && body.detail) || fallback;
  }

  async function request(path, options = {}) {
    const token = getAccessToken();

    if (!token) {
      const error = new Error(
        'Your session is missing or expired. Open the main app, sign in, then reload this page.',
      );
      error.status = 401;
      throw error;
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    };

    const init = { ...options, headers };

    if (
      init.body &&
      typeof init.body !== 'string' &&
      !(init.body instanceof FormData)
    ) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }

    const response = await fetch(`${API}${path}`, init);

    if (response.status === 204) return null;

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(
        errorMessage(body, `Request failed (${response.status}).`),
      );
      error.status = response.status;
      throw error;
    }

    return body;
  }

  function formatDate(value) {
    if (!value) return '—';

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';

    return date.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function dateForInput(value) {
    if (!value) return '';

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const part = number => String(number).padStart(2, '0');

    return [
      date.getFullYear(),
      '-',
      part(date.getMonth() + 1),
      '-',
      part(date.getDate()),
      'T',
      part(date.getHours()),
      ':',
      part(date.getMinutes()),
    ].join('');
  }

  function dateFromInput(value) {
    if (!value) return null;

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error('Enter a valid due date and time.');
    }

    return date.toISOString();
  }

  function isOverdue(task) {
    if (!task.due_at) return false;
    if (['completed', 'cancelled'].includes(task.status)) return false;
    return new Date(task.due_at).getTime() < Date.now();
  }

  function showToast(message, type = '') {
    const toast = $('achi-task-toast');

    window.clearTimeout(state.toastTimer);
    toast.textContent = message;
    toast.className = `achi-task-toast${type ? ` is-${type}` : ''}`;
    toast.hidden = false;

    state.toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 3600);
  }

  function setPageError(message) {
    $('achi-task-page-error-message').textContent = message;
    $('achi-task-page-error').hidden = false;
    $('achi-task-loading').hidden = true;
    $('achi-task-content').hidden = true;
    $('achi-task-header-actions').hidden = true;
  }

  function clearPageError() {
    $('achi-task-page-error').hidden = true;
  }

  function showDialog(dialog, trigger, focusId) {
    state.dialogTrigger = trigger || document.activeElement;

    if (!dialog.open) dialog.showModal();

    const focusTarget = focusId ? $(focusId) : null;

    window.setTimeout(() => {
      if (focusTarget) focusTarget.focus();
    }, 0);
  }

  function closeDialog(dialog) {
    if (dialog.open) dialog.close();

    const trigger = state.dialogTrigger;
    state.dialogTrigger = null;

    if (trigger && typeof trigger.focus === 'function') {
      trigger.focus();
    }
  }

  function closeAllDialogs() {
    [
      $('achi-task-work-request-dialog'),
      $('achi-task-editor-dialog'),
      $('achi-task-detail-dialog'),
      $('achi-task-action-dialog'),
    ].forEach(dialog => {
      if (dialog.open) dialog.close();
    });
  }

  function setButtonBusy(button, busy, busyText) {
    if (!button) return;

    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText || 'Saving…';
      button.disabled = true;
      return;
    }

    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }

    button.disabled = false;
  }

  function activeFilters() {
    const assignee = $('achi-task-filter-assignee').value;

    return {
      search: $('achi-task-filter-search').value.trim(),
      assignee,
      priority: $('achi-task-filter-priority').value,
      status: $('achi-task-filter-status').value,
      overdue: $('achi-task-filter-overdue').checked,
    };
  }

  function taskQuery() {
    const filters = activeFilters();
    const params = new URLSearchParams({
      offset: String(state.offset),
      limit: String(PAGE_SIZE),
    });

    const statuses = filters.status === 'active'
      ? [
        'unassigned',
        'to_do',
        'in_progress',
        'blocked',
        'ready_for_review',
        'completed',
      ]
      : filters.status
        ? [filters.status]
        : [];

    statuses.forEach(status => params.append('status', status));

    if (filters.search) params.set('search', filters.search);
    if (filters.priority) params.append('priority', filters.priority);
    if (filters.overdue) params.set('overdue_only', 'true');

    if (filters.assignee === '__unassigned__') {
      params.set('unassigned_only', 'true');
    } else if (filters.assignee) {
      params.set('assigned_to_user_id', filters.assignee);
    }

    return params.toString();
  }

  function renderAssignees() {
    const filter = $('achi-task-filter-assignee');
    const editor = $('achi-task-editor-assignee');

    const selectedFilter = filter.value;
    const selectedEditor = editor.value;

    filter.replaceChildren(
      new Option('All assignees', ''),
      new Option('Unassigned', '__unassigned__'),
    );

    editor.replaceChildren(new Option('Unassigned', ''));

    state.assignees.forEach(user => {
      const label = `${user.display_name} (${user.role})`;

      filter.add(new Option(label, user.user_id));
      editor.add(new Option(label, user.user_id));
    });

    filter.value = [...filter.options].some(option => option.value === selectedFilter)
      ? selectedFilter
      : '';

    editor.value = [...editor.options].some(option => option.value === selectedEditor)
      ? selectedEditor
      : '';
  }

  function emptyColumn(message) {
    return el('p', 'achi-task-empty-state', message);
  }

  function taskMoveTransitions(task) {
    const transitions = {};
    const access = state.access || {};
    const ownsTask = task.assigned_to_user_id === access.user_id;

    if (access.can_progress_tasks && ownsTask) {
      if (task.status === 'to_do') {
        transitions.in_progress = {
          path: `/${task.id}/progress`,
          method: 'PATCH',
          body: { action: 'start' },
        };
        transitions.blocked = { dialog: 'block' };
      } else if (task.status === 'in_progress') {
        transitions.blocked = { dialog: 'block' };
        transitions.ready_for_review = {
          path: `/${task.id}/progress`,
          method: 'PATCH',
          body: { action: 'submit', note: '' },
        };
      } else if (task.status === 'blocked') {
        transitions.in_progress = {
          path: `/${task.id}/progress`,
          method: 'PATCH',
          body: { action: 'resume' },
        };
      }
    }

    if (access.can_manage_team) {
      if (task.status === 'ready_for_review') {
        transitions.in_progress = { dialog: 'return' };
        transitions.completed = {
          path: `/${task.id}/approve`,
          method: 'POST',
          body: { note: '' },
        };
      } else if (task.status === 'completed') {
        const reopenedStatus = task.assigned_to_user_id
          ? 'to_do'
          : 'unassigned';
        transitions[reopenedStatus] = { dialog: 'reopen' };
      }
    }

    return transitions;
  }

  function taskBoardTransitions(task) {
    return (BOARD_MOVE_TARGETS[task.status] || []).reduce(
      (transitions, targetStatus) => {
        transitions[targetStatus] = {
          path: `/${task.id}/board-status`,
          method: 'PATCH',
          body: { target_status: targetStatus },
        };
        return transitions;
      },
      {},
    );
  }

  function taskDetailTransitions(task) {
    return {
      ...taskBoardTransitions(task),
      ...taskMoveTransitions(task),
    };
  }

  function formatCategory(value) {
    if (!value) return '';

    return value
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function renderDetailStatusControl(task) {
    const select = $('achi-task-detail-status-control');
    const transitions = taskDetailTransitions(task);
    const targetStatuses = Object.keys(transitions);

    select.replaceChildren(
      new Option(
        STATUS_LABELS[task.status] || task.status,
        task.status,
        true,
        true,
      ),
    );

    targetStatuses.forEach(status => {
      select.add(new Option(STATUS_LABELS[status] || status, status));
    });

    select.value = task.status;
    select.disabled = targetStatuses.length === 0;
    select.title = targetStatuses.length
      ? 'Change task status'
      : 'No status changes are currently available';
  }

  function replaceTask(updatedTask) {
    const index = state.tasks.findIndex(task => task.id === updatedTask.id);
    if (index !== -1) state.tasks[index] = updatedTask;
  }

  function applyMovedTask(updatedTask) {
    const filters = activeFilters();
    const outsideStatusFilter = (
      filters.status
      && filters.status !== 'active'
      && filters.status !== updatedTask.status
    );
    const outsideOverdueFilter = (
      filters.overdue
      && !isOverdue(updatedTask)
    );

    if (outsideStatusFilter || outsideOverdueFilter) {
      state.tasks = state.tasks.filter(task => task.id !== updatedTask.id);
      state.total = Math.max(0, state.total - 1);
      return;
    }

    replaceTask(updatedTask);
  }

  function taskCard(task) {
    const button = el('button', 'achi-task-card');
    const targetStatuses = Object.keys(taskBoardTransitions(task));
    button.type = 'button';
    button.dataset.achiTaskId = task.id;
    button.dataset.achiTaskStatus = task.status;
    button.setAttribute('role', 'listitem');
    button.setAttribute(
      'aria-label',
      `${targetStatuses.length ? 'Drag to move or open' : 'Open'} ` +
        `${task.task_number}: ${task.title}`,
    );

    if (targetStatuses.length && state.movingTaskId !== task.id) {
      button.draggable = true;
      button.classList.add('is-draggable');
      button.title = `Drag to ${targetStatuses
        .map(status => STATUS_LABELS[status] || status)
        .join(' or ')}`;
    }

    if (state.movingTaskId === task.id) {
      button.classList.add('is-moving');
      button.setAttribute('aria-busy', 'true');
    }

    const header = el('div', 'achi-task-card-header');
    header.append(el('span', 'achi-task-card-number', task.task_number));

    if (isOverdue(task)) {
      header.append(el('span', 'achi-task-card-overdue', 'Overdue'));
    }

    const title = el('h3', '', task.title);
    const description = el(
      'p',
      'achi-task-card-description',
      task.description || 'No description provided.',
    );

    const footer = el('div', 'achi-task-card-footer');
    const badges = el('div', 'achi-task-card-badges');

    badges.append(
      el(
        'span',
        `achi-task-priority-pill achi-task-priority-${task.priority}`,
        PRIORITY_LABELS[task.priority] || task.priority,
      ),
    );

    badges.append(
      el(
        'span',
        'achi-task-type-pill',
        TASK_TYPE_LABELS[task.task_type] ||
          formatCategory(task.task_type) ||
          'Task',
      ),
    );

    footer.append(badges);

    const initials = (task.assigned_to_name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0].toUpperCase())
      .join('');
    const meta = el('div', 'achi-task-card-meta');

    if (initials) {
      const avatar = el('span', 'achi-task-card-avatar', initials);
      avatar.title = task.assigned_to_name;
      meta.append(avatar);
    } else {
      meta.append(el('span', 'achi-task-card-unassigned', '—'));
    }

    footer.append(meta);
    button.append(header, title, description, footer);

    return button;
  }

  function renderMetrics() {
    const counts = {
      unassigned: 0,
      ready_for_review: 0,
      overdue: 0,
    };

    state.tasks.forEach(task => {
      if (task.status === 'unassigned') counts.unassigned += 1;
      if (task.status === 'ready_for_review') counts.ready_for_review += 1;
      if (isOverdue(task)) counts.overdue += 1;
    });

    $('achi-task-metric-total').textContent = String(state.total);
    $('achi-task-metric-unassigned').textContent = String(counts.unassigned);
    $('achi-task-metric-review').textContent = String(counts.ready_for_review);
    $('achi-task-metric-overdue').textContent = String(counts.overdue);
  }

  function renderTerminalResults() {
    const selectedStatus = activeFilters().status;
    const section = $('achi-task-terminal-results');
    const heading = $('achi-task-terminal-heading');
    const count = $('achi-task-terminal-count');
    const list = $('achi-task-terminal-list');

    const shouldShow = (
      selectedStatus === ''
      || selectedStatus === 'cancelled'
    );

    section.hidden = !shouldShow;
    if (!shouldShow) return;

    const terminalTasks = state.tasks.filter(
      task => task.status === 'cancelled',
    );

    heading.textContent = 'Cancelled tasks';
    count.textContent = String(terminalTasks.length);
    list.replaceChildren();

    if (!terminalTasks.length) {
      list.append(emptyColumn('No matching cancelled tasks'));
      return;
    }

    terminalTasks.forEach(task => list.append(taskCard(task)));
  }


  function renderBoard() {
    const groups = Object.fromEntries(
      Object.keys(COLUMN_STATUSES).map(key => [key, []]),
    );

    state.tasks.forEach(task => {
      Object.entries(COLUMN_STATUSES).forEach(([column, statuses]) => {
        if (statuses.includes(task.status)) groups[column].push(task);
      });
    });

    Object.entries(groups).forEach(([column, tasks]) => {
      const list = $(`achi-task-list-${column}`);
      const count = $(`achi-task-count-${column}`);

      count.textContent = String(tasks.length);
      list.replaceChildren();

      if (!tasks.length) {
        list.append(emptyColumn('No matching tasks'));
        return;
      }

      tasks.forEach(task => list.append(taskCard(task)));
    });

    const from = state.total ? state.offset + 1 : 0;
    const to = Math.min(state.offset + state.tasks.length, state.total);

    $('achi-task-total').textContent =
      `${state.total} task${state.total === 1 ? '' : 's'}`;

    $('achi-task-page-summary').textContent = state.total
      ? `Showing ${from}–${to} of ${state.total}`
      : 'No matching tasks';

    $('achi-task-page-previous').disabled = state.offset === 0;
    $('achi-task-page-next').disabled = state.offset + state.tasks.length >= state.total;

    renderTerminalResults();
    renderMetrics();
  }

  function boardColumns() {
    return Array.from(
      $('achi-task-board').querySelectorAll('[data-achi-task-status]'),
    );
  }

  function clearDragPresentation() {
    $('achi-task-board').classList.remove('is-dragging-task');

    boardColumns().forEach(column => {
      column.classList.remove(
        'is-drop-allowed',
        'is-drop-target',
        'is-drop-disabled',
      );
      column.removeAttribute('aria-dropeffect');
    });

    $('achi-task-board')
      .querySelectorAll('.achi-task-card.is-dragging')
      .forEach(card => {
        card.classList.remove('is-dragging');
        card.removeAttribute('aria-grabbed');
      });
  }

  function resetDragState() {
    clearDragPresentation();
    state.dragTaskId = null;
    state.dragAllowedStatuses = [];
  }

  function handleBoardDragStart(event) {
    const card = event.target.closest('[data-achi-task-id]');
    if (!card || state.movingTaskId) return;

    const task = state.tasks.find(item => item.id === card.dataset.achiTaskId);
    const allowedStatuses = task
      ? Object.keys(taskBoardTransitions(task))
      : [];

    if (!task || !allowedStatuses.length) {
      event.preventDefault();
      return;
    }

    state.dragTaskId = task.id;
    state.dragAllowedStatuses = allowedStatuses;
    state.suppressCardClickUntil = Date.now() + 400;

    card.classList.add('is-dragging');
    card.setAttribute('aria-grabbed', 'true');
    $('achi-task-board').classList.add('is-dragging-task');

    boardColumns().forEach(column => {
      const allowed = allowedStatuses.includes(column.dataset.achiTaskStatus);
      column.classList.toggle('is-drop-allowed', allowed);
      column.classList.toggle('is-drop-disabled', !allowed);
      if (allowed) column.setAttribute('aria-dropeffect', 'move');
    });

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', task.id);
    }
  }

  function handleBoardDragOver(event) {
    const column = event.target.closest('[data-achi-task-status]');
    if (!column || !state.dragTaskId) return;

    const allowed = state.dragAllowedStatuses.includes(
      column.dataset.achiTaskStatus,
    );
    if (!allowed) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

    boardColumns().forEach(item => {
      item.classList.toggle('is-drop-target', item === column);
    });
  }

  function handleBoardDragLeave(event) {
    const column = event.target.closest('[data-achi-task-status]');
    if (!column || column.contains(event.relatedTarget)) return;
    column.classList.remove('is-drop-target');
  }

  async function performTaskMove(task, targetStatus, transition, card) {
    if (!transition || state.movingTaskId) return;

    if (transition.dialog) {
      openAction(transition.dialog, card, {
        taskId: task.id,
        openTaskAfterSave: false,
        targetStatus,
      });
      return;
    }

    state.movingTaskId = task.id;
    if (card) {
      card.classList.add('is-moving');
      card.setAttribute('aria-busy', 'true');
    }

    try {
      const updatedTask = await request(transition.path, {
        method: transition.method,
        body: transition.body,
      });

      state.movingTaskId = null;
      applyMovedTask(updatedTask);
      renderBoard();
      showToast(
        `${updatedTask.task_number} moved to ` +
          `${STATUS_LABELS[updatedTask.status] || updatedTask.status}.`,
        'success',
      );
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      if (state.movingTaskId === task.id) state.movingTaskId = null;
      if (card) {
        card.classList.remove('is-moving');
        card.removeAttribute('aria-busy');
      }
    }
  }

  async function handleDetailStatusChange(event) {
    const select = event.currentTarget;
    const task = state.currentTask;
    const targetStatus = select.value;
    const transition = task
      ? taskDetailTransitions(task)[targetStatus]
      : null;

    if (!task || !transition) {
      if (task) renderDetailStatusControl(task);
      return;
    }

    if (transition.dialog) {
      select.value = task.status;
      openAction(transition.dialog, select, {
        taskId: task.id,
        openTaskAfterSave: true,
        targetStatus,
      });
      return;
    }

    select.disabled = true;

    try {
      const updatedTask = await request(transition.path, {
        method: transition.method,
        body: transition.body,
      });

      applyMovedTask(updatedTask);
      state.currentTask = updatedTask;
      renderBoard();
      renderDetailStatusControl(updatedTask);
      showToast(
        `${updatedTask.task_number} moved to ` +
          `${STATUS_LABELS[updatedTask.status] || updatedTask.status}.`,
        'success',
      );
      await openTask(updatedTask.id, select);
    } catch (error) {
      renderDetailStatusControl(task);
      showToast(error.message, 'error');
    }
  }

  async function handleDetailTypeChange(event) {
    const select = event.currentTarget;
    const task = state.currentTask;

    if (!task) return;

    const previousType = task.task_type || 'task';
    const taskType = select.value;

    if (taskType === previousType) return;

    select.disabled = true;

    try {
      const updatedTask = await request(`/${task.id}`, {
        method: 'PATCH',
        body: { task_type: taskType },
      });

      replaceTask(updatedTask);
      state.currentTask = updatedTask;
      renderBoard();
      showToast(
        `${updatedTask.task_number} changed to ${
          TASK_TYPE_LABELS[updatedTask.task_type] || updatedTask.task_type
        }.`,
        'success',
      );
      await openTask(updatedTask.id, select);
    } catch (error) {
      select.value = previousType;
      showToast(error.message, 'error');
    } finally {
      select.disabled = false;
    }
  }

  function handleBoardDrop(event) {
    const column = event.target.closest('[data-achi-task-status]');
    const task = state.tasks.find(item => item.id === state.dragTaskId);
    const targetStatus = column && column.dataset.achiTaskStatus;

    if (
      !column ||
      !task ||
      !state.dragAllowedStatuses.includes(targetStatus)
    ) {
      resetDragState();
      return;
    }

    event.preventDefault();

    const card = $('achi-task-board').querySelector(
      `[data-achi-task-id="${task.id}"]`,
    );
    const transition = taskBoardTransitions(task)[targetStatus];

    state.suppressCardClickUntil = Date.now() + 400;
    resetDragState();
    performTaskMove(task, targetStatus, transition, card);
  }

  async function loadTasks() {
    const version = ++state.requestVersion;

    try {
      const response = await request(`/team?${taskQuery()}`);

      if (version !== state.requestVersion) return;

      state.tasks = response.items || [];
      state.total = response.total || 0;

      if (state.offset >= state.total && state.total > 0) {
        state.offset = Math.max(0, state.total - PAGE_SIZE);
        return loadTasks();
      }

      renderBoard();
    } catch (error) {
      if (version !== state.requestVersion) return;

      state.tasks = [];
      state.total = 0;
      renderBoard();
      showToast(error.message, 'error');
    }
  }

  async function loadAssignees() {
    const users = await request('/assignees');
    state.assignees = Array.isArray(users) ? users : [];
    renderAssignees();
  }

  async function loadWorkRequestCount() {
    const badge = $('achi-task-work-request-count');
    const response = await request('/work-requests/team?status=pending&limit=1');
    const total = response.total || 0;

    badge.textContent = String(total);
    badge.hidden = total === 0;
  }

  async function bootstrap() {
    clearPageError();
    $('achi-task-loading').hidden = false;
    $('achi-task-content').hidden = true;
    $('achi-task-header-actions').hidden = true;

    try {
      state.access = await request('/access/me');
      $('achi-task-new-button').hidden = !state.access.can_comment;
      await Promise.all([
        loadAssignees(),
        loadTasks(),
        loadWorkRequestCount(),
      ]);

      $('achi-task-loading').hidden = true;
      $('achi-task-content').hidden = false;
      $('achi-task-header-actions').hidden = false;
    } catch (error) {
      setPageError(error.message);
    }
  }

  function attachmentExtension(filename) {
    const parts = String(filename || '').toLowerCase().split('.');
    return parts.length > 1 ? parts.pop() : '';
  }

  function formatFileSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function attachmentKind(file) {
    const extension = attachmentExtension(file.name);

    if ((file.type || file.content_type || '').startsWith('image/')) {
      return 'IMG';
    }    if (extension === 'pdf') return 'PDF';
    if (['doc', 'docx'].includes(extension)) return 'DOC';
    if (['xls', 'xlsx'].includes(extension)) return 'XLS';

    return 'FILE';
  }

  function renderPendingAttachments() {
    const list = $('achi-task-editor-pending-attachments');
    const count = $('achi-task-editor-attachments-count');

    list.replaceChildren();
    count.textContent = String(state.pendingAttachments.length);

    state.pendingAttachments.forEach((file, index) => {
      const row = el('article', 'achi-task-pending-attachment');
      const icon = el(
        'span',
        'achi-task-attachment-file-icon',
        attachmentKind(file),
      );
      const meta = el('div', 'achi-task-attachment-meta');
      const name = el('p', 'achi-task-attachment-name', file.name);
      const info = el(
        'p',
        'achi-task-attachment-info',
        formatFileSize(file.size),
      );
      const actions = el('div', 'achi-task-attachment-actions');
      const remove = el(
        'button',
        'achi-task-attachment-action achi-task-attachment-action-danger',
        'Remove',
      );

      remove.type = 'button';
      remove.dataset.pendingAttachmentIndex = String(index);

      meta.append(name, info);
      actions.append(remove);
      row.append(icon, meta, actions);
      list.append(row);
    });
  }

  function addPendingAttachments(files) {
    const errorNode = $('achi-task-editor-attachments-error');
    const accepted = [];
    const rejected = [];

    Array.from(files).forEach(file => {
      const extension = attachmentExtension(file.name);

      if (!TASK_ATTACHMENT_ALLOWED_EXTENSIONS.has(extension)) {
        rejected.push(`${file.name}: unsupported file type`);
        return;
      }

      if (file.size === 0) {
        rejected.push(`${file.name}: file is empty`);
        return;
      }

      if (file.size > TASK_ATTACHMENT_MAX_BYTES) {
        rejected.push(`${file.name}: exceeds the 25 MB limit`);
        return;
      }

      accepted.push(file);
    });

    state.pendingAttachments.push(...accepted);
    errorNode.textContent = rejected.join('. ');
    renderPendingAttachments();
  }

  function resetEditor() {
    $('achi-task-editor-form').reset();
    $('achi-task-editor-id').value = '';
    $('achi-task-editor-type').value = 'task';
    $('achi-task-editor-heading').textContent = 'New task';
    $('achi-task-editor-save').textContent = 'Save task';
    $('achi-task-editor-error').textContent = '';
    state.pendingAttachments = [];
    $('achi-task-editor-attachments-input').value = '';
    $('achi-task-editor-attachments-error').textContent = '';
    renderPendingAttachments();
  }

  function editTask(task) {
    $('achi-task-editor-id').value = task.id;
    $('achi-task-editor-heading').textContent = `Edit ${task.task_number}`;
    $('achi-task-editor-save').textContent = 'Save changes';

    $('achi-task-editor-title').value = task.title || '';
    $('achi-task-editor-description').value = task.description || '';
    $('achi-task-editor-assignee').value = task.assigned_to_user_id || '';
    $('achi-task-editor-priority').value = task.priority || 'normal';
    $('achi-task-editor-type').value = task.task_type || 'task';
    $('achi-task-editor-due').value = dateForInput(task.due_at);
    $('achi-task-editor-related-type').value = task.related_type || '';
    $('achi-task-editor-related-id').value = task.related_id || '';
    $('achi-task-editor-related-label').value = task.related_label || '';
    $('achi-task-editor-error').textContent = '';
    state.pendingAttachments = [];
    $('achi-task-editor-attachments-input').value = '';
    $('achi-task-editor-attachments-error').textContent = '';
    renderPendingAttachments();
  }

  function editorPayload(isEdit) {
    const title = $('achi-task-editor-title').value.trim();
    const description = $('achi-task-editor-description').value.trim();
    const assignee = $('achi-task-editor-assignee').value || null;
    const relatedType = $('achi-task-editor-related-type').value.trim();
    const relatedId = $('achi-task-editor-related-id').value.trim();
    const relatedLabel = $('achi-task-editor-related-label').value.trim();

    if (!title) throw new Error('A task title is required.');

    if (Boolean(relatedType) !== Boolean(relatedId)) {
      throw new Error('Related record type and record ID must be entered together.');
    }

    if (!relatedId && relatedLabel) {
      throw new Error('A related label requires a related record ID.');
    }

    const payload = {
      title,
      description,
      assigned_to_user_id: assignee,
      priority: $('achi-task-editor-priority').value,
      task_type: $('achi-task-editor-type').value,
      due_at: dateFromInput($('achi-task-editor-due').value),
      related_type: relatedType || null,
      related_id: relatedId || null,
      related_label: relatedLabel,
    };

    if (!isEdit && payload.due_at === null) {
      delete payload.due_at;
    }

    return payload;
  }

  async function uploadPendingAttachments(taskId) {
    const pending = [...state.pendingAttachments];
    const failed = [];
    let lastError = null;

    for (const file of pending) {
      const formData = new FormData();
      formData.append('file', file, file.name);

      try {
        await request(`/${taskId}/attachments`, {
          method: 'POST',
          body: formData,
        });
      } catch (error) {
        failed.push(file);
        lastError = error;
      }
    }

    state.pendingAttachments = failed;
    renderPendingAttachments();

    if (failed.length) {
      const label = failed.length === 1 ? 'attachment' : 'attachments';
      const detail = lastError ? ` ${lastError.message}` : '';

      throw new Error(
        `${failed.length} ${label} could not be uploaded.${detail}`,
      );
    }

    return pending.length;
  }

  async function saveEditor(event) {
    event.preventDefault();

    const id = $('achi-task-editor-id').value;
    const saveButton = $('achi-task-editor-save');
    const errorNode = $('achi-task-editor-error');
    let savedTask = null;

    errorNode.textContent = '';
    $('achi-task-editor-attachments-error').textContent = '';

    try {
      const payload = editorPayload(Boolean(id));
      setButtonBusy(saveButton, true, id ? 'Saving…' : 'Creating…');

      savedTask = id
        ? await request(`/${id}`, { method: 'PATCH', body: payload })
        : await request('', { method: 'POST', body: payload });

      /*
       * If an upload fails after a new task is created, retries must PATCH
       * this task rather than creating a duplicate.
       */
      if (!id) {
        $('achi-task-editor-id').value = savedTask.id;
        $('achi-task-editor-heading').textContent =
          `Edit ${savedTask.task_number}`;
        $('achi-task-editor-save').textContent = 'Save changes';
      }

      const uploadedCount = await uploadPendingAttachments(savedTask.id);

      closeDialog($('achi-task-editor-dialog'));

      const attachmentText = uploadedCount
        ? ` ${uploadedCount} attachment${uploadedCount === 1 ? '' : 's'} uploaded.`
        : '';

      showToast(`${savedTask.task_number} saved.${attachmentText}`, 'success');
      await loadTasks();

      if (
        state.currentTaskId === savedTask.id &&
        $('achi-task-detail-dialog').open
      ) {
        await openTask(savedTask.id);
      }
    } catch (error) {
      if (savedTask) {
        await loadTasks();
        errorNode.textContent =
          `Task saved, but ${error.message} Save again to retry the remaining files.`;
      } else {
        errorNode.textContent = error.message;
      }
    } finally {
      setButtonBusy(saveButton, false);
    }
  }

  function setText(id, value) {
    $(id).textContent = value || '—';
  }

  function renderAttachments(attachments) {
    const list = $('achi-task-detail-attachments-list');

    state.currentAttachments = attachments;
    list.replaceChildren();
    $('achi-task-detail-attachments-count').textContent =
      String(attachments.length);

    if (!attachments.length) {
      list.append(emptyColumn('No attachments yet.'));
      return;
    }

    attachments.forEach(attachment => {
      const row = el('article', 'achi-task-detail-attachment');
      const icon = el(
        'span',
        'achi-task-attachment-file-icon',
        attachmentKind(attachment),
      );
      const meta = el('div', 'achi-task-attachment-meta');
      const name = el(
        'p',
        'achi-task-attachment-name',
        attachment.filename,
      );
      const uploader = attachment.uploaded_by || 'Unknown user';
      const info = el(
        'p',
        'achi-task-attachment-info',
        `${formatFileSize(attachment.size_bytes)} · ${uploader} · ${
          formatDate(attachment.created_at)
        }`,
      );
      const actions = el('div', 'achi-task-attachment-actions');

      const canDelete = Boolean(state.access?.can_comment);

      ['Open', 'Download', ...(canDelete ? ['Delete'] : [])].forEach(action => {
        const button = el(
          'button',
          action === 'Delete'
            ? 'achi-task-attachment-action achi-task-attachment-action-danger'
            : 'achi-task-attachment-action',
          action,
        );

        button.type = 'button';
        button.dataset.attachmentAction = action.toLowerCase();
        button.dataset.attachmentId = attachment.id;
        actions.append(button);
      });

      meta.append(name, info);
      row.append(icon, meta, actions);
      list.append(row);
    });
  }

  async function fetchAttachmentBlob(attachmentId) {
    const token = getAccessToken();

    if (!token) {
      throw new Error(
        'Your session is missing or expired. Reload the page and sign in again.',
      );
    }

    const response = await fetch(
      `${API}/attachments/${attachmentId}/download`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        errorMessage(body, `Attachment download failed (${response.status}).`),
      );
    }

    return response.blob();
  }

  async function downloadAttachment(attachment) {
    const blob = await fetchAttachmentBlob(attachment.id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = attachment.filename;
    document.body.append(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function openAttachment(attachment) {
    const preview = window.open('', '_blank');

    try {
      const blob = await fetchAttachmentBlob(attachment.id);
      const url = URL.createObjectURL(blob);

      if (!preview) {
        await downloadAttachment(attachment);
        return;
      }

      preview.opener = null;
      preview.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      if (preview) preview.close();
      throw error;
    }
  }

  function renderComments(comments) {
    const list = $('achi-task-comments-list');
    list.replaceChildren();

    $('achi-task-comments-count').textContent = String(comments.length);

    if (!comments.length) {
      list.append(emptyColumn('No comments yet.'));
      return;
    }

    comments.forEach(comment => {
      const item = el('article', 'achi-task-comment');
      const header = el('div', 'achi-task-comment-header');
      const author = el('strong', '', comment.author_name || 'Unknown user');
      const time = el('time', '', formatDate(comment.created_at));
      const body = el('p', '', comment.body);

      header.append(author, time);
      item.append(header, body);
      list.append(item);
    });
  }

  function configureDetailActions(task) {
    const status = task.status;
    const isSupervisor = state.access && state.access.can_manage_team;

    $('achi-task-detail-edit').hidden = !state.access?.can_comment;
    $('achi-task-detail-approve').hidden =
      !isSupervisor || status !== 'ready_for_review';
    $('achi-task-detail-return').hidden =
      !isSupervisor || status !== 'ready_for_review';
    $('achi-task-detail-cancel').hidden =
      !isSupervisor || ['completed', 'cancelled'].includes(status);
    $('achi-task-detail-reopen').hidden =
      !isSupervisor || !['completed', 'cancelled'].includes(status);
  }

  function renderTaskDetail(task, comments,attachments) {
    state.currentTaskId = task.id;
    state.currentTask = task;

    $('achi-task-detail-number').textContent = task.task_number;
    $('achi-task-detail-title').textContent = task.title;
    $('achi-task-detail-summary').textContent =
      `${STATUS_LABELS[task.status] || task.status} · ${
        PRIORITY_LABELS[task.priority] || task.priority
      }`;

    renderDetailStatusControl(task);
    setText(
      'achi-task-detail-priority',
      PRIORITY_LABELS[task.priority] || task.priority,
    );

    $('achi-task-detail-type-control').value =
      TASK_TYPE_LABELS[task.task_type]
        ? task.task_type
        : 'task';

    $('achi-task-detail-description').textContent =
      task.description || 'No description provided.';

    const blocked = task.status === 'blocked' && task.blocked_reason;
    $('achi-task-detail-blocked-section').hidden = !blocked;
    $('achi-task-detail-blocked-reason').textContent =
      task.blocked_reason || '';

    const review = task.review_note;
    $('achi-task-detail-review-section').hidden = !review;
    $('achi-task-detail-review-note').textContent = review || '';

    setText(
      'achi-task-detail-assignee',
      task.assigned_to_name || 'Unassigned',
    );

    setText(
      'achi-task-detail-due',
      task.due_at ? formatDate(task.due_at) : 'No due date',
    );

    setText(
      'achi-task-detail-related',
      task.related_label ||
        (task.related_type && task.related_id
          ? `${task.related_type}: ${task.related_id}`
          : 'None'),
    );

    setText('achi-task-detail-created-by', task.created_by_name);
    setText('achi-task-detail-created-at', formatDate(task.created_at));
    setText('achi-task-detail-updated-at', formatDate(task.updated_at));

    $('achi-task-detail-error').textContent = '';
    $('achi-task-comment-form').hidden = !state.access?.can_comment;
    renderAttachments(attachments);
    renderComments(comments);
    configureDetailActions(task);
  }

  async function openTask(taskId, trigger) {
    try {
      const [task, comments, attachments] = await Promise.all([
        request(`/${taskId}`),
        request(`/${taskId}/comments`),
        request(`/${taskId}/attachments`),
      ]);

      renderTaskDetail(task, comments, attachments);
      showDialog(
        $('achi-task-detail-dialog'),
        trigger,
        'achi-task-detail-close',
      );
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function actionConfig(name) {
    const configs = {
      approve: {
        heading: 'Approve task',
        description: 'Approve the submitted work. A note is optional.',
        label: 'Approval note',
        placeholder: 'Optional note for the employee',
        required: false,
        endpoint: 'approve',
        field: 'note',
        button: 'Approve task',
      },
      return: {
        heading: 'Return task for changes',
        description: 'Explain what the employee needs to change.',
        label: 'Return note',
        placeholder: 'Describe the changes required',
        required: true,
        endpoint: 'return',
        field: 'note',
        button: 'Return task',
      },
      cancel: {
        heading: 'Cancel task',
        description: 'This closes the task. Give a reason for the audit trail.',
        label: 'Cancellation reason',
        placeholder: 'Why is this task being cancelled?',
        required: true,
        endpoint: 'cancel',
        field: 'reason',
        button: 'Cancel task',
      },
      reopen: {
        heading: 'Reopen task',
        description: 'Explain why this completed or cancelled task is being reopened.',
        label: 'Reopen note',
        placeholder: 'Why should this task be reopened?',
        required: true,
        endpoint: 'reopen',
        field: 'note',
        button: 'Reopen task',
      },
      block: {
        heading: 'Block task',
        description: 'Explain what is preventing this task from progressing.',
        label: 'Blocking reason',
        placeholder: 'What is blocking this task?',
        required: true,
        endpoint: 'progress',
        method: 'PATCH',
        field: 'reason',
        button: 'Block task',
        body: note => ({ action: 'block', reason: note }),
      },
    };

    return configs[name] || null;
  }

  function openAction(name, trigger, options = {}) {
    const config = actionConfig(name);
    const taskId = options.taskId || state.currentTaskId;
    if (!config || !taskId) return;

    state.actionName = name;
    state.actionTaskId = taskId;
    state.actionOpenTaskAfterSave = options.openTaskAfterSave !== false;
    state.actionTargetStatus = options.targetStatus || null;

    $('achi-task-action-heading').textContent = config.heading;
    $('achi-task-action-description').textContent = config.description;
    $('achi-task-action-name').value = name;
    $('achi-task-action-input').value = '';
    $('achi-task-action-input').placeholder = config.placeholder;
    $('achi-task-action-input').required = config.required;
    $('achi-task-action-input').setAttribute(
      'aria-label',
      config.label,
    );
    $('achi-task-action-error').textContent = '';
    $('achi-task-action-submit').textContent = config.button;

    showDialog(
      $('achi-task-action-dialog'),
      trigger,
      'achi-task-action-input',
    );
  }

  async function submitAction(event) {
    event.preventDefault();

    const config = actionConfig(state.actionName);
    const errorNode = $('achi-task-action-error');
    const button = $('achi-task-action-submit');
    const note = $('achi-task-action-input').value.trim();

    if (!config || !state.actionTaskId) return;

    errorNode.textContent = '';

    if (config.required && !note) {
      errorNode.textContent = `${config.label} is required.`;
      return;
    }

    try {
      setButtonBusy(button, true, 'Saving…');

      const task = await request(
        `/${state.actionTaskId}/${config.endpoint}`,
        {
          method: config.method || 'POST',
          body: config.body
            ? config.body(note)
            : { [config.field]: note },
        },
      );

      closeDialog($('achi-task-action-dialog'));
      showToast(
        state.actionTargetStatus
          ? `${task.task_number} moved to ` +
            `${STATUS_LABELS[task.status] || task.status}.`
          : `${task.task_number} updated.`,
        'success',
      );

      const refreshes = [loadTasks()];
      if (state.actionOpenTaskAfterSave) refreshes.push(openTask(task.id));
      await Promise.all(refreshes);
    } catch (error) {
      errorNode.textContent = error.message;
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function saveComment(event) {
    event.preventDefault();

    if (!state.currentTaskId) return;

    const body = $('achi-task-comment-body').value.trim();
    const errorNode = $('achi-task-comment-error');
    const button = $('achi-task-comment-submit');

    errorNode.textContent = '';

    if (!body) {
      errorNode.textContent = 'Write a comment before sending it.';
      return;
    }

    try {
      setButtonBusy(button, true, 'Sending…');

      await request(`/${state.currentTaskId}/comments`, {
        method: 'POST',
        body: { body },
      });

      $('achi-task-comment-body').value = '';
      showToast('Comment added.', 'success');
      await openTask(state.currentTaskId);
    } catch (error) {
      errorNode.textContent = error.message;
    } finally {
      setButtonBusy(button, false);
    }
  }

  function workRequestCard(item) {
    const card = el('article', 'achi-task-work-request-card');
    card.setAttribute('role', 'listitem');

    const info = el('div');
    info.append(
      el('strong', '', item.requester_name || 'Unknown user'),
      el('p', '', item.message || 'No message provided.'),
      el('small', '', `Requested ${formatDate(item.created_at)}`),
    );

    card.append(info);

    if (
      item.status === 'pending' &&
      state.access &&
      item.requester_user_id !== state.access.user_id
    ) {
      const acknowledge = el(
        'button',
        'achi-task-button achi-task-button-primary',
        'Acknowledge',
      );

      acknowledge.type = 'button';
      acknowledge.addEventListener('click', () => acknowledgeRequest(item.id, acknowledge));
      card.append(acknowledge);
    } else {
      card.append(el('span', 'achi-task-status-pill', item.status));
    }

    return card;
  }

  async function loadWorkRequests() {
    const filter = $('achi-task-work-request-filter').value;
    const params = new URLSearchParams({ limit: '100' });

    if (filter) params.append('status', filter);

    const list = $('achi-task-work-request-list');
    const errorNode = $('achi-task-work-request-error');

    errorNode.textContent = '';
    list.replaceChildren(el('p', 'achi-task-loading-card', 'Loading requests…'));

    try {
      const response = await request(`/work-requests/team?${params}`);
      const items = response.items || [];

      $('achi-task-work-request-total').textContent =
        `${response.total || 0} request${response.total === 1 ? '' : 's'}`;

      list.replaceChildren();

      if (!items.length) {
        list.append(emptyColumn('No matching work requests.'));
        return;
      }

      items.forEach(item => list.append(workRequestCard(item)));
    } catch (error) {
      errorNode.textContent = error.message;
      list.replaceChildren();
    }
  }

  async function acknowledgeRequest(requestId, button) {
    try {
      setButtonBusy(button, true, 'Saving…');

      await request(`/work-requests/${requestId}/acknowledge`, {
        method: 'POST',
      });

      showToast('Work request acknowledged.', 'success');

      await Promise.all([
        loadWorkRequests(),
        loadWorkRequestCount(),
      ]);
    } catch (error) {
      showToast(error.message, 'error');
      setButtonBusy(button, false);
    }
  }

  function bindEvents() {
    $('achi-task-page-retry').addEventListener('click', bootstrap);
    $('achi-task-refresh-button').addEventListener('click', async () => {
      await Promise.all([loadTasks(), loadWorkRequestCount()]);
      showToast('Team Tasks refreshed.', 'success');
    });

    $('achi-task-new-button').addEventListener('click', event => {
      resetEditor();
      showDialog(
        $('achi-task-editor-dialog'),
        event.currentTarget,
        'achi-task-editor-title',
      );
    });

    $('achi-task-editor-form').addEventListener('submit', saveEditor);
    const attachmentInput = $('achi-task-editor-attachments-input');
    const attachmentDropzone = $('achi-task-editor-attachments-dropzone');
    const pendingAttachments = $('achi-task-editor-pending-attachments');

    attachmentInput.addEventListener('change', event => {
      addPendingAttachments(event.target.files);
      event.target.value = '';
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      attachmentDropzone.addEventListener(eventName, event => {
        event.preventDefault();
        attachmentDropzone.classList.add('is-dragover');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      attachmentDropzone.addEventListener(eventName, event => {
        event.preventDefault();
        attachmentDropzone.classList.remove('is-dragover');
      });
    });

    attachmentDropzone.addEventListener('drop', event => {
      addPendingAttachments(event.dataTransfer.files);
    });

    pendingAttachments.addEventListener('click', event => {
      const removeButton = event.target.closest(
        '[data-pending-attachment-index]',
      );

      if (!removeButton) return;

      const index = Number(removeButton.dataset.pendingAttachmentIndex);

      if (!Number.isInteger(index)) return;

      state.pendingAttachments.splice(index, 1);
      $('achi-task-editor-attachments-error').textContent = '';
      renderPendingAttachments();
    });

    $('achi-task-detail-attachments-list').addEventListener('click', async event => {
      const button = event.target.closest('[data-attachment-action]');

      if (!button) return;

      const attachment = state.currentAttachments.find(
        item => item.id === button.dataset.attachmentId,
      );

      if (!attachment) return;

      try {
        if (button.dataset.attachmentAction === 'open') {
          await openAttachment(attachment);
          return;
        }

        if (button.dataset.attachmentAction === 'download') {
          await downloadAttachment(attachment);
          return;
        }

        if (button.dataset.attachmentAction === 'delete') {
          const confirmed = window.confirm(
            `Delete "${attachment.filename}" from this task?`,
          );

          if (!confirmed) return;

          button.disabled = true;
          await request(`/attachments/${attachment.id}`, {
            method: 'DELETE',
          });

          showToast('Attachment deleted.', 'success');
          await openTask(state.currentTaskId);
        }
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });


    $('achi-task-editor-close').addEventListener(
      'click',
      () => closeDialog($('achi-task-editor-dialog')),
    );
    $('achi-task-editor-cancel').addEventListener(
      'click',
      () => closeDialog($('achi-task-editor-dialog')),
    );

    $('achi-task-filter-search').addEventListener('input', () => {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => {
        state.offset = 0;
        loadTasks();
      }, 300);
    });

    [
      'achi-task-filter-assignee',
      'achi-task-filter-priority',
      'achi-task-filter-status',
      'achi-task-filter-overdue',
    ].forEach(id => {
      $(id).addEventListener('change', () => {
        state.offset = 0;
        loadTasks();
      });
    });

    $('achi-task-filter-reset').addEventListener('click', () => {
      $('achi-task-filter-form').reset();
      state.offset = 0;
      loadTasks();
    });

    $('achi-task-page-previous').addEventListener('click', () => {
      state.offset = Math.max(0, state.offset - PAGE_SIZE);
      loadTasks();
    });

    $('achi-task-page-next').addEventListener('click', () => {
      state.offset += PAGE_SIZE;
      loadTasks();
    });

    $('achi-task-board').addEventListener('click', event => {
      if (Date.now() < state.suppressCardClickUntil) return;
      const card = event.target.closest('[data-achi-task-id]');
      if (!card) return;
      openTask(card.dataset.achiTaskId, card);
    });

    $('achi-task-board').addEventListener('dragstart', handleBoardDragStart);
    $('achi-task-board').addEventListener('dragover', handleBoardDragOver);
    $('achi-task-board').addEventListener('dragleave', handleBoardDragLeave);
    $('achi-task-board').addEventListener('drop', handleBoardDrop);
    $('achi-task-board').addEventListener('dragend', resetDragState);

    $('achi-task-terminal-list').addEventListener('click', event => {
      const card = event.target.closest('[data-achi-task-id]');
      if (!card) return;
      openTask(card.dataset.achiTaskId, card);
    });

    [
      'achi-task-detail-close',
      'achi-task-detail-footer-close',
    ].forEach(id => {
      $(id).addEventListener(
        'click',
        () => closeDialog($('achi-task-detail-dialog')),
      );
    });

    $('achi-task-detail-edit').addEventListener('click', async event => {
      if (!state.currentTaskId) return;

      try {
        const task = await request(`/${state.currentTaskId}`);
        editTask(task);
        showDialog(
          $('achi-task-editor-dialog'),
          event.currentTarget,
          'achi-task-editor-title',
        );
      } catch (error) {
        showToast(error.message, 'error');
      }
    });

    $('achi-task-detail-status-control').addEventListener(
      'change',
      handleDetailStatusChange,
    );

    $('achi-task-detail-type-control').addEventListener(
      'change',
      handleDetailTypeChange,
    );

    ['approve', 'return', 'cancel', 'reopen'].forEach(name => {
      $(`achi-task-detail-${name}`).addEventListener('click', event => {
        openAction(name, event.currentTarget);
      });
    });

    $('achi-task-comment-form').addEventListener('submit', saveComment);

    $('achi-task-action-form').addEventListener('submit', submitAction);
    $('achi-task-action-close').addEventListener(
      'click',
      () => closeDialog($('achi-task-action-dialog')),
    );
    $('achi-task-action-cancel').addEventListener(
      'click',
      () => closeDialog($('achi-task-action-dialog')),
    );

    $('achi-task-work-requests-button').addEventListener('click', event => {
      showDialog(
        $('achi-task-work-request-dialog'),
        event.currentTarget,
        'achi-task-work-request-filter',
      );
      loadWorkRequests();
    });

    $('achi-task-work-request-close').addEventListener(
      'click',
      () => closeDialog($('achi-task-work-request-dialog')),
    );

    $('achi-task-work-request-refresh').addEventListener(
      'click',
      loadWorkRequests,
    );

    $('achi-task-work-request-filter').addEventListener(
      'change',
      loadWorkRequests,
    );

    [
      'achi-task-work-request-dialog',
      'achi-task-editor-dialog',
      'achi-task-detail-dialog',
      'achi-task-action-dialog',
    ].forEach(id => {
      $(id).addEventListener('click', event => {
        if (event.target === event.currentTarget) {
          closeDialog(event.currentTarget);
        }
      });
    });
  }

  bindEvents();
  bootstrap();
}());
