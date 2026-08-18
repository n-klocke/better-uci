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

There is no way to execute this against the live site from here. The only
way to validate real behavior is the person reloading the actual page in
their own browser, against their own session, and reporting back.

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

## Layout

- `better-uci.user.js` — the actual script.
- `docs/API.md` — reverse-engineered endpoint reference, confirmed vs.
  open items marked explicitly. Update it when you learn something new
  about the API — it's meant to stay current, not be a one-time snapshot.
- `fixtures/` — real captured API responses for offline validation.
- `test/validate-fixtures.js` — run with `node test/validate-fixtures.js`.
  Imports and exercises the real parsing/grouping code from
  `better-uci.user.js` (`parseSeatStr`, `groupSeatsByRow`) instead of a
  hand-maintained copy of it. This works despite the userscript being a
  self-contained IIFE, not a module: right after `'use strict'` it checks
  for a Node `module` and, if found, exports those functions and returns
  immediately, before touching `location`/`document`/GM_*. Real Tampermonkey
  execution never defines `module`, so that branch is dead code in the
  browser. If you change `parseSeatStr`, `rowKey`, or `groupSeatsByRow`,
  just re-run the test — there's no second copy to keep in sync.
