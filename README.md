# better-uci
A [Tampermonkey](https://www.tampermonkey.net/) userscript with two
independent fixes for the UCI Kino website:
- **Booking page** — redeem several Unlimited cards in one click instead of a
  multi-step dialog per card.
- **Programme page** — a denser, filterable schedule view instead of the
  native poster grid.
## Install
1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Chrome only: `chrome://extensions` → enable **Developer mode**, then enable
   **Allow user scripts** on Tampermonkey. Without this the script silently
   never runs.
3. **[Install better-uci](https://raw.githubusercontent.com/n-klocke/better-uci/main/better-uci.user.js)**
Updates install themselves.
## iPhone / iPad
Tampermonkey doesn't exist on iOS. Use
[Userscripts](https://apps.apple.com/app/userscripts/id1463298887) instead —
a free, open-source Safari extension that runs `.user.js` files directly, no
desktop needed.
1. Install **Userscripts** from the App Store.
2. **Settings** app → **Safari** → **Extensions** → **Userscripts** → turn it
   on → allow it for **All Websites** (or at least the `uci-kinowelt.de`
   domains).
3. In Safari, open
   [the raw script URL](https://raw.githubusercontent.com/n-klocke/better-uci/main/better-uci.user.js)
   — Userscripts should offer to install it. If it doesn't, open the
   Userscripts app itself and add it from that same URL.
4. Visit the booking or programme page, tap the puzzle-piece icon in
   Safari's address bar → **Userscripts**, and confirm better-uci is
   enabled for that site.
Updates show up in that same Userscripts popup (cloud icon), tap to
install. Saved cards don't sync from your desktop: bring them over with
**Unlimited Cards verwalten** → Exportieren / Importieren.
Only Safari works this way — Chrome, Firefox, etc. on iOS are all just
Safari's engine underneath and can't run extensions at all.
## Booking page: card redemption
<img width="553" height="473" alt="Screenshot 2026-08-15 at 18 49 11" src="https://github.com/user-attachments/assets/fc0470f9-c531-46dd-8c3f-8e190e38fcba" />
Replaces the **Unlimited Card** section of the payment step with a list of
saved cards, live status, and automatic retry on UCI's intermittent errors.
Pick seats → continue to payment → **EINLÖSEN**. Your own card is read from
your login; add friends' cards once via **+ Karte hinzufügen**. It
pre-selects as many cards as there are open seats, picks the priciest seats
first, and skips cards already redeemed — including after a reload.
It doesn't make UCI faster — each call is still 5–10s server-side — it just
removes the clicking, the typing, and retrying failed attempts by hand. Seat
selection, checkout, payment, and the wallet pass stay manual. Card numbers
live only in browser storage and are sent nowhere except
`buchung.uci-kinowelt.de`; export them via **Karten verwalten** and treat
that JSON like a credential.
## Programme page: schedule browser
<img width="553" height="473" alt="Screenshot 2026-08-15 at 18 47 38" src="https://github.com/user-attachments/assets/d5bfc3fa-0dec-4bd7-a2b8-ee044a3731ea" />
Replaces the poster grid with a list view:
- **Date tabs** — today plus the next 7 days, one click away instead of a
  filter panel.
- **New this week** — films in their first week get a yellow **NEU**
  badge, films opening within the next 8 days a **Start** date badge.
- **Nur OV** and **Nur neu** toggles, saved across visits.
- **Weitere** — everything beyond the 8-day window, grouped into *Nächste 30
  Tage* / *Später dieses Jahr* / *Nächstes Jahr und später* rather than one
  section per date. One row per film, with every one of its remaining dates
  as chips.
- **Demnächst** — real announcement data fetched from `/coming-soon` on
  first click: release date, and a **Buchen** button once it's actually
  bookable.
- A **search box** that filters whichever tab you're on, umlaut-insensitive.
## Security & safety
- **Stays on UCI's domains.** Matches only `buchung.uci-kinowelt.de` and
  `www.uci-kinowelt.de`; the one extra fetch (`/coming-soon`) is
  same-origin. Nothing is sent anywhere else — no analytics, no third
  party, not even to me.
- **Minimal permissions.** Just `GM_setValue`/`GM_getValue` for local
  storage (or `GM.setValue`/`GM.getValue`, which is all Userscripts on
  iPhone offers) — no clipboard, no cross-origin requests.
- **No new login.** Reuses the page's own session; it never sees your UCI
  credentials.
- **Not obfuscated.** One plain-text file — open it in Tampermonkey and
  every line is what runs.
- **Cards stay local.** Stored on your machine only, never synced to me.
  Treat an exported backup like a credential.
## Development
The booking flow calls several undocumented UCI endpoints — see
[`docs/API.md`](docs/API.md) for what's confirmed about each one (request
shapes, required headers, the `seatStr` field format) versus what's still
open. `fixtures/` has a real captured API response to check any parsing
logic against without needing a live session; run `node
test/validate-fixtures.js` to verify the current claims in `docs/API.md`
against it.
## Troubleshooting
No panel on either page? Filter the console for `[uci-batch]` (booking page)
or `[uci-browse]` (programme page) — both log what they find on load, so an
empty filter usually means the script isn't running (check install step 2)
rather than a bug in the page logic.
On iPhone there's no console: open **Unlimited Cards verwalten** in the
panel. Its last line shows whether the booking data and storage are
reachable, and internal errors are listed in the panel's log box.
## Disclaimer
Unofficial, not affiliated with UCI. Automates only what you're entitled to
do as a cardholder or visitor, which may still conflict with their terms.
Use at your own risk. Breaks whenever UCI changes their site.
MIT
