/* Accounting workspace: overview, invoices, payments, expenses, journal,
 * chart of accounts, reports and settings — for the company picked in the
 * sidebar (window.araraCompany). The server does every calculation that is
 * stored; this page only shows it and sends what people type.
 */
(function () {
  'use strict';

  var ACC = '/api/v1/achi/accounting';
  var $ = function (id) { return document.getElementById(id); };
  var METHODS = { bank_transfer: 'Bank transfer', cash: 'Cash', cheque: 'Cheque', card: 'Card', other: 'Other' };
  var STATUS = { draft: 'Draft', unpaid: 'Unpaid', partly_paid: 'Partly paid', paid: 'Paid', overdue: 'Overdue', void: 'Void', posted: 'Posted' };
  var TYPES = { asset: 'Asset', liability: 'Liability', equity: 'Equity', income: 'Income', expense: 'Expense' };
  var SOURCES = { manual: 'Journal', invoice: 'Invoice', receipt: 'Receipt', allocation: 'Payment applied', expense: 'Expense' };
  var CURRENCIES = ['USD', 'EUR', 'LBP'];
  var params = new URLSearchParams(location.search);
  var company = params.get('company') || (window.araraCompany ? window.araraCompany() : 'achi');

  var me = null, settings = null, accounts = [];
  var view = 'overview';
  var state = {                      // per-view filters, kept while switching views
    invoices: { tab: '', q: '' }, payments: { q: '' }, expenses: { q: '', account: '' }, journal: { q: '', type: '' },
    from: firstOfYear(), to: todayIso(), asOf: todayIso(), glAccount: '',
  };

  // ── helpers ───────────────────────────────────────────────────────────────
  function token() { return localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function detailText(d) {
    if (!d) return '';
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return d.map(function (e) { return String(e.msg || '').replace(/^Value error, /, ''); }).join(' · ');
    return JSON.stringify(d);
  }
  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(ACC + path, { method: opts.method || 'GET', body: opts.body,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() } });
    if (res.status === 401) throw new Error('Your session has expired. Sign in again, then reload this page.');
    if (!res.ok) {
      var msg = 'Something went wrong (HTTP ' + res.status + ')';
      try { msg = detailText((await res.json()).detail) || msg; } catch (e) { /* not JSON */ }
      var err = new Error(msg); err.status = res.status; throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  function q(obj) {
    var p = new URLSearchParams({ company: company });
    Object.keys(obj || {}).forEach(function (k) { if (obj[k] != null && obj[k] !== '') p.set(k, obj[k]); });
    return '?' + p.toString();
  }
  function todayIso() { var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function firstOfYear() { return new Date().getFullYear() + '-01-01'; }
  function dmy(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function num(s) { var n = parseFloat(s); return isNaN(n) ? 0 : n; }
  function fmt(s) {
    var n = num(s);
    var t = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n < 0 ? '−' + t : t;
  }
  function money(s, cls) { return '<span class="' + (num(s) < 0 ? 'ac-neg ' : '') + (cls || '') + '">' + fmt(s) + '</span>'; }
  function cur() { return settings ? settings.base_currency : 'USD'; }
  function clean(v) { return String(v == null ? '' : v).replace(/[,\s]/g, ''); }
  function showMsg(text) { var m = $('ac-msg'); m.textContent = text || ''; m.hidden = !text; }
  function setToolbar(html) { $('ac-toolbar').innerHTML = html; }
  function setView(html) { $('ac-view').innerHTML = html; }
  function pill(st) { return '<span class="ac-pill ' + esc(st) + '">' + esc(STATUS[st] || st) + '</span>'; }
  function accName(id) { var a = accounts.filter(function (x) { return x.id === id; })[0]; return a ? a.code + ' ' + a.name : ''; }
  function accOptions(filter, selected, blank) {
    return (blank ? '<option value="">' + esc(blank) + '</option>' : '') + accounts.filter(filter).map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (a.id === selected ? ' selected' : '') + '>' + esc(a.code + ' ' + a.name) + '</option>';
    }).join('');
  }
  function banks() { return accounts.filter(function (a) { return a.is_bank && a.active; }); }
  function dateRange(label) {
    return '<div class="pj-filters ac-filters"><label>' + (label || 'From') + ' <input type="date" id="f-from" value="' + esc(state.from) + '"></label>'
      + '<label>To <input type="date" id="f-to" value="' + esc(state.to) + '"></label></div>';
  }
  function bindRange(reload) {
    $('f-from').addEventListener('change', function () { state.from = this.value; reload(); });
    $('f-to').addEventListener('change', function () { state.to = this.value; reload(); });
  }
  function asOfPicker() {
    return '<div class="pj-filters ac-filters"><label>As of <input type="date" id="f-asof" value="' + esc(state.asOf) + '"></label></div>';
  }
  function bindAsOf(reload) { $('f-asof').addEventListener('change', function () { state.asOf = this.value; reload(); }); }
  function printBtn() { return '<button class="pj-btn" type="button" onclick="window.print()">Print</button>'; }
  function loading() { setView('<div class="pj-empty">Loading…</div>'); }
  function invoiceUrl(id) { return ACC + '/invoice?id=' + encodeURIComponent(id); }

  // ── one dialog for every form ─────────────────────────────────────────────
  var dialogSubmit = null;
  function openDialog(opts) {
    $('ac-dialog-crumb').textContent = opts.crumb || '';
    $('ac-dialog-title').textContent = opts.title;
    $('ac-dialog-body').innerHTML = opts.body;
    $('ac-dialog-ok').textContent = opts.ok || 'Save';
    $('ac-dialog-ok').className = opts.danger ? 'pj-danger' : 'pj-primary';
    $('ac-dialog-error').hidden = true;
    dialogSubmit = opts.submit;
    $('ac-dialog').showModal();
    if (opts.ready) opts.ready();
  }
  function dialogError(text) { var e = $('ac-dialog-error'); e.textContent = text; e.hidden = !text; }
  $('ac-dialog-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!dialogSubmit) return;
    var ok = $('ac-dialog-ok'); ok.disabled = true; dialogError('');
    try { await dialogSubmit(); $('ac-dialog').close(); }
    catch (ex) { dialogError(ex.message); }
    finally { ok.disabled = false; }
  });
  document.querySelectorAll('#ac-dialog [data-close]').forEach(function (b) { b.addEventListener('click', function () { $('ac-dialog').close(); }); });

  function voidDialog(kind, label, path, after) {
    openDialog({
      crumb: label, title: 'Void this ' + kind + '?', ok: 'Void ' + kind, danger: true,
      body: '<p class="ac-note pj-full">A reversing entry is posted, so the books keep both the original and its cancellation. The number stays, marked void.</p>'
        + '<label class="pj-field">Void date<input type="date" id="d-void-date" value="' + todayIso() + '" required></label>'
        + '<label class="pj-field pj-full">Reason<input id="d-void-reason" maxlength="1000" placeholder="e.g. entered twice"></label>',
      submit: async function () {
        await api(path, { method: 'POST', body: JSON.stringify({ void_date: $('d-void-date').value || null, reason: $('d-void-reason').value.trim() }) });
        after();
      },
    });
  }

  // ── overview ──────────────────────────────────────────────────────────────
  async function viewOverview() {
    setToolbar('<h2 class="ac-h">Overview</h2><div class="pj-actions">'
      + '<a class="pj-btn" style="display:inline-flex;align-items:center;text-decoration:none" href="' + ACC + '/invoice?company=' + esc(company) + '">+ Invoice</a>'
      + '<button class="pj-btn" type="button" id="o-pay">+ Payment received</button>'
      + '<button class="pj-primary" type="button" id="o-exp">+ Expense</button></div>');
    $('o-pay').onclick = function () { receiptDialog(); };
    $('o-exp').onclick = function () { expenseDialog(); };
    loading();
    var o = await api('/reports/overview' + q());
    var c = o.currency;
    $('ac-n-overdue').hidden = !o.overdue_count; $('ac-n-overdue').textContent = o.overdue_count;
    var tiles = ''
      + tile('Cash and bank', c + ' ' + fmt(o.cash_total), o.banks.map(function (b) { return b.name + ' ' + fmt(b.balance); }).join(' · '))
      + tile('To collect', c + ' ' + fmt(o.receivable), o.open_count + ' unpaid invoice' + (o.open_count === 1 ? '' : 's'), '#ar', 'Customer balances')
      + (o.overdue_count
        ? '<div class="ac-tile alert"><span>Overdue</span><b>' + esc(c + ' ' + fmt(o.overdue_total)) + '</b><small>⚠ ' + o.overdue_count + ' invoice' + (o.overdue_count === 1 ? '' : 's') + ' past due</small><button type="button" data-go="invoices" data-tab="overdue">Show them</button></div>'
        : tile('Overdue', c + ' 0.00', 'Nothing past due'))
      + tile('This month', c + ' ' + fmt(o.month_profit), 'Income ' + fmt(o.month_income) + ' · costs ' + fmt(o.month_expenses), '#pl', 'Profit & loss')
      + tile('VAT to pay', c + ' ' + fmt(o.vat_due), 'Output VAT less input VAT', '#vat', 'VAT report')
      + tile('Customer deposits', c + ' ' + fmt(o.customer_deposits), 'Paid in advance, not yet invoiced');
    var unpaid = o.unpaid.length ? '<table class="pj-table"><tbody>' + o.unpaid.map(function (i) {
      return '<tr class="row" data-href="' + esc(invoiceUrl(i.id)) + '"><td class="ac-code">' + esc(i.code) + '</td><td>' + esc(i.customer || '—') + '</td>'
        + '<td>' + (i.overdue ? '<span class="ac-pill overdue">Due ' + esc(dmy(i.due_date)) + '</span>' : '<span class="ac-muted">Due ' + esc(dmy(i.due_date)) + '</span>') + '</td>'
        + '<td class="ac-num">' + esc(i.currency) + ' ' + fmt(i.balance) + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="ac-empty">No unpaid invoices.</p>';
    var recent = o.recent.length ? '<table class="pj-table"><tbody>' + o.recent.map(function (e) {
      return '<tr><td class="ac-muted">' + esc(dmy(e.entry_date)) + '</td><td>' + esc(e.memo) + '</td><td class="ac-num">' + fmt(e.total) + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="ac-empty">Nothing posted yet. Issue an invoice, record a payment or an expense to begin.</p>';
    setView('<div class="ac-overview"><div class="ac-tiles">' + tiles + '</div>'
      + '<div class="ac-grid2"><div class="ac-card"><h3>Income and costs, last 6 months</h3><div class="ac-chart" id="ac-chart"></div></div>'
      + '<div class="ac-card"><h3>Unpaid invoices <button class="ac-link" type="button" data-go="invoices" data-tab="unpaid">All</button></h3>' + unpaid + '</div></div>'
      + '<div class="ac-card"><h3>Latest postings <button class="ac-link" type="button" data-go="journal">Journal</button></h3>' + recent + '</div></div>');
    drawChart($('ac-chart'), o.series, c);
  }
  function tile(label, value, sub, href, link) {
    return '<div class="ac-tile"><span>' + esc(label) + '</span><b>' + esc(value) + '</b><small>' + esc(sub || '') + '</small>'
      + (href ? '<button type="button" data-hash="' + esc(href) + '">' + esc(link) + ' →</button>' : '') + '</div>';
  }

  // Grouped bars on one axis: income (ARARA navy) and costs (orange). Colours
  // validated for colour-blind separation and contrast; identity is also in
  // the legend and the tooltip, and the numbers are in the table below.
  var SERIES = [{ key: 'income', label: 'Income', color: '#284F9E' }, { key: 'expenses', label: 'Costs', color: '#eb6834' }];
  function drawChart(el, series, c) {
    var W = 560, H = 200, L = 52, R = 8, T = 10, B = 26;
    var max = Math.max.apply(null, series.map(function (s) { return Math.max(num(s.income), num(s.expenses)); }).concat([1]));
    var step = niceStep(max / 4), top = Math.ceil(max / step) * step;
    var y = function (v) { return T + (H - T - B) * (1 - v / top); };
    var groupW = (W - L - R) / series.length, barW = Math.min(22, (groupW - 14) / 2);
    var svg = '';
    for (var g = 0; g <= top + 1e-9; g += step) {
      svg += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '"/>'
        + '<text class="axis" x="' + (L - 6) + '" y="' + (y(g) + 3.5) + '" text-anchor="end">' + shortMoney(g) + '</text>';
    }
    series.forEach(function (s, i) {
      var x0 = L + i * groupW + (groupW - (barW * 2 + 2)) / 2;
      svg += '<rect class="hit" data-i="' + i + '" x="' + (L + i * groupW) + '" y="' + T + '" width="' + groupW + '" height="' + (H - T - B) + '"/>';
      SERIES.forEach(function (ser, k) {
        var v = Math.max(0, num(s[ser.key])), x = x0 + k * (barW + 2), yt = y(v), h = (H - B) - yt;
        if (h > 0.5) svg += '<path class="bar" fill="' + ser.color + '" d="' + roundTop(x, yt, barW, h, Math.min(4, h)) + '"/>';
      });
      svg += '<text class="axis" x="' + (L + i * groupW + groupW / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + monthName(s.month) + '</text>';
    });
    el.innerHTML = '<div class="ac-legend">' + SERIES.map(function (s) { return '<span><i style="--c:' + s.color + '"></i>' + s.label + '</span>'; }).join('') + '</div>'
      + '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Income and costs by month">' + svg + '</svg>'
      + '<details><summary>Show as a table</summary><table class="pj-table"><thead><tr><th>Month</th><th class="ac-num">Income</th><th class="ac-num">Costs</th><th class="ac-num">Profit</th></tr></thead><tbody>'
      + series.map(function (s) { return '<tr><td>' + monthName(s.month, true) + '</td><td class="ac-num">' + fmt(s.income) + '</td><td class="ac-num">' + fmt(s.expenses) + '</td><td class="ac-num">' + money(s.profit) + '</td></tr>'; }).join('')
      + '</tbody></table></details>';
    var tip = chartTip();
    el.querySelectorAll('.hit').forEach(function (r) {
      r.addEventListener('mousemove', function (e) {
        var s = series[+r.dataset.i];
        tip.innerHTML = '<b>' + monthName(s.month, true) + '</b>' + SERIES.map(function (ser) { return '<div><i style="--c:' + ser.color + '"></i>' + ser.label + ' ' + c + ' ' + fmt(s[ser.key]) + '</div>'; }).join('')
          + '<div>Profit ' + c + ' ' + fmt(s.profit) + '</div>';
        tip.hidden = false; tip.style.left = Math.min(e.clientX + 14, innerWidth - 220) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
      });
      r.addEventListener('mouseleave', function () { tip.hidden = true; });
    });
  }
  var tipEl = null;
  function chartTip() {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'ac-tip'; tipEl.hidden = true; document.body.appendChild(tipEl); }
    tipEl.hidden = true;
    return tipEl;
  }
  function roundTop(x, y, w, h, r) {
    return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z';
  }
  function niceStep(raw) { var p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1)))); var f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
  function shortMoney(v) { return v >= 1e6 ? (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(v % 1e3 ? 1 : 0) + 'k' : String(v); }
  function monthName(ym, long) {
    var d = new Date(ym + '-01T12:00:00');
    return d.toLocaleString('en-US', long ? { month: 'long', year: 'numeric' } : { month: 'short' });
  }

  // ── invoices ──────────────────────────────────────────────────────────────
  var INV_TABS = [['', 'All'], ['draft', 'Drafts'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['void', 'Void']];
  async function viewInvoices() {
    var st = state.invoices;
    setToolbar('<h2 class="ac-h">Invoices</h2><div class="pj-tabs" role="tablist">' + INV_TABS.map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (st.tab === t[0]) + '">' + t[1] + '</button>';
    }).join('') + '</div><div class="pj-filters"><input id="f-q" type="search" placeholder="Search customer, number, subject" value="' + esc(st.q) + '"></div>'
      + '<div class="pj-actions"><a class="pj-primary" style="display:inline-flex;align-items:center;text-decoration:none" href="' + ACC + '/invoice?company=' + esc(company) + '">+ New invoice</a></div>');
    $('ac-toolbar').querySelectorAll('[data-tab]').forEach(function (b) { b.onclick = function () { st.tab = b.dataset.tab; viewInvoices(); }; });
    var t; $('f-q').oninput = function () { clearTimeout(t); var v = this.value; t = setTimeout(function () { st.q = v; loadInvoices(); }, 250); };
    await loadInvoices();
  }
  async function loadInvoices() {
    var st = state.invoices;
    var rows = await api('/invoices' + q({ state: st.tab, q: st.q }));
    if (!rows.length) { setView('<div class="pj-empty"><b>No invoices here</b><span>Create one with “+ New invoice”, or from an accepted quotation.</span></div>'); return; }
    var sum = {};
    rows.forEach(function (r) { if (r.status === 'issued') sum[r.currency] = (sum[r.currency] || 0) + num(r.balance); });
    setView('<div class="pj-table-wrap"><table class="pj-table"><thead><tr><th>Number</th><th>Date</th><th>Customer</th><th>Subject</th><th>Due</th><th>Status</th>'
      + '<th class="ac-num">Total</th><th class="ac-num">Balance</th></tr></thead><tbody>' + rows.map(function (r) {
        return '<tr class="row' + (r.status === 'void' ? ' void' : '') + '" data-href="' + esc(invoiceUrl(r.id)) + '"><td class="ac-code">' + esc(r.code) + '</td>'
          + '<td>' + esc(dmy(r.issue_date)) + '</td><td>' + esc(r.customer_company || r.customer_name || '—') + (r.customer_company && r.customer_name ? '<div class="ac-muted" style="font-size:12px">' + esc(r.customer_name) + '</div>' : '') + '</td>'
          + '<td>' + esc(r.subject) + (r.quotation_code ? ' <span class="ac-muted">· ' + esc(r.quotation_code) + '</span>' : '') + '</td>'
          + '<td>' + esc(dmy(r.due_date)) + '</td><td>' + pill(r.payment_status) + '</td>'
          + '<td class="ac-num">' + esc(r.currency) + ' ' + fmt(r.total) + '</td><td class="ac-num"><b>' + (r.status === 'issued' ? fmt(r.balance) : '—') + '</b></td></tr>';
      }).join('') + '</tbody><tfoot><tr><td colspan="7">Balance still to collect</td><td class="ac-num">'
      + (Object.keys(sum).map(function (k) { return k + ' ' + fmt(sum[k]); }).join('<br>') || '0.00') + '</td></tr></tfoot></table></div>');
  }

  // ── payments received ─────────────────────────────────────────────────────
  async function viewPayments() {
    var st = state.payments;
    setToolbar('<h2 class="ac-h">Payments received</h2><div class="pj-filters"><input id="f-q" type="search" placeholder="Search customer or reference" value="' + esc(st.q) + '"></div>'
      + dateRange() + '<div class="pj-actions"><button class="pj-primary" type="button" id="p-new">+ Payment received</button></div>');
    $('p-new').onclick = function () { receiptDialog(); };
    var t; $('f-q').oninput = function () { clearTimeout(t); var v = this.value; t = setTimeout(function () { st.q = v; loadPayments(); }, 250); };
    bindRange(loadPayments);
    await loadPayments();
  }
  async function loadPayments() {
    var rows = await api('/receipts' + q({ q: state.payments.q, date_from: state.from, date_to: state.to }));
    if (!rows.length) { setView('<div class="pj-empty"><b>No payments in this period</b><span>Record money received with “+ Payment received”.</span></div>'); return; }
    setView('<div class="pj-table-wrap"><table class="pj-table"><thead><tr><th>Number</th><th>Date</th><th>Customer</th><th>Method</th><th>Into</th><th>Applied to</th>'
      + '<th class="ac-num">Amount</th><th class="ac-num">Not yet applied</th><th></th></tr></thead><tbody>' + rows.map(function (r) {
        var open = r.status === 'posted' && num(r.unallocated) > 0;
        return '<tr class="' + (r.status === 'void' ? 'void' : '') + '"><td class="ac-code">' + esc(r.code) + (r.status === 'void' ? ' ' + pill('void') : '') + '</td><td>' + esc(dmy(r.receipt_date)) + '</td>'
          + '<td>' + esc(r.customer_company || r.customer_name || '—') + '</td><td>' + esc(METHODS[r.method] || r.method) + (r.reference ? '<div class="ac-muted" style="font-size:12px">' + esc(r.reference) + '</div>' : '') + '</td>'
          + '<td>' + esc(r.deposit_account_name) + '</td><td>' + (r.allocations.map(function (a) { return '<a class="ac-link" href="' + esc(invoiceUrl(a.invoice_id)) + '">' + esc(a.invoice_code) + '</a> ' + fmt(a.amount); }).join('<br>') || '<span class="ac-muted">—</span>') + '</td>'
          + '<td class="ac-num">' + esc(r.currency) + ' ' + fmt(r.amount) + '</td><td class="ac-num">' + (open ? '<b>' + fmt(r.unallocated) + '</b>' : '—') + '</td>'
          + '<td class="ac-actions-cell">' + (open ? '<button class="pj-btn" type="button" data-apply="' + esc(r.id) + '">Apply</button> ' : '')
          + (r.status === 'posted' && me.can_manage ? '<button class="pj-danger" type="button" data-void-r="' + esc(r.id) + '" data-code="' + esc(r.code) + '">Void</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>');
    $('ac-view').querySelectorAll('[data-apply]').forEach(function (b) {
      b.onclick = function () { applyDialog(rows.filter(function (r) { return r.id === b.dataset.apply; })[0]); };
    });
    $('ac-view').querySelectorAll('[data-void-r]').forEach(function (b) {
      b.onclick = function () { voidDialog('payment', b.dataset.code, '/receipts/' + b.dataset.voidR + '/void', function () { loadPayments(); }); };
    });
  }

  // Record a payment: pick the customer, the amount, and how much goes to each
  // open invoice (oldest first by default). Anything left is a customer deposit.
  async function receiptDialog() {
    var open = await api('/invoices' + q({ state: 'unpaid' }));
    var byCustomer = {};
    open.forEach(function (i) { var k = i.customer_company || i.customer_name || '—'; (byCustomer[k] = byCustomer[k] || []).push(i); });
    var names = Object.keys(byCustomer).sort();
    openDialog({
      crumb: 'Payment received', title: 'Record money received', ok: 'Save payment',
      body: '<label class="pj-field">Customer<input id="d-cust" list="d-cust-list" autocomplete="off" placeholder="Type or pick a customer"></label>'
        + '<datalist id="d-cust-list">' + names.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>'
        + '<label class="pj-field">Date received<input type="date" id="d-date" value="' + todayIso() + '" required></label>'
        + '<label class="pj-field">Amount<input id="d-amount" inputmode="decimal" autocomplete="off" required></label>'
        + '<label class="pj-field">Currency<select id="d-cur">' + CURRENCIES.map(function (c) { return '<option' + (c === cur() ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label>'
        + '<label class="pj-field" id="d-rate-wrap" hidden>Exchange rate (1 ' + esc(cur()) + ' = … )<input id="d-rate" inputmode="decimal" autocomplete="off"></label>'
        + '<label class="pj-field">Method<select id="d-method">' + Object.keys(METHODS).map(function (k) { return '<option value="' + k + '">' + METHODS[k] + '</option>'; }).join('') + '</select></label>'
        + '<label class="pj-field">Received into<select id="d-into">' + accOptions(function (a) { return a.is_bank && a.active; }, (banks().filter(function (a) { return /bank/i.test(a.name); })[0] || {}).id) + '</select></label>'
        + '<label class="pj-field">Reference<input id="d-ref" maxlength="128" placeholder="Cheque no., transfer ref."></label>'
        + '<div class="pj-full" id="d-alloc"></div>',
      ready: function () {
        var draw = function () {
          var list = (byCustomer[$('d-cust').value] || []).filter(function (i) { return i.currency === $('d-cur').value; });
          $('d-rate-wrap').hidden = $('d-cur').value === cur();
          $('d-alloc').innerHTML = list.length ? '<table class="ac-lines"><thead><tr><th>Invoice</th><th>Due</th><th class="ac-num">Balance</th><th style="width:140px">Apply</th></tr></thead><tbody>'
            + list.map(function (i) { return '<tr><td class="ac-code">' + esc(i.code) + '</td><td>' + esc(dmy(i.due_date)) + '</td><td class="ac-num">' + fmt(i.balance) + '</td>'
              + '<td><input class="ac-num" data-inv="' + esc(i.id) + '" data-bal="' + esc(i.balance) + '" inputmode="decimal"></td></tr>'; }).join('')
            + '</tbody></table><p class="ac-note" id="d-left" style="margin-top:8px"></p>'
            : '<p class="ac-note">' + ($('d-cust').value ? 'No unpaid ' + esc($('d-cur').value) + ' invoices for this customer: the whole amount is kept as a customer deposit, to apply to a later invoice.' : 'Pick the customer to see their unpaid invoices.') + '</p>';
          autoApply();
          $('d-alloc').querySelectorAll('input[data-inv]').forEach(function (inp) { inp.oninput = left; });
        };
        var autoApply = function () {
          var rest = num(clean($('d-amount').value));
          $('d-alloc').querySelectorAll('input[data-inv]').forEach(function (inp) {
            var take = Math.min(rest, num(inp.dataset.bal)); inp.value = take > 0 ? take.toFixed(2) : ''; rest -= Math.max(take, 0);
          });
          left();
        };
        var left = function () {
          var el = $('d-left'); if (!el) return;
          var applied = 0; $('d-alloc').querySelectorAll('input[data-inv]').forEach(function (inp) { applied += num(clean(inp.value)); });
          var rest = num(clean($('d-amount').value)) - applied;
          el.textContent = rest > 0.004 ? fmt(rest) + ' will be kept as a customer deposit.' : rest < -0.004 ? 'You are applying ' + fmt(-rest) + ' more than was received.' : 'The whole amount is applied.';
          el.className = 'ac-note' + (rest < -0.004 ? ' ac-diff' : '');
        };
        $('d-cust').addEventListener('change', draw); $('d-cust').addEventListener('input', draw);
        $('d-cur').addEventListener('change', draw);
        $('d-amount').addEventListener('input', autoApply);
        draw();
      },
      submit: async function () {
        var who = $('d-cust').value.trim();
        var sample = (byCustomer[who] || [])[0];
        var allocations = [];
        $('d-alloc').querySelectorAll('input[data-inv]').forEach(function (inp) { if (num(clean(inp.value)) > 0) allocations.push({ invoice_id: inp.dataset.inv, amount: clean(inp.value) }); });
        await api('/receipts', { method: 'POST', body: JSON.stringify({
          company: company, receipt_date: $('d-date').value, customer_company: sample ? sample.customer_company : who,
          customer_name: sample ? sample.customer_name : '', contact_id: sample ? sample.contact_id : null,
          method: $('d-method').value, reference: $('d-ref').value.trim(), deposit_account_id: $('d-into').value,
          currency: $('d-cur').value, fx_rate: $('d-cur').value === cur() ? '1' : (clean($('d-rate').value) || '1'),
          amount: clean($('d-amount').value), allocations: allocations,
        }) });
        refresh();
      },
    });
  }
  async function applyDialog(r) {
    var open = (await api('/invoices' + q({ state: 'unpaid' }))).filter(function (i) {
      return i.currency === r.currency && (i.customer_company || i.customer_name) === (r.customer_company || r.customer_name);
    });
    openDialog({
      crumb: r.code, title: 'Apply ' + r.currency + ' ' + fmt(r.unallocated) + ' to invoices', ok: 'Apply',
      body: '<label class="pj-field">Date applied<input type="date" id="d-date" value="' + todayIso() + '"></label><span></span>'
        + '<div class="pj-full">' + (open.length ? '<table class="ac-lines"><thead><tr><th>Invoice</th><th>Due</th><th class="ac-num">Balance</th><th style="width:140px">Apply</th></tr></thead><tbody>'
          + open.map(function (i) { return '<tr><td class="ac-code">' + esc(i.code) + '</td><td>' + esc(dmy(i.due_date)) + '</td><td class="ac-num">' + fmt(i.balance) + '</td><td><input class="ac-num" data-inv="' + esc(i.id) + '" data-bal="' + esc(i.balance) + '" inputmode="decimal"></td></tr>'; }).join('')
          + '</tbody></table>' : '<p class="ac-note">This customer has no unpaid ' + esc(r.currency) + ' invoices yet.</p>') + '</div>',
      ready: function () {
        var rest = num(r.unallocated);
        document.querySelectorAll('#ac-dialog-body input[data-inv]').forEach(function (inp) { var take = Math.min(rest, num(inp.dataset.bal)); inp.value = take > 0 ? take.toFixed(2) : ''; rest -= take; });
      },
      submit: async function () {
        var allocations = [];
        document.querySelectorAll('#ac-dialog-body input[data-inv]').forEach(function (inp) { if (num(clean(inp.value)) > 0) allocations.push({ invoice_id: inp.dataset.inv, amount: clean(inp.value) }); });
        if (!allocations.length) throw new Error('Enter an amount for at least one invoice.');
        await api('/receipts/' + r.id + '/allocate', { method: 'POST', body: JSON.stringify({ allocation_date: $('d-date').value, allocations: allocations }) });
        refresh();
      },
    });
  }

  // ── expenses ──────────────────────────────────────────────────────────────
  function costAccounts(a) { return a.active && !a.is_bank && (a.type === 'expense' || a.type === 'asset') && !a.role; }
  async function viewExpenses() {
    var st = state.expenses;
    setToolbar('<h2 class="ac-h">Expenses</h2><div class="pj-filters"><input id="f-q" type="search" placeholder="Search supplier, description, ref." value="' + esc(st.q) + '">'
      + '<select id="f-acc">' + accOptions(costAccounts, st.account, 'All categories') + '</select></div>' + dateRange()
      + '<div class="pj-actions"><button class="pj-primary" type="button" id="e-new">+ Expense</button></div>');
    $('e-new').onclick = function () { expenseDialog(); };
    $('f-acc').onchange = function () { st.account = this.value; loadExpenses(); };
    var t; $('f-q').oninput = function () { clearTimeout(t); var v = this.value; t = setTimeout(function () { st.q = v; loadExpenses(); }, 250); };
    bindRange(loadExpenses);
    await loadExpenses();
  }
  async function loadExpenses() {
    var rows = await api('/expenses' + q({ q: state.expenses.q, account_id: state.expenses.account, date_from: state.from, date_to: state.to }));
    if (!rows.length) { setView('<div class="pj-empty"><b>No expenses in this period</b><span>Record a cost with “+ Expense”: fuel, rent, materials, salaries…</span></div>'); return; }
    var total = 0; rows.forEach(function (r) { if (r.status === 'posted' && r.currency === cur()) total += num(r.total); });
    setView('<div class="pj-table-wrap"><table class="pj-table"><thead><tr><th>Number</th><th>Date</th><th>Supplier</th><th>Description</th><th>Category</th><th>Paid from</th>'
      + '<th class="ac-num">Net</th><th class="ac-num">VAT</th><th class="ac-num">Total</th><th></th></tr></thead><tbody>' + rows.map(function (r) {
        return '<tr class="' + (r.status === 'void' ? 'void' : '') + '"><td class="ac-code">' + esc(r.code) + (r.status === 'void' ? ' ' + pill('void') : '') + '</td><td>' + esc(dmy(r.expense_date)) + '</td>'
          + '<td>' + esc(r.supplier || '—') + (r.reference ? '<div class="ac-muted" style="font-size:12px">' + esc(r.reference) + '</div>' : '') + '</td><td>' + esc(r.description) + '</td>'
          + '<td>' + esc(r.account_name) + '</td><td>' + esc(r.paid_from_name) + '</td>'
          + '<td class="ac-num">' + fmt(r.amount) + '</td><td class="ac-num">' + fmt(r.vat) + '</td><td class="ac-num"><b>' + esc(r.currency) + ' ' + fmt(r.total) + '</b></td>'
          + '<td class="ac-actions-cell">' + (r.status === 'posted' && me.can_manage ? '<button class="pj-danger" type="button" data-void-e="' + esc(r.id) + '" data-code="' + esc(r.code) + '">Void</button>' : '') + '</td></tr>';
      }).join('') + '</tbody><tfoot><tr><td colspan="8">Total (' + esc(cur()) + ', not void)</td><td class="ac-num">' + fmt(total) + '</td><td></td></tr></tfoot></table></div>');
    $('ac-view').querySelectorAll('[data-void-e]').forEach(function (b) {
      b.onclick = function () { voidDialog('expense', b.dataset.code, '/expenses/' + b.dataset.voidE + '/void', function () { loadExpenses(); }); };
    });
  }
  function expenseDialog() {
    openDialog({
      crumb: 'Expense', title: 'Record an expense', ok: 'Save expense',
      body: '<label class="pj-field">Date<input type="date" id="d-date" value="' + todayIso() + '" required></label>'
        + '<label class="pj-field">Supplier<input id="d-sup" maxlength="255" autocomplete="off" placeholder="Who was paid"></label>'
        + '<label class="pj-field pj-full">Description<input id="d-desc" maxlength="5000" autocomplete="off" placeholder="e.g. Diesel for the delivery truck"></label>'
        + '<label class="pj-field">Category<select id="d-acc">' + accOptions(costAccounts, '') + '</select><small>Buying equipment? Choose an asset account such as Scaffolding equipment.</small></label>'
        + '<label class="pj-field">Paid from<select id="d-from">' + accOptions(function (a) { return a.is_bank && a.active; }, (banks().filter(function (a) { return /bank/i.test(a.name); })[0] || banks()[0] || {}).id) + '</select></label>'
        + '<label class="pj-field">Method<select id="d-method">' + Object.keys(METHODS).map(function (k) { return '<option value="' + k + '"' + (k === 'cash' ? ' selected' : '') + '>' + METHODS[k] + '</option>'; }).join('') + '</select></label>'
        + '<label class="pj-field">Supplier invoice / ref.<input id="d-ref" maxlength="128" autocomplete="off"></label>'
        + '<label class="pj-field">Currency<select id="d-cur">' + CURRENCIES.map(function (c) { return '<option' + (c === cur() ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label>'
        + '<label class="pj-field" id="d-rate-wrap" hidden>Exchange rate (1 ' + esc(cur()) + ' = … )<input id="d-rate" inputmode="decimal" autocomplete="off"></label>'
        + '<label class="pj-field">Amount before VAT<input id="d-amount" inputmode="decimal" autocomplete="off" required></label>'
        + '<label class="pj-field">VAT %<input id="d-vat" inputmode="decimal" autocomplete="off" value="0"></label>'
        + '<p class="ac-note pj-full" id="d-total"></p>',
      ready: function () {
        var total = function () {
          var a = num(clean($('d-amount').value)), v = num(clean($('d-vat').value));
          var vat = Math.round(a * v) / 100;
          $('d-total').textContent = 'Total paid: ' + $('d-cur').value + ' ' + fmt(a + vat) + (vat ? ' (VAT ' + fmt(vat) + ')' : '');
          $('d-rate-wrap').hidden = $('d-cur').value === cur();
        };
        ['d-amount', 'd-vat', 'd-cur'].forEach(function (id) { $(id).addEventListener('input', total); $(id).addEventListener('change', total); });
        total();
      },
      submit: async function () {
        await api('/expenses', { method: 'POST', body: JSON.stringify({
          company: company, expense_date: $('d-date').value, supplier: $('d-sup').value.trim(), description: $('d-desc').value.trim(),
          reference: $('d-ref').value.trim(), account_id: $('d-acc').value, paid_from_account_id: $('d-from').value, method: $('d-method').value,
          currency: $('d-cur').value, fx_rate: $('d-cur').value === cur() ? '1' : (clean($('d-rate').value) || '1'),
          amount: clean($('d-amount').value), vat_percent: clean($('d-vat').value) || null,
        }) });
        refresh();
      },
    });
  }

  // ── journal ───────────────────────────────────────────────────────────────
  async function viewJournal() {
    var st = state.journal;
    setToolbar('<h2 class="ac-h">Journal</h2><div class="pj-filters"><input id="f-q" type="search" placeholder="Search memo or JE number" value="' + esc(st.q) + '">'
      + '<select id="f-type"><option value="">All postings</option>' + Object.keys(SOURCES).map(function (k) { return '<option value="' + k + '"' + (st.type === k ? ' selected' : '') + '>' + SOURCES[k] + '</option>'; }).join('') + '</select></div>'
      + dateRange() + '<div class="pj-actions">' + (me.can_manage ? '<button class="pj-primary" type="button" id="j-new">+ Journal entry</button>' : '') + '</div>');
    if ($('j-new')) $('j-new').onclick = journalDialog;
    $('f-type').onchange = function () { st.type = this.value; loadJournal(); };
    var t; $('f-q').oninput = function () { clearTimeout(t); var v = this.value; t = setTimeout(function () { st.q = v; loadJournal(); }, 250); };
    bindRange(loadJournal);
    await loadJournal();
  }
  async function loadJournal() {
    var rows = await api('/journal' + q({ q: state.journal.q, source_type: state.journal.type, date_from: state.from, date_to: state.to }));
    if (!rows.length) { setView('<div class="pj-empty"><b>No postings in this period</b></div>'); return; }
    setView('<div class="pj-table-wrap"><table class="pj-table"><thead><tr><th>Entry</th><th>Date</th><th>From</th><th>Account</th><th>Description</th><th class="ac-num">Debit</th><th class="ac-num">Credit</th><th></th></tr></thead><tbody>'
      + rows.map(function (e) {
        var src = e.source_code ? (e.source_type === 'invoice' ? '<a class="ac-link" href="' + esc(invoiceUrl(e.source_id)) + '">' + esc(e.source_code) + '</a>' : esc(e.source_code)) : esc(SOURCES[e.source_type] || e.source_type);
        var head = '<tr class="grp"><td class="ac-code">' + esc(e.code) + '</td><td>' + esc(dmy(e.entry_date)) + '</td><td>' + src + (e.reversal_of_id ? ' <span class="ac-pill void">Reversal</span>' : e.reversed_by_id ? ' <span class="ac-pill void">Reversed</span>' : '') + '</td>'
          + '<td colspan="4"><b>' + esc(e.memo) + '</b></td><td class="ac-actions-cell">' + (me.can_manage && e.source_type === 'manual' && !e.reversal_of_id && !e.reversed_by_id ? '<button class="pj-danger" type="button" data-void-j="' + esc(e.id) + '" data-code="' + esc(e.code) + '">Reverse</button>' : '') + '</td></tr>';
        return head + e.lines.map(function (l) {
          return '<tr><td></td><td></td><td></td><td>' + esc(l.account_code + ' ' + l.account_name) + '</td><td class="ac-muted">' + esc(l.description) + '</td>'
            + '<td class="ac-num">' + (num(l.debit) ? fmt(l.debit) : '') + '</td><td class="ac-num">' + (num(l.credit) ? fmt(l.credit) : '') + '</td><td></td></tr>';
        }).join('');
      }).join('') + '</tbody></table></div>');
    $('ac-view').querySelectorAll('[data-void-j]').forEach(function (b) {
      b.onclick = function () { voidDialog('entry', b.dataset.code, '/journal/' + b.dataset.voidJ + '/void', function () { loadJournal(); }); };
    });
  }
  function journalDialog() {
    var row = function () {
      return '<tr><td><select data-k="account">' + accOptions(function (a) { return a.active; }, '', 'Choose account') + '</select></td>'
        + '<td><input data-k="desc" maxlength="1000"></td><td><input class="ac-num" data-k="debit" inputmode="decimal"></td><td><input class="ac-num" data-k="credit" inputmode="decimal"></td>'
        + '<td><button class="pj-icon" type="button" data-del aria-label="Remove line" style="min-height:30px;width:30px;font-size:16px">×</button></td></tr>';
    };
    openDialog({
      crumb: 'Journal entry', title: 'New journal entry', ok: 'Post entry',
      body: '<label class="pj-field">Date<input type="date" id="d-date" value="' + todayIso() + '" required></label>'
        + '<label class="pj-field">Memo<input id="d-memo" maxlength="2000" placeholder="e.g. Opening balances, owner loan, depreciation"></label>'
        + '<div class="pj-full"><table class="ac-lines"><thead><tr><th>Account</th><th>Description</th><th style="width:120px" class="ac-num">Debit</th><th style="width:120px" class="ac-num">Credit</th><th style="width:36px"></th></tr></thead>'
        + '<tbody id="d-lines">' + row() + row() + '</tbody><tfoot><tr><td><button class="pj-btn" type="button" id="d-add">+ Line</button></td><td class="ac-num">Totals</td><td class="ac-num" id="d-td">0.00</td><td class="ac-num" id="d-tc">0.00</td><td></td></tr>'
        + '<tr><td colspan="5" id="d-diff" class="ac-num"></td></tr></tfoot></table></div>'
        + '<p class="ac-note pj-full">Amounts are in ' + esc(cur()) + '. Debits must equal credits. Entries are never edited afterwards: a mistake is corrected with Reverse.</p>',
      ready: function () {
        var tot = function () {
          var d = 0, c = 0;
          document.querySelectorAll('#d-lines tr').forEach(function (tr) { d += num(clean(tr.querySelector('[data-k="debit"]').value)); c += num(clean(tr.querySelector('[data-k="credit"]').value)); });
          $('d-td').textContent = fmt(d); $('d-tc').textContent = fmt(c);
          var diff = Math.round((d - c) * 100) / 100;
          $('d-diff').textContent = diff ? 'Difference ' + fmt(Math.abs(diff)) + ' — the entry does not balance yet' : '';
          $('d-diff').className = 'ac-num ac-diff';
        };
        $('d-lines').addEventListener('input', tot);
        $('d-lines').addEventListener('click', function (e) { var b = e.target.closest('[data-del]'); if (b && $('d-lines').rows.length > 2) { b.closest('tr').remove(); tot(); } });
        $('d-add').onclick = function () { $('d-lines').insertAdjacentHTML('beforeend', row()); };
      },
      submit: async function () {
        var lines = [];
        document.querySelectorAll('#d-lines tr').forEach(function (tr) {
          var acc = tr.querySelector('[data-k="account"]').value, d = clean(tr.querySelector('[data-k="debit"]').value), c = clean(tr.querySelector('[data-k="credit"]').value);
          if (acc || d || c) lines.push({ account_id: acc, debit: d || null, credit: c || null, description: tr.querySelector('[data-k="desc"]').value.trim() });
        });
        if (lines.some(function (l) { return !l.account_id; })) throw new Error('Choose an account on every line.');
        await api('/journal', { method: 'POST', body: JSON.stringify({ company: company, entry_date: $('d-date').value, memo: $('d-memo').value.trim(), lines: lines }) });
        refresh();
      },
    });
  }

  // ── chart of accounts ─────────────────────────────────────────────────────
  async function viewAccounts() {
    setToolbar('<h2 class="ac-h">Chart of accounts</h2><div class="pj-actions">' + (me.can_manage ? '<button class="pj-primary" type="button" id="a-new">+ Account</button>' : '') + '</div>');
    if ($('a-new')) $('a-new').onclick = function () { accountDialog(null); };
    accounts = await api('/accounts' + q());
    var html = '';
    Object.keys(TYPES).forEach(function (t) {
      var list = accounts.filter(function (a) { return a.type === t; });
      html += '<tr class="grp"><td colspan="5">' + TYPES[t] + '<span class="n">' + list.length + '</span></td></tr>' + list.map(function (a) {
        return '<tr class="row" data-acc="' + esc(a.id) + '"><td class="ac-code">' + esc(a.code) + '</td><td>' + esc(a.name) + (a.active ? '' : ' <span class="ac-pill void">Inactive</span>') + '</td>'
          + '<td class="ac-muted">' + (a.is_bank ? 'Cash / bank' : a.role ? 'Used by automatic postings' : '') + '</td>'
          + '<td class="ac-num">' + money(a.balance) + '</td><td class="ac-actions-cell"><button class="pj-btn" type="button" data-gl="' + esc(a.id) + '">Ledger</button></td></tr>';
      }).join('');
    });
    setView('<div class="pj-table-wrap"><table class="pj-table"><thead><tr><th>Code</th><th>Account</th><th></th><th class="ac-num">Balance (' + esc(cur()) + ')</th><th></th></tr></thead><tbody>' + html + '</tbody></table></div>');
    $('ac-view').querySelectorAll('[data-gl]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); state.glAccount = b.dataset.gl; go('gl'); }; });
    $('ac-view').querySelectorAll('tr[data-acc]').forEach(function (tr) {
      tr.onclick = function () { if (me.can_manage) accountDialog(accounts.filter(function (a) { return a.id === tr.dataset.acc; })[0]); };
    });
  }
  function accountDialog(a) {
    openDialog({
      crumb: a ? a.code : 'New account', title: a ? a.name : 'New account', ok: a ? 'Save account' : 'Add account',
      body: '<label class="pj-field">Code<input id="d-code" maxlength="16" required value="' + esc(a ? a.code : '') + '" placeholder="e.g. 1020"></label>'
        + '<label class="pj-field">Type<select id="d-type"' + (a && (a.has_entries || a.role) ? ' disabled' : '') + '>' + Object.keys(TYPES).map(function (t) { return '<option value="' + t + '"' + (a && a.type === t ? ' selected' : '') + '>' + TYPES[t] + '</option>'; }).join('') + '</select></label>'
        + '<label class="pj-field pj-full">Name<input id="d-name" maxlength="255" required value="' + esc(a ? a.name : '') + '" placeholder="e.g. BLOM Bank USD"></label>'
        + '<label class="pj-field"><span><input type="checkbox" id="d-bank"' + (a && a.is_bank ? ' checked' : '') + '> Cash or bank account</span><small>Money can be received into and paid from it.</small></label>'
        + (a ? '<label class="pj-field"><span><input type="checkbox" id="d-active"' + (a.active ? ' checked' : '') + (a.role ? ' disabled' : '') + '> Active</span><small>' + (a.role ? 'Used by automatic postings; always active.' : 'Inactive accounts keep their history but cannot be used.') + '</small></label>' : '<span></span>')
        + '<label class="pj-field pj-full">Notes<textarea id="d-desc" rows="2" maxlength="2000">' + esc(a ? a.description : '') + '</textarea></label>'
        + (a && !a.role && !a.has_entries ? '<p class="pj-full"><button class="pj-danger" type="button" id="d-del">Delete this account</button></p>' : ''),
      ready: function () {
        if ($('d-del')) $('d-del').onclick = async function () {
          if (!confirm('Delete account ' + a.code + ' ' + a.name + '?')) return;
          try { await api('/accounts/' + a.id, { method: 'DELETE' }); $('ac-dialog').close(); refresh(); } catch (e) { dialogError(e.message); }
        };
      },
      submit: async function () {
        var body = { code: $('d-code').value.trim(), name: $('d-name').value.trim(), is_bank: $('d-bank').checked, description: $('d-desc').value.trim() };
        if (!$('d-type').disabled) body.type = $('d-type').value;
        if (a) { if ($('d-active') && !$('d-active').disabled) body.active = $('d-active').checked; await api('/accounts/' + a.id, { method: 'PATCH', body: JSON.stringify(body) }); }
        else await api('/accounts', { method: 'POST', body: JSON.stringify(Object.assign({ company: company }, body)) });
        refresh();
      },
    });
  }

  // ── reports ───────────────────────────────────────────────────────────────
  function reportRows(list, opts) {
    return list.map(function (r) {
      return '<tr class="row" data-gl="' + esc(r.account_id) + '"><td class="ac-code">' + esc(r.code) + '</td><td>' + esc(r.name) + '</td><td class="ac-num">' + money(opts && opts.neg ? -num(r.amount) : r.amount) + '</td></tr>';
    }).join('');
  }
  function bindGl() {
    $('ac-view').querySelectorAll('tr[data-gl]').forEach(function (tr) { tr.onclick = function () { state.glAccount = tr.dataset.gl; go('gl'); }; });
  }
  function check(ok, good, bad) { return '<p class="ac-check ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✓ ' + good : '⚠ ' + bad) + '</p>'; }
  async function viewPL() {
    setToolbar('<h2 class="ac-h">Profit &amp; loss</h2>' + dateRange() + '<div class="pj-actions">' + printBtn() + '</div>');
    bindRange(viewPL); loading();
    var r = await api('/reports/profit-loss' + q({ date_from: state.from, date_to: state.to }));
    setView('<div class="ac-report"><h2>Profit and loss</h2><p class="sub">' + esc(settings.company_name) + ' · ' + esc(dmy(r.from)) + ' to ' + esc(dmy(r.to)) + ' · ' + esc(r.currency) + '</p>'
      + '<table class="pj-table"><tbody>'
      + '<tr class="sec"><td colspan="3">Income</td></tr>' + reportRows(r.income) + '<tr class="tot"><td></td><td>Total income</td><td class="ac-num">' + money(r.total_income) + '</td></tr>'
      + '<tr class="sec"><td colspan="3">Cost of sales</td></tr>' + reportRows(r.cost_of_sales) + '<tr class="tot"><td></td><td>Total cost of sales</td><td class="ac-num">' + money(r.total_cost_of_sales) + '</td></tr>'
      + '<tr class="tot"><td></td><td>Gross profit</td><td class="ac-num">' + money(r.gross_profit) + '</td></tr>'
      + '<tr class="sec"><td colspan="3">Expenses</td></tr>' + reportRows(r.expenses) + '<tr class="tot"><td></td><td>Total expenses</td><td class="ac-num">' + money(r.total_expenses) + '</td></tr>'
      + '<tr class="grand"><td></td><td>Net profit</td><td class="ac-num">' + money(r.net_profit) + '</td></tr>'
      + '</tbody></table></div>');
    bindGl();
  }
  async function viewBS() {
    setToolbar('<h2 class="ac-h">Balance sheet</h2>' + asOfPicker() + '<div class="pj-actions">' + printBtn() + '</div>');
    bindAsOf(viewBS); loading();
    var r = await api('/reports/balance-sheet' + q({ as_of: state.asOf }));
    setView('<div class="ac-report"><h2>Balance sheet</h2><p class="sub">' + esc(settings.company_name) + ' · as of ' + esc(dmy(r.as_of)) + ' · ' + esc(r.currency) + '</p>'
      + '<table class="pj-table"><tbody>'
      + '<tr class="sec"><td colspan="3">Assets</td></tr>' + reportRows(r.assets) + '<tr class="grand"><td></td><td>Total assets</td><td class="ac-num">' + money(r.total_assets) + '</td></tr>'
      + '<tr class="sec"><td colspan="3">Liabilities</td></tr>' + reportRows(r.liabilities) + '<tr class="tot"><td></td><td>Total liabilities</td><td class="ac-num">' + money(r.total_liabilities) + '</td></tr>'
      + '<tr class="sec"><td colspan="3">Equity</td></tr>' + reportRows(r.equity) + '<tr><td></td><td>Profit to date (not yet closed)</td><td class="ac-num">' + money(r.current_earnings) + '</td></tr>'
      + '<tr class="tot"><td></td><td>Total equity</td><td class="ac-num">' + money(r.total_equity) + '</td></tr>'
      + '<tr class="grand"><td></td><td>Total liabilities and equity</td><td class="ac-num">' + money(r.total_liabilities_and_equity) + '</td></tr>'
      + '</tbody></table>' + check(r.balanced, 'Assets equal liabilities plus equity.', 'The balance sheet does not balance — please report this.') + '</div>');
    bindGl();
  }
  async function viewTB() {
    setToolbar('<h2 class="ac-h">Trial balance</h2>' + asOfPicker() + '<div class="pj-actions">' + printBtn() + '</div>');
    bindAsOf(viewTB); loading();
    var r = await api('/reports/trial-balance' + q({ as_of: state.asOf }));
    setView('<div class="ac-report"><h2>Trial balance</h2><p class="sub">' + esc(settings.company_name) + ' · as of ' + esc(dmy(r.as_of)) + ' · ' + esc(r.currency) + '</p>'
      + '<table class="pj-table"><thead><tr><th>Code</th><th>Account</th><th class="ac-num">Debit</th><th class="ac-num">Credit</th></tr></thead><tbody>'
      + (r.rows.map(function (x) { return '<tr class="row" data-gl="' + esc(x.account_id) + '"><td class="ac-code">' + esc(x.code) + '</td><td>' + esc(x.name) + '</td><td class="ac-num">' + (num(x.debit) ? fmt(x.debit) : '') + '</td><td class="ac-num">' + (num(x.credit) ? fmt(x.credit) : '') + '</td></tr>'; }).join('') || '<tr><td colspan="4" class="ac-muted">Nothing posted yet.</td></tr>')
      + '</tbody><tfoot><tr><td></td><td>Totals</td><td class="ac-num">' + fmt(r.total_debit) + '</td><td class="ac-num">' + fmt(r.total_credit) + '</td></tr></tfoot></table>'
      + check(r.balanced, 'Debits equal credits.', 'Debits and credits differ — please report this.') + '</div>');
    bindGl();
  }
  async function viewGL() {
    if (!state.glAccount) state.glAccount = (banks()[0] || accounts[0] || {}).id || '';
    setToolbar('<h2 class="ac-h">General ledger</h2><div class="pj-filters"><select id="f-gl">' + accOptions(function () { return true; }, state.glAccount) + '</select></div>'
      + dateRange() + '<div class="pj-actions">' + printBtn() + '</div>');
    $('f-gl').onchange = function () { state.glAccount = this.value; viewGL(); };
    bindRange(viewGL); loading();
    var r = await api('/reports/ledger' + q({ account_id: state.glAccount, date_from: state.from, date_to: state.to }));
    setView('<div class="ac-report" style="max-width:1100px"><h2>' + esc(r.account.code + ' ' + r.account.name) + '</h2><p class="sub">' + esc(dmy(r.from)) + ' to ' + esc(dmy(r.to)) + ' · ' + esc(cur()) + '</p>'
      + '<table class="pj-table"><thead><tr><th>Date</th><th>Entry</th><th>From</th><th>Description</th><th class="ac-num">Debit</th><th class="ac-num">Credit</th><th class="ac-num">Balance</th></tr></thead><tbody>'
      + '<tr class="tot"><td></td><td></td><td></td><td>Opening balance</td><td></td><td></td><td class="ac-num">' + money(r.opening) + '</td></tr>'
      + r.lines.map(function (l) {
        var src = l.source_code ? (l.source_type === 'invoice' ? '<a class="ac-link" href="' + esc(invoiceUrl(l.source_id)) + '">' + esc(l.source_code) + '</a>' : esc(l.source_code)) : esc(SOURCES[l.source_type] || '');
        return '<tr><td>' + esc(dmy(l.date)) + '</td><td class="ac-code">' + esc(l.entry_code) + '</td><td>' + src + '</td><td>' + esc(l.description || l.memo) + '</td>'
          + '<td class="ac-num">' + (num(l.debit) ? fmt(l.debit) : '') + '</td><td class="ac-num">' + (num(l.credit) ? fmt(l.credit) : '') + '</td><td class="ac-num">' + money(l.balance) + '</td></tr>';
      }).join('')
      + '</tbody><tfoot><tr><td></td><td></td><td></td><td>Closing balance</td><td class="ac-num">' + fmt(r.total_debit) + '</td><td class="ac-num">' + fmt(r.total_credit) + '</td><td class="ac-num">' + money(r.closing) + '</td></tr></tfoot></table></div>');
  }
  async function viewAR() {
    setToolbar('<h2 class="ac-h">Customer balances</h2>' + asOfPicker() + '<div class="pj-actions">' + printBtn() + '</div>');
    bindAsOf(viewAR); loading();
    var r = await api('/reports/aged-receivables' + q({ as_of: state.asOf }));
    var B = [['current', 'Not yet due'], ['1_30', '1–30 days late'], ['31_60', '31–60'], ['61_90', '61–90'], ['over_90', 'Over 90']];
    setView('<div class="ac-report" style="max-width:1100px"><h2>Customer balances (aged)</h2><p class="sub">' + esc(settings.company_name) + ' · as of ' + esc(dmy(r.as_of)) + ' · ' + esc(r.currency) + ' · by days past the due date</p>'
      + '<table class="pj-table"><thead><tr><th>Customer</th><th class="ac-num">Invoices</th>' + B.map(function (b) { return '<th class="ac-num">' + b[1] + '</th>'; }).join('') + '<th class="ac-num">Total</th></tr></thead><tbody>'
      + (r.customers.map(function (c) { return '<tr><td><b>' + esc(c.customer) + '</b></td><td class="ac-num">' + c.invoices + '</td>' + B.map(function (b) { return '<td class="ac-num' + (b[0] !== 'current' && num(c[b[0]]) ? ' ac-neg' : '') + '">' + (num(c[b[0]]) ? fmt(c[b[0]]) : '') + '</td>'; }).join('') + '<td class="ac-num"><b>' + fmt(c.total) + '</b></td></tr>'; }).join('') || '<tr><td colspan="8" class="ac-muted">Every invoice is paid.</td></tr>')
      + '</tbody><tfoot><tr><td>Total</td><td></td>' + B.map(function (b) { return '<td class="ac-num">' + fmt(r.totals[b[0]]) + '</td>'; }).join('') + '<td class="ac-num">' + fmt(r.total) + '</td></tr></tfoot></table>'
      + (r.invoices.length ? '<h2 style="margin-top:20px;font-size:15px">Open invoices</h2><table class="pj-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Issued</th><th>Due</th><th class="ac-num">Days late</th><th class="ac-num">Balance</th></tr></thead><tbody>'
        + r.invoices.map(function (i) { return '<tr class="row" data-href="' + esc(invoiceUrl(i.id)) + '"><td class="ac-code">' + esc(i.code) + '</td><td>' + esc(i.customer) + '</td><td>' + esc(dmy(i.issue_date)) + '</td><td>' + esc(dmy(i.due_date)) + '</td><td class="ac-num' + (i.days_late ? ' ac-neg' : '') + '">' + (i.days_late || '') + '</td><td class="ac-num">' + esc(i.currency) + ' ' + fmt(i.balance) + '</td></tr>'; }).join('')
        + '</tbody></table>' : '') + '</div>');
  }
  async function viewVAT() {
    if (state.from === firstOfYear()) { var d = new Date(); state.from = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01'; }
    setToolbar('<h2 class="ac-h">VAT</h2>' + dateRange() + '<div class="pj-actions">' + printBtn() + '</div>');
    bindRange(viewVAT); loading();
    var r = await api('/reports/vat' + q({ date_from: state.from, date_to: state.to }));
    setView('<div class="ac-report"><h2>VAT summary</h2><p class="sub">' + esc(settings.company_name) + ' · ' + esc(dmy(r.from)) + ' to ' + esc(dmy(r.to)) + ' · ' + esc(r.currency) + '</p>'
      + '<table class="pj-table"><tbody>'
      + '<tr class="sec"><td colspan="2">Sales</td></tr><tr><td>Net sales invoiced (' + r.sales_count + ' invoices)</td><td class="ac-num">' + fmt(r.sales_net) + '</td></tr>'
      + '<tr class="tot"><td>VAT charged to customers (output VAT)</td><td class="ac-num">' + fmt(r.output_vat) + '</td></tr>'
      + '<tr class="sec"><td colspan="2">Purchases</td></tr><tr><td>Net expenses with receipts (' + r.purchases_count + ')</td><td class="ac-num">' + fmt(r.purchases_net) + '</td></tr>'
      + '<tr class="tot"><td>VAT paid to suppliers (input VAT)</td><td class="ac-num">' + fmt(r.input_vat) + '</td></tr>'
      + '<tr class="grand"><td>' + (num(r.net_vat) >= 0 ? 'VAT to pay' : 'VAT to reclaim') + '</td><td class="ac-num">' + fmt(Math.abs(num(r.net_vat))) + '</td></tr>'
      + '</tbody></table></div>');
  }

  // ── settings ──────────────────────────────────────────────────────────────
  async function viewSettings() {
    setToolbar('<h2 class="ac-h">Settings</h2>');
    settings = await api('/settings' + q());
    var s = settings, dis = me.can_manage ? '' : ' disabled';
    setView('<form class="ac-settings" id="s-form"><h3 style="margin-top:0">On invoices and quotations</h3><div class="pj-form">'
      + '<label class="pj-field pj-full">Company name<input id="s-name" maxlength="255" value="' + esc(s.legal_name) + '"' + dis + '></label>'
      + '<label class="pj-field pj-full">Address<textarea id="s-address" rows="2" maxlength="2000"' + dis + '>' + esc(s.address) + '</textarea></label>'
      + '<label class="pj-field">Phone<input id="s-phone" maxlength="64" value="' + esc(s.phone) + '"' + dis + '></label>'
      + '<label class="pj-field">Email<input id="s-email" maxlength="255" value="' + esc(s.email) + '"' + dis + '></label>'
      + '<label class="pj-field">VAT / tax number<input id="s-tax" maxlength="64" value="' + esc(s.tax_number) + '"' + dis + '></label><span></span>'
      + '<label class="pj-field pj-full">Bank details (printed on invoices)<textarea id="s-bank" rows="3" maxlength="2000" placeholder="Bank, account name, IBAN, SWIFT"' + dis + '>' + esc(s.bank_details) + '</textarea></label>'
      + '<label class="pj-field pj-full">Standard payment terms (new invoices)<textarea id="s-terms" rows="3" maxlength="20000"' + dis + '>' + esc(s.invoice_terms) + '</textarea></label>'
      + '</div><h3>Defaults and control</h3><div class="pj-form">'
      + '<label class="pj-field">Default VAT %<input id="s-vat" inputmode="decimal" value="' + esc(s.default_vat_percent) + '"' + dis + '></label>'
      + '<label class="pj-field">Invoices due after (days)<input id="s-due" type="number" min="0" max="365" value="' + esc(s.invoice_due_days) + '"' + dis + '></label>'
      + '<label class="pj-field">Base currency<select id="s-cur"' + (s.has_entries || !me.can_manage ? ' disabled' : '') + '>' + CURRENCIES.map(function (c) { return '<option' + (c === s.base_currency ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select><small>' + (s.has_entries ? 'Fixed once something has been posted.' : 'The currency the books are kept in.') + '</small></label>'
      + '<label class="pj-field">Books closed up to<input id="s-lock" type="date" value="' + esc(s.lock_date || '') + '"' + dis + '><small>Nothing on or before this date can be posted or voided. Leave empty to keep every period open.</small></label>'
      + '</div><div class="foot">' + (me.can_manage ? '<button class="pj-primary" type="submit">Save settings</button>' : '<span class="ac-muted">Only managers and admins can change these.</span>') + '<span class="ac-muted" id="s-msg"></span></div></form>');
    $('s-form').onsubmit = async function (e) {
      e.preventDefault();
      try {
        var body = { legal_name: $('s-name').value.trim(), address: $('s-address').value.trim(), phone: $('s-phone').value.trim(), email: $('s-email').value.trim(),
          tax_number: $('s-tax').value.trim(), bank_details: $('s-bank').value.trim(), invoice_terms: $('s-terms').value.trim(),
          default_vat_percent: clean($('s-vat').value) || '0', invoice_due_days: parseInt($('s-due').value || '0', 10), lock_date: $('s-lock').value || null };
        if (!$('s-cur').disabled) body.base_currency = $('s-cur').value;
        settings = await api('/settings' + q(), { method: 'PATCH', body: JSON.stringify(body) });
        $('s-msg').textContent = 'Saved'; showMsg('');
      } catch (ex) { showMsg(ex.message); }
    };
  }

  // ── routing ───────────────────────────────────────────────────────────────
  var VIEWS = { overview: viewOverview, invoices: viewInvoices, payments: viewPayments, expenses: viewExpenses, journal: viewJournal,
    accounts: viewAccounts, pl: viewPL, bs: viewBS, tb: viewTB, gl: viewGL, ar: viewAR, vat: viewVAT, settings: viewSettings };
  function go(name, opts) {
    if (opts && opts.tab != null) state.invoices.tab = opts.tab;
    if (location.hash !== '#' + name) location.hash = name; else route();
  }
  async function route() {
    var name = (location.hash || '#overview').slice(1);
    view = VIEWS[name] ? name : 'overview';
    document.querySelectorAll('#ac-nav a').forEach(function (a) { a.setAttribute('aria-current', a.getAttribute('href') === '#' + view ? 'page' : 'false'); });
    showMsg('');
    try { await VIEWS[view](); }
    catch (e) { showMsg(e.message); setView(''); }
  }
  async function refresh() {
    try { accounts = await api('/accounts' + q()); } catch (e) { /* keep the old list */ }
    route();
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('click', function (e) {
    if (e.target.closest('#ac-dialog')) return;
    var t = e.target.closest('[data-go],[data-hash]');
    if (t) {
      e.preventDefault();
      if (t.dataset.go) go(t.dataset.go, { tab: t.dataset.tab }); else location.hash = t.dataset.hash;
      return;
    }
    var row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a,button,input,select')) location.assign(row.dataset.href);
  });

  async function init() {
    if (!token()) { showMsg('Not signed in on this address. Open the main app here, sign in, then reload.'); return; }
    try {
      me = await api('/me' + q());
      var got = await Promise.all([api('/settings' + q()), api('/accounts' + q())]);
      settings = got[0]; accounts = got[1];
      $('ac-company').textContent = settings.company_name;
      document.title = 'Accounting · ' + settings.company_name;
      route();
    } catch (e) {
      setToolbar('<h2 class="ac-h">Accounting</h2>');
      showMsg(e.message);
    }
  }
  init();
})();
