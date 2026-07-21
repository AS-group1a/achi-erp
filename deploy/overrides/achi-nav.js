/* ACHI Scaffolding - sidebar "Call Log" entry + in-app embed (tier 3, no fork).
 *
 * Adds our pages ("Call Log", "Site Survey") under "Project Files" and, when
 * clicked, docks them as an iframe over the content area to the RIGHT of the
 * sidebar and BELOW the header - so it reads like an in-app module instead of a
 * separate URL. Clicking any other sidebar link hides it.
 *
 * Interception is done with a single GLOBAL capture-phase listener (not a
 * per-link handler) so it keeps working across SPA re-renders. Same-origin
 * iframe shares the JWT -> no second login. Bump the ?v= in index.html when you
 * change this file; a workbox service worker caches it CacheFirst by URL.
 */
(function () {
  'use strict';
  var EMBED = 'achi-embed';
  // Our sidebar entries. Each is an id, the pretty URL, and the page it frames.
  // `icon` replaces the cloned link's SVG so the entry doesn't wear Project Files'
  // icon; ?v= busts the service-worker cache when a page changes.
  var ENTRIES = [
    { id: 'achi-nav-log', label: 'Call Log', route: '/call-log',
      href: '/api/v1/achi/ui?v=18',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>' },
    { id: 'achi-nav-survey', label: 'Site Survey', route: '/site-survey',
      href: '/api/v1/achi/survey/ui?v=1',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2 3 5v17l6-3 6 3 6-3V2l-6 3-6-3z"/><path d="M9 2v17"/><path d="M15 5v17"/></svg>' }
  ];
  var byRoute = function (r) { for (var i = 0; i < ENTRIES.length; i++) if (ENTRIES[i].route === r) return ENTRIES[i]; return null; };
  var byId = function (id) { for (var i = 0; i < ENTRIES.length; i++) if (ENTRIES[i].id === id) return ENTRIES[i]; return null; };

  function links() { return document.querySelectorAll('nav a, aside a, [class*="sidebar" i] a'); }
  function projectFilesLink() {
    var a = links();
    for (var i = 0; i < a.length; i++) {
      var h = a[i].getAttribute('href') || '';
      if (h === '/files' || h.replace(/\/+$/, '').slice(-6) === '/files') return a[i];
    }
    return null;
  }
  function sidebarEl() {
    var our = document.getElementById(ENTRIES[0].id) || document.getElementById(ENTRIES[1] && ENTRIES[1].id);
    var anchor = our || projectFilesLink();
    return anchor ? anchor.closest('nav, aside, [class*="sidebar" i]') : null;
  }
  function setIcon(el, svg) {
    var old = el.querySelector('svg');
    if (!old || !svg) return;
    var box = document.createElement('span');
    box.innerHTML = svg;
    var fresh = box.firstChild;
    // Keep the cloned icon's sizing classes so it lines up with the others.
    if (old.getAttribute('class')) fresh.setAttribute('class', old.getAttribute('class'));
    fresh.setAttribute('width', old.getAttribute('width') || '18');
    fresh.setAttribute('height', old.getAttribute('height') || '18');
    old.parentNode.replaceChild(fresh, old);
  }
  function setLabel(el, t) {
    var s = el.querySelectorAll('span');
    for (var i = 0; i < s.length; i++) if (s[i].textContent && s[i].textContent.trim()) { s[i].textContent = t; return; }
    el.setAttribute('title', t);
  }

  // The content region = the SPA's <main> (falls back to the sidebar's widest
  // sibling, then to the sidebar's right edge). Measuring <main> keeps the embed
  // exactly where a page would render — no gap, not floating over the header.
  function contentRect() {
    var m = document.querySelector('main, [role="main"]');
    if (m) { var r = m.getBoundingClientRect(); if (r.width > 300 && r.height > 160) return r; }
    var sb = sidebarEl();
    if (sb && sb.parentElement) {
      var best = null, kids = sb.parentElement.children;
      for (var i = 0; i < kids.length; i++) { var el = kids[i]; if (el === sb) continue; var rr = el.getBoundingClientRect(); if (rr.width > 300 && rr.height > 160 && (!best || rr.width > best.width)) best = rr; }
      if (best) return best;
      var sr = sb.getBoundingClientRect();
      return { left: sr.right, top: sr.top, width: window.innerWidth - sr.right, height: window.innerHeight - sr.top };
    }
    return { left: 220, top: 0, width: window.innerWidth - 220, height: window.innerHeight };
  }
  function positionEmbed(f) {
    var c = contentRect();
    f.style.left = Math.round(c.left) + 'px';
    f.style.top = Math.round(c.top) + 'px';
    f.style.width = Math.round(c.width) + 'px';
    f.style.height = Math.round(c.height) + 'px';
  }
  // Full-screen cover shown INSTANTLY on a hard load of /call-log, so the SPA's
  // 404 never flashes before the embed is ready. Removed when the iframe loads.
  function showCover() {
    if (document.getElementById('achi-cover')) return;
    var c = document.createElement('div');
    c.id = 'achi-cover';
    c.style.cssText = 'position:fixed;inset:0;z-index:9998;background:#f5f5f7;display:flex;align-items:center;justify-content:center;color:#284F9E;font:600 13px -apple-system,Segoe UI,sans-serif';
    var e0 = byRoute(location.pathname);
    c.textContent = 'Loading ' + ((e0 && e0.label) || 'page') + '…';
    (document.body || document.documentElement).appendChild(c);
    setTimeout(hideCover, 6000);   // never get stuck if the iframe stalls
  }
  function hideCover() { var c = document.getElementById('achi-cover'); if (c) c.remove(); }

  function clearCurrent() {
    for (var i = 0; i < ENTRIES.length; i++) {
      var l = document.getElementById(ENTRIES[i].id);
      if (l) l.removeAttribute('aria-current');
    }
  }
  // One iframe, reused: switching entries swaps its src rather than stacking
  // frames, so only one of our pages is ever alive.
  function showEmbed(entry, pushUrl) {
    if (!entry) return;
    var f = document.getElementById(EMBED);
    if (!f) {
      f = document.createElement('iframe');
      f.id = EMBED;
      f.style.cssText = 'position:fixed;border:0;z-index:50;background:#f5f5f7';
      document.body.appendChild(f);
    }
    f.onload = hideCover;
    if (f.getAttribute('data-entry') !== entry.id) {
      f.setAttribute('data-entry', entry.id);
      f.setAttribute('title', 'ACHI ' + entry.label);
      f.src = entry.href;
    }
    if (pushUrl && location.pathname !== entry.route) { try { history.pushState({ achi: 1 }, '', entry.route); } catch (e) {} }
    positionEmbed(f);
    f.style.display = 'block';
    clearCurrent();
    var link = document.getElementById(entry.id); if (link) link.setAttribute('aria-current', 'page');
  }
  function hideEmbed() {
    var f = document.getElementById(EMBED);
    if (f) {
      // Tell the page to save any half-typed draft rows before it goes away.
      try { f.contentWindow.postMessage({ type: 'achi-flush' }, location.origin); } catch (e) {}
      f.style.display = 'none';
    }
    hideCover();
    clearCurrent();
  }

  function inject() {
    var pf = projectFilesLink();
    if (!pf) return;
    var after = pf;
    for (var i = 0; i < ENTRIES.length; i++) {
      var e = ENTRIES[i];
      var existing = document.getElementById(e.id);
      if (existing) { after = existing; continue; }
      var link = pf.cloneNode(true);
      link.id = e.id; link.setAttribute('href', e.route);
      link.removeAttribute('aria-current');
      link.classList.remove('active', 'router-link-active', 'router-link-exact-active');
      setLabel(link, e.label);
      setIcon(link, e.icon);
      after.parentNode.insertBefore(link, after.nextSibling);
      after = link;
    }
  }

  // ONE global capture listener handles show + hide, regardless of re-renders.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var entry = byId(a.id) || byRoute(href);
    if (entry) { e.preventDefault(); e.stopImmediatePropagation(); showEmbed(entry, true); return; }
    if (a.closest('nav, aside, [class*="sidebar" i]')) hideEmbed();   // real navigation elsewhere
  }, true);

  // On a hard load straight to /call-log, cover the 404 flash immediately.
  if (byRoute(location.pathname)) showCover();

  // Keep the embed in sync with the URL: /call-log shows it, anything else hides.
  function syncToUrl() { var e = byRoute(location.pathname); if (e) showEmbed(e, false); else hideEmbed(); }
  window.addEventListener('popstate', syncToUrl);
  function reposition() { var f = document.getElementById(EMBED); if (f && f.style.display !== 'none') positionEmbed(f); }
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);

  var obs = new MutationObserver(function () { inject(); var e = byRoute(location.pathname); if (e) showEmbed(e, false); });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  function boot() { inject(); syncToUrl(); }
  if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
