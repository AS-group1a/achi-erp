/*
 * ACHI workspace-sidebar recovery.
 *
 * DRAW, RESOURCE and PLAN are separate ACHI workspaces.  This tiny injector is
 * deliberately independent from the older, broader achi-nav.js behaviour: it
 * only guarantees these three links in the real OCE sidebar.  React may rebuild
 * that sidebar at any time, so the recovery runs again after DOM changes.
 */
(function () {
  'use strict';

  var ENTRIES = [
    { id: 'achi-nav-draw', label: 'DRAW', href: '/api/v1/achi/draw/ui', after: 'site visit' },
    { id: 'achi-nav-resource', label: 'RESOURCE', href: '/api/v1/achi/resource/ui', after: 'boq' },
    { id: 'achi-nav-plan', label: 'PLAN', href: '/api/v1/achi/plan/ui', after: 'resource' }
  ];
  var pending = false;

  function sidebar() {
    return document.querySelector('[data-testid="app-sidebar"], aside.oe-sidebar');
  }

  function directLink(item) {
    if (!item) return null;
    for (var i = 0; i < item.children.length; i++) {
      if (item.children[i].tagName === 'A') return item.children[i];
    }
    return item.querySelector('a');
  }

  function labelLink(link, label) {
    var spans = link.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].children.length === 0 && spans[i].textContent.trim()) {
        spans[i].textContent = label;
        return;
      }
    }
    link.setAttribute('aria-label', label);
    link.setAttribute('title', label);
  }

  function seedItem(root) {
    var links = root.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      var href = (links[i].getAttribute('href') || '').split('?')[0];
      var text = (links[i].textContent || '').trim().toLowerCase();
      if (href === '/call-log' || href === '/mt' || href === '/boq' ||
          text === 'log' || text === 'm/t' || text === 'boq') {
        return links[i].closest('li');
      }
    }
    return null;
  }

  function itemWithLabel(root, wanted) {
    var links = root.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      var text = (links[i].textContent || '').trim().toLowerCase();
      if (text === wanted) return links[i].closest('li');
    }
    return null;
  }

  function configure(link, entry) {
    link.id = entry.id;
    link.setAttribute('href', entry.href);
    link.setAttribute('data-achi-workspace', entry.href);
    link.removeAttribute('aria-current');
    link.classList.remove('active', 'router-link-active', 'router-link-exact-active');
    labelLink(link, entry.label);
  }

  function ensure() {
    var root = sidebar();
    if (!root) return;
    var seed = seedItem(root);
    if (!seed || !seed.parentNode) return;

    ENTRIES.forEach(function (entry) {
      // Keep the real workflow sequence: Site Visit -> DRAW -> M/T -> BOQ
      // -> RESOURCE -> PLAN. If React has not rendered an anchor yet, use the
      // stable seed and retry on the next refresh.
      var after = itemWithLabel(root, entry.after) || seed;
      var link = document.getElementById(entry.id);
      var item = link && link.closest('li');
      if (!item) {
        item = seed.cloneNode(true);
        link = directLink(item);
        if (!link) return;
      }
      configure(link, entry);
      item.style.display = '';
      item.removeAttribute('aria-hidden');
      item.removeAttribute('data-achi-role-hidden');
      if (item.parentNode !== after.parentNode || item !== after.nextElementSibling) {
        after.parentNode.insertBefore(item, after.nextSibling);
      }
    });
  }

  function schedule() {
    if (pending) return;
    pending = true;
    window.setTimeout(function () { pending = false; ensure(); }, 0);
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[data-achi-workspace]');
    if (!link) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.assign(link.getAttribute('data-achi-workspace'));
  }, true);

  function boot() {
    document.documentElement.setAttribute('data-achi-workspace-nav', 'ready');
    ensure();
    var root = sidebar();
    if (root && window.MutationObserver) {
      new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
    }
    window.setInterval(ensure, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
