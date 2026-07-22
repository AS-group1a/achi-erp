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

  // Our pages first, then the upstream destinations worth a jump from here.
  var LINKS = [
    { k: 'calllog',  label: 'Call Log',      href: '/api/v1/achi/ui',        icon: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>' },
    { k: 'survey',   label: 'Site Survey',   href: '/api/v1/achi/survey/ui', icon: '<path d="M9 2 3 5v17l6-3 6 3 6-3V2l-6 3-6-3z"/><path d="M9 2v17"/><path d="M15 5v17"/>' },
    { k: 'quotes',   label: 'Quotations',   href: '/api/v1/achi/quotations/ui', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h3"/>' },
    { k: 'contacts', label: 'Contacts',      href: '/contacts',              icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' },
    { k: 'crm',      label: 'CRM',           href: '/crm',                   icon: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>' },
    { k: 'projects', label: 'Projects',      href: '/projects',              icon: '<path d="M3 7h6l2 2h10v10H3z"/>' },
    { k: 'files',    label: 'Project Files', href: '/files',                 icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>' }
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
    { label: 'Settings',   href: '/settings',   icon: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>' },
    { label: 'Users',      href: '/users',      icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
    { label: 'Modules',    href: '/modules',    icon: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>' },
    { label: 'Governance', href: '/governance', icon: '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>' },
    { label: 'Audit',      href: '/audits',     icon: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>' },
    { label: 'About',      href: '/about',      icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>' }
  ];

  // The community row upstream renders below the cluster. Telegram's mark is a
  // filled glyph, not a stroked one, hence the per-item `fill` flag.
  var COMMUNITY = [
    { label: 'GitHub',    href: 'https://github.com/datadrivenconstruction/OpenConstructionERP',
      icon: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>' },
    { label: 'Community', href: 'https://t.me/datadrivenconstruction', fill: true,
      icon: '<path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.14-3.06-1.99 1.93c-.23.23-.42.42-.83.42z"/>' }
  ];

  function activeKey() {
    var p = location.pathname;
    if (p.indexOf('/achi/survey/ui') !== -1) return 'survey';
    if (p.indexOf('/achi/quotations/ui') !== -1) return 'quotes';
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
    /* Hover-expand, mirroring Grece's behaviour on the app sidebar: start
     * collapsed, expand on hover, settle back after a beat. Widths are
     * upstream's exact 64/248 rather than our old 216 — when the two sidebars
     * are different widths, every crossing between an app page and one of ours
     * shifts the whole layout, which is the flash. Same width, no jump.
     * CSS-only here: there is no React state to hand off to, so hover does not
     * need JS, and a pure-CSS transition cannot desync from the pointer. */
    + ':root{--achi-sb:64px}'
    + '.achi-chrome{position:fixed;left:0;top:0;bottom:0;width:var(--achi-sb);background:#284F9E;color:#fff;display:flex;flex-direction:column;z-index:40;font-family:' + FONT + ';overflow:hidden;transition:width .2s ease}'
    + '.achi-chrome:hover{width:248px}'
    /* Collapsed: icons only. Labels stay in the DOM for screen readers and fade
     * back in on expand — display:none would make them unreadable to AT too. */
    + '.achi-chrome:not(:hover) .achi-link span,.achi-chrome:not(:hover) .achi-back span,'
    +   '.achi-chrome:not(:hover) .achi-tool span,.achi-chrome:not(:hover) .achi-brand div,'
    +   '.achi-chrome:not(:hover) .achi-foot{opacity:0;pointer-events:none}'
    + '.achi-chrome:not(:hover) .achi-tools,.achi-chrome:not(:hover) .achi-community{grid-template-columns:1fr}'
    + '.achi-link span,.achi-back span,.achi-tool span,.achi-brand div,.achi-foot{transition:opacity .15s ease}'
    + 'body:has(.achi-chrome:hover){--achi-sb:248px}'
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
    + '.achi-tools{display:grid;grid-template-columns:1fr 1fr;gap:4px;list-style:none;margin:0;padding:0}'
    + '.achi-tool{display:flex;align-items:center;justify-content:flex-start;gap:6px;height:32px;padding:0 8px;border-radius:6px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:rgba(255,255,255,.82);text-decoration:none;font-size:11px;line-height:1;font-weight:500;min-width:0;transition:background .12s,color .12s,border-color .12s}'
    + '.achi-tool:hover{background:rgba(255,255,255,.14);color:#fff;border-color:rgba(255,255,255,.3)}'
    + '.achi-tool span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.achi-tool svg{width:14px;height:14px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}'
    + '.achi-tool svg.fill{fill:currentColor;stroke:none}'
    + '.achi-community{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px}'
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
    +   'background-size:24px 24px;transition:padding-left .2s ease}'
    + '@media (prefers-color-scheme:dark){body{background-color:#161822}}'
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
      // The cluster is pinned below the scrolling nav the way upstream pins it —
      // .achi-nav takes flex:1, so this always sits at the bottom. Its own
      // gradient hairline is the separator, so no .achi-sep here.
      + '<div class="achi-cluster">'
      + '<ul class="achi-tools">'
      + TOOLS.map(function (t) {
          return '<li><a class="achi-tool" href="' + t.href + '" title="' + t.label + '" aria-label="' + t.label + '">'
            + '<svg viewBox="0 0 24 24" aria-hidden="true">' + t.icon + '</svg>'
            + '<span>' + t.label + '</span></a></li>';
        }).join('')
      + '</ul>'
      + '<div class="achi-community">'
      + COMMUNITY.map(function (t) {
          return '<a class="achi-tool" href="' + t.href + '" target="_blank" rel="noopener noreferrer" title="' + t.label + '" aria-label="' + t.label + '">'
            + '<svg viewBox="0 0 24 24" aria-hidden="true"' + (t.fill ? ' class="fill"' : '') + '>' + t.icon + '</svg>'
            + '<span>' + t.label + '</span></a>';
        }).join('')
      + '</div></div>'
      // Version + licence, upstream's own footer. /api/source is the AGPL source
      // offer — it is a licence notice, so it is reproduced, not restyled away.
      + '<div class="achi-foot"><span>v11.9.0</span><span>·</span>'
      + '<a href="/api/source" target="_blank" rel="noopener noreferrer">AGPL-3.0</a></div>';

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
