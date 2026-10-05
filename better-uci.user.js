// ==UserScript==
// @name         better-uci
// @namespace    https://github.com/n-klocke/better-uci
// @version      3.4.0
// @description  Batch-redeem UCI Unlimited cards on the booking page, and a denser, filterable programme browser on the kinoprogramm page.
// @author       n-klocke
// @license      MIT
// @homepageURL  https://github.com/n-klocke/better-uci
// @supportURL   https://github.com/n-klocke/better-uci/issues
// @updateURL    https://raw.githubusercontent.com/n-klocke/better-uci/main/better-uci.user.js
// @downloadURL  https://raw.githubusercontent.com/n-klocke/better-uci/main/better-uci.user.js
// @match        https://buchung.uci-kinowelt.de/*
// @match        https://www.uci-kinowelt.de/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM.setValue
// @grant        GM.getValue
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // Storage. Tampermonkey has the synchronous GM_getValue/GM_setValue.
  // Userscripts — the Safari extension this runs under on iPhone — has
  // neither: it drops GM_* grants outright, so calling one throws a
  // ReferenceError. That was the iPhone "Warenkorb wird gelesen…" hang
  // (confirmed in the iOS simulator: the first poll() tick threw in
  // wirePaymentMethodMemory and the loop never ran again). Userscripts only
  // has the async GM.getValue/GM.setValue, so those values are read into a
  // cache once, before init, and the rest of the script keeps synchronous
  // get/set. Keys are listed here because the cache has to know them
  // up front.
  const STORE_KEYS = ['uci_cards_v1', 'uci_payment_method_v1', 'uci_browse_prefs_v1', 'uci_booking_off_v1'];
  const store = (() => {
    const sync = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    const gm4 = !sync && typeof GM === 'object' && GM !== null && typeof GM.getValue === 'function';
    const cache = new Map();
    return {
      kind: sync ? 'GM_getValue' : gm4 ? 'GM.getValue' : 'keiner',
      // Runs fn once stored values are readable: right away with the
      // synchronous API (Tampermonkey timing is unchanged), after one read
      // of every key with GM.getValue.
      whenReady(fn) {
        if (!gm4) return fn();
        Promise.all(STORE_KEYS.map((k) => GM.getValue(k).then(
          (v) => { if (v !== undefined) cache.set(k, v); },
          (err) => console.warn('[better-uci] GM.getValue failed:', k, err))))
          .then(fn);
      },
      get: (k, d) => (sync ? GM_getValue(k, d) : cache.has(k) ? cache.get(k) : d),
      set(k, v) {
        if (sync) return GM_setValue(k, v);
        cache.set(k, v);
        if (gm4) GM.setValue(k, v).catch((err) => console.warn('[better-uci] GM.setValue failed:', k, err));
      },
    };
  })();

  // WebMCP: tools a browser agent can call on this page, registered with
  // the page's document.modelContext (navigator.modelContext in Chrome's
  // early preview). Silently nothing where neither exists, which today is
  // every browser without the preview, iPhone included.
  //
  // Registration happens in the page world, through an injected script
  // like pageBridge's: modelContext belongs to the page, and this script
  // usually runs in an isolated world (always on iPhone). The page-side
  // execute() forwards each call here over DOM events with JSON-string
  // payloads, the handler runs with this script's own state, and the
  // result goes back the same way. Returned as MCP-style text content,
  // which reads fine both to agents that expect that shape and to the
  // spec's plain JSON serialization.
  //
  // Anything in the page world can call a registered tool, so handlers
  // never return Unlimited card numbers (masked only) and redeeming needs
  // a click in better-uci's own confirmation.
  const webmcp = (() => {
    const ch = 'better-uci-mcp-' + Math.random().toString(36).slice(2);
    const handlers = new Map();
    let listening = false;

    function pageMain(ch, defs) {
      const mc = document.modelContext || navigator.modelContext;
      if (!mc || typeof mc.registerTool !== 'function') return;
      const pending = new Map();
      let seq = 0;
      document.addEventListener(ch + ':ret', (e) => {
        let m;
        try { m = JSON.parse(e.detail); } catch { return; }
        const done = pending.get(m.id);
        if (done) { pending.delete(m.id); done(m); }
      });
      const call = (name, input) => new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        document.dispatchEvent(new CustomEvent(ch + ':call',
          { detail: JSON.stringify({ id, name, input: input || {} }) }));
      }).then((m) => ({
        content: [{ type: 'text', text: m.ok ? JSON.stringify(m.result, null, 1) : 'Error: ' + m.error }],
        isError: !m.ok,
      }));
      defs.forEach((d) => {
        const tool = Object.assign({}, d, { execute: (input) => call(d.name, input) });
        try {
          Promise.resolve(mc.registerTool(tool))
            .catch((err) => console.warn('[better-uci] WebMCP registerTool', d.name, err));
        } catch (err) {
          console.warn('[better-uci] WebMCP registerTool', d.name, err);
        }
      });
    }

    return {
      // tools: [{ name, title, description, inputSchema, annotations, run }].
      // run(input) may be async; a thrown Error's message goes to the agent.
      register(tools) {
        if (!listening) {
          listening = true;
          document.addEventListener(ch + ':call', async (e) => {
            let m;
            try { m = JSON.parse(e.detail); } catch { return; }
            const run = handlers.get(m.name);
            let reply;
            try {
              if (!run) throw new Error('Unknown tool ' + m.name);
              reply = { id: m.id, ok: true, result: await run(m.input || {}) };
            } catch (err) {
              reply = { id: m.id, ok: false, error: String((err && err.message) || err) };
            }
            document.dispatchEvent(new CustomEvent(ch + ':ret', { detail: JSON.stringify(reply) }));
          });
        }
        // A re-mount only refreshes handlers: the page already has the
        // tool, and registering a name twice is an error there.
        const fresh = tools.filter((t) => !handlers.has(t.name));
        tools.forEach((t) => handlers.set(t.name, t.run));
        if (!fresh.length) return;
        const defs = fresh.map(({ run, ...def }) => def);
        const s = document.createElement('script');
        s.textContent = `(${pageMain})(${JSON.stringify(ch)}, ${JSON.stringify(defs)});`;
        (document.head || document.documentElement).appendChild(s);
        s.remove();
      },
    };
  })();

  if (location.hostname === 'buchung.uci-kinowelt.de') {
    store.whenReady(initRedeemer);
  } else if (location.hostname === 'www.uci-kinowelt.de') {
    store.whenReady(initBrowse);
  }

  function initRedeemer() {
  const TAG = '[uci-batch]';
  console.log(TAG, 'loaded', location.href);

  // The "better-uci an/aus" pill (see setScriptOff): while off, every
  // change this script makes to the booking page is undone in place, no
  // reload. Saved, so it stays off across the booking steps until it's
  // switched back on.
  const OFF_KEY = 'uci_booking_off_v1';
  let scriptOff = store.get(OFF_KEY, false) === true;
  let layoutStyle = null;

  // @run-at is document-start, so document.head may not exist yet — same
  // retry pattern as the browse module for the same reason. This is a
  // plain layout pass over the native seat-selection step, separate from
  // #uci-batch's own scoped styles below, so it needs its own <style> tag
  // rather than living inside the panel's template.
  (function injectSeatingLayoutCSS() {
    if (!document.documentElement) { setTimeout(injectSeatingLayoutCSS, 0); return; }
    const style = document.createElement('style');
    style.textContent = `
      /* Redundant — the film/showtime/cinema are already shown above in
         the fixed header. */
      #ticket-selection-heading { display: none !important; }

      /* Not needed — hidden rather than removed from the DOM, same as
         #ticket-type-container below, in case any native script still
         references it internally. */
      #backdrop-wrapper-sections { display: none !important; }

      /* #ticketselection, the seat map's wrapper, and #stepControl are
         direct siblings here — wrapping them in flex puts the first two
         side by side, and #stepControl's flex-basis:100% below drops it
         to its own row, since it can't fit alongside two items that
         already fill the row. */
      #StepSeatingLayout {
        display: flex !important;
        flex-wrap: wrap !important;
        align-items: flex-start !important;
        gap: 20px;
      }

      /* Fixed, modest column instead of the full row it used to occupy —
         this alone frees up most of the width the seat map needs, which
         is why the seat map itself doesn't need to shrink much if at all. */
      #ticketselection { flex: 0 0 300px !important; max-width: 300px !important; }
      /* Phone: the seat map already drops below (flex-wrap), so a fixed
         300px column just left the picker a 246px card in a wider box. */
      @media (max-width: 640px) {
        #ticketselection { flex: 1 1 100% !important; max-width: none !important; }
      }
      /* UCI's own #backdrop-wrapper-tickets (dark, 12px padding) plus a
         15px .container padding wrapped our card in a second box, leaving
         it 302px of 356px on a phone (measured), and on desktop three dark
         layers around one list. The native wrapper is the card instead —
         same box style as the seat map's beside or below it. */
      #ticket-selection > .container { padding: 0 !important; }
      #uci-tickets { background: none !important; border: none !important; padding: 0 4px !important; }
      /* Seat-map legend (PK 1 / PK 2 / PK 3 / PK 1 LOGE): at phone width
         its labels broke mid-word ("PK / 1", "PK 1 / LOGE"). Keep each
         label on one line and let the items wrap as a whole instead. */
      #SeatingPlanComponentLayoutFooter > div > div { flex-wrap: wrap; justify-content: center; row-gap: 6px; }
      #SeatingPlanComponentLayoutFooter > div > div * { white-space: nowrap; }
      /* Legend sized down: 17px text and 22px swatches, with 10px margin +
         10px padding + 10px item margin stacked under it, made it the
         largest text in the seat map box and left ~30px of dead space at
         its bottom (measured live). Structure (also measured): row >
         item > [swatch, label]. Swatch sizes via !important in case UCI
         ever sets them inline. */
      #SeatingPlanComponentLayoutFooter > div > div { padding: 4px 0 0 !important; margin: 6px 0 0 !important;
        column-gap: 14px; font-size: 12.5px !important; }
      #SeatingPlanComponentLayoutFooter > div > div > div { margin: 0 !important; align-items: center; }
      #SeatingPlanComponentLayoutFooter > div > div > div > div:first-child {
        width: 13px !important; height: 13px !important; border-radius: 3px; }
      #SeatingPlanComponentLayoutFooter > div > div > div > div:last-child { margin-left: 6px !important; }
      #SeatingPlanComponentLayoutFooter .uci-legend-price { color: #8b97a8; }
      /* A stylesheet rule rather than a JS-set inline style — the site
         replaces #ticket-type-container wholesale on every quantity
         change, and an inline style doesn't survive onto the replacement
         node the way an ID-selector rule does. */
      #ticket-type-container { display: none !important; }

      /* #ticket-type-container itself is hidden (not removed — its
         buttons are still clicked programmatically, see
         mountTicketSelector), so nothing here targets it anymore. This
         styles the real replacement panel instead — a segmented pill
         stepper rather than spread-out circle buttons, closer to how
         modern quantity pickers actually look. */
      #uci-tickets {
        background: #10141c; border: 1px solid rgba(255,255,255,.08);
        border-radius: 14px; padding: 4px 16px; color: #fff; font-size: 14px;
      }
      #uci-tickets .tk2-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,.06);
      }
      #uci-tickets .tk2-row:last-child { border-bottom: none; }
      /* Always a column: inline-with-wrap put the price beside short
         labels but under long ones (confirmed live: 2 of 4 rows wrapped),
         so prices zig-zagged between two positions. */
      #uci-tickets .tk2-info { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 0; }
      #uci-tickets .tk2-hint { font-size: 11px; color: #ffd77f; text-align: left; white-space: nowrap; }
      #uci-tickets .tk2-label { font-size: 13.5px; font-weight: 600; }
      #uci-tickets .tk2-price { font-size: 12px; color: #8b97a8; }
      #uci-tickets .tk2-stepper {
        display: flex; align-items: center; gap: 1px; flex: 0 0 auto;
        background: rgba(255,255,255,.06); border-radius: 999px; padding: 2px;
      }
      #uci-tickets .tk2-btn {
        /* min-height:0 is load-bearing, not a redundant reset: this site
           sets a global min-height:45px on <button> elements (confirmed
           via getComputedStyle while debugging the seat map, where the
           same thing turned 24-30px circles into ovals). Without this,
           height:24px gets silently clamped to 45px. */
        position: relative; width: 24px; height: 24px; min-width: 24px; min-height: 0;
        border-radius: 50%; border: none; background: transparent;
        cursor: pointer; transition: background .15s;
      }
      #uci-tickets .tk2-btn:hover:not(:disabled) { background: rgba(255,255,255,.12); }
      #uci-tickets .tk2-btn:disabled { opacity: .25; cursor: default; }
      #uci-tickets .tk2-btn::before {
        content: ''; position: absolute; top: 50%; left: 50%;
        width: 9px; height: 2px; background: #cfd6e0;
        transform: translate(-50%, -50%); border-radius: 1px;
      }
      #uci-tickets .tk2-btn.plus { background: #fff101; }
      #uci-tickets .tk2-btn.plus:hover:not(:disabled) { background: #ffe94d; }
      #uci-tickets .tk2-btn.plus::before { background: #000; }
      #uci-tickets .tk2-btn.plus::after {
        content: ''; position: absolute; top: 50%; left: 50%;
        width: 2px; height: 9px; background: #000;
        transform: translate(-50%, -50%); border-radius: 1px;
      }
      #uci-tickets .tk2-count { min-width: 18px; text-align: center; font-size: 13.5px; font-weight: 700; }

      /* Deliberately no sizing changes to the seat map or its canvas here
         — see the accompanying explanation for why. It just takes
         whatever room the flex row leaves it. overflow-x is a safety net
         for narrow viewports: scrolling is safe, silently rescaling a
         canvas the site may do click coordinate math against is not. */
      .backdrop-wrapper:has(#seatingplan) { flex: 1 1 auto !important; min-width: 0; overflow-x: auto; }

      /* Was a full-width bar sized for the old single-column layout — now
         sits on its own row below both columns, styled with the same
         accent used for EINLÖSEN and the active states elsewhere rather
         than the site's default blue. */
      #stepControl { flex: 1 1 100% !important; margin-top: 14px; text-align: right; }
      #stepControl .btn-block {
        display: inline-block !important; width: auto !important; min-width: 160px;
        padding: 10px 32px !important;
        background: #fff101 !important; color: #000 !important;
        border: none !important; border-radius: 6px !important;
        font-weight: 700 !important; letter-spacing: .3px;
      }
      /* Plain grey when disabled: the 28% yellow came out a murky olive on
         the dark page. */
      #stepControl .btn-block:disabled {
        background: rgba(255,255,255,.08) !important; color: rgba(255,255,255,.35) !important;
      }

      /* Seat and payment step: one bar at the bottom (see updateStepBar)
         with what's picked so far — read from UCI's own #customer-cart,
         hidden here since the bar replaces it — and the step's own button
         (.uci-bar-action) at its right end. That button stays where it is
         in the DOM and is only positioned over the bar: its click wiring
         is UCI's, scope unknown (same caution as the payment cards).
         Position:fixed still escapes the payment card's overflow:hidden,
         since no ancestor has a transform (checked live). --uci-sb-l/-r
         line it all up with the step's content column. */
      html.uci-bar #customer-cart { display: none !important; }
      html.uci-bar body { padding-bottom: 76px !important; }
      .uci-bar-action {
        position: fixed !important; right: var(--uci-sb-r, 16px); bottom: 11px; z-index: 1031;
        margin: 0 !important; width: auto !important; min-width: 160px;
      }
      /* What's left in place: the seat step's empty #stepControl row and
         the payment card's 12px padding around nothing. */
      html.uci-bar #stepControl { margin: 0 !important; }
      #payment-type-paid-content:has(.uci-bar-action),
      #payment-type-free-content:has(.uci-bar-action) { padding: 0 !important; }
      html.uci-bar #uci-step-hint { display: none !important; }
      /* Payment step with ticked but unredeemed Unlimited Cards (see
         updateStepBar): Weiter outlined, the bar's second line amber, so
         paying full price can't happen by clicking past EINLÖSEN. */
      html.uci-bar .uci-bar-action.uci-bar-action--muted {
        background: transparent !important; color: #fff101 !important;
        border: 1px solid rgba(255,241,1,.6) !important; }
      /* Wraps instead of truncating: on a phone the warning is the one
         line that must be read in full. */
      #uci-stepbar.uci-sb-warn .uci-sb-sub { color: #f2c94c; white-space: normal; }

      /* Payment and confirm step in one 640px column, the same width as the
         header above (#booking-info .container) — the cards were ~930px
         wide with the card panel (max 620px) filling only the left half.
         The seat step stays wide for the seat map. */
      #payment-selection, #payment-confirmation { max-width: 640px !important; }

      /* The Unlimited Card section is always open (ensureAlwaysExpanded), so
         its 22px heading and chevron were a toggle that did nothing — a
         small label now. pointer-events off: a click would only start
         UCI's collapse before the next poll tick reopens it. */
      #payment-type-uc-header { padding: 10px 12px 6px !important; background: none !important;
        border: none !important; pointer-events: none; cursor: default; }
      #payment-type-uc-header h2 { font-size: 11.5px !important; font-weight: 700; color: #8b97a8;
        text-transform: uppercase; letter-spacing: .06em; line-height: 1.3; }
      #payment-type-uc-header .fa { display: none !important; }

      /* "Buchungsabschluss und Zahlung hinterlegen" (PayPal/Kreditkarte) is
         .disabled until Weiter is pressed — a dimmed row that couldn't be
         used yet. Hidden only while disabled; it shows once it's usable. */
      .card:has(> #payment-type-others-header.disabled) { display: none !important; }
      #uci-stepbar {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 1030;
        background: rgba(8,12,22,.96); border-top: 1px solid rgba(255,255,255,.1);
      }
      /* 64px minimum on the left: UCI's cookie-settings button sits in the
         bottom-left corner on phones. */
      #uci-stepbar .uci-sb-inner {
        box-sizing: border-box; min-height: 64px; display: flex; flex-direction: column;
        justify-content: center; gap: 2px;
        padding: 8px calc(var(--uci-sb-r, 16px) + 190px) 8px max(var(--uci-sb-l, 16px), 64px);
      }
      #uci-stepbar .uci-sb-sum { font-size: 14px; font-weight: 700; color: #fff;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      /* Phone: a narrower Weiter and less room reserved for it — at 190px
         the total wrapped ("33,80 / €") in a 390px viewport (measured). */
      @media (max-width: 640px) {
        /* #stepControl too: its own .btn-block rule outranks a bare class. */
        .uci-bar-action, #stepControl .uci-bar-action { min-width: 0 !important; padding: 10px 26px !important; }
        #uci-stepbar .uci-sb-inner { padding-right: calc(var(--uci-sb-r, 16px) + 118px); }
      }
      #uci-stepbar .uci-sb-sub { font-size: 12px; color: #8b97a8;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      /* Compact performance header (see compactPerfInfo): title with a
         version chip, then date, time and cinema on one line. UCI's own
         three lines are hidden only once ours exists. */
      #booking-info .right-item:has(#uci-perf-info) > :is(.performance-date-and-time,
        .cinema-name-and-auditorium, .film-version) { display: none !important; }
      #uci-perf-info .uci-pi-title { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px;
        font-size: 15px; font-weight: 700; color: #fff; line-height: 1.3; }
      #uci-perf-info .uci-pi-version { font-size: 10px; font-weight: 700; letter-spacing: .03em;
        padding: 1px 6px; border-radius: 3px; line-height: 1.4;
        background: rgba(79,157,222,.18); color: #8fc4f0; border: 1px solid rgba(79,157,222,.6); }
      #uci-perf-info .uci-pi-when { font-size: 12.5px; color: #8b97a8; margin-top: 3px; }
      #uci-perf-info .uci-pi-when b { color: #cfd6e0; font-weight: 600; }
      /* Explains the greyed-out button — see updateStepHint(). */
      #uci-step-hint { display: block; margin-top: 6px; font-size: 12px; color: #8b97a8; }
      #uci-step-hint[hidden] { display: none; }

      /* Payment step accordion (Unlimited Card / Movie Points / Gutscheine /
         Buchungsabschluss / Zahlung hinterlegen) — a stack of Bootstrap
         .card sections. Two of their IDs are confirmed elsewhere in this
         script (goToCheckout() already opens #init-checkout-and-payment-
         type-select-content programmatically; HOST_SEL already targets
         #payment-type-uc-content .card-body) — the other three sections'
         own IDs are NOT confirmed. .card-header/.card-body below are
         Bootstrap's own class names, not a guess at site-specific IDs, so
         this should reach every section, but hasn't been checked against
         the live page yet. If Movie Points/Gutscheine/Zahlung hinterlegen
         don't pick this up, they need their own IDs added here. */
      .card-header {
        background: #10141c !important; border: 1px solid rgba(255,255,255,.08) !important;
        color: #fff !important; font-weight: 600 !important; min-height: 0;
      }
      .card-header:hover { background: #171d29 !important; }
      /* Every section's content currently stretches full-width with the
         actual form/button/text occupying only the left portion — this
         caps it near the width the content actually uses, closing up the
         dead space on the right without touching any field's own layout. */
      .card-body { max-width: 760px; }

      /* Sweepstakes banner inside "Buchungsabschluss" (confirmed id) — a
         large promo image that currently pushes the actual opt-in
         checkbox and continue button further down than necessary.
         Shrunk, not hidden: the checkbox, legal text, and button are
         untouched. */
      #init-checkout-and-payment-type-select-content img {
        max-height: 130px; width: auto; object-fit: cover;
      }

      /* "leer" hint added next to the Gutscheine header when the account
         has no vouchers — see annotateEmptyVoucherPanel(). */
      .uci-empty-badge {
        margin-left: 8px; padding: 1px 8px; border-radius: 999px;
        background: rgba(255,255,255,.08); color: #8b97a8;
        font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .3px;
      }

      /* Unlimited Card is auto-expanded by ensureAlwaysExpanded() in JS on
         every poll tick. The header keeps its own click-to-expand anyway
         (it used to be cursor:default + pointer-events:none + hidden
         chevron), as a manual fallback if the script's JS ever stops. On
         iPhone it did: the section loaded neither expanded nor expandable.
         That was first blamed on a timing race, but the real cause was
         poll() dying on its first tick (GM_getValue doesn't exist under
         Userscripts, see store at the top), so ensureAlwaysExpanded()
         never ran at all. */

      /* Movie Points / Gutscheine — demoted behind #uci-secondary-toggle
         (see setupLeanPaymentExtras()). Hidden by default; once revealed,
         their native .card-header bars are shrunk to a plain text line
         instead of the same full-width dark bar the primary sections use,
         so they read as secondary even when open. */
      .uci-secondary-card.uci-secondary-hidden { display: none !important; }
      .uci-secondary-card { border: none !important; background: none !important; }
      .uci-secondary-card .card-header {
        background: none !important; border: none !important; padding: 4px 2px !important;
        font-weight: 600 !important; font-size: 12.5px !important; color: #a9b4c2 !important;
      }
      .uci-secondary-card .card-header h2 { font-size: 12.5px !important; margin: 0; }
      .uci-secondary-card .card-body { padding-left: 2px; padding-right: 2px; }
      #uci-secondary-toggle {
        display: block; width: 100%; text-align: left; background: none; border: none;
        color: #8b97a8; font-size: 12px; cursor: pointer; padding: 6px 2px; min-height: 0;
        /* The site's button CSS uppercases it (seen live). */
        text-transform: none !important;
      }
      #uci-secondary-toggle:hover { color: #cfd6e0; }
      #uci-secondary-toggle::before { content: '▸ '; }
      #uci-secondary-toggle.open::before { content: '▾ '; }

      /* Buchungsabschluss: forced open by ensureAlwaysExpanded() too, and
         its header hidden entirely rather than just made unclickable —
         unlike Unlimited Card, this section's real content (the "Weiter"
         button, renamed by renameCheckoutButton()) doesn't need a heading
         of its own, so the whole card is stripped down to just that
         button rather than kept looking like a collapsed accordion item. */
      #init-checkout-and-payment-type-select-header { display: none !important; }
      .card:has(#init-checkout-and-payment-type-select-header) {
        background: none !important; border: none !important; box-shadow: none !important;
      }
      /* "Nach diesem Schritt haben Sie keine Möglichkeit mehr..." — the
         real warning about losing voucher/Movie Points access, sitting
         right above the Weiter button. Only one bare <p> lives directly in
         this card-body; the promo-contest widget's own <p>s are nested
         inside #promo-contest-widget, which the native page already keeps
         display:none unless a contest is actually running, so this can't
         accidentally catch those instead. Since moved one level down into
         a .tab-pane (confirmed live: it's still the only <p> anywhere in
         #payment-type-paid-content), so both positions are covered. */
      #payment-type-paid-content > p,
      #payment-type-paid-content > .tab-content > .tab-pane > p { display: none !important; }

      /* #payment-selection's own "ZAHLUNGSMITTEL" heading and subtitle —
         redundant once the accordion below it is self-explanatory (forced-
         open Unlimited Card, a lean toggle for the rest, a bare Weiter
         button). display:none removes their box entirely, so the
         accordion below moves up on its own — no separate margin fix
         needed here the way the fixed-header stack earlier needed one. */
      #payment-selection > h2, #payment-selection > p.text-center {
        display: none !important;
      }

      /* Native #booking-info header (poster + date/time/cinema/FSK block
         above the seat step) — was a tall, wide slab with a large poster
         and a whole FSK callout box. Restyled into one compact row, text
         sizes matched to .film-row from the browse experience below
         (initBrowse) for a consistent look across both halves of this
         script. FSK is dropped entirely, per explicit request — nothing
         reads it after this point, unlike parseCard()'s fsk field on the
         browse side, which is unrelated (different page, different DOM). */
      /* padding was reset here already; margin was not — if the native
         page clears the fixed header stack via margin-top rather than
         padding (a common pattern), that would explain a gap surviving
         every fix so far, since nothing above ever touched margin. */
      #booking-info { padding: 10px 0 !important; margin: 0 !important; }
      /* Confirmed via getComputedStyle: the real culprit was never
         #booking-info at all — it's body.layout-dark's own margin-top,
         hardcoded to 95px to clear the *original* (much taller) header
         stack. Now 30px: #uci-header's measured height (29px + its 1px
         hairline) once #booking-header is merged into the same row —
         see the header block below. */
      body.layout-dark { margin-top: 30px !important; }
      #booking-info .container { max-width: 640px; }
      #booking-info .booking-info-container {
        display: flex !important; align-items: center !important; gap: 12px;
      }
      /* .left-item/.right-item and the container itself kept whatever
         height the native (much larger) poster+FSK-box content used to
         need, even after that content shrank — the block stayed the same
         overall height with dead space around the smaller content inside
         it. Stripped generically (min-height/height reset) rather than
         guessed at with one fixed #booking-info height, since which of
         these was actually the source isn't confirmed. */
      #booking-info, #booking-info .booking-info-container,
      #booking-info .left-item, #booking-info .right-item {
        min-height: 0 !important; height: auto !important;
      }
      /* The <span> wrapper is inline by default — its box height then
         comes from line-height in whatever (larger) font-size context it
         sits in, not from the image itself, which can outlast a plain
         width/height change on the img alone. */
      #booking-info .poster-image { display: block; line-height: 0; }
      #booking-info .poster-image img {
        width: 60px !important; height: auto !important; border-radius: 4px; display: block;
      }
      #booking-info .aside.right-item { padding: 0; margin: 0; }
      #booking-info .performance-date-and-time {
        font-size: 14.5px; font-weight: 600; color: #fff; margin: 0;
      }
      #booking-info .cinema-name-and-auditorium {
        font-size: 12.5px; color: #8b97a8; margin: 0;
      }
      #booking-info .age-rating-info { display: none !important; }

      /* Fixed top bars above #booking-info: #uci-header (logo + account
         name) with #booking-header (back link + film title) nested inside
         it. The title is dropped entirely — same film is already shown
         right below in #booking-info, so it's pure repetition — and both
         rows get tighter padding. #booking-header itself is positioned via
         an inline top offset the native page sets to sit right under
         #uci-header; shrinking #uci-header's own height here could leave
         that stale (a few px gap) if the site only computes it once rather
         than on every layout change — worth confirming on reload. */
      #booking-header .filmTitle { display: none !important; }
      #booking-header .row {
        min-height: 0 !important; padding: 3px 0 !important; line-height: 1;
      }
      #booking-header #stepBackLink {
        font-size: 11px !important; line-height: 1; display: inline-block;
      }
      #uci-header > .container > .row {
        min-height: 0 !important; padding: 3px 0 !important; line-height: 1;
      }
      /* Shrinking the .row above had no visible effect on the bars
         themselves — the same symptom #booking-info had before its
         min-height/height reset below: an inner row can get shorter
         while the fixed-position bar wrapping it keeps whatever height
         (likely an explicit one, since #booking-header's inline top:45px
         implies the site pins #uci-header to a fixed height rather than
         sizing it to content) it had before. Same generic strip applied
         to the outer elements themselves this time, not just their .row. */
      #uci-header, #uci-header .container,
      #booking-header, #booking-header .container {
        min-height: 0 !important; height: auto !important;
      }
      /* Confirmed via a real screenshot: a visible gap now sits between
         #uci-header and #booking-header specifically — exactly the stale-
         offset risk flagged above. #booking-header's inline top:45px was
         hand-tuned to #uci-header's native ~45px height and never
         recalculated after the CSS above shrank it. 30px is computed from
         the values this file itself now sets (22px logo + 3px+3px row
         padding), not a guess at unknown native sizing — !important is
         required since only that beats an inline style, regardless of
         selector specificity. */
      /* #booking-header (just the back link) now overlays #uci-header's
         row instead of stacking below it — see the merged-header block at
         the end. Its old offset was top:30px (computed from this file's
         own 22px logo + 3px+3px padding) to sit under #uci-header. */
      #booking-header { top: 0 !important; }
      /* The logo <img> carries a real inline style="height:40px" (confirmed
         from the live markup) — only an !important rule can move it, since
         an inline style otherwise beats any plain CSS selector regardless
         of specificity. */
      #uci-header img { height: 22px !important; }
      #uci-header .text-contains-displayname { font-size: 11px; line-height: 22px; }
      /* Merged header. Measured live: #uci-header was a light-grey
         (229,229,229) 29px bar with a logo and the account name, and
         #booking-header a second, slate (64,75,98) 25px bar below it with
         a lone back chevron and a 1px white seam — two heavy bars holding
         almost nothing. Now one row on the page's own background: "‹
         Zurück" on the left (where the logo was — its link is just "#",
         so hiding it loses nothing), name on the right, one hairline.
         #booking-header sits on top of #uci-header's row (top:0 above)
         with pointer-events off except on the back link itself, so the
         row underneath stays clickable (checked with elementFromPoint). */
      #uci-header { background: rgb(0,15,46) !important;
        border-bottom: 1px solid rgba(255,255,255,.12) !important; }
      #uci-header .text-contains-displayname { color: #8b97a8 !important; }
      #uci-header .row > .col-2 img { visibility: hidden; }
      #booking-header { background: transparent !important; border-bottom: 0 !important;
        pointer-events: none; padding-top: 2px; }
      #booking-header .row > .col-2 { text-align: left !important; }
      #booking-header .row > .col-2 { overflow: visible; }
      #booking-header #stepBackLink { pointer-events: auto; font-size: 12px !important; white-space: nowrap;
        color: #cfd6e0 !important; text-decoration: none; }
      #booking-header #stepBackLink:hover { color: #fff !important; }
      #booking-header #stepBackLink .fa { color: #fff101; margin-right: 5px; }
      /* The native label "einen Schritt zurück" is visually hidden (kept
         as aria-label); a short visible "Zurück" makes the chevron's
         purpose obvious. */
      #booking-header #stepBackLinkText { display: none !important; }
      #booking-header #stepBackLink::after { content: 'Zurück'; }`;
    // media, not .disabled: disabled is ignored until the sheet exists,
    // and this may run before <head> does.
    if (scriptOff) style.media = 'not all';
    layoutStyle = style;
    (document.head || document.documentElement).appendChild(style);
  })();

  const ENDPOINT = '/TicketBoxXNG/booking/bonusAndVoucherTotal.json';
  const STORE_KEY = 'uci_cards_v1';
  const HOST_SEL = '#payment-type-uc-content .card-body';
  const MAX_ATTEMPTS = 4;

  // The page's own globals: window.book (booking state) and its jQuery.
  // Tampermonkey hands this script the page window as unsafeWindow.
  // Userscripts (iPhone) has no unsafeWindow, and because this script asks
  // it for GM.getValue/GM.setValue it runs in Safari's isolated content
  // world, which can't see page globals at all. There they're reached
  // through pageBridge below instead. Keyed on book, never on $ alone: that
  // content world has a global $ of its own. Userscripts' minified content
  // script declares a top-level `async function $` (its saveTab), which
  // made the first 3.1.7 draft take that world for the page (seen in the
  // simulator: "Seite:direkt" while book was unreadable).
  function pageWin() {
    const c = [];
    try { if (typeof unsafeWindow !== 'undefined') c.push(unsafeWindow); } catch {}
    c.push(window);
    try { if (window.wrappedJSObject) c.push(window.wrappedJSObject); } catch {}
    return c.find((w) => w && w.book) || null;
  }
  const useBridge = typeof unsafeWindow === 'undefined';

  // Runs in the page's own JS world: pageBridge injects it as an inline
  // <script>, which UCI allows (no Content-Security-Policy, checked). It
  // answers requests from this script over DOM events on document. Payloads
  // are JSON strings both ways, because Safari doesn't share event.detail
  // objects between worlds, only primitives. Only primitive fields of each
  // price row are copied. That covers every field this file reads, and
  // skips anything the page attached that wouldn't survive JSON.
  function pageBridgeMain(ch) {
    const reply = (id, msg) => document.dispatchEvent(new CustomEvent(ch + ':res',
      { detail: JSON.stringify(Object.assign({ id }, msg)) }));
    const plain = (o) => {
      const r = {};
      for (const k in o) {
        const v = o[k];
        if (v === null || (typeof v !== 'object' && typeof v !== 'function')) r[k] = v;
      }
      return r;
    };
    document.addEventListener(ch + ':req', (e) => {
      let m;
      try { m = JSON.parse(e.detail); } catch { return; }
      try {
        const b = window.book;
        if (m.op === 'state') {
          reply(m.id, { ok: true, result: b ? {
            bookingProcessId: b.bookingProcessId,
            unlimitedCustomerNumber: b.unlimitedCustomerNumber,
            priceRows: (b.priceRows || []).map(plain),
          } : null });
        } else if (m.op === 'post') {
          window.$.ajax({ url: m.url, method: 'POST', data: m.data })
            .done((resp) => reply(m.id, { ok: true, result: resp }))
            .fail((xhr) => reply(m.id, { ok: false, status: xhr.status,
              body: xhr.responseJSON || null, text: xhr.responseText || '' }));
        } else if (m.op === 'apply') {
          Promise.resolve(b.handleBookingServerSuccess(m.resp)).then(
            () => reply(m.id, { ok: true }),
            (err) => reply(m.id, { ok: false, error: String((err && err.message) || err) }));
        }
      } catch (err) {
        reply(m.id, { ok: false, error: String((err && err.message) || err) });
      }
    });
  }

  const pageBridge = (() => {
    const ch = 'better-uci-' + Math.random().toString(36).slice(2);
    let injected = false, alive = false, seq = 0, syncReply = null;
    const pending = new Map();
    function inject() {
      if (injected) return;
      injected = true;
      document.addEventListener(ch + ':res', (e) => {
        let m;
        try { m = JSON.parse(e.detail); } catch { return; }
        alive = true;
        if (m.id === 0) { syncReply = m; return; }
        const done = pending.get(m.id);
        if (done) { pending.delete(m.id); done(m); }
      });
      const s = document.createElement('script');
      s.textContent = `(${pageBridgeMain})(${JSON.stringify(ch)});`;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    }
    const send = (msg) => document.dispatchEvent(new CustomEvent(ch + ':req', { detail: JSON.stringify(msg) }));
    return {
      get alive() { return alive; },
      // Synchronous on purpose: the page-side listener runs, and replies,
      // inside dispatchEvent, so book stays readable like a plain object,
      // exactly as with unsafeWindow.
      state() {
        inject();
        syncReply = null;
        send({ id: 0, op: 'state' });
        return syncReply && syncReply.ok ? syncReply.result : null;
      },
      call(msg) {
        inject();
        return new Promise((resolve) => {
          const id = ++seq;
          pending.set(id, resolve);
          send(Object.assign({ id }, msg));
        });
      },
    };
  })();

  function getBook() {
    const w = pageWin();
    if (w) return w.book;
    if (!useBridge) return undefined;
    const b = pageBridge.state();
    if (b) b.handleBookingServerSuccess = (resp) => pageBridge.call({ op: 'apply', resp }).then((m) => {
      if (!m.ok) throw new Error(m.error || 'Ansicht nicht aktualisiert');
    });
    return b || undefined;
  }

  // Hands a server response to the page so its own views (cart bar, ticket
  // list) update. The page's refreshCustomerCart puts a loading mask with a
  // spinner over the cart bar and never takes it off itself; UCI's own
  // voucher flow removes it afterwards (removeBlockingMaskFromTicketRelatedContent).
  // Without the same step the spinner stayed over the total after every
  // redeem (confirmed on the live page, 2026-10-05). Only the cart bar's
  // mask is removed, and only once the page has re-rendered the cart. The
  // DOM is shared, so this works in both Tampermonkey and the bridge.
  async function applyToPage(resp) {
    await getBook().handleBookingServerSuccess(resp);
    document.querySelectorAll('#customer-cart .blocking-mask').forEach((m) => m.remove());
  }
  const bpid = () => { const b = getBook(); return b && b.bookingProcessId; };
  const pageAccess = () => (pageWin() ? 'direkt' : !useBridge ? 'keiner'
    : pageBridge.alive ? 'Bridge' : 'Bridge (keine Antwort)');

  const loadCards = () => { try { return JSON.parse(store.get(STORE_KEY, '[]')); } catch { return []; } };
  const saveCards = (c) => store.set(STORE_KEY, JSON.stringify(c));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safeParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const mask = (c) => c.length > 6 ? c.slice(0, 4) + '…' + c.trim().slice(-4) : c;
  const eur = (n) => (n == null ? '—' : n.toFixed(2).replace('.', ',') + ' €');
  // For anything user- or server-supplied that ends up in innerHTML: card
  // names and codes come from saved/imported JSON (shared between people),
  // error text from UCI's responses — none of it may become markup on a
  // page that holds a live booking/payment session.
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // The page mirrors every server response into book.priceRows, so basket
  // state is readable locally with no request at all.
  const localRows = () => { const b = getBook(); return (b && b.priceRows) || []; };
  const rowsOf = (r) => (r && r.priceRows) || [];
  const isOpen = (r) => !r.unlimitedTicket && !r.freeTicket;
  const appliedRow = (rows, code) =>
    rows.find((r) => r.unlimitedTicket && (r.unlimitedTicketCardNo || '').trim() === code.trim());
  const seatLabel = (r) => r && r.seatPos ? `Reihe ${r.seatRow} Platz ${r.seatRowPos}` : '?';

  // Prefer the priciest eligible seat: an Unlimited card covers the whole
  // ticket, so whatever stays paid should be the cheapest seat available.
  function bestIdx(rows) {
    let best = -1;
    rows.forEach((r, i) => {
      if (r.unlimitedTicketAvail === true && !r.unlimitedTicket)
        if (best < 0 || r.amount > rows[best].amount) best = i;
    });
    return best;
  }

  let lastFee = null;   // chfForBookingTransaction — not covered by any card

  function basket() {
    const rows = localRows();
    if (!rows.length) return null;
    return {
      n: rows.length,
      unlimited: rows.filter((r) => r.unlimitedTicket).length,
      free: rows.filter((r) => r.freeTicket).length,
      open: rows.filter(isOpen).length,
      due: rows.reduce((s, r) => s + (r.amount - (r.discount || 0)), 0),
    };
  }

  // -------------------------------------------------------------------- api
  // Always through the page's own jQuery, which adds the X-Requested-With
  // header this endpoint requires (docs/API.md): directly, or via
  // pageBridge. Resolves with the parsed response; rejects with an
  // xhr-shaped { status, responseJSON, responseText }.
  function ajaxPost(data) {
    const w = pageWin();
    if (w && w.$ && typeof w.$.ajax === 'function') {
      return new Promise((resolve, reject) =>
        w.$.ajax({ url: ENDPOINT, method: 'POST', data }).done((resp) => resolve(resp)).fail((xhr) => reject(xhr)));
    }
    if (!useBridge) return Promise.reject(new Error('jQuery nicht erreichbar'));
    return pageBridge.call({ op: 'post', url: ENDPOINT, data }).then((m) => (m.ok ? m.result
      : Promise.reject({ status: m.status, responseJSON: m.body, responseText: m.text || '' })));
  }

  function post(data, label, rep, prog) {
    const t0 = performance.now();
    rep && rep.inflight(t0);
    console.log(TAG, '→', label, data);
    return ajaxPost(data).then((resp) => {
      const ms = Math.round(performance.now() - t0);
      rep && rep.settled();
      if (resp && resp.failure === 'true') {
        console.warn(TAG, '←', label, ms + 'ms FAILURE', resp.errorCode);
        throw apiError(resp, ms);
      }
      if (typeof resp.chfForBookingTransaction === 'number')
        lastFee = resp.chfForBookingTransaction;
      console.log(TAG, '←', label, ms + 'ms ok total=' + resp.fullAmount);
      prog && prog.step();
      return resp;
    }, (xhr) => {
      const ms = Math.round(performance.now() - t0);
      rep && rep.settled();
      if (xhr instanceof Error) throw xhr;
      const body = xhr.responseJSON || safeParse(xhr.responseText);
      const err = body ? apiError(body, ms) : Object.assign(new Error('HTTP ' + xhr.status), { ms });
      console.warn(TAG, '←', label, ms + 'ms ERROR', err.code || xhr.status, err.message);
      throw err;
    });
  }

  function apiError(body, ms) {
    const e = new Error(body.errorUserMessage || body.errorMessage || 'Unbekannter Fehler');
    e.code = body.errorCode; e.ms = ms;
    return e;
  }

  // ---------------------------------------------------------------- one card
  async function redeemOne(person, rep, prog) {
    const code = person.code;
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      rep.attempt(n, MAX_ATTEMPTS);
      try {
        let rows, resp0 = null;

        if (person.own) {
          // Own card needs no determineBoni, and book.priceRows is usually
          // current — so the common case costs one request instead of two.
          rows = localRows();
          // But book.priceRows survives stepping back and choosing new seats,
          // so a local "already applied" hit may describe the PREVIOUS basket.
          // Never report success off stale state: confirm with the server.
          const staleHit = !!appliedRow(rows, code);
          if (!rows.length || staleHit || bestIdx(rows) < 0) {
            rep.phase('Warenkorb wird geladen');
            prog && prog.grow(1);
            resp0 = await post({ bookingProcessId: bpid(), joinLoyalty: 0 }, 'refresh', rep, prog);
            rows = rowsOf(resp0);
          }
        } else {
          rep.phase('Karte wird geprüft');
          resp0 = await post({ bookingProcessId: bpid(), determineBoniUnlimitedCardNumber: code },
                             'determineBoni ' + mask(code), rep, prog);
          rows = rowsOf(resp0);
        }

        const already = appliedRow(rows, code);
        if (already) {
          if (resp0) await applyToPage(resp0);
          return { ok: true, seat: seatLabel(already), note: 'war schon drauf' };
        }

        const idx = bestIdx(rows);
        if (idx < 0) {
          // Server refusal, not a transport error — retrying cannot help.
          const open = rows.filter(isOpen).length;
          return { ok: false,
            note: open ? `Karte für keinen der ${open} offenen Plätze erlaubt` : 'alle Plätze belegt' };
        }

        rep.phase('wird angewendet → ' + seatLabel(rows[idx]));
        const resp = await post(
          { bookingProcessId: bpid(), seatAction: 'unlimited', seatActionIdx: idx, seatActionValue: code },
          `apply ${mask(code)} idx=${idx}`, rep, prog);

        const row = rowsOf(resp)[idx];
        if (!row || !row.unlimitedTicket || (row.unlimitedTicketCardNo || '').trim() !== code.trim())
          throw new Error('Server hat die Karte nicht angewendet');

        rep.phase('Ansicht wird aktualisiert');
        await applyToPage(resp);
        return { ok: true, seat: seatLabel(row) };
      } catch (err) {
        rep.log(`Versuch ${n}/${MAX_ATTEMPTS}: ${[err.code, err.message].filter(Boolean).join(' — ')}`, 'err');
        if (n === MAX_ATTEMPTS) return { ok: false, note: `${err.code || ''} ${err.message}`.trim() };
        prog && prog.grow(person.own ? 1 : 2);   // retry means genuinely more work
        const wait = 800 * 2 ** (n - 1);
        rep.phase(`Fehler — neuer Versuch in ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
      }
    }
  }

  // ------------------------------------------------------------- orchestrate
  let running = false;
  let advanceArmed = false;   // set only by EINLÖSEN or the WebMCP redeem tool, cleared on use

  function makeProgress(total) {
    let done = 0, tot = total;
    // show the step being worked on, so a 7s request isn't reported as "0 von 3"
    const paint = () => ui.progress(`Schritt ${Math.min(done + 1, tot)} von ${tot}`);
    paint();
    return {
      step: () => { done++; paint(); },
      grow: (n) => { tot += n; paint(); },
      card: (i, n) => ui.cardCount(`Karte ${i} von ${n}`),
      clear: () => { ui.progress(''); ui.cardCount(''); },
    };
  }

  // Resolves with one { name, ok, seat, note } per card, for the WebMCP
  // redeem tool; the panel itself only uses what's shown along the way.
  async function runQueue(queue) {
    if (!getBook()) { ui.hint('Buchungsseite nicht bereit (window.book fehlt)', true); return []; }
    if (!bpid()) { ui.hint('Keine aktive Buchung — bitte zuerst Plätze wählen', true); return []; }

    running = true;
    ui.hint('', true);          // clear any sticky message from the last run
    ui.busy(true);
    const prog = makeProgress(queue.reduce((s, p) => s + (p.own ? 1 : 2), 0));
    const t0 = performance.now();
    let ok = 0;
    const results = [];

    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      prog.card(i + 1, queue.length);
      const rep = ui.reporterFor(p);
      ui.log(`— ${p.name} (${mask(p.code)})`, 'info');
      const r = await redeemOne(p, rep, prog);
      results.push({ name: p.name, ok: r.ok, seat: r.seat || null, note: r.note || null });
      if (r.ok) {
        ok++;
        ui.set(p.id, 'ok', `${r.seat}${r.note ? ' · ' + r.note : ''}`);
        ui.log(`  ✓ ${p.name} → ${r.seat}`, 'ok');
      } else {
        ui.set(p.id, 'err', r.note);
        ui.log(`  ✗ ${p.name}: ${r.note}`, 'err');
      }
      updateBasket();
    }

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    ui.log(`Fertig: ${ok}/${queue.length} in ${secs}s`, ok === queue.length ? 'ok' : 'warn');
    prog.clear();
    running = false;
    ui.busy(false);
    flashTitle(`✓ ${ok}/${queue.length} eingelöst`);
    updateBasket();

    const armed = advanceArmed;
    advanceArmed = false;

    if (queue.length && ok === queue.length) {
      ui.hint('', true);
      // Only move on when this run came from EINLÖSEN and nothing is left to
      // redeem — advancing while seats and unused cards remain is premature.
      const b = basket();
      const unused = (panel._rows || []).filter((p) => !appliedRow(localRows(), p.code)).length;
      const moreLeft = b && b.open > 0 && unused > 0;
      if (armed && !moreLeft) goToCheckout();
      else if (moreLeft) ui.hint('Noch offene Plätze — weitere Karte auswählen oder unten fortfahren.', true);
    } else {
      ui.hint(`${queue.length - ok} von ${queue.length} Karten fehlgeschlagen — siehe Details oben.`, true);
    }
    return results;
  }

  async function redeemAll(people) {
    ui.clearLog();
    const seen = new Set(); const queue = [];
    for (const p of people) {
      const k = p.code.trim();
      if (seen.has(k)) { ui.set(p.id, 'skip', 'Duplikat — übersprungen'); continue; }
      seen.add(k); queue.push(p);
    }
    ui.log(`Starte mit ${queue.length} Karte(n)`, 'info');
    return runQueue(queue);
  }

  // Scrolls to the "Weiter" (checkout) button. Deliberately does NOT press
  // it: that step locks out vouchers and Movie Points for the rest of the
  // booking. Used to also force-open the accordion header first — no
  // longer needed now that ensureAlwaysExpanded() keeps this section open
  // permanently (see below), and the header itself is hidden entirely, so
  // the button is the only real target left to scroll to.
  function goToCheckout() {
    const btn = document.getElementById('init-checkout-process-button');
    if (!btn) return;
    setTimeout(() => btn.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
  }

  // Some payment-step accordion sections shouldn't behave like accordions
  // at all — Unlimited Card should just always be open (it's the primary
  // path this whole panel exists for), and Buchungsabschluss's real
  // content is just the "Weiter" button, not something worth a click to
  // reveal. Re-adding the 'show' class every poll tick (rather than
  // fighting Bootstrap's collapse plugin directly, whose exact version/
  // event names aren't confirmed on this page) is what actually keeps
  // these open even if the site's own accordion logic — e.g. its
  // data-parent mutual-exclusion behavior when another section opens —
  // tries to close them. Both the class and the inline height reset are
  // unconditional on every tick now, not just when 'show' is missing:
  // Bootstrap's collapse can leave 'show' applied while height is still
  // mid-transition (e.g. stuck at an inline '0px' from an interrupted
  // animation) — that combination previously fell through this function
  // untouched since the old guard only fired when 'show' itself was
  // absent, leaving the panel visually collapsed with no further poll
  // tick able to fix it.
  function ensureAlwaysExpanded(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('show');
    el.style.height = '';
  }

  // Movie Points and Gutscheine are real, occasionally-needed features,
  // just not ones most bookings touch — demoting them behind one shared,
  // lean toggle (a plain button, not another accordion card) keeps them
  // reachable without competing visually with Unlimited Card / Weiter.
  // Deliberately does NOT move either .card in the DOM (only adds classes
  // + a new sibling button): the site's own click-to-expand wiring on
  // each card's header has no confirmed data-toggle attribute, meaning
  // it's bound by custom site JS whose delegation scope isn't known —
  // relocating those nodes elsewhere in the tree could silently break
  // that if it's scoped to their current parent. Adding classes and a
  // sibling carries none of that risk.
  function setupLeanPaymentExtras() {
    if (document.getElementById('uci-secondary-toggle')) return;
    const mpCard = document.getElementById('payment-type-mp-header')?.closest('.card');
    const voucherCard = document.getElementById('payment-type-voucher-header')?.closest('.card');
    if (!mpCard || !voucherCard) return;

    mpCard.classList.add('uci-secondary-card', 'uci-secondary-hidden');
    voucherCard.classList.add('uci-secondary-card', 'uci-secondary-hidden');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'uci-secondary-toggle';
    toggle.textContent = 'Movie Points & Gutscheine einlösen';
    toggle.onclick = () => {
      const hidden = mpCard.classList.toggle('uci-secondary-hidden');
      voucherCard.classList.toggle('uci-secondary-hidden', hidden);
      toggle.classList.toggle('open', !hidden);
    };
    mpCard.insertAdjacentElement('beforebegin', toggle);
  }

  // "ABSCHLUSS & ZAHLUNGSMITTEL WÄHLEN" is the button's native label —
  // shortened once it's rendered, rather than templated in from scratch,
  // so nothing here depends on guessing the button's full native markup.
  // The native markup is kept so setScriptOff can put it back.
  const nativeCheckoutHTML = new WeakMap();
  function renameCheckoutButton() {
    const btn = document.getElementById('init-checkout-process-button');
    if (!btn || btn.textContent.trim() === 'Weiter') return;
    nativeCheckoutHTML.set(btn, btn.innerHTML);
    btn.textContent = 'Weiter';
  }
  function restoreCheckoutButton() {
    const btn = document.getElementById('init-checkout-process-button');
    if (btn && nativeCheckoutHTML.has(btn)) btn.innerHTML = nativeCheckoutHTML.get(btn);
  }

  // The seat step's Weiter stays disabled until tickets and seats are
  // picked, with nothing saying so. Read from the button's own disabled
  // state every poll tick, so it can't disagree with what the site allows.
  function updateStepHint() {
    const btn = document.querySelector('#stepControl .btn-block');
    if (!btn) return;
    let hint = document.getElementById('uci-step-hint');
    if (!hint) {
      hint = document.createElement('span');
      hint.id = 'uci-step-hint';
      hint.textContent = 'Erst Tickets und Plätze wählen';
      btn.insertAdjacentElement('afterend', hint);
    }
    hint.hidden = !btn.disabled;
  }

  // Reads the "Gutscheine einlösen" panel's own content to add a "leer"
  // hint next to its (collapsed-by-default) header, so an empty account
  // doesn't need a click just to find out it's empty. This only reads —
  // never clicks — so it works regardless of whether the panel has ever
  // been opened: Bootstrap's .collapse keeps a panel's content in the DOM
  // and toggles visibility via CSS, it doesn't remove/defer the content
  // itself. Identifies the panel by its visible header text rather than
  // an id, since only two of these five accordion sections' ids are
  // confirmed (see the payment-step CSS above) — matches the exact
  // "no vouchers" string the site itself shows, so a false positive would
  // require the site changing its own copy, not a structural guess.
  function annotateEmptyVoucherPanel() {
    const header = [...document.querySelectorAll('.card-header')]
      .find((h) => /Gutscheine einlösen/i.test(h.textContent));
    if (!header || header.dataset.uciAnnotated) return;
    const card = header.closest('.card') || header.parentElement;
    const body = card && card.querySelector('.card-body');
    if (!body || !/keine Gutscheine hinterlegt/i.test(body.textContent)) return;
    header.dataset.uciAnnotated = '1';
    const badge = document.createElement('span');
    badge.className = 'uci-empty-badge';
    badge.textContent = 'leer';
    header.appendChild(badge);
  }

  // Remembers which payment method (PayPal vs. Kreditkarte) was used last
  // and pre-selects it, so switching to a card once doesn't mean re-
  // clicking past the site's own default every booking after. Targets
  // the two tab links by their confirmed ids (read from the live payment
  // step) — NOT by text: the same section also holds "JETZT PAYPAL
  // ZAHLUNG HINTERLEGEN" / "JETZT ZAHLUNG MIT KREDITKARTE HINTERLEGEN"
  // buttons, which start registering a payment method. The old
  // first-text-match only hit the tabs because they happen to come first
  // in the markup. If either id is missing, nothing is clicked. Clicking
  // an already-active Bootstrap tab is a no-op, and this only ever
  // clicks once per page load (paymentMethodApplied), so it can't fight
  // the user if they then pick something else.
  const PAYMENT_METHOD_KEY = 'uci_payment_method_v1';
  let paymentMethodApplied = false;
  function wirePaymentMethodMemory() {
    const paypal = document.getElementById('payment-type-paypal-tab');
    const cc = document.getElementById('payment-tab-cc-tab');   // sic: "tab-cc", not "type-cc"
    if (!paypal || !cc) return;

    if (!paypal.dataset.uciWired) {
      paypal.dataset.uciWired = '1';
      paypal.addEventListener('click', () => store.set(PAYMENT_METHOD_KEY, 'paypal'));
    }
    if (!cc.dataset.uciWired) {
      cc.dataset.uciWired = '1';
      cc.addEventListener('click', () => store.set(PAYMENT_METHOD_KEY, 'kreditkarte'));
    }

    if (paymentMethodApplied) return;
    paymentMethodApplied = true;
    const preferred = store.get(PAYMENT_METHOD_KEY, null);
    if (preferred === 'paypal') paypal.click();
    else if (preferred === 'kreditkarte') cc.click();
  }

  // Compact header: "Finding Emily [OmU]" / "Sa 10.10. · 11:30 · East
  // Side Gallery · Kino 07", built from UCI's own #booking-info lines
  // (date "10.10.2026 | 11:30", cinema "UCI East Side Gallery | Kino 07",
  // version "Vorstellung in Originalsprache mit Untertiteln") and the film
  // title that the merged top bar no longer shows ("Finding Emily (OmU)").
  // Text is set via textContent, never parsed as HTML.
  const WEEKDAY_DE = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
  // Also read by the WebMCP booking-state tool, so separate from the DOM
  // work; the native lines it reads stay in the DOM next to our box.
  function readPerfInfo() {
    const right = document.querySelector('#booking-info .right-item');
    if (!right) return null;
    // :scope > — the native lines only; a looser match could pick up text
    // from inside our own #uci-perf-info.
    const text = (sel) => right.querySelector(`:scope > ${sel}`)?.textContent.replace(/\s+/g, ' ').trim() || '';
    const dt = text('.performance-date-and-time');
    // Until the booking loads, UCI shows "Datum und Zeit werden geladen...".
    if (!dt || /geladen/i.test(dt)) return null;

    let title = document.querySelector('#booking-header .filmTitle')?.textContent.trim() || '';
    let version = '';
    const suffix = title.match(/\s*\((OV|OmU|OmeU|OmdU)\)\s*$/i);
    if (suffix) { version = suffix[1]; title = title.slice(0, suffix.index); }
    if (!version) {
      const v = text('.film-version');
      version = /englisch/i.test(v) ? 'OmeU' : /untertitel/i.test(v) ? 'OmU' : /original/i.test(v) ? 'OV' : '';
    }

    const m = dt.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*\|?\s*(\d{1,2}:\d{2})?/);
    let when = dt;
    if (m) {
      const wd = WEEKDAY_DE.format(new Date(+m[3], +m[2] - 1, +m[1])).replace('.', '');
      when = `${wd} ${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.` + (m[4] ? ` · ${m[4]}` : '');
    }
    const where = text('.cinema-name-and-auditorium').replace(/^UCI\s+/i, '').replace(/\s*\|\s*/g, ' · ');
    return { title, version, when, where };
  }
  // UCI first renders placeholders ("Filmtitel wird geladen...", "Datum
  // und Zeit werden geladen...") and fills them in later; built from those,
  // the header stayed on them (seen live). So nothing is built while any
  // part still says "geladen", and it's rebuilt whenever the parts change.
  function compactPerfInfo() {
    const right = document.querySelector('#booking-info .right-item');
    if (!right) return;
    const info = readPerfInfo();
    const sig = info ? [info.title, info.version, info.when, info.where].join('|') : '';
    const existing = right.querySelector('#uci-perf-info');
    if (existing && existing.dataset.sig === sig) return;
    existing?.remove();
    if (!info || /geladen/i.test(sig)) return;
    const { title, version, when, where } = info;

    const box = document.createElement('div');
    box.id = 'uci-perf-info';
    box.dataset.sig = sig;
    if (title || version) {
      const t = document.createElement('div');
      t.className = 'uci-pi-title';
      if (title) t.append(title);
      if (version) {
        const chip = document.createElement('span');
        chip.className = 'uci-pi-version';
        chip.textContent = version;
        t.append(chip);
      }
      box.append(t);
    }
    const w = document.createElement('div');
    w.className = 'uci-pi-when';
    const b = document.createElement('b');
    b.textContent = when;
    w.append(b);
    if (where) w.append(' · ' + where);
    box.append(w);
    right.prepend(box);
  }

  // Erwachsener price per price category, appended to the seat-map legend
  // ("PK 1 · 16,90 €"). From seatsAndTickets.json, the same read-only
  // request UCI's seat map makes (params as in docs/API.md and
  // archive/seat-map.js): sections[].name is exactly the legend's label
  // text, prices[] holds each ticket type's amount per category. Fetched
  // once, on the seat step only; on failure the legend just has no prices.
  let legendPrices = null;   // null = not loaded, Map once loaded or failed
  let legendPricesLoading = false;
  async function loadLegendPrices() {
    const id = bpid();
    if (!id || legendPricesLoading) return;
    legendPricesLoading = true;
    try {
      const params = new URLSearchParams({
        bookingProcessId: id, allowCache: 'false',
        instanceId: String(Math.floor(Math.random() * 90000) + 10000),
        verboseSeatInfo: 'false', noRefresh: 'false', advancedFormat: '1',
        reason: 'Get seats and tickets data', _: String(Date.now()),
      });
      const res = await fetch(`/TicketBoxXNG/seatsAndTickets.json?${params}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      legendPrices = new Map((data.sections || []).map((sec) => {
        const p = (sec.prices || []).find((x) => /^erwachsen/i.test(x.nameOrg || x.name || '')) || (sec.prices || [])[0];
        return [String(sec.name || '').trim(), p ? p.amount : null];
      }).filter(([name, amount]) => name && typeof amount === 'number'));
    } catch (err) {
      console.warn(TAG, 'Legend prices not loaded:', err.message);
      legendPrices = new Map();
    }
    legendPricesLoading = false;
    annotateLegend();
  }
  function annotateLegend() {
    if (scriptOff) return;
    if (legendPrices === null) {
      if (rendered(document.getElementById('SeatingPlanComponentLayoutFooter'))) loadLegendPrices();
      return;
    }
    document.querySelectorAll('#SeatingPlanComponentLayoutFooter > div > div > div > div:last-child').forEach((label) => {
      if (label.querySelector('.uci-legend-price')) return;
      const amount = legendPrices.get((label.firstChild?.textContent || '').trim());
      if (amount == null) return;
      const span = document.createElement('span');
      span.className = 'uci-legend-price';
      span.textContent = ' · ' + amount.toFixed(2).replace('.', ',') + ' €';
      label.append(span);
    });
  }

  // Bottom bar for the seat, payment and confirm steps (CSS above). Each
  // step is recognized by its own button being rendered: UCI hides each
  // step's button once the next step shows (checked live on all three);
  // on any other step its own #customer-cart bar takes over again. The
  // confirm step's JETZT KAUFEN is a submit button inside its terms form,
  // and stays inside it — only positioned — so submitting is unchanged;
  // it's disabled until the terms are accepted. The free
  // variant (#payment-type-free-content, shown instead when cards cover
  // the whole price) is assumed, not yet seen live. Re-rendered on every
  // change to the cart (cartObserver) and every poll tick, which also
  // re-aligns it.
  const rendered = (el) => !!el && el.getClientRects().length > 0;
  function stepAction() {
    const seat = document.getElementById('nextStepButton') || document.querySelector('#stepControl .btn-block');
    if (rendered(seat)) {
      return { step: 'seats', btn: seat, column: document.getElementById('StepSeatingLayout'), hint: 'Erst Tickets und Plätze wählen' };
    }
    const pay = [document.getElementById('init-checkout-process-button'),
      ...document.querySelectorAll('#payment-type-free-content .btn')].find(rendered);
    // The cards' own edges, not #payment-selection: that .container has 15px
    // of padding, which put the bar's text and button 13–15px outside the
    // cards (measured live).
    if (pay) return { step: 'payment', btn: pay, column: document.getElementById('payment-type-accordion'), hint: '' };
    const buy = document.getElementById('jetzt-kaufen-button');
    if (rendered(buy)) {
      return { step: 'confirm', btn: buy, column: document.getElementById('payment-confirmation-agb-acceptance'), hint: 'Erst die Nutzungsbedingungen akzeptieren' };
    }
    return null;
  }
  let cartObserver = null;
  function updateStepBar() {
    if (scriptOff) return;
    const action = stepAction();
    const root = document.documentElement;
    document.querySelectorAll('.uci-bar-action').forEach((b) => {
      if (!action || b !== action.btn) b.classList.remove('uci-bar-action', 'uci-bar-action--muted');
    });
    root.classList.toggle('uci-bar', !!action);
    let bar = document.getElementById('uci-stepbar');
    if (!action) { bar?.remove(); return; }
    action.btn.classList.add('uci-bar-action');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'uci-stepbar';
      bar.innerHTML = '<div class="uci-sb-inner"><div class="uci-sb-sum"></div><div class="uci-sb-sub"></div></div>';
      document.body.appendChild(bar);
    }

    const r = action.column && action.column.getBoundingClientRect();
    if (r && r.width) {
      root.style.setProperty('--uci-sb-l', Math.max(16, Math.round(r.left)) + 'px');
      root.style.setProperty('--uci-sb-r', Math.max(16, Math.round(window.innerWidth - r.right)) + 'px');
    }

    const cart = document.getElementById('customer-cart');
    if (cart && !cartObserver) {
      cartObserver = new MutationObserver(updateStepBar);
      cartObserver.observe(cart, { childList: true, subtree: true, characterData: true });
    }
    const count = cart?.querySelector('.customer-cart-ticket-counter')?.textContent.trim() || '';
    // "18.40 €", or "0.00 € (9.90 €)" once cards cover it (confirm step).
    const total = (cart?.querySelector('.customer-cart-total-price')?.textContent.trim() || '')
      .replace(/(\d)\.(\d\d)/g, '$1,$2').replace(/\(\s*(?=\d)/, '(statt ');
    // "PK 1 LOGE | Reihe 2 | Sitz 11" per seat → "Reihe 2: Sitz 11, 12".
    const rows = new Map();
    cart?.querySelectorAll('.cart-content-sub-header').forEach((h) => {
      const sm = h.textContent.match(/Reihe\s*(\S+)\s*\|\s*Sitz\s*(\S+)/i);
      if (sm) rows.set(sm[1], [...(rows.get(sm[1]) || []), sm[2]]);
    });
    const seats = [...rows].map(([row, nums]) => `Reihe ${row}: Sitz ${nums.join(', ')}`).join(' · ');
    const hasTickets = !!count && !/^0\b/.test(count);
    const sum = hasTickets ? [count, total].filter(Boolean).join(' · ') : 'Noch keine Tickets';
    let sub = action.btn.disabled && action.hint ? action.hint : seats;

    // Payment step: cards ticked in the panel but not redeemed yet (or
    // being redeemed right now) → warn and outline Weiter. Read from the
    // panel and basket(), which work through pageBridge on iPhone too.
    let warn = false;
    if (action.step === 'payment' && panel.isConnected) {
      const b = basket();
      const ticked = panel.querySelectorAll('#uci-list input[type=checkbox]:checked:not([data-applied])').length;
      if (running) {
        warn = true; sub = 'Unlimited Cards werden eingelöst…';
      } else if (b && b.open > 0 && ticked > 0) {
        const n = Math.min(ticked, b.open);
        warn = true;
        sub = `${n} Unlimited Card${n === 1 ? '' : 's'} noch nicht eingelöst — sonst ${eur(b.due)} fällig`;
      }
    }
    action.btn.classList.toggle('uci-bar-action--muted', warn);
    bar.classList.toggle('uci-sb-warn', warn);

    const sumEl = bar.querySelector('.uci-sb-sum'), subEl = bar.querySelector('.uci-sb-sub');
    if (sumEl.textContent !== sum) sumEl.textContent = sum;
    if (subEl.textContent !== sub) subEl.textContent = sub;
  }
  window.addEventListener('resize', () => { if (!scriptOff) updateStepBar(); });

  // Runs take 30–50s; you will have tabbed away by the time it finishes.
  let origTitle = null;
  function flashTitle(msg) {
    if (document.hasFocus()) return;
    origTitle = origTitle || document.title;
    document.title = msg;
    window.addEventListener('focus', function restore() {
      document.title = origTitle; origTitle = null;
      window.removeEventListener('focus', restore);
    });
  }

  // --------------------------------------------------------------------- ui
  const panel = document.createElement('div');
  panel.id = 'uci-batch';
  panel.innerHTML = `
    <style>
      /* font-size must be set on its own: the shorthand "font: 14px/1.5 inherit"
         is invalid (inherit is not a legal family), so Chrome dropped the whole
         declaration and the page's ~20px body type leaked into every label. */
      #uci-batch{color:#fff;font-size:14px;line-height:1.5;margin:0 0 8px;max-width:620px;
        accent-color:#fff101}
      #uci-batch .basket{font-size:13px;color:#cfd6e0;background:rgba(255,255,255,.06);
        border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:8px 10px;margin-bottom:2px}
      #uci-batch .basket b{color:#fff101;font-weight:600}
      #uci-batch .fee{display:block;color:#8b97a8;font-size:11px;margin-top:2px}

      #uci-batch .person{display:flex;flex-wrap:wrap;align-items:center;gap:8px;
        padding:9px 2px;border-bottom:1px solid rgba(255,255,255,.09)}
      #uci-batch .person:hover{background:rgba(255,255,255,.03)}
      #uci-batch .pname{font-weight:600;font-size:14px}
      #uci-batch .pcode{font-size:11px;color:#7c8899;font-family:ui-monospace,monospace;
        letter-spacing:.3px;margin-right:auto}
      /* Always visible but quiet — it used to be opacity:0 until hover,
         which on touch devices (no hover) meant an invisible but tappable
         delete. Two-step: first click arms it ("löschen?"), second
         deletes, see renderList(). */
      #uci-batch .del{cursor:pointer;color:#7c8899;font-size:15px;line-height:1;
        opacity:.45;transition:opacity .12s;padding:0 4px}
      #uci-batch .person:hover .del{opacity:1}
      @media (hover:none){#uci-batch .del{opacity:1}}
      #uci-batch .del:hover{color:#ff9c9c}
      #uci-batch .del.armed{opacity:1;color:#ff9c9c;font-size:12px;font-weight:600}
      #uci-batch .badge{font-size:11px;padding:2px 9px;border-radius:10px;white-space:nowrap;
        background:rgba(255,255,255,.12);color:#cfd6e0}
      #uci-batch .badge:empty{display:none}
      #uci-batch .badge.run{background:rgba(255,241,1,.16);color:#fff101}
      #uci-batch .badge.ok{background:rgba(60,190,110,.18);color:#7fd6a0}
      #uci-batch .badge.err{background:rgba(220,90,90,.18);color:#ff9c9c}
      #uci-batch .badge.skip{background:rgba(220,180,60,.16);color:#ffd77f}
      #uci-batch .retry{display:none;cursor:pointer;font-size:14px;color:#ffd77f;padding:0 2px}
      #uci-batch .retry.on{display:inline}
      /* empty details must not reserve a line, or idle rows look double height */
      #uci-batch .detail{flex:0 0 100%;font-size:11.5px;color:#98a4b3;padding-left:26px}
      #uci-batch .detail:empty{display:none}

      #uci-batch .go{margin-top:12px;width:100%;max-width:280px;padding:9px;border:0;
        border-radius:5px;background:#fff101;color:#000;font-weight:700;cursor:pointer;
        font-size:14px;letter-spacing:.4px}
      #uci-batch .go:hover:not(:disabled){filter:brightness(1.08)}
      #uci-batch .go:disabled{background:rgba(255,241,1,.28);color:rgba(0,0,0,.55);cursor:default}
      #uci-batch .prog{font-size:12px;color:#98a4b3;margin-top:7px;min-height:1em}
      #uci-batch .prog span:first-child{color:#cfd6e0;margin-right:12px}
      #uci-batch .hint{font-size:12px;color:#ffd77f;min-height:1em;margin-top:6px}
      #uci-batch .hint:empty{min-height:0}
      /* No code ever adds an 'on' class to this box (checked: no
         classList.add/toggle('on', ...) targets #uci-log anywhere), so the
         old display:none/.log.on pair left this permanently hidden —
         ui.log()/rep.log() were writing retry and error detail into a box
         nothing could ever reveal. :empty is what actually keeps it out of
         the way pre-run, matching .badge:empty/.detail:empty below. */
      #uci-batch .log{margin-top:8px;max-height:140px;overflow:auto;
        font-size:11px;line-height:1.45;font-family:ui-monospace,monospace;
        background:rgba(0,0,0,.28);border-radius:5px;padding:7px}
      #uci-batch .log:empty{display:none}
      #uci-batch .log .ok{color:#7fd6a0} #uci-batch .log .err{color:#ff9c9c}
      #uci-batch .log .warn{color:#ffd77f} #uci-batch .log .info{color:#9aa6b5}
      #uci-batch .addbox{padding:6px 2px}
      #uci-batch .addbox > summary{margin-top:0;padding:2px 0;color:#fff101;font-size:12.5px;
        font-weight:600;list-style:none}
      #uci-batch .addbox > summary::-webkit-details-marker{display:none}
      #uci-batch .addbox > summary:hover{filter:brightness(1.15)}
      #uci-batch .addbox[open] > summary{color:#8b97a8;font-weight:400}
      #uci-batch input[type=text],#uci-batch textarea{background:rgba(255,255,255,.08);
        border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:4px;padding:6px;
        margin:3px 0;width:100%;max-width:280px;box-sizing:border-box;font-family:inherit;
        font-size:13px}
      #uci-batch input[type=text]:focus,#uci-batch textarea:focus{outline:none;
        border-color:rgba(255,241,1,.6)}
      #uci-batch textarea{font-size:11px;line-height:1.4;font-family:ui-monospace,monospace;
        height:70px;max-width:none}
      #uci-batch summary{cursor:pointer;font-size:12px;color:#8b97a8;margin-top:10px}
      #uci-batch .tiny{font-size:11.5px;color:#98a4b3}
      #uci-batch .mini{width:auto;max-width:none;flex:1;margin-top:4px;padding:5px;font-size:12px}
      #uci-batch .rowbtns{display:flex;gap:6px}
      #uci-batch #uci-diag{margin-top:6px;font-family:ui-monospace,monospace;font-size:10.5px;color:#7c8899}
    </style>
    <div class="basket" id="uci-basket">Warenkorb wird gelesen…</div>
    <div id="uci-list"></div>
    <details id="uci-addbox" class="addbox">
      <summary>+ Unlimited Card hinzufügen</summary>
      <input type="text" id="uci-name" placeholder="Name">
      <input type="text" id="uci-code" placeholder="Kartennummer">
      <button class="go mini" id="uci-add">Hinzufügen</button>
    </details>
    <div class="hint" id="uci-hint"></div>
    <button class="go" id="uci-go">EINLÖSEN</button>
    <div class="prog" id="uci-prog"><span id="uci-cardcount"></span><span id="uci-stepcount"></span></div>
    <div class="log" id="uci-log"></div>
    <details>
      <summary>Unlimited Cards verwalten</summary>
      <div class="rowbtns">
        <button class="go mini" id="uci-export">Exportieren</button>
        <button class="go mini" id="uci-import">Importieren</button>
      </div>
      <textarea id="uci-io" placeholder="JSON — zum Teilen kopieren, oder hier einfügen und auf Importieren klicken"></textarea>
      <div class="tiny" id="uci-diag"></div>
    </details>`;

  let timer = null;
  let userTouched = false;   // once you pick manually, defaults stop overriding you
  let lastLimit = null;

  const ui = {
    busy: (b) => { const g = panel.querySelector('#uci-go'); g.disabled = b; g.textContent = b ? 'LÄUFT…' : 'EINLÖSEN'; },
    diag: (m) => { if (m !== ui._diag) { ui._diag = m; console.log(TAG, m); } },
    // Sticky hints (run failures) survive the 1.5s poll; cap hints do not.
    hint: (m, sticky) => {
      if (ui._sticky && !sticky) return;
      ui._sticky = !!(sticky && m);
      panel.querySelector('#uci-hint').textContent = m || '';
    },
    progress: (m) => { panel.querySelector('#uci-stepcount').textContent = m || ''; },
    cardCount: (m) => { panel.querySelector('#uci-cardcount').textContent = m || ''; },
    clearLog: () => { panel.querySelector('#uci-log').innerHTML = ''; },
    log: (m, cls) => {
      const box = panel.querySelector('#uci-log');
      box.insertAdjacentHTML('beforeend',
        `<div class="${cls || 'info'}">${new Date().toTimeString().slice(0, 8)} ${esc(m)}</div>`);
      box.scrollTop = box.scrollHeight;
    },
    set: (id, cls, text) => {
      const b = panel.querySelector(`.badge[data-id="${id}"]`);
      const d = panel.querySelector(`.detail[data-id="${id}"]`);
      const r = panel.querySelector(`.retry[data-id="${id}"]`);
      if (b) { b.className = 'badge ' + cls;
        b.textContent = { ok: 'fertig', err: 'Fehler', skip: 'übersprungen', run: 'läuft' }[cls] || ''; }
      if (d) d.textContent = text || '';
      if (r) r.classList.toggle('on', cls === 'err');
    },
    reporterFor: (p) => {
      const d = panel.querySelector(`.detail[data-id="${p.id}"]`);
      const b = panel.querySelector(`.badge[data-id="${p.id}"]`);
      const rt = panel.querySelector(`.retry[data-id="${p.id}"]`);
      let base = '', att = '';
      if (b) { b.className = 'badge run'; b.textContent = 'läuft'; }
      if (rt) rt.classList.remove('on');
      const paint = (x) => { if (d) d.textContent = att + base + (x || ''); };
      return {
        attempt: (n, max) => { att = n > 1 ? `[${n}/${max}] ` : ''; paint(); },
        phase: (t) => { base = t; paint(); },
        inflight: (t0) => { clearInterval(timer);
          timer = setInterval(() => paint(` … ${((performance.now() - t0) / 1000).toFixed(1)}s`), 100); },
        settled: () => { clearInterval(timer); timer = null; paint(); },
        log: (m, c) => ui.log('  ' + m, c),
      };
    },
  };

  function updateBasket() {
    const el = panel.querySelector('#uci-basket');
    const b = basket();
    // Without page access the basket can't be read at all, which is a
    // different problem from an empty one, so it gets its own message.
    if (!b && useBridge && !pageWin() && !pageBridge.alive) {
      el.textContent = 'Buchungsdaten nicht lesbar — Seite neu laden.'; return;
    }
    if (!b) { el.textContent = 'Noch kein Warenkorb — bitte zuerst Plätze wählen.'; return; }
    // Ticket count and total are in the bottom bar now (updateStepBar);
    // this keeps what matters for redeeming.
    const parts = [];
    if (b.unlimited) parts.push(`<b>${b.unlimited}</b> mit Unlimited`);
    if (b.free) parts.push(`<b>${b.free}</b> mit Movie Points`);
    parts.push(`<b>${b.open}</b> zu zahlen`);
    el.innerHTML = parts.join(' · ') +
      (lastFee ? `<span class="fee">zzgl. ${eur(lastFee)} Buchungsgebühr</span>` : '');
    enforceCap();
  }

  // Pre-select only as many cards as there are seats to fill. Ticking all of
  // them and letting the server refuse the surplus is just noise.
  function applyDefaults() {
    const b = basket();
    const limit = b ? b.open : 0;
    let n = 0;
    panel.querySelectorAll('#uci-list input[type=checkbox]').forEach((c) => {
      if (c.dataset.applied) { c.checked = false; return; }
      c.checked = n < limit;
      if (c.checked) n++;
    });
    enforceCap();
  }

  // Selecting more cards than there are eligible seats can never work — the
  // extras would each burn a wasted probe before the server refuses them.
  const seatsWord = (n) => (n === 1 ? '1 freier Platz' : `${n} freie Plätze`);
  function enforceCap() {
    const b = basket();
    const boxes = [...panel.querySelectorAll('#uci-list input[type=checkbox]')];
    if (!b || running) { boxes.forEach((c) => (c.disabled = running)); return; }
    const limit = b.open;
    const checked = boxes.filter((c) => c.checked && !c.dataset.applied);
    boxes.forEach((c) => { c.disabled = !c.checked && !c.dataset.applied && checked.length >= limit; });
    ui.hint(checked.length > limit
      ? `Nur ${seatsWord(limit)} — bitte Auswahl reduzieren.`
      : checked.length === limit && limit > 0 ? `Maximum erreicht (${seatsWord(limit)}).` : '');
    updateStepBar();   // its "noch nicht eingelöst" warning follows the ticks
  }

  // Cards already on the booking (reload, partial run, manual redemption)
  // should show as done without re-probing anything.
  function syncApplied() {
    if (running) return;
    const rows = localRows();
    (panel._rows || []).forEach((p) => {
      const row = appliedRow(rows, p.code);
      const box = panel.querySelector(`#uci-list input[data-id="${p.id}"]`);
      if (row) {
        ui.set(p.id, 'ok', seatLabel(row));
        if (box) { box.dataset.applied = '1'; box.checked = false; }
      } else if (box && box.dataset.applied) {
        delete box.dataset.applied;
        ui.set(p.id, '', '');
      }
    });
  }

  // Your own card (from the logged-in account) first, then the saved ones.
  function cardRows() {
    const b = getBook();
    const rows = [];
    if (b && b.unlimitedCustomerNumber)
      rows.push({ id: 'own', name: 'Ich', code: b.unlimitedCustomerNumber, own: true });
    loadCards().forEach((c, i) => rows.push({ id: 'c' + i, name: c.name, code: c.code, idx: i }));
    return rows;
  }

  function renderList() {
    const rows = cardRows();

    const prev = panel._rows || [];
    if (prev.length === rows.length && prev.every((r, i) => r.id === rows[i].id && r.code === rows[i].code))
      return false;

    const list = panel.querySelector('#uci-list');
    list.innerHTML = rows.length ? '' : '<div class="tiny">Noch keine Karten gespeichert.</div>';
    const codes = rows.map((r) => r.code.trim());
    rows.forEach((c) => {
      const dup = codes.indexOf(c.code.trim()) !== codes.lastIndexOf(c.code.trim());
      const el = document.createElement('div');
      el.className = 'person';
      el.innerHTML = `
        <input type="checkbox" data-id="${c.id}">
        <span class="pname"></span>
        <span class="pcode">${esc(mask(c.code))}</span>
        ${c.own ? '' : `<span class="del" data-del="${c.idx}" title="Karte löschen">×</span>`}
        <span class="retry" data-id="${c.id}" title="nur diese Karte erneut versuchen">↻</span>
        <span class="badge" data-id="${c.id}"></span>
        <span class="detail" data-id="${c.id}">${dup ? '⚠ doppelt gespeichert' : ''}</span>`;
      el.querySelector('.pname').textContent = c.name;
      list.appendChild(el);
    });

    list.querySelectorAll('[data-del]').forEach((el) => {
      let disarm = null;
      el.onclick = () => {
        if (!el.classList.contains('armed')) {
          el.classList.add('armed'); el.textContent = 'löschen?';
          disarm = setTimeout(() => { el.classList.remove('armed'); el.textContent = '×'; }, 3000);
          return;
        }
        clearTimeout(disarm);
        const cards = loadCards(); cards.splice(+el.dataset.del, 1); saveCards(cards);
        panel._rows = null; renderList();
      };
    });
    list.querySelectorAll('.retry').forEach((el) => {
      el.onclick = () => {
        if (running) return;
        const p = (panel._rows || []).find((r) => r.id === el.dataset.id);
        if (p) { ui.clearLog(); ui.log(`Wiederholung: ${p.name}`, 'info'); runQueue([p]); }
      };
    });
    list.querySelectorAll('input[type=checkbox]').forEach((el) => {
      el.onchange = () => { userTouched = true; enforceCap(); };
    });

    panel._rows = rows;
    return true;
  }

  function setNativeVisible(on) {
    ['#uc-wrapper', '#unlimited-card-number-form'].forEach((s) => {
      const el = document.querySelector(s);
      if (el) el.style.display = on ? '' : 'none';
    });
  }

  function wire() {
    panel.querySelector('#uci-go').onclick = () => {
      const ids = [...panel.querySelectorAll('#uci-list input[type=checkbox]:checked')].map((c) => c.dataset.id);
      if (!ids.length) return ui.hint('Keine Karte ausgewählt.', true);
      ids.forEach((id) => ui.set(id, '', ''));
      advanceArmed = true;
      redeemAll((panel._rows || []).filter((r) => ids.includes(r.id)));
    };

    const addCard = () => {
      const name = panel.querySelector('#uci-name').value.trim();
      const code = panel.querySelector('#uci-code').value;   // not trimmed: padding matters
      if (!name || !code) return;
      saveCards([...loadCards(), { name, code }]);
      panel.querySelector('#uci-name').value = '';
      panel.querySelector('#uci-code').value = '';
      panel.querySelector('#uci-addbox').open = false;
      panel._rows = null; renderList(); updateBasket();
    };
    panel.querySelector('#uci-add').onclick = addCard;
    ['#uci-name', '#uci-code'].forEach((s) => {
      panel.querySelector(s).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addCard(); } };
    });

    panel.querySelector('#uci-export').onclick = () => {
      panel.querySelector('#uci-io').value = JSON.stringify(loadCards(), null, 1);
    };

    panel.querySelector('#uci-import').onclick = () => {
      const box = panel.querySelector('#uci-io');
      const data = safeParse(box.value);
      if (!Array.isArray(data) || !data.every((c) => c && typeof c.name === 'string' && typeof c.code === 'string'))
        return ui.log('Import fehlgeschlagen: erwartet [{"name":"…","code":"…"}]', 'err');
      const merged = loadCards();
      let added = 0;
      data.forEach((c) => {
        if (!merged.some((m) => m.code.trim() === c.code.trim())) { merged.push({ name: c.name, code: c.code }); added++; }
      });
      saveCards(merged);
      box.value = '';
      panel._rows = null; renderList(); updateBasket();
      ui.log(`Import: ${added} neu, ${data.length - added} bereits vorhanden`, 'ok');
    };
  }

  let mounted = false;
  // Fully custom UI, but every click proxies through to the real native
  // button (hidden, not removed) rather than reimplementing pricing or
  // combo-ticket eligibility ourselves — a MutationObserver on the native
  // container keeps this in sync with whatever it does in response,
  // synchronous or not, without guessing at timing.
  // Shortens recurring verbose patterns rather than special-casing one
  // label — "Fam-Tarif: Kind (unter 12 J)" becomes "Fam. Kind (u. 12J)",
  // short enough to fit one line like the others. General regex rules so
  // this also helps if another cinema phrases things similarly.
  function shortenTicketLabel(label) {
    return label
      .replace(/^Fam-Tarif:\s*/i, 'Fam. ')
      .replace(/\bunter\s*12\s*J\b/i, 'u. 12J')
      .trim();
  }

  function ticketRows(container) {
    return [...container.querySelectorAll('.ticket-type-row')].map((rowEl) => {
      const typeText = rowEl.querySelector('.ticket-type-row-type')?.textContent.trim() || '';
      const m = typeText.match(/^(\d+)\s+(.*)$/);
      return {
        id: rowEl.id,
        count: m ? m[1] : '0',
        label: shortenTicketLabel(m ? m[2] : typeText),
        price: rowEl.querySelector('.ticket-type-row-price')?.textContent.trim() || '',
        minusBtn: rowEl.querySelector('.btnTicketControlMinus'),
        plusBtn: rowEl.querySelector('.btnTicketControlPlus'),
      };
    });
  }

  function renderTicketPanel(container, panel) {
    const rows = ticketRows(container);
    if (!rows.length) {
      // The native container exists but has no .ticket-type-row children
      // right now — almost certainly mid-recalculation on the site's own
      // side (we already know it wholesale-replaces this area on other
      // changes), not genuinely empty. Overwriting the panel here would
      // blank it out for however long that gap lasts; leaving the last
      // good render in place until real rows come back avoids that.
      console.warn(TAG, 'ticket container has zero rows right now — skipping render, keeping last state');
      return;
    }
    // UCI only allows a family-adult ticket alongside a family-child one;
    // its own UI just greys out the + with no reason given.
    const blockedHint = (r) => r.plusBtn?.disabled && /^Fam\. Erw/i.test(r.label)
      ? 'nur mit Fam. Kind' : '';
    panel.innerHTML = rows.map((r) => `
      <div class="tk2-row"${blockedHint(r) ? ` title="${blockedHint(r)}"` : ''}>
        <div class="tk2-info">
          <span class="tk2-label">${esc(r.label)}</span>
          <span class="tk2-price">${esc(r.price)}</span>
          ${blockedHint(r) ? `<span class="tk2-hint">${blockedHint(r)}</span>` : ''}
        </div>
        <div class="tk2-stepper">
          <button class="tk2-btn minus" data-id="${r.id}" ${r.minusBtn?.disabled ? 'disabled' : ''} aria-label="weniger"></button>
          <span class="tk2-count">${r.count}</span>
          <button class="tk2-btn plus" data-id="${r.id}" ${r.plusBtn?.disabled ? 'disabled' : ''} aria-label="mehr"></button>
        </div>
      </div>`).join('');
    panel.querySelectorAll('.tk2-btn.minus').forEach((b) => {
      b.onclick = () => rows.find((r) => r.id === b.dataset.id)?.minusBtn?.click();
    });
    panel.querySelectorAll('.tk2-btn.plus').forEach((b) => {
      b.onclick = () => rows.find((r) => r.id === b.dataset.id)?.plusBtn?.click();
    });
  }

  // The site appears to replace #ticket-type-container wholesale on every
  // quantity change rather than mutating it — that's what caused the
  // flicker back to the native UI: an inline display:none on the old node
  // doesn't carry over to its replacement, and a MutationObserver bound to
  // that old node silently stops firing once it's detached. Hiding is now
  // a stylesheet rule (re-applies to any element with that id regardless
  // of node identity), the panel re-anchors itself next to whatever the
  // current container is on every check, and the observer watches a
  // stable ancestor instead of the container itself.
  let ticketObserver = null;

  // The site has one .tab-pane.section-pane per seat price category (PK1/
  // PK2/PK3/PK1 LOGE), each with its OWN #ticket-type-container — same id,
  // repeated, which is invalid HTML but browsers don't enforce uniqueness.
  // A plain querySelector always grabs the first one in document order,
  // regardless of which pane is actually visible — which is why the panel
  // would vanish the moment a seat got selected in a different price
  // category: it stayed anchored to whichever copy happened to be first,
  // not the one that was still on screen.
  function findActiveTicketContainer() {
    const panes = document.querySelectorAll('.tab-pane.section-pane');
    for (const pane of panes) {
      if (pane.style.display !== 'none') {
        const c = pane.querySelector('#ticket-type-container');
        if (c) return c;
      }
    }
    return document.querySelector('#ticket-type-container');
  }

  function mountTicketSelector() {
    if (scriptOff) return false;
    const container = findActiveTicketContainer();
    if (!container) return false;

    let panel = document.getElementById('uci-tickets');
    if (!panel) panel = document.createElement('div');
    panel.id = 'uci-tickets';

    // Disconnected before ANY of our own DOM writes below — both
    // re-anchoring the panel next to the active pane's container and
    // rewriting its contents are mutations inside the subtree the
    // observer watches. Without this, our own writes retrigger the
    // observer, which calls this function again. That was a genuine
    // infinite loop before, not a hypothetical one.
    if (ticketObserver) ticketObserver.disconnect();
    if (panel.previousElementSibling !== container || !panel.isConnected) {
      container.insertAdjacentElement('afterend', panel);
    }
    renderTicketPanel(container, panel);

    const stableAncestor = document.querySelector('#ticketselection');
    if (stableAncestor) {
      if (!ticketObserver) ticketObserver = new MutationObserver(() => mountTicketSelector());
      ticketObserver.observe(stableAncestor, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['style'],
      });
    }
    return true;
  }

  // No floating fallback: the payment step (HOST_SEL) doesn't exist yet
  // while seats are still being picked, and showing this panel loose on
  // top of the page at that point is more confusing than useful — it's
  // only relevant once checkout is reached. Leaving mounted false here
  // just means poll() below calls tryMount() again next tick.
  function tryMount() {
    if (mounted || scriptOff) return;
    const host = document.querySelector(HOST_SEL);
    if (!host) return;
    host.insertBefore(panel, host.firstChild);
    setNativeVisible(false);
    console.log(TAG, 'mounted inline');
    mounted = true;
    wire();
  }

  // ---------------------------------------------------------------- WebMCP
  // Booking-page tools (see webmcp at the top). Seat choice, "Weiter" and
  // payment stay with the user; the agent can read the booking and redeem
  // Unlimited cards, your own and saved friends', on the payment step.
  const normName = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const OWN_ALIASES = new Set(['ich', 'me', 'myself', 'self', 'own', 'mine']);

  function cardsForAgent() {
    const rows = localRows();
    return cardRows().map((p) => {
      const applied = appliedRow(rows, p.code);
      return { name: p.name, own: !!p.own, card: mask(p.code),
        redeemed: !!applied, seat: applied ? seatLabel(applied) : null };
    });
  }

  // Agent-requested redemption always waits for a click here. Built with
  // textContent only: card names come from saved/imported JSON.
  function confirmAgentRedeem(people) {
    return new Promise((resolve) => {
      document.getElementById('uci-mcp-confirm')?.remove();
      const box = document.createElement('div');
      box.id = 'uci-mcp-confirm';
      box.innerHTML = `
        <style>
          #uci-mcp-confirm{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);
            display:flex;align-items:center;justify-content:center;padding:16px;
            font:14px/1.45 system-ui,-apple-system,sans-serif}
          #uci-mcp-confirm .dlg{background:#0b1a3a;color:#e8edf3;border:1px solid rgba(255,255,255,.18);
            border-radius:8px;padding:16px 18px;max-width:360px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.5)}
          #uci-mcp-confirm .t{font-weight:700;margin-bottom:4px}
          #uci-mcp-confirm .perf{font-size:12.5px;color:#98a4b3;margin-bottom:10px}
          #uci-mcp-confirm ul{margin:0 0 14px;padding:0;list-style:none}
          #uci-mcp-confirm li{display:flex;justify-content:space-between;gap:10px;padding:3px 0;
            border-bottom:1px solid rgba(255,255,255,.08)}
          #uci-mcp-confirm li span:last-child{color:#98a4b3;font-family:ui-monospace,monospace;font-size:12px}
          #uci-mcp-confirm .btns{display:flex;gap:8px;justify-content:flex-end}
          /* site-wide button min-height:45px (CLAUDE.md) */
          #uci-mcp-confirm button{min-height:0;border:0;border-radius:5px;padding:8px 14px;
            font-weight:700;font-size:13px;cursor:pointer;background:rgba(255,255,255,.12);color:#e8edf3}
          #uci-mcp-confirm button.yes{background:#fff101;color:#000}
        </style>
        <div class="dlg" role="dialog" aria-modal="true">
          <div class="t"></div><div class="perf"></div><ul></ul>
          <div class="btns"><button type="button" data-a="0">Abbrechen</button>
            <button type="button" class="yes" data-a="1">Einlösen</button></div>
        </div>`;
      box.querySelector('.t').textContent = `KI-Assistent: ${people.length === 1 ? '1 Unlimited Card'
        : people.length + ' Unlimited Cards'} einlösen?`;
      const info = readPerfInfo();
      box.querySelector('.perf').textContent = info
        ? [info.title + (info.version ? ` (${info.version})` : ''), info.when].filter(Boolean).join(' · ') : '';
      const ul = box.querySelector('ul');
      people.forEach((p) => {
        const li = document.createElement('li');
        const n = document.createElement('span'); n.textContent = p.name;
        const c = document.createElement('span'); c.textContent = mask(p.code);
        li.append(n, c); ul.append(li);
      });
      const done = (yes) => { box.remove(); resolve(yes); };
      box.querySelectorAll('button').forEach((b) => { b.onclick = () => done(b.dataset.a === '1'); });
      box.addEventListener('click', (e) => { if (e.target === box) done(false); });
      document.body.appendChild(box);
      box.querySelector('button.yes').focus();
    });
  }

  function registerBookingTools() {
    webmcp.register([
      {
        name: 'get_booking_state',
        title: 'Buchung lesen',
        description: 'Read the current UCI cinema booking: which step it is on (seats, payment, confirm), '
          + 'the film and showing, the seats in the basket with what covers each one, and the amount still to pay. '
          + 'The user is logged in. Seats are picked by the user on the native seat map; '
          + 'Unlimited cards can only be redeemed on the payment step.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        run: () => {
          const names = new Map(cardRows().map((p) => [p.code.trim(), p.name]));
          const b = basket();
          return {
            step: stepAction()?.step || 'other',
            showing: readPerfInfo(),
            seats: localRows().map((r) => ({
              seat: seatLabel(r), price: r.amount,
              coveredBy: r.unlimitedTicket
                ? 'Unlimited: ' + (names.get((r.unlimitedTicketCardNo || '').trim()) || 'andere Karte')
                : r.freeTicket ? 'Movie Points' : null,
            })),
            basket: b && { tickets: b.n, unlimited: b.unlimited, moviePoints: b.free,
              seatsToPay: b.open, amountDue: Math.round(b.due * 100) / 100, bookingFee: lastFee },
            canRedeemUnlimited: stepAction()?.step === 'payment' && !scriptOff && !!b && b.open > 0,
          };
        },
      },
      {
        name: 'list_unlimited_cards',
        title: 'Unlimited Cards',
        description: 'List the Unlimited cards better-uci can redeem: the logged-in user\'s own card ("Ich") '
          + 'and saved friends\' cards, by name, with a masked card number and whether each is already '
          + 'redeemed on this booking (and on which seat).',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        run: () => ({ cards: cardsForAgent() }),
      },
      {
        name: 'redeem_unlimited_cards',
        title: 'Unlimited Cards einlösen',
        description: 'Redeem Unlimited cards on this booking, one seat per card, the user\'s own and/or saved '
          + 'friends\'. Pass card names exactly as list_unlimited_cards returns them ("Ich" is the user\'s own). '
          + 'Only works on the payment step, with no more cards than seats still to pay. The user has to '
          + 'confirm in a dialog on the page first. Does not check out: afterwards the user presses "Weiter".',
        inputSchema: {
          type: 'object',
          properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1,
            description: 'Card names from list_unlimited_cards' } },
          required: ['names'],
        },
        annotations: { consequentialHint: true },
        run: async ({ names }) => {
          if (scriptOff) throw new Error('better-uci is switched off on this page.');
          // Not `mounted`: the panel mounts into the payment section while
          // it's still hidden, on the seat step already (seen live).
          if (stepAction()?.step !== 'payment' || !mounted)
            throw new Error('Not on the payment step yet. The user has to pick seats and continue first.');
          if (running) throw new Error('A redemption is already running.');
          if (!Array.isArray(names) || !names.length) throw new Error('names must list at least one card name.');
          const all = cardRows();
          const people = [];
          for (const raw of names) {
            const n = normName(raw);
            const hits = OWN_ALIASES.has(n) ? all.filter((p) => p.own) : all.filter((p) => normName(p.name) === n);
            if (!hits.length) throw new Error(`No card named "${raw}". Available: ${all.map((p) => p.name).join(', ') || 'none'}.`);
            if (hits.length > 1) throw new Error(`More than one card is named "${raw}"; the user has to rename one.`);
            if (!people.includes(hits[0])) people.push(hits[0]);
          }
          const rows = localRows();
          const todo = people.filter((p) => !appliedRow(rows, p.code));
          const b = basket();
          if (!b) throw new Error('No basket yet.');
          if (todo.length > b.open)
            throw new Error(`Only ${b.open} seat(s) left to pay, but ${todo.length} card(s) not yet redeemed were given.`);
          if (!todo.length) return { results: [], note: 'All of these cards are already redeemed.', cards: cardsForAgent() };
          if (!(await confirmAgentRedeem(todo))) return { cancelled: true, note: 'The user cancelled.' };
          if (running) throw new Error('A redemption is already running.');
          advanceArmed = true;
          const results = await redeemAll(todo);
          const after = basket();
          return {
            results,
            seatsToPay: after ? after.open : null,
            amountDue: after ? Math.round(after.due * 100) / 100 : null,
            next: 'The user presses "Weiter" to check out and pay; this tool never does.',
          };
        },
      },
    ]);
  }

  // One poll() pass; set up in boot(), also run by setScriptOff.
  let tick = () => {};

  (function boot() {
    if (!document.body) return setTimeout(boot, 200);
    tryMount();
    registerBookingTools();

    // The poll() loop below only ticks every 1.5s, and it's shared with
    // several unrelated concerns (card list, basket sync) that don't need
    // to react any faster than that. Reusing it for the ticket-type
    // selector meant up to 1.5s of pure waiting after its native
    // counterpart actually appeared before this script even noticed. Same
    // fast-then-slow idiom as initBrowse's .movies-grid polling further
    // down: check much more often at first, then stop once it has mounted
    // at least once (poll() below keeps calling it too, as a slower
    // fallback, in case it takes longer than this gives up on).
    let earlyMountTries = 0;
    const earlyMountPoll = setInterval(() => {
      if (!document.getElementById('uci-tickets')) mountTicketSelector();
      if (document.getElementById('uci-tickets') || ++earlyMountTries > 30) clearInterval(earlyMountPoll);
    }, 150);

    // Every step runs isolated, and the next tick is scheduled first.
    // Before 3.1.7 a single throw ended this loop for good. On iPhone that
    // happened on the very first tick (GM_getValue in
    // wirePaymentMethodMemory), so nothing after it ran again: no card list,
    // and "Warenkorb wird gelesen…" forever. Errors now show once in the
    // panel's log as well, since a phone has no console to check.
    const reported = new Set();
    const step = (name, fn) => {
      try { return fn(); } catch (err) {
        const msg = `${name}: ${(err && err.message) || err}`;
        if (reported.has(msg)) return;
        reported.add(msg);
        console.error(TAG, msg, err);
        ui.log('Interner Fehler — ' + msg, 'err');
      }
    };
    tick = () => {
      ensureOffToggle();
      if (scriptOff) return;
      step('mount', () => { if (!panel.isConnected) { mounted = false; tryMount(); } });
      step('tickets', mountTicketSelector);
      step('voucherHint', annotateEmptyVoucherPanel);
      step('stepHint', updateStepHint);
      step('paymentMethod', wirePaymentMethodMemory);
      step('expand', () => {
        ensureAlwaysExpanded('payment-type-uc-content');
        ensureAlwaysExpanded('init-checkout-and-payment-type-select-content');
      });
      step('extras', setupLeanPaymentExtras);
      step('checkoutButton', renameCheckoutButton);
      step('perfInfo', compactPerfInfo);
      step('stepBar', updateStepBar);
      step('legendPrices', annotateLegend);
      step('diag', () => {
        const d = `book:${getBook() ? 'ok' : '—'} bpid:${bpid() ? 'ok' : '—'} Seite:${pageAccess()} Speicher:${store.kind}`;
        ui.diag(d);
        panel.querySelector('#uci-diag').textContent = d;
      });
      const rebuilt = step('cards', renderList);
      if (!running) step('basket', () => {
        syncApplied();
        // A different seat count or an edited card list makes the previous
        // selection stale, so the defaults take over again.
        const b = basket();
        const limit = b ? b.open : null;
        if (rebuilt || limit !== lastLimit) {
          lastLimit = limit; userTouched = false; applyDefaults();
        } else if (!userTouched) {
          applyDefaults();
        }
        updateBasket();
      });
    };
    (function poll() {
      setTimeout(poll, 1500);
      tick();
    })();
  })();

  // Undoes, in place, everything this script changes on the booking page:
  // its stylesheet (layout, header, payment step), its own UI (card panel,
  // ticket picker, step hint, "leer" badge, Movie Points toggle), the
  // hidden native Unlimited Card form and the renamed checkout button.
  // poll() pauses meanwhile. Not undone: accordion sections it opened
  // stay open, and a payment method it pre-selected stays selected.
  // Switching back on runs one tick right away, which re-applies it all.
  function setScriptOff(off) {
    scriptOff = off;
    store.set(OFF_KEY, off);
    if (layoutStyle) layoutStyle.media = off ? 'not all' : '';
    if (off) {
      if (ticketObserver) ticketObserver.disconnect();
      panel.remove();
      mounted = false;
      if (cartObserver) { cartObserver.disconnect(); cartObserver = null; }
      ['uci-tickets', 'uci-step-hint', 'uci-secondary-toggle', 'uci-perf-info', 'uci-stepbar']
        .forEach((id) => document.getElementById(id)?.remove());
      document.querySelectorAll('.uci-legend-price').forEach((p) => p.remove());
      document.documentElement.classList.remove('uci-bar');
      document.querySelectorAll('.uci-bar-action').forEach((b) => b.classList.remove('uci-bar-action', 'uci-bar-action--muted'));
      ['--uci-sb-l', '--uci-sb-r'].forEach((v) => document.documentElement.style.removeProperty(v));
      document.querySelectorAll('.uci-secondary-card')
        .forEach((c) => c.classList.remove('uci-secondary-card', 'uci-secondary-hidden'));
      document.querySelectorAll('.uci-empty-badge').forEach((b) => {
        delete b.parentElement.dataset.uciAnnotated;
        b.remove();
      });
      restoreCheckoutButton();
      setNativeVisible(true);
    }
    tick();
  }

  // Centered and fixed rather than placed inside #uci-header's row: the
  // middle of the top bar is empty both in the merged header and in UCI's
  // own (logo left, account name right), and a fixed pill doesn't depend
  // on that row's markup. Its own always-on stylesheet, since the main one
  // is switched off with the script; min-height:0 against the site's
  // global button min-height:45px (see CLAUDE.md).
  function ensureOffToggle() {
    if (!document.body) return;
    let btn = document.getElementById('uci-off-toggle');
    if (!btn) {
      const style = document.createElement('style');
      style.textContent = `
        /* text-transform: the site's button CSS uppercased it ("BETTER-UCI:
           AN", seen live), which read like a main action, not a utility. */
        #uci-off-toggle{position:fixed;top:4px;left:50%;transform:translateX(-50%);z-index:2147483647;
          min-height:0 !important;height:auto;margin:0;padding:1px 8px;border-radius:10px;
          border:1px solid rgba(255,255,255,.14);background:transparent;color:#6b7684;
          font:500 10.5px/1.4 -apple-system,system-ui,sans-serif;letter-spacing:0;
          text-transform:none !important;cursor:pointer}
        #uci-off-toggle:hover{color:#cfd6e0;border-color:rgba(255,255,255,.35)}
        #uci-off-toggle.off{background:rgba(255,255,255,.92);color:#333;border-color:rgba(0,0,0,.25)}
        #uci-off-toggle:disabled{opacity:.5;cursor:default}`;
      document.head.appendChild(style);
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'uci-off-toggle';
      btn.onclick = () => { if (!running) setScriptOff(!scriptOff); };
      document.body.appendChild(btn);
    }
    const label = scriptOff ? 'better-uci: aus' : 'better-uci: an';
    if (btn.textContent !== label) btn.textContent = label;
    btn.classList.toggle('off', scriptOff);
    // Not mid-redemption: the panel showing that run's progress would vanish.
    btn.disabled = running && !scriptOff;
    btn.title = btn.disabled ? 'Während des Einlösens nicht möglich'
      : scriptOff ? 'Änderungen von better-uci wieder einschalten'
      : 'Alle Änderungen von better-uci auf dieser Seite ausschalten';
  }
  }

  function initBrowse() {
    const TAG = '[uci-browse]';
    console.log(TAG, 'loaded', location.href);

    // At true document-start, document.head may not exist yet — <html>
    // itself is the only thing guaranteed present almost immediately, so
    // this falls back to appending there rather than waiting on <head>.
    // Runs before mount() has had any chance to execute, and applies the
    // instant a matching element exists in the DOM — independent of JS
    // timing entirely, unlike the mount()-based hiding below. This is what
    // actually prevents the native page from flashing before our panel is
    // ready, rather than just reacting to it after the fact.
    (function hideEarly() {
      if (!document.documentElement) { setTimeout(hideEarly, 0); return; }
      const earlyStyle = document.createElement('style');
      // Off while html.ub-native is set ("Original-Ansicht zeigen"): with
      // !important, no inline style could bring the native page back.
      earlyStyle.textContent = `
        html:not(.ub-native) :is(.movies-grid, [data-schedule-filters-wrapper],
          .pimcore_area_keyvisual-kinowelt, .switch-tabs, #scheduleContainerVorverkauf)
          { display: none !important; }
        #uci-browse-loading{padding:60px 20px;text-align:center;color:#8b97a8;font-size:13px}
        .ub-spinner{width:32px;height:32px;margin:0 auto 12px;border:3px solid rgba(255,255,255,.15);
          border-top-color:#fff101;border-radius:50%;animation:ub-spin .8s linear infinite}
        @keyframes ub-spin{to{transform:rotate(360deg)}}`;
      (document.head || document.documentElement).appendChild(earlyStyle);
    })();

    // document.body doesn't exist yet at true document-start either, so
    // this is on its own separate retry rather than assuming hideEarly's
    // timing covers it too — <html> and <body> don't appear at the same
    // moment during parsing.
    let spinner, spinnerTimeout;
    (function showSpinner() {
      if (!document.body) { setTimeout(showSpinner, 0); return; }
      spinner = document.createElement('div');
      spinner.id = 'uci-browse-loading';
      spinner.innerHTML = '<div class="ub-spinner"></div>Lädt Kinoprogramm…';
      // This @match covers the whole www.uci-kinowelt.de domain, not just
      // kinoprogramm/coming-soon — most pages under it will never have
      // .movies-grid at all, so this needs a hard timeout or it would spin
      // forever on, say, the homepage or the shop.
      (document.querySelector('main') || document.body).prepend(spinner);
      spinnerTimeout = setTimeout(() => spinner.remove(), 5000);
    })();

    const PREF_KEY = 'uci_browse_prefs_v1';
    let prefs = { ovOnly: false, newOnly: false };
    // Not persisted like prefs — a stale search silently reapplying on a
    // later visit would be more confusing than useful.
    let searchQuery = '';
    // Mobile-only (see .ub-search-toggle CSS, hidden entirely on desktop):
    // the search field collapses to a magnifying-glass button so it
    // doesn't cost a permanent row of vertical space. Not persisted for
    // the same reason searchQuery isn't — but computed as open whenever
    // there's an active query, so switching tabs mid-search doesn't
    // re-collapse a filter that's still in effect.
    let searchOpen = false;

    // "+N weitere" toggles (Woche and Weitere rows) — which rows currently
    // show all their showtimes. Keyed by a tab-prefixed title rather than
    // a stable id (none exists); ephemeral like searchQuery/searchOpen,
    // not worth persisting across visits.
    let expandedFilms = new Set();

    function normalizeSearch(str) {
      return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    }
    function matchesQuery(title) {
      const q = searchQuery.trim();
      return !q || normalizeSearch(title).includes(normalizeSearch(q));
    }

    // Phone width — same 640px breakpoint as the CSS. Chip limits are
    // sized to what fits on one/two lines there (measured in a 386px
    // viewport: 4 week chips or 3 date chips per line), so render()
    // re-runs when the window crosses it.
    const narrowMQ = window.matchMedia('(max-width: 640px)');
    const isNarrow = () => narrowMQ.matches;

    try { prefs = Object.assign(prefs, JSON.parse(store.get(PREF_KEY, '{}'))); } catch {}
    const savePrefs = () => store.set(PREF_KEY, JSON.stringify(prefs));

    // Human labels for the attribute-* classes on each showtime badge.
    // Anything not listed falls back to a title-cased version of the raw
    // suffix, so an unfamiliar format (a new screen type) still shows up
    // instead of silently vanishing.
    const FORMAT_LABELS = {
      '2d': null,           // the overwhelming default — showing it adds noise
      '3d': '3D', '4dx': '4DX', isense: 'iSense', screenx: 'ScreenX',
      mxp: 'MXP', imax: 'IMAX', dbox: 'D-BOX', atmos: 'Dolby Atmos', laser: 'Laser',
    };
    const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    function ymd(d) {
      return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    }
    function dateLabel(d, offset) {
      if (offset === 0) return 'Heute';
      if (offset === 1) return 'Morgen';
      const wd = new Intl.DateTimeFormat('de-DE', { weekday: 'short' }).format(d);
      return `${wd} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
    }

    // -------------------------------------------------------------- parsing
    // A showtime link carries the performance and site ids in one of two
    // shapes. Until early October 2026 it was a path
    // (…/performanceId/<id>/siteId/<n>); since then UCI links straight to
    // the booking page (https://buchung.uci-kinowelt.de/?perf_id=<id>&site_id=<n>).
    // Only the old shape was matched, so every showtime was dropped, every
    // film with it, and the page said "Kein Programm gefunden". Both are
    // read, in case UCI switches back or serves the old markup from a cache.
    // /film/<slug>/<id>[/<cinema>/<n>] — the same id on the programme page
    // and on /coming-soon, which is how the two are joined (titles differ
    // between them, e.g. shortened).
    function filmIdOf(href) {
      const m = (href || '').match(/\/film\/[^/]+\/(\d+)/);
      return m ? m[1] : null;
    }

    function performanceIds(href) {
      const path = href.match(/performanceId\/([^/?#]+)\/siteId\/(\d+)/);
      if (path) return { perfId: path[1], siteId: path[2] };
      let url;
      try { url = new URL(href, location.href); } catch { return null; }
      const perfId = url.searchParams.get('perf_id') || url.searchParams.get('performanceId');
      const siteId = url.searchParams.get('site_id') || url.searchParams.get('siteId');
      return perfId && siteId ? { perfId, siteId } : null;
    }

    // Every film's full detail — poster, runtime, FSK, every showtime — is
    // already in the DOM at load, individually hidden behind its own
    // d-none wrapper. No network calls needed: just read it.
    function parseCard(card) {
      const titleEl = card.querySelector('.film-container__description__text__eventtitle a, .film-container__description__text__eventtitle');
      const title = titleEl ? titleEl.textContent.trim() : null;
      if (!title) return null;

      // The first item is either UCI's "Neu" label (an .event-label) or
      // "N. Spielwoche". "Neu" used to fall through into the genre, so the
      // meta line read "117min · Neu, Drama, …".
      let runtime = null, genre = null, isNew = false;
      card.querySelectorAll('.film-info li').forEach((li) => {
        const t = li.textContent.trim();
        if (/^\d+\s*min$/i.test(t)) runtime = t;
        else if (/^neu$/i.test(t)) isNew = true;
        else if (!/spielwoche/i.test(t) && t) genre = genre ? genre + ', ' + t : t;
      });

      const fskImg = card.querySelector('.age-rating-info__icon img');
      const fsk = fskImg ? (fskImg.getAttribute('alt') || '').replace('FSK ', '') : null;

      // Prefer the 200w carousel-size source over the full poster — this
      // list needs a lot of small thumbnails, not 78 full-size images.
      const smallSrc = card.querySelector('picture source[width="200"]');
      const posterImg = card.querySelector('picture img, .film-poster img');
      const poster = smallSrc
        ? smallSrc.getAttribute('srcset').split(' ')[0]
        : (posterImg ? posterImg.src : null);

      const showtimes = [...card.querySelectorAll('a.badge-performance[data-date]')].map((a) => {
        const ids = performanceIds(a.getAttribute('href') || '');
        if (!ids) return null;

        // The language shows up TWICE in the markup: once as an attribute-*
        // class (attribute-ov, attribute-omu…) and once as the visible
        // subtext span read below. Without excluding the class here, it
        // falls through the generic label fallback and produces a bogus
        // "format" (e.g. "Ov") that duplicates the real language tag.
        const LANG_ATTRS = new Set(['ov', 'omu', 'omeu', 'ome']);
        const formats = [...a.classList]
          .filter((c) => c.startsWith('attribute-') && c !== 'attribute')
          .map((c) => c.replace('attribute-', ''))
          .filter((raw) => !/^\d+$/.test(raw))          // numeric codes are internal, not a format
          .filter((raw) => !LANG_ATTRS.has(raw.toLowerCase()))
          .map((raw) => FORMAT_LABELS.hasOwnProperty(raw) ? FORMAT_LABELS[raw] : titleCase(raw))
          .filter(Boolean);

        const subtextEl = a.querySelector('.performance-badge__subtext');
        const lang = subtextEl ? subtextEl.textContent.trim() : null;   // null = standard dub
        const special = (a.dataset.special || '').trim();

        // The numeric attribute-* codes, kept raw: a few mean something to
        // us (see EVENT_CODES), most are unlabelled internal ones.
        const codes = [...a.classList]
          .filter((c) => /^attribute-\d+$/.test(c))
          .map((c) => c.slice('attribute-'.length));

        return {
          time: a.dataset.time, date: a.dataset.date,
          auditorium: a.dataset.trackingAuditorium || '',
          perfId: ids.perfId, siteId: ids.siteId,
          formats, lang, special, codes,
        };
      }).filter(Boolean);

      if (!showtimes.length) return null;
      // The native card's title links to the film's own page (trailer,
      // description) — kept so our poster+title can link there too.
      const filmLink = card.querySelector('.film-container__description__text__eventtitle a');
      const href = filmLink ? filmLink.getAttribute('href') : null;
      return { title, runtime, genre, fsk, poster, href, filmId: filmIdOf(href), isNew, showtimes };
    }

    // The native page can carry the same film in more than one container
    // (confirmed: ALWAYS LALISA appeared twice, in two sibling d-none
    // wrappers, with identical performanceIds) — which rendered as two
    // identical rows in "Weitere". Merged by title, the same key
    // expandedFilms/matchesQuery already treat as unique, with showtimes
    // deduped by perfId so a partial overlap still keeps every showing.
    function collectFilms(root) {
      const byTitle = new Map();
      [...(root || document).querySelectorAll('.film-container-wrapper')]
        .map(parseCard)
        .filter(Boolean)
        .forEach((film) => {
          const seen = byTitle.get(film.title);
          if (!seen) { byTitle.set(film.title, film); return; }
          const perfIds = new Set(seen.showtimes.map((s) => s.perfId));
          seen.showtimes.push(...film.showtimes.filter((s) => !perfIds.has(s.perfId)));
          if (!seen.poster) seen.poster = film.poster;
          if (!seen.href) seen.href = film.href;
          if (film.isNew) seen.isNew = true;
        });
      return [...byTitle.values()];
    }

    // New this week. UCI's "Neu" label covers a film's whole first week,
    // but also every film that hasn't started yet, months ahead (on
    // 2026-10-05 in Hamburg Mundsburg: 34 "Neu" films, 21 of them starting
    // after the 8-day window). So a film counts only if it's "Neu" and
    // plays within the window. German releases start on Thursdays: a film
    // whose first remaining showing comes before the next Thursday is in
    // its first week already ("Neu"), one starting later opens this week
    // ("Start 08.10."; the weekday only in the tooltip). The official start
    // from /coming-soon when known, so a preview doesn't pass for the
    // start; otherwise the earliest showing over all showtimes, ignoring
    // Nur OV, so the badge doesn't change with the filter.
    function freshness(film, days, start) {
      if (!film.isNew) return null;
      const first = start || film.showtimes.reduce((m, s) => (s.date < m ? s.date : m), '99999999');
      if (first > days[days.length - 1].str) return null;
      const today = new Date();
      const nextThu = new Date(today);
      nextThu.setDate(today.getDate() + ((4 - today.getDay() + 7) % 7 || 7));
      if (first < ymd(nextThu)) return { label: 'Neu', tip: 'Erste Spielwoche' };
      const d = new Date(+first.slice(0, 4), +first.slice(4, 6) - 1, +first.slice(6, 8));
      const date = `${first.slice(6, 8)}.${first.slice(4, 6)}.`;
      return { label: 'Start ' + date, tip: `Startet ${WEEKDAY.format(d)} ${date}`, upcoming: true };
    }

    // Showtime codes UCI labels (tooltips on its own attribute badges):
    // 289 "UCI Events" (concerts, Royal Ballet & Opera, live shows), 619
    // "Sonderveranstaltung" (also a live podcast that has no 289).
    const EVENT_CODES = new Set(['289', '619']);

    // Screening-level kinds: they describe one showing, not the film.
    // Measured on 2026-10-05 in Hamburg Mundsburg: Women's Night (60) on 3
    // of Der perfekte Urlaub's 104 showings, Midnight Movie (503, UCI's
    // badge text "Midnight Movie präsentiert") on 4 of Hope's 22, previews
    // on the dates before a film's official start. So they mark the chip;
    // only when every showing of a film has one does it become a film
    // badge and row edge too (A Quiet House: Midnight Movie 3 of 3).
    // In priority order: a chip with several gets the first one's color,
    // and labels in this order. Preview last: the 21.10. Women's Night is
    // also a preview, and "Women's" says more about it.
    const SCREENING_KINDS = [
      { kind: 'womens', chip: 'Women’s', badge: 'Women’s Night', tip: 'Women’s Night',
        test: (s) => s.codes.includes('60') },
      { kind: 'midnight', chip: 'Midnight', badge: 'Midnight Movie', tip: 'Midnight Movie präsentiert',
        test: (s) => s.codes.includes('503') },
      { kind: 'preview', chip: 'Preview', badge: 'Preview', tip: 'Vorstellung vor dem offiziellen Start',
        test: (s) => s.preview },
    ];

    // -------------------------------------------------------------- render
    const panel = document.createElement('div');
    panel.id = 'uci-browse';

    // One chip markup for every tab — only the visible label differs: the
    // time alone on a day tab, date + time in Weitere, weekday + time in
    // Woche (label may carry a .chip-day span; tip is the plain-text
    // version for the tooltip). A real href, not a click handler, so
    // Cmd/middle-click opens a booking in a new tab and chips are
    // keyboard-focusable. Every original-language showing (OV, OmU, OmeU
    // — the same set Nur OV keeps) gets .lang-orig, not just literal "OV".
    const bookingUrl = (s) =>
      `https://buchung.uci-kinowelt.de/?perf_id=${encodeURIComponent(s.perfId)}&site_id=${encodeURIComponent(s.siteId)}`;
    function chipMarkup(s, label, tip = label, extraClass = '') {
      const tags = [...s.formats];
      if (s.special) tags.push(s.special);
      // Screening kinds lead the sub-line: at 60px it truncates, and they
      // matter more than the format (was "iSense · Previe…" on a Women's
      // Night).
      const kinds = SCREENING_KINDS.filter((k) => s.kinds.includes(k.kind));
      const sub = [...kinds.map((k) => k.chip), s.lang, ...tags].filter(Boolean);
      const kindClass = kinds.length ? ' chip--' + kinds[0].kind : '';
      const premium = s.formats.length > 0;
      const href = bookingUrl(s);
      return `
        <a class="chip${premium ? ' premium' : ''}${isOriginalLanguage(s.lang) ? ' lang-orig' : ''}${kindClass}${extraClass}"
           href="${href}"
           title="${tip} · ${s.auditorium}${kinds.length ? ' · ' + kinds.map((k) => k.badge).join(', ') : ''}${s.lang ? ' · ' + s.lang : ''}${tags.length ? ' · ' + tags.join(', ') : ''}">
          <span class="chip-time">${label}</span>
          ${sub.length ? `<span class="chip-sub">${sub.join(' · ')}</span>` : ''}
        </a>`;
    }

    const chipHTML = (s) => chipMarkup(s, s.time);

    // For a row that spans several dates rather than one day — the time
    // alone is no longer enough to tell showings apart, so the date is
    // folded into the same label. Year is only spelled out when it isn't
    // the current one, and then as two digits ("28.3.27"), so even those
    // chips fit three to a line at phone width.
    function extraChipHTML(s, currentYear) {
      const dd = +s.date.slice(6, 8), mm = +s.date.slice(4, 6), yy = s.date.slice(0, 4);
      const dateLabel = (+yy === currentYear) ? `${dd}.${mm}.` : `${dd}.${mm}.${yy.slice(2)}`;
      return chipMarkup(s, `<span class="chip-day">${dateLabel}</span> ${s.time}`, `${dateLabel} ${s.time}`, ' chip--date');
    }

    // Woche chips: weekday + time ("Fr 20:10", "Sa 17:00") — deliberately
    // no "Heute"/"Morgen". Today and today+7 share a weekday, so the full
    // date goes into the tooltip to tell them apart on hover.
    const WEEKDAY = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
    function weekChipHTML(s) {
      const d = new Date(+s.date.slice(0, 4), +s.date.slice(4, 6) - 1, +s.date.slice(6, 8));
      const wd = WEEKDAY.format(d);
      return chipMarkup(s, `<span class="chip-day">${wd}</span> ${s.time}`,
        `${wd} ${s.time}, ${s.date.slice(6, 8)}.${s.date.slice(4, 6)}.`);
    }

    // "Nur OV" is meant as "not dubbed into German", not literally the
    // single "OV" label — OmU (subtitled) and OmeU (English-subtitled)
    // are original-language showings too, just with subtitles, so they
    // should pass the same filter even though the checkbox/label itself
    // still only says "Nur OV". Case-insensitive since this only needs to
    // match subtextEl's rendered text, not the attribute-* class spelling.
    function isOriginalLanguage(lang) {
      return !!lang && ['ov', 'omu', 'omeu'].includes(lang.toLowerCase());
    }

    // Single source of truth for "does this film have anything to show on
    // this date" — used by both rowHTML and the count/empty-tab logic in
    // render(), which previously ignored Nur OV and so overcounted.
    function showtimesOn(film, dateStr) {
      return film.showtimes
        .filter((s) => s.date === dateStr)
        .filter((s) => !prefs.ovOnly || isOriginalLanguage(s.lang));
    }

    // Title as a tooltip too — the compact row truncates with an ellipsis,
    // and some titles only differ at the end (two "BTS WORLD TOUR
    // 'ARIRANG' IN …" live viewings looked identical).
    function titleHTML(title) {
      return `<div class="film-title" title="${title.replace(/"/g, '&quot;')}">${title}</div>`;
    }
    // On their own line above the title, so they never eat into the
    // title's two clamped lines. Set per film in render() (Demnächst rows
    // carry none of these flags).
    function badgesHTML(f) {
      const badges = [];
      if (f.fresh) badges.push([f.fresh.upcoming ? 'start' : 'new', f.fresh.label, f.fresh.tip]);
      if (f.isEvent) badges.push(['event', 'Event', 'UCI Event / Sonderveranstaltung']);
      if (f.isSneak) badges.push(['preview', 'Sneak', 'Sneak Preview: Überraschungsfilm']);
      (f.allKinds || []).forEach((k) => badges.push([k.kind, k.badge, k.tip]));
      if (!badges.length) return '';
      return `<div class="ub-badges">${badges.map(([kind, label, tip]) =>
        `<span class="ub-badge ub-badge--${kind}" title="${tip}">${label}</span>`).join('')}</div>`;
    }
    // One colored edge per row, for film-level kinds only, the most
    // specific winning: Event (purple), a screening kind every showing has
    // (its own color), new this week (yellow). No yellow edge under Nur
    // neu: every row is new then, and a yellow edge on all of them only
    // adds noise. The badges stay.
    function rowAccent(film) {
      if (film.isEvent) return 'event';
      if (film.allKinds && film.allKinds.length) return film.allKinds[0].kind;
      if (film.fresh && !prefs.newOnly) return 'new';
      return null;
    }
    const rowClass = (film) => {
      const accent = rowAccent(film);
      return 'film-row' + (accent ? ' film-row--accent film-row--' + accent : '');
    };

    const filmMeta = (film) => [film.runtime, film.fsk ? 'FSK ' + film.fsk : null, film.genre].filter(Boolean).join(' · ');

    // Poster + title + meta, linked to the film's own page when known.
    // Shared by every row type. .ub-info, not .film-info: UCI's own
    // stylesheet styles .film-info (dark box, padding, rounded corners),
    // which leaked onto ours as an unintended box-in-a-box.
    function filmHeadHTML(f, meta) {
      const inner = `
          ${f.poster ? `<img class="film-thumb" src="${f.poster}" loading="lazy" alt="">` : '<div class="film-thumb film-thumb--empty"></div>'}
          <div class="ub-info">
            ${badgesHTML(f)}
            ${titleHTML(f.title)}
            <div class="film-meta">${meta}</div>
          </div>`;
      return f.href
        ? `<a class="ub-film-link" href="${f.href.replace(/"/g, '&quot;')}">${inner}</a>`
        : `<div class="ub-film-link">${inner}</div>`;
    }

    // Past this many, a row's chips are cut off behind a "+N weitere"
    // toggle — some far-future event runs carry 40+ dates, which turned a
    // single row in "Weitere" into a ~350px wall of chips.
    const extraChipLimit = () => (isNarrow() ? 6 : 12);   // phone: 2 lines of 3

    // Day tab row: just that day's showtimes. No "+N diese Woche" any
    // more — the Woche tab now covers "when else does this play?".
    function rowHTML(film, dateStr) {
      const shown = showtimesOn(film, dateStr)
        .sort((a, b) => a.time.localeCompare(b.time));
      if (!shown.length) return '';
      return `
        <div class="${rowClass(film)}">
          ${filmHeadHTML(film, filmMeta(film))}
          <div class="film-chips">${shown.map(chipHTML).join('')}</div>
        </div>`;
    }

    // One row per film, chips spanning every showtime in the given set
    // (which may cross several dates), sorted chronologically.
    function extraRowHTML(film, showtimes, sectionLabel) {
      const all = showtimes
        .filter((s) => !prefs.ovOnly || isOriginalLanguage(s.lang))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      if (!all.length) return '';
      const currentYear = new Date().getFullYear();

      // Same expandedFilms set and .ub-more-toggle handler as Woche, with a
      // section-scoped key so expanding a film in one horizon doesn't
      // expand it in another (or in Woche).
      const key = `extra:${sectionLabel}:${film.title}`;
      const expanded = expandedFilms.has(key);
      const limit = extraChipLimit();
      const overflow = all.length - limit;
      const shown = (overflow > 0 && !expanded) ? all.slice(0, limit) : all;
      const moreHTML = overflow > 0
        ? `<button type="button" class="ub-more-toggle" data-film="${key.replace(/"/g, '&quot;')}">
             ${expanded ? 'weniger' : '+' + overflow + ' weitere'}
           </button>`
        : '';
      return `
        <div class="${rowClass(film)}">
          ${filmHeadHTML(film, filmMeta(film))}
          <div class="film-chips">${shown.map((s) => extraChipHTML(s, currentYear)).join('')}${moreHTML}</div>
        </div>`;
    }

    // Woche — the default tab: every film with a showing anywhere in the
    // 8-day window, its next showings in time order (as many as fit on one
    // line) and the rest behind the same "+N weitere" toggle as Weitere,
    // so a whole week is visible without clicking through the day tabs.
    // How many fit comes from the measured width of a chips line, not a
    // fixed count per breakpoint. iPhones run from 375px to 440px wide, and
    // 4 pills plus "+N weitere" fit a 390px one (322px line, measured) but
    // not a 375px one, where the link would wrap onto a line of its own.
    // CHIP_W/CHIP_GAP must match the .chip/.film-chips CSS.
    const CHIP_W = 60, CHIP_GAP = 5;
    // "+N weitere" at 11px: 54.9px with one digit, 61.3px with two
    // (measured), plus 2px slack for font rendering differences.
    const moreLinkW = (n) => (n > 9 ? 64 : 57);
    let chipsLineW = 0;   // measured after each render()
    // Before the first measurement: the line widths measured at 390px and
    // at desktop width.
    const lineW = () => chipsLineW || (isNarrow() ? 322 : 644);
    const fitsLine = (n, more) =>
      n * CHIP_W + (n - 1) * CHIP_GAP + (more ? CHIP_GAP + moreLinkW(more) : 0) <= lineW();
    function weekChipLimit(total) {
      if (fitsLine(total, 0)) return total;
      let n = 1;
      while (n + 1 < total && fitsLine(n + 1, total - n - 1)) n++;
      return n;
    }

    function weekShowtimes(film, days) {
      const now = new Date();
      const nowHM = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      return days.flatMap((d) => showtimesOn(film, d.str))
        // Already-started showings from today are useless here even if
        // the native page still lists them.
        .filter((s) => !(s.date === days[0].str && s.time < nowHM))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    }

    function weekRowHTML(film, days) {
      const all = weekShowtimes(film, days);
      if (!all.length) return '';
      const key = `woche:${film.title}`;
      const expanded = expandedFilms.has(key);
      const limit = weekChipLimit(all.length);
      const overflow = all.length - limit;
      const shown = (overflow > 0 && !expanded) ? all.slice(0, limit) : all;
      const moreHTML = overflow > 0
        ? `<button type="button" class="ub-more-toggle" data-film="${key.replace(/"/g, '&quot;')}">
             ${expanded ? 'weniger' : '+' + overflow + ' weitere'}
           </button>`
        : '';
      return `
        <div class="${rowClass(film)}">
          ${filmHeadHTML(film, filmMeta(film))}
          <div class="film-chips">${shown.map(weekChipHTML).join('')}${moreHTML}</div>
        </div>`;
    }

    // "Weitere" used to be one collapsible section per exact date, which
    // turned into a very long scroll once far-future pre-sale events
    // (sometimes a year-plus out) were involved, and split any film with
    // several upcoming dates into a separate row under each one. Grouping
    // by three coarse time horizons instead — with one row per film,
    // showing all its dates as chips — keeps the outline short regardless
    // of how far out the data goes, and keeps a film's whole run together.
    function extraDatesHTML(films, knownDates) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const in30Days = new Date(today); in30Days.setDate(in30Days.getDate() + 30);
      const yearEnd = new Date(today.getFullYear(), 11, 31);
      const parseYmd = (str) => new Date(+str.slice(0, 4), +str.slice(4, 6) - 1, +str.slice(6, 8));

      const buckets = { next30: [], thisYear: [], beyond: [] };
      films.forEach((f) => {
        const extra = f.showtimes.filter((s) => !knownDates.has(s.date));
        if (!extra.length) return;
        const split = { next30: [], thisYear: [], beyond: [] };
        extra.forEach((s) => {
          const d = parseYmd(s.date);
          if (d < in30Days) split.next30.push(s);
          else if (d <= yearEnd) split.thisYear.push(s);
          else split.beyond.push(s);
        });
        if (split.next30.length) buckets.next30.push({ film: f, showtimes: split.next30 });
        if (split.thisYear.length) buckets.thisYear.push({ film: f, showtimes: split.thisYear });
        if (split.beyond.length) buckets.beyond.push({ film: f, showtimes: split.beyond });
      });

      const sections = [
        { label: 'Nächste 30 Tage', items: buckets.next30 },
        { label: 'Später dieses Jahr', items: buckets.thisYear },
        { label: 'Nächstes Jahr und später', items: buckets.beyond },
      ];

      const query = searchQuery.trim();
      let firstOpen = true;
      return sections.map((sec) => {
        if (!sec.items.length) return '';
        // Counted from rendered rows, not sec.items — Nur OV can drop a
        // film from a section entirely, and the header shouldn't count it.
        const rowList = sec.items.map(({ film, showtimes }) => extraRowHTML(film, showtimes, sec.label)).filter(Boolean);
        if (!rowList.length) return '';
        const rows = rowList.join('');
        const open = query ? true : firstOpen;
        if (!query) firstOpen = false;
        return `<details class="extra-date-group"${open ? ' open' : ''}>
          <summary class="extra-date-head">${sec.label}
            <span class="extra-date-count">${rowList.length} Film${rowList.length === 1 ? '' : 'e'}</span>
          </summary>
          ${rows}
        </details>`;
      }).join('');
    }

    // /coming-soon uses a completely different template than the main
    // page — .film-card, not .film-container-wrapper — with no individual
    // showtimes at all: just a poster, a title, and either a bookable link
    // or a disabled one showing a release date. There's nothing here to
    // build clickable time chips from; this reads what's actually present.
    function parseComingSoonCard(card) {
      const titleLink = card.querySelector('.film-card__content .title a');
      const title = titleLink ? titleLink.textContent.trim() : null;
      if (!title) return null;

      // DOMParser-created documents don't reliably resolve relative URLs
      // against the real site (their base URI isn't the fetched page), so
      // .src/.href would silently point at the wrong place or break
      // outright. Reading the raw attribute and resolving it explicitly
      // avoids depending on that.
      const resolve = (raw) => raw ? new URL(raw, 'https://www.uci-kinowelt.de/').href : null;
      const href = resolve(titleLink.getAttribute('href'));

      const img = card.querySelector('.film-card__picture img');
      const poster = img ? resolve(img.getAttribute('src')) : null;

      const dateEl = card.querySelector('.performance-date');
      const dateLabel = dateEl ? dateEl.textContent.trim() : null;   // "DD.MM.YYYY" or absent
      const dateSort = dateLabel ? dateLabel.split('.').reverse().join('') : '00000000';

      const bookBtn = card.querySelector('.interaction-area .badge-performance');
      const bookable = !!bookBtn && !bookBtn.classList.contains('disabled');

      return { title, href, filmId: filmIdOf(href), poster, dateLabel, dateSort, bookable };
    }

    function collectComingSoon(doc) {
      return [...doc.querySelectorAll('.film-card')]
        .map(parseComingSoonCard)
        .filter(Boolean)
        .sort((a, b) => a.dateSort.localeCompare(b.dateSort));
    }

    // The whole row used to be one <a>, which is why the text came out
    // yellow — UCI's own stylesheet colors bare <a> tags gold, and nothing
    // here declared its own color, so it inherited that. Only the
    // poster+title needs to be a link; keeping the row itself a plain div
    // fixes the color at its source rather than overriding it after the
    // fact. The action slot is either a real "Buchen" button (bookable) or
    // a muted, clearly non-interactive date badge — not the same style
    // wearing different text.
    function comingSoonRowHTML(f) {
      const dateText = f.dateLabel ? `Ab ${f.dateLabel}` : 'Bereits im Kino';
      const action = f.bookable
        ? `<a class="cs-buy-btn" href="${f.href}">Buchen</a>`
        : `<span class="cs-buy-btn cs-buy-btn--disabled">Buchen</span>`;
      return `
        <div class="film-row cs-row">
          ${filmHeadHTML(f, dateText)}
          <div class="film-chips">${action}</div>
        </div>`;
    }

    let demnaechstState = 'idle';   // idle | loading | loaded | error
    let demnaechstFilms = [];

    async function loadDemnaechst() {
      demnaechstState = 'loading';
      render();
      try {
        // UCI's server answers /coming-soon with an intermittent 502/503
        // "Störung" page (seen 2026-10-05: one failure, then 200 on the very
        // next request), so a failed load is retried a couple of times.
        let res;
        for (let attempt = 0; ; attempt++) {
          res = await fetch('/coming-soon');
          if (res.ok || attempt >= 2) break;
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        demnaechstFilms = collectComingSoon(doc);
        demnaechstState = 'loaded';
        console.log(TAG, 'Demnächst geladen:', demnaechstFilms.length, 'Ankündigungen');
      } catch (err) {
        demnaechstState = 'error';
        console.warn(TAG, 'Demnächst-Fetch fehlgeschlagen:', err.message);
      }
      render();
    }

    function demnaechstBodyHTML() {
      if (demnaechstState === 'loading' || demnaechstState === 'idle')
        return '<div class="ub-empty">Lädt…</div>';
      if (demnaechstState === 'error')
        return '<div class="ub-empty">Konnte /coming-soon nicht laden.<br><a href="/coming-soon">Seite direkt öffnen</a></div>';
      if (!demnaechstFilms.length)
        return '<div class="ub-empty">Keine Ankündigungen gefunden.<br><a href="/coming-soon">Seite direkt öffnen</a></div>';
      const visible = demnaechstFilms.filter((f) => matchesQuery(f.title));
      if (!visible.length)
        return `<div class="ub-empty">Keine Treffer für „${searchQuery.trim()}“.</div>`;
      return visible.map(comingSoonRowHTML).join('');
    }

    // The programme as render() shows it: films sorted, each showing's
    // kinds and each film's badges worked out, plus the 8-day window. Also
    // what the WebMCP tools read.
    function programme() {
      const films = collectFilms();
      films.sort((a, b) => a.title.localeCompare(b.title, 'de'));

      const today = new Date();
      const days = [...Array(8)].map((_, i) => {
        const d = new Date(today); d.setDate(d.getDate() + i);
        return { str: ymd(d), label: dateLabel(d, i) };
      });
      // Official start dates from /coming-soon (prefetched on mount). Until
      // that arrives, or if it fails, there are just no Preview badges.
      const starts = new Map(demnaechstFilms
        .filter((c) => c.filmId && c.dateLabel)
        .map((c) => [c.filmId, c.dateSort]));
      films.forEach((f) => {
        const start = starts.get(f.filmId);
        f.showtimes.forEach((s) => {
          s.preview = !!start && s.date < start;
          s.kinds = SCREENING_KINDS.filter((k) => k.test(s)).map((k) => k.kind);
        });
        // Over all showtimes, not just the shown ones, so a film's badge
        // doesn't change with the tab or Nur OV.
        f.allKinds = SCREENING_KINDS.filter((k) => f.showtimes.every((s) => s.kinds.includes(k.kind)));
        f.isSneak = /überraschungspremiere|sneak/i.test(f.title);
        f.isEvent = f.showtimes.some((s) => s.codes.some((c) => EVENT_CODES.has(c)));
        // Events and the Sneak are "Neu" by nature; NEU on top is noise.
        f.fresh = f.isEvent || f.isSneak ? null : freshness(f, days, start);
      });
      return { films, days };
    }

    function render() {
      const { films, days } = programme();
      if (!films.length) { panel.innerHTML = '<div class="ub-empty">Kein Programm gefunden.</div>'; return; }
      const visibleFilms = films.filter((f) => matchesQuery(f.title) && (!prefs.newOnly || f.fresh));
      const knownDates = new Set(days.map((d) => d.str));

      if (!panel.dataset.selected) panel.dataset.selected = 'woche';
      const sel = panel.dataset.selected;

      const extraHTML = extraDatesHTML(visibleFilms, knownDates);
      // Whether the Weitere tab exists at all is decided from the full,
      // unfiltered programme — not from extraHTML, which is search- and
      // OV-filtered. Otherwise typing a query with no far-future match
      // removed the tab mid-search, shifting Demnächst left under the
      // cursor (confirmed: a click aimed at Weitere opened Demnächst).
      const hasExtra = films.some((f) => f.showtimes.some((s) => !knownDates.has(s.date)));
      // Dimmed, not hidden or disabled: the last day or two of the window
      // is often still unpublished, and a tab that's visibly empty saves a
      // pointless click without making the tab bar shift around. Ignores
      // the search query on purpose so tabs don't flicker while typing.
      const emptyDays = new Set(days.map((d) => d.str)
        .filter((str) => !films.some((f) => showtimesOn(f, str).length)));
      const tabsHTML = `<button class="ub-tab${sel === 'woche' ? ' active' : ''}" data-date="woche">Woche</button>`
        + days.map((d) =>
        `<button class="ub-tab${d.str === sel ? ' active' : ''}${emptyDays.has(d.str) ? ' ub-tab--empty' : ''}" data-date="${d.str}"${emptyDays.has(d.str) ? ' title="Noch keine Vorstellungen"' : ''}>${d.label}</button>`
      ).join('')
        + (hasExtra ? `<button class="ub-tab${sel === 'extra' ? ' active' : ''}" data-date="extra">Weitere</button>` : '')
        + `<button class="ub-tab${sel === 'demnaechst' ? ' active' : ''}" data-date="demnaechst">Demnächst</button>`;

      const body = sel === 'woche' ? visibleFilms.map((f) => weekRowHTML(f, days)).filter(Boolean).join('')
        : sel === 'extra' ? extraHTML
        : sel === 'demnaechst' ? demnaechstBodyHTML()
        : visibleFilms.map((f) => rowHTML(f, sel)).filter(Boolean).join('');

      const shownCount = (sel === 'extra' || sel === 'demnaechst') ? null
        : sel === 'woche' ? visibleFilms.filter((f) => weekShowtimes(f, days).length).length
        : visibleFilms.filter((f) => showtimesOn(f, sel).length).length;

      const query = searchQuery.trim();
      const emptyMsg = query
        ? `Keine Treffer für „${query}“.`
        : (prefs.newOnly
          ? 'Keine neuen Filme' + (sel === 'extra' ? ' mit weiteren Vorstellungen'
            : sel === 'woche' ? ' diese Woche' : ' an diesem Tag')
          : sel === 'extra' ? 'Keine weiteren Vorstellungen'
          : sel === 'woche' ? 'Keine Vorstellungen diese Woche'
          : 'Keine Vorstellungen an diesem Tag')
          + (prefs.ovOnly ? ' in OV' : '') + '.';

      // A full innerHTML rebuild on every keystroke would otherwise kick
      // focus out of the search field after the first character typed —
      // capture position before rebuilding, restore it after.
      const searchHadFocus = document.activeElement && document.activeElement.id === 'ub-search';
      // Phone tab bar is one horizontally scrolling row (see CSS); the
      // rebuild below would reset it to the start on every click.
      const tabsScroll = panel.querySelector('.ub-tabs')?.scrollLeft || 0;
      const searchSelStart = searchHadFocus ? document.activeElement.selectionStart : null;
      const searchSelEnd = searchHadFocus ? document.activeElement.selectionEnd : null;

      panel.innerHTML = `
        <div class="ub-bar">
          <div class="ub-tabs">${tabsHTML}</div>
          <div class="ub-toggles">
            <label class="ub-ov"><input type="checkbox" id="ub-ovonly" ${prefs.ovOnly ? 'checked' : ''}> Nur OV</label>
            <label class="ub-ov"><input type="checkbox" id="ub-newonly" ${prefs.newOnly ? 'checked' : ''}> Nur neu</label>
          </div>
          <button type="button" class="ub-search-toggle" id="ub-search-toggle" aria-label="Suche öffnen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
        </div>
        <div class="ub-search-row">
          <input type="search" id="ub-search" placeholder="Film suchen…" value="${searchQuery.replace(/"/g, '&quot;')}">
          <button type="button" class="ub-search-close" id="ub-search-close" aria-label="Suche löschen" title="Suche löschen">✕</button>
        </div>
        ${shownCount !== null ? `<div class="ub-count">${shownCount} Film${shownCount === 1 ? '' : 'e'}</div>` : ''}
        <div class="ub-list">${body || `<div class="ub-empty">${emptyMsg}</div>`}</div>
        <div class="ub-foot"><span id="ub-native-toggle">Original-Ansicht zeigen</span></div>`;
      // Lives on the panel itself, not on
      // .ub-search-row — the trigger button now sits in .ub-bar, a sibling
      // of that row rather than a descendant, so a class scoped to the row
      // alone couldn't reach it.
      panel.classList.toggle('ub-search-open', searchOpen || !!searchQuery.trim());
      // Drives the desktop ✕ (see CSS) — Chrome's own type=search cancel
      // button is hidden because it only fires when the field already has
      // focus at mousedown, and every render() replaces the input with an
      // unfocused one: confirmed via event logging, a first click on it
      // produced mousedown/mouseup/click and no input event at all.
      panel.classList.toggle('ub-has-query', !!searchQuery);

      const tabStrip = panel.querySelector('.ub-tabs');
      tabStrip.scrollLeft = tabsScroll;
      // Keep the selected tab in view (e.g. Demnächst, at the far end).
      // Manual math, not scrollIntoView(), which would also scroll the page.
      const activeTab = tabStrip.querySelector('.ub-tab.active');
      if (activeTab && tabStrip.scrollWidth > tabStrip.clientWidth) {
        const l = activeTab.offsetLeft - tabStrip.offsetLeft, r = l + activeTab.offsetWidth;
        if (l < tabStrip.scrollLeft) tabStrip.scrollLeft = l - 8;
        else if (r > tabStrip.scrollLeft + tabStrip.clientWidth) tabStrip.scrollLeft = r - tabStrip.clientWidth + 8;
      }

      panel.querySelectorAll('.ub-tab').forEach((b) => {
        b.onclick = () => {
          panel.dataset.selected = b.dataset.date;
          if (b.dataset.date === 'demnaechst' && demnaechstState === 'idle') loadDemnaechst();
          else render();
        };
      });
      panel.querySelector('#ub-ovonly').onchange = (e) => { prefs.ovOnly = e.target.checked; savePrefs(); render(); };
      panel.querySelector('#ub-newonly').onchange = (e) => { prefs.newOnly = e.target.checked; savePrefs(); render(); };
      panel.querySelector('#ub-search').oninput = (e) => { searchQuery = e.target.value; render(); };
      // The toggle is mobile-only (display:none above 640px); the close
      // button doubles as the desktop clear ✕ whenever there's a query
      // (see .ub-has-query in CSS). Both wired unconditionally rather than
      // gated on viewport width, so nothing goes stale if a window gets
      // resized after mount.
      panel.querySelector('#ub-search-toggle').onclick = () => {
        searchOpen = true; render();
        panel.querySelector('#ub-search').focus();
      };
      panel.querySelector('#ub-search-close').onclick = () => {
        // Clears the query too, not just the open flag — otherwise the
        // "open whenever there's an active query" rule above would
        // immediately re-open it, and the ✕ would visibly do nothing.
        searchOpen = false; searchQuery = ''; render();
      };
      if (searchHadFocus) {
        const el = panel.querySelector('#ub-search');
        el.focus();
        el.setSelectionRange(searchSelStart, searchSelEnd);
      }
      panel.querySelectorAll('.ub-more-toggle').forEach((b) => {
        b.onclick = () => {
          const title = b.dataset.film;
          if (expandedFilms.has(title)) expandedFilms.delete(title);
          else expandedFilms.add(title);
          render();
        };
      });
      const nt = panel.querySelector('#ub-native-toggle');
      if (nt) nt.onclick = () => setNativeVisible(true);

      // Re-measure the chips line (see weekChipLimit). If this render went
      // by a guess or a stale width (first render, rotation, resize),
      // render once more with the real one. Only once, so a width that
      // changes again in response (e.g. a scrollbar appearing) can't loop.
      const line = panel.querySelector('.film-row:not(.cs-row) .film-chips');
      const w = line ? line.getBoundingClientRect().width : 0;
      if (w && Math.abs(w - chipsLineW) > 0.5 && !remeasured) {
        chipsLineW = w;
        remeasured = true;
        render();
        remeasured = false;
      }
    }
    let remeasured = false;

    // "Original-Ansicht zeigen" used to clear only the grid's inline style,
    // which the !important early CSS still overrode, and enforceHidden()
    // re-hid it within a second anyway, so the button did nothing visible.
    // Now the html.ub-native class switches off the early CSS, the
    // matching rules in STYLE and enforceHidden(), and every element we
    // hid is shown again.
    const nativeShown = () => document.documentElement.classList.contains('ub-native');
    function setNativeVisible(on) {
      document.documentElement.classList.toggle('ub-native', on);
      if (on) {
        [document.querySelector('.movies-grid'),
          document.getElementById('scheduleContainerVorverkauf'),
          document.querySelector('[data-schedule-filters-wrapper]'),
          ...nativeHiddenEls].forEach((el) => { if (el) el.style.display = ''; });
      } else {
        enforceHidden();
        nativeHiddenEls.forEach((el) => { el.style.display = 'none'; });
      }
      panel.style.display = on ? 'none' : '';
      if (on) {
        const back = document.createElement('button');
        back.id = 'uci-browse-back';
        back.textContent = '← Zur modernen Ansicht';
        back.onclick = () => { back.remove(); setNativeVisible(false); };
        document.body.appendChild(back);
      } else {
        document.getElementById('uci-browse-back')?.remove();
      }
    }

    const STYLE = `
      #uci-browse{max-width:960px;margin:0 auto;font-size:14px;line-height:1.45;
        color:#fff;background:#10141c;border-radius:10px;padding:14px;
        box-shadow:0 2px 14px rgba(0,0,0,.25)}
      #uci-browse .ub-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
        border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:10px;margin-bottom:8px}
      #uci-browse .ub-tabs{display:flex;gap:4px;flex-wrap:wrap;flex:1}
      /* 8px side padding, not 10: with the Woche tab added, 10px pushed
         the 11 tabs to 814px, past the room left beside the checkbox(es)
         in the 960px panel, wrapping Demnächst onto a 2nd row. */
      #uci-browse .ub-tab{background:rgba(255,255,255,.06);border:1px solid transparent;
        color:#cfd6e0;border-radius:6px;padding:5px 8px;font-size:12.5px;cursor:pointer}
      #uci-browse .ub-tab:hover{background:rgba(255,255,255,.12)}
      #uci-browse .ub-tab.active{background:#fff101;color:#000;font-weight:700}
      #uci-browse .ub-tab--empty:not(.active){color:#5c6673;background:rgba(255,255,255,.03)}
      #uci-browse .ub-ov{display:flex;align-items:center;gap:6px;font-size:12.5px;
        color:#cfd6e0;white-space:nowrap;accent-color:#fff101}
      /* Stacked on desktop: side by side, a second checkbox pushed the tab
         row past the panel width (see .ub-tab padding above). */
      #uci-browse .ub-toggles{display:flex;flex-direction:column;gap:2px}
      @media (max-width: 640px) {
        #uci-browse .ub-toggles{flex-direction:row;gap:14px}
      }

      /* Confirmed via a real screenshot: below this width the two .ub-ov
         checkboxes don't wrap onto their own clean line — they land
         wherever .ub-tabs' own internal wrapping happened to leave
         leftover space that row, i.e. visually stuck mid-grid next to
         whichever date tabs half-filled a line. */
      @media (max-width: 640px) {
        /* .ub-tabs is a single flex item in .ub-bar (it does its own
           wrapping internally) — forcing it to claim a full line itself
           means whatever comes after it in the flex-wrap flow starts
           fresh on the next line instead of sharing a row with it. */
        #uci-browse .ub-tabs { flex: 1 1 100%; }
        /* One swipeable row instead of three wrapped ones (measured: the
           11 tabs took 3 rows / 149px before the first film at 386px). */
        #uci-browse .ub-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none;
          -webkit-overflow-scrolling: touch; margin: 0 -14px; padding: 0 14px; }
        #uci-browse .ub-tabs::-webkit-scrollbar { display: none; }
        #uci-browse .ub-tab { flex: 0 0 auto; white-space: nowrap; }
      }

      #uci-browse .ub-search-row{margin-bottom:8px;display:flex;align-items:center;gap:8px}
      #uci-browse #ub-search{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);
        border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#fff;font-size:13px;
        padding:7px 10px}
      #uci-browse #ub-search::placeholder{color:#6b7684}
      #uci-browse #ub-search:focus{outline:none;border-color:rgba(255,241,1,.5)}
      /* Native cancel button replaced by .ub-search-close — see the
         .ub-has-query toggle in render() for why it never worked here. */
      #uci-browse #ub-search::-webkit-search-cancel-button{-webkit-appearance:none;display:none}
      /* Hidden by default — desktop keeps the plain always-visible input
         with no icon and nothing to toggle; the ✕ only appears once
         there's something to clear. */
      #uci-browse .ub-search-toggle,#uci-browse .ub-search-close{display:none}
      #uci-browse .ub-search-close{align-items:center;justify-content:center;flex:0 0 auto;
        background:none;border:none;color:#8b97a8;font-size:15px;cursor:pointer;
        padding:4px 6px;min-height:0}
      #uci-browse .ub-search-close:hover{color:#fff}
      #uci-browse.ub-has-query .ub-search-close{display:flex}

      /* A permanent search row costs a full line of vertical space that
         matters more on a short phone screen than on desktop — collapsed
         to a single icon button (next to Nur OV, in .ub-bar) until
         tapped, matching the same 640px breakpoint used for the tab bar/
         film-row changes above. */
      @media (max-width: 640px) {
        #uci-browse .ub-search-toggle{
          display:flex;align-items:center;justify-content:center;flex:0 0 auto;
          width:30px;height:30px;background:rgba(255,255,255,.06);color:#cfd6e0;
          border:1px solid rgba(255,255,255,.14);border-radius:6px;
          cursor:pointer;min-height:0}
        #uci-browse .ub-search-toggle:hover{background:rgba(255,255,255,.12)}
        #uci-browse .ub-search-toggle svg{width:15px;height:15px}
        #uci-browse .ub-search-row{display:none}
        #uci-browse #ub-search{flex:1 1 auto;min-width:0}
        #uci-browse .ub-search-close{display:flex}
        /* Set on the panel itself, not the row — see render(). Whenever
           it's open, hide the trigger (it lives in .ub-bar, a sibling of
           .ub-search-row, so this can't be a plain descendant rule off
           the row) and reveal the row it points at. */
        #uci-browse.ub-search-open .ub-search-toggle{display:none}
        #uci-browse.ub-search-open .ub-search-row{display:flex}
      }
      #uci-browse .ub-count{font-size:11.5px;color:#8b97a8;margin-bottom:6px}
      #uci-browse .ub-list{display:flex;flex-direction:column}
      /* Top-aligned, not centered: expanding "+N weitere" grows the chips
         downward, and a centered row slid the poster/title down with it.
         .film-chips' min-height (= the compact thumb) + align-content
         keeps a single chip line centered on the poster exactly as before. */
      #uci-browse .film-row{display:flex;align-items:flex-start;gap:12px;padding:8px 2px;
        border-bottom:1px solid rgba(255,255,255,.07)}
      #uci-browse .film-row:hover{background:rgba(255,255,255,.03)}
      #uci-browse .film-thumb{width:40px;height:57px;object-fit:cover;border-radius:4px;flex:0 0 auto;
        background:rgba(255,255,255,.08)}
      /* Poster+title block — a link to the film's page where one exists.
         Text centered on the poster; underline on hover is the only cue,
         so the row doesn't gain another visual element. */
      #uci-browse .ub-film-link{display:flex;align-items:center;gap:12px;flex:0 0 auto;
        min-width:0;color:inherit;text-decoration:none}
      #uci-browse a.ub-film-link:hover .film-title{text-decoration:underline}
      #uci-browse .ub-info{flex:0 0 auto;width:220px;min-width:0}
      /* Two lines, then ellipsis — a single nowrap line made titles that
         only differ at the end ("BTS WORLD TOUR 'ARIRANG' IN BUENOS AIRES"
         vs "… IN SÃO PAULO") render identically. Two lines still fit
         beside the 57px compact thumbnail along with .film-meta. */
      #uci-browse .film-title{font-weight:600;font-size:13.5px;line-height:1.3;
        overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
      /* Colored row edge (see rowAccent()): yellow for new this week,
         purple for events, and a screening kind's own color (Preview blue,
         Midnight Movie red, Women's Night pink), each with a faint tint
         of the same color. The edge sits in the panel's own 14px side
         padding (::before, not a border or row padding): inside the row it
         pushed that row's poster and chips 7px right of every other row. */
      #uci-browse .film-row.film-row--accent{position:relative;--accent:255,241,1;
        background:rgba(var(--accent),.035)}
      #uci-browse .film-row.film-row--event{--accent:180,120,230}
      #uci-browse .film-row.film-row--preview{--accent:79,157,222}
      #uci-browse .film-row.film-row--midnight{--accent:230,70,70}
      #uci-browse .film-row.film-row--womens{--accent:235,110,170}
      #uci-browse .film-row.film-row--accent::before{content:'';position:absolute;left:-8px;
        top:6px;bottom:6px;width:3px;border-radius:2px;background:rgb(var(--accent))}
      #uci-browse .film-row.film-row--accent:hover{background:rgba(var(--accent),.07)}
      #uci-browse .ub-badges{display:flex;flex-wrap:wrap;gap:4px;line-height:1;margin-bottom:3px}
      #uci-browse .ub-badge{display:inline-block;padding:1px 5px;border-radius:3px;border:1px solid;
        font-size:9.5px;font-weight:700;line-height:1.3;letter-spacing:.03em;text-transform:uppercase}
      #uci-browse .ub-badge--new{background:#fff101;color:#000;border-color:#fff101}
      #uci-browse .ub-badge--start{color:#fff101;border-color:rgba(255,241,1,.6)}
      /* Preview and Sneak: blue, like the OV chips. Event: purple.
         Midnight Movie: red. Women's Night: pink, as on UCI's own badge. */
      #uci-browse .ub-badge--preview{background:rgba(79,157,222,.18);color:#8fc4f0;border-color:rgba(79,157,222,.6)}
      #uci-browse .ub-badge--event{background:rgba(180,120,230,.16);color:#d3b2f2;border-color:rgba(180,120,230,.55)}
      #uci-browse .ub-badge--midnight{background:rgba(230,70,70,.16);color:#f2a3a3;border-color:rgba(230,70,70,.6)}
      #uci-browse .ub-badge--womens{background:rgba(235,110,170,.16);color:#f5b3d3;border-color:rgba(235,110,170,.6)}
      #uci-browse .film-meta{font-size:11px;color:#8b97a8;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis}
      #uci-browse .film-chips{display:flex;flex-wrap:wrap;gap:5px;flex:1;
        min-height:57px;align-items:center;align-content:center}

      /* Fixed size, not content-sized: every chip reserves the second
         (lang/format) line and shares one width, so a row reads as an even
         grid instead of "OmU · IMAX" chips towering over bare times.
         60px is the smallest that still fits every label at these fonts
         (measured in a 390px viewport: "Sa 22:00" 49px, "OV · ScreenX"
         52px of a 52px content box), so a 390px iPhone fits 4 pills plus
         "+N weitere" per line (was 3 at 76x38). width and the 5px gap are
         mirrored in CHIP_W/CHIP_GAP (weekChipLimit). Weitere's date chips
         need 78px ("28.3.27 17:00"), hence their own wider .chip--date.
         Anything longer ellipsizes — the full text is in the tooltip. */
      #uci-browse .chip{display:flex;flex-direction:column;align-items:center;justify-content:center;
        box-sizing:border-box;width:60px;min-height:34px;overflow:hidden;
        padding:3px;border-radius:6px;background:rgba(255,255,255,.08);
        border:1px solid rgba(255,255,255,.12);text-decoration:none;cursor:pointer;line-height:1.25}
      #uci-browse .chip:hover{background:rgba(255,255,255,.16)}
      #uci-browse .chip.chip--date{width:80px}
      #uci-browse .chip-time,#uci-browse .chip-sub{max-width:100%;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis}
      #uci-browse .chip-time{font-size:11.5px;font-weight:700;color:#fff}
      #uci-browse .chip-sub{font-size:9px;color:#a9b4c2}
      #uci-browse .chip.premium{border-color:rgba(255,241,1,.5)}
      #uci-browse .chip.lang-orig{background:rgba(79,157,222,.16);border-color:rgba(79,157,222,.4)}
      #uci-browse .chip.lang-orig .chip-sub{color:#8fc4f0}
      /* Screening kinds (SCREENING_KINDS): the chip's border in the kind's
         color, after .premium/.lang-orig so it wins over theirs. */
      #uci-browse .chip.chip--preview{border-color:rgba(79,157,222,.9)}
      #uci-browse .chip.chip--midnight{border-color:rgba(230,70,70,.85)}
      #uci-browse .chip.chip--midnight .chip-sub{color:#f2a3a3}
      #uci-browse .chip.chip--womens{border-color:rgba(235,110,170,.85)}
      #uci-browse .chip.chip--womens .chip-sub{color:#f5b3d3}
      /* Weekday/date prefix de-emphasized so the times are what the eye
         scans along a row; translucent white so it reads on both the grey
         and the blue (original-language) chip backgrounds. */
      #uci-browse .chip-day{font-weight:500;color:rgba(255,255,255,.55)}

      /* "+N weitere" — deliberately text, not another chip: it isn't a
         showtime itself, and matching the chip shape/size would make it
         look like one at a glance. */
      #uci-browse .ub-more-toggle{
        align-self:center;background:none;border:none;color:#8fc4f0;
        font-size:11px;font-weight:600;cursor:pointer;padding:4px 1px;
        white-space:nowrap;min-height:0}
      #uci-browse .ub-more-toggle:hover{color:#b3dcff;text-decoration:underline}

      /* Demnächst rows: no showtimes to fit, so give the title the room
         the other tabs can't spare, instead of the fixed-width truncation
         used where the chips area needs to stay wide for many showtimes. */
      #uci-browse .film-row.cs-row .ub-film-link{flex:1 1 auto}
      #uci-browse .film-row.cs-row .ub-info{width:auto;flex:1 1 auto;min-width:0}
      #uci-browse .film-row.cs-row .film-title{display:block;overflow:visible}
      #uci-browse .film-row.cs-row .film-chips{flex:0 0 auto}
      #uci-browse .cs-buy-btn{display:inline-block;padding:7px 16px;border-radius:6px;
        background:#4f9dde;color:#fff;font-weight:700;font-size:13px;text-decoration:none;
        white-space:nowrap;flex:0 0 auto}
      #uci-browse .cs-buy-btn:hover{background:#6bb0e8}
      #uci-browse .cs-buy-btn--disabled{background:rgba(255,255,255,.06);color:#6b7684;
        cursor:default;pointer-events:none}
      #uci-browse .cs-buy-btn--disabled:hover{background:rgba(255,255,255,.06)}

      /* Narrow viewport (phone portrait, and most phone-landscape widths):
         the fixed 220px .ub-info column fights .film-chips for space on
         the same line, leaving showtimes almost no room. Below this width
         the poster+title link takes its own first line and the chips drop
         to their own line(s) below — film-row is a flat flex container
         with exactly those two children, so this is just flex-wrap. */
      @media (max-width: 640px) {
        #uci-browse .film-row { flex-wrap: wrap; }
        /* flex-basis must be 0, not auto: with auto, a flex item's size
           for the *wrapping decision* is its content's natural size —
           and a long title's natural size is its full unwrapped text
           width (the line clamp doesn't shrink that). Confirmed against a
           real screenshot: short titles stayed on the poster's line, only
           long ones broke onto their own. A 0 basis means the wrap
           decision sees "small", then flex-grow:1 fills the line. */
        #uci-browse .ub-film-link { flex: 1 1 0; }
        #uci-browse .ub-info { width: auto; flex: 1 1 0; min-width: 0; }
        #uci-browse .film-chips { flex: 1 1 100%; min-height: 0; }
        /* Weitere's dated chips: three per line instead of two (measured:
           12 dates took 6 lines / 344px); widest label "28.3.27 17:00". */
        #uci-browse .chip.chip--date { width: calc((100% - 10px) / 3); }
        /* Demnächst: Buchen stays beside the title instead of taking a
           line of its own (measured: 119px rows). */
        #uci-browse .film-row.cs-row { flex-wrap: nowrap; }
        #uci-browse .film-row.cs-row .film-chips { flex: 0 0 auto; }
      }

      #uci-browse .extra-date-group{margin:0}
      #uci-browse .extra-date-head{font-size:12px;font-weight:700;color:#fff101;
        margin:10px 0 4px;padding-top:6px;border-top:1px solid rgba(255,255,255,.1);
        cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px}
      #uci-browse .extra-date-head::-webkit-details-marker{display:none}
      #uci-browse .extra-date-head::before{content:'▸';display:inline-block;color:#6b7684;
        transition:transform .15s}
      #uci-browse .extra-date-group[open] .extra-date-head::before{transform:rotate(90deg)}
      #uci-browse .extra-date-count{font-weight:400;color:#6b7684;font-size:11px}
      #uci-browse .ub-empty{padding:24px 4px;color:#8b97a8;text-align:center;font-size:13px}
      #uci-browse .ub-foot{margin-top:10px;text-align:center}
      #uci-browse .ub-foot span,#uci-browse .ub-foot a{font-size:11px;color:#6b7684;cursor:pointer;
        text-decoration:none}
      #uci-browse .ub-foot span:hover,#uci-browse .ub-foot a:hover{color:#a9b4c2;text-decoration:underline}
      #uci-browse-back{position:fixed;top:12px;left:12px;z-index:2147483647;
        background:#fff101;color:#000;border:0;border-radius:6px;padding:8px 14px;
        font-weight:700;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3)}

      /* Toggling Nur OV or switching tabs changes page height, which can cross the
         viewport's overflow threshold and toggle the vertical scrollbar —
         that shifts the whole page's width by the scrollbar's own size,
         not just this panel. Reserve the space permanently so it can't. */
      html{overflow-y:scroll}

      /* Belt-and-suspenders: the panel itself should never narrow based on
         its own content either. */
      #uci-browse{width:100%;box-sizing:border-box}

      /* The "Ihre Filme im UCI Kino …" heading sat ~100px left of the
         panel: measured live, .cinema-select spans 1192px with 64px side
         margins inside .container-standard while the panel is a centered
         960px. Same width + centering lines them up; auto margins also
         collapse to 0 on narrower screens, where both fill the container. */
      .container-standard > .cinema-select{max-width:960px;margin-left:auto !important;
        margin-right:auto !important}

      /* Pure marketing banner — nothing functional lives here. */
      html:not(.ub-native) .pimcore_area_keyvisual-kinowelt{display:none !important}

      /* The native filter panel (Datum/Version/Uhrzeit/Events, the Filter
         toggle, the reset link) is fully superseded by our own date tabs
         and Nur-OV control — removed outright rather than kept as
         a fallback. Real data-attribute, unique to this one wrapper. */
      html:not(.ub-native) [data-schedule-filters-wrapper]{display:none !important}

      /* Real navigation (Aktuelles Programm / Demnächst → /coming-soon),
         but 150px for two links is a lot of scroll cost. Kept reachable via
         a small link in our own footer instead — see ub-foot below. */
      html:not(.ub-native) .switch-tabs{display:none !important}`;

    // These two blocks have no unique classnames — only reusable Bootstrap
    // utility combos that likely repeat elsewhere on the page — so they're
    // found by their visible text at runtime instead of a hardcoded CSS
    // selector, same technique used to identify them during diagnosis.
    // Uses the SAME .closest() call that was used to identify each target
    // during diagnosis — a fixed parentElement climb count is not the same
    // operation and can silently land on the wrong ancestor. extraClimb
    // steps past that match when the element itself collapses to 0 height
    // once emptied, but its outer wrapper still reserves space via its own
    // padding, independent of content.
    // What tidyNativeChrome() hid, so the original view can show it again.
    const nativeHiddenEls = [];
    function hideByText(text, closestSelector, extraClimb = 0) {
      const el = [...document.querySelectorAll('*')].find((e) =>
        e.children.length === 0 && e.textContent.trim() === text);
      let target = el ? el.closest(closestSelector) : null;
      for (let i = 0; i < extraClimb && target; i++) target = target.parentElement;
      if (target) { target.style.display = 'none'; nativeHiddenEls.push(target); return true; }
      return false;
    }

    function tidyNativeChrome() {
      // View switcher (Poster-/Tages-/Vorstellungsansicht): controlled only
      // how the native .movies-grid rendered, which we've already hidden —
      // nothing left for it to do. The inner button-row div collapses on
      // its own, but its outer wrapper carries ~52px of its own padding
      // regardless — climb one further level to take that too.
      const sw = hideByText('Vorstellungsansicht', 'div[class]', 1);
      // Search box: filters the native grid, same as above.
      const q = document.querySelector('input[placeholder*="Filmtitel" i]');
      if (q) {
        const box = q.closest('div[class]').parentElement;
        box.style.display = 'none';
        nativeHiddenEls.push(box);
      }
      console.log(TAG, 'view-switcher hidden:', sw, '| search box hidden:', !!q);
    }

    // Applied every poll tick, not just once at mount — if anything on the
    // page re-renders these elements, or if a native stylesheet loaded
    // later wins a specificity fight against our injected CSS, this
    // re-asserts the fix directly via inline styles rather than silently
    // going stale after the old one-shot mount window closed.
    function enforceHidden() {
      if (nativeShown()) return;
      const grid = document.querySelector('.movies-grid');
      if (grid && grid.style.display !== 'none') grid.style.display = 'none';

      const vorverkauf = document.getElementById('scheduleContainerVorverkauf');
      if (vorverkauf && vorverkauf.style.display !== 'none') vorverkauf.style.display = 'none';

      const filters = document.querySelector('[data-schedule-filters-wrapper]');
      if (filters && filters.style.display !== 'none') filters.style.display = 'none';

      // grid.parentElement's class combo is reused elsewhere on the page
      // (confirmed earlier), so this stays keyed off the DOM relationship
      // rather than a selector.
      const outer = grid && grid.parentElement;
      if (outer && outer.style.getPropertyValue('padding-top') !== '0px') {
        // A plain assignment (outer.style.paddingTop = '0') loses to
        // Bootstrap's pt-5/pb-8 utility classes, which carry !important —
        // and !important always wins over a non-important inline style,
        // regardless of specificity. setProperty is the only way to attach
        // !important to an inline style from JS.
        outer.style.setProperty('padding-top', '0', 'important');
        outer.style.setProperty('padding-bottom', '0', 'important');
      }
    }

    // -------------------------------------------------------------- WebMCP
    // Programme-page tools (see webmcp at the top): the same data and
    // filters as the list, read-only, plus opening a showing's booking page,
    // where the booking tools take over.
    const isoDate = (str) => `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
    const compactDate = (iso, field) => {
      if (iso == null || iso === '') return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`${field} must be YYYY-MM-DD`);
      return iso.replace(/-/g, '');
    };
    const hhmm = (t, field) => {
      if (t == null || t === '') return null;
      if (!/^\d{1,2}:\d{2}$/.test(t)) throw new Error(`${field} must be HH:MM`);
      return t.padStart(5, '0');
    };
    const kindLabel = (kind) => SCREENING_KINDS.find((k) => k.kind === kind).badge;
    function showingForAgent(s) {
      const d = new Date(+s.date.slice(0, 4), +s.date.slice(4, 6) - 1, +s.date.slice(6, 8));
      return {
        date: isoDate(s.date), weekday: WEEKDAY.format(d).replace('.', ''), time: s.time,
        auditorium: s.auditorium || null, language: s.lang || 'Deutsch', formats: s.formats,
        special: s.special || null, kinds: s.kinds.map(kindLabel), perfId: s.perfId, siteId: s.siteId,
      };
    }
    function filmForAgent(f) {
      const badges = [f.fresh && f.fresh.label, ...f.allKinds.map((k) => k.badge),
        f.isEvent && 'Event', f.isSneak && 'Sneak'].filter(Boolean);
      return { title: f.title, runtime: f.runtime, fsk: f.fsk,
        genre: f.genre && f.genre.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', '), badges,
        filmPage: f.href ? new URL(f.href, location.href).href : null };
    }
    const waitFor = async (cond, ms) => {
      for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms;) await new Promise((r) => setTimeout(r, 200));
    };

    function registerBrowseTools() {
      webmcp.register([
        {
          name: 'search_showtimes',
          title: 'Vorstellungen suchen',
          description: 'Search this UCI cinema\'s programme (the cinema whose programme page is open). '
            + 'Returns films with their matching showings: date, weekday, time, auditorium, language '
            + '("Deutsch" = German dub; OV, OmU, OmeU = original language), formats (IMAX, 3D, …), '
            + 'special kinds (Preview, Women\'s Night, Midnight Movie), and the perfId/siteId that '
            + 'open_booking takes. All filters are optional and combine.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Part of the film title, accent- and case-insensitive' },
              date: { type: 'string', description: 'One day, YYYY-MM-DD' },
              dateFrom: { type: 'string', description: 'First day, YYYY-MM-DD' },
              dateTo: { type: 'string', description: 'Last day, YYYY-MM-DD' },
              after: { type: 'string', description: 'Earliest start time, HH:MM' },
              before: { type: 'string', description: 'Latest start time, HH:MM' },
              originalLanguageOnly: { type: 'boolean', description: 'Only OV, OmU and OmeU showings' },
              format: { type: 'string', description: 'Only showings with this format, e.g. IMAX, 3D, Dolby Atmos' },
              newOnly: { type: 'boolean', description: 'Only films new this week or starting this week' },
              limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max showings returned (default 150)' },
            },
          },
          annotations: { readOnlyHint: true },
          run: (inp) => {
            const day = compactDate(inp.date, 'date');
            const from = day || compactDate(inp.dateFrom, 'dateFrom');
            const to = day || compactDate(inp.dateTo, 'dateTo');
            const after = hhmm(inp.after, 'after'), before = hhmm(inp.before, 'before');
            const fmt = inp.format ? normalizeSearch(inp.format) : null;
            const q = inp.query ? normalizeSearch(inp.query) : null;
            let budget = Math.min(Math.max(+inp.limit || 150, 1), 500), truncated = false;
            const out = [];
            for (const f of programme().films) {
              if (q && !normalizeSearch(f.title).includes(q)) continue;
              if (inp.newOnly && !f.fresh) continue;
              const shows = f.showtimes
                .filter((s) => (!from || s.date >= from) && (!to || s.date <= to))
                .filter((s) => (!after || s.time.padStart(5, '0') >= after) && (!before || s.time.padStart(5, '0') <= before))
                .filter((s) => !inp.originalLanguageOnly || isOriginalLanguage(s.lang))
                .filter((s) => !fmt || s.formats.some((x) => normalizeSearch(x).includes(fmt)))
                .sort((a, b) => (a.date + a.time.padStart(5, '0')).localeCompare(b.date + b.time.padStart(5, '0')));
              if (!shows.length) continue;
              if (budget <= 0) { truncated = true; break; }
              if (shows.length > budget) truncated = true;
              out.push(Object.assign(filmForAgent(f), { showtimes: shows.slice(0, budget).map(showingForAgent) }));
              budget -= shows.length;
            }
            return { today: isoDate(ymd(new Date())), films: out, truncated };
          },
        },
        {
          name: 'list_new_this_week',
          title: 'Neu diese Woche',
          description: 'Films new at this UCI cinema this week, or starting before the next 8 days are over '
            + '(label "Neu" = in its first week, "Start DD.MM." = opens that day), with their first showing.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
          run: () => {
            const { films, days } = programme();
            const last = days[days.length - 1].str;
            return {
              films: films.filter((f) => f.fresh).map((f) => {
                const week = f.showtimes.filter((s) => s.date <= last)
                  .sort((a, b) => (a.date + a.time.padStart(5, '0')).localeCompare(b.date + b.time.padStart(5, '0')));
                return Object.assign(filmForAgent(f), { label: f.fresh.label, detail: f.fresh.tip,
                  showingsNext8Days: week.length, firstShowing: week[0] ? showingForAgent(week[0]) : null });
              }),
            };
          },
        },
        {
          name: 'list_coming_soon',
          title: 'Demnächst',
          description: 'Films announced as coming soon at UCI, with their German start date (YYYY-MM-DD; '
            + 'null = already running) and whether '
            + 'tickets can already be booked. Showtimes for these appear in search_showtimes once published.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Part of the film title' } },
          },
          annotations: { readOnlyHint: true },
          run: async (inp) => {
            if (demnaechstState === 'idle' || demnaechstState === 'error') loadDemnaechst();
            await waitFor(() => demnaechstState !== 'loading', 20000);
            if (demnaechstState !== 'loaded') throw new Error('Could not load /coming-soon (UCI server error).');
            const q = inp.query ? normalizeSearch(inp.query) : null;
            return {
              films: demnaechstFilms.filter((f) => !q || normalizeSearch(f.title).includes(q)).map((f) => ({
                title: f.title, start: f.dateLabel ? isoDate(f.dateSort) : null, bookable: f.bookable, filmPage: f.href,
              })),
            };
          },
        },
        {
          name: 'open_booking',
          title: 'Buchung öffnen',
          description: 'Open the booking page for one showing (perfId and siteId from search_showtimes). '
            + 'The tab navigates away; on the booking page the user picks seats, and the booking tools '
            + '(get_booking_state, list_unlimited_cards, redeem_unlimited_cards) become available.',
          inputSchema: {
            type: 'object',
            properties: { perfId: { type: 'string' }, siteId: { type: 'string' } },
            required: ['perfId', 'siteId'],
          },
          annotations: { readOnlyHint: false },
          run: ({ perfId, siteId }) => {
            for (const f of programme().films) {
              const s = f.showtimes.find((x) => x.perfId === String(perfId) && x.siteId === String(siteId));
              if (!s) continue;
              const url = bookingUrl(s);
              setTimeout(() => location.assign(url), 300);
              return { opening: url, film: f.title, showing: showingForAgent(s),
                next: 'The user picks seats on the seat map and presses Weiter to reach the payment step.' };
            }
            throw new Error('No showing with that perfId/siteId on this programme page.');
          },
        },
      ]);
    }

    function mount() {
      const grid = document.querySelector('.movies-grid');
      if (!grid) return false;
      if (document.getElementById('uci-browse')) { enforceHidden(); return true; }

      const style = document.createElement('style');
      style.textContent = STYLE;
      document.head.appendChild(style);

      tidyNativeChrome();
      grid.insertAdjacentElement('afterend', panel);
      enforceHidden();
      render();
      // /coming-soon carries the official start dates the Preview badges
      // need, so it's loaded right away instead of on the first Demnächst
      // click. Renders again when it arrives.
      if (demnaechstState === 'idle') loadDemnaechst();
      registerBrowseTools();
      clearTimeout(spinnerTimeout);
      spinner.remove();
      console.log(TAG, 'mounted, replacing .movies-grid');
      return true;
    }

    // setInterval's first tick only fires after the full delay — mount()
    // would otherwise never run at all during that first second, which is
    // exactly the native-page flash this whole thing exists to prevent.
    mount();
    narrowMQ.addEventListener('change', () => { if (panel.isConnected) render(); });
    // Pills per row follow the width (weekChipLimit), so a width change
    // inside one breakpoint (rotation, window resize) re-renders too. Width
    // only: iOS Safari fires resize whenever its toolbar collapses on
    // scroll, and rebuilding the list on every scroll isn't wanted.
    let lastVW = window.innerWidth, resizeTimer = 0;
    window.addEventListener('resize', () => {
      if (window.innerWidth === lastVW) return;
      lastVW = window.innerWidth;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (panel.isConnected) render(); }, 200);
    });
    // At document-start, .movies-grid usually doesn't exist for the first
    // several ticks, so this polls quickly at first rather than waiting a
    // full second per attempt, then drops to the steady rate once mounted
    // (or once it's given up trying quickly) for ongoing enforcement.
    let fastTries = 0;
    const fastPoll = setInterval(() => {
      if (mount() || ++fastTries > 10) { clearInterval(fastPoll); setInterval(mount, 1000); }
    }, 150);
  }
})();
