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
