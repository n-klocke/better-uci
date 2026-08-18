// ============================================================================
// ARCHIVED — custom seat map, paused. Not wired into better-uci.user.js and
// does nothing on its own sitting here. Read seat-map.md first — it has the
// status, what's confirmed working, what was never resolved, and exactly
// how to paste this back in if you pick it up again.
//
// This is the code AS IT LAST RAN, extracted verbatim (not rewritten) so a
// diff against a future re-integration attempt is meaningful. It expects
// the following from its surrounding scope — all of them already exist in
// better-uci.user.js's initRedeemer(), which is where every function below
// used to live:
//
//   TAG                          — this module's console-log prefix ('[uci-batch]')
//   getBook()                    — resolves window.book across the Tampermonkey
//                                  sandbox boundary (via pageWin()/unsafeWindow)
//   bpid()                       — current bookingProcessId, or falsy
//   findActiveTicketContainer()  — from the still-live ticket-selector feature;
//   ticketRows()                   totalTicketCount() below calls both
//
// The four pure functions at the top (parseSeatStr, rowKey, groupSeatsByRow,
// seatMapHTML) have no such dependency and are directly testable under
// plain `node` — see seat-map.test.js, which requires this file the same
// way test/validate-fixtures.js used to require better-uci.user.js.
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSeatStr, rowKey, groupSeatsByRow, seatMapHTML };
  return;
}

// Each seatStr entry is pipe-delimited:
//   seatNum|row|x|y|f4|w|h|availability|leftNeighbor|rightNeighbor|f10|f11|colIndex
// f4, f10, f11 have confirmed-but-unused meaning: f4 varies (1/2/3) and
// looked like it might indicate seat-pairing/width class, but the
// neighbor-based rounding in seatMapHTML achieves the same "capsule"
// grouping more reliably, so it was never actually needed. f10/f11 are
// non-zero in some auditoriums and always "0" in others (confirmed across
// two different real datasets) — likely some kind of row-above/row-below
// seat reference, never needed for anything this script does. colIndex
// (last field) resets to 1 at the start of every row — that's the
// customer-facing "Platz" number seat tooltips show, not seatNum (field
// 0), which is an internal booking id that runs continuously across a
// whole section instead of restarting per row. Kept as a string, not
// coerced to a number, since wheelchair-designated seats carry an
// R-prefixed variant ("R2", "R1").
//
// Field 4 (previously unconfirmed) is a seat-class flag: "1" normal,
// "2" one half of a couple/loveseat pair, "3" wheelchair-designated
// (always co-occurs with an R-prefixed row — confirmed against every
// seat in fixtures/seatsAndTickets.sample.json). Every "2" seat has
// exactly one neighbor that's also "2", so pairs, never larger groups.
function parseSeatStr(str, sectionId, sectionName) {
  return str.split(';').filter(Boolean).map((entry) => {
    const f = entry.split('|');
    return {
      num: +f[0], row: f[1], x: +f[2], y: +f[3], w: +f[5], h: +f[6],
      leftNeighbor: +f[8], rightNeighbor: +f[9], colIndex: f[12],
      wheelchair: /^R/.test(f[1]),
      coupled: f[4] === '2',
      available: f[7] === '2',
      sectionId, sectionName,
    };
  });
}

// "7" and "R7" are the same physical row — R marks the
// wheelchair-designated spots within it, not a separate row. Grouping by
// raw y-value treated them as two rows a couple pixels apart, inserting a
// phantom extra row-slot that pushed every row below it down unnecessarily
// (part of the overlap). Grouping by this R-stripped key merges them back
// into one — the native map shows exactly this merged label ("7,R7") for
// the same reason.
function rowKey(row) {
  return String(row).replace(/^R/i, '');
}

function groupSeatsByRow(seats) {
  const groups = new Map(); // key -> { minY, rawRows: Set, sectionIds: Set }
  seats.forEach((s) => {
    const key = rowKey(s.row);
    if (!groups.has(key)) groups.set(key, { minY: s.y, rawRows: new Set(), sectionIds: new Set() });
    const g = groups.get(key);
    g.minY = Math.min(g.minY, s.y);
    g.rawRows.add(s.row);
    g.sectionIds.add(s.sectionId);
  });
  return groups;
}

