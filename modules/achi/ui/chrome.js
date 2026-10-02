/* ARARA app chrome — the sidebar every ARARA page wears.
 *
 * The ERP underneath has no screens of its own any more (achi-nav.js sends
 * anyone signed in straight here), so this sidebar is the whole app menu: every
 * ARARA page, plus Sign out. Pages hidden per user on the Users page are taken
 * out of it further down this file.
 *
 * Only renders when the page is NOT inside a frame. Links are ordinary full
 * page loads. It is hand-maintained — add a page to LINKS when adding a page.
 */
(function () {
  'use strict';

  // Browser tab icon: the ARARA mark, not the ERP logo (the same one
  // deploy/overrides/achi-nav.js sets on the sign-in screens).
  (function () {
    var l = document.createElement('link');
    l.rel = 'icon';
    l.type = 'image/svg+xml';
    l.href = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
      + '<rect width="64" height="64" rx="14" fill="#284F9E"/>'
      + '<path fill="#fff" fill-rule="evenodd" d="M32 11 50.5 53h-8.2l-3.6-8.4H25.3L21.7 53h-8.2zm0 17.2-4.3 10h8.6z"/>'
      + '</svg>');
    document.head.appendChild(l);
  })();

  // Installable app: ARARA's manifest and home-screen icon, not upstream's
  // "OpenConstructionERP" (modules/achi/router.py serves both).
  (function () {
    var tags = [
      ['link', 'manifest', '/api/v1/achi/ui/manifest.webmanifest'],
      ['link', 'apple-touch-icon', '/api/v1/achi/ui/apple-touch-icon.png'],
      ['meta', 'theme-color', '#284F9E'],
      ['meta', 'apple-mobile-web-app-title', 'ARARA'],
      ['meta', 'application-name', 'ARARA'],
      ['meta', 'apple-mobile-web-app-capable', 'yes'],
      ['meta', 'mobile-web-app-capable', 'yes']
    ];
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i], sel = t[0] === 'link' ? 'link[rel="' + t[1] + '"]' : 'meta[name="' + t[1] + '"]';
      var el = document.head.querySelector(sel);
      if (!el) {
        el = document.createElement(t[0]);
        if (t[0] === 'link') el.rel = t[1]; else el.name = t[1];
        document.head.appendChild(el);
      }
      el.setAttribute(t[0] === 'link' ? 'href' : 'content', t[2]);
    }
  })();

  // Company: Achi Scaffolding or ARARA, picked in the sidebar and remembered
  // per browser. It decides which modules the menu shows, and the HR and
  // Projects pages read it (window.araraCompany) to load that company's data.
  var COMPANIES = [['achi', 'Achi Scaffolding', 'AC'], ['arara', 'ARARA', 'AR']];
  var COMPANY_KEY = 'arara_company';
  function currentCompany() {
    // A page that belongs to one company (opened from a bookmark or a shared
    // link) switches to that company, so the menu and the page's data agree.
    var owner = pageOwner();
    if (owner) { storeCompany(owner); return owner; }
    try { var c = localStorage.getItem(COMPANY_KEY); if (c === 'achi' || c === 'arara') return c; } catch (e) {}
    return 'achi';
  }
  function samePage(href) { return href.split('?')[0].replace(/\/+$/, '') === location.pathname.replace(/\/+$/, ''); }
  function pageOwner() {
    // LINKS is assigned further down; it stays undefined in a docked frame.
    if (!LINKS) return null;
    for (var i = 0; i < LINKS.length; i++) {
      if (LINKS[i].co !== 'both' && samePage(LINKS[i].href)) return LINKS[i].co;
    }
    return null;
  }
  function storeCompany(c) { try { localStorage.setItem(COMPANY_KEY, c); } catch (e) {} }
  window.araraCompany = currentCompany;

  // Docked in the SPA? Upstream's sidebar is already there — stand down.
  if (window.top !== window.self) return;

  // The whole ARARA menu, in order. The ERP underneath has no screens of its
  // own any more (deploy/overrides/achi-nav.js).
