(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value == null ? '' : value).replace(
    /[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]),
  );
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const today = () => new Date().toISOString().slice(0, 10);
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
              parsed.access_token,
              parsed.refresh_token,
              parsed.token,
              parsed.state && parsed.state.access_token,
              parsed.state && parsed.state.refresh_token,
              parsed.state && parsed.state.token,
            ];
            for (const candidate of candidates) if (match(candidate)) return candidate;
          } catch (_error) {
            // Ignore storage entries owned by unrelated features.
          }
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
  let toastTimer = null;
  let modalState = null;

  const state = {
    view: 'pipeline',
    search: '',
    filter: 'all',
    dashboard: null,
    metrics: null,
    board: { columns: [] },
    accounts: [],
    leads: [],
    activities: [],
    contacts: [],
    reasons: [],
    active: null,
    timeline: [],
    loading: false,
  };

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

  async function optionalRequest(path, fallback) {
    try { return await request(path); }
    catch (error) {
      if (![401, 403, 404].includes(error.status)) console.warn(`Optional CRM request failed: ${path}`, error);
      return fallback;
    }
  }

  function showToast(message, isError) {
    const toast = $('toast');
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('is-error', Boolean(isError));
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3200);
  }

  function titleCase(value) {
    return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function formatDate(value, includeTime) {
    if (!value) return '-';
    const parsed = new Date(value.length === 10 ? `${value}T12:00:00` : value);
    if (Number.isNaN(parsed.getTime())) return value;
    return new Intl.DateTimeFormat('en-GB', includeTime
      ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: 'short', year: 'numeric' }).format(parsed);
  }

  function formatMoney(value, currency, compact) {
    const number = Number(value || 0);
    const code = String(currency || '').toUpperCase();
    if (!code) {
      const formatted = new Intl.NumberFormat('en-GB', {
        notation: compact ? 'compact' : 'standard',
        maximumFractionDigits: compact ? 1 : 0,
      }).format(number);
      return number ? `${formatted} (currency unset)` : '-';
    }
    try {
      return new Intl.NumberFormat('en-GB', {
        style: 'currency', currency: code,
        notation: compact ? 'compact' : 'standard',
        maximumFractionDigits: compact ? 1 : 0,
      }).format(number);
    } catch (_error) {
      return `${number.toLocaleString('en-GB')} ${code}`;
    }
  }

  function currencySummary(items) {
    const nonZero = (items || []).filter(item => Number(item.total));
    if (!nonZero.length) return { main: '-', note: 'No value recorded' };
    if (nonZero.length === 1) return {
      main: formatMoney(nonZero[0].total, nonZero[0].currency, true),
      note: nonZero[0].currency || 'Currency not assigned',
    };
    return {
      main: `${nonZero.length} currencies`,
      note: nonZero.map(item => formatMoney(item.total, item.currency, true)).join(' + '),
    };
  }

  const accountById = id => state.accounts.find(item => item.id === id) || null;
  const contactById = id => state.contacts.find(item => item.id === id) || null;
  const stageById = id => state.board.columns.find(item => item.stage_id === id) || null;
  const leadById = id => state.leads.find(item => item.id === id) || null;
  const opportunityById = id => state.board.columns.flatMap(column => column.opportunities).find(item => item.id === id) || null;
  const activityById = id => state.activities.find(item => item.id === id) || null;
  const fullContactName = contact => contact
    ? ([contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.company_name || contact.primary_email || 'Contact')
    : '-';

  function statusPill(status) {
    return `<span class="status-pill status-${escapeHtml(status || '')}">${escapeHtml(titleCase(status || 'unknown'))}</span>`;
  }

  function recordMark(kind, label) {
    if (kind === 'account') return `<span class="record-mark">${icon('building')}</span>`;
    if (kind === 'activity') return `<span class="record-mark">${icon('clock')}</span>`;
    const initials = String(label || '?').split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
    return `<span class="record-mark">${escapeHtml(initials || '?')}</span>`;
  }

  function openDateState(value) {
    if (!value) return '';
    return value < today() ? ' is-overdue' : '';
  }

  function dealMatches(deal) {
    const account = accountById(deal.account_id);
    const haystack = [deal.title, deal.description, deal.source, account && account.name, deal.currency].join(' ').toLowerCase();
    if (state.search && !haystack.includes(state.search)) return false;
    if (state.filter === 'overdue') return Boolean(deal.expected_close_date && deal.expected_close_date < today());
    if (state.filter === 'closing_30') {
      if (!deal.expected_close_date) return false;
      const end = new Date(); end.setDate(end.getDate() + 30);
      return deal.expected_close_date >= today() && deal.expected_close_date <= end.toISOString().slice(0, 10);
    }
    return true;
  }

  function groupedCurrency(items) {
    const totals = new Map();
    for (const item of items) {
      const currency = item.currency || '';
      totals.set(currency, (totals.get(currency) || 0) + Number(item.estimated_value || 0));
    }
    return [...totals.entries()].filter(([, value]) => value).map(([currency, value]) => formatMoney(value, currency, true)).join(' + ') || '-';
  }

  function renderMetrics() {
    const metrics = state.metrics || {};
    const dashboard = state.dashboard || {};
    const pipeline = currencySummary(metrics.by_currency);
    const weighted = currencySummary(metrics.weighted_by_currency);
    $('metric-pipeline').textContent = pipeline.main;
    $('metric-pipeline-note').textContent = pipeline.note;
    $('metric-weighted').textContent = weighted.main;
    $('metric-weighted-note').textContent = weighted.note;
    $('metric-deals').textContent = metrics.open_count == null ? '-' : String(metrics.open_count);
    $('metric-stage-note').textContent = `${state.board.columns.filter(column => !isFinalStage(column)).length} active stages`;
    $('metric-leads').textContent = dashboard.leads_open == null ? '-' : String(dashboard.leads_open);
    $('metric-activities').textContent = dashboard.activities_due_soon == null ? '-' : String(dashboard.activities_due_soon);
    $('metric-win-rate').textContent = dashboard.win_rate_30d == null ? '-' : `${Number(dashboard.win_rate_30d).toFixed(0)}%`;
    const overdue = state.activities.filter(activity => !activity.completed_at && activity.due_at && new Date(activity.due_at) < new Date()).length;
    $('metric-overdue-note').textContent = overdue ? `${overdue} overdue` : 'Nothing overdue';
    $('lead-tab-count').textContent = state.leads.length;
    $('account-tab-count').textContent = state.accounts.length;
    $('activity-tab-count').textContent = state.activities.filter(item => !item.completed_at).length;
  }

  function isFinalStage(column) {
    return /won|lost/i.test(`${column.code} ${column.name}`);
  }

  function renderPipeline() {
    const columns = state.board.columns || [];
    if (!columns.length) {
      $('pipeline-board').innerHTML = '<div class="empty-state">No pipeline stages are configured.</div>';
      return;
    }
    $('pipeline-board').innerHTML = columns.map(column => {
      const deals = column.opportunities.filter(dealMatches);
      const final = isFinalStage(column);
      return `
        <section class="pipeline-column" style="--stage-color:${escapeHtml(column.color || '#94a3b8')}">
          <header class="column-header">
            <div class="column-title-row"><h2>${escapeHtml(column.name)}</h2><span class="count-badge">${deals.length}</span></div>
            <p class="column-value">${escapeHtml(groupedCurrency(deals))}</p>
          </header>
          <div class="column-body" data-stage-id="${escapeHtml(column.stage_id)}" data-final="${final}">
            ${deals.map(deal => {
              const account = accountById(deal.account_id);
              return `
                <button class="deal-card" type="button" draggable="${!final && deal.status === 'open'}" data-record-type="opportunity" data-record-id="${escapeHtml(deal.id)}">
                  <span class="deal-top"><h3>${escapeHtml(deal.title)}</h3><span class="probability">${Number(deal.probability_percent || 0)}%</span></span>
                  <span class="deal-account">${escapeHtml(account ? account.name : 'Account unavailable')}</span>
                  <span class="deal-bottom"><span class="deal-value">${escapeHtml(formatMoney(deal.estimated_value, deal.currency, true))}</span><span class="deal-date${openDateState(deal.expected_close_date)}">${escapeHtml(formatDate(deal.expected_close_date))}</span></span>
                </button>`;
            }).join('') || '<div class="empty-column">No matching deals</div>'}
          </div>
        </section>`;
    }).join('');
  }

  function filteredLeads() {
    return state.leads.filter(lead => {
      const account = accountById(lead.account_id);
      const haystack = [lead.contact_name, lead.contact_email, lead.contact_phone, lead.source, account && account.name].join(' ').toLowerCase();
      return (!state.search || haystack.includes(state.search)) && (state.filter === 'all' || lead.status === state.filter);
    });
  }

  function renderLeads() {
    const leads = filteredLeads();
    $('leads-list').innerHTML = leads.length ? `
      <table class="data-table"><thead><tr><th class="wide">Lead</th><th>Account</th><th>Status</th><th>Source</th><th>Phone</th><th>Created</th></tr></thead>
      <tbody>${leads.map(lead => {
        const account = accountById(lead.account_id);
        return `<tr data-record-type="lead" data-record-id="${escapeHtml(lead.id)}">
          <td><div class="table-primary">${recordMark('lead', lead.contact_name)}<div class="table-primary-text"><strong>${escapeHtml(lead.contact_name)}</strong><small>${escapeHtml(lead.contact_email || 'No email')}</small></div></div></td>
          <td>${escapeHtml(account ? account.name : '-')}</td><td>${statusPill(lead.status)}</td><td><span class="source-label">${escapeHtml(titleCase(lead.source))}</span></td>
          <td>${escapeHtml(lead.contact_phone || '-')}</td><td>${escapeHtml(formatDate(lead.created_at))}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty-state">No leads match this view.</div>';
  }

  function filteredAccounts() {
    return state.accounts.filter(account => {
      const haystack = [account.name, account.industry, account.country, account.website, ...(account.tags || [])].join(' ').toLowerCase();
      return (!state.search || haystack.includes(state.search)) && (state.filter === 'all' || account.status === state.filter);
    });
  }

  function renderAccounts() {
    const accounts = filteredAccounts();
    $('accounts-list').innerHTML = accounts.length ? `
      <table class="data-table"><thead><tr><th class="wide">Account</th><th>Industry</th><th>Status</th><th>Open deals</th><th>Open value</th><th>Country</th></tr></thead>
      <tbody>${accounts.map(account => {
        const deals = state.board.columns.flatMap(column => column.opportunities).filter(deal => deal.account_id === account.id && deal.status === 'open');
        return `<tr data-record-type="account" data-record-id="${escapeHtml(account.id)}">
          <td><div class="table-primary">${recordMark('account')}<div class="table-primary-text"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.website || account.size_category || '')}</small></div></div></td>
          <td>${escapeHtml(account.industry || '-')}</td><td>${statusPill(account.status)}</td><td>${deals.length}</td><td>${escapeHtml(groupedCurrency(deals))}</td><td>${escapeHtml(account.country || '-')}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty-state">No accounts match this view.</div>';
  }

  function activityStatus(activity) {
    if (activity.completed_at) return 'complete';
    if (activity.due_at && new Date(activity.due_at) < new Date()) return 'overdue';
    return 'open';
  }

  function relatedLabel(activity) {
    if (activity.opportunity_id) return (opportunityById(activity.opportunity_id) || {}).title || 'Opportunity';
    if (activity.lead_id) return (leadById(activity.lead_id) || {}).contact_name || 'Lead';
    if (activity.account_id) return (accountById(activity.account_id) || {}).name || 'Account';
    return '-';
  }

  function filteredActivities() {
    return state.activities
      .filter(activity => {
        const haystack = [activity.subject, activity.body, activity.kind, activity.outcome, relatedLabel(activity)].join(' ').toLowerCase();
        const matchesSearch = !state.search || haystack.includes(state.search);
        const status = activityStatus(activity);
        return matchesSearch && (state.filter === 'all' || status === state.filter || activity.kind === state.filter);
      })
      .sort((a, b) => {
        if (Boolean(a.completed_at) !== Boolean(b.completed_at)) return a.completed_at ? 1 : -1;
        return String(a.due_at || '9999').localeCompare(String(b.due_at || '9999'));
      });
  }

  function renderActivities() {
    const activities = filteredActivities();
    $('activities-list').innerHTML = activities.length ? `
      <table class="data-table"><thead><tr><th class="wide">Activity</th><th>Related to</th><th>Type</th><th>Due</th><th>Status</th><th>Outcome</th></tr></thead>
      <tbody>${activities.map(activity => `<tr data-record-type="activity" data-record-id="${escapeHtml(activity.id)}">
        <td><div class="table-primary">${recordMark('activity')}<div class="table-primary-text"><strong>${escapeHtml(activity.subject || titleCase(activity.kind))}</strong><small>${escapeHtml(activity.body || 'No notes')}</small></div></div></td>
        <td>${escapeHtml(relatedLabel(activity))}</td><td>${escapeHtml(titleCase(activity.kind))}</td><td>${escapeHtml(formatDate(activity.due_at, true))}</td>
        <td>${statusPill(activityStatus(activity))}</td><td>${escapeHtml(titleCase(activity.outcome || '-'))}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty-state">No activities match this view.</div>';
  }

  function filterOptions() {
    if (state.view === 'pipeline') return [['all', 'All deals'], ['closing_30', 'Closing in 30 days'], ['overdue', 'Past close date']];
    if (state.view === 'leads') return [['all', 'All statuses'], ['new', 'New'], ['qualifying', 'Qualifying'], ['qualified', 'Qualified'], ['converted', 'Converted'], ['disqualified', 'Disqualified']];
    if (state.view === 'accounts') return [['all', 'All statuses'], ['active', 'Active'], ['dormant', 'Dormant'], ['lost', 'Lost']];
    return [['all', 'All activities'], ['open', 'Open'], ['overdue', 'Overdue'], ['complete', 'Completed'], ['call', 'Calls'], ['meeting', 'Meetings'], ['email', 'Emails'], ['task', 'Tasks']];
  }

  function renderFilter() {
    $('status-filter').innerHTML = filterOptions().map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    $('status-filter').value = state.filter;
  }

  function renderView() {
    document.querySelectorAll('.view-panel').forEach(panel => { panel.hidden = panel.id !== `${state.view}-view`; });
    document.querySelectorAll('.view-button').forEach(button => button.classList.toggle('is-active', button.dataset.view === state.view));
    renderFilter();
    if (state.view === 'pipeline') renderPipeline();
    if (state.view === 'leads') renderLeads();
    if (state.view === 'accounts') renderAccounts();
    if (state.view === 'activities') renderActivities();
    const labels = { pipeline: 'New deal', leads: 'New lead', accounts: 'New account', activities: 'New activity' };
    $('context-add-button').querySelector('span').textContent = labels[state.view];
  }

  function detailRow(label, value, raw) {
    return `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${raw ? value : escapeHtml(value == null || value === '' ? '-' : value)}</strong></div>`;
  }

  function contactDetails(contact) {
    if (!contact) return detailRow('Primary contact', '-');
    const email = contact.primary_email ? `<a href="mailto:${escapeHtml(contact.primary_email)}">${escapeHtml(contact.primary_email)}</a>` : '-';
    const phone = contact.primary_phone ? `<a href="tel:${escapeHtml(contact.primary_phone)}">${escapeHtml(contact.primary_phone)}</a>` : '-';
    return detailRow('Primary contact', fullContactName(contact)) + detailRow('Email', email, true) + detailRow('Phone', phone, true);
  }

  function timelineHtml() {
    if (!state.timeline.length) return '<p class="timeline-empty">No activity has been logged for this record.</p>';
    return `<div class="timeline">${state.timeline.map(item => {
      const subject = item.subject || item.description || titleCase(item.kind || item.event_type || 'Update');
      const when = item.timestamp || item.created_at || item.changed_at || item.due_at;
      let body = item.body || item.outcome || (item.to_stage_id ? `Moved to ${stageById(item.to_stage_id)?.name || 'new stage'}` : '');
      if (item.entry_type === 'stage_history') {
        const stageId = String(body).match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
        body = `Moved to ${stageById(stageId)?.name || 'a new stage'}`;
      }
      return `<article class="timeline-item"><div class="timeline-top"><strong>${escapeHtml(subject)}</strong><time>${escapeHtml(formatDate(when, true))}</time></div>${body ? `<p>${escapeHtml(body)}</p>` : ''}</article>`;
    }).join('')}</div>`;
  }

  function opportunityDrawer(record) {
    const account = accountById(record.account_id);
    const contact = contactById(record.primary_contact_id);
    const stage = stageById(record.stage_id);
    $('drawer-eyebrow').textContent = 'Opportunity';
    $('drawer-title').textContent = record.title;
    $('drawer-subtitle').textContent = account ? account.name : 'Account unavailable';
    $('drawer-command-bar').innerHTML = `
      <button class="button button-secondary compact" type="button" data-action="edit">${icon('edit')}Edit</button>
      <button class="button button-secondary compact" type="button" data-action="log-activity">${icon('plus')}Activity</button>
      ${record.status === 'open' ? `<button class="button button-success compact" type="button" data-action="win">${icon('check')}Won</button><button class="button button-danger compact" type="button" data-action="lose">Lost</button>` : ''}`;
    const stageOptions = state.board.columns.filter(column => !isFinalStage(column)).map(item => `<option value="${escapeHtml(item.stage_id)}" ${item.stage_id === record.stage_id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
    $('drawer-body').innerHTML = `
      <section class="drawer-section"><h3>Deal</h3><select class="inline-stage" data-action="move-stage" ${record.status !== 'open' ? 'disabled' : ''}>${stageOptions}</select>
        <div class="detail-list">${detailRow('Status', statusPill(record.status), true)}${detailRow('Value', formatMoney(record.estimated_value, record.currency))}${detailRow('Probability', `${record.probability_percent}%`)}${detailRow('Weighted value', formatMoney(record.weighted_value, record.currency))}${detailRow('Expected close', formatDate(record.expected_close_date))}${detailRow('Source', titleCase(record.source))}</div></section>
      <section class="drawer-section"><h3>Account and contact</h3><div class="detail-list">${detailRow('Account', account ? account.name : '-')}${contactDetails(contact)}</div>
        ${contact ? `<a class="related-link" href="/api/v1/achi/contact-info/ui"><strong>Open Contact Info</strong>${icon('arrow')}</a>` : ''}</section>
      ${record.description ? `<section class="drawer-section"><h3>Description</h3><p class="detail-copy">${escapeHtml(record.description)}</p></section>` : ''}
      ${record.notes ? `<section class="drawer-section"><h3>Notes</h3><p class="detail-copy">${escapeHtml(record.notes)}</p></section>` : ''}
      <section class="drawer-section"><h3>Activity timeline</h3>${timelineHtml()}</section>
      <section class="drawer-section"><h3>Official record</h3><a class="related-link" href="/crm"><strong>Open in OpenConstructionERP CRM</strong>${icon('arrow')}</a>${record.project_id ? `<a class="related-link" href="/projects/${escapeHtml(record.project_id)}"><strong>Open linked project</strong>${icon('arrow')}</a>` : ''}</section>`;
  }

  function leadDrawer(record) {
    const account = accountById(record.account_id);
    $('drawer-eyebrow').textContent = 'Lead';
    $('drawer-title').textContent = record.contact_name;
    $('drawer-subtitle').textContent = account ? account.name : titleCase(record.source);
    $('drawer-command-bar').innerHTML = `
      <button class="button button-secondary compact" type="button" data-action="edit">${icon('edit')}Edit</button>
      <button class="button button-secondary compact" type="button" data-action="log-activity">${icon('plus')}Activity</button>
      ${['new', 'qualifying'].includes(record.status) ? `<button class="button button-success compact" type="button" data-action="qualify">${icon('check')}Qualify</button><button class="button button-danger compact" type="button" data-action="disqualify">Disqualify</button>` : ''}
      ${record.status === 'qualified' ? `<button class="button button-primary compact" type="button" data-action="convert">Convert to deal</button>` : ''}`;
    const email = record.contact_email ? `<a href="mailto:${escapeHtml(record.contact_email)}">${escapeHtml(record.contact_email)}</a>` : '-';
    const phone = record.contact_phone ? `<a href="tel:${escapeHtml(record.contact_phone)}">${escapeHtml(record.contact_phone)}</a>` : '-';
    $('drawer-body').innerHTML = `
      <section class="drawer-section"><h3>Lead</h3><div class="detail-list">${detailRow('Status', statusPill(record.status), true)}${detailRow('Source', titleCase(record.source))}${detailRow('Account', account ? account.name : '-')}${detailRow('Email', email, true)}${detailRow('Phone', phone, true)}${detailRow('Created', formatDate(record.created_at))}</div></section>
      ${record.qualification_notes ? `<section class="drawer-section"><h3>Qualification notes</h3><p class="detail-copy">${escapeHtml(record.qualification_notes)}</p></section>` : ''}
      <section class="drawer-section"><h3>Activity timeline</h3>${timelineHtml()}</section>`;
  }

  function accountDrawer(record) {
    const contact = contactById(record.primary_contact_id);
    const deals = state.board.columns.flatMap(column => column.opportunities).filter(item => item.account_id === record.id);
    const leads = state.leads.filter(item => item.account_id === record.id);
    $('drawer-eyebrow').textContent = 'Account';
    $('drawer-title').textContent = record.name;
    $('drawer-subtitle').textContent = [record.industry, record.country].filter(Boolean).join(' | ') || 'Company account';
    $('drawer-command-bar').innerHTML = `<button class="button button-secondary compact" type="button" data-action="edit">${icon('edit')}Edit</button><button class="button button-secondary compact" type="button" data-action="log-activity">${icon('plus')}Activity</button><button class="button button-primary compact" type="button" data-action="new-deal">${icon('plus')}Deal</button>`;
    $('drawer-body').innerHTML = `
      <section class="drawer-section"><h3>Account</h3><div class="detail-list">${detailRow('Status', statusPill(record.status), true)}${detailRow('Industry', record.industry)}${detailRow('Size', titleCase(record.size_category))}${detailRow('Country', record.country)}${detailRow('Website', record.website ? `<a href="${escapeHtml(record.website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(record.website)}</a>` : '-', true)}${contactDetails(contact)}</div></section>
      ${record.description ? `<section class="drawer-section"><h3>Description</h3><p class="detail-copy">${escapeHtml(record.description)}</p></section>` : ''}
      <section class="drawer-section"><h3>Open opportunities (${deals.length})</h3>${deals.slice(0, 8).map(deal => `<button class="related-link" type="button" data-open-type="opportunity" data-open-id="${escapeHtml(deal.id)}"><strong>${escapeHtml(deal.title)}</strong><span>${escapeHtml(formatMoney(deal.estimated_value, deal.currency, true))}</span></button>`).join('') || '<p class="timeline-empty">No opportunities.</p>'}</section>
      <section class="drawer-section"><h3>Leads (${leads.length})</h3>${leads.slice(0, 8).map(lead => `<button class="related-link" type="button" data-open-type="lead" data-open-id="${escapeHtml(lead.id)}"><strong>${escapeHtml(lead.contact_name)}</strong><span>${escapeHtml(titleCase(lead.status))}</span></button>`).join('') || '<p class="timeline-empty">No leads.</p>'}</section>
      <section class="drawer-section"><h3>Activity timeline</h3>${timelineHtml()}</section>`;
  }

  function activityDrawer(record) {
    $('drawer-eyebrow').textContent = titleCase(record.kind);
    $('drawer-title').textContent = record.subject || titleCase(record.kind);
    $('drawer-subtitle').textContent = relatedLabel(record);
    $('drawer-command-bar').innerHTML = `<button class="button button-secondary compact" type="button" data-action="edit">${icon('edit')}Edit</button>${!record.completed_at ? `<button class="button button-success compact" type="button" data-action="complete">${icon('check')}Complete</button>` : ''}`;
    $('drawer-body').innerHTML = `
      <section class="drawer-section"><h3>Activity</h3><div class="detail-list">${detailRow('Status', statusPill(activityStatus(record)), true)}${detailRow('Type', titleCase(record.kind))}${detailRow('Related to', relatedLabel(record))}${detailRow('Due', formatDate(record.due_at, true))}${detailRow('Completed', formatDate(record.completed_at, true))}${detailRow('Outcome', titleCase(record.outcome || '-'))}</div></section>
      ${record.body ? `<section class="drawer-section"><h3>Notes</h3><p class="detail-copy">${escapeHtml(record.body)}</p></section>` : ''}`;
  }

  function activeRecord() {
    if (!state.active) return null;
    if (state.active.type === 'opportunity') return opportunityById(state.active.id);
    if (state.active.type === 'lead') return leadById(state.active.id);
    if (state.active.type === 'account') return accountById(state.active.id);
    if (state.active.type === 'activity') return activityById(state.active.id);
    return null;
  }

  function renderDrawer() {
    const record = activeRecord();
    if (!record) return closeDrawer();
    if (state.active.type === 'opportunity') opportunityDrawer(record);
    if (state.active.type === 'lead') leadDrawer(record);
    if (state.active.type === 'account') accountDrawer(record);
    if (state.active.type === 'activity') activityDrawer(record);
  }

  async function openRecord(type, id) {
    const exists = type === 'opportunity' ? opportunityById(id)
      : type === 'lead' ? leadById(id)
        : type === 'account' ? accountById(id)
          : activityById(id);
    if (!exists) {
      closeDrawer();
      return;
    }
    state.active = { type, id };
    state.timeline = [];
    renderDrawer();
    $('drawer-backdrop').hidden = false;
    $('record-drawer').classList.add('is-open');
    $('record-drawer').setAttribute('aria-hidden', 'false');
    if (type !== 'activity') {
      const key = type === 'opportunity' ? 'opportunity_id' : `${type}_id`;
      state.timeline = await optionalRequest(`/api/v1/crm/activities/timeline?${key}=${encodeURIComponent(id)}&limit=100`, []);
      if (state.active && state.active.type === type && state.active.id === id) renderDrawer();
    }
  }

  function closeDrawer() {
    state.active = null;
    state.timeline = [];
    $('record-drawer').classList.remove('is-open');
    $('record-drawer').setAttribute('aria-hidden', 'true');
    window.setTimeout(() => { if (!state.active) $('drawer-backdrop').hidden = true; }, 180);
  }

  const optionList = (items, selected, emptyLabel) => `${emptyLabel == null ? '' : `<option value="">${escapeHtml(emptyLabel)}</option>`}${items.map(item => `<option value="${escapeHtml(item.value)}" ${String(item.value) === String(selected || '') ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}`;
  const accountOptions = selected => optionList(state.accounts.map(item => ({ value: item.id, label: item.name })), selected, 'Select account');
  const contactOptions = selected => optionList(state.contacts.map(item => ({ value: item.id, label: fullContactName(item) })), selected, 'No linked contact');
  const stageOptions = selected => optionList(state.board.columns.filter(column => !isFinalStage(column)).map(item => ({ value: item.stage_id, label: item.name })), selected, 'Select stage');
  const sourceOptions = selected => optionList(['inbound', 'web', 'referral', 'event', 'cold_outreach'].map(value => ({ value, label: titleCase(value) })), selected);

  function field(name, label, value, options = {}) {
    const classes = options.wide ? 'span-2' : '';
    const required = options.required ? 'required' : '';
    const note = options.note ? `<span class="field-note">${escapeHtml(options.note)}</span>` : '';
    const disabled = options.disabled ? 'disabled' : '';
    const displayValue = value == null ? '' : value;
    if (options.type === 'textarea') return `<label class="${classes}">${escapeHtml(label)}${note}<textarea name="${name}" rows="${options.rows || 3}" ${required} ${disabled}>${escapeHtml(displayValue)}</textarea></label>`;
    if (options.type === 'select') return `<label class="${classes}">${escapeHtml(label)}${note}<select name="${name}" ${required} ${disabled}>${options.html}</select></label>`;
    if (options.type === 'checkbox') return `<label class="${classes}">${escapeHtml(label)}<input type="checkbox" name="${name}" ${value ? 'checked' : ''}></label>`;
    return `<label class="${classes}">${escapeHtml(label)}${note}<input type="${options.type || 'text'}" name="${name}" value="${escapeHtml(displayValue)}" ${options.min != null ? `min="${options.min}"` : ''} ${options.max != null ? `max="${options.max}"` : ''} ${options.step ? `step="${options.step}"` : ''} ${required} ${disabled}></label>`;
  }

  function toLocalDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function relatedOptions(record) {
    const selected = record ? (record.opportunity_id ? `opportunity:${record.opportunity_id}` : record.lead_id ? `lead:${record.lead_id}` : record.account_id ? `account:${record.account_id}` : '') : '';
    const items = [
      ...state.accounts.map(item => ({ value: `account:${item.id}`, label: `Account | ${item.name}` })),
      ...state.leads.filter(item => !['converted', 'disqualified'].includes(item.status)).map(item => ({ value: `lead:${item.id}`, label: `Lead | ${item.contact_name}` })),
      ...state.board.columns.flatMap(column => column.opportunities).map(item => ({ value: `opportunity:${item.id}`, label: `Deal | ${item.title}` })),
    ];
    return optionList(items, selected, 'No related record');
  }

  function renderForm(type, record, context) {
    if (type === 'opportunity') return [
      field('title', 'Deal title', record && record.title, { required: true, wide: true }),
      record
        ? field('account_display', 'Account', (accountById(record.account_id) || {}).name || 'Account unavailable', { disabled: true })
        : field('account_id', 'Account', context && context.account_id, { type: 'select', html: accountOptions(context && context.account_id), required: true }),
      field('primary_contact_id', 'Primary contact', record && record.primary_contact_id, { type: 'select', html: contactOptions(record && record.primary_contact_id) }),
      field('estimated_value', 'Estimated value', record && record.estimated_value, { type: 'number', min: 0, step: '0.01' }),
      field('currency', 'Currency', (record && record.currency) || 'USD', { note: 'ISO code' }),
      field('expected_close_date', 'Expected close', record && record.expected_close_date, { type: 'date' }),
      field('probability_percent', 'Probability %', record ? record.probability_percent : 10, { type: 'number', min: 0, max: 100, required: true }),
      field('stage_id', 'Pipeline stage', (record && record.stage_id) || (state.board.columns.find(column => !isFinalStage(column)) || {}).stage_id, { type: 'select', html: stageOptions((record && record.stage_id) || (state.board.columns.find(column => !isFinalStage(column)) || {}).stage_id), required: true }),
      field('source', 'Source', (record && record.source) || 'inbound', { type: 'select', html: sourceOptions((record && record.source) || 'inbound') }),
      field('description', 'Description', record && record.description, { type: 'textarea', wide: true }),
      field('notes', 'Internal notes', record && record.notes, { type: 'textarea', wide: true }),
    ].join('');
    if (type === 'lead') return [
      field('contact_name', 'Contact name', record && record.contact_name, { required: true, wide: true }),
      field('contact_email', 'Email', record && record.contact_email, { type: 'email' }),
      field('contact_phone', 'Phone', record && record.contact_phone, { type: 'tel' }),
      field('account_id', 'Account', record && record.account_id, { type: 'select', html: accountOptions(record && record.account_id) }),
      field('source', 'Source', (record && record.source) || 'inbound', { type: 'select', html: sourceOptions((record && record.source) || 'inbound') }),
      field('qualification_notes', 'Qualification notes', record && record.qualification_notes, { type: 'textarea', wide: true }),
    ].join('');
    if (type === 'account') return [
      field('name', 'Account name', record && record.name, { required: true, wide: true }),
      field('industry', 'Industry', record && record.industry),
      field('size_category', 'Company size', (record && record.size_category) || 'sme', { type: 'select', html: optionList([{ value: 'sme', label: 'SME' }, { value: 'mid', label: 'Mid-market' }, { value: 'enterprise', label: 'Enterprise' }], (record && record.size_category) || 'sme') }),
      field('country', 'Country', record && record.country),
      field('website', 'Website', record && record.website, { type: 'url' }),
      field('primary_contact_id', 'Primary contact', record && record.primary_contact_id, { type: 'select', html: contactOptions(record && record.primary_contact_id) }),
      field('status', 'Status', (record && record.status) || 'active', { type: 'select', html: optionList([{ value: 'active', label: 'Active' }, { value: 'dormant', label: 'Dormant' }, { value: 'lost', label: 'Lost' }], (record && record.status) || 'active') }),
      field('tags', 'Tags', record && (record.tags || []).join(', '), { wide: true, note: 'Comma separated' }),
      field('description', 'Description', record && record.description, { type: 'textarea', wide: true }),
    ].join('');
    if (type === 'activity') {
      const contextual = context && context.type ? `${context.type}:${context.id}` : null;
      let activity = record ? { ...record } : null;
      if (contextual && !activity) {
        const [kind, id] = contextual.split(':');
        Object.assign(activity || (activity = {}), { [`${kind}_id`]: id });
      }
      return [
        field('kind', 'Activity type', (record && record.kind) || 'call', { type: 'select', html: optionList(['call', 'meeting', 'email', 'task', 'note'].map(value => ({ value, label: titleCase(value) })), (record && record.kind) || 'call') }),
        field('related', 'Related to', '', { type: 'select', html: relatedOptions(activity), disabled: Boolean(record), note: record ? 'Relationship is fixed after creation' : '' }),
        field('subject', 'Subject', record && record.subject, { required: true, wide: true }),
        field('due_at', 'Due date and time', toLocalDateTime(record && record.due_at), { type: 'datetime-local' }),
        field('outcome', 'Outcome', record && record.outcome, { type: 'select', html: optionList(['no_answer', 'voicemail', 'positive', 'negative', 'neutral'].map(value => ({ value, label: titleCase(value) })), record && record.outcome, 'No outcome') }),
        field('body', 'Notes', record && record.body, { type: 'textarea', wide: true }),
        record ? field('completed', 'Mark as completed', Boolean(record.completed_at), { type: 'checkbox' }) : '',
      ].join('');
    }
    if (type === 'convert') return [
      field('account_id', 'Account', record.account_id, { type: 'select', html: accountOptions(record.account_id), required: true }),
      field('title', 'Deal title', `${record.contact_name} opportunity`, { required: true }),
      field('estimated_value', 'Estimated value', '', { type: 'number', min: 0, step: '0.01' }),
      field('currency', 'Currency', 'USD'),
      field('expected_close_date', 'Expected close', '', { type: 'date' }),
      field('stage_id', 'Pipeline stage', (state.board.columns.find(column => !isFinalStage(column)) || {}).stage_id, { type: 'select', html: stageOptions((state.board.columns.find(column => !isFinalStage(column)) || {}).stage_id), required: true }),
      field('probability_percent', 'Probability %', '10', { type: 'number', min: 0, max: 100 }),
      field('description', 'Description', record.qualification_notes, { type: 'textarea', wide: true }),
    ].join('');
    if (type === 'qualify') return field('qualification_notes', 'Qualification notes', record.qualification_notes, { type: 'textarea', wide: true, rows: 5 });
    if (type === 'lose') return field('lost_reason_code', 'Loss reason', '', { type: 'select', html: optionList(state.reasons.filter(item => item.is_loss_reason).map(item => ({ value: item.code, label: item.name })), '', 'Select reason'), required: true });
    return '';
  }

  function openForm(type, record, context) {
    modalState = { type, record: record || null, context: context || null };
    const names = { opportunity: 'deal', lead: 'lead', account: 'account', activity: 'activity', convert: 'deal conversion', qualify: 'lead qualification', lose: 'lost opportunity' };
    $('modal-eyebrow').textContent = type === 'opportunity' ? 'Pipeline' : 'CRM';
    $('modal-title').textContent = record && !['convert', 'qualify', 'lose'].includes(type) ? `Edit ${names[type]}` : `New ${names[type]}`;
    if (type === 'convert') $('modal-title').textContent = 'Convert lead to deal';
    if (type === 'qualify') $('modal-title').textContent = 'Qualify lead';
    if (type === 'lose') $('modal-title').textContent = 'Close as lost';
    $('modal-save').textContent = type === 'convert' ? 'Convert' : type === 'qualify' ? 'Qualify' : type === 'lose' ? 'Close opportunity' : 'Save';
    $('form-fields').innerHTML = renderForm(type, record, context);
    $('form-error').textContent = '';
    $('record-modal').hidden = false;
    window.setTimeout(() => $('record-form').querySelector('input, select, textarea')?.focus(), 20);
  }

  function closeModal() {
    modalState = null;
    $('record-modal').hidden = true;
    $('record-form').reset();
    $('form-error').textContent = '';
  }

  function formValue(data, name) { return String(data.get(name) || '').trim(); }
  function nullable(value) { return value || null; }

  function formPayload(type, data, existing) {
    if (type === 'opportunity') return {
      ...(!existing ? { account_id: formValue(data, 'account_id') } : {}), title: formValue(data, 'title'), description: formValue(data, 'description'),
      estimated_value: Number(formValue(data, 'estimated_value') || 0), currency: formValue(data, 'currency').toUpperCase(), expected_close_date: nullable(formValue(data, 'expected_close_date')),
      probability_percent: Number(formValue(data, 'probability_percent') || 0), stage_id: formValue(data, 'stage_id'), source: formValue(data, 'source') || 'inbound',
      notes: formValue(data, 'notes'), primary_contact_id: nullable(formValue(data, 'primary_contact_id')),
      ...(existing ? {} : { status: 'open', competitor_names: [] }),
    };
    if (type === 'lead') return {
      contact_name: formValue(data, 'contact_name'), contact_email: nullable(formValue(data, 'contact_email')), contact_phone: nullable(formValue(data, 'contact_phone')),
      account_id: nullable(formValue(data, 'account_id')), source: formValue(data, 'source') || 'inbound', qualification_notes: formValue(data, 'qualification_notes'),
      ...(existing ? {} : { status: 'new' }),
    };
    if (type === 'account') return {
      name: formValue(data, 'name'), industry: nullable(formValue(data, 'industry')), size_category: formValue(data, 'size_category') || 'sme', country: nullable(formValue(data, 'country')),
      website: nullable(formValue(data, 'website')), primary_contact_id: nullable(formValue(data, 'primary_contact_id')), status: formValue(data, 'status') || 'active',
      tags: formValue(data, 'tags').split(',').map(tag => tag.trim()).filter(Boolean), description: formValue(data, 'description'),
    };
    if (type === 'activity') {
      const related = formValue(data, 'related');
      const [relatedType, relatedId] = related ? related.split(':') : [];
      return {
        kind: formValue(data, 'kind') || 'note', subject: formValue(data, 'subject'), body: formValue(data, 'body'),
        due_at: formValue(data, 'due_at') ? new Date(formValue(data, 'due_at')).toISOString() : null,
        outcome: nullable(formValue(data, 'outcome')),
        ...(existing ? { completed_at: data.get('completed') ? (existing.completed_at || new Date().toISOString()) : null } : {}),
        ...(!existing ? {
          account_id: relatedType === 'account' ? relatedId : null,
          lead_id: relatedType === 'lead' ? relatedId : null,
          opportunity_id: relatedType === 'opportunity' ? relatedId : null,
        } : {}),
      };
    }
    if (type === 'convert') return {
      account_id: formValue(data, 'account_id'), title: formValue(data, 'title'), estimated_value: Number(formValue(data, 'estimated_value') || 0),
      currency: formValue(data, 'currency').toUpperCase(), expected_close_date: nullable(formValue(data, 'expected_close_date')), stage_id: formValue(data, 'stage_id'),
      probability_percent: Number(formValue(data, 'probability_percent') || 0), description: formValue(data, 'description'),
    };
    if (type === 'qualify') return { qualification_notes: formValue(data, 'qualification_notes') };
    if (type === 'lose') return { lost_reason_code: formValue(data, 'lost_reason_code'), lost_at: today() };
    return {};
  }

  async function submitForm(event) {
    event.preventDefault();
    if (!modalState) return;
    const { type, record } = modalState;
    const data = new FormData(event.currentTarget);
    const payload = formPayload(type, data, record);
    $('form-error').textContent = '';
    $('modal-save').disabled = true;
    try {
      let result;
      if (['opportunity', 'lead', 'account', 'activity'].includes(type)) {
        const resource = { opportunity: 'opportunities', lead: 'leads', account: 'accounts', activity: 'activities' }[type];
        result = await request(`/api/v1/crm/${resource}/${record ? record.id : ''}`, { method: record ? 'PATCH' : 'POST', body: payload });
      } else if (type === 'convert') {
        result = await request(`/api/v1/crm/leads/${record.id}/convert`, { method: 'POST', body: payload });
      } else if (type === 'qualify') {
        result = await request(`/api/v1/crm/leads/${record.id}/qualify`, { method: 'POST', body: payload });
      } else if (type === 'lose') {
        result = await request(`/api/v1/crm/opportunities/${record.id}/lose`, { method: 'POST', body: payload });
      }
      const openType = type === 'convert' ? 'opportunity' : ['qualify', 'lose'].includes(type) ? (type === 'qualify' ? 'lead' : 'opportunity') : type;
      const openId = (result && result.id) || (record && record.id);
      closeModal();
      await loadData(false);
      if (openId) await openRecord(openType, openId);
      showToast(type === 'convert' ? 'Lead converted to a deal.' : 'CRM record saved.');
    } catch (error) {
      $('form-error').textContent = error.message;
    } finally {
      $('modal-save').disabled = false;
    }
  }

  async function moveOpportunity(id, stageId) {
    const deal = opportunityById(id);
    if (!deal || deal.stage_id === stageId) return;
    try {
      await request(`/api/v1/crm/opportunities/${id}/move-stage`, { method: 'POST', body: { to_stage_id: stageId } });
      await loadData(false);
      if (state.active && state.active.type === 'opportunity' && state.active.id === id) await openRecord('opportunity', id);
      showToast('Deal moved to the new stage.');
    } catch (error) { showToast(error.message, true); }
  }

  async function drawerAction(action) {
    const record = activeRecord();
    if (!record) return;
    const recordType = state.active.type;
    if (action === 'edit') return openForm(state.active.type, record);
    if (action === 'log-activity') return openForm('activity', null, state.active);
    if (action === 'new-deal') return openForm('opportunity', null, { account_id: record.id });
    if (action === 'qualify') return openForm('qualify', record);
    if (action === 'convert') return openForm('convert', record);
    if (action === 'lose') return openForm('lose', record);
    try {
      if (action === 'win') await request(`/api/v1/crm/opportunities/${record.id}/win`, { method: 'POST', body: { won_at: today() } });
      if (action === 'disqualify') await request(`/api/v1/crm/leads/${record.id}/disqualify`, { method: 'POST' });
      if (action === 'complete') await request(`/api/v1/crm/activities/${record.id}`, { method: 'PATCH', body: { completed_at: new Date().toISOString() } });
      await loadData(false);
      await openRecord(recordType, record.id);
      showToast(action === 'win' ? 'Opportunity marked as won.' : action === 'complete' ? 'Activity completed.' : 'Lead disqualified.');
    } catch (error) { showToast(error.message, true); }
  }

  async function loadData(showLoading) {
    if (state.loading) return;
    state.loading = true;
    if (showLoading) $('pipeline-board').innerHTML = '<div class="loading-state">Loading pipeline...</div>';
    try {
      const [dashboard, metrics, board, accounts, leads, activities, contactsPage, reasons] = await Promise.all([
        request('/api/v1/crm/dashboard'), request('/api/v1/crm/pipeline/metrics'), request('/api/v1/crm/pipeline/kanban'),
        request('/api/v1/crm/accounts/?limit=200'), request('/api/v1/crm/leads/?limit=200'), request('/api/v1/crm/activities/?limit=200'),
        optionalRequest('/api/v1/contacts/?limit=500', { items: [] }), optionalRequest('/api/v1/crm/win-loss-reasons/', []),
      ]);
      Object.assign(state, {
        dashboard, metrics, board, accounts, leads, activities,
        contacts: Array.isArray(contactsPage) ? contactsPage : (contactsPage.items || []), reasons,
      });
      renderMetrics();
      renderView();
      if (state.active) renderDrawer();
    } catch (error) {
      if (error.status === 401) {
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      const panel = $(`${state.view}-view`);
      if (panel) panel.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      showToast(error.message, true);
    } finally {
      state.loading = false;
    }
  }

  function contextAdd() {
    const types = { pipeline: 'opportunity', leads: 'lead', accounts: 'account', activities: 'activity' };
    openForm(types[state.view]);
  }

  document.addEventListener('click', event => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) {
      state.view = viewButton.dataset.view;
      state.filter = 'all';
      renderView();
      return;
    }
    const record = event.target.closest('[data-record-type][data-record-id]');
    if (record) { openRecord(record.dataset.recordType, record.dataset.recordId); return; }
    const related = event.target.closest('[data-open-type][data-open-id]');
    if (related) { openRecord(related.dataset.openType, related.dataset.openId); return; }
    const action = event.target.closest('[data-action]');
    if (action && action.dataset.action !== 'move-stage') drawerAction(action.dataset.action);
  });

  $('crm-search').addEventListener('input', event => { state.search = event.target.value.trim().toLowerCase(); renderView(); });
  $('status-filter').addEventListener('change', event => { state.filter = event.target.value; renderView(); });
  $('new-lead-button').addEventListener('click', () => openForm('lead'));
  $('new-deal-button').addEventListener('click', () => openForm('opportunity'));
  $('context-add-button').addEventListener('click', contextAdd);
  $('refresh-button').addEventListener('click', () => loadData(true).then(() => showToast('CRM refreshed.')));
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  $('modal-close').addEventListener('click', closeModal);
  $('modal-cancel').addEventListener('click', closeModal);
  $('record-modal').addEventListener('click', event => { if (event.target === $('record-modal')) closeModal(); });
  $('record-form').addEventListener('submit', submitForm);
  $('record-drawer').addEventListener('change', event => {
    if (event.target.matches('[data-action="move-stage"]') && state.active) moveOpportunity(state.active.id, event.target.value);
  });

  $('pipeline-board').addEventListener('dragstart', event => {
    const card = event.target.closest('.deal-card');
    if (!card || card.getAttribute('draggable') !== 'true') return event.preventDefault();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.recordId);
    card.classList.add('is-dragging');
  });
  $('pipeline-board').addEventListener('dragend', event => {
    event.target.closest('.deal-card')?.classList.remove('is-dragging');
    document.querySelectorAll('.pipeline-column.is-drop-target').forEach(item => item.classList.remove('is-drop-target'));
  });
  $('pipeline-board').addEventListener('dragover', event => {
    const body = event.target.closest('.column-body');
    if (!body || body.dataset.final === 'true') return;
    event.preventDefault();
    document.querySelectorAll('.pipeline-column.is-drop-target').forEach(item => item.classList.remove('is-drop-target'));
    body.closest('.pipeline-column').classList.add('is-drop-target');
  });
  $('pipeline-board').addEventListener('drop', event => {
    const body = event.target.closest('.column-body');
    if (!body || body.dataset.final === 'true') return;
    event.preventDefault();
    moveOpportunity(event.dataTransfer.getData('text/plain'), body.dataset.stageId);
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!$('record-modal').hidden) closeModal();
    else if (state.active) closeDrawer();
  });

  if (!accessToken) window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  else loadData(true);
})();
