#!/usr/bin/env node
// Validates the claims in docs/API.md against real captured fixtures, using
// the actual parsing/grouping code from better-uci.user.js — not a copy of
// it. The userscript is a single self-contained IIFE, not built as a
// module, so it can't be require()'d directly in a browser; but under
// `node` (module.exports exists) it takes an early-return branch right
// after 'use strict' that exports the pure functions instead of running any
// of the browser-only init code. See that branch in better-uci.user.js for
// details.
//
// Run: node test/validate-fixtures.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseSeatStr, groupSeatsByRow, seatMapHTML } = require('../better-uci.user.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    process.exitCode = 1;
  }
}

function rowKey(row) {
  return String(row).replace(/^R/i, '');
}

// ---- load fixture ----
const fixturePath = path.join(__dirname, '..', 'fixtures', 'seatsAndTickets.sample.json');
const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const seats = [];
data.sections.forEach((s) => seats.push(...parseSeatStr(s.seatStr, s.id, s.name)));

console.log(`Loaded ${seats.length} seats from ${path.relative(process.cwd(), fixturePath)}\n`);

check('total seat count is 79', () => {
  assert.strictEqual(seats.length, 79);
});

check('42 seats are available (field[7]==="2")', () => {
  assert.strictEqual(seats.filter((s) => s.available).length, 42);
});

check('37 seats are not available', () => {
  assert.strictEqual(seats.filter((s) => !s.available).length, 37);
});

check('wheelchair seats (num 3, 4) are detected via row prefix, not field[7]', () => {
  const wc = seats.filter((s) => s.wheelchair);
  assert.strictEqual(wc.length, 2);
  assert.deepStrictEqual(wc.map((s) => s.num).sort(), [3, 4]);
  // both carry field[7]==="1", which would read as "unavailable" if this
  // script trusted field[7] alone for wheelchair seats — row-prefix
  // detection is what avoids that.
  wc.forEach((s) => assert.strictEqual(s.available, false));
});

check('"7" and "R7" merge into one row group, not two', () => {
  const pk3Seats = seats.filter((s) => s.sectionId === 4);
  const groups = groupSeatsByRow(pk3Seats);
  assert.ok(groups.has('7'), 'expected a "7" group');
  assert.ok(!groups.has('R7'), 'R7 should have merged into "7", not be its own group');
  const rawRows = [...groups.get('7').rawRows].sort();
  assert.deepStrictEqual(rawRows, ['7', 'R7']);
});

check('row grouping across the whole auditorium produces exactly 7 rows', () => {
  const groups = groupSeatsByRow(seats);
  assert.strictEqual(groups.size, 7);
  const ordered = [...groups.keys()].sort((a, b) => groups.get(a).minY - groups.get(b).minY);
  assert.deepStrictEqual(ordered, ['7', '6', '5', '4', '3', '2', '1']);
});

check('row numbering is one continuous sequence across the whole auditorium, not per-section', () => {
  // Confirmed against a real screenshot of the native map: rows read
  // 7,R7 / 6 / 5 / 4 / 3 / 2 / 1 top to bottom, with PK1's row "4" and
  // row "1" correctly NOT adjacent — PK1 LOGE's rows "3" and "2" sit
  // physically between them. seatMapHTML must sort every row globally by
  // minY (not group by section first, which was tried and reverted —
  // it broke this exact interleaving) to reproduce that.
  const groups = groupSeatsByRow(seats);
  const ordered = [...groups.keys()].sort((a, b) => groups.get(a).minY - groups.get(b).minY);
  const sectionSequence = ordered.map((key) => [...groups.get(key).sectionIds][0]);
  assert.deepStrictEqual(sectionSequence, [4, 4, 3, 2, 6, 6, 2],
    'expected PK3,PK3,PK2,PK1,LOGE,LOGE,PK1 top-to-bottom, with PK1 (id 2) split by LOGE (id 6) rows in between');
  // Every row group must belong to exactly one section — the color-coded
  // row labels in seatMapHTML assume this; a collision would silently
  // mislabel a row with the wrong section's color.
  ordered.forEach((key) => {
    assert.strictEqual(groups.get(key).sectionIds.size, 1,
      `row "${key}" spans ${groups.get(key).sectionIds.size} sections — expected exactly 1`);
  });
});

check('seat[0] (num) is continuous across rows within a section, not reset per row', () => {
  // PK3 row 7 is seats 1-10 (with gaps for R7), row 6 continues at 11-21.
  const row7Nums = seats.filter((s) => s.sectionId === 4 && rowKey(s.row) === '7').map((s) => s.num);
  const row6Nums = seats.filter((s) => s.sectionId === 4 && s.row === '6').map((s) => s.num);
  assert.strictEqual(Math.max(...row6Nums) > Math.max(...row7Nums), true,
    'row 6 seat numbers should be higher than row 7\'s — if this ever fails, the ' +
    'open tooltip-numbering question in docs/API.md may have flipped for this dataset');
});

