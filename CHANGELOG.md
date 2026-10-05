# Changelog

## 3.1.9

Booking page:

- After EINLÖSEN, the cart bar at the bottom no longer stays dimmed with a
  spinner over the total. UCI's own cart refresh puts that loading mask up
  and leaves removing it to the caller; UCI's voucher flow does, the script
  didn't. It now removes the cart bar's mask once the page has updated
  (confirmed on the live page: the mask stayed after the update, and was
  gone with the fix, total unchanged).

## 3.1.8

Programme page:

- The programme loads again. It showed "Kein Programm gefunden" for every
  cinema. UCI changed its showtime links from
  `…/performanceId/<id>/siteId/<n>` to
  `https://buchung.uci-kinowelt.de/?perf_id=<id>&site_id=<n>`, and only
  the old form was recognised, so every showtime and with it every film
  was dropped. Both forms are read now (confirmed on the live East Side
  Gallery page: 0 films before, 63 films with 275 showtimes after).
- Demnächst retries up to twice when UCI's server answers with its
  intermittent 502/503 "Störung" page, instead of giving up at once.

## 3.1.7

iPhone (Userscripts in Safari):

- The Unlimited Card panel works. It used to stay on "Warenkorb wird
  gelesen…" with no cards. Userscripts doesn't provide `GM_getValue`, so
  the first update tick threw a ReferenceError and the loop that fills the
  panel never ran again (confirmed in the iOS simulator). That loop was
  also what auto-expands the section, which is why it once loaded
  "neither expanded nor expandable" (3.0.1).
- Storage uses `GM.getValue`/`GM.setValue` where `GM_getValue` doesn't
  exist. Saved cards, the payment method and programme settings now
  persist on iPhone. Nothing was ever saved there before, so cards have to
  be added once, or brought over with Exportieren/Importieren.
- With those permissions Userscripts runs the script walled off from the
  page, so a small helper injected into the page reads the booking state
  and sends the requests through UCI's own jQuery, as Tampermonkey does
  directly.
- One failing step can no longer stop the panel's update loop, and errors
  show in the panel's log, since a phone has no console. "Unlimited Cards
  verwalten" shows a status line (page access, storage).

Programme page:

- Showtime pills are smaller (60×34 instead of 76×38) and the number per
  row follows the actual width. A 390px+ iPhone shows 4 pills plus
  "+N weitere" (was 3), a 375px one 3, desktop up to 9 (was 6), and a film
  with only one line's worth shows them all.

## 3.1.6

Programme page (phone width):

- Date tabs are one swipeable row instead of three wrapped rows.
- Woche fits each film on one line: 3 showtimes plus "+N weitere" (or
  all 4 if there are exactly 4) instead of 6 across two lines;
  Weitere shows 6 dated chips, three per line, with two-digit years.
- Demnächst keeps "Buchen" beside the title.

Booking page:

- Phone width: ticket picker uses the full width as a single box (no
  box-in-box); the back link no longer
  wraps; the seat-map legend no longer breaks labels mid-word.
- "1 freier Platz" instead of "1 freie Plätze".
- The "Nach diesem Schritt …" voucher warning is hidden again — UCI moved
  it, so the old rule stopped matching.
- Card names, card numbers and server error messages are escaped before
  being written into the page — an imported card list could previously
  inject HTML into the booking page.
- Ticket picker: prices always sit on their own line under the ticket
  name, instead of jumping between beside and below it.
- "Fam. Erw." explains why it can't be added ("nur mit Fam. Kind"), and a greyed-out "Weiter" says "Erst Tickets und Plätze wählen".
- The two top bars (logo/name and back arrow) are merged into one quiet
  row on the page background: "‹ Zurück" on the left, name on the right.
- Payment-method memory clicks only the PayPal / Kreditkarte *tabs*, by
  their ids. It used to click the first element containing that text —
  which only worked because the tabs come before the "JETZT … ZAHLUNG
  HINTERLEGEN" buttons in the page.
- Deleting a saved card: the × is always visible (it was invisible on
  touch devices) and needs a second click ("löschen?") to confirm.

## 3.1.1

Programme page:

- Showtime chips are real links: Cmd/middle-click opens a booking in a
  new tab, and they're reachable with the keyboard.
- Poster and title link to the film's own UCI page (trailer, description).
- The dark box behind each title is gone — it was UCI's own `.film-info`
  style leaking onto ours via a shared class name.
- OmU/OmeU chips are tinted blue like OV, matching what Nur OV counts as
  original language.
- Weekday/date prefixes on chips are de-emphasized so the times stand out.
- Day tabs no longer show "+N diese Woche" — Woche covers that now.
- "Kompakt" toggle removed; the compact layout is the only one.
- The "Ihre Filme im UCI Kino …" heading lines up with the panel.