var LINKS = [
  { label: 'Log', co: 'achi', href: '/api/v1/achi/ui', icon: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>' },
  { label: 'Contacts', co: 'achi', href: '/api/v1/achi/contact-info/ui', icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' },
  { label: 'CRM', co: 'achi', href: '/api/v1/achi/crm/ui', icon: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>' },
  { label: 'Planner', co: 'both', href: '/api/v1/achi/planner/ui', icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>' },
  { label: 'Site Visit', co: 'achi', href: '/api/v1/achi/survey/ui', icon: '<path d="M9 2 3 5v17l6-3 6 3 6-3V2l-6 3-6-3z"/><path d="M9 2v17"/><path d="M15 5v17"/>' },
  { label: 'DRAW', co: 'achi', href: '/api/v1/achi/draw/ui', icon: '<path d="M4 20h16"/><path d="m14 4 6 6-10 10H4v-6z"/><path d="m13 5 6 6"/>' },
  { label: 'M/T', co: 'achi', href: '/api/v1/achi/mt/ui', icon: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h3M13 12h3M8 16h8"/>' },
  { label: 'BOQ', co: 'achi', href: '/api/v1/achi/boq/ui', icon: '<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/>' },
  { label: 'Quotation', co: 'achi', href: '/api/v1/achi/quotation/ui', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>' },
  { label: 'Files', co: 'achi', href: '/api/v1/achi/files/ui', icon: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>' },
  { label: 'Projects', co: 'arara', href: '/api/v1/achi/projects/ui', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16"/><path d="M13 8h4M13 12h4M13 16h2"/>' },
  { label: 'HR', co: 'both', href: '/api/v1/achi/hr/ui', icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M16 11h6"/><rect x="15" y="15" width="7" height="6" rx="1"/>' },
  { label: 'Users', co: 'both', href: '/api/v1/achi/users/ui', icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' }
  ];

  /* The admin cluster upstream pins at the bottom of its sidebar — a literal
   * clone, not an approximation: upstream's own Lucide paths, its 14px icons at
   * stroke-width 1.75, its 32px (h-8) rows, its 11px/500 labels, and its
   * two-column grid. Copied from the rendered markup rather than redrawn, so
   * "same icon" means the same path data, not a lookalike.
   *
   * Routes verified against the compiled bundle. Audit is /audits, plural — the
   * singular looks right and 404s.
   */
  var TOOLS = [
    { label: 'Sign out', href: '/login', signout: true, icon: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>' }
  ];

  // #284F9E is the same navy achi-theme.css paints upstream's sidebar with —
  // sampled from the logo so the mark's square background dissolves into it.
  /* Type scale is upstream's, read out of the compiled stylesheet rather than
   * eyeballed: .text-sm = 13px/1.46, .text-xs = 11px/1.36, .font-medium = 500,
   * .font-semibold = 600, and --oe-font-sans is the stack below. Matching the
   * SIZE alone still read as heavier than the real sidebar, because these rows
   * were 600-weight against upstream's 500. Weight is doing as much work as size
   * here — change both together or it drifts visibly again.
   */
  var FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif';
  var CSS = ''
    /* Hover-expand, mirroring the last good app sidebar: start collapsed,
     * expand on mouseenter, and settle back 120 ms after mouseleave. Widths are
     * upstream's exact 64/248 rather than our old 216 — when the two sidebars
     * are different widths, every crossing between an app page and one of ours
     * shifts the whole layout, which is the flash. Same width, no jump.
     * The class is driven below so the close delay is deterministic. */
    /* The expanded sidebar OVERLAYS the page; it never widens the content gutter.
     * Driving body's padding from hover reflowed the whole page on every expand
     * — on a wide grid that reads as fields jumping and getting cropped. The
     * gutter is therefore pinned to the collapsed width and never animates. */
    + ':root{--achi-sb:64px}'
    + '.achi-chrome{position:fixed;left:0;top:0;bottom:0;width:var(--achi-sb);background:#284F9E;color:#fff;display:flex;flex-direction:column;z-index:40;font-family:' + FONT + ';overflow:hidden;transition:width .2s ease}'
    + '.achi-chrome.achi-expanded{width:248px;box-shadow:6px 0 24px rgba(0,0,0,.18)}'
    /* Collapsed: icons only. Labels stay in the DOM for screen readers and fade
     * back in on expand — display:none would make them unreadable to AT too. */
    + '.achi-chrome:not(.achi-expanded) .achi-link span,.achi-chrome:not(.achi-expanded) .achi-back span,'
    +   '.achi-chrome:not(.achi-expanded) .achi-tool span,.achi-chrome:not(.achi-expanded) .achi-brand div,'
    +   '.achi-chrome:not(.achi-expanded) .achi-foot{opacity:0;pointer-events:none}'
    + '.achi-chrome:not(.achi-expanded) .achi-tools{grid-template-columns:1fr}'
    + '.achi-link span,.achi-back span,.achi-tool span,.achi-brand div,.achi-foot{transition:opacity .15s ease}'
    + '.achi-brand{display:flex;align-items:center;gap:10px;padding:16px 16px 14px}'
    + '.achi-brand{min-height:28px}'
    + '.achi-mark{display:block;flex:none;width:32px;height:32px}'
    + '.achi-mark svg{display:block;width:32px;height:32px;border-radius:9px;box-shadow:0 0 0 1px rgba(255,255,255,.22)}'
    + '.achi-chrome:not(.achi-expanded) .achi-brand div{position:absolute}'
    + '.achi-back{display:flex;align-items:center;gap:9px;margin:0 8px 6px;padding:7px 11px;border-radius:8px;color:rgba(255,255,255,.7);text-decoration:none;font-size:11px;line-height:1.36;font-weight:500}'
    + '.achi-back:hover{background:rgba(255,255,255,.12);color:#fff}'
    + '.achi-back svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
    + '.achi-sep{height:1px;background:rgba(255,255,255,.14);margin:2px 16px 8px}'
    + '.achi-company{margin:0 12px 10px}'
    + '.achi-co-label{display:block;margin:0 0 4px 2px;color:rgba(255,255,255,.62);font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}'
    + '.achi-company select{width:100%;height:32px;padding:0 26px 0 10px;border:1px solid rgba(255,255,255,.28);border-radius:8px;background:rgba(255,255,255,.1) url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 12 12%27%3E%3Cpath d=%27M3 4.5 6 7.5 9 4.5%27 fill=%27none%27 stroke=%27white%27 stroke-width=%271.6%27/%3E%3C/svg%3E") no-repeat right 9px center/12px;color:#fff;font:600 12.5px/1 ' + FONT + ';-webkit-appearance:none;appearance:none;cursor:pointer}'
    + '.achi-company select:focus-visible{outline:2px solid #fff;outline-offset:1px}'
    + '.achi-company option{color:#17223b;background:#fff}'
    + '.achi-co-short{display:none}'
    + '.achi-chrome:not(.achi-expanded) .achi-company{margin:0 16px 10px}'
    + '.achi-chrome:not(.achi-expanded) .achi-co-label,.achi-chrome:not(.achi-expanded) .achi-company select{display:none}'
    + '.achi-chrome:not(.achi-expanded) .achi-co-short{display:grid;place-items:center;width:32px;height:24px;border-radius:6px;background:rgba(255,255,255,.16);font-size:10px;font-weight:800;letter-spacing:.05em}'
    + '.achi-brand b{font-size:18px;line-height:28px;font-weight:800;letter-spacing:.08em;display:block}'
    + '.achi-nav{padding:6px 8px;overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}'
    + '.achi-link{display:flex;align-items:center;gap:10px;padding:7px 11px;border-radius:8px;color:rgba(255,255,255,.86);text-decoration:none;font-size:13px;line-height:1.46;font-weight:500;margin-bottom:2px}'
    + '.achi-link:hover{background:rgba(255,255,255,.12);color:#fff}'
    + '.achi-link svg{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
    /* Cluster metrics are upstream's, translated from its Tailwind classes:
     * py-2 px-2 container over a bg-black/[0.02] wash, grid-cols-2 gap-1,
     * h-8 rows, rounded-md, px-2, gap-1.5, text-[11px] font-medium leading-none.
     * Surface: upstream's class is bg-surface-primary, which is NOT white here.
     * achi-theme.css rescopes --oe-bg-ch to the brand navy on the sidebar
     * subtree, and custom properties inherit, so those buttons resolve to navy
     * and read as translucent chips with light text. Hardcoding white was wrong
     * for exactly that reason — it ignored the rescope and stood out. */
    + '.achi-cluster{position:relative;padding:8px;background:rgba(0,0,0,.02)}'
    + '.achi-cluster::before{content:"";position:absolute;top:0;left:12px;right:12px;height:1px;background:linear-gradient(to right,transparent,rgba(255,255,255,.22),transparent)}'
    + '.achi-tools{display:grid;grid-template-columns:1fr;gap:4px;list-style:none;margin:0;padding:0}'
    + '.achi-tool{display:flex;align-items:center;justify-content:flex-start;gap:6px;height:32px;padding:0 8px;border-radius:6px;border:0;background:transparent;color:rgba(255,255,255,.82);text-decoration:none;font-size:11px;line-height:1;font-weight:500;min-width:0;transition:background .12s,color .12s}'
    + '.achi-tool:hover{background:rgba(255,255,255,.12);color:#fff}'
    + '.achi-tool span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.achi-tool svg{width:14px;height:14px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}'
    + '.achi-foot{display:flex;align-items:center;justify-content:center;gap:6px;padding:9px 16px 12px;font-size:10px;line-height:1.36;color:rgba(255,255,255,.5)}'
    + '.achi-foot a{color:inherit;text-decoration:none}'
    + '.achi-foot a:hover{color:rgba(255,255,255,.78)}'
    + '.achi-top{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:10px;background:#fff;border-bottom:1px solid #dfe4ec;padding:11px 18px;font-family:' + FONT + '}'
    + '.achi-top h1{font-size:13px;line-height:1.46;font-weight:600;color:#1d1d1f}'
    + '.achi-burger{display:none;border:0;background:#eef2fb;color:#284F9E;border-radius:8px;padding:7px 9px;cursor:pointer;font-size:15px;line-height:1}'
    /* Page background cloned from upstream's "dots" shell style, values lifted
     * from the bundle: --oe-bg-secondary under a 0.9px 16%-alpha dot every 24px.
     * Ours had a flat grey, which is why these pages read as a different surface
     * from the rest of the app. */
    + 'body{padding-left:var(--achi-sb);background-color:#f5f5f7;'
    +   'background-image:radial-gradient(circle,rgba(60,60,67,.16) .9px,transparent .9px);'
    +   'background-size:24px 24px}'
    + '@media (prefers-color-scheme:dark){body{background-color:#161822}}'
    + '@media (max-width:900px){'
    + ' body{padding-left:0}'
    + ' .achi-chrome{transform:translateX(-100%);transition:transform .18s ease;box-shadow:0 0 40px rgba(0,0,0,.3)}'
    + ' .achi-chrome.open{transform:none;width:248px}'
    + ' .achi-burger{display:inline-flex}'
    + '}';

  // The ARARA logo: a blue rounded square holding a white rounded bar.
  var LOGO = '<svg viewBox="0 0 64 64" width="32" height="32" focusable="false">'
    + '<defs><linearGradient id="achi-logo-fill" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#2E5EBC"/><stop offset="1" stop-color="#203F8D"/></linearGradient></defs>'
    + '<rect width="64" height="64" rx="18" fill="url(#achi-logo-fill)"/>'
    + '<rect x="16.9" y="26" width="30.2" height="12" rx="6" fill="none" stroke="#fff" stroke-width="3.9"/>'
    + '</svg>';

  function build(title) {
    var side = document.createElement('nav');
    side.className = 'achi-chrome';
    var company = currentCompany();
    var shown = LINKS.filter(function (l) { return l.co === 'both' || l.co === company; });
    var short = COMPANIES.filter(function (c) { return c[0] === company; })[0][2];
    // The ARARA logo, then the product name (hidden while collapsed).
    side.innerHTML =
      '<div class="achi-brand">'
      + '<span class="achi-mark" aria-hidden="true">' + LOGO + '</span>'
      + '<div><b>ARARA</b></div></div>'
      + '<div class="achi-company"><label class="achi-co-label" for="achi-company">Company</label>'
      + '<select id="achi-company">' + COMPANIES.map(function (c) {
          return '<option value="' + c[0] + '"' + (c[0] === company ? ' selected' : '') + '>' + c[1] + '</option>';
        }).join('') + '</select>'
      + '<span class="achi-co-short" title="Company">' + short + '</span></div>'
      + '<div class="achi-sep"></div>'
      + '<div class="achi-nav">'
      + shown.map(function (l) {
          return '<a class="achi-link" href="' + l.href + '">'
            + '<svg viewBox="0 0 24 24">' + l.icon + '</svg><span>' + l.label + '</span></a>';
        }).join('')
      + '</div>'
      // The cluster is pinned below the scrolling nav the way upstream pins it —
      // .achi-nav takes flex:1, so this always sits at the bottom. Its own
      // gradient hairline is the separator, so no .achi-sep here.
      + '<div class="achi-cluster">'
      + '<ul class="achi-tools">'
      + TOOLS.map(function (t) {
          return '<li><a class="achi-tool" href="' + t.href + '"' + (t.signout ? ' data-achi-signout' : '') + ' title="' + t.label + '" aria-label="' + t.label + '">'
            + '<svg viewBox="0 0 24 24" aria-hidden="true">' + t.icon + '</svg>'
            + '<span>' + t.label + '</span></a></li>';
        }).join('')
      + '</ul>'
      + '</div>'
      // Licence, from upstream's own footer. /api/source is the AGPL source
      // offer — it is a licence notice, so it is reproduced, not restyled away.
      + '<div class="achi-foot">'
      + '<a href="/api/source" target="_blank" rel="noopener noreferrer">AGPL-3.0</a></div>';

    // Switching company: stay on this page when the other company has it too
    // (Planner, HR, Users), otherwise open that company's first module.
    side.querySelector('#achi-company').addEventListener('change', function (event) {
      var next = event.target.value;
      storeCompany(next);
      var keep = LINKS.some(function (l) { return (l.co === 'both' || l.co === next) && samePage(l.href); });
      if (keep) { location.reload(); return; }
      var first = LINKS.filter(function (l) { return l.co === next; })[0];
      location.assign(first ? first.href : location.href);
    });

    var top = document.createElement('div');
    top.className = 'achi-top';
    top.innerHTML = '<button class="achi-burger" type="button" aria-label="Menu">&#9776;</button><h1>' + title + '</h1>';
    top.querySelector('.achi-burger').addEventListener('click', function () { side.classList.toggle('open'); });

    var collapseTimer = null;
    side.addEventListener('mouseenter', function () {
      if (collapseTimer !== null) {
        window.clearTimeout(collapseTimer);
        collapseTimer = null;
      }
      side.classList.add('achi-expanded');
    });
    side.addEventListener('mouseleave', function () {
      if (collapseTimer !== null) window.clearTimeout(collapseTimer);
      collapseTimer = window.setTimeout(function () {
        collapseTimer = null;
        side.classList.remove('achi-expanded');
      }, 120);
    });

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    document.body.insertBefore(side, document.body.firstChild);
    if (!document.body.classList.contains('log-page')) {
      document.body.insertBefore(top, side.nextSibling);
}
  }

  /* Admins keep the full mirror sidebar; everyone else gets exactly three
   * primary destinations (Log, Contacts, CRM). The verdict is the JWT's role claim
   * from the same storage the SPA uses — synchronous, so the sidebar never
   * flashes the wrong shape. UI-only: the API enforces real permissions. */
  function isAdminUser() {
    var tok;
    try { tok = localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token') || ''; }
    catch (e) { tok = ''; }
    if (!tok) return false;
    try {
      var part = (tok.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      return JSON.parse(atob(part)).role === 'admin';
    } catch (e) { return false; }
  }

  /* Standalone ACHI pages use one operational navigation list for every user. */
  /* Team Tasks is revealed separately for admins and supervisors. */

  function showPrimaryLinksOnly() {
    var links = document.querySelectorAll('.achi-chrome .achi-link');
    for (var i = 0; i < links.length; i++) {
      var href = (links[i].getAttribute('href') || '').split('?')[0];
      // Users is admin-only (the page's data is admin-only too).
      links[i].style.display = href === '/api/v1/achi/users/ui' && !isAdminUser() ? 'none' : '';
    }
  }

  function showTeamTasksLink() {
    var link = document.querySelector(
      '.achi-chrome .achi-link[href="/api/v1/achi/tasks/ui"]'
    );
    if (link) link.style.display = '';
  }

  function showTeamTasksForSupervisors() {
    var tok;
    try {
      tok = localStorage.getItem('oe_access_token')
        || sessionStorage.getItem('oe_access_token')
        || '';
    } catch (e) {
      tok = '';
    }

    if (!tok || isAdminUser()) return;

    fetch('/api/v1/achi/tasks/access/me', {
      headers: { Authorization: 'Bearer ' + tok }
    })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (access) {
        if (!access || !access.can_manage_team) return;
        showTeamTasksLink();
      })
      .catch(function () {});
  }
  /* Sign-in lives on the ERP's /login screen (the only ERP screen still used),
   * so signing out clears exactly what its own logout clears, then goes there. */
  var AUTH_KEYS = ['oe_access_token', 'oe_refresh_token', 'oe_remember', 'oe_user_email', 'oe_user_full_name'];
  function signOut() {
    try {
      AUTH_KEYS.forEach(function (k) { localStorage.removeItem(k); sessionStorage.removeItem(k); });
      localStorage.removeItem('achi_access_verdict');
      sessionStorage.setItem('oe_manual_login', '1');
    } catch (e) { /* storage blocked: /login still works */ }
    location.replace('/login');
  }
  // No session at all (never signed in, or the refresh token is gone and the
  // access token has expired): straight to sign-in instead of a page of errors.
  function hasSession() {
    var access, refresh;
    try {
      access = localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token') || '';
      refresh = localStorage.getItem('oe_refresh_token') || sessionStorage.getItem('oe_refresh_token') || '';
    } catch (e) { return true; }
    if (refresh) return true;
    if (!access) return false;
    try {
      var part = (access.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      var exp = JSON.parse(atob(part)).exp;
      return !exp || exp * 1000 > Date.now();
    } catch (e) { return true; }
  }

  function boot() {
    if (!hasSession()) { location.replace('/login'); return; }
    // Each page names itself; fall back to the document title.
    var t = document.body.getAttribute('data-achi-title') || document.title.split('·')[0].trim();
    build(t);
    showPrimaryLinksOnly();
    var out = document.querySelector('.achi-chrome [data-achi-signout]');
    if (out) out.addEventListener('click', function (e) { e.preventDefault(); signOut(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

/* ── Site Visit for an enquiry ────────────────────────────────────────────
 * window.achiEnsureSiteVisit(info, io) — called by the Log and CRM right after
 * they move an enquiry to the "Site visit" stage. Opens its SV-NNNNN visit in
 * the Site Visit module unless one already exists for that enquiry.
 *   info: { fileId, fileNumber, customer, contact, site, maps, subject }
 *   io:   { get(path) → JSON, post(path, body) → JSON }   (page's own auth)
 * The visit carries the ENQ code in its "lead" field; the server treats a visit
 * with that code as the enquiry's own (ContactFileService._ensure_site_visit),
 * so the server-side rule never opens a second one.
 */
(function () {
  'use strict';
  var pending = {};
  var enqCode = function (fileNumber) {
    var m = String(fileNumber || '').trim().match(/-(\d+)$/);
    return m ? 'ENQ-' + ('00000' + m[1]).slice(-Math.max(5, m[1].length)) : '';
  };
  window.achiEnsureSiteVisit = function (info, io) {
    if (!info || !info.fileId || pending[info.fileId]) return Promise.resolve(null);
    var code = enqCode(info.fileNumber);
    pending[info.fileId] = true;
    return Promise.resolve(io.get('/api/v1/achi/surveys/?limit=1000'))
      .then(function (rows) {
        var list = Array.isArray(rows) ? rows : [];
        var exists = list.some(function (s) {
          return s.file_id === info.fileId || (code && String(s.lead || '') === code);
        });
        if (exists) return null;
        return io.post('/api/v1/achi/surveys/', {
          status: 'Scheduled',
          lead: code || null,
          customer: info.customer || null,
          contact: info.contact || null,
          site_location: info.site || null,
          google_maps_url: info.maps || null,
          notes: info.subject || null,
        });
      })
      .catch(function () { return null; })
      .then(function (created) { delete pending[info.fileId]; return created; });
  };
})();

/* ── Page access (set per user on the Users page) ────────────────────────────
 * Asks /users/me/pages which ACHI pages this user may open, hides the menu
 * links to the others, and covers a blocked page with a "no access" notice when
 * it is opened directly (bookmark, shared link). Runs docked or standalone.
 * Fails open: if the check can't be made, nothing is hidden.
 */
(function () {
  'use strict';
  var tok;
  try { tok = localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token') || ''; }
  catch (e) { tok = ''; }
  if (!tok) return;

  function norm(path) { return String(path || '').split('?')[0].replace(/\/+$/, '') || '/'; }

  function apply(access) {
    if (!access || access.all || !access.blocked_paths) return;
    var blocked = {};
    access.blocked_paths.forEach(function (p) { blocked[norm(p)] = true; });
    var links = document.querySelectorAll('.achi-chrome .achi-link');
    for (var i = 0; i < links.length; i++) {
      if (blocked[norm(links[i].getAttribute('href'))]) links[i].style.display = 'none';
    }
    if (!blocked[norm(location.pathname)]) return;
    var box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;padding:20px;'
      + 'background:#f4f6f9;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#44546e';
    box.innerHTML = '<div style="max-width:420px;padding:20px 22px;border:1px solid #b9c5d8;border-radius:6px;background:#fff;text-align:center">'
      + '<div style="margin-bottom:6px;color:#1f3f80;font-size:15px;font-weight:800">No access to this page</div>'
      + 'Your account can’t open this page. Ask an admin to add it on the Users page.'
      + '<div style="margin-top:12px"><a href="javascript:history.back()" style="color:#284f9e;font-weight:700">← Go back</a></div></div>';
    document.body.appendChild(box);
  }

  function run() {
    fetch('/api/v1/achi/users/me/pages', { headers: { Authorization: 'Bearer ' + tok } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(apply)
      .catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
