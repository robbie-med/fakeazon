/* Fakeazon Bank page. Reads state from the background, sends every change back
 * as a message (the background is the only writer), and re-renders. */
'use strict';

const S = globalThis.FakeazonStore;
const fmt = S.fmt;
const AMAZON = ['*://*.amazon.com/*'];
const TABS = ['overview', 'transactions', 'recurring', 'orders', 'insights', 'settings'];
const FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Every 2 weeks', semimonthly: 'Twice a month (15th & last day)', monthly: 'Monthly' };
const TYPE_LABEL = { paycheck: 'Paycheck', bill: 'Bill', purchase: 'Purchase', refund: 'Refund', adjust: 'Manual' };

let state = null;
let charts = [];
let txFilter = { type: '', q: '' };

// ---------- plumbing ----------

async function call(op, args) {
  const r = await browser.runtime.sendMessage(Object.assign({ op }, args || {}));
  if (!r) throw new Error('No answer from background');
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const dollarsToCents = (v) => Math.round(parseFloat(String(v).replace(/[$,]/g, '')) * 100);
const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtYmd = (s) => (s ? S.parseYmd(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—');
const monthLabel = (mk) => {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
};
const signed = (c) => h('span', { class: 'num ' + (c < 0 ? 'neg' : 'pos') }, (c > 0 ? '+' : '') + fmt(c));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function act(fn, okMsg) {
  try {
    await fn();
    await reload();
    if (okMsg) flash(okMsg);
  } catch (e) {
    alert(e.message || e);
  }
}

function flash(text) {
  const t = h('div', { class: 'card', role: 'status', style: 'position:fixed;right:16px;bottom:16px;z-index:9' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2500);
}

function currentTab() {
  const t = location.hash.slice(1);
  return TABS.includes(t) ? t : 'overview';
}

async function reload() {
  state = await call('getState');
  render();
}

function render() {
  const bal = S.balance(state);
  document.getElementById('account-name').textContent = state.settings.accountName;
  const top = document.getElementById('top-balance');
  top.textContent = state.settings.setupDone ? fmt(bal) : '';
  top.classList.toggle('neg', bal < 0);

  const view = document.getElementById('view');
  charts.forEach((c) => c.destroy());
  charts = [];

  const tabsNav = document.getElementById('tabs');
  if (!state.settings.setupDone) {
    tabsNav.hidden = true;
    view.replaceChildren(setupView());
    return;
  }
  tabsNav.hidden = false;
  const tab = currentTab();
  for (const a of tabsNav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.tab === tab);
  const views = { overview, transactions, recurring, orders, insights, settings };
  view.replaceChildren(views[tab]());
  if (tab === 'insights') drawCharts();
}

// ---------- setup ----------

function setupView() {
  const today = S.ymd(new Date());
  const form = h('form', { class: 'card stack' },
    h('h2', null, 'Open your Fakeazon account'),
    h('p', { class: 'muted' }, 'Pick how much play money you start with and how you get paid. You can change all of this later.'),
    h('div', { class: 'setup-grid' },
      h('label', { class: 'field' }, 'Account name', h('input', { name: 'accountName', value: 'Fakeazon Checking' })),
      h('label', { class: 'field' }, 'Opening balance ($)', h('input', { name: 'opening', type: 'number', min: '0', step: '0.01', value: '500', required: true })),
      h('label', { class: 'field' }, 'Paycheck amount ($)', h('input', { name: 'pay', type: 'number', min: '0', step: '0.01', value: '750', placeholder: 'leave 0 for none' })),
      h('label', { class: 'field' }, 'How often', freqSelect('biweekly')),
      h('label', { class: 'field' }, 'First payday', h('input', { name: 'anchor', type: 'date', value: today, required: true })),
      h('label', { class: 'field' }, 'Sales tax (%)', h('input', { name: 'tax', type: 'number', min: '0', max: '25', step: '0.01', value: '7' }))
    ),
    h('p', { class: 'muted' }, 'Tip: a first payday in the past back-pays every paycheck since then.'),
    h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Open account'))
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(form);
    act(async () => {
      await call('updateSettings', { patch: { taxRate: (parseFloat(f.get('tax')) || 0) / 100 } });
      const pay = dollarsToCents(f.get('pay') || 0);
      if (pay > 0) {
        await call('addRecurring', { rule: { name: 'Paycheck', amount: pay, kind: 'income', freq: f.get('freq'), anchorDate: f.get('anchor') } });
      }
      await call('setup', { accountName: f.get('accountName'), openingBalance: dollarsToCents(f.get('opening') || 0) });
      location.hash = 'overview';
    }, 'Account opened. Happy shopping!');
  });
  return h('div', { class: 'setup' }, form);
}

function freqSelect(selected) {
  return h('select', { name: 'freq' }, S.FREQS.map((f) => h('option', { value: f, selected: f === selected }, FREQ_LABEL[f])));
}

// ---------- overview ----------

function nextOf(kind) {
  return state.recurring
    .filter((r) => r.kind === kind && !r.paused)
    .map((r) => ({ r, date: S.nextOccurrence(r, new Date()) }))
    .filter((x) => x.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
}

function overview() {
  const bal = S.balance(state);
  const mk = S.ymd(new Date()).slice(0, 7);
  const flow = S.insights(state).flow[mk] || { income: 0, shopping: 0, bills: 0, other: 0 };
  const np = nextOf('income');
  const nb = nextOf('bill');
  const recentTx = state.ledger.slice().sort((a, b) => b.ts - a.ts).slice(0, 6);
  const recentOrders = state.orders.slice().sort((a, b) => b.ts - a.ts).slice(0, 3);

  return h('div', { class: 'stack' },
    h('div', { class: 'grid' },
      h('div', { class: 'card' },
        h('div', { class: 'stat-label' }, 'Available balance'),
        h('div', { class: 'hero' + (bal < 0 ? ' neg' : '') }, fmt(bal)),
        h('div', { class: 'stat-sub' }, state.settings.accountName + ' ••••4242')
      ),
      h('div', { class: 'card' },
        h('div', { class: 'stat-label' }, 'Next paycheck'),
        h('div', { class: 'stat-value' }, np ? '+' + fmt(np.r.amount) : '—'),
        h('div', { class: 'stat-sub' }, np ? np.r.name + ' · ' + fmtYmd(np.date) : h('a', { href: '#recurring' }, 'Set one up'))
      ),
      h('div', { class: 'card' },
        h('div', { class: 'stat-label' }, 'This month'),
        h('div', { class: 'stat-value' }, fmt(flow.shopping), h('span', { class: 'stat-sub' }, ' shopping')),
        h('div', { class: 'stat-sub' }, '+' + fmt(flow.income) + ' in · ' + fmt(flow.bills) + ' bills'),
        nb ? h('div', { class: 'stat-sub' }, 'Next bill: ' + nb.r.name + ' ' + fmt(nb.r.amount) + ' on ' + fmtYmd(nb.date)) : null
      )
    ),
    h('div', { class: 'grid' },
      h('div', { class: 'card' },
        h('h3', null, 'Recent activity'),
        recentTx.length ? txTable(recentTx, false) : h('div', { class: 'empty' }, 'No activity yet.'),
        h('p', null, h('a', { href: '#transactions' }, 'All transactions →'))
      ),
      h('div', { class: 'card' },
        h('h3', null, 'Latest orders'),
        recentOrders.length
          ? recentOrders.map((o) => orderMini(o))
          : h('div', { class: 'empty' }, 'Nothing bought yet. ', h('a', { href: 'https://www.amazon.com/' }, 'Go shopping →')),
        recentOrders.length ? h('p', null, h('a', { href: '#orders' }, 'All orders →')) : null
      )
    )
  );
}

function orderMini(o) {
  const first = o.items[0];
  const n = o.items.reduce((a, l) => a + l.qty, 0);
  return h('div', { class: 'order-item' + (o.status === 'returned' ? ' returned' : ''), style: 'margin-bottom:10px' },
    first.image ? h('img', { src: first.image, alt: '' }) : h('div', { class: 'noimg' }),
    h('div', null,
      h('div', null, first.title.length > 70 ? first.title.slice(0, 70) + '…' : first.title),
      h('div', { class: 'stat-sub' }, fmtDate(o.ts) + (n > 1 ? ' · ' + n + ' items' : '') + (o.status === 'returned' ? ' · returned' : ''))
    ),
    h('div', { class: 'num' }, fmt(o.total))
  );
}

// ---------- transactions ----------

function txTable(entries, withRunning) {
  let running = null;
  const rows = entries;
  if (withRunning) {
    // Running balance in chronological order, displayed newest first.
    const chrono = state.ledger.slice().sort((a, b) => a.ts - b.ts);
    running = new Map();
    let acc = 0;
    for (const e of chrono) running.set(e.id, (acc += e.amount));
  }
  return h('div', { class: 'table-wrap' },
    h('table', null,
      h('thead', null, h('tr', null,
        h('th', null, 'Date'), h('th', null, 'Description'), h('th', null, 'Type'),
        h('th', { class: 'num' }, 'Amount'), withRunning ? h('th', { class: 'num' }, 'Balance') : null
      )),
      h('tbody', null, rows.map((e) => h('tr', null,
        h('td', { class: 'muted' }, fmtDate(e.ts)),
        h('td', null, e.memo),
        h('td', null, h('span', { class: 'pill' }, TYPE_LABEL[e.type] || e.type)),
        h('td', { class: 'num' }, signed(e.amount)),
        withRunning ? h('td', { class: 'num' }, fmt(running.get(e.id))) : null
      )))
    )
  );
}

function transactions() {
  const q = txFilter.q.toLowerCase();
  const list = state.ledger
    .filter((e) => (!txFilter.type || e.type === txFilter.type) && (!q || e.memo.toLowerCase().includes(q)))
    .sort((a, b) => b.ts - a.ts);

  const adj = h('form', { class: 'inline' },
    h('label', { class: 'field' }, 'Amount ($)', h('input', { name: 'amt', type: 'number', step: '0.01', min: '0.01', required: true })),
    h('label', { class: 'field' }, 'Note', h('input', { name: 'memo', placeholder: 'Birthday money' })),
    h('button', { class: 'btn primary', type: 'submit', name: 'dir', value: 'in' }, 'Deposit'),
    h('button', { class: 'btn', type: 'submit', name: 'dir', value: 'out' }, 'Withdraw')
  );
  adj.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(adj);
    const cents = dollarsToCents(f.get('amt'));
    const sign = e.submitter && e.submitter.value === 'out' ? -1 : 1;
    act(() => call('adjust', { amount: sign * cents, memo: f.get('memo') }), sign > 0 ? 'Deposited.' : 'Withdrawn.');
  });

  const typeSel = h('select', { onchange: (e) => { txFilter.type = e.target.value; render(); } },
    h('option', { value: '' }, 'All types'),
    Object.entries(TYPE_LABEL).map(([k, v]) => h('option', { value: k, selected: txFilter.type === k }, v))
  );
  const search = h('input', { type: 'search', placeholder: 'Search…', value: txFilter.q });
  search.addEventListener('change', (e) => { txFilter.q = e.target.value; render(); });

  return h('div', { class: 'stack' },
    h('div', { class: 'card' }, h('h3', null, 'Manual deposit or withdrawal'), adj),
    h('div', { class: 'card' },
      h('div', { class: 'order-head' }, h('h2', null, 'Transactions'), h('div', { class: 'form inline' }, typeSel, ' ', search)),
      list.length ? txTable(list, true) : h('div', { class: 'empty' }, 'No transactions match.')
    )
  );
}

// ---------- recurring ----------

function recurring() {
  const form = h('form', { class: 'inline' },
    h('label', { class: 'field' }, 'Name', h('input', { name: 'name', placeholder: 'Day job / Rent', required: true })),
    h('label', { class: 'field' }, 'Type', h('select', { name: 'kind' }, h('option', { value: 'income' }, 'Paycheck (money in)'), h('option', { value: 'bill' }, 'Bill (money out)'))),
    h('label', { class: 'field' }, 'Amount ($)', h('input', { name: 'amt', type: 'number', step: '0.01', min: '0.01', required: true })),
    h('label', { class: 'field' }, 'How often', freqSelect('biweekly')),
    h('label', { class: 'field' }, 'First date', h('input', { name: 'anchor', type: 'date', value: S.ymd(new Date()), required: true })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add')
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(form);
    act(() => call('addRecurring', { rule: {
      name: f.get('name'), kind: f.get('kind'), amount: dollarsToCents(f.get('amt')), freq: f.get('freq'), anchorDate: f.get('anchor'),
    } }), 'Added. Anything already due has been posted.');
  });

  const rows = state.recurring.map((r) => {
    const next = r.paused ? null : S.nextOccurrence(r, new Date());
    return h('tr', null,
      h('td', null, r.name, r.paused ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'paused') : null),
      h('td', null, r.kind === 'income' ? 'Paycheck' : 'Bill'),
      h('td', { class: 'num' }, r.kind === 'income' ? signed(r.amount) : signed(-r.amount)),
      h('td', null, FREQ_LABEL[r.freq]),
      h('td', null, r.paused ? '—' : fmtYmd(next)),
      h('td', null, h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => {
          const v = prompt('New amount for ' + r.name + ' ($):', (r.amount / 100).toFixed(2));
          if (v != null && dollarsToCents(v) > 0) act(() => call('updateRecurring', { id: r.id, patch: { amount: dollarsToCents(v) } }));
        } }, 'Edit'),
        h('button', { class: 'btn small', type: 'button', onclick: () => act(() => call('updateRecurring', { id: r.id, patch: { paused: !r.paused } })) }, r.paused ? 'Resume' : 'Pause'),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => {
          if (confirm('Delete "' + r.name + '"? Past payments stay in your history.')) act(() => call('deleteRecurring', { id: r.id }));
        } }, 'Delete')
      ))
    );
  });

  return h('div', { class: 'stack' },
    h('div', { class: 'card' }, h('h3', null, 'Add a paycheck or bill'), form,
      h('p', { class: 'muted' }, 'A first date in the past back-posts everything since then. Payments post automatically, even while Firefox was closed.')),
    h('div', { class: 'card' },
      h('h2', null, 'Paychecks & bills'),
      state.recurring.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Amount'), h('th', null, 'Schedule'), h('th', null, 'Next'), h('th', null, ''))),
            h('tbody', null, rows)))
        : h('div', { class: 'empty' }, 'Nothing scheduled. Add a paycheck above.')
    )
  );
}