// Row numbering is NOT independent per price section — it's one
// continuous physical sequence across the whole auditorium (confirmed
// against the real native map: rows read 7,R7 / 6 / 5 / 4 / 3 / 2 / 1
// top to bottom, with PK1's row 4 and row 1 correctly NOT adjacent —
// PK1 LOGE's rows 3 and 2 sit physically between them). An earlier
// attempt grouped rows by section first, which broke that real
// interleaving (it visually moved PK1's two rows next to each other).
// Reverted to sorting every row globally by minY, matching the native
// layout exactly; row labels are colored by section below instead, as
// a hint that doesn't require moving anything.
// `selected` (optional Set of seat nums) tells the renderer which
// unavailable seats are unavailable because WE hold them, rather than
// because someone else does — without it, a seat we'd just selected
// fell through the `!s.available` check the same as any taken seat,
// rendering it disabled and grey (sm-taken) with no way to click it
// again to deselect, and fighting visually with the sm-selected
// checkmark.
function seatMapHTML(seats, selected) {
  const minX = Math.min(...seats.map((s) => s.x)), maxX = Math.max(...seats.map((s) => s.x + s.w));
  const pad = 12;
  const totalW = maxX - minX + pad * 2;
  const sectionClass = { 2: 'sm-pk1', 3: 'sm-pk2', 4: 'sm-pk3', 6: 'sm-loge' };

  const groups = groupSeatsByRow(seats);
  const orderedKeys = [...groups.keys()].sort((a, b) => groups.get(a).minY - groups.get(b).minY);
  const rowIndex = new Map(orderedKeys.map((k, i) => [k, i]));

  // Seat height shrunk ~12% per request, on top of the row-merge fix —
  // together these should close up whatever overlap is left.
  const shrink = 0.88;
  const rowH = Math.max(...seats.map((s) => s.h)) * shrink + 10;
  const totalH = orderedKeys.length * rowH + pad * 2;
  const topFor = (row) => rowIndex.get(rowKey(row)) * rowH + pad;

  const rowLabels = orderedKeys.map((key) => {
    const g = groups.get(key);
    const label = [...g.rawRows].sort((a, b) => (/^R/i.test(a) ? 1 : 0) - (/^R/i.test(b) ? 1 : 0)).join(',');
    // Every seat in a row-group belongs to the same section in practice
    // (no two sections share a row label in real data) — colored to
    // match that section's seat color, purely as a visual hint.
    const rowSectionId = [...g.sectionIds][0];
    return `<div class="sm-rowlabel ${sectionClass[rowSectionId] || 'sm-pk1'}" style="top:${rowIndex.get(key) * rowH + pad}px;height:${rowH - 10}px">${label}</div>`;
  }).join('');
  const byNum = new Map(seats.map((s) => [s.num, s]));
  const seatEls = seats.map((s) => {
    const isMine = !!selected?.has(s.num);
    const cls = ['sm-seat', sectionClass[s.sectionId] || 'sm-pk1'];
    if (isMine) cls.push('sm-selected');
    else if (!s.available) cls.push('sm-taken');
    if (s.wheelchair) cls.push('sm-wheelchair');
    const title = `${s.sectionName}, Reihe ${s.row}, Platz ${s.colIndex}`;
    // A seat with no neighbor on a given side is either alone or at the
    // end of a run — rounding that side (and only that side) reproduces
    // the native map's "capsule" blocks, isolated pairs included.
    const r = 6;
    const radius = `${s.leftNeighbor === 0 ? r : 0}px ${s.rightNeighbor === 0 ? r : 0}px ${s.rightNeighbor === 0 ? r : 0}px ${s.leftNeighbor === 0 ? r : 0}px`;
    // Couple/loveseat pairs (field 4 === "2") share one physical seat
    // with no divider — dropping the border on just their shared inner
    // edge (both halves, so no 1px sliver is left from either side)
    // reproduces that, independent of the capsule-rounding above, which
    // only ever touches the outer ends of a whole run.
    const pairedLeft = s.coupled && s.leftNeighbor !== 0 && byNum.get(s.leftNeighbor)?.coupled;
    const pairedRight = s.coupled && s.rightNeighbor !== 0 && byNum.get(s.rightNeighbor)?.coupled;
    const borderOverride = `${pairedLeft ? 'border-left:none;' : ''}${pairedRight ? 'border-right:none;' : ''}`;
    return `<button class="${cls.join(' ')}"
      style="left:${s.x - minX + pad}px;top:${topFor(s.row)}px;width:${s.w}px;height:${s.h * shrink}px;border-radius:${radius};${borderOverride}"
      data-num="${s.num}" ${!s.available && !isMine ? 'disabled' : ''} title="${title}"></button>`;
  }).join('');
  return `
    <div class="sm-legend">
      <span class="sm-legenditem"><i class="sm-swatch sm-pk1"></i>PK 1</span>
      <span class="sm-legenditem"><i class="sm-swatch sm-pk2"></i>PK 2</span>
      <span class="sm-legenditem"><i class="sm-swatch sm-pk3"></i>PK 3</span>
      <span class="sm-legenditem"><i class="sm-swatch sm-loge"></i>PK 1 LOGE</span>
    </div>
    <div class="sm-stage"><div class="sm-screen-curve"></div><div class="sm-screen-label">Leinwand</div></div>
    <div class="sm-grid-wrap"><div class="sm-grid" style="width:${totalW}px;height:${totalH}px">${seatEls}${rowLabels}</div></div>`;
}

