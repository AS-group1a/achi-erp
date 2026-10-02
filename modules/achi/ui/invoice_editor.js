/* Invoice editor: write a draft, issue it (which posts it to the accounts),
 * record payments against it, void it, and print it.
 *
 *   ?id=<invoice>        opens one
 *   ?company=achi|arara  starts a blank draft for that company
 *
 * A draft is fully editable. Once issued the page is read-only: the books
 * already hold it, so a change means void + new invoice. Totals here are a
 * live preview; after every save the page shows the server's numbers.
 */
(function () {
  'use strict';

  var API = '/api/v1/achi';
  var ACC = API + '/accounting';
  var UNITS = ['m²', 'm', 'm³', 'pcs', 'hour', 'day', 'week', 'month', 'lot'];
  var METHODS = { bank_transfer: 'Bank transfer', cash: 'Cash', cheque: 'Cheque', card: 'Card', other: 'Other' };
  var STATUS_TEXT = { draft: 'Draft', unpaid: 'Unpaid', partly_paid: 'Partly paid', paid: 'Paid', overdue: 'Overdue', void: 'Void' };
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var invoiceId = params.get('id') || null;
  var company = params.get('company') || (window.araraCompany ? window.araraCompany() : 'achi');

  var current = null;            // the server's copy
  var lines = [];                // editor rows
  var accounts = [];             // the company's accounts
  var settings = null;           // accounting settings (base currency, VAT, terms)
  var letterhead = null;
  var canManage = false;
  var customers = [];
  var dirty = false, busy = false;

  function token() { return localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token'); }
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
    var res = await fetch(path, {
      method: opts.method || 'GET', body: opts.body,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
    });
    if (res.status === 401) throw new Error('Your session has expired. Sign in again in the main app, then reload this page.');
    if (!res.ok) {
      var msg = 'Something went wrong (HTTP ' + res.status + ')';
      try { msg = detailText((await res.json()).detail) || msg; } catch (e) { /* not JSON */ }
      var err = new Error(msg); err.status = res.status; throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  // ── numbers and dates ─────────────────────────────────────────────────────
  function clean(v) { return String(v == null ? '' : v).replace(/[,\s]/g, ''); }
  function parse(v, decimals) {
    var s = clean(v);
    if (s === '') return 0;
    var re = new RegExp('^\\d*\\.?\\d{0,' + (decimals == null ? 4 : decimals) + '}$');
    if (!re.test(s) || s === '.') return NaN;
    return parseFloat(s);
  }
  function cents(v) { var n = parse(v, 2); return isNaN(n) ? 0 : Math.round(n * 100); }
  function lineCents(l) { var q = parse(l.quantity, 4); return isNaN(q) ? 0 : Math.round(q * cents(l.unit_price)); }
  function money(minor) { return (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function moneyText(s) { return money(Math.round(parseFloat(s || 0) * 100)); }
  function qtyText(v) { var n = parse(v, 4); return !clean(v) || isNaN(n) ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 4 }); }
  function totals() {
    var items = lines.reduce(function (sum, l) { return sum + lineCents(l); }, 0);
    var discount = cents($('qe-discount').value);
    var sub = Math.max(0, items - discount);
    var pct = parse($('qe-vat').value, 2); pct = isNaN(pct) ? 0 : pct;
    var vat = Math.round(sub * pct / 100);
    return { items: items, discount: discount, sub: sub, pct: pct, vat: vat, total: sub + vat };
  }
  function iso(d) { var p = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function dmy(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function addDays(isoDay, n) { var d = new Date(isoDay + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); }
  function period(l) {
    if (l.start_date && l.end_date) return dmy(l.start_date) + ' – ' + dmy(l.end_date);
    if (l.start_date) return 'From ' + dmy(l.start_date);
    if (l.end_date) return 'Until ' + dmy(l.end_date);
    return '';
  }

  // ── messages ──────────────────────────────────────────────────────────────
  function showErr(text) { var e = $('qe-err'); e.textContent = text || ''; e.hidden = !text; }
  function setMsg(text, cls) { var m = $('qe-msg'); m.textContent = text || ''; m.className = 'qe-msg' + (cls ? ' ' + cls : ''); }
  function markDirty() { if (locked()) return; dirty = true; setMsg('Unsaved changes', 'dirty'); }
  function locked() { return !!current && current.status !== 'draft'; }

  // ── lines ─────────────────────────────────────────────────────────────────
  function incomeAccounts() { return accounts.filter(function (a) { return a.type === 'income' && a.active && a.role !== 'sales_discount'; }); }
  function blankLine() { return { item: '', description: '', start_date: '', end_date: '', unit: 'm²', quantity: '', unit_price: '', account_id: '' }; }
  function isBlank(l) {
    return !String(l.item || '').trim() && !String(l.description || '').trim() && !l.start_date && !l.end_date && !clean(l.quantity) && !clean(l.unit_price);
  }
  function unitOptions(unit) {
    var list = UNITS.indexOf(unit) >= 0 || !unit ? UNITS : UNITS.concat([unit]);
    return list.map(function (u) { return '<option' + (u === unit ? ' selected' : '') + '>' + esc(u) + '</option>'; }).join('');
  }
  function accountOptions(selected) {
    var dflt = accounts.filter(function (a) { return a.role === 'default_income'; })[0];
    return '<option value="">' + esc(dflt ? dflt.code + ' ' + dflt.name : 'Default income') + '</option>'
      + incomeAccounts().filter(function (a) { return !dflt || a.id !== dflt.id; }).map(function (a) {
        return '<option value="' + esc(a.id) + '"' + (a.id === selected ? ' selected' : '') + '>' + esc(a.code + ' ' + a.name) + '</option>';
      }).join('');
  }
  function rowHtml(l, i) {
    var n = i + 1;
    return '<tr data-i="' + i + '">'
      + '<td class="qe-n">' + n + '</td>'
      + '<td><input class="qe-in" data-k="item" value="' + esc(l.item) + '" list="qe-item-list" maxlength="255" placeholder="e.g. Scaffolding hire" aria-label="Line ' + n + ' product or service">'
      + '<select class="qe-in qe-acc" data-k="account_id" aria-label="Line ' + n + ' income account" style="font-size:11.5px;min-height:26px;padding:3px 4px;color:#5b6b85">' + accountOptions(l.account_id) + '</select></td>'
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
  function flag(el, decimals) { el.classList.toggle('bad', isNaN(parse(el.value, decimals))); }
  function renderLines() {
    var body = $('qe-lines');
    body.innerHTML = lines.length ? lines.map(rowHtml).join('')
      : '<tr class="qe-empty"><td colspan="10">No lines yet — add a product or service.</td></tr>';
    body.querySelectorAll('textarea').forEach(grow);
    body.querySelectorAll('[data-k="quantity"]').forEach(function (el) { flag(el, 4); });
    body.querySelectorAll('[data-k="unit_price"]').forEach(function (el) { flag(el, 2); });
    applyLock();
    renderTotals();
  }
  function renderTotals() {
    var t = totals(), cur = $('qe-currency').value;
    $('qe-t-items').textContent = money(t.items);
    $('qe-t-sub').textContent = money(t.sub);
    $('qe-t-vat').textContent = money(t.vat);
    $('qe-t-total').textContent = cur + ' ' + money(t.total);
    flag($('qe-discount'), 2); flag($('qe-vat'), 2);
    var issued = current && current.status === 'issued';
    $('qe-paid-row').hidden = !issued; $('qe-due-row').hidden = !issued;
    if (issued) {
      $('qe-t-paid').textContent = moneyText(current.paid);
      $('qe-t-due').textContent = cur + ' ' + moneyText(current.balance);
    }
  }
  function addLine(focus) {
    var last = lines[lines.length - 1], line = blankLine();
    if (last) { line.unit = last.unit || 'm²'; line.start_date = last.start_date || ''; line.end_date = last.end_date || ''; }
    lines.push(line); renderLines(); markDirty();
    if (focus) { var el = $('qe-lines').querySelector('tr[data-i="' + (lines.length - 1) + '"] [data-k="item"]'); if (el) el.focus(); }
  }
  $('qe-lines').addEventListener('input', function (e) {
    var el = e.target, tr = el.closest('tr[data-i]');
    if (!tr || !el.dataset.k || locked()) return;
    var l = lines[+tr.dataset.i];
    l[el.dataset.k] = el.value;
    if (el.tagName === 'TEXTAREA') grow(el);
    if (el.dataset.k === 'quantity') flag(el, 4);
    if (el.dataset.k === 'unit_price') flag(el, 2);
    tr.querySelector('[data-total]').textContent = money(lineCents(l));
    renderTotals(); markDirty();
  });
  $('qe-lines').addEventListener('change', function (e) {
    var el = e.target, tr = el.closest('tr[data-i]');
    if (!tr || !el.dataset.k || locked()) return;
    lines[+tr.dataset.i][el.dataset.k] = el.value; markDirty();
  });
  $('qe-lines').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-del]');
    if (!btn || locked()) return;
    var i = +btn.closest('tr[data-i]').dataset.i;
    if (!isBlank(lines[i]) && !confirm('Remove line ' + (i + 1) + '?')) return;
    lines.splice(i, 1); renderLines(); markDirty();
  });
  $('qe-add').addEventListener('click', function () { addLine(true); });

  // ── form <-> data ─────────────────────────────────────────────────────────
  var FIELDS = {
    'qe-name': 'customer_name', 'qe-company': 'customer_company', 'qe-mobile': 'customer_mobile',
    'qe-email': 'customer_email', 'qe-address': 'customer_address', 'qe-taxno': 'customer_tax_number',
    'qe-subject': 'subject', 'qe-notes': 'notes', 'qe-terms': 'terms',
  };
  function base() { return settings ? settings.base_currency : 'USD'; }
  function setCurrency(code) {
    var sel = $('qe-currency');
    if (![].some.call(sel.options, function (o) { return o.value === code; })) sel.add(new Option(code, code));
    sel.value = code || base();
    showRate();
  }
  function showRate() {
    var cur = $('qe-currency').value, foreign = cur !== base();
    $('qe-rate-wrap').hidden = !foreign;
    $('qe-base').textContent = base(); $('qe-rate-cur').textContent = cur;
  }
  function applyLock() {
    var isLocked = locked();
    $('qe-wrap').classList.toggle('is-locked', isLocked);
    document.querySelectorAll('#qe-wrap input, #qe-wrap select, #qe-wrap textarea').forEach(function (el) { el.disabled = isLocked; });
  }
  function fill(inv) {
    current = inv; invoiceId = inv.id; company = inv.company;
    Object.keys(FIELDS).forEach(function (id) { $(id).value = inv[FIELDS[id]] || ''; });
    $('qe-date').value = inv.issue_date || '';
    $('qe-due').value = inv.due_date || '';
    $('qe-discount').value = parseFloat(inv.discount) ? inv.discount : '';
    $('qe-vat').value = inv.vat_percent && inv.vat_percent !== '0' ? inv.vat_percent : '';
    setCurrency(inv.currency);
    $('qe-rate').value = inv.fx_rate && inv.fx_rate !== '1' ? inv.fx_rate : '';
    lines = (inv.lines || []).map(function (l) {
      return { item: l.item || '', description: l.description || '', start_date: l.start_date || '', end_date: l.end_date || '',
        unit: l.unit || 'm²', quantity: l.quantity || '', unit_price: l.unit_price || '', account_id: l.account_id || '' };
    });
    if (!lines.length && inv.status === 'draft') lines = [blankLine()];
    $('qe-number').textContent = inv.code;
    document.title = inv.code + ' · Invoice · ARARA';
    var pill = $('qe-pill'); pill.hidden = false; pill.className = 'qe-pill ' + inv.payment_status; pill.textContent = STATUS_TEXT[inv.payment_status] || inv.payment_status;
    $('qe-crumb').textContent = 'Invoice · ' + (settings ? settings.company_name : company);
    $('qe-locked').hidden = inv.status === 'draft';
    if (inv.status === 'void') $('qe-locked').textContent = 'This invoice is void. A reversing entry cancelled it in the accounts.';
    var links = [];
    if (inv.quotation_id) links.push('<a href="' + API + '/quotations/edit?id=' + encodeURIComponent(inv.quotation_id) + '">From quotation ' + esc(inv.quotation_code || '') + '</a>');
    $('qe-links').innerHTML = links.length ? links.join('') : ''; $('qe-links').hidden = !links.length;
    renderPayments();
    renderLines();
    refreshButtons();
    dirty = false; setMsg('');
  }
  function fillNew() {
    var today = iso(new Date());
    $('qe-date').value = today;
    $('qe-due').value = addDays(today, settings ? settings.invoice_due_days : 30);
    $('qe-vat').value = settings ? settings.default_vat_percent : '';
    $('qe-terms').value = settings ? settings.invoice_terms : '';
    setCurrency(base());
    lines = [blankLine()];
    $('qe-crumb').textContent = 'New invoice · ' + (settings ? settings.company_name : company);
    renderLines(); refreshButtons();
  }
  function refreshButtons() {
    var st = current ? current.status : 'draft', ps = current ? current.payment_status : 'draft';
    $('qe-save').hidden = st !== 'draft';
    $('qe-issue').hidden = st !== 'draft';
    $('qe-delete').hidden = !current || st !== 'draft';
    $('qe-pay').hidden = st !== 'issued' || ps === 'paid';
    $('qe-void').hidden = st !== 'issued' || !canManage;
    $('qe-back').href = ACC + '/ui?company=' + encodeURIComponent(company) + '#invoices';
  }
  function renderPayments() {
    var pays = (current && current.payments) || [];
    $('qe-payments').hidden = !current || current.status === 'draft';
    $('qe-pay-rows').innerHTML = pays.length ? pays.map(function (p) {
      return '<tr><td>' + esc(dmy(p.date)) + '</td><td><b>' + esc(p.receipt_code) + '</b></td><td>' + esc(METHODS[p.method] || p.method)
        + (p.reference ? ' · ' + esc(p.reference) : '') + '</td><td class="r">' + esc(current.currency) + ' ' + moneyText(p.amount) + '</td></tr>';
    }).join('') : '<tr><td class="none" colspan="4">No payments yet.</td></tr>';
  }
  function payload() {
    var body = { company: company };
    Object.keys(FIELDS).forEach(function (id) { body[FIELDS[id]] = $(id).value.trim(); });
    body.issue_date = $('qe-date').value;
    body.due_date = $('qe-due').value || null;
    body.currency = $('qe-currency').value;
    body.fx_rate = body.currency === base() ? '1' : (clean($('qe-rate').value) || '1');
    body.discount = clean($('qe-discount').value) || null;
    body.vat_percent = clean($('qe-vat').value) || null;
    var match = customers.filter(function (c) { return (c.customer_company || c.customer_name) === (body.customer_company || body.customer_name); })[0];
    body.contact_id = (current && current.contact_id) || (match && match.contact_id) || null;
    body.lines = lines.filter(function (l) { return !isBlank(l); }).map(function (l) {
      return { item: String(l.item || '').trim(), description: String(l.description || '').trim(), start_date: l.start_date || null,
        end_date: l.end_date || null, unit: l.unit || 'm²', quantity: clean(l.quantity) || null, unit_price: clean(l.unit_price) || null,
        account_id: l.account_id || null };
    });
    return body;
  }
  function problems() {
    var bad = [];
    lines.forEach(function (l, i) {
      if (isNaN(parse(l.quantity, 4)) || isNaN(parse(l.unit_price, 2))) bad.push('line ' + (i + 1) + ' numbers');
      if (l.start_date && l.end_date && l.end_date < l.start_date) bad.push('line ' + (i + 1) + ' dates');
    });
    if (isNaN(parse($('qe-discount').value, 2))) bad.push('discount');
    if (isNaN(parse($('qe-vat').value, 2))) bad.push('VAT %');
    if (!$('qe-date').value) bad.push('invoice date');
    if ($('qe-due').value && $('qe-due').value < $('qe-date').value) bad.push('due date (before the invoice date)');
    return bad.length ? 'Check ' + bad.join(', ') + '.' : '';
  }

  // ── actions ───────────────────────────────────────────────────────────────
  async function save() {
    if (busy || locked()) return !!current;
    var p = problems();
    if (p) { showErr(p); setMsg('Not saved', 'bad'); return false; }
    busy = true; showErr(''); setMsg('Saving…');
    try {
      var body = payload(), inv;
      if (invoiceId) inv = await api(ACC + '/invoices/' + encodeURIComponent(invoiceId), { method: 'PUT', body: JSON.stringify(body) });
      else {
        inv = await api(ACC + '/invoices', { method: 'POST', body: JSON.stringify(body) });
        history.replaceState(null, '', location.pathname + '?id=' + encodeURIComponent(inv.id));
      }
      fill(inv); setMsg('Saved', 'ok');
      return true;
    } catch (e) { showErr(e.message); setMsg('Not saved', 'bad'); return false; }
    finally { busy = false; }
  }
  async function issue() {
    if (!(await save())) return;
    if (!confirm('Issue ' + current.code + ' for ' + $('qe-currency').value + ' ' + money(totals().total) + '?\n\nIt will be posted to the accounts and can no longer be edited.')) return;
    busy = true; setMsg('Issuing…');
    try { fill(await api(ACC + '/invoices/' + encodeURIComponent(invoiceId) + '/issue', { method: 'POST' })); setMsg('Issued and posted', 'ok'); }
    catch (e) { showErr(e.message); setMsg('Not issued', 'bad'); }
    finally { busy = false; }
  }
  async function removeDraft() {
    if (!current || !confirm('Delete draft ' + current.code + '? This cannot be undone.')) return;
    try { await api(ACC + '/invoices/' + encodeURIComponent(invoiceId), { method: 'DELETE' }); dirty = false; location.assign($('qe-back').href); }
    catch (e) { showErr(e.message); }
  }

  // Record payment
  function bankAccounts() { return accounts.filter(function (a) { return a.is_bank && a.active; }); }
  function openPay() {
    $('pay-err').hidden = true;
    $('pay-date').value = iso(new Date());
    $('pay-amount').value = current.balance;
    var banks = bankAccounts();
    var preferred = banks.filter(function (a) { return /bank/i.test(a.name); })[0] || banks[0];
    $('pay-account').innerHTML = banks.map(function (a) { return '<option value="' + esc(a.id) + '"' + (preferred && a.id === preferred.id ? ' selected' : '') + '>' + esc(a.code + ' ' + a.name) + '</option>'; }).join('');
    var foreign = current.currency !== base();
    $('pay-rate-wrap').hidden = !foreign; $('pay-base').textContent = base(); $('pay-cur').textContent = current.currency;
    $('pay-rate').value = foreign ? current.fx_rate : '';
    $('pay-title').textContent = 'Record a payment for ' + current.code;
    $('pay-dialog').showModal();
    $('pay-amount').select();
  }
  $('pay-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('pay-err'); err.hidden = true;
    var amount = clean($('pay-amount').value);
    if (!amount || isNaN(parse(amount, 2)) || !parseFloat(amount)) { err.textContent = 'Enter the amount received.'; err.hidden = false; return; }
    $('pay-save').disabled = true;
    try {
      await api(ACC + '/receipts', { method: 'POST', body: JSON.stringify({
        company: company, receipt_date: $('pay-date').value, customer_name: current.customer_name, customer_company: current.customer_company,
        contact_id: current.contact_id, method: $('pay-method').value, reference: $('pay-ref').value.trim(),
        deposit_account_id: $('pay-account').value, currency: current.currency,
        fx_rate: current.currency === base() ? '1' : (clean($('pay-rate').value) || '1'), amount: amount,
        allocations: [{ invoice_id: current.id, amount: String(Math.min(parseFloat(amount), parseFloat(current.balance)).toFixed(2)) }],
      }) });
      var extra = parseFloat(amount) - parseFloat(current.balance);
      $('pay-dialog').close();
      fill(await api(ACC + '/invoices/' + encodeURIComponent(invoiceId)));
      setMsg(extra > 0 ? 'Payment saved · ' + money(Math.round(extra * 100)) + ' kept as a customer deposit' : 'Payment saved', 'ok');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    finally { $('pay-save').disabled = false; }
  });

  // Void
  function openVoid() { $('void-err').hidden = true; $('void-date').value = iso(new Date()); $('void-reason').value = ''; $('void-dialog').showModal(); }
  $('void-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    $('void-save').disabled = true;
    try {
      fill(await api(ACC + '/invoices/' + encodeURIComponent(invoiceId) + '/void', { method: 'POST',
        body: JSON.stringify({ void_date: $('void-date').value || null, reason: $('void-reason').value.trim() }) }));
      $('void-dialog').close(); setMsg('Voided', 'ok');
    } catch (ex) { $('void-err').textContent = ex.message; $('void-err').hidden = false; }
    finally { $('void-save').disabled = false; }
  });
  document.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });

  // ── printed invoice ───────────────────────────────────────────────────────
  function v(id) { return $(id).value.trim(); }
  function printHtml() {
    var t = totals(), cur = $('qe-currency').value;
    var number = current ? current.code : 'DRAFT';
    var lh = letterhead || { legal_name: settings ? settings.company_name : '' };
    var brandSub = [lh.address, [lh.phone, lh.email].filter(Boolean).join(' · '), lh.tax_number ? 'VAT no. ' + lh.tax_number : ''].filter(Boolean).join('\n');
    var who = v('qe-name') || v('qe-company') || '—';
    var reach = [v('qe-name') ? v('qe-company') : '', v('qe-address'), v('qe-mobile'), v('qe-email'), v('qe-taxno') ? 'VAT no. ' + v('qe-taxno') : ''].filter(Boolean).join('\n');
    var rows = lines.filter(function (l) { return !isBlank(l); });
    var body = rows.map(function (l, i) {
      var unit = esc(l.unit || 'm²');
      return '<tr><td class="qp-n">' + (i + 1) + '</td><td class="qp-item">' + esc(l.item) + '</td><td class="qp-desc">' + esc(l.description) + '</td>'
        + '<td class="qp-dates">' + esc(period(l)) + '</td>'
        + '<td class="r">' + (qtyText(l.quantity) ? esc(qtyText(l.quantity)) + ' ' + unit : '') + '</td>'
        + '<td class="r">' + (clean(l.unit_price) ? money(cents(l.unit_price)) + ' / ' + unit : '') + '</td>'
        + '<td class="r"><b>' + money(lineCents(l)) + '</b></td></tr>';
    }).join('') || '<tr><td colspan="7" style="color:#5b6b85">No items.</td></tr>';
    var sums = '';
    if (t.discount) sums += '<tr><td>Items total</td><td>' + money(t.items) + '</td></tr><tr><td>Discount</td><td>− ' + money(Math.min(t.discount, t.items)) + '</td></tr>';
    sums += '<tr><td>Subtotal</td><td>' + money(t.sub) + '</td></tr>'
      + (t.pct ? '<tr><td>VAT ' + esc(String(t.pct)) + '%</td><td>' + money(t.vat) + '</td></tr>' : '')
      + '<tr class="qp-grand"><td>Total ' + esc(cur) + '</td><td>' + money(t.total) + '</td></tr>';
    if (current && current.status === 'issued' && parseFloat(current.paid)) {
      sums += '<tr class="qp-paid"><td>Paid</td><td>− ' + moneyText(current.paid) + '</td></tr>'
        + '<tr class="qp-due"><td>Balance due ' + esc(cur) + '</td><td>' + moneyText(current.balance) + '</td></tr>';
    }
    var stamp = !current ? '' : current.status === 'void' ? '<span class="qp-stamp void">VOID</span>'
      : current.payment_status === 'paid' ? '<span class="qp-stamp">PAID</span>' : '';
    var rate = cur !== base() && clean($('qe-rate').value) ? '<p class="qp-notes" style="margin:8px 0 0">Exchange rate: 1 ' + esc(base()) + ' = ' + esc(clean($('qe-rate').value)) + ' ' + esc(cur) + '</p>' : '';
    return '<article class="qp-page">'
      + '<header class="qp-head"><div class="qp-brand"><b>' + esc((lh.legal_name || '').toUpperCase()) + '</b>' + (brandSub ? '<small>' + esc(brandSub) + '</small>' : '') + '</div>'
      + '<div class="qp-title"><h1>' + (current && current.status === 'draft' ? 'DRAFT INVOICE' : 'INVOICE') + '</h1><table class="qp-meta">'
      + '<tr><th>No.</th><td>' + esc(number) + '</td></tr>'
      + '<tr><th>Date</th><td>' + esc(dmy(v('qe-date'))) + '</td></tr>'
      + (v('qe-due') ? '<tr><th>Due date</th><td>' + esc(dmy(v('qe-due'))) + '</td></tr>' : '')
      + (current && current.quotation_code ? '<tr><th>Quotation</th><td>' + esc(current.quotation_code) + '</td></tr>' : '')
      + '</table>' + stamp + '</div></header>'
      + '<section class="qp-parties"><div><h3>Bill to</h3><p><b>' + esc(who) + '</b>' + (reach ? '\n' + esc(reach) : '') + '</p></div><div></div></section>'
      + (v('qe-subject') ? '<p class="qp-subject"><b>Subject:</b> ' + esc(v('qe-subject')) + '</p>' : '')
      + '<table class="qp-lines"><thead><tr><th>#</th><th>Product / service</th><th>Description</th><th>Dates</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Total (' + esc(cur) + ')</th></tr></thead><tbody>' + body + '</tbody></table>'
      + '<div class="qp-sum"><div class="qp-notes">' + (v('qe-notes') ? '<h3>Notes</h3>' + esc(v('qe-notes')) : '') + rate + '</div><table class="qp-totals">' + sums + '</table></div>'
      + (lh.bank_details ? '<div class="qp-bank"><b>Payment details</b>' + esc(lh.bank_details) + '</div>' : '')
      + (v('qe-terms') ? '<div class="qp-notes" style="margin-top:12px"><h3>Payment terms</h3>' + esc(v('qe-terms')) + '</div>' : '')
      + '</article>';
  }
  function buildPrint() { $('qp-doc').innerHTML = printHtml(); }
  async function preview() {
    if (!locked() && (dirty || !invoiceId) && !(await save())) return;
    buildPrint(); $('qp').hidden = false; $('qp-print').focus();
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  Object.keys(FIELDS).concat(['qe-date', 'qe-due', 'qe-currency', 'qe-rate', 'qe-discount', 'qe-vat']).forEach(function (id) {
    $(id).addEventListener('input', function () { markDirty(); if (/discount|vat|currency/.test(id)) renderTotals(); });
    $(id).addEventListener('change', function () { markDirty(); if (id === 'qe-currency') { showRate(); renderTotals(); } });
  });
  // Picking a known customer from the suggestions fills the rest of the block.
  // Only a pick does it (the browser reports no typing for it): filling other
  // boxes while someone is still typing would put text where they are about to type.
  ['qe-name', 'qe-company'].forEach(function (id) {
    $(id).addEventListener('input', function (e) {
      if (e.inputType && e.inputType !== 'insertReplacementText') return;
      var val = $(id).value.trim(), key = id === 'qe-name' ? 'customer_name' : 'customer_company';
      var c = customers.filter(function (x) { return x[key] === val; })[0];
      if (!c) return;
      [['qe-name', 'customer_name'], ['qe-company', 'customer_company'], ['qe-mobile', 'customer_mobile'], ['qe-email', 'customer_email'],
        ['qe-address', 'customer_address'], ['qe-taxno', 'customer_tax_number']].forEach(function (pair) {
        if (!$(pair[0]).value.trim() && c[pair[1]]) $(pair[0]).value = c[pair[1]];
      });
    });
  });
  $('qe-date').addEventListener('change', function () {
    if (!current && settings && $('qe-date').value) $('qe-due').value = addDays($('qe-date').value, settings.invoice_due_days);
  });
  $('qe-save').addEventListener('click', save);
  $('qe-issue').addEventListener('click', issue);
  $('qe-delete').addEventListener('click', removeDraft);
  $('qe-pay').addEventListener('click', openPay);
  $('qe-void').addEventListener('click', openVoid);
  $('qe-preview').addEventListener('click', preview);
  $('qp-back').addEventListener('click', function () { $('qp').hidden = true; });
  $('qp-print').addEventListener('click', function () { buildPrint(); window.print(); });
  window.addEventListener('beforeprint', buildPrint);
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if (e.key === 'Escape' && !$('qp').hidden) $('qp').hidden = true;
  });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  async function loadCompany() {
    var q = '?company=' + encodeURIComponent(company);
    var me = await api(ACC + '/me' + q);
    canManage = !!me.can_manage;
    var got = await Promise.all([api(ACC + '/settings' + q), api(ACC + '/accounts' + q), api(ACC + '/letterhead' + q),
      api(ACC + '/customers' + q).catch(function () { return []; })]);
    settings = got[0]; accounts = got[1]; letterhead = got[2]; customers = got[3];
    $('qe-customers').innerHTML = customers.map(function (c) {
      return (c.customer_company ? '<option value="' + esc(c.customer_company) + '">' : '') + (c.customer_name ? '<option value="' + esc(c.customer_name) + '">' : '');
    }).join('');
  }
  async function init() {
    if (!token()) { showErr('Not signed in on this address. Open the main app here, sign in, then reload.'); return; }
    try {
      if (invoiceId) {
        var inv = await api(ACC + '/invoices/' + encodeURIComponent(invoiceId));
        company = inv.company;
        await loadCompany();
        fill(inv);
      } else {
        await loadCompany();
        fillNew();
      }
    } catch (e) {
      showErr(e.message || 'Could not open the invoice');
      ['qe-save', 'qe-issue', 'qe-preview'].forEach(function (id) { $(id).disabled = true; });
    }
  }
  init();
})();
