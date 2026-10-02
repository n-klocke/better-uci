# CLAUDE.md

Orientation for working in this repo — how to work here, not what the
site's API does. For endpoint-level details, see `docs/API.md`.

## What this is

A single-file Tampermonkey userscript (`better-uci.user.js`) for
`buchung.uci-kinowelt.de` and `www.uci-kinowelt.de`. No build step, no
`package.json`, no bundler — it's one plain JS file Tampermonkey loads
directly. Edit it in place.

## How changes actually reach the user

The script self-updates via `@updateURL`/`@downloadURL` pointing at
`raw.githubusercontent.com`. Committing and pushing to `main` is the
actual delivery mechanism, not optional cleanup — editing the local file
and stopping there does nothing for the person using it.

Bump the `// @version` line in the userscript header on every shipped
change; Tampermonkey uses it to decide whether an update exists.

## Testing model — read this before assuming anything works

Real behavior only shows on the live site, against the person's own session.
When a browser-automation tool attached to their logged-in Chrome is
available (Claude in Chrome), that works. Install a local build by serving
the repo on 127.0.0.1 and opening the `.user.js` URL; the person clicks
Update in Tampermonkey. Phone widths: load the page in a fixed-width
`<iframe>` overlay, since Tampermonkey runs in iframes too. iPhone Safari:
see the Userscripts section below. Without those tools, the only check is
the person reloading the page and reporting back.

`test/validate-fixtures.js` is not a substitute for that. It validates
parsing logic against a captured API response offline — does the code
correctly interpret real data — not live behavior — does clicking a
button actually work on the real site. Both matter; neither stands in for
the other.

Given that, the single most expensive mistake to avoid repeating here:
guessing at a fix from a description or screenshot alone, without getting
real data first (console output, `getComputedStyle`, an actual API
response) to confirm the theory before changing code. This codebase has a
real history of that going wrong — four straight rounds of plausible
position-math fixes for a seat-map row-overlap report, all wrong, before
real diagnostic output (`getBoundingClientRect`, then `getComputedStyle`)
revealed the actual cause: a site-wide CSS `min-height: 45px` on
`<button>` elements, unrelated to position math entirely. Every one of
those rounds could have been skipped by asking for real numbers first.

## Known site quirks (apply to any new UI, not just existing code)

- `<button>` elements on `buchung.uci-kinowelt.de` have a global
  `min-height: 45px` from the site's own CSS. Any custom button needs an
  explicit `min-height: 0` override or it silently renders taller than
  specified — this is what caused the bug above.
- The site does not enforce unique `id` attributes, and browsers don't
  either. Duplicate IDs exist here in the wild (e.g. one
  `#ticket-type-container` per price-category tab pane). A plain
  `getElementById`/`querySelector` returns the first match in document
  order, which is not necessarily the visible or active one.
- `/TicketBoxXNG/seatsAndTickets.json` has no `/booking/` prefix, unlike
  `init.json`, `selectSeats.json`, and `bonusAndVoucherTotal.json`. Full
  endpoint reference: `docs/API.md`.
- Fixed-position elements on the booking page don't reserve their own
  layout space — something else does, sized for their *original*
  dimensions, and it doesn't recompute when those elements are resized via
  CSS. Confirmed twice this way: `#booking-header`'s inline `top` offset
  assumed `#uci-header`'s original ~45px height, and separately
  `body.layout-dark`'s own `margin-top` (95px) was sized for the original
  two-bar header stack — not `#booking-info` itself, which was the first
  (wrong) suspect. Both needed an explicit, measured override
  (`getBoundingClientRect`/`getComputedStyle`), not a CSS-only shrink.
- Not just ids — classes repeat too. The seat-selection page has more than
  one `.backdrop-wrapper`; only `.backdrop-wrapper:has(#seatingplan)` is
  the real, rendered seat-map wrapper. A plain `.backdrop-wrapper` query
  silently grabs a different, unrendered one (confirmed: its
  `getBoundingClientRect()` came back all zeros).