check('colIndex (field[12]) resets independently per row, unlike seatNum', () => {
  const row7 = seats.filter((s) => s.sectionId === 4 && s.row === '7');
  const row6 = seats.filter((s) => s.sectionId === 4 && s.row === '6');
  const row7Min = Math.min(...row7.map((s) => +s.colIndex));
  const row6Max = Math.max(...row6.map((s) => +s.colIndex));
  assert.strictEqual(row7Min, 1, 'row 7 colIndex should reach down to 1');
  assert.strictEqual(row6Max, 11, 'row 6 colIndex should start as high as 11, independent of row 7');
});

check('wheelchair seats carry an R-prefixed colIndex, not a plain number', () => {
  const wc = seats.filter((s) => s.wheelchair);
  wc.forEach((s) => assert.ok(/^R\d+$/.test(s.colIndex), `seat ${s.num}'s colIndex "${s.colIndex}" should look like "R<n>"`));
});

check('every coupled (field[4]==="2") seat has exactly one coupled neighbor, never zero or two', () => {
  const byNum = new Map(seats.map((s) => [s.num, s]));
  seats.filter((s) => s.coupled).forEach((s) => {
    const leftCoupled = s.leftNeighbor !== 0 && byNum.get(s.leftNeighbor)?.coupled;
    const rightCoupled = s.rightNeighbor !== 0 && byNum.get(s.rightNeighbor)?.coupled;
    assert.strictEqual((leftCoupled ? 1 : 0) + (rightCoupled ? 1 : 0), 1,
      `seat ${s.num} (coupled) should have exactly one coupled neighbor`);
  });
});

check('PK3 row 7 seats "1"/"2" (Platz numbers, i.e. colIndex) render as a couple seat with no border between them', () => {
  const pk3 = seats.filter((s) => s.sectionId === 4);
  const platz1 = pk3.find((s) => s.row === '7' && s.colIndex === '1');
  const platz2 = pk3.find((s) => s.row === '7' && s.colIndex === '2');
  assert.ok(platz1 && platz2, 'expected to find row 7 Platz 1 and Platz 2');
  assert.strictEqual(platz1.coupled, true);
  assert.strictEqual(platz2.coupled, true);
  const html = seatMapHTML(pk3);
  const buttonFor = (num) => (html.match(new RegExp(`<button[^>]*data-num="${num}"[^>]*>`)) || [])[0];
  assert.ok(buttonFor(platz1.num)?.includes('border-left:none'),
    `seat ${platz1.num} (row 7, Platz 1) should render with border-left:none`);
  assert.ok(buttonFor(platz2.num)?.includes('border-right:none'),
    `seat ${platz2.num} (row 7, Platz 2) should render with border-right:none`);
});

check('isolated pair (seats 55/56) rounds only its outer edges, matching neighbor fields', () => {
  const s55 = seats.find((s) => s.num === 55);
  const s56 = seats.find((s) => s.num === 56);
  assert.strictEqual(s55.leftNeighbor, 0, 'seat 55 should have no left neighbor (round left)');
  assert.strictEqual(s55.rightNeighbor, 56, 'seat 55\'s right neighbor should be seat 56 (no rounding there)');
  assert.strictEqual(s56.leftNeighbor, 55, 'seat 56\'s left neighbor should be seat 55 (no rounding there)');
  assert.strictEqual(s56.rightNeighbor, 0, 'seat 56 should have no right neighbor (round right)');
});

check('every non-zero neighbor reference points to a seat that actually exists', () => {
  const numsBySection = new Map();
  seats.forEach((s) => {
    if (!numsBySection.has(s.sectionId)) numsBySection.set(s.sectionId, new Set());
    numsBySection.get(s.sectionId).add(s.num);
  });
  seats.forEach((s) => {
    const known = numsBySection.get(s.sectionId);
    if (s.leftNeighbor !== 0) assert.ok(known.has(s.leftNeighbor), `seat ${s.num}'s leftNeighbor ${s.leftNeighbor} doesn't exist in section ${s.sectionId}`);
    if (s.rightNeighbor !== 0) assert.ok(known.has(s.rightNeighbor), `seat ${s.num}'s rightNeighbor ${s.rightNeighbor} doesn't exist in section ${s.sectionId}`);
  });
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) console.log('Some checks FAILED — see above.');
