# Fakeazon: agent notes

Firefox MV3 extension. No server and no port, so PORTS.md doesn't apply.

- **The safety invariant is the point of the project:** a real Amazon order must be impossible.
  Never weaken `rules.json` (checkout and sign-in blocks) or the capture-phase interception in
  `content/amazon.js`. The Fakeazon Firefox profile must stay signed out of Amazon.
- All state is one object under `storage.local` key `state`. `background.js` is the only writer
  (a queued `mutate`). Pages and content scripts send messages. The balance is `sum(ledger)` and
  is never stored. Money is integer cents.
- Keep data logic in `lib/store.js` (pure, works in both the browser and Node) and add a
  `test/store.test.js` case for any change. Run `npm test` and `npm run lint`.
- Amazon markup breaks scraping, not safety. Fix selectors in `lib/selectors.js` only.
- The profile is `Fakeazon` (`~/.mozilla/firefox/*.Fakeazon`). Its `user.js` keeps temporary
  add-on storage. Shortcuts: `~/Desktop/Fakeazon.desktop`, `~/.local/share/applications/Fakeazon.desktop`.
- Signing (`web-ext sign --channel=unlisted`) uploads the code to Mozilla. Ask the user first.
  The gecko id is `fakeazon@robbiemed.org`; don't change it, because stored data is keyed to it.
