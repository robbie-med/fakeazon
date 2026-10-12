const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/store.js');

const at = (s, h = 12) => {
  const d = S.parseYmd(s);
  d.setHours(h);
  return d;
};

test('parsePrice handles Amazon formats', () => {
  assert.equal(S.parsePrice('$1,234.56'), 123456);
  assert.equal(S.parsePrice('$19.99'), 1999);
  assert.equal(S.parsePrice('24'), 2400);
  assert.equal(S.parsePrice('19.9'), 1990);
  assert.equal(S.parsePrice(''), null);
  assert.equal(S.parsePrice(null), null);
});

test('weekly and biweekly occurrences', () => {
  const r = { freq: 'biweekly', anchorDate: '2026-09-21' };
  assert.deepEqual(S.occurrences(r, null, '2026-10-12'), ['2026-09-21', '2026-10-05']);
  assert.deepEqual(S.occurrences(r, '2026-10-05', '2026-10-19'), ['2026-10-19']);
  const w = { freq: 'weekly', anchorDate: '2026-10-01' };
  assert.deepEqual(S.occurrences(w, '2026-10-01', '2026-10-22'), ['2026-10-08', '2026-10-15', '2026-10-22']);
  assert.deepEqual(S.occurrences(w, null, '2026-09-30'), []);
});

test('monthly clamps to month end', () => {
  const r = { freq: 'monthly', anchorDate: '2026-01-31' };
  assert.deepEqual(S.occurrences(r, null, '2026-04-30'), [
    '2026-01-31',
    '2026-02-28',
    '2026-03-31',
    '2026-04-30',
  ]);
  const leap = { freq: 'monthly', anchorDate: '2028-01-30' };
  assert.deepEqual(S.occurrences(leap, '2028-01-30', '2028-02-29'), ['2028-02-29']);
});

test('semimonthly is the 15th and last day, from the anchor on', () => {
  const r = { freq: 'semimonthly', anchorDate: '2026-01-20' };
  assert.deepEqual(S.occurrences(r, null, '2026-03-01'), ['2026-01-31', '2026-02-15', '2026-02-28']);
  assert.deepEqual(S.occurrences(r, '2026-02-15', '2026-02-27'), []);
});

test('processRecurring catches up and is idempotent', () => {
  const st = S.emptyState();
  S.setup(st, { openingBalance: 100000 }, at('2026-09-01'));
  S.addRecurring(st, { name: 'Job', amount: 50000, kind: 'income', freq: 'biweekly', anchorDate: '2026-09-21' });
  S.addRecurring(st, { name: 'Rent', amount: 30000, kind: 'bill', freq: 'monthly', anchorDate: '2026-10-01' });

  const posted = S.processRecurring(st, at('2026-10-12'));
  assert.equal(posted.length, 3); // 2 paychecks + 1 rent
  assert.equal(S.balance(st), 100000 + 2 * 50000 - 30000);

  assert.equal(S.processRecurring(st, at('2026-10-12')).length, 0);
  assert.equal(S.processRecurring(st, at('2026-10-18')).length, 0);
  assert.equal(S.processRecurring(st, at('2026-10-19')).length, 1);
  assert.equal(S.balance(st), 100000 + 3 * 50000 - 30000);

  // Even if postedThrough were lost, the ledger keys prevent double posting.
  for (const r of st.recurring) r.postedThrough = null;
  assert.equal(S.processRecurring(st, at('2026-10-19')).length, 0);
});

test('paused rules do not post', () => {
  const st = S.emptyState();
  const r = S.addRecurring(st, { amount: 100, kind: 'income', freq: 'weekly', anchorDate: '2026-10-01' });
  S.updateRecurring(st, r.id, { paused: true });
  assert.equal(S.processRecurring(st, at('2026-10-20')).length, 0);
});