// ----------------------------------------------------------------------------
// Everything below here is browser-only (references TAG/getBook/bpid/
// findActiveTicketContainer/ticketRows from the surrounding scope — see the
// header). This is exactly the CSS block and JS that used to live inside
// better-uci.user.js's initRedeemer(), unreachable from Node.
// ----------------------------------------------------------------------------

/* CSS (was inside injectSeatingLayoutCSS()'s <style> template literal) */
const SEAT_MAP_CSS = `
      /* Custom seat map — sits above the native one for now (see
         mountSeatMap), not replacing it, so clicks can be visually
         cross-checked against the real canvas before it's hidden. */
      #uci-seatmap {
        background: #10141c; border: 1px solid rgba(255,255,255,.08);
        border-radius: 10px; padding: 16px; margin-bottom: 14px; overflow: hidden;
      }
      #uci-seatmap .sm-loading { padding: 50px; text-align: center; color: #8b97a8; font-size: 13px; }
      #uci-seatmap .sm-legend { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; font-size: 11.5px; color: #8b97a8; }
      #uci-seatmap .sm-legenditem { display: flex; align-items: center; gap: 5px; }
      #uci-seatmap .sm-swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
      #uci-seatmap .sm-swatch.sm-pk1, #uci-seatmap .sm-seat.sm-pk1 { background: #9fa8e0; }
      #uci-seatmap .sm-swatch.sm-pk2, #uci-seatmap .sm-seat.sm-pk2 { background: #4a5570; }
      #uci-seatmap .sm-swatch.sm-pk3, #uci-seatmap .sm-seat.sm-pk3 { background: #3ec9c9; }
      #uci-seatmap .sm-swatch.sm-loge, #uci-seatmap .sm-seat.sm-loge { background: #2f7fd6; }
      #uci-seatmap .sm-stage { text-align: center; margin-bottom: 14px; }
      #uci-seatmap .sm-screen-curve {
        height: 2px; width: 70%; margin: 0 auto 6px;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,.5), transparent);
        border-radius: 50%;
      }
      #uci-seatmap .sm-screen-label { font-size: 11px; color: #8b97a8; letter-spacing: .5px; text-transform: uppercase; }
      #uci-seatmap .sm-grid-wrap { width: 100%; overflow: hidden; }
      #uci-seatmap .sm-grid { position: relative; margin: 0 auto; }
      #uci-seatmap .sm-seat {
        /* min-height:0/min-width:0 are load-bearing. This site sets a
           global min-height:45px on <button> elements — confirmed via
           getComputedStyle here specifically, after several rounds of
           wrongly assuming a positioning-math bug was causing rows to
           overlap. It wasn't: every seat was silently 45px tall
           regardless of the height set below, clamped by this site rule,
           eating straight through the row gaps. Remove this and that
           overlap comes back. */
        position: absolute; box-sizing: border-box; min-height: 0; min-width: 0;
        border: 1px solid rgba(2,11,32,.55); padding: 0;
        cursor: pointer; transition: transform .1s ease, filter .15s ease, background .15s ease, box-shadow .15s ease;
      }
      #uci-seatmap .sm-seat:not(.sm-taken):hover { filter: brightness(1.25); transform: scale(1.1); z-index: 2; }
      #uci-seatmap .sm-seat.sm-taken { background: #3a4152 !important; opacity: .6; cursor: default; }
      /* Darkens the seat's own category color rather than replacing it or
         ringing it — keeps a hint of which category it is while reading
         clearly as selected, no border/outline involved. */
      #uci-seatmap .sm-seat.sm-selected { filter: brightness(.4); box-shadow: none; }
      #uci-seatmap .sm-seat.sm-selected::after {
        content: '✓'; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        color: #fff; font-size: 13px; font-weight: 700; line-height: 1;
      }
      #uci-seatmap .sm-seat.sm-pending { opacity: .55; cursor: wait; }
      #uci-seatmap .sm-seat.sm-error { box-shadow: 0 0 0 2px #ff6b6b inset; }
      /* Always styled as a wheelchair seat, regardless of taken/available
         — the previous rule specifically excluded taken seats from this,
         but the availability rule marks these unavailable by default
         (field[7]!==2), so the exclusion meant it never applied at all,
         and wheelchair seats just looked like empty gaps. */
      #uci-seatmap .sm-seat.sm-wheelchair { background: #e8e8ea !important; opacity: 1 !important; }
      #uci-seatmap .sm-seat.sm-wheelchair::after {
        content: '♿'; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        font-size: 12px; line-height: 1;
      }
      #uci-seatmap .sm-rowlabel { position: absolute; right: -22px; font-size: 10px; color: #8b97a8; line-height: inherit; display: flex; align-items: center; font-weight: 700; }
      /* Colored to match the row's price section (every row belongs to
         exactly one — no two sections share a row label in real data) so
         a section boundary is visible at a glance without needing to
         reposition anything relative to the native map's own row order. */
      #uci-seatmap .sm-rowlabel.sm-pk1 { color: #9fa8e0; }
      #uci-seatmap .sm-rowlabel.sm-pk2 { color: #8b97a8; }
      #uci-seatmap .sm-rowlabel.sm-pk3 { color: #3ec9c9; }
      #uci-seatmap .sm-rowlabel.sm-loge { color: #2f7fd6; }
`;