## 3.1.0

Programme page:

- New default **Woche** tab: every film playing in the next 8 days, each
  with its next 6 showings labelled by weekday ("Fr 20:10", "Sa 17:00") and
  the rest behind "+N weitere" — no clicking through day tabs to see the
  week. The day tabs stay for "what's on Saturday?"-style browsing.
- Showings from today that have already started are left out of Woche.
- Film rows are top-aligned: expanding "+N weitere" no longer slides the
  poster and title down.
- Showtime chips are all the same size (one width for this week, a wider
  one for Weitere's dated chips) instead of sizing to their labels.

## 3.0.3

Programme page:

- Film count ("21 Filme") and the Weitere section counts now respect
  Nur OV instead of counting films with no OV showing.
- Weitere tab no longer disappears while searching — it used to vanish
  when the query had no far-future match, shifting Demnächst under the
  cursor. A search with no Weitere hits now shows an empty state instead.
- Films the native page lists twice (e.g. ALWAYS LALISA) are merged into
  one row instead of appearing as duplicates.
- Search ✕ now actually clears the search. Chrome's built-in clear button
  only worked if the field was already focused, so the first click
  usually did nothing; it's replaced with the panel's own button.
- Rows in Weitere with more than 12 dates collapse behind "+N weitere"
  instead of a wall of 40+ chips.
- Titles wrap to two lines (and show in full on hover) instead of
  truncating to one, so titles that only differ at the end are
  distinguishable.
- Date tabs with no showings yet (usually the unpublished end of the
  week) are dimmed.

Repo:

- `test/validate-fixtures.js` imports from `archive/seat-map.js`, where
  the seat-parsing code moved in 3.0.0; it previously crashed on load.

## 3.0.0

Booking page:

- Ticket quantity picker replaced with a compact segmented stepper instead
  of the native spread-out circle buttons.
- Seat-selection layout narrowed to a fixed column next to the seat map
  instead of stretching full-width; the redundant heading above it removed.
- Payment step decluttered: Unlimited Card is now always expanded and no
  longer collapsible; Movie Points and Gutscheine are demoted behind a
  single lean toggle instead of two full-width accordion cards;
  Buchungsabschluss is reduced to a bare "Weiter" button with no header or
  card chrome; the redundant "ZAHLUNGSMITTEL" heading/subtitle and the
  voucher-lockout notice are removed.
- An empty Gutscheine account is flagged with a "leer" badge on its
  (still-collapsed) header instead of requiring a click to find out.
- Last-used payment method (PayPal/Kreditkarte) is remembered and
  pre-selected on the next booking.
- Sweepstakes banner image capped in height so it no longer pushes the
  continue button further down than necessary.
- Native header above the seat step redesigned: the FSK callout is
  removed, the poster and text are shrunk, and the fixed header bars
  (logo/account bar, back-button bar) are tightened up.
- Floating fallback panel removed — the redeemer panel now only ever
  mounts inline at the payment step, instead of floating over the
  seat-selection step while its usual host doesn't exist yet.
- "Debug-Logs" and "UCI-Originalfelder" toggles removed from the panel;
  several labels reworded ("Karten verwalten" → "Unlimited Cards
  verwalten", "Karte hinzufügen" → "Unlimited Card hinzufügen").

Programme page:

- Mobile layout: poster+title and showtime chips now wrap onto separate
  lines below ~640px instead of cramming three columns into one row; long
  titles clamp to two lines instead of truncating mid-word.
- "Kompakt" is forced on below 640px (the wide-poster layout didn't work
  at that width) and its checkbox is hidden there; the search box
  collapses to a magnifying-glass icon that expands on tap.
- "Nur OV" now also matches OmU/OmeU showings, not just an exact "OV" tag.
- New "+N diese Woche" toggle on a film's row shows its other showtimes
  within the same 8-day window inline, without switching days.

## 1.0.0

First release.

- Redeem multiple Unlimited cards in one sequential run.
- Panel replaces the Unlimited section on the payment step; hidden during
  seat selection.
- Own card read from login; friends' cards stored locally.
- Live basket: total tickets, redeemed, Movie Points, still to pay, sum.
  Booking fee shown only when non-zero.
- Pre-selection capped at the number of open seats; manual choices respected.
- Already-redeemed cards detected (including after reload) and skipped.
- Assigns each card to the most expensive free seat.
- Per-card and per-step progress with a live elapsed counter.
- Backoff retry on transient errors; single-card retry button.
- Server refusals reported immediately without pointless retries.
- Duplicate card numbers flagged and skipped.
- JSON export/import of the card list.
- Opens the checkout section after a fully successful run, only when nothing
  is left to redeem.
- Title notification when the run finishes in a background tab.
