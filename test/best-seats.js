#!/usr/bin/env node
// Runs Beste Plätze (bestSeatGroup) on captured seat plans and checks the
// picks against test/best-seats.cases.js. The function is read out of
// better-uci.user.js and evaluated on its own, so this tests the shipped
// code, not a copy. It only depends on SEAT_PREFS_DEFAULT (read from the
// same file) and legendPrices (the fixture's prices).
//
// Prints each hall as text with the pick marked, and writes
// test/out/best-seats.html with the same maps drawn to scale.
//
// Run: node test/best-seats.js [case-id-filter]

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'better-uci.user.js'), 'utf8');

// Cuts `function name(...) {...}` out of the source by counting braces.
// Fine for bestSeatGroup, which has no braces inside strings or regexes.
function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in better-uci.user.js`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
}
const defaultsSrc = src.match(/const SEAT_PREFS_DEFAULT = (\{[^}]*\});/);
if (!defaultsSrc) throw new Error('SEAT_PREFS_DEFAULT not found in better-uci.user.js');
const SEAT_PREFS_DEFAULT = Function(`return ${defaultsSrc[1]}`)();
const makeBest = Function('SEAT_PREFS_DEFAULT', 'legendPrices',
  `${extractFunction('bestSeatGroup')}\nreturn bestSeatGroup;`);

function loadFixture(name) {
  const file = path.join(root, 'fixtures', 'seatplans', `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// '7 4-5' / '7 4,5' → { row: '7', seats: ['4', '5'] }
function parsePick(s) {
  const m = String(s).trim().match(/^(\S+)\s+(.+)$/);
  if (!m) throw new Error(`bad pick "${s}", expected e.g. "7 4-5"`);
  const [, row, rest] = m;
  const range = rest.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const a = +range[1], b = +range[2], seats = [];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) seats.push(String(i));
    return { row, seats };
  }
  return { row, seats: rest.split(/\s*,\s*/) };
}
const pickLabel = (best) => {
  if (!best) return 'none';
  const nums = best.seats.map((t) => +t.seat).sort((a, b) => a - b);
  const contiguous = nums.every((v, i) => i === 0 || v === nums[i - 1] + 1);
  return `${best.row} ${contiguous && nums.length > 1 ? `${nums[0]}-${nums[nums.length - 1]}` : nums.join(',')}`;
};
const samePick = (best, want) => !!best && String(best.row) === want.row
  && best.seats.length === want.seats.length && best.seats.every((t) => want.seats.includes(String(t.seat)));

// Text map: one line per row, screen at the top, one character per seat
// at its x position. . free  x taken  w wheelchair  * pick  o expected
function textMap(plan, pickIds, wantIds) {
  const seats = plan.seats;
  const median = (a) => { const v = a.slice().sort((x, y) => x - y); return v[v.length >> 1]; };
  const seatW = median(seats.map((t) => t.w));
  const minX = Math.min(...seats.map((t) => t.x));
  // One line per row label. Curved rows (IMAX) spread over several seat
  // heights, so seats are grouped by label, and only split where the same
  // label turns up again far away (a second block, a loge).
  const rows = [];
  const byLabel = new Map();
  seats.slice().sort((a, b) => a.y - b.y).forEach((t) => {
    const groups = byLabel.get(t.row) || [];
    let g = groups.find((r) => Math.abs(r.y - t.y) < seatW * 2.5);
    if (!g) { g = { y: t.y, seats: [] }; groups.push(g); rows.push(g); byLabel.set(t.row, groups); }
    g.seats.push(t);
  });
  rows.forEach((g) => { g.y = g.seats.reduce((s, t) => s + t.y, 0) / g.seats.length; });
  const width = Math.max(...seats.map((t) => Math.round((t.x - minX) / seatW))) + 1;
  const lines = [`      ${'─'.repeat(Math.max(4, width - 8)).padStart(width - 4)}  Leinwand`];
  rows.sort((a, b) => a.y - b.y).forEach(({ seats: row }) => {
    const line = Array(width).fill(' ');
    row.forEach((t) => {
      const col = Math.round((t.x - minX) / seatW);
      line[col] = pickIds.has(t.id) ? '*' : wantIds.has(t.id) ? 'o'
        : t.type === 3 ? 'w' : t.status === 2 ? '.' : 'x';
    });
    const nums = row.slice().sort((a, b) => a.x - b.x);
    const label = String(row[0].row).padStart(4);
    lines.push(`${label}  ${line.join('')}  ${String(row[0].row).padEnd(4)} ${nums[0].seat}→${nums[nums.length - 1].seat}`);
  });
  return lines.join('\n');
}

