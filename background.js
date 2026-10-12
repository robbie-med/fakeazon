/* Fakeazon background (MV3 event page). The single writer of extension state:
 * content scripts and the bank page send messages here, and every mutation runs
 * through one queue so two tabs can't clobber each other. */
'use strict';

const S = globalThis.FakeazonStore;
const KEY = 'state';
const BANK_URL = browser.runtime.getURL('bank/bank.html');

async function load() {
  const got = await browser.storage.local.get(KEY);
  return S.normalize(got[KEY]);
}

async function save(state) {
  await browser.storage.local.set({ [KEY]: state });
}

let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(async () => {
    const state = await load();
    const before = JSON.stringify(state);
    const result = await fn(state);
    // Skip no-op writes: pages listen to storage.onChanged and re-read summaries.
    if (JSON.stringify(state) !== before) await save(state);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

function catchUp() {
  return mutate((state) => S.processRecurring(state, new Date()).length);
}

function summary(state) {
  const income = state.recurring
    .filter((r) => r.kind === 'income' && !r.paused)
    .map((r) => ({ name: r.name, date: S.nextOccurrence(r, new Date()), amount: r.amount }))
    .filter((x) => x.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    balance: S.balance(state),
    setupDone: state.settings.setupDone,
    accountName: state.settings.accountName,
    taxRate: state.settings.taxRate,
    clearCartAfterPurchase: state.settings.clearCartAfterPurchase,
    nextPaycheck: income[0] || null,
  };
}

async function openBank(hash) {
  const url = BANK_URL + (hash ? '#' + hash : '');
  const tabs = await browser.tabs.query({ url: BANK_URL + '*' });
  if (tabs.length) {
    await browser.tabs.update(tabs[0].id, { active: true, url });
    await browser.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
}

const handlers = {
  // --- reads ---
  async getSummary() {
    await catchUp();
    return summary(await load());
  },
  async getState() {
    await catchUp();
    return load();
  },
  async quote({ items }) {
    const state = await load();
    return Object.assign(S.priceCart(state, items), { summary: summary(state) });
  },

  // --- shopping ---
  cacheAsin({ meta }) {
    return mutate((state) => S.cacheAsin(state, meta));
  },
  async placeOrder({ items }) {
    await catchUp();
    return mutate((state) => {
      const r = S.placeOrder(state, items, new Date());
      return Object.assign(r, { summary: summary(state) });
    });
  },
  returnOrder({ orderId }) {
    return mutate((state) => S.returnOrder(state, orderId, new Date()));
  },

  // --- bank ---
  setup({ accountName, openingBalance }) {
    return mutate((state) => S.setup(state, { accountName, openingBalance }, new Date()));
  },
  adjust({ amount, memo }) {
    return mutate((state) => S.adjust(state, amount, memo, new Date()));
  },
  async addRecurring({ rule }) {
    const r = await mutate((state) => S.addRecurring(state, rule));
    await catchUp();
    return r;
  },
  updateRecurring({ id, patch }) {
    return mutate((state) => S.updateRecurring(state, id, patch));
  },
  deleteRecurring({ id }) {
    return mutate((state) => S.deleteRecurring(state, id));
  },
  updateSettings({ patch }) {
    return mutate((state) => {
      if ('taxRate' in patch) state.settings.taxRate = Math.max(0, Math.min(0.25, Number(patch.taxRate) || 0));
      if ('accountName' in patch) state.settings.accountName = String(patch.accountName).trim() || 'Fakeazon Checking';
      if ('clearCartAfterPurchase' in patch) state.settings.clearCartAfterPurchase = !!patch.clearCartAfterPurchase;
      return state.settings;
    });
  },
  async exportData() {
    return S.exportJSON(await load());
  },
  importData({ text }) {
    const next = S.importJSON(text);
    return mutate((state) => {
      Object.assign(state, next);
      return true;
    });
  },
  reset() {
    return mutate((state) => {
      Object.assign(state, S.emptyState());
      return true;
    });
  },

  // --- navigation ---
  openBank({ hash }) {
    return openBank(hash);
  },
};

browser.runtime.onMessage.addListener((msg) => {
  const h = msg && handlers[msg.op];
  if (!h) return undefined;
  return Promise.resolve()
    .then(() => h(msg))
    .then(
      (value) => ({ ok: true, value }),
      (err) => ({ ok: false, error: String((err && err.message) || err) })
    );
});

browser.action.onClicked.addListener(() => openBank());

browser.runtime.onInstalled.addListener(() => {
  browser.alarms.create('recurring', { periodInMinutes: 60 });
  catchUp();
});
browser.runtime.onStartup.addListener(() => {
  browser.alarms.create('recurring', { periodInMinutes: 60 });
  catchUp();
});
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === 'recurring') catchUp();
});
