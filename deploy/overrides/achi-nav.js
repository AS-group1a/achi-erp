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

  check();
  window.addEventListener('popstate', check);
  // Catches the token appearing after sign-in and the SPA's own navigations.
  window.setInterval(check, 400);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
})();
