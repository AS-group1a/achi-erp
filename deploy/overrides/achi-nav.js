/* ACHI Scaffolding - sidebar "Call Log" entry + in-app embed (tier 3, no fork).
 *
 * Adds "Call Log" under "Project Files" and, when clicked, docks our page
 * (/api/v1/achi/ui) as an iframe over the content area to the RIGHT of the
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
  var ID = 'achi-nav-log';
  var EMBED = 'achi-embed';
  var LABEL = 'Call Log';
  var HREF = '/api/v1/achi/ui?v=3'; // iframe source; version busts the service-worker cache
  var ROUTE = '/call-log';         // the pretty URL we show in the address bar

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
    var our = document.getElementById(ID);
    var anchor = our || projectFilesLink();
    return anchor ? anchor.closest('nav, aside, [class*="sidebar" i]') : null;
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
    c.textContent = 'Loading Call Log…';
    (document.body || document.documentElement).appendChild(c);
    setTimeout(hideCover, 6000);   // never get stuck if the iframe stalls
  }
  function hideCover() { var c = document.getElementById('achi-cover'); if (c) c.remove(); }

  function showEmbed(pushUrl) {
    var f = document.getElementById(EMBED);
    if (!f) {
      f = document.createElement('iframe');
      f.id = EMBED; f.src = HREF; f.setAttribute('title', 'ACHI Call Log');
      f.style.cssText = 'position:fixed;border:0;z-index:50;background:#f5f5f7';
      f.onload = hideCover;
      document.body.appendChild(f);
    }
    if (pushUrl && location.pathname !== ROUTE) { try { history.pushState({ achi: 1 }, '', ROUTE); } catch (e) {} }
    positionEmbed(f);
    f.style.display = 'block';
    var link = document.getElementById(ID); if (link) link.setAttribute('aria-current', 'page');
  }
  function hideEmbed() {
    var f = document.getElementById(EMBED); if (f) f.style.display = 'none';
    hideCover();
    var link = document.getElementById(ID); if (link) link.removeAttribute('aria-current');
  }

  function inject() {
    if (document.getElementById(ID)) return;
    var pf = projectFilesLink();
    if (!pf) return;
    var link = pf.cloneNode(true);
    link.id = ID; link.setAttribute('href', ROUTE);
    link.removeAttribute('aria-current');
    link.classList.remove('active', 'router-link-active', 'router-link-exact-active');
    setLabel(link, LABEL);
    pf.parentNode.insertBefore(link, pf.nextSibling);
  }

  // ONE global capture listener handles show + hide, regardless of re-renders.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var ours = a.id === ID || href === ROUTE || href === HREF;
    if (ours) { e.preventDefault(); e.stopImmediatePropagation(); showEmbed(true); return; }
    if (a.closest('nav, aside, [class*="sidebar" i]')) hideEmbed();   // real navigation elsewhere
  }, true);

  // On a hard load straight to /call-log, cover the 404 flash immediately.
  if (location.pathname === ROUTE) showCover();

  // Keep the embed in sync with the URL: /call-log shows it, anything else hides.
  function syncToUrl() { if (location.pathname === ROUTE) showEmbed(false); else hideEmbed(); }
  window.addEventListener('popstate', syncToUrl);
  function reposition() { var f = document.getElementById(EMBED); if (f && f.style.display !== 'none') positionEmbed(f); }
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);

  var obs = new MutationObserver(function () { inject(); if (location.pathname === ROUTE) showEmbed(false); });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  function boot() { inject(); syncToUrl(); }
  if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