// ---------- orders ----------

function orders() {
  const list = state.orders.slice().sort((a, b) => b.ts - a.ts);
  if (!list.length) {
    return h('div', { class: 'card empty' }, 'No orders yet. ', h('a', { href: 'https://www.amazon.com/' }, 'Go shopping →'));
  }
  return h('div', { class: 'stack' }, list.map((o) => {
    const returned = o.status === 'returned';
    return h('div', { class: 'card order' + (returned ? ' returned' : '') },
      h('div', { class: 'order-head' },
        h('div', null, h('b', null, fmtDate(o.ts)), h('span', { class: 'muted' }, ' · Order # ' + o.id)),
        h('div', null,
          h('b', { class: 'num' }, fmt(o.total)),
          ' ',
          returned
            ? h('span', { class: 'pill' }, 'Returned ' + fmtDate(o.returnedTs))
            : h('button', { class: 'btn small', type: 'button', onclick: () => {
                if (confirm('Return this order and refund ' + fmt(o.total) + '?')) act(() => call('returnOrder', { orderId: o.id }), 'Refunded.');
              } }, 'Return')
        )
      ),
      h('div', { class: 'order-items' }, o.items.map((l) => h('div', { class: 'order-item' },
        l.image ? h('img', { src: l.image, alt: '' }) : h('div', { class: 'noimg' }),
        h('div', null,
          h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.title),
          h('div', { class: 'stat-sub' },
            h('span', { class: 'pill' }, l.category), ' ',
            l.wasDeal ? h('span', { class: 'pill deal' }, 'Deal') : null, ' ',
            l.listPrice && l.listPrice > l.price ? 'List ' + fmt(l.listPrice) + ', saved ' + fmt((l.listPrice - l.price) * l.qty) : null
          )
        ),
        h('div', { class: 'num' }, (l.qty > 1 ? l.qty + ' × ' : '') + fmt(l.price))
      ))),
      h('div', { class: 'stat-sub' }, 'Items ' + fmt(o.subtotal) + ' + tax ' + fmt(o.tax))
    );
  }));
}

