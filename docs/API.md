# UCI Kinowelt booking API — reference

Everything in this document was reverse-engineered by capturing real requests
against `buchung.uci-kinowelt.de` and validating every claim against live
responses — nothing here is assumed. Where something is confirmed, it says
so; where something is still uncertain, it's flagged explicitly as **OPEN**
rather than presented as settled. See `fixtures/` for real captured
responses and `test/validate-fixtures.js` for a runnable check of the claims
below against them.

All endpoints are same-origin relative to `buchung.uci-kinowelt.de` and
require an active `bookingProcessId` (obtained from `init.json` at page
load — read from the page's own `window.book.bookingProcessId`, not
fetched independently).

## Required headers

Confirmed required (a real 404 with a body explaining "not found" resulted
from omitting these, not a generic failure):

```
accept: application/json, text/javascript, */*; q=0.01
x-requested-with: XMLHttpRequest
```

The site appears to use `x-requested-with` specifically to distinguish real
AJAX calls from other requests, and returns 404 (not 403 or a clearer
error) for requests missing it — likely a deliberate choice to avoid
revealing endpoint existence to non-AJAX callers.

## Endpoints

### `GET /TicketBoxXNG/booking/init.json`

Session bootstrap. Returns film, cinema, and payment-method metadata, and
establishes `bookingProcessId`. Not called independently by this script —
`window.book.bookingProcessId` is read from the page's own state instead.

### `GET /TicketBoxXNG/login.json`

Auth state. Not used by this script.

### `GET /TicketBoxXNG/seatsAndTickets.json`

**No `/booking/` prefix** — this is the one exception among these five
endpoints. Getting this wrong (adding `/booking/` by pattern-matching the
other four) produced persistent 404s that took several rounds of debugging
to trace back to the path itself, not the headers or parameters.

Query parameters (all required in practice, copied from a real captured
request):

```
bookingProcessId=<the session's booking process id>
allowCache=false
instanceId=<a number — real captures showed the SAME value, e.g. 19959,
            across multiple different bookingProcessIds in the same
            browser tab, suggesting it's per-tab/session, not per-request.
            This script generates a random 5-digit number instead, which
            has not caused any observed failure, but the real semantics
            are OPEN.>
verboseSeatInfo=false
noRefresh=false
advancedFormat=1
reason=Get seats and tickets data
_=<cache-busting timestamp>
```

Response shape (see `fixtures/seatsAndTickets.sample.json` for a full real
example):

```json
{
  "isDynamicPricing": true,
  "currency": "EUR",
  "sections": [
    {
      "name": "PK 3",
      "id": 4,
      "prices": [ { "id": "10000000999PJOBECA", "name": "Erwachsener", "nameOrg": "Erwachsener", "amount": 9.9, ... }, ... ],
      "seatStr": "1|7|90|227|1|30|30|2|0|2|0|0|10;2|7|120|227|...",
      "modeStr": "reserved"
    }
  ]
}
```

Each `sections[].prices[]` entry has both `name` (the fuller display name,
e.g. `"Fam-Tarif: Kind (unter 12 J)"`) and `nameOrg` (a shorter internal
name, e.g. `"Fam. Kind"`) — this script currently reads ticket-type labels
from the native DOM instead of this field, then shortens known verbose
patterns with a regex. Using `nameOrg` directly would be a cleaner
alternative worth considering.

#### `seatStr` field format

Semicolon-separated seat entries, each pipe-delimited:

```
seatNum|row|x|y|f4|w|h|availability|leftNeighbor|rightNeighbor|f10|f11|colIndex
```

