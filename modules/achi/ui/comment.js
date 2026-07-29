(function () {
  'use strict';

  if (window.top !== window.self) return;
  if (window.__achiCommentLoaded) return;
  window.__achiCommentLoaded = true;

  var STORE_KEY = 'achi_comments_v2';

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [];
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(comments)); } catch (e) {}
  }

  var comments = load();
  var drafting = false;
  var replyingId = null;
  var seq = 0;

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

  function uid() { seq++; return 'c' + seq + '-' + comments.length; }

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
  var GRAD = 'linear-gradient(135deg,#1e3f85,#284f9e)';
  var BD = '#dfe4ec';
  var WASH = '#eef1f6';
  var TX = '#1d1d1f', TX2 = '#5b5e66', TX3 = '#8a8f98';
  var CSS = ''
    + '.acmt-tab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147482400;'
    +   'display:flex;align-items:center;gap:8px;padding:15px 9px;border:0;cursor:pointer;'
    +   'background:' + GRAD + ';color:#fff;border-radius:12px 0 0 12px;'
    +   'writing-mode:vertical-rl;font-family:' + FONT + ';font-size:12.5px;font-weight:800;letter-spacing:.02em;'
    +   'box-shadow:-6px 0 20px rgba(20,33,61,.28);transition:filter .15s,box-shadow .15s,opacity .15s}'
    + '.acmt-tab:hover{filter:brightness(1.08);box-shadow:-8px 0 26px rgba(20,33,61,.36)}'
    + '.acmt-tab svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transform:rotate(90deg)}'
    + '.acmt-tab-badge{position:absolute;top:-6px;left:-6px;min-width:18px;height:18px;padding:0 4px;'
    +   'display:grid;place-items:center;border-radius:9px;background:#ef4444;color:#fff;font-size:11px;font-weight:800;writing-mode:horizontal-tb}'
    + '.acmt-tab-badge[hidden]{display:none}'
    + '.acmt-tab.hidden{opacity:0;pointer-events:none}'
    + '.acmt-panel{position:fixed;top:0;right:0;bottom:0;z-index:2147482401;width:min(404px,96vw);'
    +   'display:flex;flex-direction:column;background:' + WASH + ';font-family:' + FONT + ';color:' + TX + ';'
    +   'border-left:1px solid #cdd8ea;box-shadow:-20px 0 56px rgba(15,35,75,.24);'
    +   'transform:translateX(100%);transition:transform .22s cubic-bezier(.2,0,.2,1)}'
    + '.acmt-panel.open{transform:none}'
    + '.acmt-head{display:flex;align-items:center;gap:8px;padding:15px 14px 15px 20px;background:' + GRAD + ';color:#fff;flex:0 0 auto}'
    + '.acmt-head h2{font-size:16px;font-weight:800;letter-spacing:.01em;color:#fff;margin:0}'
    + '.acmt-chev{border:0;background:transparent;color:rgba(255,255,255,.72);cursor:pointer;padding:2px;line-height:1;font-size:12px}'
    + '.acmt-chev:hover{color:#fff}'
    + '.acmt-x{margin-left:auto;width:28px;height:28px;border:0;border-radius:7px;background:rgba(255,255,255,.16);color:#fff;font-size:15px;cursor:pointer;line-height:1;display:grid;place-items:center}'
    + '.acmt-x:hover{background:rgba(255,255,255,.3)}'
    + '.acmt-bar{display:flex;align-items:center;gap:8px;padding:11px 14px;background:#fff;border-bottom:1px solid ' + BD + ';flex:0 0 auto}'
    + '.acmt-new{display:inline-flex;align-items:center;gap:7px;border:0;background:' + GRAD + ';'
    +   'color:#fff;border-radius:8px;padding:8px 15px;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer;'
    +   'box-shadow:0 4px 12px rgba(30,63,133,.22);transition:transform .15s,box-shadow .15s}'
    + '.acmt-new:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(30,63,133,.3)}'
    + '.acmt-new svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
    + '.acmt-nav{margin-left:auto;display:flex;gap:5px}'
    + '.acmt-nav button{width:30px;height:30px;border:1px solid ' + BD + ';border-radius:8px;background:#fff;color:' + TX2 + ';cursor:pointer;display:grid;place-items:center;transition:border-color .12s,color .12s}'
    + '.acmt-nav button:hover{border-color:' + NAVY + ';color:' + NAVY + '}'
    + '.acmt-nav svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
    + '.acmt-list{flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:11px;'
    +   'box-shadow:inset 0 7px 7px -7px rgba(15,35,75,.16);-webkit-overflow-scrolling:touch}'
    + '.acmt-empty{margin:52px 22px;color:' + TX3 + ';font-size:13px;line-height:1.6;text-align:center}'
    + '.acmt-empty svg{width:34px;height:34px;stroke:#c2ccdb;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;margin-bottom:10px}'
    + '.acmt-empty b{color:' + NAVY + '}'
    + '.acmt-item{background:#fff;border:1px solid ' + BD + ';border-radius:12px;padding:12px 14px;box-shadow:0 3px 12px rgba(40,79,158,.06)}'
    + '.acmt-item.sel{border-color:' + NAVY + ';box-shadow:0 0 0 3px rgba(40,79,158,.14)}'
    + '.acmt-row{display:flex;align-items:flex-start;gap:10px}'
    + '.acmt-tri{border:0;background:transparent;color:' + TX3 + ';cursor:pointer;padding:2px 0 0;font-size:10px;line-height:1;width:12px;flex:0 0 auto}'
    + '.acmt-av{flex:0 0 auto;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:11.5px;font-weight:800}'
    + '.acmt-av.sm{width:26px;height:26px;font-size:10px}'
    + '.acmt-body{min-width:0;flex:1}'
    + '.acmt-name{font-size:13px;font-weight:800;color:' + TX + '}'
    + '.acmt-where{font-size:12px;font-weight:700;color:' + TX + ';opacity:.3;margin-left:6px}'
    + '.acmt-time{font-size:11.5px;color:' + TX3 + ';margin-left:6px;font-weight:500}'
    + '.acmt-text{margin:4px 0 0;font-size:13px;line-height:1.55;color:#33373d;white-space:pre-wrap;word-wrap:break-word}'
    + '.acmt-actions{margin-top:8px;display:flex;gap:14px}'
    + '.acmt-link{border:0;background:transparent;color:' + TX2 + ';font:inherit;font-size:12px;font-weight:700;cursor:pointer;padding:0}'
    + '.acmt-link:hover{color:' + NAVY + '}'
    + '.acmt-link.del:hover{color:#c0392b}'
    + '.acmt-replies{margin:11px 0 0 20px;padding-left:12px;border-left:2px solid ' + WASH + ';display:flex;flex-direction:column;gap:12px}'
    + '.acmt-reply{display:flex;align-items:flex-start;gap:9px}'
    + '.acmt-edit{margin-top:8px}'
    + '.acmt-ta{width:100%;box-sizing:border-box;min-height:58px;resize:vertical;border:1px solid ' + NAVY + ';'
    +   'border-radius:8px;padding:9px 11px;font:inherit;font-size:13px;color:' + TX + ';outline:0;box-shadow:0 0 0 3px rgba(40,79,158,.16)}'
    + '.acmt-editbtns{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}'
    + '.acmt-post{border:0;border-radius:8px;background:' + GRAD + ';color:#fff;font:inherit;font-size:12.5px;font-weight:800;padding:8px 16px;cursor:pointer;box-shadow:0 4px 12px rgba(30,63,133,.2)}'
    + '.acmt-post:hover{filter:brightness(1.06)}'
    + '.acmt-post:disabled{background:#b7c2da;box-shadow:none;filter:none;cursor:default}'
    + '.acmt-cancel{border:1.5px solid #e0e0ea;border-radius:8px;background:#fff;color:#6b7280;font:inherit;font-size:12.5px;font-weight:700;padding:8px 14px;cursor:pointer}'
    + '.acmt-cancel:hover{background:' + WASH + '}'
    + '@media (prefers-reduced-motion:reduce){.acmt-panel{transition:none}}';

  var els = {};
  var selIndex = -1;

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
    return '<div class="acmt-reply">' + avatarHTML(r.author, true)
      + '<div class="acmt-body">'
      +   '<div><span class="acmt-name">' + esc(r.author) + '</span>' + whereHTML(r.where) + '<span class="acmt-time">' + esc(ago(r.ts)) + '</span></div>'
      +   '<p class="acmt-text">' + esc(r.text) + '</p>'
      + '</div></div>';
  }

  function itemHTML(c, idx) {
    var replies = c.replies || [];
    var html = '<div class="acmt-item' + (idx === selIndex ? ' sel' : '') + '" data-id="' + esc(c.id) + '">'
      + '<div class="acmt-row">'
      +   '<button class="acmt-tri" data-act="toggle" aria-label="Collapse">' + (c.collapsed ? '▶' : '▼') + '</button>'
      +   avatarHTML(c.author, false)
      +   '<div class="acmt-body">'
      +     '<div><span class="acmt-name">' + esc(c.author) + '</span>' + whereHTML(c.where) + '<span class="acmt-time">' + esc(ago(c.ts)) + '</span></div>'
      +     '<p class="acmt-text">' + esc(c.text) + '</p>';
    if (!c.collapsed) {
      html += '<div class="acmt-actions">'
        +   '<button class="acmt-link" data-act="reply">Reply</button>'
        +   '<button class="acmt-link del" data-act="delete">Delete</button>'
        + '</div>';
      if (replies.length) html += '<div class="acmt-replies">' + replies.map(replyHTML).join('') + '</div>';
      if (replyingId === c.id) html += editorHTML('Reply…', 'Reply');
    }
    html += '</div></div></div>';
    return html;
  }

  var EMPTY = '<div class="acmt-empty">'
    + '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    + '<div>No comments yet.<br>Press <b>New</b> to leave the first one.</div></div>';

  function render() {
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
    html += comments.length ? comments.map(itemHTML).join('') : (drafting ? '' : EMPTY);
    els.list.innerHTML = html;
    wireList();
    focusOpenEditor();
    renderBadge();
  }

  function renderBadge() {
    var n = comments.length;
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
      comments.unshift({ id: uid(), author: me.name, where: pageLabel(), ts: Date.now(), text: text, collapsed: false, replies: [] });
      drafting = false; save(); render();
    });

    els.list.querySelectorAll('.acmt-item[data-id]').forEach(function (item) {
      var id = item.getAttribute('data-id');
      item.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () { onAct(btn.getAttribute('data-act'), id); });
      });
      if (replyingId === id) {
        wireEditor(item, function (text) {
          var c = byId(id);
          if (c) { (c.replies = c.replies || []).push({ id: uid(), author: me.name, where: pageLabel(), ts: Date.now(), text: text }); }
          replyingId = null; save(); render();
        });
      }
    });
  }

  function byId(id) { for (var i = 0; i < comments.length; i++) if (comments[i].id === id) return comments[i]; return null; }

  function onAct(act, id) {
    var c = byId(id);
    if (act === 'toggle') { if (c) c.collapsed = !c.collapsed; save(); render(); }
    else if (act === 'reply') { replyingId = replyingId === id ? null : id; drafting = false; render(); }
    else if (act === 'delete') {
      comments = comments.filter(function (x) { return x.id !== id; });
      save(); render();
    }
  }

  function openPanel() { els.panel.classList.add('open'); els.tab.classList.add('hidden'); render(); }
  function closePanel() { els.panel.classList.remove('open'); els.tab.classList.remove('hidden'); drafting = false; replyingId = null; }

  function startNew() { drafting = true; replyingId = null; render(); }

  function navComment(dir) {
    if (!comments.length) return;
    selIndex = Math.max(0, Math.min(comments.length - 1, (selIndex < 0 ? (dir > 0 ? -1 : comments.length) : selIndex) + dir));
    render();
    var el = els.list.querySelectorAll('.acmt-item[data-id]')[selIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function collapseAll() {
    var anyOpen = comments.some(function (c) { return !c.collapsed; });
    comments.forEach(function (c) { c.collapsed = anyOpen; });
    save(); render();
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
    panel.className = 'acmt-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'Comments');
    panel.innerHTML =
      '<div class="acmt-head">'
      +   '<h2>Comments</h2>'
      +   '<button class="acmt-chev" type="button" aria-label="Collapse all">▾</button>'
      +   '<button class="acmt-x" type="button" aria-label="Close">✕</button>'
      + '</div>'
      + '<div class="acmt-bar">'
      +   '<button class="acmt-new" type="button">'
      +     '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 8v6M9 11h6"/></svg>'
      +     'New</button>'
      +   '<div class="acmt-nav">'
      +     '<button data-nav="-1" type="button" aria-label="Previous comment"><svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg></button>'
      +     '<button data-nav="1" type="button" aria-label="Next comment"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>'
      +   '</div>'
      + '</div>'
      + '<div class="acmt-list"></div>';

    document.body.appendChild(tab);
    document.body.appendChild(panel);

    els = { tab: tab, panel: panel, list: panel.querySelector('.acmt-list'), badge: tab.querySelector('.acmt-tab-badge') };

    panel.querySelector('.acmt-x').addEventListener('click', closePanel);
    panel.querySelector('.acmt-chev').addEventListener('click', collapseAll);
    panel.querySelector('.acmt-new').addEventListener('click', startNew);
    panel.querySelectorAll('.acmt-nav button').forEach(function (b) {
      b.addEventListener('click', function () { navComment(parseInt(b.getAttribute('data-nav'), 10)); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('open') && !drafting && replyingId === null) closePanel();
    });

    renderBadge();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