// ---------- insights ----------

function lastMonths(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0'));
  }
  return out;
}

function insights() {
  const I = S.insights(state);
  if (!state.orders.length && !state.ledger.length) return h('div', { class: 'card empty' }, 'No data yet.');

  const months = lastMonths(12);
  const cats = Object.entries(I.byCategory).sort((a, b) => b[1] - a[1]);
  const maxHeat = Math.max(1, ...I.heat.flat());
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const step = (v) => (v === 0 ? 0 : Math.min(5, 1 + Math.floor((v / maxHeat) * 4.999)));

  const heat = h('div', { class: 'heat', role: 'img', 'aria-label': 'Orders by day of week and hour' },
    h('div'),
    Array.from({ length: 24 }, (_, hr) => h('div', { class: 'hr' }, hr % 6 === 0 ? (hr === 0 ? '12a' : hr === 12 ? '12p' : hr < 12 ? hr + 'a' : hr - 12 + 'p') : '')),
    days.map((d, di) => [
      h('div', { class: 'lbl' }, d),
      I.heat[di].map((v, hr) => h('div', {
        class: 'cell',
        style: 'background:var(--seq-' + step(v) + ')',
        title: d + ' ' + hr + ':00 · ' + v + ' order' + (v === 1 ? '' : 's'),
      })),
    ])
  );

  return h('div', { class: 'stack' },
    h('div', { class: 'grid' },
      tile('Total spent', fmt(I.totalSpent), I.orderCount + ' orders · ' + I.itemCount + ' items'),
      tile('Average order', fmt(I.avgOrder), I.returnedCount ? I.returnedCount + ' returned' : 'no returns'),
      tile('Saved vs list price', fmt(I.savings), I.dealItems + ' deal item' + (I.dealItems === 1 ? '' : 's')),
      tile('Biggest splurge', I.biggest ? fmt(I.biggest.total) : '—', I.biggest ? I.biggest.items[0].title.slice(0, 48) + (I.biggest.items[0].title.length > 48 ? '…' : '') : '')
    ),
    h('div', { class: 'card' },
      h('h3', null, 'Money in and out, last 12 months'),
      h('div', { class: 'legend' },
        h('span', null, h('i', { style: 'background:var(--series-1)' }), 'Income'),
        h('span', null, h('i', { style: 'background:var(--series-2)' }), 'Shopping'),
        h('span', null, h('i', { style: 'background:var(--series-3)' }), 'Bills')
      ),
      h('div', { class: 'chart-box' }, h('canvas', { id: 'chart-flow', 'aria-label': 'Monthly income, shopping and bills' })),
      h('details', null, h('summary', null, 'Show as table'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Month'), h('th', { class: 'num' }, 'Income'), h('th', { class: 'num' }, 'Shopping'), h('th', { class: 'num' }, 'Bills'))),
          h('tbody', null, months.map((m) => {
            const f = I.flow[m] || { income: 0, shopping: 0, bills: 0 };
            return h('tr', null, h('td', null, monthLabel(m)), h('td', { class: 'num' }, fmt(f.income)), h('td', { class: 'num' }, fmt(f.shopping)), h('td', { class: 'num' }, fmt(f.bills)));
          }))
        )))
    ),
    h('div', { class: 'grid' },
      h('div', { class: 'card' },
        h('h3', null, 'Spending by category'),
        cats.length
          ? h('div', { class: 'chart-box', style: 'height:' + Math.max(160, cats.length * 34 + 40) + 'px' }, h('canvas', { id: 'chart-cats', 'aria-label': 'Spending by category' }))
          : h('div', { class: 'empty' }, 'No purchases yet.'),
        cats.length ? h('details', null, h('summary', null, 'Show as table'),
          h('table', null, h('tbody', null, cats.map(([c, v]) => h('tr', null, h('td', null, c), h('td', { class: 'num' }, fmt(v))))))) : null
      ),
      h('div', { class: 'card' },
        h('h3', null, 'When you shop'),
        heat,
        h('div', { class: 'heat-scale' }, 'fewer', [1, 2, 3, 4, 5].map((i) => h('span', { class: 'cell', style: 'background:var(--seq-' + i + ')' })), 'more orders')
      )
    )
  );
}