| # | Field | Meaning | Confidence |
|---|---|---|---|
| 0 | `seatNum` | Unique seat identifier, used in `selectSeats.json` requests. In every real example seen so far, monotonically increasing **within a section**, spanning across that section's rows without resetting (e.g. PK3's row 7 is seats 1–10, row 6 continues at 11–21). | Confirmed |
| 1 | `row` | Row label. Wheelchair-designated seats within a row carry an `R`-prefixed variant of the same row (`"R7"` for row `"7"`) — same physical row, not a separate one. Confirmed directly by the person who built this cinema's seating chart context. | Confirmed |
| 2 | `x` | Horizontal position, shared coordinate space across all sections in the same response. | Confirmed |
| 3 | `y` | Vertical position (row position), same shared space. Lower y = closer to the screen. | Confirmed |
| 4 | seatClass | Seat-class flag: `"1"` normal, `"2"` one half of a couple/loveseat pair (shown with no border on their shared inner edge — see `seatMapHTML`), `"3"` wheelchair-designated. Confirmed against every seat in `fixtures/seatsAndTickets.sample.json`: every `"3"` co-occurs with an `R`-prefixed row, and every `"2"` seat has exactly one neighbor (via fields 8/9) that's also `"2"`, forming clean pairs, never larger groups. | Confirmed |
| 5 | `w` | Seat width in the same units as x/y. | Confirmed |
| 6 | `h` | Seat height, same units. | Confirmed |
| 7 | `availability` | `"2"` = available. Verified against 79 real seats: 78 clean matches, one explained exception — wheelchair-designated seats (row starts with `R`) can carry `"1"` whether actually occupied or not, so wheelchair seats are identified by row label, not this field. Other observed values: `"4"` = occupied, `"52"` = occupied (seen 3/3 times, originally guessed to mean "selected by the current session" but that theory didn't hold up — treat as occupied, not selectable). | Confirmed (with the wheelchair exception) |
| 8 | `leftNeighbor` | Seat number of the seat immediately to the left within the same row, or `0` if none (start of a run, or isolated). Confirmed via direct adjacency testing. | Confirmed |
| 9 | `rightNeighbor` | Same, to the right. | Confirmed |
| 10 | — | Non-zero in some auditoriums, always `"0"` in others (confirmed across two different real datasets from different auditoriums). Never needed for anything this script does. Best guess: some kind of row-above/row-below seat reference for a feature not used here. | **OPEN** |
| 11 | — | Same as field 10 — always paired with it, same behavior. | **OPEN** |
| 12 | `colIndex` | A **within-row** display position: decreases from a row-specific maximum down to `1` as x increases (i.e. counts from one side of the row). Resets independently per row — row 7's colIndex range is 1–10 (with wheelchair seats using an `R`-prefixed variant, e.g. `"R2"`, `"R1"`), row 6's is 1–11, neither continuing from the other. This is the actual customer-facing "Platz" number (confirmed: real seats are numbered per-row starting at 1, not globally down the whole auditorium). `better-uci.user.js` shows this in seat tooltips; `seatNum` (field 0) is the internal booking identifier only, used for click-target lookups, never shown to the user. | Confirmed |

### `POST /TicketBoxXNG/booking/selectSeats.json`

Request body:

```json
{
  "bookingProcessId": "<session id>",
  "sectionId": 4,
  "seatsStr": "10000000999PJOBECA:53;20000000999PJOBECA:54;"
}
```

`seatsStr` maps ticket-type id → seat number, semicolon-separated, one
section at a time. In every real captured example, the full current
selection for that section was sent each time (not just the newly-changed
seat) — i.e. this behaves as "set the complete selection for this section"
rather than an incremental add/remove.

Response:

```json
{ "selectedSeatNumbers": [53, 54] }
```

**No fixture file exists yet for this endpoint** — the shape above is
documented from real examples seen earlier in this project's history, but
not from a byte-exact capture available for this codebase. Capturing a
fresh real request/response pair into `fixtures/selectSeats.request.json`
and `fixtures/selectSeats.response.json` would be a good next addition.

**Critical, confirmed-the-hard-way finding:** calling this endpoint
directly via an isolated `fetch()` correctly updates seat state
server-side (the response confirms it), but does **not** update whatever
client-side state gates the native "weiter" button — that only gets
updated by the site's own click-handling code path. This script currently
selects seats via a synthetic click dispatched at the seat's real canvas
coordinates (see `mountSeatMap`/`onSeatClick` in `better-uci.user.js`) so
the site's own handler runs in full, rather than calling this endpoint
directly.

### `POST /TicketBoxXNG/booking/bonusAndVoucherTotal.json`

Used by the voucher-redemption module. Not documented in detail here —
see `better-uci.user.js` for its usage.

- **`seatActionIdx` is the row's index in the server's `priceRows`** —
  confirmed 2026-10-07. Server responses carry no `bookingServerIndex`;
  the page adds it when it copies them into `book.priceRows`, and stores
  that array **reversed** (4 seats: positions 0–3 had `bookingServerIndex`
  3, 2, 1, 0). UCI's own forms send `bookingServerIndex`. So: index into
  a raw response by position, into `book.priceRows` by
  `bookingServerIndex`.
- **One request at a time per booking** — confirmed 2026-10-07. A request
  sent while another on the same booking is still running is refused in
  ~0.2s with `failure: "true"` and a `B-RT34` code: `C-05-1` ("Leider
  haben wir ein Problem mit Ihrer Buchung", HTTP 311) or `C-160` ("Es
  können derzeit keine Buchungen mit hinterlegter Kundenkarte durchgeführt
  werden"). The payment step's own load sends one to this endpoint that
  takes 5–7s, so anything fired right after the step appears collides
  with it. All the page's calls go through its jQuery, so `$.active === 0`
  means the booking is free.
- Requests here are slow: 2.5–8.6s each, observed 2026-10-07. On the
  evening of 2026-10-07 they took 7–18s, and some ended in HTTP 0 or a
  504 after 60s. A retry after a 504 on a card check went through.
- **Send card numbers trimmed** — confirmed 2026-10-07. Unlimited card
  numbers are 13 characters (`book.unlimitedCustomerNumber`, and
  `unlimitedTicketCardNo` once applied). Two saved friends' codes had a
  trailing space. With the space, `determineBoniUnlimitedCardNumber`
  still passed and echoed a 14-character `currentUnlimitedCard.number`.
  The apply (`seatAction: 'unlimited'`) then hung until a 504. From then
  on, every request on that booking, even a plain `joinLoyalty: 0`
  refresh, failed in about 1s with `B-RT34 C-160` and
  `errorAction: "exit"`. That was still the case 10 minutes later, so the
  booking was dead. The same card, trimmed, applied in 11.5s on a new
  booking. So C-160 can mean a dead booking, not only a request that
  collided with another one.
- **A friend's card can be refused for every seat.** For one card,
  `determineBoni` returned `unlimitedTicketAvail: false` on all four Loge
  seats, on two separate bookings, sent both trimmed and untrimmed. Other
  friends' cards came back `true` for the same seats. The
  `currentUnlimitedCard` record looked the same as an accepted card's:
  `contractStatus: "canceled"` with a future `contractEnd`, same
  `promoCode` and `cardBlock`. **OPEN:** why the server refuses it.
- **IMAX Loge with Unlimited:** the 24,90 € ticket gets `discount: 20.9`,
  which leaves 4,00 € to pay per card.

## Seat map internals (`book.seatingApp`) — confirmed 2026-10-06

Groundwork for an automatic "best seats" picker (not built yet). All of this
was observed live by wrapping the seat-map prototypes and logging the calls a
real click makes. `bd` below is `book.seatingApp.bookingData`.

- **Seat models:** `bd.attributes.seats.models` (Backbone), one per seat. The
  attributes include `row`, `seatNumber` (the customer-facing Platz),
  `x`/`y`/`width`/`height` (own units: seats ~30 wide at a ~30.6 pitch, rows
  ~76 apart, lower `y` = closer to the screen), `statusStr` (`FREE`, `SOLD`,
  `BLOCKED`, `SELECTEDFREE` = held by another session) and `typeStr`
  (`REGULAR`, `WHEELCHAIR`). Also `neighborLeft`/`neighborRight`,
  `isAisleSeat`, `isEdgeSeat`. `m.getSectionId()` gives the price category.
  The models stay loaded on the payment step, with the picked seats still
  `isSelected()`.
- **Selecting a seat:** a real click runs `seat.markSeat('add')`, then
  `bd.lockSeats([seat])`. `lockSeats` locks it server-side and then calls
  `permanentlySelectSeat()` and `bd.addSeat(seat)` itself. Doing exactly
  those two calls from code works: the map draws the seat, the header shows
  "Reihe E | Platz 24,25", and Weiter becomes enabled.
- **Deselecting a seat:** `seat.markSeat('remove')`, then
  `bd.unlockSeats([seat])`, which runs `unlockSeat`, `unselectSeat` and
  `removeSeat`.
- **Don't do this:** calling `temporarilySelectSeat()`,
  `lockSeats()` and `permanentlySelectSeat()` directly (the old
  `archive/seat-map.js` approach), or `unselectSeat()` alone. The seat then
  reports as selected, but `bd.attributes.seatsPlaced` keeps the old seats,
  the map doesn't redraw it, and Weiter stays disabled.
- **Price categories (sections):** `bd.attributes.sections.models`. In
  Mundsburg Kino 7 these are `1:VIP`, `2:PK 1`, `3:PK 2`, `4:PK 3` and
  `6:PK1-LOGE`. Only one is active at a time (`bd.getActiveSection()`).
  `bd.activateSection(id)` switches categories and resets the seat selection
  (`resetSeatSelection`), but the ticket count stays as it was. A click on a
  seat in another category does the same thing, and selects that seat too.
- **Ticket count needs an active category:** on a fresh page no category is
  active, and the ticket picker's + does nothing until a seat has been
  clicked once (that click only activates its category). `bd.getSeatingLimit()`
  equals the ticket count.
- **UCI's cart (`#customer-cart`) stays empty on the seat step** ("Es
  befindet sich noch nichts in Ihrem Warenkorb") until Weiter is pressed. On
  the payment step it has one line per row: `PK 2 | Reihe J | Sitz 13, 14`.
- **Unlimited eligibility per category:** Loge seats are eligible
  (`priceRows[].unlimitedTicketAvail === true` at 17,90 €). **VIP: OPEN.**
  The check was inconclusive because `book.priceRows` still showed the
  previous seats after stepping back and re-picking.

### The real tap path, and the enums — confirmed 2026-10-07

Used by the seat map in `better-uci.user.js` (`tapSeatIn`).

- UCI's canvas is a Pixi view
  (`components/SeatingPlan/core/views/SeatCollectionPixiView`, via
  require.js). Its Hammer `tap` runs
  `view.seatingHelper.onSeatSelectionStart(seat)`. The `release` that
  follows runs `view.onTouchEnd()`, which calls
  `seatingHelper.onSeatSelectionEnd()` once a selection is in progress.
  Calling those two with a seat model does everything a real tap does:
  select, deselect, enforce the seat limit (a tap past it does nothing),
  and switch category (it drops the current picks and selects the
  tapped seat). After `onSeatSelectionStart` alone, the seat is only
  `markedForSelection`, and Weiter stays disabled.
- The view isn't reachable from `book`. It is the `context` of its own
  listeners in `bd.attributes.seats._events` (the entry with a
  `seatingHelper`).
- `core/enums/SeatType`: `REGULAR 1`, `LOVECHAIR 2`, `WHEELCHAIR 3`,
  `HOUSESEAT 4`, `REMOVABLE 5`, `AISLE 0`. The model's `type` is the number
  as a string.
- `core/enums/SeatStatus`: `BROKEN 0`, `BLOCKED 1`, `FREE 2`,
  `RESERVED 3`, `SOLD 4`, `PREPAID 5`, `LOCKEDFORSALE 6`,
  `LOCKEDFORRESERVATIONS 7`, `LOCKEDFORSALEANDRESERVATION 13`,
  `SELECTEDFREE 52`, `SELECTEDLOCKEDFORSALE 56`,
  `SELECTEDLOCKEDFORRESERVATIONS 57`, `RESERVATION2SALE 53`.
- Wheelchair rows: Mundsburg Kino 8 names them `KR` (a suffix) for row
  `K`. The `R7` prefix form in the `seatStr` section above came from
  another hall, so expect both.
- **Gap rule:** UCI moves a pick that would leave a single free seat next
  to it. With 2 tickets and H1 free at the block end, tapping H2 selected
  H1. With J10 (aisle) and J9 picked, deselecting J10 left J10 picked and
  dropped J9. So code that taps several seats must check the selection
  after every tap rather than assume it.
- Model attributes `isAisleSeat` is true at every block end, wall side
  included. `isEdgeSeat` was false everywhere in Kino 8.
  `neighborLeftUnlinked`/`neighborRightUnlinked` are the strings
  `"true"`/`"false"`.
- Lowering the ticket count clears the seat selection; raising it keeps it.
- Section models have only `name`, not colours. UCI's legend colours
  exist only in its DOM.

## Ticket-type ID reference

IDs are stable across price categories within a given performance (only
the price amounts change per category):

| ID | Type | Example label |
|---|---|---|
| `10000000999PJOBECA` | ADULT | Erwachsener |
| `20000000999PJOBECA` | CHILD | Kind unter 12 J |
| `07000000999AKQLNRG` | FAM_CHILD | Fam-Tarif: Kind (unter 12 J) |
| `E6000000999AKQLNRG` | FAM_ADULT | Fam-Tarif: Erw. |

Whether these exact ID strings are stable across different performances,
films, or cinemas (as opposed to just across price categories within one
performance) is **OPEN** — only ever observed within a single session.

## Checkout steps (DOM) — confirmed 2026-10-07

Walked live up to (not past) the payment details, 1 ticket, nothing paid:

- **Seat step → payment:** `#nextStepButton` ("weiter"), disabled until
  tickets and that many seats are picked. The payment step's
  `#init-checkout-process-button` is rendered about 2s after the click.
- **Payment step, something left to pay:** `#init-checkout-process-button`
  opens "Buchungsabschluss und Zahlung hinterlegen"
  (`#payment-type-others-content`), with the tabs
  `#payment-type-paypal-tab` / `#payment-tab-cc-tab` and the buttons
  `#pay-with-paypal-button` (redirects to PayPal) and
  `#pay-with-cc-button`. Card details go into CrefoPay hosted-field
  iframes (`api.crefopay.de/secureFields`). The confirm step isn't shown
  yet at that point; `#init-checkout-process-button` stays rendered.
- **Payment step, everything covered:** `#payment-type-free-content`
  (hidden otherwise) holds `#pay-with-balance-button` ("Weiter zum
  Zahlungsabschluss"). **OPEN:** not yet seen visible live.
- **Confirm step:** `form#payment-confirmation-agb-acceptance` with
  `#payment-confirmation-abg-acceptance-checkbox` (sic, "abg"), a second
  `#movie-card-confirmation-abg-acceptance-checkbox` that is `d-none`
  unless a Movie Card is involved, and the submit button
  `#jetzt-kaufen-button` ("JETZT KAUFEN"), disabled until the terms are
  ticked. **OPEN:** whether ticking the checkbox via `click()` enables the
  button (expected, since it's UCI's own change handler), and where
  the page goes after submitting.