// ===== Custom seat map =====
//
// Rendering is ours: real geometry from seatsAndTickets.json, and
// field[7] === 2 as the availability signal — verified against 79 real
// seats (78 clean matches, one explained exception: wheelchair-type
// seats can carry field[7]===1 whether occupied or not, which is why
// wheelchair seats are identified by their row label instead, not by
// this field).
//
// Selection calls the site's own internal Backbone objects directly —
// window.book.seatingApp.bookingData (a BookingDataModel) and the
// specific seat's own model from its `seats` collection — rather than
// simulating a click. Two earlier approaches were tried and rejected
// first:
//   1. A direct fetch() to selectSeats.json: updated the SERVER side
//      only. The native canvas never found out, so "weiter" stayed
//      disabled — whatever gates it is populated by the site's own
//      click handling, not by the server alone knowing a seat is held.
//   2. A synthetic click dispatched at the seat's real canvas
//      coordinates: this got much further (confirmed via real testing
//      that coordinate math, `view`, and event properties were all
//      correct), but reliably selected a DIFFERENT seat than intended,
//      by a non-constant offset — something inside the site's
//      Hammer.js/Pixi.js gesture-to-hit-test pipeline that isn't
//      controllable from outside via dispatched events.
// `seatModel.temporarilySelectSeat()` mirrors a real click's first,
// optimistic step; `bookingData.lockSeats([seatModel])` is what
// actually validates and locks it server-side — confirmed via a real
// stack trace that this is exactly what the native click handler calls
// internally (CoreSeatingHelper.finishValidation → BookingDataModel.
// lockSeats). Operating on the seat by direct object reference removes
// the coordinate-mapping ambiguity entirely. Every call is still
// verified afterward via a plain re-fetch of seatsAndTickets.json,
// same as before — never assume success just because the call didn't
// throw.
//
// Because the site's own handler decides ticket-type assignment again,
// the earlier single-price-category lock (needed only because the
// direct-fetch version had to replicate that assignment logic itself)
// is gone — selecting across multiple price categories in one booking
// is safe again.
const seatMapState = { seats: [], selection: new Set(), busy: false };