function tile(label, value, sub) {
  return h('div', { class: 'card' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-sub' }, sub));
}

function drawCharts() {
  const Chart = globalThis.Chart;
  if (!Chart) return;
  const I = S.insights(state);
  const ink = cssVar('--text-secondary');
  const grid = cssVar('--line');
  const money = (v) => fmt(Math.round(v * 100));
  Chart.defaults.color = ink;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  const flowEl = document.getElementById('chart-flow');
  if (flowEl) {
    const months = lastMonths(12);
    const series = [
      ['Income', 'income', '--series-1'],
      ['Shopping', 'shopping', '--series-2'],
      ['Bills', 'bills', '--series-3'],
    ];
    charts.push(new Chart(flowEl, {
      type: 'bar',
      data: {
        labels: months.map(monthLabel),
        datasets: series.map(([label, key, v]) => ({
          label,
          data: months.map((m) => ((I.flow[m] || {})[key] || 0) / 100),
          backgroundColor: cssVar(v),
          borderRadius: 4,
          borderSkipped: 'start',
          borderWidth: 0,
          categoryPercentage: 0.7,
          barPercentage: 0.9,
        })),
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + money(c.parsed.y) } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { callback: (v) => money(v) } },
        },
      },
    }));
  }

  const catEl = document.getElementById('chart-cats');
  if (catEl) {
    const cats = Object.entries(I.byCategory).sort((a, b) => b[1] - a[1]);
    charts.push(new Chart(catEl, {
      type: 'bar',
      data: {
        labels: cats.map((c) => c[0]),
        datasets: [{ label: 'Spent', data: cats.map((c) => c[1] / 100), backgroundColor: cssVar('--series-1'), borderRadius: 4, borderSkipped: 'start', barPercentage: 0.8 }],
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.parsed.x) } } },
        scales: {
          x: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { callback: (v) => money(v) } },
          y: { grid: { display: false } },
        },
      },
    }));
  }
}

