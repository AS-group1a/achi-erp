/* ACHI Scaffolding - sidebar ordering + "Call Log" embed (tier 3, no fork).
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
  var ID = ENTRIES[0].id;
  var CONTACTS_ID = 'achi-nav-contacts';
  var CRM_ID = 'achi-nav-crm';
  var HREF = ENTRIES[0].href;
  var ROUTE = ENTRIES[0].route;
  var ORDER_KEY = 'achi_sidebar_module_order_v2';
  var dragged = null;
  var draggedAt = 0;
  var arranging = false;

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
  function moduleNav() {
    var pf = projectFilesLink();
    return pf ? pf.closest('nav') : null;
  }
  function directLink(item) {
    if (!item || item.tagName !== 'LI') return null;
    for (var i = 0; i < item.children.length; i++) {
      var child = item.children[i];
      if (child.tagName === 'A') return child;
    }
    return null;
  }
  function moduleItems() {
    var nav = moduleNav();
    if (!nav) return [];
    var out = [], items = nav.querySelectorAll('ul > li');
    for (var i = 0; i < items.length; i++) {
      var link = directLink(items[i]);
      var href = link ? link.getAttribute('href') || '' : '';
      if (href.charAt(0) === '/' && href.indexOf('/api/') !== 0) out.push(items[i]);
    }
    return out;
  }
  function orderId(link) {
    var href = (link.getAttribute('href') || '').replace(/\?.*$/, '').replace(/\/+$/, '') || '/';
    return href === HREF.replace(/\?.*$/, '') ? ROUTE : href;
  }
  function routeItem(route, syntheticId, labelText) {
    var items = moduleItems(), fallback = null;
    for (var i = 0; i < items.length; i++) {
      var link = directLink(items[i]), href = link ? orderId(link) : '';
      if (href === route) {
        if (link.id !== syntheticId) return items[i];
        fallback = items[i];
      }
    }
    for (var j = 0; j < items.length; j++) {
      var label = directLink(items[j]);
      if (label && (label.textContent || '').trim().toLowerCase() === labelText.toLowerCase()) return items[j];
    }
    return fallback;
  }
  function ensureRouteAfter(precedingItem, route, syntheticId, labelText) {
    if (!precedingItem || !precedingItem.parentNode) return null;
    var synthetic = document.getElementById(syntheticId);
    var item = synthetic && synthetic.closest('li');
    if (!item) {
      item = precedingItem.cloneNode(true);
      var anchor = directLink(item);
      if (!anchor) return null;
      anchor.id = syntheticId;
      anchor.setAttribute('href', route);
      anchor.removeAttribute('aria-current');
      anchor.classList.remove('active', 'router-link-active', 'router-link-exact-active');
      setLabel(anchor, labelText);
    }
    // Do not move React-owned rows between groups; React will reconstruct them
    // and can enter a render fight. The ACHI Overview link opens the same route.
    moduleItems().forEach(function (candidate) {
      var candidateLink = directLink(candidate);
      if (candidateLink && candidateLink.id !== syntheticId && orderId(candidateLink) === route) {
        candidate.style.display = 'none';
        candidate.setAttribute('aria-hidden', 'true');
        candidate.setAttribute('data-achi-relocated', syntheticId);
      }
    });
    if (item.parentNode !== precedingItem.parentNode || item !== precedingItem.nextElementSibling) {
      precedingItem.parentNode.insertBefore(item, precedingItem.nextSibling);
    }
    return item;
  }
  function ensureOverviewModules() {
    var log = document.getElementById(ID);
    var logItem = log && log.closest('li');
    if (!logItem || !logItem.parentNode) return null;
    var specs = [
      { id: CONTACTS_ID, route: '/contacts', label: 'Contacts' },
      { id: CRM_ID, route: '/crm', label: 'CRM' }
    ];
    var previous = logItem;
    specs.forEach(function (spec) {
      var link = document.getElementById(spec.id);
      var item = link && link.closest('li');
      if (!link) {
        item = logItem.cloneNode(true);
        link = directLink(item);
        if (!link) return;
        link.id = spec.id;
        link.setAttribute('href', spec.route);
        link.removeAttribute('aria-current');
        link.classList.remove('active', 'router-link-active', 'router-link-exact-active');
        setLabel(link, spec.label);
      }
      if (item.parentNode !== logItem.parentNode || item !== previous.nextElementSibling) {
        logItem.parentNode.insertBefore(item, previous.nextSibling);
      }
      previous = item;
    });
    // Suppress the original group entries; these inline links open the same
    // upstream routes and therefore the same Contacts and CRM data.
    moduleItems().forEach(function (item) {
      var link = directLink(item), href = link ? orderId(link) : '';
      if (link && link.id !== CONTACTS_ID && link.id !== CRM_ID &&
          (href === '/contacts' || href === '/crm')) {
        item.style.display = 'none';
        item.setAttribute('aria-hidden', 'true');
      }
    });
    return { contacts: document.getElementById(CONTACTS_ID), crm: document.getElementById(CRM_ID) };
  }
  function savedOrder() {
    try { var value = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); return Array.isArray(value) ? value : []; }
    catch (e) { return []; }
  }
  function saveOrder() {
    var nav = moduleNav();
    if (!nav) return;
    var groups = [], lists = nav.querySelectorAll('ul');
    for (var i = 0; i < lists.length; i++) {
      var ids = [], children = lists[i].children;
      for (var j = 0; j < children.length; j++) {
        var link = directLink(children[j]);
        if (link) ids.push(orderId(link));
      }
      groups.push(ids);
    }
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(groups)); } catch (e) {}
  }
  function applySidebarOrder() {
    if (arranging || dragged) return;
    var nav = moduleNav();
    if (!nav) return;
    arranging = true;
    var ours = document.getElementById(ID), oursItem = ours && ours.closest('li');
    ensureOverviewModules();
    var order = savedOrder();
    if (order.length) {
      var items = moduleItems(), byId = {}, lists = nav.querySelectorAll('ul');
      items.forEach(function (item) { var link = directLink(item); if (link) byId[orderId(link)] = item; });
      order.forEach(function (ids, groupIndex) {
        var list = lists[groupIndex];
        if (!list || !Array.isArray(ids)) return;
        ids.forEach(function (id) { if (byId[id]) list.appendChild(byId[id]); });
      });
    }
    moduleItems().forEach(function (item) {
      var link = directLink(item);
      item.draggable = true;
      item.classList.add('achi-sidebar-draggable');
      if (link) item.setAttribute('data-achi-order-id', orderId(link));
    });
    arranging = false;
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

  // The SPA's router knows none of our routes, so it resolves each as a 404 and
  // sets document.title to "Page not found | <app>". The cover hides the visual
  // 404; without this the tab still advertised an error on a page that works.
  // Re-applied rather than set once: the router rewrites the title
  // asynchronously and again on every re-render.
  var appName = '', titleEntry = null, titleObs = null;
  function wantedTitle() {
    var base = (titleEntry && titleEntry.label) || '';
    return appName ? base + ' | ' + appName : base;
  }
  function applyTitle() {
    if (!titleEntry) return;
    var t = document.title || '';
    if (t === wantedTitle()) return;            // already ours; stops the observer looping
    var i = t.lastIndexOf('|');                 // learn the app name from whatever it set
    var tail = i >= 0 ? t.slice(i + 1).trim() : '';
    if (tail) appName = tail;
    document.title = wantedTitle();
  }
  function holdTitle(entry) {
    titleEntry = entry || null;
    if (!titleEntry) { if (titleObs) { titleObs.disconnect(); titleObs = null; } return; }
    applyTitle();
    var el = document.querySelector('title');
    if (titleObs || !el) return;
    titleObs = new MutationObserver(function () {
      var e = byRoute(location.pathname);       // follows a switch between our entries
      if (e) { titleEntry = e; applyTitle(); }
    });
    titleObs.observe(el, { childList: true, characterData: true, subtree: true });
  }

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
    holdTitle(entry);
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
    holdTitle(null);   // release it; the SPA names its own real pages
  }

  function inject() {
    var pf = projectFilesLink();
    if (!pf) return;
    var sourceItem = pf.closest('li');
    if (!sourceItem) return;
    var after = sourceItem;
    for (var i = 0; i < ENTRIES.length; i++) {
      var e = ENTRIES[i];
      var existing = document.getElementById(e.id);
      if (existing) { after = existing.closest('li') || after; continue; }
      var item = sourceItem.cloneNode(true);
      var link = directLink(item);
      if (!link) continue;
      link.id = e.id; link.setAttribute('href', e.route);
      link.removeAttribute('aria-current');
      link.classList.remove('active', 'router-link-active', 'router-link-exact-active');
      setLabel(link, e.label);
      setIcon(link, e.icon);
      after.parentNode.insertBefore(item, after.nextSibling);
      after = item;
    }
    applySidebarOrder();
  }

  // Native sidebar drag-and-drop. Reordering the existing anchors preserves all
  // upstream click handlers; the MutationObserver reapplies the saved order if
  // the SPA rebuilds the sidebar during navigation.
  document.addEventListener('dragstart', function (e) {
    var item = e.target.closest && e.target.closest('li.achi-sidebar-draggable');
    if (!item) return;
    dragged = item; draggedAt = Date.now(); item.classList.add('achi-sidebar-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.getAttribute('data-achi-order-id') || ''); }
  }, true);
  document.addEventListener('dragover', function (e) {
    if (!dragged) return;
    var over = e.target.closest && e.target.closest('li.achi-sidebar-draggable');
    if (!over || over === dragged) return;
    e.preventDefault();
    var r = over.getBoundingClientRect();
    over.parentNode.insertBefore(dragged, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  }, true);
  document.addEventListener('drop', function (e) {
    if (!dragged) return;
    e.preventDefault(); saveOrder();
  }, true);
  document.addEventListener('dragend', function () {
    if (!dragged) return;
    dragged.classList.remove('achi-sidebar-dragging'); saveOrder(); dragged = null; draggedAt = Date.now();
  }, true);

  // ONE global capture listener handles show + hide, regardless of re-renders.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a) return;
    if (Date.now() - draggedAt < 250) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    var href = a.getAttribute('href') || '';
    if (a.id === CONTACTS_ID || a.id === CRM_ID) {
      e.preventDefault(); e.stopImmediatePropagation(); hideEmbed(); location.assign(href); return;
    }
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

  // Avoid observing the whole React tree: the authenticated app performs many
  // unrelated DOM mutations and a global observer can continuously rescan it.
  // This check is effectively free once the requested sequence is in place.
  window.setInterval(function () {
    var log = document.getElementById(ID), survey = document.getElementById(ENTRIES[1].id);
    var contacts = document.getElementById(CONTACTS_ID);
    var crm = document.getElementById(CRM_ID);
    if (log && survey && contacts && crm) return;
    inject();
    ensureOverviewModules();
    var entry = byRoute(location.pathname);
    if (entry) showEmbed(entry, false);
  }, 1000);
  function boot() { inject(); syncToUrl(); }
  if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
