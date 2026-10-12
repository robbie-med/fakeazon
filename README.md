# Fakeazon

Browse the real amazon.com, add to cart and hunt deals as usual. When you check out, Fakeazon
takes over: it shows its own checkout and pays from a **fake bank account** with recurring fake
paychecks and bills. A bank tab shows your balance, history, orders and spending insights.

It's a Firefox extension (MV3, vanilla JS, no build step, no server, no port).

## How a real order is prevented (three layers)
1. **Dedicated, signed-out Firefox profile** ("Fakeazon"). Amazon checkout needs a login.
2. **Network block** (`rules.json`, declarativeNetRequest): `/gp/buy/`, `/checkout/`,
   `/gp/checkoutportal`, go-to-checkout, `/ap/signin`, `/ap/register` and `/ax/claim` are
   redirected to `blocked.html` (page loads) or dropped (XHR/fetch). This holds even if
   Amazon's markup changes.
3. **Click interception** (`content/amazon.js`): "Proceed to checkout", "Buy Now" and the
   side-sheet checkout open the fake checkout instead. Sign-in links show a toast.

## Run it
- Double-click **Fakeazon** on the desktop, or run `./launch-fakeazon.sh`. This opens Amazon
  in the Fakeazon profile.
- Release Firefox only installs *signed* extensions permanently. Until it's signed, load it each
  launch: the launcher opens `about:debugging` → **Load Temporary Add-on…** → pick
  `manifest.json` in this folder. Your data survives this, because the profile's `user.js` sets
  `keepStorageOnUninstall` and `keepUuidOnUninstall`.
- **Permanent install:** sign it privately (unlisted; free and not public) with your
  addons.mozilla.org API key, then install the `.xpi` in the Fakeazon profile:
  `npx web-ext@8 sign --channel=unlisted --api-key=... --api-secret=...`
- Click the toolbar icon or the 🏦 balance chip on Amazon to open the bank.

## Using it
- **First run:** the bank asks for an opening balance, a paycheck (amount, frequency, first
  payday) and a sales-tax rate. A first payday in the past back-pays every paycheck since then.
- **Paychecks & bills:** weekly, every 2 weeks, twice a month (15th and last day) or monthly.
  They post automatically: on Firefox start, hourly, and when the bank opens. Missed ones catch up.
- **Checkout:** shows the review, tax and balance-after. Not enough money means the payment is
  **declined**, with the date of your next paycheck. After a purchase the bought items are removed
  from your Amazon cart (you can turn this off in Settings).
- **Orders:** shows everything you "bought", with images and links. **Return** refunds it.
- **Insights:** total spent, average order, savings vs list price, biggest splurge, monthly
  income/shopping/bills, spend by category, and a day-of-week × hour heatmap.
- **Settings:** export/import a JSON backup, and reset.

## Layout
| Path | What |
|---|---|
| `manifest.json`, `rules.json` | extension manifest and network block rules |
| `background.js` | single writer of state; message router, hourly alarm |
| `lib/store.js` | all data logic (pure; unit-tested) |
| `lib/selectors.js` | every Amazon DOM selector. **Fix scraping here when Amazon changes** |
| `content/amazon.js`, `.css` | scraping, interception, fake checkout modal, balance chip |
| `bank/` | the bank tab |
| `blocked.html` | where blocked checkout/sign-in navigations land |
| `vendor/chart.umd.min.js` | Chart.js 4.4.9 (MIT) |
| `tools/make_icons.py` | regenerates `icons/` |

## Dev
```
npm test        # node --test on lib/store.js
npm run lint    # web-ext lint
npm run build   # zip into web-ext-artifacts/
```
