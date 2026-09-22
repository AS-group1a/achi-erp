(function () {
  'use strict';

  const API = '/api/v1/achi';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

  // ── Auth (unchanged — the OCE shell's bearer token, refreshed on 401) ──────
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

  // ── Domain constants (mirror schemas.py — STAGES / STATUSES) ──────────────
  // The 7 visual pipeline steps of the dot strip and the board. Every backend
  // stage value maps into one step; on_hold / cancelled are parked, not steps.
  // Board columns = the pipeline. Order is a per-user preference (drag a
  // column header to move it; saved in this browser). Dropping a card on a
  // column applies that column's patch via PATCH /files/{id}.
  const COLS = [
    { id: 'enq',  label: 'Enquiry',     stages: ['prospect', 'outreach', 'first_contact', 'second_follow_up', 'enquiry'], patch: { stage: 'enquiry' } },
    { id: 'sv',   label: 'Site visit',  stages: ['site_survey'], patch: { stage: 'site_survey' } },
    { id: 'dwg',  label: 'Drawing',     stages: ['drawing'], patch: { stage: 'drawing' } },
    { id: 'mt',   label: 'M/T',         stages: ['takeoff'], patch: { stage: 'takeoff' } },
    { id: 'boq',  label: 'BOQ',         stages: ['boq', 'resources', 'plan'], patch: { stage: 'boq' } },
    { id: 'quo',  label: 'Quotation',   stages: ['costing', 'pricing', 'quotation'], patch: { stage: 'quotation' } },
    { id: 'fup',  label: 'Follow-up',   stages: ['follow_up'], patch: { stage: 'follow_up' } },
    { id: 'neg',  label: 'Negotiation', stages: ['negotiation'], patch: { stage: 'negotiation' } },
    { id: 'conf', label: 'Confirmed',   stages: ['accepted'], patch: { stage: 'accepted' } },
    { id: 'job',  label: 'JOB',         stages: [], patch: { stage: 'accepted', status: 'transferred' } },
    { id: 'hold', label: 'On hold',     stages: ['on_hold'], parked: true, patch: { stage: 'on_hold' } },
    { id: 'canc', label: 'Cancelled',   stages: ['cancelled'], parked: true, patch: { stage: 'cancelled' } },
  ];
  const COL_BY_ID = {};
  const STAGE_COL = {};
  COLS.forEach(c => { COL_BY_ID[c.id] = c; c.stages.forEach(s => { STAGE_COL[s] = c.id; }); });

  // Confirmed vs JOB both live on stage "accepted": JOB = handed over
  // (status "transferred"), Confirmed = accepted but not yet transferred.
  const colId = f => (f.stage === 'accepted'
    ? (f.status === 'transferred' ? 'job' : 'conf')
    : (STAGE_COL[f.stage] || 'enq'));
  const isDone = f => f.stage === 'accepted';

  const ORDER_KEY = 'achi.crm.colOrder';
  function loadColOrder() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null'); } catch (_e) { saved = null; }
    const order = Array.isArray(saved) ? saved.filter(id => COL_BY_ID[id]) : [];
    COLS.forEach(c => { if (!order.includes(c.id)) order.push(c.id); });
    return order;
  }
  function saveColOrder() {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(state.colOrder)); } catch (_e) { /* private mode */ }
  }
  // The stage-dot strip follows the user's column order (parked columns and
  // JOB excluded — JOB shares Confirmed's spot in the flow).
  const flowIds = () => state.colOrder.filter(id => !COL_BY_ID[id].parked && id !== 'job');

  const STAGE_LABEL = {
    prospect: 'Prospect', outreach: 'Outreach', follow_up: 'Follow-up',
    first_contact: 'First contact', second_follow_up: '2nd follow-up',
    enquiry: 'Enquiry', site_survey: 'Site visit', drawing: 'Drawing',
    takeoff: 'Takeoff (M/T)', boq: 'BOQ', resources: 'Resources',
    plan: 'Plan', costing: 'Costing', pricing: 'Pricing',
    quotation: 'Quotation', negotiation: 'Negotiation', accepted: 'Confirmed',
    quotation: 'Quotation', negotiation: 'Negotiation', accepted: 'Won',
    cancelled: 'Cancelled', on_hold: 'On hold',
  };
  const STAGE_KEYS = Object.keys(STAGE_LABEL);

  const STATUS_META = {
    open:        { label: 'OPEN',        style: 'background:#eaf1ff;color:#1F3F80' },
    scheduled:   { label: 'SCHEDULED',   style: 'background:#fff4e0;color:#8a5a08' },
    viewed:      { label: 'VIEWED',      style: 'background:#f3edfb;color:#5b21b6' },
    done:        { label: 'DONE',        style: 'background:#dcefe2;color:#14532d' },
    cancelled:   { label: 'CANCELLED',   style: 'background:#fbeaea;color:#b91c1c' },
    transferred: { label: 'TRANSFERRED', style: 'background:#f4f6f9;color:#44546e' },
  };
  const statusMeta = s => STATUS_META[s] || { label: String(s || '—').toUpperCase(), style: 'background:#f4f6f9;color:#44546e' };

  // Docs pills + where each document kind lives, for the panel's links.
  const DOCS = [
    ['srv', 'SRV', `${API}/site-visit/ui`, 'Site visit'],
    ['dwg', 'DWG', `${API}/draw/ui`, 'Drawing'],
    ['mt',  'M/T', `${API}/mt/ui`, 'Measurement / takeoff'],
    ['boq', 'BOQ', `${API}/boq/ui`, 'Bill of quantities'],
    ['cst', 'CST', `${API}/plan/ui`, 'Costing / plan'],
    ['qte', 'QTE', `${API}/quotation/ui`, 'Quotation'],
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    view: 'list',            // list | board
    colOrder: null,          // filled right below (loadColOrder reads storage)
    seg: 'all',              // all | act | due | won | hold | closed
    chips: new Set(),        // stuck | quiet | quo
    q: '',
    fSt: '',                 // status column filter
    sort: { k: 'recv', dir: 'desc' },
    sel: null,               // selected file_id
    dock: 'below',           // below | side
    wide: false,
    tIdx: 2,                 // table height step while panel docked below
  };
  state.colOrder = loadColOrder();
  const HS = [168, 280, 400, 560, 720];

  let RAW = [];              // log rows as returned by /logs/
  let FILES = [];            // one entry per enquiry file (grouped client-side)
  let TOTAL_LOGS = 0;

  // ── Dates ──────────────────────────────────────────────────────────────────
  const DAY = 86400000;
  const parseTs = v => { const t = v ? new Date(v).getTime() : NaN; return Number.isNaN(t) ? null : t; };
  const fmtDM = ts => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const fmtFull = ts => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  const todayYmd = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fmtYmd = ymd => {
    if (!ymd) return '—';
    const [y, m, d] = String(ymd).split('-');
    return d && m ? `${d}/${m}/${y ? y.slice(2) : ''}` : String(ymd);
  };

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  // ── Grouping: /logs/ returns one row per log; the CRM shows one per file ───
  function groupFiles(rows) {
    const map = new Map();
    for (const r of rows) {
      let f = map.get(r.file_id);
      if (!f) {
        f = { fid: r.file_id, logs: [] };
        map.set(r.file_id, f);
      }
      f.logs.push(r);
    }
    const today = todayYmd();
    const files = [];
    for (const f of map.values()) {
      f.logs.sort((a, b) => (parseTs(b.occurred_at || b.created_at) || 0) - (parseTs(a.occurred_at || a.created_at) || 0));
      const lead = f.logs[0];
      const times = f.logs.map(l => parseTs(l.occurred_at || l.created_at)).filter(Boolean);
      const recvAt = times.length ? Math.min(...times) : null;
      const lastLogAt = times.length ? Math.max(...times) : null;

      // Follow-up: the next scheduled one, else the most recent overdue one.
      const fus = f.logs
        .filter(l => l.follow_up_date)
        .map(l => ({ date: String(l.follow_up_date), notes: l.follow_up_notes || '' }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const upcoming = fus.find(x => x.date >= today);
      const fu = upcoming || (fus.length ? fus[fus.length - 1] : null);
      if (fu) fu.overdue = fu.date < today;

      // Docs + deliverables are per log; the file has a doc if any log does.
      const docs = { srv: false, dwg: false, mt: false, boq: false, cst: false, qte: false };
      const deliverables = new Set();
      for (const l of f.logs) {
        const d = l.docs || {};
        for (const k of Object.keys(docs)) if (d[k]) docs[k] = true;
        for (const item of (l.deliverables || [])) deliverables.add(String(item));
      }

      files.push({
        fid: f.fid,
        code: lead.file_number || '',
        logCode: lead.log_code || null,
        origin: lead.origin_module || null,
        stage: lead.stage,
        status: lead.status,
        parked: lead.stage === 'on_hold' || lead.stage === 'cancelled',
        subject: lead.subject || '',
        category: lead.category || null,
        description: lead.description || '',
        contact: {
          id: lead.contact_id, name: lead.contact_name || '', prefix: lead.prefix || '',
          first: lead.first_name || '', last: lead.last_name || '',
          company: lead.company_name || '', role: lead.role || '',
          companyType: lead.company_type || '',
          mobile: lead.mobile || '', email: lead.email || '', emailSent: Boolean(lead.email_sent),
          phones: Array.isArray(lead.phones) ? lead.phones : [],
          emails: Array.isArray(lead.emails) ? lead.emails : [],
          related: Array.isArray(lead.related_contacts) ? lead.related_contacts : [],
        },
        site: {
          location: lead.site_location || '', street: lead.street || '', city: lead.city || '',
          district: lead.district || '', country: lead.country || '',
          number: lead.site_number || '', building: lead.site_building || '', floor: lead.site_floor || '',
          maps: lead.maps_url || '',
        },
        ownerName: lead.owner_name || '', assignedName: lead.assigned_name || '',
        recvAt, lastLogAt, fu,
        docs, deliverables: [...deliverables],
        commCounts: lead.comm_counts || null, commTotal: lead.comm_total || 0,
        lastTouchAt: parseTs(lead.last_touch_at), lastTouchChannel: lead.last_touch_channel || '',
        logCount: f.logs.length,
        logs: f.logs,
      });
    }
    files.sort((a, b) => (b.recvAt || 0) - (a.recvAt || 0));
    return files;
  }

  // ── Derived flags + filtering ──────────────────────────────────────────────
  const isHot = f => Boolean(f.fu && f.fu.overdue) || Boolean(f.fu && f.fu.date === todayYmd());
  const isQuiet = f => {
    if (isDone(f) || f.parked) return false;
    const t = f.lastTouchAt || f.lastLogAt;
    return !t || (Date.now() - t) > 7 * DAY;
  };
  const isOpenPipe = f => !f.parked && !isDone(f) && ['open', 'scheduled', 'viewed'].includes(f.status);

  function chipMatch(f) {
    if (!state.chips.size) return true;
    if (state.chips.has('stuck') && !isHot(f)) return false;
    if (state.chips.has('quiet') && !isQuiet(f)) return false;
    if (state.chips.has('quo') && colId(f) !== 'quo') return false;
    return true;
  }

  // The ask-box honours the mock's example questions without pretending to be
  // an LLM: a recognised phrase becomes the matching live filter.
  const MAGIC = [
    [/\bstuck\b|\bneed(s)? action\b|\boverdue\b/, f => isHot(f)],
    [/\bquiet\b|\bgone quiet\b/, f => isQuiet(f)],
    [/\bquotation\b|\bclos(e|ing)\b/, f => colId(f) === 'quo'],
    [/\bquotation\b|\bclos(e|ing)\b/, f => f.step === 5],
    [/\bwon\b|\baccepted\b/, f => f.stage === 'accepted'],
    [/\bon hold\b/, f => f.stage === 'on_hold'],
  ];
  const magicFor = q => { const hit = MAGIC.find(([re]) => re.test(q)); return hit ? hit[1] : null; };

  function textMatch(f) {
    if (!state.q) return true;
    const magic = magicFor(state.q);
    if (magic) return magic(f);
    const hay = [
      f.code, f.logCode, f.subject, f.category, f.description,
      f.contact.name, f.contact.company, f.contact.mobile, f.contact.email,
      f.site.location, f.site.city, f.site.district, f.site.country, f.site.street,
      f.ownerName, f.assignedName, f.stage, f.status, STAGE_LABEL[f.stage],
    ].join(' ').toLowerCase();
    return hay.includes(state.q);
  }

  function visibleFiles() {
    let list = FILES.filter(f => chipMatch(f) && textMatch(f));
    if (state.fSt) list = list.filter(f => f.status === state.fSt);
    const dir = state.sort.dir === 'asc' ? 1 : -1;
    const key = state.sort.k === 'age'
      ? f => (f.recvAt ? Date.now() - f.recvAt : -1)
      : f => (f.recvAt || 0);
    list = [...list].sort((a, b) => {
      const x = key(a); const y = key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    return list;
  }

  // ── Cell renderers ─────────────────────────────────────────────────────────
  function stageDots(f) {
    const flow = flowIds();
    if (f.parked) {
      const grey = flow.map(() => '<span></span>').join('');
      return `<div class="stage">${grey}</div><span class="stage-badge">${esc((STAGE_LABEL[f.stage] || f.stage).toUpperCase())}</span>`;
    }
    const idx = flow.indexOf(colId(f) === 'job' ? 'conf' : colId(f));
    const done = isDone(f);
    const dots = flow.map((_, i) => {
      const cls = done ? 'won' : i < idx ? 'on' : i === idx ? 'cur' : '';
      return `<span class="${cls}"></span>`;
    }).join('');
    return `<div class="stage" title="${esc(STAGE_LABEL[f.stage] || f.stage)}">${dots}</div>`;
  }

  function stageCell(f) {
    const options = STAGE_KEYS.map(k =>
      `<option value="${k}"${k === f.stage ? ' selected' : ''}>${esc(STAGE_LABEL[k])}</option>`).join('');
    return `<span class="stw" title="Change stage — ${esc(STAGE_LABEL[f.stage] || f.stage)}">${stageDots(f)}`
      + `<i class="farr">▾</i><select class="stover" data-act="stage" data-fid="${esc(f.fid)}">${options}</select></span>`;
  }

  function statusCell(f) {
    const meta = statusMeta(f.status);
    const options = Object.keys(STATUS_META).map(k =>
      `<option value="${k}"${k === f.status ? ' selected' : ''}>${esc(STATUS_META[k].label)}</option>`).join('');
    return `<span class="st stw" style="${meta.style}">${esc(meta.label)} <i class="farr">▾</i>`
      + `<select class="stover" data-act="status" data-fid="${esc(f.fid)}">${options}</select></span>`;
  }

  function docsCell(f) {
    return `<div class="docs">${DOCS.map(([k, label]) =>
      `<span class="doc${f.docs[k] ? ' on' : ''}">${label}</span>`).join('')}</div>`;
  }

  function clientCell(f) {
    const main = f.contact.company || f.contact.name || '';
    const person = [f.contact.prefix, f.contact.first, f.contact.last].filter(Boolean).join(' ').trim();
    const sub = f.contact.company
      ? [person, f.contact.role].filter(Boolean).join(' — ')
      : (f.contact.role || f.contact.mobile || '');
    if (!main) return '<span class="mut">—</span>';
    return `<div style="line-height:1.15"><span class="nm-main">${esc(main)}</span>`
      + (sub ? `<div class="nm-sub">${esc(sub)}</div>` : '') + '</div>';
  }

  function subjectCell(f) {
    const site = [f.site.city, f.site.location].filter(Boolean).join(' — ');
    return `<div style="line-height:1.15"><span style="font-size:11px">${f.subject ? esc(f.subject) : '<span class="mut">—</span>'}</span>`
      + (site ? `<div class="nm-sub">${esc(site)}</div>` : '') + '</div>';
  }

  function nextCell(f) {
    if (!f.fu) return '<span class="mut">—</span>';
    const cls = f.fu.overdue ? 'fu-red' : 'mut';
    const label = f.fu.notes ? esc(f.fu.notes) : 'Follow-up';
    return `<span class="${cls}" style="font-size:10.5px" title="${esc(f.fu.notes || '')}">`
      + `${label} · ${esc(fmtYmd(f.fu.date))}${f.fu.overdue ? ' ⚠' : ''}</span>`;
  }

  function ageCell(f) {
    if (!f.recvAt) return '<span class="mut">—</span>';
    const days = Math.max(0, Math.floor((Date.now() - f.recvAt) / DAY));
    const color = isHot(f) ? '#b91c1c' : '#8a8f98';
    return `<span class="num" style="font-size:10px;color:${color}">${days}d${isHot(f) ? ' ⚠' : ''}</span>`;
  }

  // ── Grid ───────────────────────────────────────────────────────────────────
  function renderHead() {
    const arrow = k => (state.sort.k === k ? (state.sort.dir === 'asc' ? '▲' : '▼') : '↕');
    const statuses = [...new Set(FILES.map(f => f.status))];
    const options = ['<option value="">All statuses</option>']
      .concat(statuses.map(s => `<option value="${esc(s)}"${state.fSt === s ? ' selected' : ''}>${esc(statusMeta(s).label)}</option>`))
      .join('');
    $('hd').innerHTML =
      '<span>Code</span>'
      + `<span class="srt" data-sort="recv">Received<i class="sarr2">${arrow('recv')}</i></span>`
      + '<span>Client</span>'
      + '<span>Subject / site</span>'
      + '<span>Stage E·S·D·M·B·Q·W</span>'
      + '<span>Docs</span>'
      + '<span>Next action</span>'
      + '<span>Own</span>'
      + `<span class="srt" data-sort="age">Age<i class="sarr2">${arrow('age')}</i></span>`
      + `<span class="flt${state.fSt ? ' on' : ''}">Status <i class="farr">▾</i>${state.fSt ? ' · ' + esc(statusMeta(state.fSt).label) : ''}`
      + `<select class="stover" data-act="fst" title="Filter by status">${options}</select></span>`;
  }

  function rowHTML(f) {
    const cls = (state.sel === f.fid ? 'sel ' : '') + (isHot(f) ? 'hot' : '');
    return `<div class="row ${cls}" data-fid="${esc(f.fid)}">`
      + `<div><span class="code">${esc(f.code)}</span></div>`
      + `<div class="mut num" style="font-size:10.5px">${esc(fmtDM(f.recvAt))}</div>`
      + `<div>${clientCell(f)}</div>`
      + `<div>${subjectCell(f)}</div>`
      + `<div>${stageCell(f)}</div>`
      + `<div>${docsCell(f)}</div>`
      + `<div>${nextCell(f)}</div>`
      + `<div><span class="who" title="${esc(f.ownerName || '')}">${esc(initials(f.ownerName))}</span></div>`
      + `<div>${ageCell(f)}</div>`
      + `<div>${statusCell(f)}</div>`
      + '</div>';
  }

  function renderRows() {
    const list = visibleFiles();
    const body = $('rows');
    if (!FILES.length) {
      body.innerHTML = '<div class="row"><div class="empty">No CRM records yet — log a call or add a prospect.</div></div>';
    } else if (!list.length) {
      body.innerHTML = '<div class="row"><div class="empty">No enquiries match the current filters.</div></div>';
    } else {
      body.innerHTML = list.map(rowHTML).join('');
    }
    $('foot').innerHTML = `<span>${list.length} shown</span><span>·</span>`
      + `<span>${FILES.length} enquiries, ${TOTAL_LOGS} log entries</span>`
      + '<span style="flex:1"></span><span>click a line for the full picture — stage and status change inline</span>';
  }

  // ── Board ──────────────────────────────────────────────────────────────────
  function boardCard(f) {
    const meta = statusMeta(f.status);
    return `<div class="bcard${state.sel === f.fid ? ' sel' : ''}" draggable="true" data-fid="${esc(f.fid)}">`
      + `<div class="bc-top"><span class="code">${esc(f.code)}</span>${ageCell(f)}</div>`
      + `<div class="bc-client">${esc(f.contact.company || f.contact.name || '—')}</div>`
      + (f.subject ? `<div class="bc-subj">${esc(f.subject)}</div>` : '')
      + `<div class="bc-bot"><span class="who" title="${esc(f.ownerName || '')}">${esc(initials(f.ownerName))}</span>`
      + `<span class="st" style="${meta.style}">${esc(meta.label)}</span></div>`
      + '</div>';
  }

  function renderBoard() {
    const list = visibleFiles();
    const board = $('board');
    board.style.gridTemplateColumns = `repeat(${state.colOrder.length}, minmax(168px, 1fr))`;
    board.style.minWidth = `${state.colOrder.length * 176}px`;
    board.innerHTML = state.colOrder.map(id => {
      const col = COL_BY_ID[id];
      const items = list.filter(f => colId(f) === id);
      return `<div class="bcol" data-col="${id}">`
        + `<div class="bch" draggable="true" data-col="${id}" title="Drag to reorder columns">⠿ ${esc(col.label)}<span class="n2">${items.length}</span></div>`
        + (items.length ? items.map(boardCard).join('') : '<div class="bempty">drop here</div>')
        + '</div>';
    }).join('');
  }

  // ── Drag & drop: cards move enquiries between stages, headers reorder ──────
  let dragging = null;      // { kind: 'card', fid } | { kind: 'col', id }
  let dropCol = null;
  function clearDrop() { if (dropCol && dropCol.classList) dropCol.classList.remove('drop'); dropCol = null; }
  const boardEl = $('board');

  boardEl.addEventListener('dragstart', event => {
    const head = event.target.closest('.bch[data-col]');
    const card = head ? null : event.target.closest('.bcard[data-fid]');
    if (head) dragging = { kind: 'col', id: head.dataset.col };
    else if (card) dragging = { kind: 'card', fid: card.dataset.fid };
    else return;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', ''); } catch (_e) { /* old engines */ }
    }
    if (card && card.classList) card.classList.add('dragging');
  });

  boardEl.addEventListener('dragover', event => {
    if (!dragging) return;
    const col = event.target.closest('.bcol[data-col]');
    if (!col) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (col !== dropCol) { clearDrop(); dropCol = col; if (col.classList) col.classList.add('drop'); }
  });

  boardEl.addEventListener('drop', event => {
    const col = event.target.closest('.bcol[data-col]');
    if (!col || !dragging) return;
    event.preventDefault();
    const targetId = col.dataset.col;
    const d = dragging;
    dragging = null;
    clearDrop();
    if (d.kind === 'col') {
      if (d.id === targetId) return;
      const order = state.colOrder.filter(id => id !== d.id);
      order.splice(order.indexOf(targetId), 0, d.id);
      state.colOrder = order;
      saveColOrder();
      renderBoard();
      return;
    }
    const f = FILES.find(x => x.fid === d.fid);
    if (!f || colId(f) === targetId) return;
    const patch = { ...COL_BY_ID[targetId].patch };
    if (targetId === 'conf' && f.status === 'transferred') patch.status = 'open';
    patchFile(d.fid, patch, 'Stage');
  });

  boardEl.addEventListener('dragend', () => { dragging = null; clearDrop(); });

  // ── KPI chips ──────────────────────────────────────────────────────────────
  function renderKchips() {
    const open = FILES.filter(isOpenPipe).length;
    const quo = FILES.filter(f => colId(f) === 'quo').length;
    const won = FILES.filter(f => f.stage === 'accepted').length;
    const due = FILES.filter(isHot).length;
    const quiet = FILES.filter(isQuiet).length;
    const year = new Date().getFullYear();
    const inYear = FILES.filter(f => f.recvAt && new Date(f.recvAt).getFullYear() === year);
    const yWon = inYear.filter(f => f.stage === 'accepted').length;
    const yLost = inYear.filter(f => f.stage === 'cancelled').length;
    const rateChip = (yWon + yLost) > 0
      ? `<span class="kc"><b>${Math.round((yWon / (yWon + yLost)) * 100)}%</b> win rate ${year}</span>`
      : '';
    $('kchips').innerHTML =
      `<span class="kc"><b>${open}</b> open enquiries</span>`
      + `<span class="kc"><b>${quo}</b> at quotation stage</span>`
      + `<span class="kc"><b>${won}</b> won</span>`
      + `<span class="kc"><b>${quiet}</b> gone quiet 7d+</span>`
      + rateChip
      + `<span class="kc${due ? ' alert' : ''}"><b>${due}</b> need action today</span>`;
  }

  // ── Detail panel ───────────────────────────────────────────────────────────
  const kvRow = (k, v) => (v ? `<div class="k">${esc(k)}</div><div class="v">${v}</div>` : '');

  function panelHTML(f) {
    const c = f.contact; const s = f.site;
    const person = [c.prefix, c.first, c.last].filter(Boolean).join(' ').trim() || c.name;
    const phones = c.phones.length ? c.phones : (c.mobile ? [{ label: 'Mobile', number: c.mobile }] : []);
    const emails = c.emails.length ? c.emails : (c.email ? [{ label: 'Primary', address: c.email }] : []);
    const meta = statusMeta(f.status);
    const siteLine = [s.location, s.street, [s.building, s.floor, s.number].filter(Boolean).join(' · ')].filter(Boolean);
    const place = [s.city, s.district, s.country].filter(Boolean).join(', ');

    const clientSec = `<div class="sec"><div class="sech">Client${c.id ? `<a href="${API}/contact-info/ui">open Contacts ↗</a>` : ''}</div><div class="kv">`
      + kvRow('Company', c.company ? esc(c.company) : '')
      + kvRow('Contact', person ? esc(person) : '')
      + kvRow('Role', c.role ? esc(c.role) : '')
      + phones.map(p => kvRow(p.label || 'Phone', `<a href="tel:${esc(String(p.number).replace(/\s+/g, ''))}">${esc(p.number)}</a>`)).join('')
      + emails.map(e => kvRow(e.label || 'Email', `<a href="mailto:${esc(e.address)}">${esc(e.address)}</a>${c.emailSent ? ' <span class="mut" style="font-size:9px">· emailed before</span>' : ''}`)).join('')
      + (c.related.length ? kvRow('Also', esc(c.related.map(r => r.name || [r.first_name, r.last_name].filter(Boolean).join(' ')).filter(Boolean).join(' · '))) : '')
      + '</div></div>';

    const enqSec = `<div class="sec"><div class="sech">Enquiry<span class="sech-r mut">${esc(f.logCount)} log${f.logCount === 1 ? '' : 's'}</span></div><div class="kv">`
      + kvRow('Subject', f.subject ? esc(f.subject) : '')
      + kvRow('Category', f.category ? esc(f.category) : '')
      + kvRow('Received', esc(fmtFull(f.recvAt)))
      + kvRow('Stage', esc(STAGE_LABEL[f.stage] || f.stage))
      + kvRow('Owner', f.ownerName ? esc(f.ownerName) : '')
      + kvRow('Assigned', f.assignedName ? esc(f.assignedName) : '')
      + kvRow('Follow-up', f.fu ? `<span class="${f.fu.overdue ? 'fu-red' : ''}">${esc(fmtYmd(f.fu.date))}${f.fu.overdue ? ' ⚠ overdue' : ''}</span>${f.fu.notes ? ` — ${esc(f.fu.notes)}` : ''}` : '')
      + kvRow('Details', f.description ? esc(f.description) : '')
      + '</div></div>';

    const siteSec = (siteLine.length || place || s.maps)
      ? `<div class="sec"><div class="sech">Site${s.maps ? `<a href="${esc(s.maps)}" target="_blank" rel="noopener">open map ↗</a>` : ''}</div><div class="kv">`
        + kvRow('Location', siteLine.length ? esc(siteLine.join(' · ')) : '')
        + kvRow('Area', place ? esc(place) : '')
        + '</div></div>'
      : '';

    const docsRows = DOCS.map(([k, label, href, name]) =>
      `<tr><td class="tw"><span class="doc${f.docs[k] ? ' on' : ''}">${label}</span></td>`
      + `<td>${esc(name)}</td>`
      + `<td class="tw" style="text-align:right">${f.docs[k] ? `<a href="${href}">open ↗</a>` : '<span class="mut">—</span>'}</td></tr>`).join('');
    const docsSec = `<div class="sec"><div class="sech">Documents${f.deliverables.length ? `<span class="sech-r mut">${esc(f.deliverables.join(', '))}</span>` : ''}</div>`
      + `<table class="t">${docsRows}</table></div>`;

    const commPills = f.commCounts
      ? Object.entries(f.commCounts).map(([k, n]) => `<span class="commpill">${esc(k)} · ${esc(n)}</span>`).join('')
      : '';
    const logRows = f.logs.slice(0, 12).map(l =>
      `<tr><td class="tw mut num" style="font-size:10px">${esc(fmtDM(parseTs(l.occurred_at || l.created_at)))}</td>`
      + `<td class="tw"><span class="st" style="background:#eef2f8;color:#44546e">${esc((l.communication || l.log_type || '—').toUpperCase())}</span></td>`
      + `<td>${esc(l.description || l.subject || '—')}</td></tr>`).join('');
    const actSec = `<div class="sec"><div class="sech">Activity`
      + `<span class="sech-r mut">${f.lastTouchAt ? `last touch ${esc(fmtDM(f.lastTouchAt))}${f.lastTouchChannel ? ' · ' + esc(f.lastTouchChannel) : ''}` : ''}</span></div>`
      + (commPills ? `<div class="commrow">${commPills}</div>` : '')
      + `<table class="t">${logRows || '<tr><td class="mut">No log entries.</td></tr>'}</table>`
      + `<div class="commrow"><a class="mini" href="${API}/ui">open in Log ↗</a></div></div>`;

    const sizeCtl = state.dock === 'below'
      ? `<button class="szb" data-pact="smaller" title="Shrink table">−</button>`
        + `<button class="szb" data-pact="bigger" title="Grow table">+</button>`
      : `<button class="szb" data-pact="wide" title="${state.wide ? 'Narrower panel' : 'Wider panel'}">${state.wide ? '⇤' : '⇥'}</button>`;

    return `<div class="dph"><span class="code">${esc(f.code)}</span><b>${esc(c.company || c.name || f.subject || 'Enquiry')}</b>`
      + `<span class="st" style="${meta.style}">${esc(meta.label)}</span>`
      + '<span style="flex:1"></span>'
      + sizeCtl
      + `<button class="dpx" data-pact="dock" title="${state.dock === 'below' ? 'Dock to the side' : 'Dock under the table'}">${state.dock === 'below' ? '⤞' : '⤓'}</button>`
      + '<button class="dpx" data-pact="close" title="Close"><svg><use href="#i-x"/></svg></button></div>'
      + `<div class="dpb">${clientSec}${enqSec}${siteSec}${docsSec}${actSec}</div>`;
  }

  function applyLayout() {
    const pg = $('pg');
    const panelOpen = Boolean(state.sel);
    pg.classList.toggle('side', panelOpen && state.dock === 'side');
    pg.classList.toggle('wide', panelOpen && state.dock === 'side' && state.wide);
    const wrap = $('list-wrap');
    const shrink = panelOpen && state.dock === 'below' && state.view === 'list';
    wrap.classList.toggle('shrink', shrink);
    wrap.style.maxHeight = shrink ? `${HS[state.tIdx]}px` : '';
  }

  function renderPanel() {
    const panel = $('panel');
    const f = state.sel ? FILES.find(x => x.fid === state.sel) : null;
    if (!f) {
      state.sel = null;
      panel.hidden = true;
      panel.innerHTML = '';
    } else {
      panel.hidden = false;
      panel.innerHTML = panelHTML(f);
    }
    applyLayout();
  }

  // ── Render everything that depends on data / filters ──────────────────────
  function renderViews() {
    $('list-wrap').hidden = state.view !== 'list';
    $('board-wrap').hidden = state.view !== 'board';
    if (state.view === 'list') { renderHead(); renderRows(); } else { renderBoard(); }
    applyLayout();
  }

  function renderAll() {
    renderKchips();
    renderViews();
    renderPanel();
  }

  // ── Load: pull every page of /logs/ (server caps a page at 1000) ───────────
  async function load() {
    $('rows').innerHTML = '<div class="row"><div class="empty">Loading…</div></div>';
    try {
      const rows = [];
      let offset = 0;
      let total = 0;
      for (let page = 0; page < 5; page += 1) {
        const data = await request(`${API}/logs/?limit=1000&offset=${offset}`);
        const items = Array.isArray(data && data.items) ? data.items : (Array.isArray(data) ? data : []);
        rows.push(...items);
        total = (data && typeof data.total === 'number') ? data.total : rows.length;
        offset += items.length;
        if (!items.length || rows.length >= total) break;
      }
      RAW = rows;
      TOTAL_LOGS = total || rows.length;
      FILES = groupFiles(RAW);
      renderAll();
    } catch (error) {
      $('rows').innerHTML = `<div class="row"><div class="empty">Couldn’t load records: ${esc(error.message || 'error')}</div></div>`;
    }
  }

  // ── Inline edits: PATCH /files/{id} — stage or status ──────────────────────
  async function patchFile(fid, patch, label) {
    try {
      await request(`${API}/files/${encodeURIComponent(fid)}`, { method: 'PATCH', body: patch });
      RAW.forEach(r => { if (r.file_id === fid) Object.assign(r, patch); });
      FILES = groupFiles(RAW);
      renderAll();
      showToast(`${label} updated.`);
    } catch (error) {
      renderAll(); // put the selects back to server truth
      showToast(error.message || `Could not update ${label.toLowerCase()}.`, true);
    }
  }

  // ── New Prospect (unchanged behaviour — POST /logs/) ───────────────────────
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
      showToast('Enquiry added.');
      await load();
    } catch (error) {
      $('prospect-error').textContent = error.message || 'Could not add the enquiry.';
    } finally {
      save.disabled = false;
      save.textContent = label;
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  function selectFile(fid) {
    state.sel = state.sel === fid ? null : fid;
    renderViews();
    renderPanel();
    if (state.sel && state.dock === 'below') $('panel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  document.addEventListener('change', event => {
    const sel = event.target.closest('select.stover');
    if (!sel) return;
    event.stopPropagation();
    if (sel.dataset.act === 'stage') patchFile(sel.dataset.fid, { stage: sel.value }, 'Stage');
    else if (sel.dataset.act === 'status') patchFile(sel.dataset.fid, { status: sel.value }, 'Status');
    else if (sel.dataset.act === 'fst') { state.fSt = sel.value; renderViews(); }
  });

  $('rows').addEventListener('click', event => {
    if (event.target.closest('.stw') || event.target.closest('a')) return;
    const row = event.target.closest('.row[data-fid]');
    if (row) selectFile(row.dataset.fid);
  });

  $('hd').addEventListener('click', event => {
    if (event.target.closest('.stover')) return;
    const srt = event.target.closest('[data-sort]');
    if (!srt) return;
    const k = srt.dataset.sort;
    state.sort = { k, dir: state.sort.k === k && state.sort.dir === 'desc' ? 'asc' : 'desc' };
    renderViews();
  });

  $('board').addEventListener('click', event => {
    const card = event.target.closest('.bcard[data-fid]');
    if (card) selectFile(card.dataset.fid);
  });

  $('panel').addEventListener('click', event => {
    const btn = event.target.closest('[data-pact]');
    if (!btn) return;
    const act = btn.dataset.pact;
    if (act === 'close') { state.sel = null; state.wide = false; renderViews(); renderPanel(); }
    else if (act === 'dock') { state.dock = state.dock === 'below' ? 'side' : 'below'; renderPanel(); }
    else if (act === 'wide') { state.wide = !state.wide; renderPanel(); }
    else if (act === 'smaller') { state.tIdx = Math.max(0, state.tIdx - 1); applyLayout(); }
    else if (act === 'bigger') { state.tIdx = Math.min(HS.length - 1, state.tIdx + 1); applyLayout(); }
  });

  $('seg-filters').addEventListener('click', event => {
    const btn = event.target.closest('button[data-seg]');
    if (!btn) return;
    state.seg = btn.dataset.seg;
    [...$('seg-filters').children].forEach(b => b.classList.toggle('on', b === btn));
    renderViews();
  });

  $('seg-view').addEventListener('click', event => {
    const btn = event.target.closest('button[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    [...$('seg-view').children].forEach(b => b.classList.toggle('on', b === btn));
    renderViews();
  });

  document.querySelectorAll('.ai .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.chip;
      if (state.chips.has(key)) state.chips.delete(key); else state.chips.add(key);
      chip.classList.toggle('on', state.chips.has(key));
      renderViews();
    });
  });

  const searchBar = $('crm-search');
  const searchAi = $('ai-q');
  function setQuery(value, from) {
    state.q = value.trim().toLowerCase();
    if (from !== searchBar && searchBar) searchBar.value = value;
    if (from !== searchAi && searchAi) searchAi.value = value;
    renderViews();
  }
  if (searchBar) searchBar.addEventListener('input', e => setQuery(e.target.value, searchBar));
  if (searchAi) searchAi.addEventListener('input', e => setQuery(e.target.value, searchAi));

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

  // ── Boot ───────────────────────────────────────────────────────────────────
  renderHead();
  load();
})();