async function fetchSeatMapData(retries = 3, delayMs = 1200) {
  const bid = bpid();
  if (!bid) return null;
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const params = new URLSearchParams({
      bookingProcessId: bid,
      allowCache: 'false',
      instanceId: String(Math.floor(Math.random() * 90000) + 10000),
      verboseSeatInfo: 'false',
      noRefresh: 'false',
      advancedFormat: '1',
      reason: 'Get seats and tickets data',
      _: String(Date.now()),
    });
    // No /booking/ prefix here, unlike init.json, selectSeats.json, and
    // bonusAndVoucherTotal.json — this endpoint is the one exception.
    // Getting this wrong (adding /booking/ by pattern-matching the
    // others) caused persistent 404s that took several rounds of
    // debugging to trace back to the path itself.
    const url = `/TicketBoxXNG/seatsAndTickets.json?${params}`;
    try {
      const res = await fetch(url, {
        credentials: 'same-origin',
        // Both headers are required, not just conventional — omitting
        // x-requested-with specifically produced 404s too. The site's
        // backend appears to use it to distinguish real AJAX calls
        // from other requests.
        headers: { accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest' },
      });
      if (res.ok) {
        const data = await res.json();
        const seats = [];
        (data.sections || []).forEach((s) => seats.push(...parseSeatStr(s.seatStr, s.id, s.name)));
        return seats;
      }
      const bodyText = await res.text().catch(() => '');
      lastErr = new Error(`HTTP ${res.status} — ${bodyText.slice(0, 300)}`);
    } catch (err) {
      lastErr = err;
    }
    // A 404 right after bookingProcessId first appears client-side is
    // likely a race — the server side of that session may not be fully
    // ready yet, normally hidden by the site's own slower, sequenced
    // init.json → login.json → seatsAndTickets.json chain, which this
    // doesn't wait for. A short retry survives that without needing to
    // understand the exact sequencing requirement.
    console.warn(TAG, `seatsAndTickets.json attempt ${attempt}/${retries} failed:`, lastErr.message);
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastErr;
}

// mountSeatMap() used to wait for the native <canvas> to exist before
// calling fetchSeatMapData() at all — but that canvas only appears once
// the site's own init.json → login.json → seatsAndTickets.json chain has
// ALREADY finished and rendered it (see the comment above). Since this
// script's own fetch doesn't depend on that chain (only on
// bookingProcessId, which shows up much earlier), gating our fetch on the
// canvas guaranteed our map render started only after the native one had
// already completed, instead of racing it. This kicks the same request
// off as soon as bookingProcessId exists — in parallel with, not after,
// whatever the native page is doing — and caches it so mountSeatMap
// below can reuse it instead of starting a second, later fetch.
let seatDataPrefetch = null;
function prefetchSeatMapData() {
  if (!seatDataPrefetch && bpid()) {
    seatDataPrefetch = fetchSeatMapData().catch((err) => {
      // Clear the cache on failure so the next call (from the retry loop
      // in mountSeatMap, via the poll below) starts a fresh attempt
      // instead of forever replaying this same rejected promise.
      seatDataPrefetch = null;
      throw err;
    });
  }
  return seatDataPrefetch;
}

function totalTicketCount() {
  const container = findActiveTicketContainer();
  if (!container) return 0;
  return ticketRows(container).reduce((sum, r) => sum + (+r.count || 0), 0);
}

// Selection no longer goes through the canvas at all. A synthetic click
// (dispatched MouseEvents at the seat's exact data coordinates) was
// tried extensively: the coordinate math, `view`, and `buttons` were
// all individually confirmed correct, yet it reliably selected a
// DIFFERENT seat than intended, immediately (not a timing issue —
// tested with a much longer poll window, same result), by an offset
// that wasn't constant (sometimes a different row, sometimes a
// different column). That points to something inside the site's own
// Hammer.js/Pixi.js gesture-to-hit-test pipeline that isn't controllable
// via MouseEventInit properties from outside — not something to keep
// guessing at.
//
// Instead, this calls the real internal Backbone objects directly,
// confirmed working via real console testing before wiring this in:
// `seatModel.temporarilySelectSeat()` mirrors the optimistic local step
// a real click does first, and `bookingData.lockSeats([seatModel])` is
// what actually validates and locks it server-side (confirmed via a
// real stack trace: CoreSeatingHelper.finishValidation calls exactly
// this). This operates on the seat by direct object reference, not by
// pixel position, so there's no coordinate ambiguity possible.
//
// Deselection (`unselectSeat()`) is comparatively less tested — only
// selection was directly verified against a real "weiter" enable
// before this was wired in. Still verified via the same re-fetch
// pattern as before: never assume success just because the call didn't
// throw.
function getSeatModel(num) {
  const bd = getBook() && getBook().seatingApp && getBook().seatingApp.bookingData;
  const seats = bd && bd.attributes && bd.attributes.seats;
  return seats ? seats.get(String(num)) : null;
}

// The real source of truth for "did WE select this seat" — queried
// fresh on every render instead of maintaining our own separate
// tracking Set, which could silently drift from reality (e.g. if a
// selection changes through some path this script doesn't observe).
function computeSelectedNums(seats) {
  const result = new Set();
  seats.forEach((s) => {
    const model = getSeatModel(s.num);
    if (model && model.isSelected()) result.add(s.num);
  });
  return result;
}

// Applies the local Backbone mutation for a select/deselect. These are
// synchronous, no-network-of-their-own calls (confirmed via direct
// testing), so the model's own isSelected() — what computeSelectedNums
// reads — is correct the instant this returns. Nothing here needs
// waiting on a network round-trip.
function applySeatSelection(deselecting, model) {
  if (deselecting) {
    model.unselectSeat();
  } else {
    model.temporarilySelectSeat();
    getBook().seatingApp.bookingData.lockSeats([model]);
    // temporarilySelectSeat() alone does NOT flip isSelected() to true
    // (confirmed via direct testing — it only marks the seat, no
    // checkmark). Without this call, computeSelectedNums() would never
    // find this seat, and the next render would fall back to sm-taken
    // styling instead of sm-selected.
    model.permanentlySelectSeat();
  }
}

// Confirms the server actually agrees with the local change, in the
// background — does NOT block the UI (which already updated
// optimistically in onSeatClick, using the just-set local model state).
// Only relevant if this somehow silently didn't take server-side, which
// hasn't been observed in testing but is worth still checking rather
// than trusting blindly, per the same "never assume success" reasoning
// used everywhere else in this file.
async function verifySeatSelection(seat, deselecting) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 200));
    const seats = await fetchSeatMapData().catch((err) => { console.warn(TAG, 'verifySeatSelection: fetchSeatMapData rejected', err); return null; });
    if (!seats) continue;
    const updated = seats.find((s) => s.num === seat.num);
    if (!updated) continue;
    const flipped = deselecting ? updated.available : !updated.available;
    if (flipped) { seatMapState.seats = seats; return true; }
  }
  return false;
}

