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
  // Contact columns of the grid (same order as the Log table: Mobile / WA,
  // Email, Role, Company, City). All but Role get a header dropdown filter of
  // the values present, plus "(blank)" for empty cells.
  const CONTACT_COLS = [
    // Mobile / WA: the WhatsApp number when the contact has one (green icon),
    // else the first number (mobile icon). Filtered by that type, not value.
    { k: 'mobile',  label: 'Mobile / WA', get: f => phoneInfo(f).number, filter: true,
      options: [['whatsapp', 'WhatsApp'], ['mobile', 'Mobile']], match: (f, want) => phoneInfo(f).kind === want },
    { k: 'email',   label: 'Email',       get: f => f.contact.email, filter: true },
    { k: 'role',    label: 'Role',        get: f => f.contact.role, filter: false },
    { k: 'company', label: 'Company',     get: f => f.contact.company, filter: true },
    { k: 'city',    label: 'City',        get: f => f.site.city, filter: true },
  ];
  const CF_BLANK = '__blank__';
  // Which number the Mobile / WA column shows, and its type: a number labelled
  // WhatsApp wins ('whatsapp'); else the first number of any other label
  // ('mobile'); '' when the contact has no number.
  function phoneInfo(f) {
    const phones = (f.contact.phones || []).filter(p => p && String(p.number || '').trim());
    const wa = phones.find(p => /whats\s*app/i.test(String(p.label || '')));
    if (wa) return { kind: 'whatsapp', number: String(wa.number).trim() };
    const first = phones[0] ? String(phones[0].number).trim() : String(f.contact.mobile || '').trim();
    return first ? { kind: 'mobile', number: first } : { kind: '', number: '' };
  }
  const PHONE_ICON = {
    whatsapp: '<svg class="ph-ic is-wa" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>',
    mobile: '<svg class="ph-ic is-mob" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
  };
  const cfValue = (col, f) => String(col.get(f) || '').trim();

  // The statuses the grid's Status column offers (row dropdown + header filter).
  const STATUS_PICK = ['open', 'scheduled', 'viewed', 'done', 'cancelled'];
  // Colours only (background-color, not the `background` shorthand) so the
  // pill's chevron background-image from crm.css survives the inline style.
  const statusPillStyle = s => statusMeta(s).style.replace(/background:/g, 'background-color:');
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
    q: '',
    fSt: '',                 // status column filter
    fStage: '',              // stage column filter (a STAGE_PICK id)
    fCl: '',                 // client / lead column filter: '' | 'lead' | 'client'
    cf: { mobile: '', email: '', company: '', city: '' }, // contact column filters (CF_BLANK = empty cells)
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

  function visibleFiles() {
    let list = FILES.filter(f => textMatch(f));
    if (state.fSt) list = list.filter(f => f.status === state.fSt);
    if (state.fCl) list = list.filter(f => f.clientStatus === state.fCl);
    CONTACT_COLS.forEach(col => {
      const want = col.filter && state.cf[col.k];
      if (want) {
        list = list.filter(f => (want === CF_BLANK ? !cfValue(col, f)
          : col.match ? col.match(f, want) : cfValue(col, f) === want));
      }
    });
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

  function subjectCell(f) {
    // Site line = the site location only; the city has its own City column.
    const site = f.site.location || '';
    return `<div style="line-height:1.15"><span style="font-size:11px">${f.subject ? esc(f.subject) : ''}</span>`
      + (site ? `<div class="nm-sub">${esc(site)}</div>` : '') + '</div>';
  }

  function nextCell(f) {
    if (!f.fu) return '';
    const cls = f.fu.overdue ? 'fu-red' : 'mut';
    const label = f.fu.notes ? esc(f.fu.notes) : 'Follow-up';
    return `<span class="${cls}" style="font-size:10.5px" title="${esc(f.fu.notes || '')}">`
      + `${label} · ${esc(fmtYmd(f.fu.date))}${f.fu.overdue ? ' ⚠' : ''}</span>`;
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
      + `<span class="flt${state.fCl ? ' on' : ''}">Client / Lead <i class="farr">▾</i>`
      + `<select class="stover" data-act="fcl" title="Filter by client / lead">`
      + `<option value="">All</option><option value="lead"${state.fCl === 'lead' ? ' selected' : ''}>Lead</option>`
      + `<option value="client"${state.fCl === 'client' ? ' selected' : ''}>Client</option></select></span>`
      + CONTACT_COLS.map(contactHeadCell).join('')
      + '<span>Subject / site</span>'
      + `<span class="flt${state.fStage ? ' on' : ''}">Stage <i class="farr">▾</i>`
      + `<select class="stover" data-act="fstage" title="Filter by stage">${stageFilterOptions}</select></span>`
      + '<span>Next action</span>'
      + '<span>Own</span>'
      + `<span class="srt" data-sort="age">Age<i class="sarr2">${arrow('age')}</i></span>`
      + `<span class="flt${state.fSt ? ' on' : ''}">Status <i class="farr">▾</i>`
      + `<select class="stover" data-act="fst" title="Filter by status">${options}</select></span>`;
  }

  // Header cell of a contact column: plain for Role, else a dropdown filter
  // listing the values present in the loaded enquiries.
  function contactHeadCell(col) {
    if (!col.filter) return `<span>${esc(col.label)}</span>`;
    const want = state.cf[col.k];
    // A column with fixed options (Mobile / WA: WhatsApp, Mobile) lists those;
    // the others list the values present in the loaded enquiries.
    const choices = col.options
      ? col.options
      : [...new Set(FILES.map(f => cfValue(col, f)).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
        .map(v => [v, v]);
    const hasBlank = FILES.some(f => !cfValue(col, f));
    const options = [`<option value="">All</option>`]
      .concat(choices.map(([v, label]) => `<option value="${esc(v)}"${want === v ? ' selected' : ''}>${esc(label)}</option>`))
      .concat(hasBlank ? [`<option value="${CF_BLANK}"${want === CF_BLANK ? ' selected' : ''}>(blank)</option>`] : [])
      .join('');
    // An active filter shows only as the solid blue filter box; the header
    // keeps just the column name.
    return `<span class="flt${want ? ' on' : ''}">${esc(col.label)} <i class="farr">▾</i>`
      + `<select class="stover" data-act="cf" data-k="${col.k}" title="Filter by ${esc(col.label.toLowerCase())}">${options}</select></span>`;
  }

  // Row cells of the contact columns: plain text, blank when empty.
  function contactCells(f) {
    return CONTACT_COLS.map(col => {
      const v = cfValue(col, f);
      if (col.k === 'mobile') {
        const info = phoneInfo(f);
        if (!info.number) return '<div class="mut c2"></div>';
        const kind = info.kind === 'whatsapp' ? 'WhatsApp' : 'Mobile';
        return `<div class="mut num c2" title="${esc(kind + ': ' + info.number)}"><span class="ph-cell">`
          + `${PHONE_ICON[info.kind]}<span class="ph-num">${esc(info.number)}</span></span></div>`;
      }
      const cls = col.k === 'company' ? '' : col.k === 'mobile' ? 'mut num c2' : 'mut c2';
      return `<div class="${cls}" title="${esc(v)}">${esc(v)}</div>`;
    }).join('');
  }

  function rowHTML(f) {
    const cls = (state.sel === f.fid ? 'sel ' : '') + (isHot(f) ? 'hot' : '');
    return `<div class="row ${cls}" data-fid="${esc(f.fid)}">`
      + `<div><span class="code">${esc(f.code)}</span></div>`
      + `<div class="mut num" style="font-size:10.5px">${f.recvAt ? esc(fmtDMY(f.recvAt)) : ''}</div>`
      + `<div>${clientCell(f)}</div>`
      + contactCells(f)
      + `<div>${subjectCell(f)}</div>`
      + `<div>${stageCell(f)}</div>`
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
    const due = FILES.filter(isHot).length;
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
  async function patchFile(fid, patch, label) {
    try {
      await request(`${API}/files/${encodeURIComponent(fid)}`, { method: 'PATCH', body: patch });
      RAW.forEach(r => { if (r.file_id === fid) Object.assign(r, patch); });
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

  // ── New ENQ: the Log page's Add Log popup, exactly ─────────────────────────
  // Markup: add_ENQ_popup.html. /crm/add-enq/ui is the Log page reduced to its
  // Add Log popup and set to create CRM enquiries (stage "enquiry", origin
  // "crm"). It is preloaded once into a hidden full-screen frame and kept, so
  // "+ New ENQ" only fades in the backdrop and asks the popup to open (it
  // plays its own animation). Messages: frame → 'ready' / 'closed';
  // CRM → 'open-enq'.
  const ENQ_FORM_URL = `${API}/crm/add-enq/ui`;
  let enqReady = false;
  let enqPending = false;

  function preloadEnqForm() {
    const frame = $('enq-frame');
    if (frame && !frame.getAttribute('src')) frame.src = ENQ_FORM_URL;
  }

  function sendEnqOpen() {
    const frame = $('enq-frame');
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ source: 'achi-crm', type: 'open-enq' }, window.location.origin);
    try { frame.focus(); } catch (_e) { /* ignore */ }
  }

  function openEnqForm() {
    const wrap = $('enq-frame-wrap');
    if (!wrap) return;
    preloadEnqForm();
    wrap.classList.add('is-open');
    wrap.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (enqReady) sendEnqOpen(); else enqPending = true;   // opens on 'ready'
  }

  function closeEnqForm() {
    const wrap = $('enq-frame-wrap');
    if (!wrap || !wrap.classList.contains('is-open')) return;
    wrap.classList.remove('is-open');                      // backdrop fades out (crm.css)
    wrap.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    enqPending = false;
    load({ quiet: true });                                 // a saved enquiry shows up
  }

  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin) return;
    const data = event.data || {};
    if (data.source !== 'achi-add-enq') return;
    if (data.type === 'ready') {
      enqReady = true;
      if (enqPending) { enqPending = false; sendEnqOpen(); }
    } else if (data.type === 'closed') {
      closeEnqForm();
    }
  });

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
    else if (sel.dataset.act === 'cf') { state.cf[sel.dataset.k] = sel.value; renderViews(); }
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


  $('seg-view').addEventListener('click', event => {
    const btn = event.target.closest('button[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    [...$('seg-view').children].forEach(b => b.classList.toggle('on', b === btn));
    renderViews();
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
  if (newBtn) {
    newBtn.addEventListener('click', openEnqForm);
    newBtn.addEventListener('pointerenter', preloadEnqForm, { once: true });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  renderHead();
  // Preload the New ENQ form once the grid has had its turn on the network.
  load().finally(() => window.setTimeout(preloadEnqForm, 600));
})();