test('nextOccurrence is strictly after today', () => {
  const r = { freq: 'biweekly', anchorDate: '2026-09-21' };
  assert.equal(S.nextOccurrence(r, at('2026-10-05')), '2026-10-19');
  assert.equal(S.nextOccurrence(r, at('2026-10-04')), '2026-10-05');
});

test('placeOrder declines on insufficient funds and charges tax otherwise', () => {
  const st = S.emptyState();
  st.settings.taxRate = 0.1;
  S.setup(st, { openingBalance: 5000 }, at('2026-10-01'));

  const big = S.placeOrder(st, [{ asin: 'B1', title: 'TV', price: 49999, qty: 1 }]);
  assert.equal(big.ok, false);
  assert.equal(big.reason, 'insufficient_funds');
  assert.equal(big.shortBy, 54999 - 5000);
  assert.equal(st.orders.length, 0);
  assert.equal(S.balance(st), 5000);

  const ok = S.placeOrder(st, [{ asin: 'B2', title: 'Mug', price: 1000, qty: 2 }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.order.total, 2200);
  assert.equal(S.balance(st), 2800);
  assert.match(ok.order.id, /^1\d\d-\d{7}-\d{7}$/);
});

test('placeOrder fills category from cached asin meta and refuses unpriced items', () => {
  const st = S.emptyState();
  S.setup(st, { openingBalance: 100000 });
  S.cacheAsin(st, { asin: 'B3', category: 'Kitchen', listPrice: 3000, wasDeal: true });
  const r = S.placeOrder(st, [{ asin: 'B3', title: 'Pan', price: 2000, qty: 1 }]);
  assert.equal(r.order.items[0].category, 'Kitchen');
  assert.equal(r.order.items[0].listPrice, 3000);
  assert.equal(r.order.items[0].wasDeal, true);

  const u = S.placeOrder(st, [{ asin: 'B4', title: '?', qty: 1 }]);
  assert.equal(u.ok, false);
  assert.equal(u.reason, 'unpriced');
});

test('returnOrder refunds once', () => {
  const st = S.emptyState();
  st.settings.taxRate = 0;
  S.setup(st, { openingBalance: 10000 });
  const { order } = S.placeOrder(st, [{ asin: 'B5', price: 4000 }]);
  assert.equal(S.balance(st), 6000);
  S.returnOrder(st, order.id);
  S.returnOrder(st, order.id);
  assert.equal(S.balance(st), 10000);
  assert.equal(st.ledger.filter((e) => e.type === 'refund').length, 1);
});

test('insights aggregate kept orders, savings and cash flow', () => {
  const st = S.emptyState();
  st.settings.taxRate = 0;
  S.setup(st, { openingBalance: 100000 }, at('2026-10-01'));
  S.cacheAsin(st, { asin: 'A', category: 'Books', listPrice: 2000 });
  S.placeOrder(st, [{ asin: 'A', price: 1500, qty: 2 }], at('2026-10-02', 21));
  const { order } = S.placeOrder(st, [{ asin: 'B', price: 9000, category: 'Toys' }], at('2026-10-03'));
  S.returnOrder(st, order.id, at('2026-10-04'));

  const i = S.insights(st);
  assert.equal(i.orderCount, 1);
  assert.equal(i.returnedCount, 1);
  assert.deepEqual(i.byCategory, { Books: 3000 });
  assert.equal(i.savings, 1000);
  assert.equal(i.byMonthShopping['2026-10'], 3000);
  assert.equal(i.flow['2026-10'].income, 100000);
  assert.equal(i.flow['2026-10'].shopping, 3000);
  assert.equal(i.heat[S.parseYmd('2026-10-02').getDay()][21], 1);
});

test('export / import round-trips and rejects junk', () => {
  const st = S.emptyState();
  S.setup(st, { openingBalance: 1234 });
  const back = S.importJSON(S.exportJSON(st));
  assert.equal(S.balance(back), 1234);
  assert.throws(() => S.importJSON('{"foo":1}'));
});
