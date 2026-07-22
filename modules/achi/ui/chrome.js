/* ACHI app chrome — the sidebar our own pages wear when opened directly.
 *
 * WHY THIS EXISTS
 * Our pages are served by our router, not by OCE's SPA, so on their own they
 * arrive with no app furniture around them. Opened straight from a URL — a phone
 * on site, a bookmark, a link in a message — that looks like a different product.
 *
 * WHEN IT RENDERS
 * Only when the page is NOT inside a frame. achi-nav.js docks these same pages
 * into the SPA's content area, where the real sidebar is already on screen; a
 * second one there is the duplicate you get in a docked screenshot. So the frame
 * case is upstream's chrome, and the standalone case is this. One file covers
 * both because the check is one line, not because the two are the same thing.
 *
 * FIDELITY
 * Deliberately mirrors upstream's sidebar — same logo (/logo.svg, served by the
 * app itself so it can never drift), same "by ACHI Scaffolding" credit, same
 * navy, same version/licence footer. It lists only OUR pages plus the handful of
 * upstream destinations worth reaching from here, because this is a way back into
 * the app, not a replacement for its menu.
 *
 * The cost of the mirror is that it is hand-maintained: it does not read
 * upstream's nav, so restyling there will not reach here. Kept small on purpose
 * to keep that cost small. Links out are ordinary full page loads.
 */
