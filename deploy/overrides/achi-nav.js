/* ARARA - keeps people out of the underlying ERP (tier 3, no fork).
 *
 * OpenConstructionERP still runs underneath as the engine (sign-in, users,
 * database, files, CAD converters), but none of its screens are used. This
 * script is injected into every page the ERP's single-page app serves and:
 *
 *   1. sends the old pretty routes (/call-log, /crm, ...) to the matching
 *      ARARA page, so existing bookmarks keep working;
 *   2. sends any signed-in visitor on any other ERP screen to the ARARA Log.
 *
 * Only the ERP's sign-in screens (below) stay reachable, and only while signed
 * out; wherever the ERP sends someone after signing in, this forwards them to
 * ARARA. Purely navigation: the API keeps enforcing permissions server-side
 * (/api/v1/achi/authz).
 */
(function () {
  'use strict';
  var HOME = '/api/v1/achi/ui';
  var ROUTES = {
    '/call-log': HOME,
    '/contacts': '/api/v1/achi/contact-info/ui',
    '/crm': '/api/v1/achi/crm/ui',
    '/site-survey': '/api/v1/achi/site-visit/ui',
    '/achi-files': '/api/v1/achi/files/ui',
    '/users': '/api/v1/achi/users/ui'
  };
  // The ERP's own public routes (its router's list, 11.9.0 bundle).
  var SIGN_IN = ['/login', '/register', '/forgot-password', '/onboarding', '/setup'];

  // The SPA keeps the token in localStorage with "remember me", else in
  // sessionStorage, so both are checked.
  function signedIn() {
    try { return Boolean(localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token')); }
    catch (e) { return false; }
  }
  function path() { return location.pathname.replace(/\/+$/, '') || '/'; }

  function cover() {
    if (document.getElementById('achi-gate')) return;
    var g = document.createElement('div');
    g.id = 'achi-gate';
    g.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#f5f5f7;display:flex;align-items:center;justify-content:center;color:#8a8a8e;font:500 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:.02em';
    g.textContent = 'Loading…';
    (document.body || document.documentElement).appendChild(g);
  }

  var leaving = false;
  function check() {
    if (leaving) return;
    var p = path();
    if (p.indexOf('/api/') === 0) return;
    var target = ROUTES[p] || (signedIn() && SIGN_IN.indexOf(p) === -1 ? HOME : null);
    if (!target) return;
    leaving = true;
    cover();
    location.replace(target);
  }

  // Browser tab icon: the ERP ships its own logo as /favicon.svg; swap in the
  // ARARA mark (same one modules/achi/ui/chrome.js sets on the ARARA pages).
  var ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    + '<rect width="64" height="64" rx="14" fill="#284F9E"/>'
    + '<path fill="#fff" fill-rule="evenodd" d="M32 11 50.5 53h-8.2l-3.6-8.4H25.3L21.7 53h-8.2zm0 17.2-4.3 10h8.6z"/>'
    + '</svg>');
  function brandIcon() {
    var links = document.querySelectorAll('link[rel~="icon"]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('href') !== ICON) links[i].parentNode.removeChild(links[i]);
    }
    if (!document.querySelector('link[rel="icon"][href="' + ICON + '"]')) {
      var l = document.createElement('link');
      l.rel = 'icon';
      l.type = 'image/svg+xml';
      l.href = ICON;
      document.head.appendChild(l);
    }
  }

  // ARARA is light-only and the sign-in screen's theme switch is hidden
  // (achi-theme.css), so pin the ERP's stored theme to light.
  try {
    if (localStorage.getItem('oe_theme') !== 'light') localStorage.setItem('oe_theme', 'light');
  } catch (e) { /* storage blocked: the SPA falls back to the system theme */ }
  document.documentElement.classList.remove('dark');

  // The Caddyfile links /achi-theme.css?v=11, a fixed URL that browsers keep
  // serving from cache after the file changes, and bumping it there needs a
  // proxy rebuild. This script is never cached, so it loads a fresh copy under
  // its own version: bump THEME_V whenever achi-theme.css changes.
  var THEME_V = '12';
  function freshTheme() {
    var href = '/achi-theme.css?v=' + THEME_V;
    if (document.querySelector('link[rel="stylesheet"][href="' + href + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  }

  check();
  freshTheme();
  brandIcon();

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
  window.addEventListener('popstate', check);
  // Catches the token appearing after sign-in and the SPA's own navigations.
  window.setInterval(check, 400);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
})();