async function onSeatClick(seatEl) {
  if (seatMapState.busy) return;
  const num = +seatEl.dataset.num;
  const seat = seatMapState.seats.find((s) => s.num === num);
  if (!seat || !seat.available) return;

  const alreadySelected = seatMapState.selection.has(num);
  if (!alreadySelected && seatMapState.selection.size >= totalTicketCount()) {
    console.warn(TAG, 'seat click ignored — already have as many seats selected as tickets purchased');
    return;
  }

  const bd = getBook() && getBook().seatingApp && getBook().seatingApp.bookingData;
  const model = getSeatModel(num);
  if (!bd || !model) {
    seatEl.classList.add('sm-error');
    setTimeout(() => seatEl.classList.remove('sm-error'), 1400);
    return;
  }

  // Busy only wraps the synchronous local mutation, not the background
  // verification below — that no longer needs to block further clicks.
  seatMapState.busy = true;
  try {
    applySeatSelection(alreadySelected, model);
    seatEl.classList.toggle('sm-selected', !alreadySelected);
    seatEl.classList.toggle('sm-taken', false);
    console.log(TAG, 'seat', num, alreadySelected ? 'deselected' : 'selected', 'locally — verifying server-side in the background');
  } catch (err) {
    console.error(TAG, 'onSeatClick: applySeatSelection threw', err);
    seatEl.classList.add('sm-error');
    setTimeout(() => seatEl.classList.remove('sm-error'), 1400);
    seatMapState.busy = false;
    return;
  }
  seatMapState.busy = false;
  refreshSeatMap();

  const confirmed = await verifySeatSelection(seat, alreadySelected);
  if (!confirmed) {
    console.warn(TAG, 'seat selection could not be confirmed server-side — expected seat', num, 'availability to flip');
    seatEl.classList.add('sm-error');
    setTimeout(() => seatEl.classList.remove('sm-error'), 1400);
  }
  refreshSeatMap();
}

