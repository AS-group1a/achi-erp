(function () {
  'use strict';

  if (window.top !== window.self) return;
  if (window.__achiCommentLoaded) return;
  window.__achiCommentLoaded = true;

  function achiToken() {
    try { return localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token') || ''; } catch (e) { return ''; }
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    var t = achiToken(); if (t) headers.Authorization = 'Bearer ' + t;
    opts.headers = headers;
    return fetch('/api/v1/achi' + path, opts);
  }
  function mapMsg(r) {
    return { id: r.id, author: r.author_name || 'Someone', text: r.text || '', issue: !!r.is_issue, resolved: !!r.resolved, ts: Date.parse(r.created_at) || Date.now() };
  }
  function mapReply(r) {
    return { id: r.id, author: r.author_name || 'Someone', where: r.where || '', text: r.text || '', ts: Date.parse(r.created_at) || Date.now() };
  }
  function mapComment(c) {
    var m = mapReply(c);
    m.replies = (c.replies || []).map(mapReply);
    m.status = c.status || 'open';
    m.assignedId = c.assigned_to_user_id || null;
    m.assignedName = c.assigned_to_name || '';
    return m;
  }
  function fetchComments() {
    return api('/comments').then(function (r) { return r.ok ? r.json() : null; }).then(function (list) {
      if (!list) return;
      comments = list.map(mapComment);
      // Don't clobber an editor the user is typing in; the array still updates.
      if (activeTab === 'comments' && !drafting && replyingId === null) renderComments();
      renderBadge();
    }).catch(function () {});
  }
  function fetchChat() {
    return api('/chat').then(function (r) { return r.ok ? r.json() : null; }).then(function (list) {
      if (!list) return;
      messages = list.map(mapMsg);
      if (activeTab === 'chat') renderChat();
      renderBadge();
    }).catch(function () {});
  }

  var comments = [];
  var messages = [];
  var collapsed = {};
  var drafting = false;
  var replyingId = null;
  var activeTab = 'comments';
  var chatFilter = 'all';
  var commentFilter = 'all';
  var selIndex = -1;

  var me = { name: 'You' };
  (function whoAmI() {
    var tok;
    try { tok = localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token'); } catch (e) {}
    if (!tok) return;
    fetch('/api/v1/users/me', { headers: { Authorization: 'Bearer ' + tok } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (u) {
        if (!u) return;
        var name = u.full_name || u.name || u.display_name
          || [u.first_name, u.last_name].filter(Boolean).join(' ')
          || (u.email ? String(u.email).split('@')[0] : '');
        if (name) me.name = name;
      })
      .catch(function () {});
  })();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function initials(name) {
    var p = String(name || '?').trim().split(/\s+/);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  var SWATCH = ['#2f6fb0', '#0f9d8f', '#b5561f', '#8046b7', '#c2185b', '#4b6bdc', '#4a7c2f'];
  function avatarColor(name) {
    var sum = 0, s = String(name || '?');
    for (var i = 0; i < s.length; i++) sum += s.charCodeAt(i);
    return SWATCH[sum % SWATCH.length];
  }

  function ago(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return 'Just now';
    if (s < 60) return s + ' seconds ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m === 1 ? 'A minute ago' : m + ' minutes ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h === 1 ? 'An hour ago' : h + ' hours ago';
    var d = Math.floor(h / 24);
    if (d < 7) return d === 1 ? 'Yesterday' : d + ' days ago';
    return new Date(ts).toLocaleDateString();
  }

  var ROUTES = [
    ['/call-log', 'Call Log'], ['/achi', 'Call Log'], ['/dashboard', 'Dashboard'],
    ['/project', 'Projects'], ['/lead', 'Leads'], ['/crm', 'CRM'], ['/contact', 'Contacts'],
    ['/finance', 'Finance'], ['/invoic', 'Invoices'], ['/estimat', 'Estimating'],
    ['/quotation', 'Quotations'], ['/tender', 'Tenders'], ['/procure', 'Procurement'],
    ['/survey', 'Site Survey'], ['/file', 'Project Files'], ['/schedule', 'Schedule'],
    ['/setting', 'Settings']
  ];
  function pageLabel() {
    try { var a = document.body && document.body.getAttribute('data-achi-title'); if (a) return a; } catch (e) {}
    var path = (location.pathname || '/').toLowerCase();
    for (var i = 0; i < ROUTES.length; i++) if (path.indexOf(ROUTES[i][0]) !== -1) return ROUTES[i][1];
    if (path === '/' || path === '') return 'Dashboard';
    var t = (document.title || '').split(/[|·–—]/)[0].trim();
    if (t && !/not found/i.test(t)) return t;
    var seg = path.split('/').filter(Boolean)[0];
    return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : 'This page';
  }
  function whereHTML(w) { return w ? '<span class="acmt-where">' + esc(w) + '</span>' : ''; }

  var FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';
  var NAVY = '#284F9E';
  var BD = '#dfe4ec';
  var WASH = '#eef1f6';
  var TX = '#1d1d1f', TX2 = '#5b5e66', TX3 = '#8a8f98';
  var CSS = ''
    + '.acmt-tab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147482400;'
    +   'display:flex;align-items:center;gap:8px;padding:15px 9px;border:0;cursor:pointer;'
    +   'background:' + NAVY + ';color:#fff;border-radius:8px 0 0 8px;'
    +   'writing-mode:vertical-rl;font-family:' + FONT + ';font-size:12.5px;font-weight:700;letter-spacing:.02em;'
    +   'box-shadow:-5px 0 16px rgba(20,33,61,.22);transition:background .15s,box-shadow .15s,opacity .15s}'
    + '.acmt-tab:hover{background:#1F3F80;box-shadow:-7px 0 22px rgba(20,33,61,.3)}'
    + '.acmt-tab svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transform:rotate(90deg)}'
    + '.acmt-tab-badge{position:absolute;top:-6px;left:-6px;min-width:18px;height:18px;padding:0 4px;'
    +   'display:grid;place-items:center;border-radius:9px;background:#ef4444;color:#fff;font-size:11px;font-weight:800;writing-mode:horizontal-tb}'
    + '.acmt-tab-badge[hidden]{display:none}'
    + '.acmt-tab.hidden{opacity:0;pointer-events:none}'
    + '.acmt-panel{position:fixed;top:50%;right:0;z-index:2147482401;width:min(388px,96vw);height:min(600px,calc(100vh - 36px));'
    +   'display:flex;flex-direction:column;overflow:hidden;background:' + WASH + ';font-family:' + FONT + ';color:' + TX + ';'
    +   'border:1px solid #cdd8ea;border-right:0;border-radius:6px 0 0 6px;box-shadow:-12px 0 34px rgba(15,35,75,.16);'
    +   'transform:translate(100%,-50%);transition:transform .22s cubic-bezier(.2,0,.2,1)}'
    + '.acmt-panel.open{transform:translate(0,-50%)}'
    + '.acmt-head{display:flex;align-items:center;gap:8px;padding:12px 12px 12px 18px;background:' + NAVY + ';color:#fff;flex:0 0 auto}'
    + '.acmt-head h2{font-size:15px;font-weight:600;letter-spacing:.01em;color:#fff;margin:0}'
    + '.acmt-chev{border:0;background:transparent;color:rgba(255,255,255,.72);cursor:pointer;padding:2px;line-height:1;font-size:12px}'
    + '.acmt-chev:hover{color:#fff}'
    + '.acmt-x{margin-left:auto;width:28px;height:28px;border:0;border-radius:7px;background:rgba(255,255,255,.16);color:#fff;font-size:15px;cursor:pointer;line-height:1;display:grid;place-items:center}'
    + '.acmt-x:hover{background:rgba(255,255,255,.3)}'
    + '.acmt-tabs{display:flex;align-items:center;padding:10px 14px;background:#fff;border-bottom:1px solid ' + BD + ';flex:0 0 auto}'
    + '.acmt-seg{display:inline-flex;background:' + WASH + ';border-radius:8px;padding:3px;width:100%}'
    + '.acmt-seg button{flex:1;border:0;background:transparent;color:' + TX2 + ';font:inherit;font-size:12.5px;font-weight:600;padding:7px 12px;border-radius:6px;cursor:pointer;transition:color .12s}'
    + '.acmt-seg button.on{background:#fff;color:' + NAVY + ';box-shadow:0 1px 3px rgba(16,24,40,.14)}'
    + '.acmt-bar{display:flex;align-items:center;gap:8px;padding:11px 14px;background:#fff;border-bottom:1px solid ' + BD + ';flex:0 0 auto}'
    + '.acmt-new{display:inline-flex;align-items:center;gap:7px;border:0;background:' + NAVY + ';'
    +   'color:#fff;border-radius:6px;padding:8px 14px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;'
    +   'transition:background .12s}'
    + '.acmt-new:hover{background:#1F3F80}'
    + '.acmt-new svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
    + '.acmt-nav{margin-left:auto;display:flex;gap:5px}'
    + '.acmt-nav button{width:30px;height:30px;border:1px solid ' + BD + ';border-radius:6px;background:#fff;color:' + TX2 + ';cursor:pointer;display:grid;place-items:center;transition:border-color .12s,color .12s}'
    + '.acmt-nav button:hover{border-color:' + NAVY + ';color:' + NAVY + '}'
    + '.acmt-nav svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
    + '.acmt-cfilter{display:flex;gap:7px;flex-wrap:wrap;padding:11px 14px;background:#fff;border-bottom:1px solid ' + BD + ';flex:0 0 auto}'
    + '.acmt-chip{border:1px solid ' + BD + ';background:#fff;color:' + TX2 + ';border-radius:999px;padding:5px 11px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}'
    + '.acmt-chip:hover{background:' + WASH + '}'
    + '.acmt-chip.on{background:' + NAVY + ';border-color:' + NAVY + ';color:#fff}'
    + '.acmt-list{flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;'
    +   'box-shadow:inset 0 7px 7px -7px rgba(15,35,75,.16);-webkit-overflow-scrolling:touch}'
    + '.acmt-empty{margin:48px 22px;color:' + TX3 + ';font-size:13px;line-height:1.6;text-align:center}'
    + '.acmt-empty svg{width:32px;height:32px;stroke:#c2ccdb;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;margin-bottom:10px}'
    + '.acmt-empty b{color:' + NAVY + '}'
    + '.acmt-item{background:#fff;border:1px solid ' + BD + ';border-radius:8px;padding:11px 13px;box-shadow:0 1px 2px rgba(16,24,40,.05)}'
    + '.acmt-item.sel{border-color:' + NAVY + ';box-shadow:0 0 0 3px rgba(40,79,158,.14)}'
    + '.acmt-item.issue{border-left:3px solid #f59e0b;padding-left:10px}'
    + '.acmt-item.resolved{opacity:.6}'
    + '.acmt-row{display:flex;align-items:flex-start;gap:10px}'
    + '.acmt-tri{border:0;background:transparent;color:' + TX3 + ';cursor:pointer;padding:2px 0 0;font-size:10px;line-height:1;width:12px;flex:0 0 auto}'
    + '.acmt-av{flex:0 0 auto;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:11.5px;font-weight:800}'
    + '.acmt-av.sm{width:26px;height:26px;font-size:10px}'
    + '.acmt-body{min-width:0;flex:1}'
    + '.acmt-name{font-size:13px;font-weight:700;color:' + TX + '}'
    + '.acmt-where{font-size:12px;font-weight:700;color:' + TX + ';opacity:.3;margin-left:6px}'
    + '.acmt-time{font-size:11.5px;color:' + TX3 + ';margin-left:6px;font-weight:500}'
    + '.acmt-issuetag{margin-left:6px;font-size:10.5px;font-weight:700;color:#8a5a12;background:#fff4e0;border-radius:5px;padding:1px 7px}'
    + '.acmt-donetag{margin-left:6px;font-size:10.5px;font-weight:700;color:#15803d;background:#e7f6ec;border-radius:5px;padding:1px 7px}'
    // Workflow status pills shown next to a comment's author.
    + '.acmt-tag{margin-left:6px;font-size:10.5px;font-weight:700;border-radius:5px;padding:1px 7px;white-space:nowrap}'
    + '.acmt-tag-testing{color:#8a5a12;background:#fff4e0}'
    + '.acmt-tag-done{color:#1e40af;background:#e6edfb}'
    + '.acmt-tag-resolved{color:#15803d;background:#e7f6ec}'
    // "Assigned by X" — visible to the whole team so nobody double-works an issue.
    + '.acmt-assigntag{display:inline-block;margin-left:6px;font-size:10.5px;font-weight:700;color:' + NAVY + ';background:#e8edf9;border-radius:5px;padding:1px 7px;white-space:nowrap}'
    + '.acmt-text{margin:4px 0 0;font-size:13px;line-height:1.55;color:#33373d;white-space:pre-wrap;word-wrap:break-word}'
    + '.acmt-actions{margin-top:8px;display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px}'
    + '.acmt-link{border:0;background:transparent;color:' + TX2 + ';font:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:0}'
    + '.acmt-link:hover{color:' + NAVY + '}'
    + '.acmt-link.del:hover{color:#c0392b}'
    + '.acmt-link.solve{color:#15803d}'
    + '.acmt-link.on{color:' + NAVY + ';text-decoration:underline}'
    + '.acmt-link.assign.on{color:#15803d}'
    + '.acmt-item.done{opacity:.75}'
    + '.acmt-replies{margin:11px 0 0 20px;padding-left:12px;border-left:2px solid ' + WASH + ';display:flex;flex-direction:column;gap:12px}'
    + '.acmt-reply{display:flex;align-items:flex-start;gap:9px}'
    + '.acmt-ractions{margin-top:5px}'
    + '.acmt-edit{margin-top:8px}'
    + '.acmt-ta{width:100%;box-sizing:border-box;min-height:56px;resize:vertical;border:1px solid ' + NAVY + ';'
    +   'border-radius:8px;padding:9px 11px;font:inherit;font-size:13px;color:' + TX + ';outline:0;box-shadow:0 0 0 3px rgba(40,79,158,.16)}'
    + '.acmt-editbtns{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}'
    + '.acmt-post{border:0;border-radius:6px;background:' + NAVY + ';color:#fff;font:inherit;font-size:12.5px;font-weight:600;padding:8px 15px;cursor:pointer}'
    + '.acmt-post:hover{background:#1F3F80}'
    + '.acmt-post:disabled{background:#b7c2da;cursor:default}'
    + '.acmt-cancel{border:1.5px solid #e0e0ea;border-radius:6px;background:#fff;color:#6b7280;font:inherit;font-size:12.5px;font-weight:600;padding:8px 14px;cursor:pointer}'
    + '.acmt-cancel:hover{background:' + WASH + '}'
    + '.acmt-compose{border-top:1px solid ' + BD + ';background:#fff;padding:11px 14px;display:flex;flex-direction:column;gap:8px;flex:0 0 auto}'
    + '.acmt-tinput{width:100%;box-sizing:border-box;border:1px solid #cfd9e8;border-radius:8px;padding:9px 11px;font:inherit;font-size:13px;color:' + TX + ';outline:0;background:#fff}'
    + '.acmt-tinput:focus{border-color:' + NAVY + ';box-shadow:0 0 0 3px rgba(40,79,158,.16)}'
    + 'textarea.acmt-tinput{min-height:48px;resize:vertical}'
    + '.acmt-crow2{display:flex;align-items:center;justify-content:space-between;gap:8px}'
    + '.acmt-issueflag{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:' + TX2 + ';cursor:pointer;user-select:none}'
    + '.acmt-issueflag input{width:15px;height:15px;accent-color:' + NAVY + ';cursor:pointer}'
    + '.acmt-tsend{border:0;border-radius:6px;background:' + NAVY + ';color:#fff;font:inherit;font-size:12.5px;font-weight:600;padding:8px 16px;cursor:pointer}'
    + '.acmt-tsend:hover{background:#1F3F80}'
    + '.acmt-tsend:disabled{background:#b7c2da;cursor:default}'
    + '.acmt-panel.mode-comments .acmt-only-chat{display:none}'
    + '.acmt-panel.mode-chat .acmt-only-comments{display:none}'
    + '@media (prefers-reduced-motion:reduce){.acmt-panel{transition:none}}';

  var els = {};

  function avatarHTML(name, small) {
    return '<div class="acmt-av' + (small ? ' sm' : '') + '" style="background:' + avatarColor(name) + '">'
      + esc(initials(name)) + '</div>';
  }

  function editorHTML(placeholder, postLabel) {
    return '<div class="acmt-edit">'
      + '<textarea class="acmt-ta" placeholder="' + esc(placeholder) + '"></textarea>'
      + '<div class="acmt-editbtns">'
      +   '<button class="acmt-cancel" type="button">Cancel</button>'
      +   '<button class="acmt-post" type="button" disabled>' + esc(postLabel) + '</button>'
      + '</div></div>';
  }

  function replyHTML(r) {
    // Reply actions use data-ract (not data-act): the parent item's wiring grabs
    // every [data-act] inside it, so a reply's button must NOT match that or a
    // reply-delete would fire against the parent comment's id.
    return '<div class="acmt-reply" data-rid="' + esc(r.id) + '">' + avatarHTML(r.author, true)
      + '<div class="acmt-body">'
      +   '<div><span class="acmt-name">' + esc(r.author) + '</span>' + whereHTML(r.where) + '<span class="acmt-time">' + esc(ago(r.ts)) + '</span></div>'
      +   '<p class="acmt-text">' + esc(r.text) + '</p>'
      +   '<div class="acmt-ractions"><button class="acmt-link del" data-ract="delete">Delete</button></div>'
      + '</div></div>';
  }

  function statusTag(st) {
    if (st === 'resolved') return '<span class="acmt-tag acmt-tag-resolved">Resolved</span>';
    if (st === 'testing') return '<span class="acmt-tag acmt-tag-testing">Testing</span>';
    if (st === 'done') return '<span class="acmt-tag acmt-tag-done">Done</span>';
    return '';
  }
  function assignTag(c) {
    if (!c.assignedName) return '';
    return '<span class="acmt-assigntag">👤 Assigned by ' + esc(c.assignedName) + '</span>';
  }
  // A small toggle button for a workflow status: clicking the active one clears
  // it back to "open".
  function statusBtn(st, label, cur) {
    return '<button class="acmt-link' + (cur === st ? ' on' : '') + '" data-act="st-' + st + '">' + esc(label) + '</button>';
  }

  function itemHTML(c, idx) {
    var replies = c.replies || [];
    var st = c.status || 'open';
    var cls = 'acmt-item'
      + (idx === selIndex ? ' sel' : '')
      + (st === 'resolved' ? ' resolved' : '')
      + (st === 'done' ? ' done' : '');
    var html = '<div class="' + cls + '" data-id="' + esc(c.id) + '">'
      + '<div class="acmt-row">'
      +   '<button class="acmt-tri" data-act="toggle" aria-label="Collapse">' + (collapsed[c.id] ? '▶' : '▼') + '</button>'
      +   avatarHTML(c.author, false)
      +   '<div class="acmt-body">'
      +     '<div><span class="acmt-name">' + esc(c.author) + '</span>' + whereHTML(c.where)
      +       statusTag(st) + assignTag(c)
      +       '<span class="acmt-time">' + esc(ago(c.ts)) + '</span></div>'
      +     '<p class="acmt-text">' + esc(c.text) + '</p>';
    if (!collapsed[c.id]) {
      html += '<div class="acmt-actions">'
        +   '<button class="acmt-link" data-act="reply">Reply</button>'
        +   '<button class="acmt-link assign' + (c.assignedId ? ' on' : '') + '" data-act="assign">'
        +     (c.assignedId ? 'Unassign' : 'Assign to me') + '</button>'
        +   statusBtn('resolved', 'Resolved', st)
        +   statusBtn('testing', 'Testing', st)
        +   statusBtn('done', 'Done', st)
        +   '<button class="acmt-link del" data-act="delete">Delete</button>'
        + '</div>';
      if (replies.length) html += '<div class="acmt-replies">' + replies.map(replyHTML).join('') + '</div>';
      if (replyingId === c.id) html += editorHTML('Reply…', 'Reply');
    }
    html += '</div></div></div>';
    return html;
  }

  function msgCardHTML(m) {
    var acts = '';
    if (m.issue) {
      acts += '<button class="acmt-link solve" data-mact="resolve">' + (m.resolved ? 'Reopen' : '✓ Resolve') + '</button>';
    }
    acts += '<button class="acmt-link del" data-mact="delmsg">Delete</button>';
    return '<div class="acmt-item' + (m.issue ? ' issue' : '') + (m.resolved ? ' resolved' : '') + '" data-mid="' + esc(m.id) + '">'
      + '<div class="acmt-row">' + avatarHTML(m.author, false)
      +   '<div class="acmt-body">'
      +     '<div><span class="acmt-name">' + esc(m.author) + '</span>'
      +       (m.issue ? '<span class="acmt-issuetag">Issue</span>' : '')
      +       (m.resolved ? '<span class="acmt-donetag">Resolved</span>' : '')
      +       '<span class="acmt-time">' + esc(ago(m.ts)) + '</span></div>'
      +     '<p class="acmt-text">' + esc(m.text) + '</p>'
      +     '<div class="acmt-actions">' + acts + '</div>'
      +   '</div>'
      + '</div></div>';
  }

  var EMPTY = '<div class="acmt-empty">'
    + '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    + '<div>No comments yet.<br>Press <b>New</b> to leave the first one.</div></div>';

  function chatEmpty() {
    if (chatFilter === 'issues') return '<div class="acmt-empty"><svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><div>No open issues.<br>Nothing to solve right now.</div></div>';
    if (chatFilter === 'resolved') return '<div class="acmt-empty"><svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><div>No resolved issues yet.</div></div>';
    return '<div class="acmt-empty"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><div>No messages yet.<br>Say something to the team, or flag an <b>issue</b>.</div></div>';
  }

  function visibleMsgs() {
    return messages.filter(function (m) {
      if (chatFilter === 'resolved') return m.resolved;
      if (m.resolved) return false;
      if (chatFilter === 'issues') return m.issue;
      return true;
    });
  }

  function visibleComments() {
    if (commentFilter === 'all') return comments;
    return comments.filter(function (c) { return (c.status || 'open') === commentFilter; });
  }

  function commentEmpty() {
    if (commentFilter === 'resolved') return '<div class="acmt-empty"><svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><div>No resolved comments.</div></div>';
    if (commentFilter === 'testing') return '<div class="acmt-empty"><svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><div>Nothing in testing.</div></div>';
    if (commentFilter === 'done') return '<div class="acmt-empty"><svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><div>Nothing marked done.</div></div>';
    return EMPTY;
  }

  function byId(id) { for (var i = 0; i < comments.length; i++) if (comments[i].id === id) return comments[i]; return null; }

  function render() {
    if (activeTab === 'chat') renderChat(); else renderComments();
    renderBadge();
  }

  function renderComments() {
    var html = '';
    if (drafting) {
      html += '<div class="acmt-item" data-draft="1"><div class="acmt-row">'
        + '<span class="acmt-tri" style="visibility:hidden">▼</span>'
        + avatarHTML(me.name, false)
        + '<div class="acmt-body">'
        +   '<div><span class="acmt-name">' + esc(me.name) + '</span>' + whereHTML(pageLabel()) + '<span class="acmt-time">Now</span></div>'
        +   editorHTML('Type a comment…', 'Post')
        + '</div></div></div>';
    }
    var list = visibleComments();
    html += list.length ? list.map(itemHTML).join('') : (drafting ? '' : commentEmpty());
    els.list.innerHTML = html;
    wireList();
    focusOpenEditor();
  }

  function renderChat(goBottom) {
    var prev = els.list.scrollTop;
    var atBottom = (els.list.scrollHeight - els.list.clientHeight - prev) < 30;
    var v = visibleMsgs();
    els.list.innerHTML = v.length ? v.map(msgCardHTML).join('') : chatEmpty();
    wireChat();
    if (goBottom || (atBottom && chatFilter === 'all')) els.list.scrollTop = els.list.scrollHeight;
    else els.list.scrollTop = prev;
  }

  function openIssues() { return messages.filter(function (m) { return m.issue && !m.resolved; }).length; }
  function openComments() { return comments.filter(function (c) { var s = c.status || 'open'; return s !== 'resolved' && s !== 'done'; }).length; }

  function renderBadge() {
    var n = openComments() + openIssues();
    els.badge.hidden = n === 0;
    els.badge.textContent = n;
  }

  function focusOpenEditor() {
    var ta = els.list.querySelector('.acmt-ta');
    if (ta) { ta.focus(); }
  }
  function wireEditor(scope, onPost) {
    var ta = scope.querySelector('.acmt-ta');
    var post = scope.querySelector('.acmt-post');
    var cancel = scope.querySelector('.acmt-cancel');
    if (!ta) return;
    ta.addEventListener('input', function () { post.disabled = !ta.value.trim(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (ta.value.trim()) onPost(ta.value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
    });
    post.addEventListener('click', function () { if (ta.value.trim()) onPost(ta.value.trim()); });
    cancel.addEventListener('click', cancelEdit);
  }

  function cancelEdit() { drafting = false; replyingId = null; render(); }

  function wireList() {
    var draft = els.list.querySelector('[data-draft]');
    if (draft) wireEditor(draft, function (text) {
      api('/comments', { method: 'POST', body: JSON.stringify({ text: text, where: pageLabel().slice(0, 120) }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (row) { if (row) { drafting = false; fetchComments(); } })
        .catch(function () {});
    });

    els.list.querySelectorAll('.acmt-item[data-id]').forEach(function (item) {
      var id = item.getAttribute('data-id');
      item.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () { onAct(btn.getAttribute('data-act'), id); });
      });
      if (replyingId === id) {
        wireEditor(item, function (text) {
          api('/comments', { method: 'POST', body: JSON.stringify({ text: text, where: pageLabel().slice(0, 120), parent_id: id }) })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (row) { if (row) { replyingId = null; fetchComments(); } })
            .catch(function () {});
        });
      }
    });

    // Reply-level actions (their own id, own attribute — see replyHTML).
    els.list.querySelectorAll('.acmt-reply[data-rid]').forEach(function (rep) {
      var rid = rep.getAttribute('data-rid');
      rep.querySelectorAll('[data-ract]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (btn.getAttribute('data-ract') !== 'delete') return;
          api('/comments/' + encodeURIComponent(rid), { method: 'DELETE' })
            .then(function (r) { if (r.ok || r.status === 204) fetchComments(); })
            .catch(function () {});
        });
      });
    });
  }

  function wireChat() {
    els.list.querySelectorAll('.acmt-item[data-mid]').forEach(function (item) {
      var id = item.getAttribute('data-mid');
      item.querySelectorAll('[data-mact]').forEach(function (btn) {
        btn.addEventListener('click', function () { onMsgAct(btn.getAttribute('data-mact'), id); });
      });
    });
  }

  function byMid(id) { for (var i = 0; i < messages.length; i++) if (messages[i].id === id) return messages[i]; return null; }

  // Persist a workflow change (status / assignment) and refresh the shared list
  // so every teammate's next poll sees it.
  function patchComment(id, body) {
    api('/comments/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(body) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (row) { if (row) fetchComments(); })
      .catch(function () {});
  }

  function onAct(act, id) {
    if (act === 'toggle') { if (collapsed[id]) delete collapsed[id]; else collapsed[id] = true; renderComments(); }
    else if (act === 'reply') { replyingId = replyingId === id ? null : id; drafting = false; renderComments(); }
    else if (act === 'assign') {
      var c = byId(id);
      patchComment(id, { assigned: !(c && c.assignedId) });
    }
    else if (act.indexOf('st-') === 0) {
      var st = act.slice(3);                 // testing | done | resolved
      var cur = byId(id);
      // Clicking the current status clears it back to "open" (a toggle).
      patchComment(id, { status: (cur && cur.status === st) ? 'open' : st });
    }
    else if (act === 'delete') {
      api('/comments/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function (r) { if (r.ok || r.status === 204) fetchComments(); })
        .catch(function () {});
    }
  }

  function onMsgAct(act, id) {
    var m = byMid(id);
    if (!m) return;
    if (act === 'resolve') {
      var want = !m.resolved;
      api('/chat/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ resolved: want }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (row) { if (row) { m.resolved = !!row.resolved; render(); } })
        .catch(function () {});
    } else if (act === 'delmsg') {
      api('/chat/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function (r) { if (r.ok || r.status === 204) { messages = messages.filter(function (x) { return x.id !== id; }); render(); } })
        .catch(function () {});
    }
  }

  function sendMsg() {
    var text = els.ctext.value.trim();
    if (!text) return;
    var issue = !!els.isissue.checked;
    els.tsend.disabled = true;
    api('/chat', { method: 'POST', body: JSON.stringify({ text: text, is_issue: issue }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (row) {
        if (row) {
          els.ctext.value = ''; els.isissue.checked = false; updateChatSend();
          messages.push(mapMsg(row)); renderChat(true); renderBadge();
        } else { updateChatSend(); }
      })
      .catch(function () { updateChatSend(); });
  }
  function updateChatSend() { els.tsend.disabled = !els.ctext.value.trim(); }

  function openPanel() { els.panel.classList.add('open'); els.tab.classList.add('hidden'); render(); fetchComments(); fetchChat(); }
  function closePanel() { els.panel.classList.remove('open'); els.tab.classList.remove('hidden'); drafting = false; replyingId = null; }

  function startNew() { drafting = true; replyingId = null; render(); }

  function navComment(dir) {
    var list = visibleComments();
    if (!list.length) return;
    selIndex = Math.max(0, Math.min(list.length - 1, (selIndex < 0 ? (dir > 0 ? -1 : list.length) : selIndex) + dir));
    render();
    var el = els.list.querySelectorAll('.acmt-item[data-id]')[selIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function collapseAll() {
    if (activeTab !== 'comments') return;
    var anyOpen = comments.some(function (c) { return !collapsed[c.id]; });
    comments.forEach(function (c) { if (anyOpen) collapsed[c.id] = true; else delete collapsed[c.id]; });
    renderComments();
  }

  function setTab(tab) {
    activeTab = tab;
    drafting = false; replyingId = null;
    els.panel.classList.toggle('mode-chat', tab === 'chat');
    els.panel.classList.toggle('mode-comments', tab === 'comments');
    els.segC.classList.toggle('on', tab === 'comments');
    els.segT.classList.toggle('on', tab === 'chat');
    els.title.textContent = tab === 'chat' ? 'Team Chat' : 'Comments';
    render();
    if (tab === 'chat') fetchChat(); else fetchComments();
  }

  function build() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var tab = document.createElement('button');
    tab.className = 'acmt-tab';
    tab.type = 'button';
    tab.setAttribute('aria-label', 'Open comments');
    tab.innerHTML = '<span class="acmt-tab-badge" hidden></span>'
      + '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
      + '<span>Comment</span>';
    tab.addEventListener('click', openPanel);

    var panel = document.createElement('aside');
    panel.className = 'acmt-panel mode-comments';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'Comments and team chat');
    panel.innerHTML =
      '<div class="acmt-head">'
      +   '<h2 class="acmt-title">Comments</h2>'
      +   '<button class="acmt-chev" type="button" aria-label="Collapse all">▾</button>'
      +   '<button class="acmt-x" type="button" aria-label="Close">✕</button>'
      + '</div>'
      + '<div class="acmt-tabs"><div class="acmt-seg">'
      +   '<button class="acmt-segc on" type="button">Comments</button>'
      +   '<button class="acmt-segt" type="button">Team Chat</button>'
      + '</div></div>'
      + '<div class="acmt-bar acmt-only-comments">'
      +   '<button class="acmt-new" type="button">'
      +     '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 8v6M9 11h6"/></svg>'
      +     'New</button>'
      +   '<div class="acmt-nav">'
      +     '<button data-nav="-1" type="button" aria-label="Previous comment"><svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg></button>'
      +     '<button data-nav="1" type="button" aria-label="Next comment"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>'
      +   '</div>'
      + '</div>'
      + '<div class="acmt-cfilter acmt-only-comments">'
      +   '<button class="acmt-chip on" data-cmf="all" type="button">All</button>'
      +   '<button class="acmt-chip" data-cmf="resolved" type="button">Resolved</button>'
      +   '<button class="acmt-chip" data-cmf="testing" type="button">Testing</button>'
      +   '<button class="acmt-chip" data-cmf="done" type="button">Done</button>'
      + '</div>'
      + '<div class="acmt-cfilter acmt-only-chat">'
      +   '<button class="acmt-chip on" data-cf="all" type="button">All</button>'
      +   '<button class="acmt-chip" data-cf="issues" type="button">Issues</button>'
      +   '<button class="acmt-chip" data-cf="resolved" type="button">Resolved</button>'
      + '</div>'
      + '<div class="acmt-list"></div>'
      + '<div class="acmt-compose acmt-only-chat">'
      +   '<textarea class="acmt-tinput acmt-ctext" placeholder="Message the team…" aria-label="Message"></textarea>'
      +   '<div class="acmt-crow2">'
      +     '<label class="acmt-issueflag"><input type="checkbox" class="acmt-isissue"> ⚠️ Mark as issue</label>'
      +     '<button class="acmt-tsend" type="button" disabled>Send ▸</button>'
      +   '</div>'
      + '</div>';

    document.body.appendChild(tab);
    document.body.appendChild(panel);

    els = {
      tab: tab, panel: panel,
      list: panel.querySelector('.acmt-list'),
      badge: tab.querySelector('.acmt-tab-badge'),
      title: panel.querySelector('.acmt-title'),
      segC: panel.querySelector('.acmt-segc'),
      segT: panel.querySelector('.acmt-segt'),
      ctext: panel.querySelector('.acmt-ctext'),
      isissue: panel.querySelector('.acmt-isissue'),
      tsend: panel.querySelector('.acmt-tsend')
    };

    panel.querySelector('.acmt-x').addEventListener('click', closePanel);
    panel.querySelector('.acmt-chev').addEventListener('click', collapseAll);
    panel.querySelector('.acmt-new').addEventListener('click', startNew);
    panel.querySelectorAll('.acmt-nav button').forEach(function (b) {
      b.addEventListener('click', function () { navComment(parseInt(b.getAttribute('data-nav'), 10)); });
    });
    els.segC.addEventListener('click', function () { setTab('comments'); });
    els.segT.addEventListener('click', function () { setTab('chat'); });
    panel.querySelectorAll('.acmt-only-chat .acmt-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        chatFilter = chip.getAttribute('data-cf');
        panel.querySelectorAll('.acmt-only-chat .acmt-chip').forEach(function (c) { c.classList.remove('on'); });
        chip.classList.add('on');
        renderChat();
      });
    });
    panel.querySelectorAll('.acmt-only-comments .acmt-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        commentFilter = chip.getAttribute('data-cmf');
        panel.querySelectorAll('.acmt-only-comments .acmt-chip').forEach(function (c) { c.classList.remove('on'); });
        chip.classList.add('on');
        selIndex = -1;
        renderComments();
      });
    });
    els.ctext.addEventListener('input', updateChatSend);
    els.ctext.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });
    els.tsend.addEventListener('click', sendMsg);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('open') && !drafting && replyingId === null) closePanel();
    });

    renderBadge();
    fetchComments();
    fetchChat();
    setInterval(function () {
      if (!els.panel.classList.contains('open')) return;
      if (activeTab === 'chat') fetchChat(); else fetchComments();
    }, 5000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