(function () {
  'use strict';

  // Docked in the SPA? Upstream's sidebar is already there — stand down.
  if (window.top !== window.self) return;

  var VERSION = 'v11.9.0 · AGPL-3.0';

  // Our pages first, then the upstream destinations worth a jump from here.
  var LINKS = [
    { k: 'calllog',  label: 'Call Log',      href: '/api/v1/achi/ui',        icon: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>' },
    { k: 'survey',   label: 'Site Survey',   href: '/api/v1/achi/survey/ui', icon: '<path d="M9 2 3 5v17l6-3 6 3 6-3V2l-6 3-6-3z"/><path d="M9 2v17"/><path d="M15 5v17"/>' },
    { k: 'contacts', label: 'Contacts',      href: '/contacts',              icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' },
    { k: 'crm',      label: 'CRM',           href: '/crm',                   icon: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>' },
    { k: 'projects', label: 'Projects',      href: '/projects',              icon: '<path d="M3 7h6l2 2h10v10H3z"/>' },
    { k: 'files',    label: 'Project Files', href: '/files',                 icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>' }
  ];

  /* The admin cluster upstream pins at the bottom of its sidebar, in the same
   * two-column grid and the same order. Routes verified against the compiled
   * bundle — note Audit is /audits (plural), which is easy to get wrong.
   * Reachable from our pages so an admin does not have to go back to the app
   * first just to open Settings.
   */
  var TOOLS = [
    { label: 'Settings',   href: '/settings',   icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9z"/>' },
    { label: 'Users',      href: '/users',      icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' },
    { label: 'Modules',    href: '/modules',    icon: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>' },
    { label: 'Governance', href: '/governance', icon: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="m5 7-3 7h6z"/><path d="m19 7-3 7h6z"/>' },
    { label: 'Audit',      href: '/audits',     icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/>' },
    { label: 'About',      href: '/about',      icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>' }
  ];

  function activeKey() {
    var p = location.pathname;
    if (p.indexOf('/achi/survey/ui') !== -1) return 'survey';
    if (p.indexOf('/achi/ui') !== -1) return 'calllog';
    return '';
  }

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
    + '.achi-chrome{position:fixed;left:0;top:0;bottom:0;width:216px;background:#284F9E;color:#fff;display:flex;flex-direction:column;z-index:40;font-family:' + FONT + '}'
    + '.achi-brand{display:flex;align-items:center;gap:10px;padding:16px 16px 14px}'
    + '.achi-brand img{width:28px;height:28px;flex:0 0 auto;border-radius:6px;object-fit:contain}'
    + '.achi-back{display:flex;align-items:center;gap:9px;margin:0 8px 6px;padding:7px 11px;border-radius:8px;color:rgba(255,255,255,.7);text-decoration:none;font-size:11px;line-height:1.36;font-weight:500}'
    + '.achi-back:hover{background:rgba(255,255,255,.12);color:#fff}'
    + '.achi-back svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
    + '.achi-sep{height:1px;background:rgba(255,255,255,.14);margin:2px 16px 8px}'
    + '.achi-brand b{font-size:13px;line-height:1.46;font-weight:600;letter-spacing:.02em;display:block}'
    + '.achi-brand span{font-size:11px;line-height:1.36;opacity:.72;display:block}'
    + '.achi-nav{padding:6px 8px;overflow:auto;flex:1}'
    + '.achi-link{display:flex;align-items:center;gap:10px;padding:7px 11px;border-radius:8px;color:rgba(255,255,255,.86);text-decoration:none;font-size:13px;line-height:1.46;font-weight:500;margin-bottom:2px}'
    + '.achi-link:hover{background:rgba(255,255,255,.12);color:#fff}'
    + '.achi-link.on{background:rgba(255,255,255,.16);color:#fff;font-weight:600}'
    + '.achi-link svg{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
    + '.achi-tools{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px}'
    + '.achi-tool{display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:8px;background:rgba(255,255,255,.10);color:rgba(255,255,255,.88);text-decoration:none;font-size:11px;line-height:1.36;font-weight:500;min-width:0}'
    + '.achi-tool:hover{background:rgba(255,255,255,.18);color:#fff}'
    + '.achi-tool span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.achi-tool svg{width:14px;height:14px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
    + '.achi-foot{padding:10px 16px 14px;font-size:11px;line-height:1.36;opacity:.55}'
    + '.achi-top{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:10px;background:#fff;border-bottom:1px solid #dfe4ec;padding:11px 18px;font-family:' + FONT + '}'
    + '.achi-top h1{font-size:13px;line-height:1.46;font-weight:600;color:#1d1d1f}'
    + '.achi-burger{display:none;border:0;background:#eef2fb;color:#284F9E;border-radius:8px;padding:7px 9px;cursor:pointer;font-size:15px;line-height:1}'
    + 'body{padding-left:216px}'
    + '@media (max-width:900px){'
    + ' body{padding-left:0}'
    + ' .achi-chrome{transform:translateX(-100%);transition:transform .18s ease;box-shadow:0 0 40px rgba(0,0,0,.3)}'
    + ' .achi-chrome.open{transform:none}'
    + ' .achi-burger{display:inline-flex}'
    + '}';

  function build(title) {
    var side = document.createElement('nav');
    side.className = 'achi-chrome';
    // Start on the stock mark so the sidebar paints immediately; applyBranding()
    // swaps in the real ACHI logo once /api/v1/branding/ answers. See there for
    // why the logo cannot simply be a file path.
    side.innerHTML =
      '<div class="achi-brand">'
      + '<img id="achi-logo" src="/logo.svg" alt="" onerror="this.style.display=\'none\'">'
      + '<div><b>ACHI</b><span id="achi-credit">by ACHI Scaffolding</span></div></div>'
      + '<a class="achi-back" href="/modules">'
      + '<svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>'
      + '<span>All modules</span></a>'
      + '<div class="achi-sep"></div>'
      + '<div class="achi-nav">'
      + LINKS.map(function (l) {
          return '<a class="achi-link' + (l.k === activeKey() ? ' on' : '') + '" href="' + l.href + '">'
            + '<svg viewBox="0 0 24 24">' + l.icon + '</svg><span>' + l.label + '</span></a>';
        }).join('')
      + '</div>'
      // Separator then the admin grid, pinned below the scrolling nav the way
      // upstream pins it — .achi-nav takes flex:1, so this stays at the bottom.
      + '<div class="achi-sep"></div>'
      + '<div class="achi-tools">'
      + TOOLS.map(function (t) {
          return '<a class="achi-tool" href="' + t.href + '" title="' + t.label + '">'
            + '<svg viewBox="0 0 24 24">' + t.icon + '</svg><span>' + t.label + '</span></a>';
        }).join('')
      + '</div>'
      + '<div class="achi-foot">' + VERSION + '</div>';

    var top = document.createElement('div');
    top.className = 'achi-top';
    top.innerHTML = '<button class="achi-burger" type="button" aria-label="Menu">&#9776;</button><h1>' + title + '</h1>';
    top.querySelector('.achi-burger').addEventListener('click', function () { side.classList.toggle('open'); });

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    document.body.insertBefore(side, document.body.firstChild);
    document.body.insertBefore(top, side.nextSibling);
  }

  /* The ACHI logo is not a file. apply-branding.sh PUTs it to /api/v1/branding/
   * as a base64 data URL held in the DB, because the tab title and in-app logo
   * are a runtime setting the partner pack does not carry. /logo.svg is stock
   * OpenConstructionERP, which is why hardcoding it showed the wrong mark.
   *
   * Read at runtime rather than baked in: re-brand once and every page follows,
   * with no redeploy. The endpoint is public (it is what the login screen draws
   * with), so this works before sign-in too. Any failure leaves the stock mark
   * already on screen — a wrong logo is survivable, a broken sidebar is not.
   */
  function applyBranding() {
    try {
      fetch('/api/v1/branding/', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (b) {
          if (!b) return;
          var img = document.getElementById('achi-logo');
          if (img && b.logo_data_url) { img.src = b.logo_data_url; img.style.display = ''; }
          var credit = document.getElementById('achi-credit');
          if (credit && b.company_name) credit.textContent = 'by ' + b.company_name;
        })
        .catch(function () {});
    } catch (e) {}
  }

  function boot() {
    // Each page names itself; fall back to the document title.
    var t = document.body.getAttribute('data-achi-title') || document.title.split('·')[0].trim();
    build(t);
    applyBranding();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
