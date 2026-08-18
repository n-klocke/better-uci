# Changelog

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