// ---------- settings ----------

function settings() {
  const s = state.settings;
  const form = h('form', { class: 'stack' },
    h('label', { class: 'field' }, 'Account name', h('input', { name: 'accountName', value: s.accountName })),
    h('label', { class: 'field' }, 'Sales tax (%)', h('input', { name: 'tax', type: 'number', min: '0', max: '25', step: '0.01', value: String(Math.round(s.taxRate * 10000) / 100) })),
    h('label', { class: 'field', style: 'display:flex;gap:8px;align-items:center' },
      h('input', { name: 'clear', type: 'checkbox', checked: s.clearCartAfterPurchase }),
      'Remove bought items from the Amazon cart after a fake checkout'),
    h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Save'))
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(form);
    act(() => call('updateSettings', { patch: {
      accountName: f.get('accountName'),
      taxRate: (parseFloat(f.get('tax')) || 0) / 100,
      clearCartAfterPurchase: f.get('clear') === 'on',
    } }), 'Saved.');
  });

  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files[0];
    if (!file) return;
    const text = await file.text();
    if (confirm('Replace everything in Fakeazon with this backup?')) act(() => call('importData', { text }), 'Backup restored.');
    fileIn.value = '';
  });

  return h('div', { class: 'stack' },
    h('div', { class: 'card' }, h('h2', null, 'Settings'), form),
    h('div', { class: 'card' },
      h('h3', null, 'Backup'),
      h('p', { class: 'muted' }, 'Your fake bank lives inside this Firefox profile. Export a backup now and then.'),
      h('div', { class: 'row-actions', style: 'justify-content:flex-start' },
        h('button', { class: 'btn', type: 'button', onclick: exportBackup }, 'Export backup (.json)'),
        h('button', { class: 'btn', type: 'button', onclick: () => fileIn.click() }, 'Import backup…'),
        fileIn
      )
    ),
    h('div', { class: 'card' },
      h('h3', null, 'Start over'),
      h('p', { class: 'muted' }, 'Deletes all transactions, orders and schedules.'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => {
        if (prompt('Type RESET to wipe your Fakeazon bank:') === 'RESET') act(() => call('reset'), 'Wiped.');
      } }, 'Reset everything')
    )
  );
}

async function exportBackup() {
  const text = await call('exportData');
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: 'fakeazon-backup-' + S.ymd(new Date()) + '.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- permission banner ----------

async function checkPermission() {
  const banner = document.getElementById('perm-banner');
  const ok = await browser.permissions.contains({ origins: AMAZON });
  banner.hidden = ok;
}

document.getElementById('perm-grant').addEventListener('click', async () => {
  await browser.permissions.request({ origins: AMAZON });
  checkPermission();
});

// ---------- boot ----------

window.addEventListener('hashchange', render);

// Another tab changed something (e.g. a purchase): refresh, but don't yank a
// form out from under someone typing; wait until they leave the field.
let reloadTimer = null;
let pendingReload = false;
const typing = () => document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
browser.storage.onChanged.addListener(() => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (typing()) pendingReload = true;
    else reload();
  }, 300);
});
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (pendingReload && !typing()) {
      pendingReload = false;
      reload();
    }
  }, 0);
});

checkPermission();
reload().catch((e) => {
  document.getElementById('view').textContent = 'Could not load: ' + e.message;
});