function renderSeatMap(wrap) {
  seatMapState.selection = computeSelectedNums(seatMapState.seats);
  wrap.innerHTML = seatMapHTML(seatMapState.seats, seatMapState.selection);
  wrap.querySelectorAll('.sm-seat').forEach((el) => {
    if (!el.disabled) el.onclick = () => onSeatClick(el);
  });
  fitSeatGridToContainer(wrap);
}

// Scales the whole grid down to fit rather than letting it overflow
// into a scrollbar — transform:scale doesn't affect layout size on its
// own, so the wrapper's height is set explicitly to the scaled result,
// otherwise the page would still reserve the original, larger space.
function fitSeatGridToContainer(wrap) {
  const gridWrap = wrap.querySelector('.sm-grid-wrap');
  const grid = wrap.querySelector('.sm-grid');
  if (!gridWrap || !grid) return;
  const naturalW = grid.offsetWidth, naturalH = grid.offsetHeight;
  const available = gridWrap.clientWidth;
  if (!naturalW || available >= naturalW) { grid.style.transform = ''; gridWrap.style.height = ''; return; }
  const scale = available / naturalW;
  grid.style.transformOrigin = 'top left';
  grid.style.transform = `scale(${scale})`;
  gridWrap.style.height = `${naturalH * scale}px`;
}

function refreshSeatMap() {
  const wrap = document.getElementById('uci-seatmap');
  if (!wrap) return;
  fetchSeatMapData().then((seats) => {
    if (!seats) return;
    seatMapState.seats = seats;
    renderSeatMap(wrap);
  }).catch((err) => console.warn(TAG, 'seat map refresh failed', err.message));
}

let seatMapMountFailures = 0;
const SEAT_MAP_MAX_MOUNT_RETRIES = 5;

async function mountSeatMap() {
  const canvas = document.querySelector('#SeatCollection canvas');
  if (!canvas) return false;
  if (document.getElementById('uci-seatmap')) return true;

  const wrap = document.createElement('div');
  wrap.id = 'uci-seatmap';
  wrap.innerHTML = '<div class="sm-loading">Lädt Sitzplan…</div>';
  // Kept above the native map for this round too — not for click-
  // accuracy anymore (there's no synthetic click to verify now), but to
  // visually confirm the native canvas reflects the same selection
  // state after a direct API call, i.e. that server-side changes made
  // this way are actually picked up client-side for "weiter" too.
  const nativeWrap = canvas.closest('.backdrop-wrapper') || canvas.closest('#seatingplan');
  (nativeWrap || canvas.parentElement).insertAdjacentElement('beforebegin', wrap);

  try {
    const seats = await (prefetchSeatMapData() || fetchSeatMapData());
    if (!seats) { wrap.innerHTML = '<div class="sm-loading">Sitzplan nicht verfügbar.</div>'; return true; }
    seatMapState.seats = seats;
    renderSeatMap(wrap);
    seatMapMountFailures = 0;
  } catch (err) {
    console.warn(TAG, 'seat map load failed', err.message);
    seatMapMountFailures++;
    if (seatMapMountFailures <= SEAT_MAP_MAX_MOUNT_RETRIES) {
      // Likely still a race, not a permanent failure — remove this
      // attempt entirely so the next poll tick (1.5s later) starts
      // fresh instead of getting stuck showing an error that a moment
      // later would have actually succeeded.
      wrap.remove();
    } else {
      wrap.innerHTML = '<div class="sm-loading">Sitzplan konnte nicht geladen werden.</div>';
    }
  }
  return true;
}

// --- how boot() used to wire this in (for reference — NOT executable here) ---
//
// Inside the earlyMountPoll setInterval (150ms, fast-then-slow):
//   prefetchSeatMapData();
//   if (!document.getElementById('uci-seatmap')) mountSeatMap();
//   (bothMounted check included document.getElementById('uci-seatmap'))
//
// Inside the steady-state poll() loop (1.5s):
//   mountSeatMap();
