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
  var HREF = '/api/v1/achi/ui?v=2';

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

  // Dock to the RIGHT of the sidebar, full height. Top is aligned to the very
  // top of the sidebar column so there is no gap above the embed.
  function positionEmbed(f) {
    var sb = sidebarEl();
    var left = 220, top = 0;
    if (sb) { var r = sb.getBoundingClientRect(); left = Math.max(0, Math.round(r.right)); top = Math.max(0, Math.round(r.top)); }
    f.style.left = left + 'px';
    f.style.top = top + 'px';
    f.style.width = (window.innerWidth - left) + 'px';
    f.style.height = (window.innerHeight - top) + 'px';
  }
  function showEmbed() {
    var f = document.getElementById(EMBED);
    if (!f) {
      f = document.createElement('iframe');
      f.id = EMBED; f.src = HREF; f.setAttribute('title', 'ACHI Call Log');
      f.style.cssText = 'position:fixed;border:0;z-index:50;background:#f5f5f7';
      document.body.appendChild(f);
    }
    positionEmbed(f);
    f.style.display = 'block';
  }
  function hideEmbed() { var f = document.getElementById(EMBED); if (f) f.style.display = 'none'; }

  function inject() {
    if (document.getElementById(ID)) return;
    var pf = projectFilesLink();
    if (!pf) return;
    var link = pf.cloneNode(true);
    link.id = ID; link.setAttribute('href', HREF);
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
    var ours = a.id === ID || href === HREF || href.indexOf('/api/v1/achi/ui') !== -1;
    if (ours) { e.preventDefault(); e.stopImmediatePropagation(); showEmbed(); return; }
    if (a.closest('nav, aside, [class*="sidebar" i]')) hideEmbed();
  }, true);

  window.addEventListener('resize', function () { var f = document.getElementById(EMBED); if (f && f.style.display !== 'none') positionEmbed(f); });
  window.addEventListener('popstate', hideEmbed);

  var obs = new MutationObserver(inject);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState !== 'loading') inject(); else document.addEventListener('DOMContentLoaded', inject);
})();
