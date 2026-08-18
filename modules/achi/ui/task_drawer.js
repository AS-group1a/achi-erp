(function () {
  'use strict';

  if (window.top !== window.self || window.__achiTaskDrawerLoaded) return;
  window.__achiTaskDrawerLoaded = true;

  var API = '/api/v1/achi/tasks';
  var ACTIVE_STATUSES = ['to_do', 'in_progress', 'blocked', 'ready_for_review'];

  var state = {
    access: null,
    panel: null,
    tab: null,
    view: null,
    tasks: [],
    total: 0,
    pendingRequest: false,
    currentTask: null,
    comments: [],
    loading: false,
    error: '',
    actionTaskId: null,
    actionName: '',
    dialog: null,
    dialogText: null,
    dialogError: null
  };

  function token() {
    try {
      return localStorage.getItem('oe_access_token')
        || sessionStorage.getItem('oe_access_token')
        || '';
    } catch (error) {
      return '';
    }
  }

  async function request(path, options) {
    options = options || {};

    if (path !== API && path.indexOf(API + '/') !== 0 && path.indexOf(API + '?') !== 0) {
      throw new Error('Blocked request outside the Team Tasks API.');
    }

    var headers = { Accept: 'application/json' };
    var accessToken = token();
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;

    if (options.body && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    options.headers = Object.assign(headers, options.headers || {});
    if (!options.method || options.method === 'GET') options.cache = 'no-store';

    var response;
    try {
      response = await fetch(path, options);
    } catch (error) {
      throw new Error('Could not reach Team Tasks.');
    }

    var text = await response.text();
    var body = {};

    if (text) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        body = { detail: text };
      }
    }

    if (!response.ok) {
      var detail = body.detail;
      if (Array.isArray(detail)) {
        detail = detail.map(function (item) {
          return item && item.msg ? item.msg : String(item);
        }).join(' ');
      }
      var failure = new Error(detail || ('Request failed (' + response.status + ').'));
      failure.status = response.status;
      throw failure;
    }

    return body;
  }

  function make(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function button(label, className, handler) {
    var element = make('button', className || 'achi-task-drawer-button', label);
    element.type = 'button';
    element.addEventListener('click', handler);
    return element;
  }

  function dateFrom(value) {
    if (!value) return null;
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dueLabel(value) {
    var due = dateFrom(value);
    if (!due) return 'No due date';

    var difference = due.getTime() - Date.now();
    var minutes = Math.round(Math.abs(difference) / 60000);
    var amount;
    var unit;

    if (minutes < 60) {
      amount = minutes;
      unit = 'minute';
    } else if (minutes < 1440) {
      amount = Math.round(minutes / 60);
      unit = 'hour';
    } else {
      amount = Math.round(minutes / 1440);
      unit = 'day';
    }

    var relative = amount + ' ' + unit + (amount === 1 ? '' : 's');
    return difference < 0 ? 'Overdue ' + relative : 'Due in ' + relative;
  }

  function formatDate(value) {
    var date = dateFrom(value);
    if (!date) return '—';
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date);
  }

  function titleCase(value) {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function (letter) {
        return letter.toUpperCase();
      });
  }

  function priorityClass(priority) {
    return 'achi-task-drawer-priority--' + (priority || 'normal');
  }

  function statusClass(status) {
    return 'achi-task-drawer-status--' + (status || 'to_do');
  }

  function taskAction(task) {
    if (task.status === 'to_do') return { label: 'Start', action: 'start' };
    if (task.status === 'in_progress') return { label: 'Block', action: 'block' };
    if (task.status === 'blocked') return { label: 'Resume', action: 'resume' };
    if (task.status === 'ready_for_review') return { label: 'Waiting for review', action: '' };
    return null;
  }

  function addStyle() {
    var style = document.createElement('style');
    style.textContent =
      '.acmt-panel.mode-tasks .acmt-only-comments,' +
      '.acmt-panel.mode-tasks .acmt-only-chat,' +
      '.acmt-panel.mode-tasks .acmt-list{display:none!important}' +
      '.acmt-panel.mode-tasks .achi-task-drawer{display:flex!important}' +
      '.achi-task-drawer{display:none;flex:1;min-height:0;overflow-y:auto;flex-direction:column;' +
        'gap:12px;padding:14px;background:#f7f9fc;color:#172b4d;font:13px/1.45 system-ui,sans-serif}' +
      '.achi-task-drawer *{box-sizing:border-box}' +
      '.achi-task-drawer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}' +
      '.achi-task-drawer-head h3{margin:0;font-size:15px;color:#102a56}' +
      '.achi-task-drawer-head p{margin:3px 0 0;color:#6c7d97;font-size:12px}' +
      '.achi-task-drawer-count{background:#e8eef9;color:#244b8f;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:700}' +
      '.achi-task-drawer-error{margin:0;padding:9px 10px;border:1px solid #f4b7b7;border-radius:7px;background:#fff3f3;color:#b42318}' +
      '.achi-task-drawer-list{display:flex;flex-direction:column;gap:9px}' +
      '.achi-task-drawer-card{border:1px solid #d8e0ec;border-radius:9px;background:#fff;padding:11px;box-shadow:0 1px 2px rgba(16,42,86,.05)}' +
      '.achi-task-drawer-open{display:block;width:100%;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}' +
      '.achi-task-drawer-open:focus-visible,.achi-task-drawer-button:focus-visible{outline:3px solid #91b5ff;outline-offset:2px}' +
      '.achi-task-drawer-top{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '.achi-task-drawer-number{color:#2857a5;font-size:10px;font-weight:800;letter-spacing:.03em}' +
      '.achi-task-drawer-badges{display:flex;gap:5px;align-items:center;flex-wrap:wrap;justify-content:flex-end}' +
      '.achi-task-drawer-badge{border-radius:999px;padding:3px 7px;font-size:10px;font-weight:800}' +
      '.achi-task-drawer-priority--low{background:#eef2f7;color:#52647f}' +
      '.achi-task-drawer-priority--normal{background:#e9f1ff;color:#2857a5}' +
      '.achi-task-drawer-priority--high{background:#fff0d5;color:#9a5a00}' +
      '.achi-task-drawer-priority--urgent{background:#ffdfdf;color:#b42318}' +
      '.achi-task-drawer-status--to_do{background:#e9f1ff;color:#2857a5}' +
      '.achi-task-drawer-status--in_progress{background:#eee8ff;color:#6846bb}' +
      '.achi-task-drawer-status--blocked{background:#ffdfdf;color:#b42318}' +
      '.achi-task-drawer-status--ready_for_review{background:#e3f8ee;color:#18794e}' +
      '.achi-task-drawer-title{margin:8px 0 4px;font-size:14px;font-weight:750;color:#102a56}' +
      '.achi-task-drawer-meta{color:#6c7d97;font-size:11px}' +
      '.achi-task-drawer-overdue{color:#b42318;font-weight:700}' +
      '.achi-task-drawer-actions{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap}' +
      '.achi-task-drawer-button{border:1px solid #b9c9e2;border-radius:6px;background:#fff;color:#193c78;padding:6px 9px;font:inherit;font-size:11px;font-weight:700;cursor:pointer}' +
      '.achi-task-drawer-button:hover{background:#edf3ff}' +
      '.achi-task-drawer-button--primary{background:#2857a5;border-color:#2857a5;color:#fff}' +
      '.achi-task-drawer-button--primary:hover{background:#1d467f}' +
      '.achi-task-drawer-button:disabled{opacity:.62;cursor:not-allowed}' +
      '.achi-task-drawer-empty{padding:28px 12px;text-align:center;color:#6c7d97}' +
      '.achi-task-drawer-footer{margin-top:auto;border-top:1px solid #d8e0ec;padding-top:12px}' +
      '.achi-task-drawer-footer p{margin:0 0 8px;color:#52647f;font-size:12px}' +
      '.achi-task-drawer-detail-back{align-self:flex-start}' +
      '.achi-task-drawer-detail h3{margin:0;color:#102a56;font-size:16px}' +
      '.achi-task-drawer-detail-copy{margin:10px 0;color:#40516c;white-space:pre-wrap}' +
      '.achi-task-drawer-info{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}' +
      '.achi-task-drawer-info div{padding:8px;border-radius:7px;background:#fff;border:1px solid #d8e0ec}' +
      '.achi-task-drawer-info b{display:block;color:#6c7d97;font-size:10px;text-transform:uppercase;letter-spacing:.04em}' +
      '.achi-task-drawer-info span{display:block;margin-top:3px;font-size:12px}' +
      '.achi-task-drawer-comments{margin-top:14px;border-top:1px solid #d8e0ec;padding-top:12px}' +
      '.achi-task-drawer-comments h4{margin:0 0 8px;color:#102a56;font-size:13px}' +
      '.achi-task-drawer-comment{padding:8px 0;border-bottom:1px solid #edf0f5}' +
      '.achi-task-drawer-comment strong{font-size:11px;color:#193c78}' +
      '.achi-task-drawer-comment time{margin-left:5px;color:#8a98ae;font-size:10px}' +
      '.achi-task-drawer-comment p{margin:4px 0 0;white-space:pre-wrap;color:#40516c}' +
      '.achi-task-drawer-comment-form{display:flex;flex-direction:column;gap:7px;margin-top:10px}' +
      '.achi-task-drawer textarea{width:100%;resize:vertical;border:1px solid #b9c9e2;border-radius:6px;padding:8px;font:inherit}' +
      '.achi-task-drawer-dialog{border:0;border-radius:10px;box-shadow:0 16px 45px rgba(16,42,86,.3);padding:0;max-width:min(360px,92vw)}' +
      '.achi-task-drawer-dialog::backdrop{background:rgba(15,35,75,.4)}' +
      '.achi-task-drawer-dialog form{padding:17px;display:flex;flex-direction:column;gap:10px}' +
      '.achi-task-drawer-dialog h3{margin:0;color:#102a56;font-size:16px}' +
      '.achi-task-drawer-dialog p{margin:0;color:#52647f;font-size:12px}' +
      '.achi-task-drawer-dialog-actions{display:flex;justify-content:flex-end;gap:7px}' +
      '.achi-task-drawer-dialog-error{margin:0;color:#b42318;font-size:12px}';
    document.head.appendChild(style);
  }

  function setTaskMode(enabled) {
    state.panel.classList.toggle('mode-tasks', enabled);
    state.tab.classList.toggle('on', enabled);
    state.view.hidden = !enabled;

    if (enabled) {
      state.panel.querySelector('.acmt-title').textContent = 'My Tasks';
    }
  }

  function card(task) {
    var item = make('article', 'achi-task-drawer-card');
    var open = button('', 'achi-task-drawer-open', function () {
      openTask(task.id);
    });

    var top = make('div', 'achi-task-drawer-top');
    top.appendChild(make('span', 'achi-task-drawer-number', task.task_number));

    var badges = make('span', 'achi-task-drawer-badges');
    badges.appendChild(make(
      'span',
      'achi-task-drawer-badge ' + priorityClass(task.priority),
      titleCase(task.priority)
    ));
    badges.appendChild(make(
      'span',
      'achi-task-drawer-badge ' + statusClass(task.status),
      titleCase(task.status)
    ));
    top.appendChild(badges);

    open.appendChild(top);
    open.appendChild(make('div', 'achi-task-drawer-title', task.title));

    var meta = make('div', 'achi-task-drawer-meta');
    meta.textContent = dueLabel(task.due_at);
    if (task.due_at && dateFrom(task.due_at).getTime() < Date.now()) {
      meta.classList.add('achi-task-drawer-overdue');
    }
    open.appendChild(meta);
    item.appendChild(open);

    var action = taskAction(task);
    if (action) {
      var actions = make('div', 'achi-task-drawer-actions');

      if (task.status === 'in_progress') {
        actions.appendChild(button('Submit for review', 'achi-task-drawer-button achi-task-drawer-button--primary', function () {
          showActionDialog(task.id, 'submit');
        }));
      }

      if (action.action) {
        actions.appendChild(button(action.label, 'achi-task-drawer-button', function () {
          if (action.action === 'block') {
            showActionDialog(task.id, 'block');
          } else {
            progress(task.id, action.action, {});
          }
        }));
      } else {
        actions.appendChild(make('span', 'achi-task-drawer-meta', action.label));
      }

      item.appendChild(actions);
    }

    return item;
  }

  function renderRequestArea(container) {
    var footer = make('section', 'achi-task-drawer-footer');

    if (state.pendingRequest) {
      footer.appendChild(make('p', '', 'Task request pending. Your supervisor has been notified.'));
      footer.appendChild(button('Task request pending', 'achi-task-drawer-button', function () {}, true));
      footer.lastChild.disabled = true;
    } else {
      footer.appendChild(make(
        'p',
        '',
        'No more assigned work? Notify supervisor without making a call.'
      ));
      footer.appendChild(button(
        'I need another task',
        'achi-task-drawer-button achi-task-drawer-button--primary',
        requestWork
      ));
    }

    container.appendChild(footer);
  }

  function renderList() {
    var view = state.view;
    view.replaceChildren();

    var head = make('div', 'achi-task-drawer-head');
    var heading = make('div');
    heading.appendChild(make('h3', '', 'My Tasks'));
    heading.appendChild(make('p', '', 'Your assigned work, due dates and progress updates.'));
    head.appendChild(heading);
    head.appendChild(make(
      'span',
      'achi-task-drawer-count',
      state.total + (state.total === 1 ? ' task' : ' tasks')
    ));
    view.appendChild(head);

    if (state.error) {
      view.appendChild(make('p', 'achi-task-drawer-error', state.error));
    }

    if (state.loading) {
      view.appendChild(make('p', 'achi-task-drawer-empty', 'Loading tasks…'));
      return;
    }

    if (!state.tasks.length) {
      view.appendChild(make(
        'p',
        'achi-task-drawer-empty',
        'You have no active tasks right now.'
      ));
      renderRequestArea(view);
      return;
    }

    var list = make('div', 'achi-task-drawer-list');
    state.tasks.forEach(function (task) {
      list.appendChild(card(task));
    });
    view.appendChild(list);
    renderRequestArea(view);
  }

  function detailInfo(label, value) {
    var item = make('div');
    item.appendChild(make('b', '', label));
    item.appendChild(make('span', '', value || '—'));
    return item;
  }

  function renderComments(section) {
    section.appendChild(make(
      'h4',
      '',
      'Comments (' + state.comments.length + ')'
    ));

    if (!state.comments.length) {
      section.appendChild(make('p', 'achi-task-drawer-meta', 'No comments yet.'));
    } else {
      state.comments.forEach(function (comment) {
        var item = make('article', 'achi-task-drawer-comment');
        item.appendChild(make('strong', '', comment.author_name || 'Team member'));

        var time = make('time', '', formatDate(comment.created_at));
        if (comment.created_at) time.dateTime = comment.created_at;
        item.appendChild(time);

        item.appendChild(make('p', '', comment.body));
        section.appendChild(item);
      });
    }

    if (!state.access.can_comment) return;

    var form = make('form', 'achi-task-drawer-comment-form');
    var input = document.createElement('textarea');
    input.rows = 3;
    input.maxLength = 5000;
    input.required = true;
    input.placeholder = 'Write a comment for this task';
    input.setAttribute('aria-label', 'Task comment');

    var error = make('p', 'achi-task-drawer-dialog-error');
    var submit = button('Send comment', 'achi-task-drawer-button achi-task-drawer-button--primary', function () {});
    submit.type = 'submit';

    form.appendChild(input);
    form.appendChild(error);
    form.appendChild(submit);

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var body = input.value.trim();
      if (!body) return;

      submit.disabled = true;
      error.textContent = '';

      try {
        var comment = await request(API + '/' + state.currentTask.id + '/comments', {
          method: 'POST',
          body: { body: body }
        });
        state.comments.push(comment);
        renderDetail();
      } catch (failure) {
        error.textContent = failure.message;
        submit.disabled = false;
      }
    });

    section.appendChild(form);
  }

  function renderDetail() {
    var task = state.currentTask;
    var view = state.view;
    view.replaceChildren();

    view.appendChild(button('← Back to My Tasks', 'achi-task-drawer-button achi-task-drawer-detail-back', function () {
      state.currentTask = null;
      state.comments = [];
      state.error = '';
      renderList();
    }));

    if (state.error) {
      view.appendChild(make('p', 'achi-task-drawer-error', state.error));
    }

    if (state.loading || !task) {
      view.appendChild(make('p', 'achi-task-drawer-empty', 'Loading task details…'));
      return;
    }

    var detail = make('section', 'achi-task-drawer-detail');
    detail.appendChild(make('span', 'achi-task-drawer-number', task.task_number));
    detail.appendChild(make('h3', '', task.title));

    var badges = make('div', 'achi-task-drawer-badges');
    badges.style.justifyContent = 'flex-start';
    badges.style.marginTop = '8px';
    badges.appendChild(make(
      'span',
      'achi-task-drawer-badge ' + priorityClass(task.priority),
      titleCase(task.priority)
    ));
    badges.appendChild(make(
      'span',
      'achi-task-drawer-badge ' + statusClass(task.status),
      titleCase(task.status)
    ));
    detail.appendChild(badges);

    detail.appendChild(make(
      'p',
      'achi-task-drawer-detail-copy',
      task.description || 'No description was provided.'
    ));

    var info = make('div', 'achi-task-drawer-info');
    info.appendChild(detailInfo('Due', task.due_at ? formatDate(task.due_at) : 'No due date'));
    info.appendChild(detailInfo('Assigned by', task.created_by_name));
    info.appendChild(detailInfo('Related work', task.related_label || 'None'));
    info.appendChild(detailInfo('Started', task.started_at ? formatDate(task.started_at) : 'Not started'));

    if (task.blocked_reason) {
      info.appendChild(detailInfo('Blocked reason', task.blocked_reason));
    }

    if (task.review_note) {
      info.appendChild(detailInfo('Review note', task.review_note));
    }

    detail.appendChild(info);

    var action = taskAction(task);
    if (action) {
      var actions = make('div', 'achi-task-drawer-actions');

      if (task.status === 'in_progress') {
        actions.appendChild(button('Submit for review', 'achi-task-drawer-button achi-task-drawer-button--primary', function () {
          showActionDialog(task.id, 'submit');
        }));
      }

      if (action.action) {
        actions.appendChild(button(action.label, 'achi-task-drawer-button', function () {
          if (action.action === 'block') {
            showActionDialog(task.id, 'block');
          } else {
            progress(task.id, action.action, {});
          }
        }));
      } else {
        actions.appendChild(make('span', 'achi-task-drawer-meta', action.label));
      }

      detail.appendChild(actions);
    }

    var comments = make('section', 'achi-task-drawer-comments');
    renderComments(comments);
    detail.appendChild(comments);

    view.appendChild(detail);
  }

  function render() {
    if (state.currentTask) renderDetail();
    else renderList();
  }

  async function loadTasks() {
    state.loading = true;
    state.error = '';
    render();

    var query = new URLSearchParams();
    ACTIVE_STATUSES.forEach(function (status) {
      query.append('status', status);
    });
    query.set('limit', '100');

    try {
      var results = await Promise.all([
        request(API + '/mine?' + query.toString()),
        request(API + '/work-requests/mine?status=pending&limit=1')
      ]);

      state.tasks = results[0].items || [];
      state.total = results[0].total || 0;
      state.pendingRequest = Boolean(
        results[1] && results[1].total > 0
      );
    } catch (failure) {
      state.tasks = [];
      state.total = 0;
      state.pendingRequest = false;
      state.error = failure.status === 401
        ? 'Your session expired. Sign in again, then reopen My Tasks.'
        : failure.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function openTask(taskId) {
    state.loading = true;
    state.error = '';
    state.currentTask = null;
    render();

    try {
      var results = await Promise.all([
        request(API + '/' + encodeURIComponent(taskId)),
        request(API + '/' + encodeURIComponent(taskId) + '/comments')
      ]);
      state.currentTask = results[0];
      state.comments = Array.isArray(results[1]) ? results[1] : [];
    } catch (failure) {
      state.currentTask = null;
      state.comments = [];
      state.error = failure.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function progress(taskId, action, extra) {
    state.loading = true;
    state.error = '';
    render();

    try {
      var updated = await request(API + '/' + encodeURIComponent(taskId) + '/progress', {
        method: 'PATCH',
        body: Object.assign({ action: action }, extra || {})
      });

      if (state.currentTask && state.currentTask.id === updated.id) {
        state.currentTask = updated;
      }

      await loadTasks();
    } catch (failure) {
      state.loading = false;
      state.error = failure.message;
      render();
    }
  }

  async function requestWork() {
    state.loading = true;
    state.error = '';
    render();

    try {
      await request(API + '/work-requests', {
        method: 'POST',
        body: { message: '' }
      });
      state.pendingRequest = true;
    } catch (failure) {
      state.error = failure.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  function buildDialog() {
    var dialog = document.createElement('dialog');
    dialog.className = 'achi-task-drawer-dialog';

    var form = document.createElement('form');
    var heading = make('h3', '', '');
    var description = make('p', '', '');
    var input = document.createElement('textarea');
    input.rows = 4;
    input.maxLength = 5000;

    var error = make('p', 'achi-task-drawer-dialog-error');
    var actions = make('div', 'achi-task-drawer-dialog-actions');
    var cancel = button('Cancel', 'achi-task-drawer-button', function () {
      dialog.close();
    });
    var submit = button('Confirm', 'achi-task-drawer-button achi-task-drawer-button--primary', function () {});
    submit.type = 'submit';


    actions.appendChild(cancel);
    actions.appendChild(submit);
    form.appendChild(heading);
    form.appendChild(description);
    form.appendChild(input);
    form.appendChild(error);
    form.appendChild(actions);
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    form.addEventListener('submit', async function (event) {
      event.preventDefault();

      var value = input.value.trim();
      if (state.actionName === 'block' && !value) {
        error.textContent = 'A blocked reason is required.';
        input.focus();
        return;
      }

      submit.disabled = true;
      error.textContent = '';

      try {
        dialog.close();
        if (state.actionName === 'block') {
          await progress(state.actionTaskId, 'block', { reason: value });
        } else {
          await progress(state.actionTaskId, 'submit', { note: value });
        }
      } finally {
        submit.disabled = false;
      }
    });

    state.dialog = dialog;
    state.dialogText = input;
    state.dialogError = error;
    state.dialogHeading = heading;
    state.dialogDescription = description;
  }

  function showActionDialog(taskId, action) {
    state.actionTaskId = taskId;
    state.actionName = action;
    state.dialogError.textContent = '';
    state.dialogText.value = '';

    if (action === 'block') {
      state.dialogHeading.textContent = 'Block task';
      state.dialogDescription.textContent = 'Explain what is stopping you from continuing.';
      state.dialogText.placeholder = 'Blocked reason';
      state.dialogText.required = true;
    } else {
      state.dialogHeading.textContent = 'Submit for review';
      state.dialogDescription.textContent = 'Add an optional note for your supervisor.';
      state.dialogText.placeholder = 'Review note (optional)';
      state.dialogText.required = false;
    }

    state.dialog.showModal();
    window.setTimeout(function () {
      state.dialogText.focus();
    }, 0);
  }

  async function activate() {
    setTaskMode(true);
    state.currentTask = null;
    state.comments = [];
    await loadTasks();
  }

  function waitForDrawer(remaining) {
    var panel = document.querySelector('.acmt-panel');
    var segment = panel && panel.querySelector('.acmt-seg');

    if (!panel || !segment) {
      if (remaining > 0) {
        window.setTimeout(function () {
          waitForDrawer(remaining - 1);
        }, 100);
      }
      return;
    }

    request(API + '/access/me').then(function (access) {
      if (!access.can_progress_tasks || access.can_manage_team) return;

      state.access = access;
      state.panel = panel;

      addStyle();
      buildDialog();

      var tab = button('My Tasks', 'acmt-segm', activate);
      segment.appendChild(tab);
      state.tab = tab;

      var view = make('section', 'achi-task-drawer');
      view.hidden = true;
      view.setAttribute('aria-label', 'My Tasks');
      panel.appendChild(view);
      state.view = view;

      panel.querySelectorAll('.acmt-segc, .acmt-segt').forEach(function (existingTab) {
        existingTab.addEventListener('click', function () {
          setTaskMode(false);
        });
      });
    }).catch(function () {
         if (remaining > 0) {
        window.setTimeout(function () {
          waitForDrawer(remaining - 1);
        }, 250);
      }
      /* Existing Comments and Team Chat remain fully usable if task access fails. */
    });
  }

  var lastSessionToken = null;

  function checkSession() {
    var currentToken = token();

    if (currentToken === lastSessionToken) return;

    lastSessionToken = currentToken;

    if (currentToken) {
      waitForDrawer(50);
    }
  }

  window.addEventListener('storage', checkSession);
  window.setInterval(checkSession, 1000);
  checkSession();
}());