const COLORS = ['#f472b6', '#a78bfa', '#60a5fa', '#22d3ee', '#34d399', '#fb923c', '#f87171'];
function svgMap(fx, plan, pickIds, wantIds) {
  const seats = plan.seats;
  const minX = Math.min(...seats.map((t) => t.x)), maxX = Math.max(...seats.map((t) => t.x + t.w));
  const minY = Math.min(...seats.map((t) => t.y)), maxY = Math.max(...seats.map((t) => t.y + t.h));
  const pad = 30, W = maxX - minX + pad * 2, H = maxY - minY + pad * 2 + 20;
  const bySection = [...new Set(seats.map((t) => t.section))]
    .map((id) => ({ id, price: fx.prices[(plan.sections.find((x) => x.id === id) || {}).name?.trim()] ?? -1 }))
    .sort((a, b) => b.price - a.price);
  const color = new Map(bySection.map((x, i) => [x.id, COLORS[i % COLORS.length]]));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const parts = [`<line x1="${pad}" y1="12" x2="${W - pad}" y2="12" stroke="#cfd6e0" stroke-width="3"/>`];
  const rowsDone = new Set();
  seats.forEach((t) => {
    const x = t.x - minX + pad, y = t.y - minY + pad + 20;
    const free = t.status === 2;
    const fill = t.type === 3 ? '#475569' : free ? color.get(t.section) : '#1e293b';
    const stroke = pickIds.has(t.id) ? '#fff101' : wantIds.has(t.id) ? '#22c55e' : 'none';
    parts.push(`<g><title>Reihe ${esc(t.row)}, Platz ${esc(t.seat)}${t.aisle ? ' (Gang)' : ''}${free ? '' : ' – belegt'}</title>`
      + `<rect x="${x + 1}" y="${y + 1}" width="${t.w - 2}" height="${t.h - 2}" rx="3" fill="${fill}"`
      + ` opacity="${free || pickIds.has(t.id) ? 1 : 0.6}" stroke="${stroke}" stroke-width="${stroke === 'none' ? 0 : 3}"/>`
      + `<text x="${x + t.w / 2}" y="${y + t.h / 2 + 3.5}" font-size="${Math.min(10, t.w * 0.5)}" text-anchor="middle"`
      + ` fill="${free ? '#0b1220' : '#64748b'}">${esc(t.seat)}</text></g>`);
    const rk = `${t.row}@${Math.round(t.y)}`;
    if (!rowsDone.has(rk)) {
      rowsDone.add(rk);
      parts.push(`<text x="${pad - 8}" y="${y + t.h / 2 + 4}" font-size="11" text-anchor="end" fill="#94a3b8">${esc(t.row)}</text>`);
    }
  });
  const legend = bySection.map((x) => {
    const name = (plan.sections.find((s) => s.id === x.id) || {}).name || x.id;
    return `<span><i style="background:${color.get(x.id)}"></i>${esc(name)}${x.price >= 0 ? ` ${x.price.toFixed(2).replace('.', ',')} €` : ''}</span>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="max-width:${Math.min(900, W * 2)}px">${parts.join('')}</svg><div class="lg">${legend}</div>`;
}

// Makes a captured hall fuller: takes free seats until `fill` of all
// seats are taken, the middle and the rows a third in from the back
// first, as a hall fills in practice. Seeded, so a case shows the same
// hall every run.
function fillHall(plan, fill, seed) {
  let r = seed >>> 0;
  const rand = () => { r = (r + 0x6d2b79f5) >>> 0; let t = r; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const seats = plan.seats.filter((t) => t.type !== 3);
  const minX = Math.min(...seats.map((t) => t.x)), maxX = Math.max(...seats.map((t) => t.x + t.w));
  const minY = Math.min(...seats.map((t) => t.y)), maxY = Math.max(...seats.map((t) => t.y + t.h));
  const want = Math.round(seats.length * fill);
  const byId = new Map(plan.seats.map((t) => [t.id, t]));
  seats.filter((t) => t.status === 2)
    .map((t) => {
      const dx = Math.abs(t.x + t.w / 2 - (minX + maxX) / 2) / ((maxX - minX) / 2 || 1);
      const dy = Math.abs(t.y - (minY + (maxY - minY) * 0.67)) / ((maxY - minY) || 1);
      return { t, score: rand() * 1.2 - (dx * 0.7 + dy * 0.9) };
    })
    .sort((a, b) => b.score - a.score)
    .forEach(({ t }) => {
      // Bookings come in groups: a seat plus 0–3 neighbours to its right.
      let left = want - seats.filter((u) => u.status !== 2).length;
      for (let u = t, k = 1 + Math.floor(rand() * 4); u && u.status === 2 && k > 0 && left > 0; k--, left--) {
        u.status = 4;
        u = byId.get(u.right);
      }
    });
}

const filter = process.argv[2];
const cases = require('./best-seats.cases.js').filter((c) => !filter || c.id.includes(filter));
const html = [];
let failed = 0, passed = 0, review = 0;
const fixtures = new Map();

cases.forEach((c, i) => {
  if (!fixtures.has(c.fixture)) fixtures.set(c.fixture, loadFixture(c.fixture));
  const fx = fixtures.get(c.fixture);
  const plan = JSON.parse(JSON.stringify(fx.plan));
  (c.taken || []).forEach((rs) => {
    const [row, seat] = rs.split('-');
    const t = plan.seats.find((s) => String(s.row) === row && String(s.seat) === seat);
    if (!t) throw new Error(`case ${i + 1}: no seat ${rs} in ${c.fixture}`);
    t.status = 4;
  });
  if (c.fill) fillHall(plan, c.fill, c.seed || 1);
  plan.limit = c.n;
  const prefs = Object.assign({}, SEAT_PREFS_DEFAULT, c.prefs || {});
  const best = makeBest(SEAT_PREFS_DEFAULT, new Map(Object.entries(fx.prices)))(plan, c.n, prefs);
  const wants = c.expect == null ? [] : [].concat(c.expect).map(parsePick);
  const ok = wants.length ? wants.some((w) => samePick(best, w)) : null;
  const pickIds = new Set((best?.seats || []).map((t) => t.id));
  const wantIds = new Set();
  if (ok === false) {
    wants.forEach((w) => plan.seats.forEach((t) => {
      if (String(t.row) === w.row && w.seats.includes(String(t.seat))) wantIds.add(t.id);
    }));
  }
  const status = ok === null ? 'pick' : ok ? '  ok' : 'FAIL';
  if (ok === null) review++; else if (ok) passed++; else failed++;
  const title = `${c.id}  ·  ${fx.name}, ${c.n} Ticket${c.n > 1 ? 's' : ''}${c.fill ? `, ${Math.round(c.fill * 100)} % voll` : ''}`;
  const line = `${status}  ${title}: ${pickLabel(best)}`
    + (wants.length && !ok ? `   (expected ${[].concat(c.expect).join(' or ')})` : '')
    + (c.prefs ? `   prefs ${JSON.stringify(c.prefs)}` : '');
  console.log(line);
  if (ok !== true) console.log(textMap(plan, pickIds, wantIds) + '\n');
  html.push(`<section id="${c.id}" class="${ok === false ? 'fail' : ok ? 'ok' : ''}"><h2>${title}</h2>`
    + `<p><b>Pick:</b> Reihe ${pickLabel(best)}${best ? ` · cost ${best.cost.toFixed(2)}` : ''}`
    + (wants.length ? ` · <b>Expected:</b> ${[].concat(c.expect).join(' or ')} ${ok ? '✓' : '✗'}` : '')
    + (c.note ? ` · ${c.note}` : '') + `</p>${svgMap(fx, plan, pickIds, wantIds)}</section>`);
});

console.log(`\n${passed} ok, ${failed} failed, ${review} without expectation`);
console.log(`Text map: . free  x taken  w wheelchair  * pick  o expected`);
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'best-seats.html'), `<!doctype html><meta charset="utf-8"><title>Beste Plätze</title>
<style>body{background:#0b1220;color:#e2e8f0;font:14px system-ui,sans-serif;margin:24px}section{margin:0 0 40px}
h2{font-size:16px;margin:0 0 4px}section.fail h2{color:#f87171}section.ok h2{color:#4ade80}svg{display:block;width:100%;margin:8px 0}
nav{display:flex;flex-wrap:wrap;gap:4px 12px;margin:0 0 32px;font-size:12px}nav a{color:#93c5fd}
.lg span{margin-right:14px;font-size:12px;color:#94a3b8}.lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}</style>
<h1>Beste Plätze</h1><p>Defaults ${JSON.stringify(SEAT_PREFS_DEFAULT)}. Yellow outline = pick, green = expected (on failures). Screen at the top.</p>
<nav>${cases.map((c) => `<a href="#${c.id}">${c.id}</a>`).join('')}</nav>
${html.join('\n')}`);
console.log(`Report: ${path.relative(process.cwd(), path.join(outDir, 'best-seats.html'))}`);
if (failed) process.exitCode = 1;
