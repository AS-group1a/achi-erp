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
  const isDone = f => f.stage === 'accepted';

  // Board columns = the eight stages of STAGE_PICK (below). Order is a per-user
  // preference (drag a column header to move it; saved in this browser). The
  // key is new: orders saved for the old 12-column board don't apply.
  const ORDER_KEY = 'achi.crm.colOrder.v2';
  function loadColOrder() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null'); } catch (_e) { saved = null; }
    const order = Array.isArray(saved) ? saved.filter(id => STAGE_PICK_BY_ID[id]) : [];
    STAGE_PICK.forEach(p => { if (!order.includes(p.id)) order.push(p.id); });
    return order;
  }
  function saveColOrder() {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(state.colOrder)); } catch (_e) { /* private mode */ }
  }
  // Stage column of the grid: one dropdown per row, and the same list (plus
  // "All stages") as the header filter. Each step groups the backend stages it
  // covers; picking a step saves its `value`. "Log" is the pre-enquiry first
  // contact (prospect … 2nd follow-up); "Won → JOB" is stage "accepted".
  // Stages outside these steps (follow-up, negotiation, on hold, cancelled) show
  // their own name in the row's dropdown and appear only under "All stages".
  const STAGE_PICK = [
    { id: 'log',       label: 'Log',        stages: ['prospect', 'outreach', 'first_contact', 'second_follow_up'], value: 'first_contact' },
    { id: 'enquiry',   label: 'Enquiry',    stages: ['enquiry'], value: 'enquiry' },
    { id: 'site',      label: 'Site visit', stages: ['site_survey'], value: 'site_survey' },
    { id: 'drawing',   label: 'Drawing',    stages: ['drawing'], value: 'drawing' },
    { id: 'mt',        label: 'M/T',        stages: ['takeoff'], value: 'takeoff' },
    { id: 'boq',       label: 'BOQ',        stages: ['boq', 'resources', 'plan'], value: 'boq' },
    { id: 'quotation', label: 'Quotation',  stages: ['costing', 'pricing', 'quotation'], value: 'quotation' },
    { id: 'won',       label: 'Won → JOB',  stages: ['accepted'], value: 'accepted' },
  ];
  const STAGE_PICK_OF = {};
  const STAGE_PICK_BY_ID = {};
  STAGE_PICK.forEach(p => { STAGE_PICK_BY_ID[p.id] = p; p.stages.forEach(s => { STAGE_PICK_OF[s] = p; }); });
  // Which of the eight stages an enquiry is in ('' for follow-up, negotiation,
  // on hold, cancelled — those have no board column).
  const pickId = f => (STAGE_PICK_OF[f.stage] ? STAGE_PICK_OF[f.stage].id : '');

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

  const STATUS_META = {
    open:        { label: 'OPEN',        style: 'background:#eaf1ff;color:#1F3F80' },
    scheduled:   { label: 'SCHEDULED',   style: 'background:#fff4e0;color:#8a5a08' },
    viewed:      { label: 'VIEWED',      style: 'background:#f3edfb;color:#5b21b6' },
    done:        { label: 'DONE',        style: 'background:#dcefe2;color:#14532d' },
    cancelled:   { label: 'CANCELLED',   style: 'background:#fbeaea;color:#b91c1c' },
    transferred: { label: 'TRANSFERRED', style: 'background:#f4f6f9;color:#44546e' },
  };
  // The statuses the grid's Status column offers (row dropdown + header filter).
  const STATUS_PICK = ['open', 'scheduled', 'viewed', 'done', 'cancelled'];
  // Colours only (background-color, not the `background` shorthand) so the
  // pill's chevron background-image from crm.css survives the inline style.
  const statusPillStyle = s => statusMeta(s).style.replace(/background:/g, 'background-color:');
  const statusMeta = s => STATUS_META[s] || { label: String(s || '—').toUpperCase(), style: 'background:#f4f6f9;color:#44546e' };

  // Docs pills + where each document kind lives, for the panel's links.
  const DOCS = [
    ['srv', 'SRV', `${API}/survey/ui`, 'Site visit'],
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
    q: '',
    fSt: '',                 // status column filter
    fStage: '',              // stage column filter (a STAGE_PICK id)
    fCl: '',                 // client / lead column filter: '' | 'lead' | 'client'
    sort: { k: 'recv', dir: 'desc' },
    sel: null,               // selected file_id
    dock: 'below',           // below | side
    wide: false,
    tIdx: 2,                 // table height step while panel docked below
    day: '',                 // My day: '' = all days, else YYYY-MM-DD
    mine: false,             // My day: only enquiries I own / am assigned
    me: '',                  // current user's full name (for "Only mine")
    calMonth: '',            // Calendar view month, YYYY-MM
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
  // Received column: dd/mm/yyyy.
  const fmtDMY = ts => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  };
  // Enquiry code shown in the CRM: the file number's running sequence as
  // ENQ-00001 (file_number is ACHI-YYYY-NNNNN). Anything else shows unchanged.
  const enqCode = fileNumber => {
    const raw = String(fileNumber || '').trim();
    const match = raw.match(/-(\d+)$/);
    return match ? `ENQ-${match[1].padStart(5, '0')}` : raw;
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
  const LOGTYPE_DOC = {
    'site visit': 'srv', drawing: 'dwg', 'm/t': 'mt', boq: 'boq',
    'costing / plan': 'cst', plan: 'cst', quotation: 'qte',
  };
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
        // A module added under the ENQ (New ENQ popup) is a log typed with its name.
        const mod = LOGTYPE_DOC[String(l.log_type || '').toLowerCase()];
        if (mod) docs[mod] = true;
        for (const item of (l.deliverables || [])) deliverables.add(String(item));
      }

      files.push({
        fid: f.fid,
        code: enqCode(lead.file_number),
        fileNumber: lead.file_number || '',
        logCode: lead.log_code || null,
        origin: lead.origin_module || null,
        stage: lead.stage,
        status: lead.status,
        parked: lead.stage === 'on_hold' || lead.stage === 'cancelled',
        subject: lead.subject || '',
        category: lead.category || null,
        description: lead.description || '',
        // CLIENT / LEAD comes from the server, which looks at the contact's
        // whole history (any job ever), not just this enquiry's stage.
        clientStatus: lead.contact_status === 'client' ? 'client' : 'lead',
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
        recvAt, lastLogAt, fu, fus,
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


  // The ask-box honours the mock's example questions without pretending to be
  // an LLM: a recognised phrase becomes the matching live filter.
  const MAGIC = [
    [/\bstuck\b|\bneed(s)? action\b|\boverdue\b/, f => isHot(f)],
    [/\bquiet\b|\bgone quiet\b/, f => isQuiet(f)],
    [/\bquotation\b|\bclos(e|ing)\b/, f => pickId(f) === 'quotation'],
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
      f.code, f.fileNumber, f.logCode, f.subject, f.category, f.description,
      f.contact.name, f.contact.company, f.contact.mobile, f.contact.email,
      f.site.location, f.site.city, f.site.district, f.site.country, f.site.street,
      f.ownerName, f.assignedName, f.stage, f.status, STAGE_LABEL[f.stage],
    ].join(' ').toLowerCase();
    return hay.includes(state.q);
  }

  // ── My day / calendar: what has to be done when ─────────────────────────
  // A to-do is a follow-up date on an enquiry that is still open (not won,
  // cancelled, on hold, done). Overdue = its latest follow-up is in the past.
  const isOpenTodo = f => !f.parked && !isDone(f) && !['done', 'cancelled', 'transferred'].includes(f.status);
  const isOverdue = f => isOpenTodo(f) && Boolean(f.fu && f.fu.overdue);
  const isMine = f => Boolean(state.me) && [f.ownerName, f.assignedName].some(n => n && n.trim().toLowerCase() === state.me.trim().toLowerCase());
  const dueOn = (f, ymd) => isOpenTodo(f) && f.fus.some(x => x.date === ymd);
  // In the day list: due that day, plus overdue when the day is today.
  const onDay = (f, ymd) => dueOn(f, ymd) || (ymd === todayYmd() && isOverdue(f));
  const ymdOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const shiftYmd = (ymd, days) => { const d = new Date(`${ymd}T12:00:00`); d.setDate(d.getDate() + days); return ymdOf(d); };
  const longDay = ymd => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  function visibleFiles() {
    let list = FILES.filter(f => textMatch(f));
    if (state.mine) list = list.filter(isMine);
    if (state.day) list = list.filter(f => onDay(f, state.day));
    if (state.fSt) list = list.filter(f => f.status === state.fSt);
    if (state.fCl) list = list.filter(f => f.clientStatus === state.fCl);
    if (state.fStage) list = list.filter(f => STAGE_PICK_OF[f.stage] && STAGE_PICK_OF[f.stage].id === state.fStage);
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
  function stageCell(f) {
    const pick = STAGE_PICK_OF[f.stage];
    // A stage outside the eight steps keeps its own name as the selected entry,
    // so the dropdown never claims a step the enquiry is not in.
    const current = pick ? ''
      : `<option value="" selected disabled>${esc(STAGE_LABEL[f.stage] || f.stage)}</option>`;
    const options = STAGE_PICK.map(p =>
      `<option value="${p.value}"${pick === p ? ' selected' : ''}>${esc(p.label)}</option>`).join('');
    return `<span class="stw" title="Change stage — ${esc(STAGE_LABEL[f.stage] || f.stage)}">`
      + `<select class="stover stsel${pick && pick.id === 'won' ? ' is-won' : ''}" data-act="stage" data-fid="${esc(f.fid)}" aria-label="Stage">${current}${options}</select></span>`;
  }

  function statusCell(f) {
    const meta = statusMeta(f.status);
    // Any other stored status (e.g. "transferred" once handed over as a JOB)
    // keeps its own name as the selected entry, like the Stage dropdown.
    const current = STATUS_PICK.includes(f.status) ? ''
      : `<option value="" selected disabled>${esc(meta.label)}</option>`;
    const options = STATUS_PICK.map(k =>
      `<option value="${k}"${k === f.status ? ' selected' : ''}>${esc(statusMeta(k).label)}</option>`).join('');
    return `<span class="stw" title="Change status">`
      + `<select class="stover stsel-status" style="${statusPillStyle(f.status)}" data-act="status" data-fid="${esc(f.fid)}" aria-label="Status">${current}${options}</select></span>`;
  }


  function clientCell(f) {
    const main = f.contact.company || f.contact.name || '';
    const person = [f.contact.prefix, f.contact.first, f.contact.last].filter(Boolean).join(' ').trim();
    const sub = f.contact.company
      ? [person, f.contact.role].filter(Boolean).join(' — ')
      : (f.contact.role || f.contact.mobile || '');
    const badge = f.clientStatus === 'client'
      ? '<span class="cl-badge is-client" title="Has worked with us before (at least one job)">CLIENT</span>'
      : '<span class="cl-badge is-lead" title="No job with us yet">LEAD</span>';
    if (!main) return `<div class="cl-line">${badge}</div>`;
    return `<div style="line-height:1.15"><div class="cl-line"><span class="nm-main">${esc(main)}</span>${badge}</div>`
      + (sub ? `<div class="nm-sub">${esc(sub)}</div>` : '') + '</div>';
  }

  // Site opens the location in Google Maps: the saved Maps link when there is
  // one, else a Maps search for the site + city.
  function siteMapsUrl(f) {
    if (f.site.maps && /^https?:\/\//i.test(f.site.maps)) return f.site.maps;
    const q = [f.site.location, f.site.street, f.site.city, f.site.district, f.site.country].filter(Boolean).join(', ')
      || [f.subject, f.site.city].filter(Boolean).join(', ');
    return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : '';
  }
  // Site text shows in Title Case (display only — the saved value is unchanged).
  const titleCase = s => String(s || '').toLowerCase().replace(/(^|[\s\-\/(.,])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
  function subjectCell(f) {
    const site = [esc(titleCase(f.site.city)), esc(titleCase(f.site.location))]
      .filter(Boolean).join(' — ');
    const url = siteMapsUrl(f);
    const inner = `<span style="font-size:11px">${f.subject ? esc(titleCase(f.subject)) : ''}</span>`
      + (site ? `<div class="nm-sub">${site}</div>` : '');
    if (!url || (!f.subject && !site)) return `<div style="line-height:1.15">${inner}</div>`;
    return `<a class="site-lnk" href="${esc(url)}" target="_blank" rel="noopener" title="Open in Google Maps">`
      + `<svg aria-hidden="true"><use href="#i-pin"/></svg><span style="line-height:1.15;min-width:0">${inner}</span></a>`;
  }
  function contactCell(f) {
    const person = [f.contact.prefix, f.contact.first, f.contact.last].filter(Boolean).join(' ').trim()
      || (f.contact.company ? '' : f.contact.name);
    return person ? `<span class="nm-main" title="${esc(person)}">${esc(person)}</span>` : '';
  }
  function mobileCell(f) {
    const num = f.contact.mobile || (f.contact.phones[0] && f.contact.phones[0].number) || '';
    if (!num) return '';
    const digits = String(num).replace(/[^\d]/g, '');
    return `<span class="num">${esc(num)}</span>`
      + (digits ? ` <a class="wa" href="https://wa.me/${digits}" target="_blank" rel="noopener" title="Open in WhatsApp">WA</a>` : '');
  }
  function emailCell(f) {
    const mail = f.contact.email || (f.contact.emails[0] && f.contact.emails[0].address) || '';
    return mail ? `<a href="mailto:${esc(mail)}" title="${esc(mail)}">${esc(mail)}</a>` : '';
  }
  function companyCell(f) {
    const badge = f.clientStatus === 'client'
      ? '<span class="cl-badge is-client" title="Has worked with us before (at least one job)">CLIENT</span>'
      : '<span class="cl-badge is-lead" title="No job with us yet">LEAD</span>';
    const name = f.contact.company || (f.contact.first || f.contact.last ? '' : f.contact.name) || '';
    return `<div class="cl-line">${name ? `<span class="nm-main" title="${esc(name)}">${esc(name)}</span>` : ''}${badge}</div>`;
  }
  // "Linked to": a count button; the list opens in one shared floating menu.
  const linkedCount = f => DOCS.filter(([k]) => f.docs[k]).length + f.logs.length;
  function linkedCell(f) {
    const n = linkedCount(f);
    return `<button type="button" class="lnk-btn${n ? '' : ' is-empty'}" data-linked="${esc(f.fid)}">`
      + `${n} linked <i class="farr">▾</i></button>`;
  }
  function linkedMenuHTML(f) {
    const docs = DOCS.map(([k, label, href, name]) => (f.docs[k]
      ? `<a class="lnk-it" href="${href}"><span class="doc on">${label}</span>${esc(name)}<span class="lnk-go">open ↗</span></a>`
      : `<div class="lnk-it is-off"><span class="doc">${label}</span>${esc(name)}<span class="lnk-go">—</span></div>`)).join('');
    const logs = f.logs.map(l => `<a class="lnk-it" href="${API}/ui">`
      + `<span class="mut num">${esc(fmtDM(parseTs(l.occurred_at || l.created_at)))}</span>`
      + `<span class="lnk-desc">${esc(l.log_code ? l.log_code + ' · ' : '')}${esc(l.description || l.subject || (l.log_type || 'Log'))}</span>`
      + '<span class="lnk-go">↗</span></a>').join('');
    return `<div class="lnk-h">Documents${f.deliverables.length ? ` <span class="mut">· ${esc(f.deliverables.join(', '))}</span>` : ''}</div>${docs}`
      + `<div class="lnk-h">Log entries <span class="mut">· ${f.logs.length}</span></div>`
      + (logs || '<div class="lnk-it is-off">No log entries.</div>');
  }
  function closeLinked() {
    const m = document.getElementById('lnk-menu');
    if (m) m.remove();
  }
  function openLinked(btn) {
    const f = FILES.find(x => x.fid === btn.dataset.linked);
    const wasOpen = document.getElementById('lnk-menu');
    const sameBtn = wasOpen && wasOpen.dataset.fid === btn.dataset.linked;
    closeLinked();
    if (!f || sameBtn) return;
    const m = document.createElement('div');
    m.id = 'lnk-menu';
    m.className = 'lnk-menu';
    m.dataset.fid = f.fid;
    m.innerHTML = linkedMenuHTML(f);
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect();
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const top = r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
  }


  function ageCell(f) {
    if (!f.recvAt) return '';
    const days = Math.max(0, Math.floor((Date.now() - f.recvAt) / DAY));
    const color = isHot(f) ? '#b91c1c' : '#8a8f98';
    return `<span class="num" style="font-size:10px;color:${color}">${days}d${isHot(f) ? ' ⚠' : ''}</span>`;
  }

  // ── Grid ───────────────────────────────────────────────────────────────────
  function renderHead() {
    const arrow = k => (state.sort.k === k ? (state.sort.dir === 'asc' ? '▲' : '▼') : '↕');
    const options = ['<option value="">All statuses</option>']
      .concat(STATUS_PICK.map(s => `<option value="${s}"${state.fSt === s ? ' selected' : ''}>${esc(statusMeta(s).label)}</option>`))
      .join('');
    const stageFilterOptions = ['<option value="">All stages</option>']
      .concat(STAGE_PICK.map(p => `<option value="${p.id}"${state.fStage === p.id ? ' selected' : ''}>${esc(p.label)}</option>`))
      .join('');
    $('hd').innerHTML =
      '<span>Code</span>'
      + `<span class="srt" data-sort="recv">Received<i class="sarr2">${arrow('recv')}</i></span>`
      + `<span class="flt${state.fSt ? ' on' : ''}">Status <i class="farr">▾</i>${state.fSt ? ' · ' + esc(statusMeta(state.fSt).label) : ''}`
      + `<select class="stover" data-act="fst" title="Filter by status">${options}</select></span>`
      + '<span>Contact</span>'
      + '<span>Mobile / WA</span>'
      + '<span>Email</span>'
      + '<span>Role</span>'
      + `<span class="flt${state.fCl ? ' on' : ''}">Company <i class="farr">▾</i>${state.fCl ? ' · ' + (state.fCl === 'client' ? 'Client' : 'Lead') : ''}`
      + `<select class="stover" data-act="fcl" title="Filter by client / lead">`
      + `<option value="">All</option><option value="lead"${state.fCl === 'lead' ? ' selected' : ''}>Lead</option>`
      + `<option value="client"${state.fCl === 'client' ? ' selected' : ''}>Client</option></select></span>`
      + '<span>Site</span>'
      + `<span class="flt${state.fStage ? ' on' : ''}">Stage <i class="farr">▾</i>${state.fStage ? ' · ' + esc(STAGE_PICK.find(p => p.id === state.fStage).label) : ''}`
      + `<select class="stover" data-act="fstage" title="Filter by stage">${stageFilterOptions}</select></span>`
      + '<span>Linked to</span>'
      + '<span>Owner</span>';
    Array.from($('hd').children).forEach((cell, i) => {
      cell.insertAdjacentHTML('beforeend', `<i class="rz" data-i="${i}" title="Drag to resize · double-click to reset"></i>`);
    });
  }

  // ── Resizable grid columns ────────────────────────────────────────────────
  // Widths in px per column, saved in this browser. null = the CSS defaults.
  const COLW_KEY = 'achi.crm.colW.v2';
  const COL_COUNT = 12;
  const COL_MIN = 36;
  let colW = null;
  try {
    const saved = JSON.parse(localStorage.getItem(COLW_KEY) || 'null');
    if (Array.isArray(saved) && saved.length === COL_COUNT && saved.every(n => Number.isFinite(n) && n >= COL_MIN)) colW = saved;
  } catch (_e) { colW = null; }
  function applyColW() {
    const pg = $('pg');
    if (!colW) { pg.style.removeProperty('--crm-cols'); pg.style.removeProperty('--crm-minw'); return; }
    pg.style.setProperty('--crm-cols', colW.map(w => `${Math.round(w)}px`).join(' '));
    pg.style.setProperty('--crm-minw', `${Math.round(colW.reduce((a, b) => a + b, 0))}px`);
  }
  function saveColW() {
    try {
      if (colW) localStorage.setItem(COLW_KEY, JSON.stringify(colW.map(w => Math.round(w))));
      else localStorage.removeItem(COLW_KEY);
    } catch (_e) { /* private mode */ }
  }
  applyColW();

  function rowHTML(f) {
    const cls = (state.sel === f.fid ? 'sel ' : '') + (isHot(f) ? 'hot' : '');
    return `<div class="row ${cls}" data-fid="${esc(f.fid)}">`
      + `<div><span class="code">${esc(f.code)}</span></div>`
      + `<div class="mut num" style="font-size:10.5px">${f.recvAt ? esc(fmtDMY(f.recvAt)) : ''}</div>`
      + `<div>${statusCell(f)}</div>`
      + `<div>${contactCell(f)}</div>`
      + `<div>${mobileCell(f)}</div>`
      + `<div>${emailCell(f)}</div>`
      + `<div title="${esc(f.contact.role)}">${esc(f.contact.role)}</div>`
      + `<div>${companyCell(f)}</div>`
      + `<div>${subjectCell(f)}</div>`
      + `<div>${stageCell(f)}</div>`
      + `<div>${linkedCell(f)}</div>`
      + `<div><span class="who" title="${esc(f.ownerName || '')}">${esc(initials(f.ownerName))}</span></div>`
      + '</div>';
  }

  function renderRows() {
    const list = visibleFiles();
    const body = $('rows');
    if (!FILES.length) {
      body.innerHTML = '<div class="row"><div class="empty">No CRM records yet — log a call or add a prospect.</div></div>';
    } else if (!list.length) {
      body.innerHTML = `<div class="row"><div class="empty">${state.day ? 'Nothing to follow up on this day.' : 'No enquiries match the current filters.'}</div></div>`;
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
      const col = STAGE_PICK_BY_ID[id];
      const items = list.filter(f => pickId(f) === id);
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
    if (!f || pickId(f) === targetId) return;
    // Same value the row's Stage dropdown saves for that step.
    patchFile(d.fid, { stage: STAGE_PICK_BY_ID[targetId].value }, 'Stage');
  });

  boardEl.addEventListener('dragend', () => { dragging = null; clearDrop(); });

  // ── KPI chips ──────────────────────────────────────────────────────────────
  function renderKchips() {
    const open = FILES.filter(isOpenPipe).length;
    const quo = FILES.filter(f => pickId(f) === 'quotation').length;
    const due = FILES.filter(f => onDay(f, todayYmd())).length;   // same rule as the My day list
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
      + rateChip
      + `<button type="button" class="kc kc-btn${due ? ' alert' : ''}" data-day="today" title="Show today's list"><b>${due}</b> need action today</button>`;
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

  function renderDaybar() {
    $('day-pick').value = state.day || '';
    $('day-clear').hidden = !state.day;
    $('day-mine').checked = state.mine;
    const sum = $('daysum');
    if (!state.day || state.view === 'cal') { sum.hidden = true; return; }
    let base = FILES;
    if (state.mine) base = base.filter(isMine);
    const due = base.filter(f => dueOn(f, state.day)).length;
    const late = state.day === todayYmd() ? base.filter(f => isOverdue(f) && !dueOn(f, state.day)).length : 0;
    sum.hidden = false;
    sum.innerHTML = `<b>${esc(longDay(state.day))}</b>${state.day === todayYmd() ? ' <span class="db-today">today</span>' : ''}`
      + ` · <b>${due}</b> follow-up${due === 1 ? '' : 's'} due`
      + (late ? ` · <b class="db-late">${late}</b> overdue from earlier` : '')
      + (state.mine ? ' · only mine' : '')
      + (due + late ? '' : ' — nothing to do 🎉');
  }

  // ── Calendar: one month, follow-ups on their day ─────────────────────────
  function renderCalendar() {
    if (!state.calMonth) state.calMonth = (state.day || todayYmd()).slice(0, 7);
    const [y, m] = state.calMonth.split('-').map(Number);
    const first = new Date(y, m - 1, 1, 12);
    const title = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    $('cal-head').innerHTML = `<button type="button" class="mini ghost db-arr" data-cal="prev" aria-label="Previous month">‹</button>`
      + `<b class="cal-title">${esc(title)}</b>`
      + `<button type="button" class="mini ghost db-arr" data-cal="next" aria-label="Next month">›</button>`
      + '<button type="button" class="mini" data-cal="today">This month</button>'
      + '<span style="flex:1"></span>'
      + '<span class="cal-leg"><i class="cal-dot"></i>follow-up <i class="cal-dot late"></i>overdue — click a day to see its list</span>';
    let base = FILES.filter(f => textMatch(f) && isOpenTodo(f));
    if (state.mine) base = base.filter(isMine);
    const byDay = {};
    base.forEach(f => f.fus.forEach(x => { (byDay[x.date] = byDay[x.date] || []).push(f); }));
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7));   // back to Monday
    const today = todayYmd();
    let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="cal-dow">${d}</div>`).join('');
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ymd = ymdOf(d);
      const items = [...new Map((byDay[ymd] || []).map(f => [f.fid, f])).values()];
      const out = d.getMonth() !== m - 1;
      const cls = ['cal-day', out ? 'out' : '', ymd === today ? 'today' : '', ymd === state.day ? 'sel' : ''].filter(Boolean).join(' ');
      const shown = items.slice(0, 3).map(f => {
        const late = ymd < today;
        return `<button type="button" class="cal-it${late ? ' late' : ''}" data-cal-fid="${esc(f.fid)}" data-cal-day="${ymd}" title="${esc(f.code)} · ${esc(f.contact.company || f.contact.name || '')}">`
          + `<span class="code">${esc(f.code.replace(/^ENQ-0*/, 'ENQ-'))}</span> ${esc(f.contact.company || f.contact.name || '—')}</button>`;
      }).join('');
      html += `<div class="${cls}" data-cal-open="${ymd}"><div class="cal-n">${d.getDate()}${items.length ? `<span class="cal-cnt">${items.length}</span>` : ''}</div>`
        + shown + (items.length > 3 ? `<div class="cal-more">+${items.length - 3} more</div>` : '') + '</div>';
    }
    $('cal').innerHTML = html;
  }

  // ── Render everything that depends on data / filters ──────────────────────
  function renderViews() {
    $('list-wrap').hidden = state.view !== 'list';
    $('board-wrap').hidden = state.view !== 'board';
    $('cal-wrap').hidden = state.view !== 'cal';
    renderDaybar();
    if (state.view === 'list') { renderHead(); renderRows(); } else if (state.view === 'board') { renderBoard(); } else { renderCalendar(); }
    applyLayout();
  }

  function renderAll() {
    renderKchips();
    renderViews();
    renderPanel();
  }

  // ── Load: pull every page of /logs/ (server caps a page at 1000) ───────────
  // quiet: refresh in place (no "Loading…" placeholder, keep the table on error)
  // — used after an edit so server-derived fields such as CLIENT / LEAD, which
  // can change on other enquiries of the same contact, catch up.
  async function load({ quiet = false } = {}) {
    if (!quiet) $('rows').innerHTML = '<div class="row"><div class="empty">Loading…</div></div>';
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
      if (quiet) return;
      $('rows').innerHTML = `<div class="row"><div class="empty">Couldn’t load records: ${esc(error.message || 'error')}</div></div>`;
    }
  }

  // ── Inline edits: PATCH /files/{id} — stage or status ──────────────────────
  // Moving an enquiry to "Site visit" opens its visit in the Site Visit module
  // (achiEnsureSiteVisit in chrome.js — skipped when it already has one).
  function ensureSiteVisit(f) {
    if (!f || !window.achiEnsureSiteVisit) return;
    const person = [f.contact.prefix, f.contact.first, f.contact.last].filter(Boolean).join(' ').trim() || f.contact.name;
    window.achiEnsureSiteVisit({
      fileId: f.fid, fileNumber: f.fileNumber, customer: f.contact.company || person, contact: person,
      site: [f.site.location, f.site.city].filter(Boolean).join(', '), maps: f.site.maps, subject: f.subject,
    }, {
      get: path => request(path),
      post: (path, body) => request(path, { method: 'POST', body }),
    }).then(v => { if (v && v.survey_number) showToast(`Site visit ${String(v.survey_number).replace(/^ACHI-SV-\d{4}-(\d+)$/, 'SV-$1')} opened.`); });
  }

  async function patchFile(fid, patch, label) {
    try {
      await request(`${API}/files/${encodeURIComponent(fid)}`, { method: 'PATCH', body: patch });
      RAW.forEach(r => { if (r.file_id === fid) Object.assign(r, patch); });
      if (patch.stage === 'site_survey') ensureSiteVisit(FILES.find(x => x.fid === fid));
      FILES = groupFiles(RAW);
      renderAll();
      showToast(`${label} updated.`);
      // A move into / out of Won → JOB can turn this contact's other
      // enquiries CLIENT or LEAD too — re-read the server's verdict.
      if ('stage' in patch || 'status' in patch) load({ quiet: true });
    } catch (error) {
      renderAll(); // put the selects back to server truth
      showToast(error.message || `Could not update ${label.toLowerCase()}.`, true);
    }
  }

  // ── New ENQ popup ──────────────────────────────────────────────────────────
  // Same layout as the Log "+ Log" and Contacts "+ contact" popups: general
  // fields, then "+ Add" puts a Contact (search the directory or type a new
  // one) and module sections (Site Visit, Drawing, M/T, BOQ…) under the ENQ.
  // Save = POST /logs/ (finds/creates the contact, opens a new file), then one
  // log per module on that file, typed with the module name so it shows under
  // the ENQ's "Linked to".
  const NQ_MODULES = [
    { type: 'Site Visit', doc: 'srv', label: 'SRV', name: 'Site visit' },
    { type: 'Drawing', doc: 'dwg', label: 'DWG', name: 'Drawing' },
    { type: 'M/T', doc: 'mt', label: 'M/T', name: 'Measurement / takeoff' },
    { type: 'BOQ', doc: 'boq', label: 'BOQ', name: 'Bill of quantities' },
    { type: 'Costing / Plan', doc: 'cst', label: 'CST', name: 'Costing / plan' },
    { type: 'Quotation', doc: 'qte', label: 'QTE', name: 'Quotation' },
  ];
  const NQ_PREFIXES = ['Mr', 'Ms', 'Mrs', 'Dr', 'Eng', 'Arch'];
  const NQ_ROLES = ['Owner', 'Engineer', 'Contractor', 'Foreman', 'Site manager', 'Architect', 'Procurement'];
  const nq = { contacts: null, userLoaded: false, linked: null };

  const pad2 = n => String(n).padStart(2, '0');
  const localDateTime = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const nqStatusDot = s => ({ open: '#22c55e', scheduled: '#f59e0b', viewed: '#0ea5e9', done: '#15803d', cancelled: '#ef4444' }[s] || '#22c55e');

  function openProspect() {
    const modal = $('prospect-modal');
    if (!modal) return;
    $('prospect-form').reset();
    $('prospect-error').textContent = '';
    $('nq-subs').innerHTML = '';
    nq.linked = null;
    $('nq-when').value = localDateTime(new Date());
    $('nq-status').innerHTML = STATUS_PICK.map(k => `<option value="${k}">${esc(statusMeta(k).label)}</option>`).join('');
    $('nq-status').value = 'open';
    $('nq-dot').style.background = nqStatusDot('open');
    $('nq-stage').innerHTML = STAGE_PICK.map(p => `<option value="${p.value}">${esc(p.label)}</option>`).join('');
    $('nq-stage').value = 'enquiry';
    renderAddMenu();
    modal.hidden = false;
    $('nq-subject').focus();
    loadNqUser();
  }
  function closeProspect() {
    const modal = $('prospect-modal');
    if (modal) modal.hidden = true;
    toggleAddMenu(false);
  }
  async function loadNqUser() {
    if (nq.userLoaded) return;
    try {
      const me = await request('/api/v1/users/me/');
      const name = me.full_name || me.email || '';
      $('nq-user').textContent = initials(name) || '—';
      $('nq-user').title = name;
      nq.userLoaded = true;
    } catch (_e) { $('nq-user').textContent = '—'; }
  }

  // "+ Add" menu: Contact once, each module once.
  const hasSub = key => Boolean($('nq-subs').querySelector(`[data-sub="${CSS.escape(key)}"]`));
  function renderAddMenu() {
    $('nq-addmenu').innerHTML = '<span class="nq-mh">People</span>'
      + `<button type="button" class="nq-mi" role="menuitem" data-add="contact"${hasSub('contact') ? ' disabled' : ''}><span class="doc on">CON</span>Contact — search or add new</button>`
      + '<span class="nq-mh">Modules</span>'
      + NQ_MODULES.map(m => `<button type="button" class="nq-mi" role="menuitem" data-add="${esc(m.type)}"${hasSub(m.type) ? ' disabled' : ''}>`
        + `<span class="doc on">${esc(m.label)}</span>${esc(m.name)}</button>`).join('');
  }
  function toggleAddMenu(open) {
    const menu = $('nq-addmenu');
    if (!menu) return;
    const show = open === undefined ? menu.hidden : open;
    menu.hidden = !show;
    $('nq-add').setAttribute('aria-expanded', String(show));
  }
  function addSub(key) {
    toggleAddMenu(false);
    $('prospect-error').textContent = '';
    if (hasSub(key)) return;
    const box = document.createElement('section');
    box.className = 'nq-card';
    box.dataset.sub = key;
    if (key === 'contact') {
      box.innerHTML = '<div class="nq-sec-t">Contact <span class="nq-sub" data-c-state>— search or add new</span>'
        + '<button type="button" class="nq-rm" data-rm title="Remove">&times;</button></div>'
        + '<div class="nq-search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>'
        + '<input class="nq-in" type="search" data-c-search placeholder="Search existing contacts or companies…" autocomplete="off">'
        + '<div class="nq-results" data-c-results hidden></div></div>'
        + '<div class="nq-info" data-c-info hidden></div>'
        + '<div class="nq-grid">'
        + `<label class="nq-f"><span>Pre</span><select class="nq-in" data-c="prefix"><option value=""></option>${NQ_PREFIXES.map(x => `<option>${x}</option>`).join('')}</select></label>`
        + '<label class="nq-f"><span>First</span><input class="nq-in" data-c="first" maxlength="128" autocomplete="off"></label>'
        + '<label class="nq-f"><span>Last</span><input class="nq-in" data-c="last" maxlength="128" autocomplete="off"></label>'
        + '<label class="nq-f"><span>Company</span><input class="nq-in" data-c="company" maxlength="255" autocomplete="off"></label>'
        + '<label class="nq-f"><span>Role</span><input class="nq-in" data-c="role" maxlength="64" list="nq-roles" autocomplete="off"></label>'
        + '<label class="nq-f"><span>Mobile / WA</span><input class="nq-in" data-c="mobile" maxlength="32" autocomplete="off" inputmode="tel"></label>'
        + '<label class="nq-f"><span>Email</span><input class="nq-in" data-c="email" type="email" maxlength="255" autocomplete="off"></label>'
        + '</div>'
        + `<datalist id="nq-roles">${NQ_ROLES.map(r => `<option value="${esc(r)}"></option>`).join('')}</datalist>`;
      $('nq-subs').prepend(box);
      box.querySelector('[data-c-search]').focus();
      loadNqContacts();
    } else {
      const m = NQ_MODULES.find(x => x.type === key);
      if (!m) return;
      box.innerHTML = `<div class="nq-sec-t"><span class="doc on">${esc(m.label)}</span>${esc(m.name)}`
        + '<button type="button" class="nq-rm" data-rm title="Remove">&times;</button></div>'
        + '<div class="nq-grid">'
        + '<label class="nq-f"><span>Due date</span><input class="nq-in" type="date" data-m="date"></label>'
        + '<label class="nq-f nq-f-wide"><span>Notes</span><textarea class="nq-in nq-notes" rows="2" data-m="notes" placeholder="What is needed for this step?"></textarea></label>'
        + '</div>';
      $('nq-subs').appendChild(box);
      box.querySelector('[data-m="date"]').focus();
    }
    renderAddMenu();
  }

  // Contact search over the shared directory (loaded once per page).
  async function loadNqContacts() {
    if (nq.contacts) return;
    try {
      const data = await request(`${API}/contact-info/contacts?limit=500`);
      nq.contacts = Array.isArray(data && data.items) ? data.items : [];
    } catch (_e) { nq.contacts = []; }
  }
  const contactLabel = c => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || '—';
  function renderContactResults(box, q) {
    const out = box.querySelector('[data-c-results]');
    const term = q.trim().toLowerCase();
    if (!term) { out.hidden = true; return; }
    const hits = (nq.contacts || []).filter(c => [c.first_name, c.last_name, c.company_name, c.primary_phone, c.primary_email]
      .filter(Boolean).join(' ').toLowerCase().includes(term)).slice(0, 8);
    out.innerHTML = (hits.length
      ? hits.map(c => `<button type="button" class="nq-res" data-pick="${esc(c.id)}"><b>${esc(contactLabel(c))}</b>`
        + `${c.first_name || c.last_name ? (c.company_name ? ` <span>· ${esc(c.company_name)}</span>` : '') : ''}`
        + `<span class="mut">${esc(c.primary_phone || c.primary_email || '')}</span></button>`).join('')
      : `<div class="nq-res-empty">${nq.contacts ? 'No match in Contacts.' : 'Loading contacts…'}</div>`)
      + `<button type="button" class="nq-res nq-res-new" data-pick="">+ New contact “${esc(q.trim())}”</button>`;
    out.hidden = false;
  }
  function pickContact(box, id, typed) {
    const out = box.querySelector('[data-c-results]');
    out.hidden = true;
    const set = (k, v) => { const el = box.querySelector(`[data-c="${k}"]`); if (el) el.value = v || ''; };
    const lockable = ['first', 'last', 'company', 'mobile', 'email'];
    const info = box.querySelector('[data-c-info]');
    if (!id) {
      nq.linked = null;
      const parts = typed.trim().split(/\s+/);
      set('first', parts.shift() || ''); set('last', parts.join(' '));
      lockable.forEach(k => { box.querySelector(`[data-c="${k}"]`).readOnly = false; });
      info.hidden = true;
      box.querySelector('[data-c-state]').textContent = '— new contact';
      box.querySelector('[data-c="first"]').focus();
      return;
    }
    const c = (nq.contacts || []).find(x => String(x.id) === id);
    if (!c) return;
    nq.linked = c;
    set('first', c.first_name); set('last', c.last_name); set('company', c.company_name);
    set('mobile', c.primary_phone); set('email', c.primary_email);
    lockable.forEach(k => { box.querySelector(`[data-c="${k}"]`).readOnly = true; });
    info.innerHTML = `Existing contact — <b>${esc(contactLabel(c))}</b> is linked; their saved details are kept.`
      + ' <button type="button" class="nq-link" data-c-clear>Change</button>';
    info.hidden = false;
    box.querySelector('[data-c-state]').textContent = `— ${contactLabel(c)}`;
    box.querySelector('[data-c-search]').value = '';
  }
  function clearContact(box) {
    nq.linked = null;
    box.querySelectorAll('[data-c]').forEach(el => { el.value = ''; el.readOnly = false; });
    box.querySelector('[data-c-info]').hidden = true;
    box.querySelector('[data-c-state]').textContent = '— search or add new';
    box.querySelector('[data-c-search]').focus();
  }

  async function submitProspect(event) {
    event.preventDefault();
    const err = $('prospect-error');
    err.textContent = '';
    const cbox = $('nq-subs').querySelector('[data-sub="contact"]');
    if (!cbox) { err.textContent = 'Press “+ Add” → Contact to say who the enquiry is from.'; return; }
    const cv = k => (cbox.querySelector(`[data-c="${k}"]`).value || '').trim();
    const first = cv('first'), last = cv('last'), company = cv('company'), email = cv('email');
    if (!first && !last && !company) {
      err.textContent = 'Enter the contact’s name or company.';
      cbox.querySelector('[data-c="first"]').classList.add('nq-invalid');
      cbox.querySelector('[data-c="first"]').focus();
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      err.textContent = 'That email doesn’t look right.';
      cbox.querySelector('[data-c="email"]').classList.add('nq-invalid');
      return;
    }
    const when = $('nq-when').value ? new Date($('nq-when').value) : new Date();
    const site = {
      site_location: $('nq-site').value.trim() || null,
      city: $('nq-city').value.trim() || null,
      maps_url: $('nq-maps').value.trim() || null,
    };
    const payload = {
      person: {
        prefix: cv('prefix') || null,
        first_name: first || null,
        last_name: last || null,
        company_name: company || null,
        role: cv('role') || null,
        mobile: cv('mobile') || null,
        email: email || null,
        is_company: !first && !last && Boolean(company),
      },
      site: Object.values(site).some(Boolean) ? site : null,
      subject: $('nq-subject').value.trim(),
      category: $('nq-category').value.trim() || null,
      description: $('nq-notes').value.trim(),
      stage: $('nq-stage').value || 'enquiry',
      status: $('nq-status').value || 'open',
      log_type: 'Enquiry',
      occurred_at: when.toISOString(),
      follow_up_date: $('nq-followup').value || null,
      origin_module: 'crm',
      new_file: true,
    };
    const modules = Array.from($('nq-subs').querySelectorAll('.nq-card')).filter(b => b.dataset.sub !== 'contact').map(b => ({
      type: b.dataset.sub,
      date: b.querySelector('[data-m="date"]').value || null,
      notes: b.querySelector('[data-m="notes"]').value.trim(),
    }));
    const save = $('prospect-save');
    save.disabled = true;
    const label = save.textContent;
    save.textContent = 'Saving…';
    try {
      const res = await request(`${API}/logs/`, { method: 'POST', body: payload });
      let failed = 0;
      for (const m of modules) {
        try {
          await request(`${API}/files/${encodeURIComponent(res.file_id)}/logs/`, {
            method: 'POST',
            body: {
              log_type: m.type,
              occurred_at: new Date().toISOString(),
              description: m.notes || `${m.type} added from New ENQ`,
              follow_up_date: m.date,
            },
          });
        } catch (_e) { failed += 1; }
      }
      closeProspect();
      const code = enqCode(res.file_number);
      if (payload.stage === 'site_survey') {
        const c = payload.person;
        const person = [c.prefix, c.first_name, c.last_name].filter(Boolean).join(' ');
        ensureSiteVisit({
          fid: res.file_id, fileNumber: res.file_number, subject: payload.subject,
          contact: { prefix: '', first: person, last: '', name: person, company: c.company_name || '' },
          site: { location: (payload.site && payload.site.site_location) || '', city: (payload.site && payload.site.city) || '', maps: (payload.site && payload.site.maps_url) || '' },
        });
      }
      showToast(failed
        ? `${code} saved, but ${failed} module${failed > 1 ? 's' : ''} couldn’t be added — add them from the Log.`
        : `${code} saved${modules.length ? ` with ${modules.length} module${modules.length > 1 ? 's' : ''}` : ''}.`, Boolean(failed));
      await load();
    } catch (error) {
      err.textContent = error.message || 'Could not save the enquiry.';
    } finally {
      save.disabled = false;
      save.textContent = label;
    }
  }

  if ($('prospect-modal')) {
    $('nq-add').addEventListener('click', event => { event.stopPropagation(); toggleAddMenu(); });
    $('nq-addmenu').addEventListener('click', event => {
      const it = event.target.closest('[data-add]');
      if (it && !it.disabled) addSub(it.dataset.add);
    });
    $('nq-status').addEventListener('change', event => { $('nq-dot').style.background = nqStatusDot(event.target.value); });
    $('nq-subs').addEventListener('click', event => {
      const box = event.target.closest('.nq-card');
      if (!box) return;
      if (event.target.closest('[data-rm]')) {
        if (box.dataset.sub === 'contact') nq.linked = null;
        box.remove();
        renderAddMenu();
        return;
      }
      const pick = event.target.closest('[data-pick]');
      if (pick) { pickContact(box, pick.dataset.pick, box.querySelector('[data-c-search]').value); return; }
      if (event.target.closest('[data-c-clear]')) clearContact(box);
    });
    $('nq-subs').addEventListener('input', event => {
      event.target.classList.remove('nq-invalid');
      if (event.target.matches('[data-c-search]')) renderContactResults(event.target.closest('.nq-card'), event.target.value);
    });
    $('prospect-form').addEventListener('click', event => {
      if (!event.target.closest('.nq-addwrap')) toggleAddMenu(false);
      if (!event.target.closest('.nq-search')) $('nq-subs').querySelectorAll('[data-c-results]').forEach(r => { r.hidden = true; });
    });
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
    // Recolour the stage pill at once; the re-render after the save confirms it.
    if (sel.classList.contains('stsel')) sel.classList.toggle('is-won', STAGE_PICK_OF[sel.value] && STAGE_PICK_OF[sel.value].id === 'won');
    // Recolour the status pill at once, too.
    if (sel.classList.contains('stsel-status')) sel.setAttribute('style', statusPillStyle(sel.value));
    if (sel.dataset.act === 'stage') patchFile(sel.dataset.fid, { stage: sel.value }, 'Stage');
    else if (sel.dataset.act === 'status') patchFile(sel.dataset.fid, { status: sel.value }, 'Status');
    else if (sel.dataset.act === 'fst') { state.fSt = sel.value; renderViews(); }
    else if (sel.dataset.act === 'fstage') { state.fStage = sel.value; renderViews(); }
    else if (sel.dataset.act === 'fcl') { state.fCl = sel.value; renderViews(); }
  });

  $('rows').addEventListener('click', event => {
    const lb = event.target.closest('[data-linked]');
    if (lb) { event.stopPropagation(); openLinked(lb); return; }
    if (event.target.closest('.stw') || event.target.closest('a')) return;
    const row = event.target.closest('.row[data-fid]');
    if (row) selectFile(row.dataset.fid);
  });

  $('hd').addEventListener('pointerdown', event => {
    const grip = event.target.closest('.rz');
    if (!grip || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // Freeze every column at its current on-screen width, then drag just this one.
    colW = Array.from($('hd').children).map(c => c.getBoundingClientRect().width);
    const i = Number(grip.dataset.i);
    const startX = event.clientX;
    const startW = colW[i];
    grip.classList.add('on');
    document.body.classList.add('col-resizing');
    const move = e => { colW[i] = Math.max(COL_MIN, startW + e.clientX - startX); applyColW(); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      grip.classList.remove('on');
      document.body.classList.remove('col-resizing');
      saveColW();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  $('hd').addEventListener('dblclick', event => {
    if (!event.target.closest('.rz')) return;
    colW = null;
    applyColW();
    saveColW();
  });

  $('hd').addEventListener('click', event => {
    if (event.target.closest('.stover') || event.target.closest('.rz')) return;
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


  function setView(view) {
    state.view = view;
    [...$('seg-view').children].forEach(b => b.classList.toggle('on', b.dataset.view === view));
    renderViews();
  }
  $('seg-view').addEventListener('click', event => {
    const btn = event.target.closest('button[data-view]');
    if (btn) setView(btn.dataset.view);
  });

  // My day controls (also the "need action today" chip).
  function setDay(ymd) {
    state.day = ymd || '';
    if (state.day) state.calMonth = state.day.slice(0, 7);
    if (state.day && state.view !== 'list') setView('list'); else renderViews();
  }
  document.addEventListener('click', event => {
    const b = event.target.closest('[data-day]');
    if (!b || !b.closest('#daybar, #kchips')) return;
    const act = b.dataset.day;
    if (act === 'today') setDay(todayYmd());
    else if (act === 'clear') setDay('');
    else if (act === 'prev' || act === 'next') setDay(shiftYmd(state.day || todayYmd(), act === 'prev' ? -1 : 1));
  });
  $('day-pick').addEventListener('change', event => setDay(event.target.value));
  $('day-mine').addEventListener('change', event => {
    state.mine = event.target.checked;
    if (state.mine && !state.me) showToast('Couldn’t tell who you are — showing everyone.', true);
    renderViews();
  });
  $('cal-head').addEventListener('click', event => {
    const b = event.target.closest('[data-cal]');
    if (!b) return;
    if (b.dataset.cal === 'today') state.calMonth = todayYmd().slice(0, 7);
    else {
      const [y, m] = state.calMonth.split('-').map(Number);
      const d = new Date(y, m - 1 + (b.dataset.cal === 'next' ? 1 : -1), 1, 12);
      state.calMonth = ymdOf(d).slice(0, 7);
    }
    renderCalendar();
  });
  $('cal').addEventListener('click', event => {
    const it = event.target.closest('[data-cal-fid]');
    if (it) { setDay(it.dataset.calDay); if (state.sel !== it.dataset.calFid) selectFile(it.dataset.calFid); return; }
    const day = event.target.closest('[data-cal-open]');
    if (day) setDay(day.dataset.calOpen);
  });
  (async () => {
    try {
      const me = await request('/api/v1/users/me/');
      state.me = me.full_name || me.email || '';
    } catch (_e) { state.me = ''; }
  })();

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
  document.addEventListener('click', event => {
    if (!event.target.closest('#lnk-menu') && !event.target.closest('[data-linked]')) closeLinked();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeLinked(); });
  window.addEventListener('resize', closeLinked);
  $('list-wrap').addEventListener('scroll', closeLinked);

  // ── Boot ───────────────────────────────────────────────────────────────────
  renderHead();
  load();
})();