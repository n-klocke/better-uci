// Beste Plätze cases for test/best-seats.js. Each one runs bestSeatGroup
// on a captured seat plan (fixtures/seatplans/<fixture>.json).
//
//   fixture  file name in fixtures/seatplans, without .json
//   n        ticket count
//   expect   what a good pick is: 'Row seat-seat' ('7 4-5') or a seat list
//            ('7 4,5'), or an array of picks that are all fine. Leave it
//            null to only show the pick for review.
//   taken    optional extra taken seats, as 'row-seat' ('7-4'), to build
//            a fuller hall from a captured one
//   prefs    optional Gewichtung overrides ({ aisle: 0, depth: 50 }),
//            merged over SEAT_PREFS_DEFAULT
//   note     why this pick is expected, for later
//
// Fixtures are real plans captured 2026-10-07 with their real occupancy
// (bochum-kino6 and berlin-esg-kino5 are fairly full, most are near empty).

module.exports = [
  { fixture: 'berlin-esg-kino7', n: 2, expect: null },
  { fixture: 'berlin-esg-kino7', n: 4, expect: null },
  { fixture: 'berlin-esg-kino5', n: 2, expect: null },
  { fixture: 'berlin-esg-kino3', n: 2, expect: null },
  { fixture: 'berlin-esg-kino1', n: 2, expect: null },
  { fixture: 'berlin-esg-kino1', n: 4, expect: null },
  { fixture: 'bochum-kino2', n: 2, expect: null },
  { fixture: 'bochum-kino3', n: 2, expect: null },
  { fixture: 'bochum-kino6', n: 2, expect: null },
  { fixture: 'bochum-kino6', n: 4, expect: null },
  { fixture: 'dresden-kino1', n: 2, expect: null },
  { fixture: 'dresden-kino4', n: 2, expect: null },
  { fixture: 'dresden-kino4', n: 3, expect: null },
  { fixture: 'duesseldorf-kino1', n: 2, expect: null },
  { fixture: 'duesseldorf-kino4', n: 2, expect: null },
  { fixture: 'hh-mundsburg-kino3', n: 2, expect: null },
  { fixture: 'hh-mundsburg-kino5', n: 1, expect: null },
  { fixture: 'hh-mundsburg-kino5', n: 2, expect: null },
];
