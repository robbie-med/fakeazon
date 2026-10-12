/* Fakeazon content script for amazon.com.
 * - Remembers product details (price, list price, category) as you browse.
 * - Intercepts "Proceed to checkout" / "Buy Now" and shows a fake checkout
 *   that pays from the Fakeazon bank instead.
 * - Shows a balance chip in the corner.
 * Runs at document_start so the capture-phase listeners are in place before
 * Amazon's own handlers. */
(function () {
  'use strict';
  if (window.top !== window) return;

  const SEL = globalThis.FKZ_SEL;
  const ROOT_ID = 'fkz-root';
  const CLEAR_KEY = 'fkz-clear-asins';

  // ---------- messaging ----------

  async function call(op, args) {
    const r = await browser.runtime.sendMessage(Object.assign({ op }, args || {}));
    if (!r) throw new Error('Fakeazon background did not answer');
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }

  // ---------- helpers ----------

  function fmt(cents) {
    const s = (Math.abs(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    return cents < 0 ? '-' + s : s;
  }

  function parsePrice(text) {
    if (text == null) return null;
    const m = String(text).replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
    return m ? Math.round(parseFloat(m[1]) * 100) : null;
  }

  function first(root, list) {
    for (const s of [].concat(list)) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function clean(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  // Tiny element builder: h('div', {class: 'x', onclick}, child, 'text', ...)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function withTimeout(p, ms) {
    return Promise.race([p, sleep(ms).then(() => null)]);
  }

  function absUrl(href) {
    try {
      return new URL(href, location.origin).href;
    } catch (e) {
      return '';
    }
  }

  // ---------- scraping ----------

  function asinFromUrl(url) {
    const m = String(url || '').match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})/i);
    return m ? m[1].toUpperCase() : null;
  }

  function priceFrom(el) {
    if (!el) return null;
    const off = el.matches('.a-offscreen') ? el : el.querySelector('.a-offscreen');
    let p = off ? parsePrice(off.textContent) : null;
    if (p == null || p === 0) {
      const whole = el.querySelector('.a-price-whole');
      const frac = el.querySelector('.a-price-fraction');
      if (whole) p = parsePrice(clean(whole.textContent).replace(/\.$/, '') + '.' + clean(frac ? frac.textContent : '00'));
    }
    if (p == null || p === 0) p = parsePrice(el.textContent);
    return p || null;
  }

  function titleCase(s) {
    return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function categoryOf(doc) {
    const crumbs = [...doc.querySelectorAll(SEL.product.breadcrumbs)].map((a) => clean(a.textContent)).filter(Boolean);
    if (crumbs.length) return { category: crumbs[0], subcategory: crumbs[crumbs.length - 1] };
    const sub = doc.querySelector(SEL.product.subnavCategory);
    if (sub && sub.dataset.category) return { category: titleCase(sub.dataset.category), subcategory: '' };
    const alias = doc.querySelector(SEL.product.searchAlias);
    if (alias && !/^all/i.test(clean(alias.textContent))) return { category: clean(alias.textContent), subcategory: '' };
    return { category: '', subcategory: '' };
  }

  function scrapeProduct(doc, url) {
    const P = SEL.product;
    const titleEl = first(doc, P.title);
    if (!titleEl) return null;
    let asin = asinFromUrl(url);
    if (!asin) {
      const inp = first(doc, P.asinInput);
      asin = inp && inp.value ? inp.value.toUpperCase() : null;
    }
    if (!asin) return null;

    let price = null;
    for (const s of P.price) {
      price = priceFrom(doc.querySelector(s));
      if (price) break;
    }
    let listPrice = null;
    for (const s of P.listPrice) {
      const el = doc.querySelector(s);
      listPrice = el ? parsePrice(el.textContent) : null;
      if (listPrice) break;
    }
    if (listPrice && price && listPrice <= price) listPrice = null;

    const dealEl = first(doc, P.deal);
    const wasDeal = !!(dealEl && clean(dealEl.textContent)) || /limited time deal|lightning deal/i.test(
      clean((doc.querySelector('#apex_desktop') || {}).textContent || '')
    );

    const img = first(doc, P.image);
    const image = img ? img.getAttribute('data-old-hires') || img.getAttribute('src') || '' : '';
    const qtyEl = first(doc, P.qty);
    const qty = qtyEl ? parseInt(qtyEl.value, 10) || 1 : 1;

    return Object.assign(
      {
        asin,
        title: clean(titleEl.textContent),
        price,
        listPrice,
        wasDeal,
        image: image.startsWith('data:') ? '' : image,
        url: 'https://www.amazon.com/dp/' + asin,
        qty,
      },
      categoryOf(doc)
    );
  }

  function cartRoot(doc) {
    return first(doc, SEL.cart.activeRoot) || doc;
  }

  function scrapeCart(doc) {
    const C = SEL.cart;
    const items = [];
    for (const row of cartRoot(doc).querySelectorAll(C.item)) {
      if (row.closest('#sc-saved-cart')) continue;
      const box = row.querySelector(C.checkbox);
      if (box && !box.checked && !box.hasAttribute('checked')) continue;
      const asin = (row.dataset.asin || '').toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
      let price = parsePrice(row.dataset.price);
      if (!price) price = priceFrom(first(row, C.price));
      const titleEl = first(row, C.title);
      const img = first(row, C.image);
      const link = first(row, C.link);
      items.push({
        asin,
        title: clean(titleEl ? titleEl.textContent : ''),
        price: price || null,
        qty: parseInt(row.dataset.quantity, 10) || 1,
        image: img ? img.getAttribute('src') || '' : '',
        url: link ? absUrl(link.getAttribute('href')) : 'https://www.amazon.com/dp/' + asin,
      });
    }
    return items;
  }

  function isCartPage() {
    return /\/gp\/cart\/view\.html|\/cart(\/|\?|$)/.test(location.pathname + location.search);
  }

  // content.fetch (Firefox) runs the request as the page itself, so Amazon's
  // guest-cart cookies go along; plain fetch in a content script is an extension request.
  const pageFetch = typeof content !== 'undefined' && content.fetch ? content.fetch.bind(content) : fetch;

  async function fetchDoc(path) {
    const res = await pageFetch(location.origin + path, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + path);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  async function getCartItems() {
    if (isCartPage()) return scrapeCart(document);
    return scrapeCart(await fetchDoc('/gp/cart/view.html'));
  }

  // Cart rows don't carry a category or list price: fill gaps from product pages.
  async function enrich(items, known) {
    const missing = items.filter((it) => !(known[it.asin] && known[it.asin].category)).slice(0, 8);
    await Promise.all(
      missing.map(async (it) => {
        const doc = await withTimeout(fetchDoc('/dp/' + it.asin).catch(() => null), 6000);
        const meta = doc && scrapeProduct(doc, '/dp/' + it.asin);
        if (!meta) return;
        // Keep the cart's price (it is what you'd actually pay); take the rest.
        delete meta.price;
        delete meta.qty;
        await call('cacheAsin', { meta }).catch(() => {});
      })
    );
  }

  // ---------- UI: root, chip, toast ----------

  function root() {
    let r = document.getElementById(ROOT_ID);
    if (!r) {
      r = h('div', { id: ROOT_ID });
      (document.body || document.documentElement).append(r);
    }
    return r;
  }

  let chip = null;
  async function refreshChip() {
    if (!document.body) return;
    let s;
    try {
      s = await call('getSummary');
    } catch (e) {
      return;
    }
    if (!chip) {
      chip = h('button', { class: 'fkz-chip', type: 'button', title: 'Open your Fakeazon bank', onclick: () => call('openBank') });
      root().append(chip);
    }
    chip.textContent = s.setupDone ? '🏦 ' + fmt(s.balance) : '🏦 Set up your Fakeazon bank';
    chip.classList.toggle('fkz-neg', s.balance < 0);
  }

  function toast(text) {
    const t = h('div', { class: 'fkz-toast', role: 'status' }, text);
    root().append(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ---------- UI: fake checkout modal ----------

  let modal = null;

  function closeModal() {
    if (modal) modal.remove();
    modal = null;
    document.removeEventListener('keydown', onEsc, true);
  }

  function onEsc(e) {
    if (e.key === 'Escape') closeModal();
  }

  function openModal(...content) {
    closeModal();
    const panel = h('div', { class: 'fkz-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Fakeazon checkout' });
    modal = h('div', { class: 'fkz-overlay', onclick: (e) => e.target === modal && closeModal() }, panel);
    root().append(modal);
    document.addEventListener('keydown', onEsc, true);
    setPanel(...content);
    return panel;
  }

  function setPanel(...content) {
    const panel = modal.querySelector('.fkz-panel');
    panel.replaceChildren(
      h('div', { class: 'fkz-head' },
        h('span', { class: 'fkz-logo' }, 'fakeazon', h('span', { class: 'fkz-smile' })),
        h('span', { class: 'fkz-badge' }, 'Nothing real will be ordered'),
        h('button', { class: 'fkz-x', type: 'button', 'aria-label': 'Close', onclick: closeModal }, '×')
      ),
      h('div', { class: 'fkz-body' }, ...content)
    );
  }

  function loadingView(text) {
    return h('div', { class: 'fkz-loading' }, h('span', { class: 'fkz-spin' }), text);
  }

  function line(label, value, cls) {
    return h('div', { class: 'fkz-row ' + (cls || '') }, h('span', null, label), h('span', null, value));
  }

  function itemRow(l) {
    return h('div', { class: 'fkz-item' },
      l.image ? h('img', { src: l.image, alt: '' }) : h('div', { class: 'fkz-noimg' }),
      h('div', { class: 'fkz-item-main' },
        h('div', { class: 'fkz-item-title' }, l.title),
        h('div', { class: 'fkz-item-meta' },
          l.category && l.category !== 'Uncategorized' ? h('span', { class: 'fkz-cat' }, l.category) : null,
          l.wasDeal ? h('span', { class: 'fkz-deal' }, 'Deal') : null,
          l.listPrice && l.listPrice > l.price ? h('s', null, fmt(l.listPrice)) : null
        )
      ),
      h('div', { class: 'fkz-item-price' }, (l.qty > 1 ? l.qty + ' × ' : '') + fmt(l.price))
    );
  }

  function reviewView(quote, items, source, skipped) {
    const s = quote.summary;
    const after = s.balance - quote.total;
    const placeBtn = h('button', { class: 'fkz-btn fkz-primary', type: 'button' }, 'Place your order');
    placeBtn.addEventListener('click', async () => {
      placeBtn.disabled = true;
      placeBtn.textContent = 'Placing order…';
      let r;
      try {
        r = await call('placeOrder', { items });
      } catch (e) {
        setPanel(errorView(e));
        return;
      }
      if (r.ok) setPanel(successView(r, source));
      else if (r.reason === 'insufficient_funds') {
        setPanel(loadingView('Checking with your bank…'));
        setPanel(declinedView(r, await call('getSummary').catch(() => ({}))));
      } else setPanel(failedView(r));
      refreshChip();
    });

    return [
      h('h2', { class: 'fkz-h2' }, 'Review your order'),
      h('div', { class: 'fkz-ship' },
        h('div', null, h('b', null, 'Ship to: '), 'You · 1 Pretend Lane, Imaginary City'),
        h('div', null, h('b', null, 'Pay with: '), s.accountName + ' ••••4242 · balance ' + fmt(s.balance))
      ),
      skipped ? h('div', { class: 'fkz-note' }, skipped + ' item(s) without a price were left out (unavailable or not loaded).') : null,
      h('div', { class: 'fkz-items' }, quote.lines.map(itemRow)),
      h('div', { class: 'fkz-totals' },
        line('Items (' + quote.lines.reduce((a, l) => a + l.qty, 0) + '):', fmt(quote.subtotal)),
        line('Estimated tax (' + (Math.round(s.taxRate * 1000) / 10) + '%):', fmt(quote.tax)),
        line('Order total:', fmt(quote.total), 'fkz-total'),
        line('Balance after:', fmt(after), after < 0 ? 'fkz-bad' : 'fkz-good')
      ),
      h('div', { class: 'fkz-actions' },
        placeBtn,
        h('button', { class: 'fkz-btn', type: 'button', onclick: closeModal }, 'Cancel')
      ),
    ];
  }

  function successView(r, source) {
    const o = r.order;
    const n = o.items.reduce((a, l) => a + l.qty, 0);
    const willClear = source === 'cart' && r.summary.clearCartAfterPurchase;
    const done = () => {
      closeModal();
      if (willClear) startClearingCart(o.items.map((l) => l.asin));
    };
    return [
      h('div', { class: 'fkz-big fkz-good' }, '✔ Order placed, thank you!'),
      h('p', null, 'Arriving never 📦. ' + n + ' item' + (n === 1 ? '' : 's') + ', charged ' + fmt(o.total) + '.'),
      h('div', { class: 'fkz-totals' },
        line('Order #', o.id),
        line('New balance:', fmt(r.balance), r.balance < 0 ? 'fkz-bad' : '')
      ),
      willClear ? h('div', { class: 'fkz-note' }, 'These items will be removed from your Amazon cart.') : null,
      h('div', { class: 'fkz-actions' },
        h('button', { class: 'fkz-btn fkz-primary', type: 'button', onclick: done }, 'Keep shopping'),
        h('button', { class: 'fkz-btn', type: 'button', onclick: () => { call('openBank', { hash: 'orders' }); done(); } }, 'See it in my bank')
      ),
    ];
  }

  function declinedView(r, s) {
    const np = s.nextPaycheck;
    const when = np && new Date(np.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return [
      h('div', { class: 'fkz-big fkz-bad' }, '✖ Payment declined'),
      h('p', null, 'Insufficient funds. You’re short ' + fmt(r.shortBy) + ' (balance ' + fmt(r.balance) + ', order ' + fmt(r.quote.total) + ').'),
      h('p', null, np ? 'Next paycheck: ' + np.name + ' on ' + when + ' (+' + fmt(np.amount) + ').' : 'No paychecks are set up yet. Add one in your bank.'),
      h('div', { class: 'fkz-actions' },
        h('button', { class: 'fkz-btn fkz-primary', type: 'button', onclick: () => { call('openBank'); closeModal(); } }, 'Open my bank'),
        h('button', { class: 'fkz-btn', type: 'button', onclick: closeModal }, 'Back to shopping')
      ),
    ];
  }

  function failedView(r) {
    const why = { empty_cart: 'Your cart is empty.', unpriced: 'Some items have no price Fakeazon could read.' }[r.reason] || r.reason;
    return [
      h('div', { class: 'fkz-big fkz-bad' }, 'Couldn’t place the order'),
      h('p', null, why),
      h('div', { class: 'fkz-actions' }, h('button', { class: 'fkz-btn', type: 'button', onclick: closeModal }, 'Close')),
    ];
  }

  function errorView(e) {
    return [
      h('div', { class: 'fkz-big fkz-bad' }, 'Something went wrong'),
      h('p', null, String(e.message || e)),
      h('div', { class: 'fkz-actions' }, h('button', { class: 'fkz-btn', type: 'button', onclick: closeModal }, 'Close')),
    ];
  }

  function setupNeededView() {
    return [
      h('div', { class: 'fkz-big' }, 'Open your Fakeazon bank first'),
      h('p', null, 'Set an opening balance and a paycheck, then come back and buy whatever you like.'),
      h('div', { class: 'fkz-actions' },
        h('button', { class: 'fkz-btn fkz-primary', type: 'button', onclick: () => { call('openBank'); closeModal(); } }, 'Set up my bank'),
        h('button', { class: 'fkz-btn', type: 'button', onclick: closeModal }, 'Not now')
      ),
    ];
  }

  async function startCheckout(source) {
    openModal(loadingView(source === 'buynow' ? 'Getting this item…' : 'Reading your cart…'));
    try {
      const summary = await call('getSummary');
      if (!summary.setupDone) return setPanel(...setupNeededView());

      let items;
      if (source === 'buynow') {
        const meta = scrapeProduct(document, location.href);
        if (!meta) throw new Error('Couldn’t read this product page.');
        await call('cacheAsin', { meta: Object.assign({}, meta, { qty: undefined }) });
        items = [meta];
      } else {
        items = await getCartItems();
        if (!items.length) {
          return setPanel(h('div', { class: 'fkz-big' }, 'Your cart looks empty'),
            h('p', null, 'Add something first. (If it isn’t empty, Amazon changed its cart page: fix lib/selectors.js.)'),
            h('div', { class: 'fkz-actions' }, h('button', { class: 'fkz-btn', type: 'button', onclick: closeModal }, 'Close')));
        }
        setPanel(loadingView('Looking up categories…'));
        const state = await call('getState');
        await enrich(items, state.asinMeta);
      }

      const priced = items.filter((it) => it.price > 0);
      const skipped = items.length - priced.length;
      if (!priced.length) throw new Error('Couldn’t read any prices. Amazon may have changed its page layout.');
      const quote = await call('quote', { items: priced });
      setPanel(...reviewView(quote, priced, source, skipped));
    } catch (e) {
      setPanel(...errorView(e));
    }
  }

  // ---------- after purchase: empty the bought items from the real cart ----------

  function startClearingCart(asins) {
    try {
      sessionStorage.setItem(CLEAR_KEY, JSON.stringify(asins));
    } catch (e) {
      return;
    }
    if (isCartPage()) clearCartItems();
    else location.href = '/gp/cart/view.html';
  }

  async function clearCartItems() {
    let asins;
    try {
      asins = JSON.parse(sessionStorage.getItem(CLEAR_KEY) || '[]');
      sessionStorage.removeItem(CLEAR_KEY);
    } catch (e) {
      return;
    }
    if (!asins.length) return;
    toast('Fakeazon: removing purchased items from your cart…');
    for (const asin of asins) {
      const row = cartRoot(document).querySelector('.sc-list-item[data-asin="' + asin + '"]');
      const btn = row && first(row, SEL.cart.deleteBtn);
      if (!btn) continue;
      btn.click();
      // Amazon removes the row via AJAX; wait for it before the next one.
      for (let i = 0; i < 40 && row.isConnected && !row.classList.contains('sc-list-item-removed'); i++) await sleep(100);
      await sleep(250);
    }
  }

  // ---------- interception ----------

  function classify(target) {
    if (!target || !target.closest) return null;
    if (target.closest('#' + ROOT_ID)) return null;
    const el = target.closest(SEL.clickable);
    if (!el) return null;
    if (el.closest(SEL.buyNow)) return 'buynow';
    if (el.closest(SEL.checkout)) return 'cart';
    const control = el.matches('input, button') ? el : el.querySelector('input[type="submit"], button');
    const name = (control && control.getAttribute('name')) || '';
    if (/submit\.buy-now/i.test(name)) return 'buynow';
    if (SEL.checkoutName.test(name)) return 'cart';
    const a = el.closest('a[href]');
    const href = (a && a.getAttribute('href')) || (control && control.getAttribute('formaction')) || '';
    if (SEL.checkoutUrl.test(href)) return 'cart';
    if (SEL.signinUrl.test(href)) return 'signin';
    const form = control && control.form;
    if (form && /\/gp\/buy\/|\/checkout\/|checkoutportal|go-to-checkout/i.test(form.getAttribute('action') || '')) return 'cart';
    return null;
  }

  function stop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function act(kind) {
    if (kind === 'signin') toast('Fakeazon keeps this browser signed out of Amazon, so nothing can be bought for real.');
    else startCheckout(kind);
  }

  window.addEventListener(
    'click',
    (e) => {
      const kind = classify(e.target);
      if (!kind) return;
      stop(e);
      act(kind);
    },
    true
  );

  // Keyboard-submitted or script-submitted forms that would go to checkout.
  window.addEventListener(
    'submit',
    (e) => {
      const form = e.target;
      const kind = classify(e.submitter) ||
        (/\/gp\/buy\/|\/checkout\/|checkoutportal|go-to-checkout/i.test(form.getAttribute('action') || '') ? 'cart' : null);
      if (!kind) return;
      stop(e);
      act(kind);
    },
    true
  );

  // ---------- on load ----------

  async function onReady() {
    refreshChip();
    const meta = scrapeProduct(document, location.href);
    if (meta) {
      delete meta.qty;
      call('cacheAsin', { meta }).catch(() => {});
    }
    if (isCartPage() && sessionStorage.getItem(CLEAR_KEY)) {
      await sleep(600);
      clearCartItems();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();

  let chipTimer = null;
  browser.storage.onChanged.addListener(() => {
    clearTimeout(chipTimer);
    chipTimer = setTimeout(refreshChip, 300);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshChip();
  });
})();
