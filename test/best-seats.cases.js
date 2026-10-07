// Beste Plätze cases for test/best-seats.js. Each one runs bestSeatGroup
// on a captured seat plan (fixtures/seatplans/<fixture>.json).
//
//   fixture  file name in fixtures/seatplans, without .json
//   n        ticket count
//   expect   what a good pick is: 'Row seat-seat' ('7 4-5') or a seat list
//            ('7 4,5'), or an array of picks that are all fine. Leave it
//            null to only show the pick for review.
//   fill     optional: make the hall this full (0.5 = half), taking the
//            middle seats first, as a hall fills; seed varies the layout
//   taken    optional extra taken seats, as 'row-seat' ('7-4')
//   prefs    optional Gewichtung overrides ({ aisle: 0, depth: 50 }),
//            merged over SEAT_PREFS_DEFAULT
//   note     why this pick is expected, for later
//
// Each case gets an id: '<fixture> n<n>', plus ' <fill>%' when filled.
// Fixtures are real plans captured 2026-10-07 with their real occupancy
// (bochum-kino6 and berlin-esg-kino5 are fairly full, most are near empty).

// Cases with an expectation. They replace the review case with the same id.
const expected = [
  { fixture: 'berlin-esg-kino1', n: 2, expect: '5 7-8',
    note: 'closer to the middle, not the side block at the wall' },
];

const FIXTURES = [
  'berlin-esg-kino1', 'berlin-esg-kino3', 'berlin-esg-kino5', 'berlin-esg-kino7',
  'bochum-kino2', 'bochum-kino3', 'bochum-kino6',
  'dresden-kino1', 'dresden-kino4',
  'duesseldorf-kino1', 'duesseldorf-kino4',
  'hh-mundsburg-kino3', 'hh-mundsburg-kino5',
];
// Fuller versions of a spread of hall shapes: curved IMAX, small Luxe,
// big multi-block, loge.
const FILLED = ['berlin-esg-kino1', 'berlin-esg-kino7', 'bochum-kino2', 'dresden-kino4', 'duesseldorf-kino1', 'hh-mundsburg-kino5'];

const review = [];
FIXTURES.forEach((fixture) => [1, 2, 3, 4, 6].forEach((n) => review.push({ fixture, n, expect: null })));
FILLED.forEach((fixture) => [0.5, 0.75].forEach((fill) => [2, 4].forEach((n) => review.push({ fixture, n, fill, expect: null }))));

const id = (c) => `${c.fixture} n${c.n}${c.fill ? ` ${Math.round(c.fill * 100)}%` : ''}`;
const byId = new Map(review.map((c) => [id(c), c]));
expected.forEach((c) => byId.set(id(c), c));
module.exports = [...byId.entries()].map(([key, c]) => Object.assign({ id: key }, c));
