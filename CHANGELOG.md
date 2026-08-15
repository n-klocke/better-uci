# Changelog

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
