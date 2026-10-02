/* Quotation editor: a customer quotation with a table of products / services
 * (dates, quantity, price per m² or other unit, line totals), totals with
 * discount and VAT, and terms & conditions printed on a second page.
 *
 *   ?id=<quotation>  opens a saved quotation
 *   ?file=<enquiry>  starts one addressed to that enquiry's customer
 *   neither          starts a blank one
 *
 * Totals here are a live preview of quotation_service.compute_totals. What is
 * stored is the server's arithmetic, so after every save the page shows the
 * server's numbers.
 */
(function () {
  'use strict';

  var API = '/api/v1/achi';
  var UNITS = ['m²', 'm', 'm³', 'pcs', 'day', 'week', 'month', 'lot'];
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var quoteId = params.get('id') || null;
  var fileId = params.get('file') || null;

  var current = null;     // the server's copy, once there is one
  var lines = [];         // [{item, description, start_date, end_date, unit, quantity, unit_price}]
  var defaults = { conditions: '', currency: 'USD', vat_percent: '11' };
  var dirty = false, busy = false;

  function token() {
    return localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function detailText(d) {
    if (!d) return '';
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) {
      return d.map(function (e) {
        var loc = e.loc || [], i = loc.indexOf('lines');
        var where = i >= 0 && typeof loc[i + 1] === 'number' ? 'Line ' + (loc[i + 1] + 1) + ': ' : '';
        return where + String(e.msg || '').replace(/^Value error, /, '');
      }).join(' · ');
    }
    return JSON.stringify(d);
  }
  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(API + path, {
      method: opts.method || 'GET',
      body: opts.body,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
    });
    if (res.status === 401) throw new Error('Your session has expired. Sign in again in the main app, then reload this page.');
    if (!res.ok) {
      var msg = 'Something went wrong (HTTP ' + res.status + ')';
      try { msg = detailText((await res.json()).detail) || msg; } catch (e) { /* not JSON */ }
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }

  // ── numbers ───────────────────────────────────────────────────────────────
  // Typed amounts may carry thousands separators; anything else non-numeric is
  // flagged rather than silently counted as zero (the server refuses it too).
  function clean(v) { return String(v == null ? '' : v).replace(/[,\s]/g, ''); }
  function parse(v) {
    var s = clean(v);
    if (s === '') return 0;
    if (!/^\d*\.?\d*$/.test(s) || s === '.') return NaN;
    return parseFloat(s);
  }
  function cents(v) { var n = parse(v); return isNaN(n) ? 0 : Math.round(n * 100); }
  function lineCents(l) {
    var q = parse(l.quantity), p = cents(l.unit_price);
    return isNaN(q) ? 0 : Math.round(q * p);
  }
  function money(minor) {
    return (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function qtyText(v) {
    var n = parse(v);
    if (!clean(v) || isNaN(n)) return '';
    return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
  }
  function totals() {
    var items = lines.reduce(function (sum, l) { return sum + lineCents(l); }, 0);
    var sub = Math.max(0, items - cents($('qe-discount').value));
    var vatPct = parse($('qe-vat').value);
    var vat = Math.round(sub * (isNaN(vatPct) ? 0 : vatPct) / 100);
    return { items: items, discount: cents($('qe-discount').value), sub: sub, vatPct: isNaN(vatPct) ? 0 : vatPct, vat: vat, total: sub + vat };
  }

  // ── dates ─────────────────────────────────────────────────────────────────
  function iso(d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function dmy(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }
  function issueDate() {
    if (current && current.created_at) {
      var d = new Date(current.created_at);
      if (!isNaN(d)) return iso(d);
    }
    return iso(new Date());
  }
  function period(l) {
    if (l.start_date && l.end_date) return dmy(l.start_date) + ' – ' + dmy(l.end_date);
    if (l.start_date) return 'From ' + dmy(l.start_date);
    if (l.end_date) return 'Until ' + dmy(l.end_date);
    return '';
  }

  // ── messages ──────────────────────────────────────────────────────────────
  function showErr(text) { var e = $('qe-err'); e.textContent = text || ''; e.hidden = !text; }
  function setMsg(text, cls) { var m = $('qe-msg'); m.textContent = text || ''; m.className = 'qe-msg' + (cls ? ' ' + cls : ''); }
  function markDirty() { dirty = true; setMsg('Unsaved changes', 'dirty'); }

  // ── lines table ───────────────────────────────────────────────────────────
  function blankLine() { return { item: '', description: '', start_date: '', end_date: '', unit: 'm²', quantity: '', unit_price: '' }; }
  function isBlank(l) {
    return !String(l.item || '').trim() && !String(l.description || '').trim() && !l.start_date && !l.end_date
      && !clean(l.quantity) && !clean(l.unit_price);
  }
  function unitOptions(unit) {
    var list = UNITS.indexOf(unit) >= 0 || !unit ? UNITS : UNITS.concat([unit]);
    return list.map(function (u) { return '<option' + (u === unit ? ' selected' : '') + '>' + esc(u) + '</option>'; }).join('');
  }
  function rowHtml(l, i) {
    var n = i + 1;
    return '<tr data-i="' + i + '">'
      + '<td class="qe-n">' + n + '</td>'
      + '<td><input class="qe-in" data-k="item" value="' + esc(l.item) + '" list="qe-item-list" maxlength="255" placeholder="e.g. Scaffolding hire" aria-label="Line ' + n + ' product or service"></td>'
      + '<td><textarea class="qe-in" data-k="description" rows="1" maxlength="5000" placeholder="Details" aria-label="Line ' + n + ' description">' + esc(l.description) + '</textarea></td>'
      + '<td><input class="qe-in" type="date" data-k="start_date" value="' + esc(l.start_date || '') + '" aria-label="Line ' + n + ' from"></td>'
      + '<td><input class="qe-in" type="date" data-k="end_date" value="' + esc(l.end_date || '') + '" aria-label="Line ' + n + ' to"></td>'
      + '<td><input class="qe-in r" data-k="quantity" inputmode="decimal" maxlength="32" value="' + esc(l.quantity || '') + '" placeholder="0" aria-label="Line ' + n + ' quantity"></td>'
      + '<td><select class="qe-in" data-k="unit" aria-label="Line ' + n + ' unit">' + unitOptions(l.unit || 'm²') + '</select></td>'
      + '<td><input class="qe-in r" data-k="unit_price" inputmode="decimal" maxlength="32" value="' + esc(l.unit_price || '') + '" placeholder="0.00" aria-label="Line ' + n + ' price per unit"></td>'
      + '<td class="qe-tot r" data-total>' + money(lineCents(l)) + '</td>'
      + '<td><button type="button" class="qe-x" data-del title="Remove line" aria-label="Remove line ' + n + '">×</button></td>'
      + '</tr>';
  }
  function grow(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
  function renderLines() {
    var body = $('qe-lines');
    body.innerHTML = lines.length
      ? lines.map(rowHtml).join('')
      : '<tr class="qe-empty"><td colspan="10">No lines yet — add a product or service.</td></tr>';
    body.querySelectorAll('textarea').forEach(grow);
    body.querySelectorAll('[data-k="quantity"],[data-k="unit_price"]').forEach(flagNumber);
    renderTotals();
  }
  function flagNumber(el) { el.classList.toggle('bad', isNaN(parse(el.value))); }
  function renderTotals() {
    var t = totals();
    $('qe-t-items').textContent = money(t.items);
    $('qe-t-sub').textContent = money(t.sub);
    $('qe-t-vat').textContent = money(t.vat);
    $('qe-t-total').textContent = $('qe-currency').value + ' ' + money(t.total);
    flagNumber($('qe-discount'));
    flagNumber($('qe-vat'));
  }
  function addLine(focus) {
    var last = lines[lines.length - 1];
    var line = blankLine();
    if (last) { line.unit = last.unit || 'm²'; line.start_date = last.start_date || ''; line.end_date = last.end_date || ''; }
    lines.push(line);
    renderLines();
    markDirty();
    if (focus) {
      var row = $('qe-lines').querySelector('tr[data-i="' + (lines.length - 1) + '"] [data-k="item"]');
      if (row) row.focus();
    }
  }

  $('qe-lines').addEventListener('input', function (e) {
    var el = e.target, tr = el.closest('tr[data-i]');
    if (!tr || !el.dataset.k) return;
    var l = lines[+tr.dataset.i];
    l[el.dataset.k] = el.value;
    if (el.tagName === 'TEXTAREA') grow(el);
    if (el.dataset.k === 'quantity' || el.dataset.k === 'unit_price') flagNumber(el);
    tr.querySelector('[data-total]').textContent = money(lineCents(l));
    renderTotals();
    markDirty();
  });
  $('qe-lines').addEventListener('change', function (e) {
    var el = e.target, tr = el.closest('tr[data-i]');
    if (!tr || !el.dataset.k) return;
    lines[+tr.dataset.i][el.dataset.k] = el.value;
    markDirty();
  });
  $('qe-lines').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-del]');
    if (!btn) return;
    var i = +btn.closest('tr[data-i]').dataset.i;
    if (!isBlank(lines[i]) && !confirm('Remove line ' + (i + 1) + '?')) return;
    lines.splice(i, 1);
    renderLines();
    markDirty();
  });
  $('qe-add').addEventListener('click', function () { addLine(true); });

  // ── form <-> data ─────────────────────────────────────────────────────────
  var FIELDS = {
    'qe-name': 'customer_name', 'qe-company': 'customer_company', 'qe-mobile': 'customer_mobile',
    'qe-email': 'customer_email', 'qe-city': 'site_city', 'qe-address': 'site_address',
    'qe-subject': 'scope', 'qe-notes': 'notes', 'qe-conditions': 'conditions',
  };
  function fillCustomer(c) {
    Object.keys(FIELDS).forEach(function (id) {
      var key = FIELDS[id];
      if (key in c && /^customer_|^site_/.test(key)) $(id).value = c[key] || '';
    });
  }
  function setCurrency(code) {
    var sel = $('qe-currency');
    code = code || 'USD';
    if (![].some.call(sel.options, function (o) { return o.value === code; })) sel.add(new Option(code, code));
    sel.value = code;
  }
  // A quotation drafted from the Log carries one estimate (area x weeks x rate
  // plus erection, transport, extras). Shown as lines so it can be edited here.
  function estimateLines(q) {
    var out = [];
    var area = parse(q.area_sqm), weeks = parse(q.duration_weeks), rate = parse(q.rate);
    if (clean(q.rate) && (clean(q.area_sqm) || clean(q.duration_weeks))) {
      var w = clean(q.duration_weeks) ? weeks : 1;
      out.push({
        item: 'Scaffolding hire',
        description: clean(q.duration_weeks) ? q.duration_weeks + ' weeks at ' + q.rate + ' per m² per week' : '',
        start_date: '', end_date: '', unit: 'm²', quantity: clean(q.area_sqm) || '1',
        unit_price: (Math.round(rate * w * 100) / 100).toFixed(2),
      });
    }
    [['erection', 'Erection'], ['transport', 'Transport'], ['extras', 'Extras']].forEach(function (pair) {
      if (parse(q[pair[0]]) > 0) {
        out.push({ item: pair[1], description: '', start_date: '', end_date: '', unit: 'lot', quantity: '1', unit_price: q[pair[0]] });
      }
    });
    return out;
  }
  function fill(q) {
    current = q;
    quoteId = q.id;
    Object.keys(FIELDS).forEach(function (id) { $(id).value = q[FIELDS[id]] || ''; });
    $('qe-valid').value = q.valid_until || '';
    $('qe-status').value = q.status || 'draft';
    $('qe-discount').value = q.discount && parse(q.discount) !== 0 ? q.discount : '';
    $('qe-vat').value = q.vat_percent || '';
    setCurrency(q.currency);
    $('qe-date').value = dmy(issueDate());
    $('qe-number').textContent = q.quotation_number;
    document.title = q.quotation_number + ' · Quotation · ARARA';
    $('qe-delete').hidden = false;
    var legacy = !(q.lines && q.lines.length) ? estimateLines(q) : [];
    lines = (q.lines || []).map(function (l) {
      return {
        item: l.item || '', description: l.description || '', start_date: l.start_date || '', end_date: l.end_date || '',
        unit: l.unit || 'm²', quantity: l.quantity || '', unit_price: l.unit_price || '',
      };
    });
    if (legacy.length) lines = legacy;
    $('qe-legacy').hidden = !legacy.length;
    renderLines();
    dirty = legacy.length > 0;
    setMsg(dirty ? 'Unsaved changes' : 'Saved', dirty ? 'dirty' : 'ok');
  }
  function fillNew() {
    var valid = new Date(); valid.setDate(valid.getDate() + 30);
    $('qe-valid').value = iso(valid);
    $('qe-date').value = dmy(issueDate());
    $('qe-vat').value = defaults.vat_percent || '';
    $('qe-conditions').value = defaults.conditions || '';
    setCurrency(defaults.currency);
    lines = [blankLine()];
    renderLines();
    dirty = false;
    setMsg('');
  }
  function payload() {
    var body = {};
    Object.keys(FIELDS).forEach(function (id) { body[FIELDS[id]] = $(id).value.trim(); });
    body.valid_until = $('qe-valid').value || null;
    body.status = $('qe-status').value;
    body.currency = $('qe-currency').value;
    body.discount = clean($('qe-discount').value) || null;
    body.vat_percent = clean($('qe-vat').value) || null;
    // The table is the price now; the Log's one-line estimate no longer applies.
    body.area_sqm = null; body.duration_weeks = null;
    body.rate = null; body.erection = null; body.transport = null; body.extras = null;
    body.lines = lines.filter(function (l) { return !isBlank(l); }).map(function (l) {
      return {
        item: String(l.item || '').trim(), description: String(l.description || '').trim(),
        start_date: l.start_date || null, end_date: l.end_date || null, unit: l.unit || 'm²',
        quantity: clean(l.quantity) || null, unit_price: clean(l.unit_price) || null,
      };
    });
    return body;
  }
  function invalidReason() {
    var bad = [];
    lines.forEach(function (l, i) {
      if (isNaN(parse(l.quantity)) || isNaN(parse(l.unit_price))) bad.push('line ' + (i + 1));
      if (l.start_date && l.end_date && l.end_date < l.start_date) bad.push('line ' + (i + 1) + ' dates');
    });
    if (isNaN(parse($('qe-discount').value))) bad.push('discount');
    if (isNaN(parse($('qe-vat').value))) bad.push('VAT %');
    return bad.length ? 'Check ' + bad.join(', ') + ': numbers only, and the “To” date on or after “From”.' : '';
  }

  // ── save / delete ─────────────────────────────────────────────────────────
  async function save() {
    if (busy) return false;
    var problem = invalidReason();
    if (problem) { showErr(problem); setMsg('Not saved', 'bad'); return false; }
    busy = true; showErr('');
    $('qe-save').disabled = true; setMsg('Saving…');
    try {
      var body = payload(), q;
      if (quoteId) {
        q = await api('/quotations/' + encodeURIComponent(quoteId), { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        if (fileId) body.file_id = fileId;
        q = await api('/quotations/', { method: 'POST', body: JSON.stringify(body) });
        history.replaceState(null, '', location.pathname + '?id=' + encodeURIComponent(q.id));
      }
      fill(q);
      setMsg('Saved', 'ok');
      return true;
    } catch (e) {
      showErr(e.message || 'Could not save the quotation');
      setMsg('Not saved', 'bad');
      return false;
    } finally {
      busy = false; $('qe-save').disabled = false;
    }
  }
  async function remove() {
    if (!quoteId || !confirm('Delete ' + (current ? current.quotation_number : 'this quotation') + '? This cannot be undone.')) return;
    try {
      await api('/quotations/' + encodeURIComponent(quoteId), { method: 'DELETE' });
      dirty = false;
      location.assign(API + '/quotations/ui');
    } catch (e) { showErr(e.message || 'Could not delete the quotation'); }
  }

  // ── printed document ──────────────────────────────────────────────────────
  function v(id) { return $(id).value.trim(); }
  function printHtml() {
    var t = totals(), cur = $('qe-currency').value;
    var number = current ? current.quotation_number : 'Draft';
    // Name first (bold), then the company if there is a name, then how to reach them.
    var who = v('qe-name') || v('qe-company') || '—';
    var reach = [v('qe-name') ? v('qe-company') : '', v('qe-mobile'), v('qe-email')].filter(Boolean).join('\n');
    var site = [v('qe-address'), v('qe-city')].filter(Boolean).join('\n');
    var rows = lines.filter(function (l) { return !isBlank(l); });
    var body = rows.map(function (l, i) {
      var unit = esc(l.unit || 'm²');
      return '<tr><td class="qp-n">' + (i + 1) + '</td>'
        + '<td class="qp-item">' + esc(l.item) + '</td>'
        + '<td class="qp-desc">' + esc(l.description) + '</td>'
        + '<td class="qp-dates">' + esc(period(l)) + '</td>'
        + '<td class="r">' + (qtyText(l.quantity) ? esc(qtyText(l.quantity)) + ' ' + unit : '') + '</td>'
        + '<td class="r">' + (clean(l.unit_price) ? money(cents(l.unit_price)) + ' / ' + unit : '') + '</td>'
        + '<td class="r"><b>' + money(lineCents(l)) + '</b></td></tr>';
    }).join('') || '<tr><td colspan="7" style="color:#5b6b85">No items.</td></tr>';
    var sums = '';
    if (t.discount) {
      sums += '<tr><td>Items total</td><td>' + money(t.items) + '</td></tr>'
        + '<tr><td>Discount</td><td>− ' + money(Math.min(t.discount, t.items)) + '</td></tr>';
    }
    sums += '<tr><td>Subtotal</td><td>' + money(t.sub) + '</td></tr>'
      + (t.vatPct ? '<tr><td>VAT ' + esc(String(t.vatPct)) + '%</td><td>' + money(t.vat) + '</td></tr>' : '')
      + '<tr class="qp-grand"><td>Total ' + esc(cur) + '</td><td>' + money(t.total) + '</td></tr>';
    var notes = v('qe-notes');
    var page1 = '<article class="qp-page">'
      + '<header class="qp-head"><div class="qp-brand"><b>ACHI SCAFFOLDING</b></div>'
      + '<div class="qp-title"><h1>QUOTATION</h1><table class="qp-meta">'
      + '<tr><th>No.</th><td>' + esc(number) + '</td></tr>'
      + '<tr><th>Date</th><td>' + esc(dmy(issueDate())) + '</td></tr>'
      + (v('qe-valid') ? '<tr><th>Valid until</th><td>' + esc(dmy(v('qe-valid'))) + '</td></tr>' : '')
      + '</table></div></header>'
      + '<section class="qp-parties"><div><h3>Prepared for</h3><p><b>' + esc(who) + '</b>'
      + (reach ? '\n' + esc(reach) : '') + '</p></div>'
      + (site ? '<div><h3>Site</h3><p>' + esc(site) + '</p></div>' : '<div></div>')
      + '</section>'
      + (v('qe-subject') ? '<p class="qp-subject"><b>Subject:</b> ' + esc(v('qe-subject')) + '</p>' : '')
      + '<table class="qp-lines"><thead><tr><th>#</th><th>Product / service</th><th>Description</th><th>Dates</th>'
      + '<th class="r">Qty</th><th class="r">Price</th><th class="r">Total (' + esc(cur) + ')</th></tr></thead><tbody>' + body + '</tbody></table>'
      + '<div class="qp-sum"><div class="qp-notes">' + (notes ? '<h3>Notes</h3>' + esc(notes) : '') + '</div>'
      + '<table class="qp-totals">' + sums + '</table></div>'
      + '</article>';
    var page2 = '<article class="qp-page">'
      + '<header class="qp-head2"><b>ACHI SCAFFOLDING</b><span>Quotation ' + esc(number) + ' · ' + esc(dmy(issueDate())) + '</span></header>'
      + '<h2>Terms &amp; Conditions</h2>'
      + '<div class="qp-cond">' + (esc(v('qe-conditions')) || '<span style="color:#5b6b85">No conditions.</span>') + '</div>'
      + '<section class="qp-sign">'
      + '<div><h3>Accepted by the client</h3><p>Name</p><p>Signature</p><p>Date</p></div>'
      + '<div><h3>For Achi Scaffolding</h3><p>Name</p><p>Signature</p><p>Date</p></div>'
      + '</section></article>';
    return page1 + page2;
  }
  function buildPrint() { $('qp-doc').innerHTML = printHtml(); }
  async function preview() {
    // The document needs its number, so a new or changed quotation is saved first.
    if ((dirty || !quoteId) && !(await save())) return;
    buildPrint();
    $('qp').hidden = false;
    $('qp-print').focus();
  }
  function closePreview() { $('qp').hidden = true; $('qe-preview').focus(); }

  // ── wiring ────────────────────────────────────────────────────────────────
  Object.keys(FIELDS).concat(['qe-valid', 'qe-status', 'qe-currency', 'qe-discount', 'qe-vat']).forEach(function (id) {
    $(id).addEventListener('input', function () { markDirty(); if (/discount|vat|currency/.test(id)) renderTotals(); });
    $(id).addEventListener('change', function () { markDirty(); if (/currency/.test(id)) renderTotals(); });
  });
  $('qe-save').addEventListener('click', save);
  $('qe-delete').addEventListener('click', remove);
  $('qe-preview').addEventListener('click', preview);
  $('qp-back').addEventListener('click', closePreview);
  $('qp-print').addEventListener('click', function () { buildPrint(); window.print(); });
  $('qe-std').addEventListener('click', function () {
    var box = $('qe-conditions');
    if (box.value.trim() && box.value.trim() !== defaults.conditions.trim()
        && !confirm('Replace the conditions below with the standard conditions?')) return;
    box.value = defaults.conditions || '';
    markDirty();
  });
  // Ctrl+P from the editor prints the document, not the form.
  window.addEventListener('beforeprint', buildPrint);
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if (e.key === 'Escape' && !$('qp').hidden) closePreview();
  });
  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  async function init() {
    if (!token()) { showErr('Not signed in on this address. Open the main app here, sign in, then reload.'); return; }
    try { defaults = Object.assign(defaults, await api('/quotations/defaults')); } catch (e) { /* the built-ins will do */ }
    if (quoteId) {
      try { fill(await api('/quotations/' + encodeURIComponent(quoteId))); }
      catch (e) { showErr(e.message || 'Could not open the quotation'); $('qe-save').disabled = true; $('qe-preview').disabled = true; }
      return;
    }
    fillNew();
    if (fileId) {
      try {
        fillCustomer(await api('/quotations/customer?file_id=' + encodeURIComponent(fileId)));
        $('qe-crumb').textContent = 'Quotation for an enquiry';
      } catch (e) { showErr(e.message || 'Could not load the enquiry'); }
    }
  }
  init();
})();
