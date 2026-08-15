// ==UserScript==
// @name         better-uci
// @namespace    https://github.com/n-klocke/better-uci
// @version      2.1.0
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
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (location.hostname === 'buchung.uci-kinowelt.de') {
    initRedeemer();
  } else if (location.hostname === 'www.uci-kinowelt.de') {
    initBrowse();
  }

  function initRedeemer() {
  const TAG = '[uci-batch]';
  console.log(TAG, 'loaded', location.href);

  const ENDPOINT = '/TicketBoxXNG/booking/bonusAndVoucherTotal.json';
  const STORE_KEY = 'uci_cards_v1';
  const HOST_SEL = '#payment-type-uc-content .card-body';
  const MAX_ATTEMPTS = 4;

  function pageWin() {
    const c = [];
    try { if (typeof unsafeWindow !== 'undefined') c.push(unsafeWindow); } catch {}
    c.push(window);
    try { if (window.wrappedJSObject) c.push(window.wrappedJSObject); } catch {}
    return c.find((w) => w && w.book) || c.find((w) => w && w.$) || window;
  }
  const getBook = () => pageWin().book;
  const getJQ = () => pageWin().$;
  const bpid = () => { const b = getBook(); return b && b.bookingProcessId; };

  const loadCards = () => { try { return JSON.parse(GM_getValue(STORE_KEY, '[]')); } catch { return []; } };
  const saveCards = (c) => GM_setValue(STORE_KEY, JSON.stringify(c));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safeParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const mask = (c) => c.length > 6 ? c.slice(0, 4) + '…' + c.trim().slice(-4) : c;
  const eur = (n) => (n == null ? '—' : n.toFixed(2).replace('.', ',') + ' €');

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
  function post(data, label, rep, prog) {
    const $ = getJQ();
    if (!$) return Promise.reject(new Error('jQuery nicht erreichbar'));
    const t0 = performance.now();
    rep && rep.inflight(t0);
    console.log(TAG, '→', label, data);
    return new Promise((resolve, reject) => {
      $.ajax({ url: ENDPOINT, method: 'POST', data })
        .done((resp) => {
          const ms = Math.round(performance.now() - t0);
          rep && rep.settled();
          if (resp && resp.failure === 'true') {
            console.warn(TAG, '←', label, ms + 'ms FAILURE', resp.errorCode);
            return reject(apiError(resp, ms));
          }
          if (typeof resp.chfForBookingTransaction === 'number')
            lastFee = resp.chfForBookingTransaction;
          console.log(TAG, '←', label, ms + 'ms ok total=' + resp.fullAmount);
          prog && prog.step();
          resolve(resp);
        })
        .fail((xhr) => {
          const ms = Math.round(performance.now() - t0);
          rep && rep.settled();
          const body = xhr.responseJSON || safeParse(xhr.responseText);
          const err = body ? apiError(body, ms) : Object.assign(new Error('HTTP ' + xhr.status), { ms });
          console.warn(TAG, '←', label, ms + 'ms ERROR', err.code || xhr.status, err.message);
          reject(err);
        });
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
          if (resp0) await getBook().handleBookingServerSuccess(resp0);
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
        await getBook().handleBookingServerSuccess(resp);
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
  let advanceArmed = false;   // set only by the EINLÖSEN button, cleared on use

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

  async function runQueue(queue) {
    if (!getBook()) { ui.hint('Buchungsseite nicht bereit (window.book fehlt)', true); return; }
    if (!bpid()) { ui.hint('Keine aktive Buchung — bitte zuerst Plätze wählen', true); return; }

    running = true;
    ui.hint('', true);          // clear any sticky message from the last run
    ui.busy(true);
    const prog = makeProgress(queue.reduce((s, p) => s + (p.own ? 1 : 2), 0));
    const t0 = performance.now();
    let ok = 0;

    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      prog.card(i + 1, queue.length);
      const rep = ui.reporterFor(p);
      ui.log(`— ${p.name} (${mask(p.code)})`, 'info');
      const r = await redeemOne(p, rep, prog);
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
    await runQueue(queue);
  }

  // Opens the "Buchungsabschluss" accordion and scrolls to it. Deliberately
  // does NOT press the button inside it: that step locks out vouchers and
  // Movie Points for the rest of the booking.
  function goToCheckout() {
    const hdr = document.querySelector('#init-checkout-and-payment-type-select-header');
    const body = document.querySelector('#init-checkout-and-payment-type-select-content');
    if (!hdr) return;
    if (body && !body.classList.contains('show')) hdr.click();
    setTimeout(() => hdr.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
  }

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
      #uci-batch.floating{position:fixed;top:90px;right:16px;width:340px;max-width:none;
        z-index:2147483647;background:#2b3444;border:1px solid #566;border-radius:8px;
        padding:12px;box-shadow:0 6px 20px rgba(0,0,0,.45)}
      #uci-batch .hd{display:none}
      #uci-batch.floating .hd{display:flex;align-items:center;margin-bottom:4px;cursor:move;
        font-size:12px;color:#8b97a8}
      #uci-batch.floating .hd::before{content:'⠳ Unlimited-Karten'}
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
      /* delete stays out of the way until you actually want it */
      #uci-batch .del{cursor:pointer;color:#7c8899;font-size:15px;line-height:1;
        opacity:0;transition:opacity .12s;padding:0 4px}
      #uci-batch .person:hover .del{opacity:1}
      #uci-batch .del:hover{color:#ff9c9c}
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
      #uci-batch .log{margin-top:8px;max-height:140px;overflow:auto;
        font-size:11px;line-height:1.45;font-family:ui-monospace,monospace;
        background:rgba(0,0,0,.28);border-radius:5px;padding:7px;display:none}
      #uci-batch .log.on{display:block}
      #uci-batch .log .ok{color:#7fd6a0} #uci-batch .log .err{color:#ff9c9c}
      #uci-batch .log .warn{color:#ffd77f} #uci-batch .log .info{color:#9aa6b5}
      #uci-batch .addbox{padding:6px 2px}
      #uci-batch .addbox > summary{margin-top:0;padding:2px 0;color:#fff101;font-size:12.5px;
        font-weight:600;list-style:none}
      #uci-batch .addbox > summary::-webkit-details-marker{display:none}
      #uci-batch .addbox > summary:hover{filter:brightness(1.15)}
      #uci-batch .addbox[open] > summary{color:#8b97a8;font-weight:400}
      #uci-batch .toggles{display:flex;gap:16px;margin-top:8px}
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
    </style>
    <div class="hd"></div>
    <div class="basket" id="uci-basket">Warenkorb wird gelesen…</div>
    <div id="uci-list"></div>
    <details id="uci-addbox" class="addbox">
      <summary>+ Karte hinzufügen</summary>
      <input type="text" id="uci-name" placeholder="Name">
      <input type="text" id="uci-code" placeholder="Kartennummer">
      <button class="go mini" id="uci-add">Hinzufügen</button>
    </details>
    <div class="hint" id="uci-hint"></div>
    <button class="go" id="uci-go">EINLÖSEN</button>
    <div class="prog" id="uci-prog"><span id="uci-cardcount"></span><span id="uci-stepcount"></span></div>
    <div class="toggles">
      <label class="tiny"><input type="checkbox" id="uci-showlog"> Debug-Logs</label>
      <label class="tiny"><input type="checkbox" id="uci-native"> UCI-Originalfelder</label>
    </div>
    <div class="log" id="uci-log"></div>
    <details>
      <summary>Karten verwalten</summary>
      <div class="rowbtns">
        <button class="go mini" id="uci-export">Exportieren</button>
        <button class="go mini" id="uci-import">Importieren</button>
      </div>
      <textarea id="uci-io" placeholder="JSON — zum Teilen kopieren, oder hier einfügen und auf Importieren klicken"></textarea>
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
        `<div class="${cls || 'info'}">${new Date().toTimeString().slice(0, 8)} ${m}</div>`);
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
    if (!b) { el.textContent = 'Noch kein Warenkorb — bitte zuerst Plätze wählen.'; return; }
    const parts = [`<b>${b.n}</b> Ticket${b.n === 1 ? '' : 's'}`];
    if (b.unlimited) parts.push(`<b>${b.unlimited}</b> mit Unlimited`);
    if (b.free) parts.push(`<b>${b.free}</b> mit Movie Points`);
    parts.push(`<b>${b.open}</b> zu zahlen`);
    parts.push(`<b>${eur(b.due)}</b>`);
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
  function enforceCap() {
    const b = basket();
    const boxes = [...panel.querySelectorAll('#uci-list input[type=checkbox]')];
    if (!b || running) { boxes.forEach((c) => (c.disabled = running)); return; }
    const limit = b.open;
    const checked = boxes.filter((c) => c.checked && !c.dataset.applied);
    boxes.forEach((c) => { c.disabled = !c.checked && !c.dataset.applied && checked.length >= limit; });
    ui.hint(checked.length > limit
      ? `Nur ${limit} freie Plätze — bitte Auswahl reduzieren.`
      : checked.length === limit && limit > 0 ? `Maximum erreicht (${limit} freie Plätze).` : '');
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

  function renderList() {
    const b = getBook();
    const rows = [];
    if (b && b.unlimitedCustomerNumber)
      rows.push({ id: 'own', name: 'Ich', code: b.unlimitedCustomerNumber, own: true });
    loadCards().forEach((c, i) => rows.push({ id: 'c' + i, name: c.name, code: c.code, idx: i }));

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
        <span class="pcode">${mask(c.code)}</span>
        ${c.own ? '' : `<span class="del" data-del="${c.idx}" title="Karte löschen">×</span>`}
        <span class="retry" data-id="${c.id}" title="nur diese Karte erneut versuchen">↻</span>
        <span class="badge" data-id="${c.id}"></span>
        <span class="detail" data-id="${c.id}">${dup ? '⚠ doppelt gespeichert' : ''}</span>`;
      el.querySelector('.pname').textContent = c.name;
      list.appendChild(el);
    });

    list.querySelectorAll('[data-del]').forEach((el) => {
      el.onclick = () => {
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

  function makeDraggable() {
    const hd = panel.querySelector('.hd');
    let sx, sy, ox, oy, on = false;
    hd.addEventListener('pointerdown', (e) => {
      if (!panel.classList.contains('floating')) return;
      on = true; hd.setPointerCapture(e.pointerId);
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.right = 'auto';
    });
    hd.addEventListener('pointermove', (e) => {
      if (!on) return;
      panel.style.left = ox + e.clientX - sx + 'px';
      panel.style.top = oy + e.clientY - sy + 'px';
    });
    hd.addEventListener('pointerup', () => { on = false; });
  }

  function wire() {
    panel.querySelector('#uci-showlog').onchange = (e) =>
      panel.querySelector('#uci-log').classList.toggle('on', e.target.checked);
    panel.querySelector('#uci-native').onchange = (e) => setNativeVisible(e.target.checked);

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

    makeDraggable();
  }

  let mounted = false;
  function tryMount() {
    if (mounted) return;
    const host = document.querySelector(HOST_SEL);
    if (host) {
      host.insertBefore(panel, host.firstChild);
      setNativeVisible(false);
      console.log(TAG, 'mounted inline');
    } else {
      panel.classList.add('floating');
      document.body.appendChild(panel);
      console.log(TAG, 'host not found — floating fallback');
    }
    mounted = true;
    wire();
  }

  (function boot() {
    if (!document.body) return setTimeout(boot, 200);
    tryMount();
    (function poll() {
      if (!panel.isConnected) { mounted = false; tryMount(); }
      ui.diag(`book:${getBook() ? 'ok' : '—'} $:${getJQ() ? 'ok' : '—'} bpid:${bpid() ? 'ok' : '—'}`);
      const rebuilt = renderList();
      if (!running) {
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
      }
      setTimeout(poll, 1500);
    })();
  })();
  }

  function initBrowse() {
    const TAG = '[uci-browse]';
    console.log(TAG, 'loaded', location.href);

    const PREF_KEY = 'uci_browse_prefs_v1';
    let prefs = { ovOnly: false, compact: true };
    // Not persisted like prefs — a stale search silently reapplying on a
    // later visit would be more confusing than useful.
    let searchQuery = '';

    function normalizeSearch(str) {
      return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    }
    function matchesQuery(title) {
      const q = searchQuery.trim();
      return !q || normalizeSearch(title).includes(normalizeSearch(q));
    }
    try { prefs = Object.assign(prefs, JSON.parse(GM_getValue(PREF_KEY, '{}'))); } catch {}
    const savePrefs = () => GM_setValue(PREF_KEY, JSON.stringify(prefs));

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
    // Every film's full detail — poster, runtime, FSK, every showtime — is
    // already in the DOM at load, individually hidden behind its own
    // d-none wrapper. No network calls needed: just read it.
    function parseCard(card) {
      const titleEl = card.querySelector('.film-container__description__text__eventtitle a, .film-container__description__text__eventtitle');
      const title = titleEl ? titleEl.textContent.trim() : null;
      if (!title) return null;

      let runtime = null, genre = null;
      card.querySelectorAll('.film-info li').forEach((li) => {
        const t = li.textContent.trim();
        if (/^\d+\s*min$/i.test(t)) runtime = t;
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
        const href = a.getAttribute('href') || '';
        const m = href.match(/performanceId\/([^/]+)\/siteId\/(\d+)/);
        if (!m) return null;

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

        return {
          time: a.dataset.time, date: a.dataset.date,
          auditorium: a.dataset.trackingAuditorium || '',
          perfId: m[1], siteId: m[2],
          formats, lang, special,
        };
      }).filter(Boolean);

      if (!showtimes.length) return null;
      return { title, runtime, genre, fsk, poster, showtimes };
    }

    function collectFilms(root) {
      return [...(root || document).querySelectorAll('.film-container-wrapper')]
        .map(parseCard)
        .filter(Boolean);
    }

    // -------------------------------------------------------------- render
    const panel = document.createElement('div');
    panel.id = 'uci-browse';

    function chipHTML(s) {
      const tags = [...s.formats];
      if (s.special) tags.push(s.special);
      const premium = s.formats.length > 0;
      const langClass = s.lang ? ' lang-' + s.lang.toLowerCase().replace(/[^a-z]/g, '') : '';
      return `
        <a class="chip${premium ? ' premium' : ''}${langClass}"
           data-perf="${s.perfId}" data-site="${s.siteId}"
           title="${s.time} · ${s.auditorium}${s.lang ? ' · ' + s.lang : ''}${tags.length ? ' · ' + tags.join(', ') : ''}">
          <span class="chip-time">${s.time}</span>
          ${(s.lang || tags.length) ? `<span class="chip-sub">${[s.lang, ...tags].filter(Boolean).join(' · ')}</span>` : ''}
        </a>`;
    }

    // Same as chipHTML, but for a row that spans several dates rather than
    // one day — the time alone is no longer enough to tell showings apart,
    // so the date is folded into the same label. Year is only spelled out
    // when it isn't the current one, so the common case stays compact.
    function extraChipHTML(s, currentYear) {
      const tags = [...s.formats];
      if (s.special) tags.push(s.special);
      const premium = s.formats.length > 0;
      const langClass = s.lang ? ' lang-' + s.lang.toLowerCase().replace(/[^a-z]/g, '') : '';
      const dd = +s.date.slice(6, 8), mm = +s.date.slice(4, 6), yy = s.date.slice(0, 4);
      const dateLabel = (+yy === currentYear) ? `${dd}.${mm}.` : `${dd}.${mm}.${yy}`;
      return `
        <a class="chip${premium ? ' premium' : ''}${langClass}"
           data-perf="${s.perfId}" data-site="${s.siteId}"
           title="${dateLabel} ${s.time} · ${s.auditorium}${s.lang ? ' · ' + s.lang : ''}${tags.length ? ' · ' + tags.join(', ') : ''}">
          <span class="chip-time">${dateLabel} ${s.time}</span>
          ${(s.lang || tags.length) ? `<span class="chip-sub">${[s.lang, ...tags].filter(Boolean).join(' · ')}</span>` : ''}
        </a>`;
    }

    function rowHTML(film, dateStr) {
      const shown = film.showtimes
        .filter((s) => s.date === dateStr)
        .filter((s) => !prefs.ovOnly || s.lang === 'OV')
        .sort((a, b) => a.time.localeCompare(b.time));
      if (!shown.length) return '';
      return `
        <div class="film-row">
          ${film.poster ? `<img class="film-thumb" src="${film.poster}" loading="lazy" alt="">` : '<div class="film-thumb film-thumb--empty"></div>'}
          <div class="film-info">
            <div class="film-title">${film.title}</div>
            <div class="film-meta">${[film.runtime, film.fsk ? 'FSK ' + film.fsk : null, film.genre].filter(Boolean).join(' · ')}</div>
          </div>
          <div class="film-chips">${shown.map(chipHTML).join('')}</div>
        </div>`;
    }

    // One row per film, chips spanning every showtime in the given set
    // (which may cross several dates), sorted chronologically.
    function extraRowHTML(film, showtimes) {
      const shown = showtimes
        .filter((s) => !prefs.ovOnly || s.lang === 'OV')
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      if (!shown.length) return '';
      const currentYear = new Date().getFullYear();
      return `
        <div class="film-row">
          ${film.poster ? `<img class="film-thumb" src="${film.poster}" loading="lazy" alt="">` : '<div class="film-thumb film-thumb--empty"></div>'}
          <div class="film-info">
            <div class="film-title">${film.title}</div>
            <div class="film-meta">${[film.runtime, film.fsk ? 'FSK ' + film.fsk : null, film.genre].filter(Boolean).join(' · ')}</div>
          </div>
          <div class="film-chips">${shown.map((s) => extraChipHTML(s, currentYear)).join('')}</div>
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
        const rows = sec.items.map(({ film, showtimes }) => extraRowHTML(film, showtimes)).filter(Boolean).join('');
        if (!rows) return '';
        const open = query ? true : firstOpen;
        if (!query) firstOpen = false;
        return `<details class="extra-date-group"${open ? ' open' : ''}>
          <summary class="extra-date-head">${sec.label}
            <span class="extra-date-count">${sec.items.length} Film${sec.items.length === 1 ? '' : 'e'}</span>
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

      return { title, href, poster, dateLabel, dateSort, bookable };
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
          <a class="cs-link" href="${f.href}">
            ${f.poster ? `<img class="film-thumb" src="${f.poster}" loading="lazy" alt="">` : '<div class="film-thumb film-thumb--empty"></div>'}
            <div class="film-info">
              <div class="film-title">${f.title}</div>
              <div class="film-meta">${dateText}</div>
            </div>
          </a>
          <div class="film-chips">${action}</div>
        </div>`;
    }

    let demnaechstState = 'idle';   // idle | loading | loaded | error
    let demnaechstFilms = [];

    async function loadDemnaechst() {
      demnaechstState = 'loading';
      render();
      try {
        const res = await fetch('/coming-soon');
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

    function render() {
      const films = collectFilms();
      if (!films.length) { panel.innerHTML = '<div class="ub-empty">Kein Programm gefunden.</div>'; return; }
      films.sort((a, b) => a.title.localeCompare(b.title, 'de'));
      const visibleFilms = films.filter((f) => matchesQuery(f.title));

      const today = new Date();
      const days = [...Array(8)].map((_, i) => {
        const d = new Date(today); d.setDate(d.getDate() + i);
        return { str: ymd(d), label: dateLabel(d, i) };
      });
      const knownDates = new Set(days.map((d) => d.str));

      if (!panel.dataset.selected) panel.dataset.selected = days[0].str;
      const sel = panel.dataset.selected;

      const extraHTML = extraDatesHTML(visibleFilms, knownDates);
      const tabsHTML = days.map((d) =>
        `<button class="ub-tab${d.str === sel ? ' active' : ''}" data-date="${d.str}">${d.label}</button>`
      ).join('')
        + (extraHTML ? `<button class="ub-tab${sel === 'extra' ? ' active' : ''}" data-date="extra">Weitere</button>` : '')
        + `<button class="ub-tab${sel === 'demnaechst' ? ' active' : ''}" data-date="demnaechst">Demnächst</button>`;

      const body = sel === 'extra' ? extraHTML
        : sel === 'demnaechst' ? demnaechstBodyHTML()
        : visibleFilms.map((f) => rowHTML(f, sel)).filter(Boolean).join('');

      const shownCount = (sel === 'extra' || sel === 'demnaechst') ? null
        : visibleFilms.filter((f) => f.showtimes.some((s) => s.date === sel)).length;

      const query = searchQuery.trim();
      const emptyMsg = query
        ? `Keine Treffer für „${query}“.`
        : 'Keine Vorstellungen an diesem Tag' + (prefs.ovOnly ? ' in OV' : '') + '.';

      // A full innerHTML rebuild on every keystroke would otherwise kick
      // focus out of the search field after the first character typed —
      // capture position before rebuilding, restore it after.
      const searchHadFocus = document.activeElement && document.activeElement.id === 'ub-search';
      const searchSelStart = searchHadFocus ? document.activeElement.selectionStart : null;
      const searchSelEnd = searchHadFocus ? document.activeElement.selectionEnd : null;

      panel.innerHTML = `
        <div class="ub-bar">
          <div class="ub-tabs">${tabsHTML}</div>
          <label class="ub-ov"><input type="checkbox" id="ub-ovonly" ${prefs.ovOnly ? 'checked' : ''}> Nur OV</label>
          <label class="ub-ov"><input type="checkbox" id="ub-compact" ${prefs.compact ? 'checked' : ''}> Kompakt</label>
        </div>
        <div class="ub-search-row">
          <input type="search" id="ub-search" placeholder="Film suchen…" value="${searchQuery.replace(/"/g, '&quot;')}">
        </div>
        ${shownCount !== null ? `<div class="ub-count">${shownCount} Film${shownCount === 1 ? '' : 'e'}</div>` : ''}
        <div class="ub-list">${body || `<div class="ub-empty">${emptyMsg}</div>`}</div>
        <div class="ub-foot"><span id="ub-native-toggle">Original-Ansicht zeigen</span></div>`;

      panel.querySelectorAll('.ub-tab').forEach((b) => {
        b.onclick = () => {
          panel.dataset.selected = b.dataset.date;
          if (b.dataset.date === 'demnaechst' && demnaechstState === 'idle') loadDemnaechst();
          else render();
        };
      });
      panel.querySelector('#ub-ovonly').onchange = (e) => { prefs.ovOnly = e.target.checked; savePrefs(); render(); };
      panel.querySelector('#ub-compact').onchange = (e) => { prefs.compact = e.target.checked; savePrefs(); render(); };
      panel.querySelector('#ub-search').oninput = (e) => { searchQuery = e.target.value; render(); };
      if (searchHadFocus) {
        const el = panel.querySelector('#ub-search');
        el.focus();
        el.setSelectionRange(searchSelStart, searchSelEnd);
      }
      panel.classList.toggle('ub-large', !prefs.compact);
      panel.querySelectorAll('.chip').forEach((c) => {
        c.onclick = (e) => {
          e.preventDefault();
          location.href = `https://buchung.uci-kinowelt.de/?perf_id=${encodeURIComponent(c.dataset.perf)}&site_id=${encodeURIComponent(c.dataset.site)}`;
        };
      });
      const nt = panel.querySelector('#ub-native-toggle');
      if (nt) nt.onclick = () => setNativeVisible(true);
    }

    function setNativeVisible(on) {
      const grid = document.querySelector('.movies-grid');
      if (grid) grid.style.display = on ? '' : 'none';
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
      #uci-browse .ub-tab{background:rgba(255,255,255,.06);border:1px solid transparent;
        color:#cfd6e0;border-radius:6px;padding:5px 10px;font-size:12.5px;cursor:pointer}
      #uci-browse .ub-tab:hover{background:rgba(255,255,255,.12)}
      #uci-browse .ub-tab.active{background:#fff101;color:#000;font-weight:700}
      #uci-browse .ub-ov{display:flex;align-items:center;gap:6px;font-size:12.5px;
        color:#cfd6e0;white-space:nowrap;accent-color:#fff101}
      #uci-browse .ub-search-row{margin-bottom:8px}
      #uci-browse #ub-search{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);
        border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#fff;font-size:13px;
        padding:7px 10px}
      #uci-browse #ub-search::placeholder{color:#6b7684}
      #uci-browse #ub-search:focus{outline:none;border-color:rgba(255,241,1,.5)}
      #uci-browse #ub-search::-webkit-search-cancel-button{filter:invert(1);opacity:.6;cursor:pointer}
      #uci-browse .ub-count{font-size:11.5px;color:#8b97a8;margin-bottom:6px}
      #uci-browse .ub-list{display:flex;flex-direction:column}
      #uci-browse .film-row{display:flex;align-items:center;gap:12px;padding:8px 2px;
        border-bottom:1px solid rgba(255,255,255,.07)}
      #uci-browse .film-row:hover{background:rgba(255,255,255,.03)}
      #uci-browse .film-thumb{width:40px;height:57px;object-fit:cover;border-radius:4px;flex:0 0 auto;
        background:rgba(255,255,255,.08);transition:width .15s,height .15s}
      #uci-browse .film-thumb--empty{}
      #uci-browse .film-info{flex:0 0 auto;width:220px;min-width:0}
      #uci-browse .film-title{font-weight:600;font-size:13.5px;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis}
      #uci-browse .film-meta{font-size:11px;color:#8b97a8;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis}
      #uci-browse .film-chips{display:flex;flex-wrap:wrap;gap:6px;flex:1}

      /* "Kompakt" off: posters at 2x, as requested. Rows switch to
         top-alignment so the (much taller) poster doesn't visually center
         two lines of text against it — and title/genre get room to wrap
         onto a second line rather than truncating. */
      #uci-browse.ub-large .film-row{align-items:flex-start;padding:12px 2px;gap:14px}
      #uci-browse.ub-large .film-thumb{width:80px;height:114px}
      #uci-browse.ub-large .film-info{width:260px;padding-top:2px}
      #uci-browse.ub-large .film-title{white-space:normal;font-size:14.5px}
      #uci-browse.ub-large .film-meta{white-space:normal}
      #uci-browse.ub-large .film-chips{padding-top:2px}
      #uci-browse .chip{display:flex;flex-direction:column;align-items:center;justify-content:center;
        min-width:52px;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.08);
        border:1px solid rgba(255,255,255,.12);text-decoration:none;cursor:pointer;line-height:1.25}
      #uci-browse .chip:hover{background:rgba(255,255,255,.16)}
      #uci-browse .chip-time{font-size:12.5px;font-weight:700;color:#fff}
      #uci-browse .chip-sub{font-size:9.5px;color:#a9b4c2;white-space:nowrap}
      #uci-browse .chip.premium{border-color:rgba(255,241,1,.5)}
      #uci-browse .chip.lang-ov{background:rgba(79,157,222,.16);border-color:rgba(79,157,222,.4)}
      #uci-browse .chip.lang-ov .chip-sub{color:#8fc4f0}

      /* Demnächst rows: no showtimes to fit, so give the title the room
         the other tabs can't spare, instead of the fixed-width truncation
         used where the chips area needs to stay wide for many showtimes. */
      #uci-browse .film-row.cs-row .film-info{width:auto;flex:1 1 auto;min-width:0}
      #uci-browse .film-row.cs-row .film-title{white-space:normal;overflow:visible;text-overflow:clip}
      #uci-browse .film-row.cs-row .film-chips{flex:0 0 auto}
      #uci-browse .cs-link{display:flex;align-items:center;gap:12px;flex:1;min-width:0;
        color:inherit;text-decoration:none}
      #uci-browse.ub-large .cs-link{align-items:flex-start}
      #uci-browse .cs-buy-btn{display:inline-block;padding:7px 16px;border-radius:6px;
        background:#4f9dde;color:#fff;font-weight:700;font-size:13px;text-decoration:none;
        white-space:nowrap;flex:0 0 auto}
      #uci-browse .cs-buy-btn:hover{background:#6bb0e8}
      #uci-browse .cs-buy-btn--disabled{background:rgba(255,255,255,.06);color:#6b7684;
        cursor:default;pointer-events:none}
      #uci-browse .cs-buy-btn--disabled:hover{background:rgba(255,255,255,.06)}
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

      /* Toggling Nur OV / Kompakt changes page height, which can cross the
         viewport's overflow threshold and toggle the vertical scrollbar —
         that shifts the whole page's width by the scrollbar's own size,
         not just this panel. Reserve the space permanently so it can't. */
      html{overflow-y:scroll}

      /* Belt-and-suspenders: the panel itself should never narrow based on
         its own content either. */
      #uci-browse{width:100%;box-sizing:border-box}

      /* Pure marketing banner — nothing functional lives here. */
      .pimcore_area_keyvisual-kinowelt{display:none !important}

      /* The native filter panel (Datum/Version/Uhrzeit/Events, the Filter
         toggle, the reset link) is fully superseded by our own date tabs
         and Nur-OV/Kompakt controls — removed outright rather than kept as
         a fallback. Real data-attribute, unique to this one wrapper. */
      [data-schedule-filters-wrapper]{display:none !important}

      /* Real navigation (Aktuelles Programm / Demnächst → /coming-soon),
         but 150px for two links is a lot of scroll cost. Kept reachable via
         a small link in our own footer instead — see ub-foot below. */
      .switch-tabs{display:none !important}`;

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
    function hideByText(text, closestSelector, extraClimb = 0) {
      const el = [...document.querySelectorAll('*')].find((e) =>
        e.children.length === 0 && e.textContent.trim() === text);
      let target = el ? el.closest(closestSelector) : null;
      for (let i = 0; i < extraClimb && target; i++) target = target.parentElement;
      if (target) { target.style.display = 'none'; return true; }
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
      if (q) { q.closest('div[class]').parentElement.style.display = 'none'; }
      console.log(TAG, 'view-switcher hidden:', sw, '| search box hidden:', !!q);
    }

    // Applied every poll tick, not just once at mount — if anything on the
    // page re-renders these elements, or if a native stylesheet loaded
    // later wins a specificity fight against our injected CSS, this
    // re-asserts the fix directly via inline styles rather than silently
    // going stale after the old one-shot mount window closed.
    function enforceHidden() {
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
      console.log(TAG, 'mounted, replacing .movies-grid');
      return true;
    }

    // Runs indefinitely, not just for a few seconds after load: covers slow
    // initial render AND any later re-render that would otherwise silently
    // undo the hides.
    setInterval(mount, 1000);
  }
})();