- The payment-step accordion's `.payment-type-header` elements carry no
  `data-toggle="collapse"` attribute — their click-to-expand is wired by
  the site's own custom JS, not Bootstrap's delegated init, and that JS's
  delegation scope is unconfirmed. Treat relocating any of these `.card`
  elements elsewhere in the DOM as a real risk to that click behavior, not
  a safe refactor; toggle visibility with classes in place instead (see
  `setupLeanPaymentExtras` in `better-uci.user.js`).
- The empty space above the seat rows inside `#seatingplan` (before the
  "Leinwand" screen curve renders) isn't a CSS box this script controls —
  confirmed the surrounding wrapper's own padding/margin is already
  minimal. It's baked into the seat map's own internal rendering; leave it
  alone rather than guessing at a fix.

## Userscripts (iPhone Safari) quirks — all confirmed in the iOS simulator

On iPhone the script runs under the Userscripts extension (quoid/userscripts),
not Tampermonkey. It differs in ways that break code that works on desktop:

- No `GM_getValue`/`GM_setValue`: Userscripts drops `GM_*` grants, and calling
  one throws a ReferenceError. It only has the async `GM.getValue`/
  `GM.setValue`. That ReferenceError was the 3.1.6 iPhone "Warenkorb wird
  gelesen…" hang. All storage goes through `store` at the top of the file.
- Which JS world the script runs in depends on its grants. With no valid
  grant it runs in the page world, as an inline `<script>`, so it's subject
  to CSP. With any valid grant, such as `GM.getValue`, it runs in Safari's
  isolated content world, where there are no page globals and no
  `unsafeWindow`. Since 3.1.7 it's the latter, and `window.book` and the
  page's jQuery are reached through `pageBridge` (an injected page script
  talking over DOM events with JSON-string payloads). UCI sends no
  Content-Security-Policy, which is what allows that injected script. If UCI
  ever adds one, the bridge is the first thing to break, and the panel then
  says "Buchungsdaten nicht lesbar".
- That content world has a global `$` of its own: Userscripts' minified
  content script declares `async function $`. Never detect the page by `$`,
  only by `book`.
- The relative order of several userscripts isn't reliable (its sort
  comparator returns booleans), so a helper script can't count on running
  first.
- The phone has no console. The panel's "Unlimited Cards verwalten" section
  ends in a status line (page access, storage), and poll() errors land in
  the panel log.

Testing it for real: build Userscripts from source for the iOS simulator
(Xcode required; node isn't installed, bun works):
`git clone --branch v4.8.6 https://github.com/quoid/userscripts` (match the
App Store version), then `bun install`, `bun scripts/build-app.js`,
`SAFARI_PLATFORM=ios bun scripts/build-ext-safari-15.js`, then
`xcodebuild -project xcode/Userscripts.xcodeproj -scheme iOS -configuration
Debug -sdk iphonesimulator`. Install the .app and enable the extension under
Settings → Apps → Safari → Extensions, allowing "Other Websites". Scripts are
plain files in the app's Documents folder
(`xcrun simctl get_app_container <udid> dev.debug.userscripts data`). Edits
to an existing file apply on reload. A new file needs Userscripts to rebuild
its index, which happens when you switch away from Safari and back. Web
Inspector isn't reachable from here, so to see state in screenshots, write it
into the DOM, e.g. with a throwaway page-world overlay script.

## Layout

- `better-uci.user.js` — the actual script.
- `docs/API.md` — reverse-engineered endpoint reference, confirmed vs.
  open items marked explicitly. Update it when you learn something new
  about the API — it's meant to stay current, not be a one-time snapshot.
- `fixtures/` — real captured API responses for offline validation.
- `archive/seat-map.js` — the paused custom seat map, moved out of the
  userscript in v3.0.0. Not loaded by Tampermonkey; it's still where
  `parseSeatStr`, `rowKey`, `groupSeatsByRow`, and `seatMapHTML` live.
- `test/validate-fixtures.js` — run with `node test/validate-fixtures.js`
  (or `bun`). Imports and exercises the real parsing/grouping code from
  `archive/seat-map.js` instead of a hand-maintained copy of it. That file
  starts with a `module.exports` early-return branch so it can be
  `require()`d under Node without running its browser-only code. If you
  change those functions, just re-run the test — there's no second copy to
  keep in sync. (Before v3.0.3 the test still required them from
  `better-uci.user.js`, which no longer exports anything, so it crashed on
  load.)
