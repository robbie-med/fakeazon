/* Fakeazon data layer.
 *
 * Pure functions over a single state object, so the same file runs in the
 * extension (background + bank page, as a classic script exposing
 * globalThis.FakeazonStore) and under `node --test` (via module.exports).
 *
 * Money is always integer cents. Dates for recurring rules are local
 * 'YYYY-MM-DD' strings. The balance is never stored: it is sum(ledger).
 */
(function (root) {
  'use strict';

  const SCHEMA = 1;
  const FREQS = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

  function emptyState() {
    return {
      schema: SCHEMA,
      ledger: [],
      recurring: [],
      orders: [],
      asinMeta: {},
      settings: {
        setupDone: false,
        accountName: 'Fakeazon Checking',
        taxRate: 0.07,
        clearCartAfterPurchase: true,
      },
    };
  }

  // Fill in anything missing (older exports, partial imports).
  function normalize(s) {
    const base = emptyState();
    if (!s || typeof s !== 'object') return base;
    return {
      schema: SCHEMA,
      ledger: Array.isArray(s.ledger) ? s.ledger : [],
      recurring: Array.isArray(s.recurring) ? s.recurring : [],
      orders: Array.isArray(s.orders) ? s.orders : [],
      asinMeta: s.asinMeta && typeof s.asinMeta === 'object' ? s.asinMeta : {},
      settings: Object.assign(base.settings, s.settings || {}),
    };
  }

  // ---------- ids, dates, money ----------

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function fakeOrderNumber() {
    const d = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
    return '1' + d(2) + '-' + d(7) + '-' + d(7);
  }

  const pad = (n) => String(n).padStart(2, '0');

  function ymd(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  // Local noon avoids DST edge cases when adding days.
  function parseYmd(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }

  function addDays(s, n) {
    const d = parseYmd(s);
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function daysInMonth(y, m0) {
    return new Date(y, m0 + 1, 0).getDate();
  }

  // "$1,234.56" / "1234.56" / "1.234,56"-free US formats -> cents. null if unparseable.
  function parsePrice(text) {
    if (text == null) return null;
    const m = String(text).replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    return Math.round(parseFloat(m[1]) * 100);
  }

  function fmt(cents) {
    const neg = cents < 0;
    const s = (Math.abs(cents) / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
    });
    return neg ? '-' + s : s;
  }

  // ---------- balance ----------

  function balance(state) {
    return state.ledger.reduce((a, e) => a + e.amount, 0);
  }

  function post(state, entry) {
    const e = Object.assign({ id: uid('tx'), ts: Date.now() }, entry);
    state.ledger.push(e);
    return e;
  }

  // ---------- recurring ----------

  // All occurrence dates of `rule` with afterExclusive < date <= throughInclusive.
  function occurrences(rule, afterExclusive, throughInclusive) {
    const out = [];
    const anchor = rule.anchorDate;
    const lo = afterExclusive && afterExclusive >= anchor ? afterExclusive : addDays(anchor, -1);
    if (throughInclusive < anchor) return out;

    if (rule.freq === 'weekly' || rule.freq === 'biweekly') {
      const step = rule.freq === 'weekly' ? 7 : 14;
      // Jump close to `lo` instead of walking from the anchor.
      const gap = Math.floor((parseYmd(lo) - parseYmd(anchor)) / 86400000);
      let k = Math.max(0, Math.floor(gap / step));
      for (;;) {
        const d = addDays(anchor, k * step);
        if (d > throughInclusive) break;
        if (d > lo) out.push(d);
        k++;
      }
      return out;
    }

    // Month-based: walk month by month from the anchor's month.
    const a = parseYmd(anchor);
    const anchorDay = a.getDate();
    let y = a.getFullYear();
    let m = a.getMonth();
    for (;;) {
      const dim = daysInMonth(y, m);
      const days =
        rule.freq === 'monthly'
          ? [Math.min(anchorDay, dim)]
          : [15, dim]; // semimonthly: the 15th and the last day, like most payroll
      let past = false;
      for (const day of days) {
        const d = y + '-' + pad(m + 1) + '-' + pad(day);
        if (d > throughInclusive) {
          past = true;
          break;
        }
        if (d >= anchor && d > lo) out.push(d);
      }
      if (past) break;
      m++;
      if (m === 12) {
        m = 0;
        y++;
      }
    }
    return out;
  }

  function nextOccurrence(rule, now) {
    const today = ymd(now);
    const hits = occurrences(rule, today, addDays(today, 400));
    return hits.length ? hits[0] : null;
  }

  // Post every due occurrence up to today. Idempotent: an occurrence is keyed by
  // rule id + date, and postedThrough moves forward. Returns the entries posted.
  function processRecurring(state, now) {
    const today = ymd(now || new Date());
    const seen = new Set(
      state.ledger.filter((e) => e.recurringId).map((e) => e.recurringId + ':' + e.date)
    );
    const posted = [];
    for (const rule of state.recurring) {
      if (rule.paused) continue;
      for (const date of occurrences(rule, rule.postedThrough || null, today)) {
        if (seen.has(rule.id + ':' + date)) continue;
        const ts = parseYmd(date);
        ts.setHours(9, 0, 0, 0);
        posted.push(
          post(state, {
            ts: ts.getTime(),
            type: rule.kind === 'income' ? 'paycheck' : 'bill',
            amount: rule.kind === 'income' ? Math.abs(rule.amount) : -Math.abs(rule.amount),
            memo: rule.name,
            recurringId: rule.id,
            date,
          })
        );
      }
      if (!rule.postedThrough || rule.postedThrough < today) rule.postedThrough = today;
    }
    return posted;
  }

  function addRecurring(state, r) {
    if (!FREQS.includes(r.freq)) throw new Error('bad freq: ' + r.freq);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.anchorDate || '')) throw new Error('bad anchorDate');
    const amount = Math.abs(Math.round(r.amount));
    if (!amount) throw new Error('amount must be > 0');
    const rule = {
      id: uid('rec'),
      name: (r.name || '').trim() || (r.kind === 'income' ? 'Paycheck' : 'Bill'),
      amount,
      kind: r.kind === 'bill' ? 'bill' : 'income',
      freq: r.freq,
      anchorDate: r.anchorDate,
      postedThrough: null,
      paused: false,
    };
    state.recurring.push(rule);
    return rule;
  }

  function updateRecurring(state, id, patch) {
    const rule = state.recurring.find((r) => r.id === id);
    if (!rule) throw new Error('no such rule');
    for (const k of ['name', 'paused']) if (k in patch) rule[k] = patch[k];
    if ('amount' in patch) rule.amount = Math.abs(Math.round(patch.amount));
    return rule;
  }

  // Deleting a rule stops future postings; past ledger entries stay (they happened).
  function deleteRecurring(state, id) {
    state.recurring = state.recurring.filter((r) => r.id !== id);
  }

  // ---------- setup / manual ----------

  function setup(state, { accountName, openingBalance }, now) {
    if (accountName) state.settings.accountName = accountName.trim();
    if (openingBalance) {
      post(state, {
        ts: (now || new Date()).getTime(),
        type: 'adjust',
        amount: Math.round(openingBalance),
        memo: 'Opening deposit',
      });
    }
    state.settings.setupDone = true;
  }

  function adjust(state, amount, memo, now) {
    if (!Math.round(amount)) throw new Error('amount must be non-zero');
    return post(state, {
      ts: (now || new Date()).getTime(),
      type: 'adjust',
      amount: Math.round(amount),
      memo: memo || (amount > 0 ? 'Deposit' : 'Withdrawal'),
    });
  }

  // ---------- shopping ----------

  function cacheAsin(state, meta) {
    if (!meta || !meta.asin) return;
    const prev = state.asinMeta[meta.asin] || {};
    const next = Object.assign({}, prev);
    for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') next[k] = v;
    next.ts = Date.now();
    state.asinMeta[meta.asin] = next;
  }

  function priceCart(state, items) {
    const lines = items.map((it) => {
      const meta = state.asinMeta[it.asin] || {};
      return {
        asin: it.asin,
        title: it.title || meta.title || it.asin,
        price: it.price != null ? it.price : meta.price,
        listPrice: it.listPrice != null ? it.listPrice : meta.listPrice || null,
        qty: Math.max(1, it.qty || 1),
        image: it.image || meta.image || '',
        category: it.category || meta.category || 'Uncategorized',
        subcategory: it.subcategory || meta.subcategory || '',
        url: it.url || meta.url || 'https://www.amazon.com/dp/' + it.asin,
        wasDeal: !!(it.wasDeal || meta.wasDeal),
      };
    });
    const bad = lines.filter((l) => !(l.price > 0));
    const subtotal = lines.reduce((a, l) => a + (l.price || 0) * l.qty, 0);
    const tax = Math.round(subtotal * (state.settings.taxRate || 0));
    return { lines, unpriced: bad.map((l) => l.asin), subtotal, tax, total: subtotal + tax };
  }

  function placeOrder(state, items, now) {
    if (!items || !items.length) return { ok: false, reason: 'empty_cart' };
    const quote = priceCart(state, items);
    if (quote.unpriced.length) return { ok: false, reason: 'unpriced', asins: quote.unpriced };
    const bal = balance(state);
    if (quote.total > bal) {
      return { ok: false, reason: 'insufficient_funds', shortBy: quote.total - bal, balance: bal, quote };
    }
    const ts = (now || new Date()).getTime();
    const order = {
      id: fakeOrderNumber(),
      ts,
      items: quote.lines,
      subtotal: quote.subtotal,
      tax: quote.tax,
      total: quote.total,
      status: 'placed',
    };
    state.orders.push(order);
    const n = order.items.reduce((a, l) => a + l.qty, 0);
    post(state, {
      ts,
      type: 'purchase',
      amount: -order.total,
      memo: 'Amazon order ' + order.id + ' (' + n + ' item' + (n === 1 ? '' : 's') + ')',
      orderId: order.id,
    });
    return { ok: true, order, balance: balance(state) };
  }

  function returnOrder(state, orderId, now) {
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new Error('no such order');
    if (order.status === 'returned') return order;
    order.status = 'returned';
    order.returnedTs = (now || new Date()).getTime();
    post(state, {
      ts: order.returnedTs,
      type: 'refund',
      amount: order.total,
      memo: 'Refund for order ' + order.id,
      orderId: order.id,
    });
    return order;
  }

  // ---------- insights ----------

  function monthKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  function insights(state) {
    const kept = state.orders.filter((o) => o.status !== 'returned');
    const byCategory = {};
    const byMonthShopping = {};
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
    let savings = 0;
    let dealItems = 0;
    let itemCount = 0;
    let biggest = null;

    for (const o of kept) {
      const mk = monthKey(o.ts);
      byMonthShopping[mk] = (byMonthShopping[mk] || 0) + o.total;
      const d = new Date(o.ts);
      heat[d.getDay()][d.getHours()]++;
      if (!biggest || o.total > biggest.total) biggest = o;
      for (const l of o.items) {
        byCategory[l.category] = (byCategory[l.category] || 0) + l.price * l.qty;
        itemCount += l.qty;
        if (l.listPrice && l.listPrice > l.price) savings += (l.listPrice - l.price) * l.qty;
        if (l.wasDeal) dealItems += l.qty;
      }
    }

    // Cash flow per month straight from the ledger.
    const flow = {};
    for (const e of state.ledger) {
      const mk = monthKey(e.ts);
      const f = (flow[mk] = flow[mk] || { income: 0, bills: 0, shopping: 0, other: 0 });
      if (e.type === 'paycheck') f.income += e.amount;
      else if (e.type === 'bill') f.bills += -e.amount;
      else if (e.type === 'purchase' || e.type === 'refund') f.shopping += -e.amount;
      else if (e.type === 'adjust') {
        if (e.amount > 0) f.income += e.amount;
        else f.other += -e.amount;
      }
    }

    const totalSpent = kept.reduce((a, o) => a + o.total, 0);
    return {
      orderCount: kept.length,
      returnedCount: state.orders.length - kept.length,
      itemCount,
      totalSpent,
      avgOrder: kept.length ? Math.round(totalSpent / kept.length) : 0,
      biggest,
      savings,
      dealItems,
      byCategory,
      byMonthShopping,
      flow,
      heat,
    };
  }

  // ---------- import / export ----------

  function exportJSON(state) {
    return JSON.stringify({ app: 'fakeazon', exportedAt: new Date().toISOString(), state }, null, 2);
  }

  function importJSON(text) {
    const obj = JSON.parse(text);
    if (!obj || obj.app !== 'fakeazon' || !obj.state) throw new Error('Not a Fakeazon export');
    return normalize(obj.state);
  }

  const api = {
    SCHEMA,
    FREQS,
    emptyState,
    normalize,
    ymd,
    parseYmd,
    addDays,
    parsePrice,
    fmt,
    balance,
    occurrences,
    nextOccurrence,
    processRecurring,
    addRecurring,
    updateRecurring,
    deleteRecurring,
    setup,
    adjust,
    cacheAsin,
    priceCart,
    placeOrder,
    returnOrder,
    insights,
    exportJSON,
    importJSON,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FakeazonStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
