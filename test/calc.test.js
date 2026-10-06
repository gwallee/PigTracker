/* Unit tests for calc.js — run with: node --test test/ */
const test = require("node:test");
const assert = require("node:assert/strict");
const { calc, days, addDays, slope, normalizeShows, rangeStatus } = require("../calc.js");

const S = { name: "", target: 290, showDate: "2026-12-06" }; // legacy single-target settings
const TWO = { name: "Hamlet", taperPct: 85, shows: [
  { name: "Williamson County", date: "2026-12-06", min: 150, max: 280 },
  { name: "San Antonio", date: "2027-02-22", min: 250, max: 300 }
] };
const r2 = n => Math.round(n * 100) / 100;

test("date helpers use UTC day math", () => {
  assert.equal(days("2026-08-30", "2026-09-06"), 7);
  assert.equal(addDays("2026-08-30", 7), "2026-09-06");
  assert.equal(days("2026-03-07", "2026-03-09"), 2); // across US DST change
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("SPEC §8: feed 4.00 from 8/20, four weekly weigh-ins", () => {
  const feeds = [{ date: "2026-08-20", lbs: 4 }];
  const weights = [
    { date: "2026-08-30", lbs: 212 }, { date: "2026-09-06", lbs: 218 },
    { date: "2026-09-13", lbs: 223.5 }, { date: "2026-09-20", lbs: 229.5 }
  ];
  const c = calc(weights, feeds, S, "last", "2026-09-23");
  assert.equal(c.periods.length, 3);
  const p = c.periods[2];
  assert.equal(p.gain, 6);
  assert.equal(r2(p.adg), 0.86);
  assert.equal(p.feed, 28);
  assert.equal(p.missing, 0);
  assert.equal(r2(p.fcr), 4.67);
  assert.equal(c.lastFcr, p.fcr);
  // projection from the last period: 229.5 + 0.857 × 77 days
  assert.equal(c.daysToShow, 77);
  assert.equal(r2(c.proj), r2(229.5 + (6 / 7) * 77));
  assert.equal(r2(c.band.hi), r2((290 - 229.5) / 77)); // legacy target → min = max = target
  assert.equal(r2(c.band.lo), r2((290 - 229.5) / 77));
  assert.equal(c.rateNow, 4);
  assert.equal(c.daysLeft, 74);
});

test("SPEC §8: feed change mid-period is summed day by day", () => {
  const feeds = [{ date: "2026-08-20", lbs: 4 }, { date: "2026-09-16", lbs: 4.25 }];
  const weights = [{ date: "2026-09-13", lbs: 223.5 }, { date: "2026-09-20", lbs: 229.5 }];
  const c = calc(weights, feeds, S, "last", "2026-09-23");
  // 9/13,14,15 at 4.00 (3 days) + 9/16..19 at 4.25 (4 days)
  assert.equal(r2(c.periods[0].feed), r2(3 * 4 + 4 * 4.25));
});

test("row order in the sheet doesn't matter", () => {
  const feeds = [{ date: "2026-09-16", lbs: 4.25 }, { date: "2026-08-20", lbs: 4 }];
  const weights = [{ date: "2026-09-20", lbs: 229.5 }, { date: "2026-08-30", lbs: 212 }, { date: "2026-09-13", lbs: 223.5 }, { date: "2026-09-06", lbs: 218 }];
  const c = calc(weights, feeds, S, "last", "2026-09-23");
  assert.deepEqual(c.W.map(w => w.date), ["2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20"]);
  assert.equal(c.periods.length, 3);
  assert.equal(c.periods[2].gain, 6);
});

test("days before the first feed entry count as missing", () => {
  const feeds = [{ date: "2026-09-16", lbs: 4 }];
  const weights = [{ date: "2026-09-13", lbs: 223.5 }, { date: "2026-09-20", lbs: 229.5 }];
  const p = calc(weights, feeds, S, "last", "2026-09-23").periods[0];
  assert.equal(p.missing, 3);
  assert.equal(p.feed, 16);
  assert.equal(r2(p.fcr), r2(16 / 6)); // shown with * on the page
  const none = calc(weights, [], S, "last", "2026-09-23").periods[0];
  assert.equal(none.missing, 7);
  assert.equal(none.fcr, null);
});

test("no F:G when gain is zero or negative", () => {
  const feeds = [{ date: "2026-08-20", lbs: 4 }];
  const weights = [{ date: "2026-09-13", lbs: 230 }, { date: "2026-09-20", lbs: 229 }];
  assert.equal(calc(weights, feeds, S, "last", "2026-09-23").periods[0].fcr, null);
});

test("projection bases", () => {
  const weights = [{ date: "2026-08-30", lbs: 212 }, { date: "2026-09-06", lbs: 218 }, { date: "2026-09-13", lbs: 223.5 }, { date: "2026-09-20", lbs: 229.5 }];
  const last = calc(weights, [], S, "last", "2026-09-23").adg;
  const recent = calc(weights, [], S, "recent", "2026-09-23").adg;
  const all = calc(weights, [], S, "all", "2026-09-23").adg;
  assert.equal(r2(last), 0.86);
  assert.equal(r2(recent), r2(slope(weights.slice(-3))));
  assert.equal(r2(all), r2(slope(weights)));
  assert.equal(r2(slope([{ date: "2026-01-01", lbs: 100 }, { date: "2026-01-11", lbs: 110 }])), 1);
});

test("fewer than two weigh-ins → no projection, one weigh-in still gives 'need' numbers", () => {
  const c0 = calc([], [], S, "last", "2026-09-23");
  assert.equal(c0.proj, null); assert.equal(c0.last, null); assert.equal(c0.daysLeft, 74);
  const c1 = calc([{ date: "2026-09-20", lbs: 229.5 }], [], S, "last", "2026-09-23");
  assert.equal(c1.proj, null); assert.equal(c1.adg, null);
  assert.equal(r2(c1.band.hi), r2(60.5 / 77));
});

test("after show day: no projection, countdown floors at 0", () => {
  const weights = [{ date: "2026-12-01", lbs: 280 }, { date: "2026-12-08", lbs: 286 }];
  const c = calc(weights, [], S, "last", "2026-12-09");
  assert.equal(c.proj, null);
  assert.equal(c.daysToShow, -2);
  assert.equal(c.daysLeft, 0);
  assert.equal(c.showPassed, true);
});

test("garbage rows are ignored", () => {
  const weights = [{ date: "2026-09-20", lbs: 229.5 }, { date: "bad", lbs: 5 }, { date: "2026-09-13", lbs: "" }, null, { date: "2026-09-06", lbs: "218" }];
  const feeds = [{ date: "2026-08-20", lbs: "4" }, { date: "2026-08-21", lbs: null }];
  const c = calc(weights, feeds, S, "last", "2026-09-23");
  assert.equal(c.W.length, 2); assert.equal(c.F.length, 1);
  assert.equal(c.periods[0].n, 14);
});

test("scheduled feed changes aren't applied before their date", () => {
  const feeds = [{ date: "2026-08-20", lbs: 4 }, { date: "2026-09-28", lbs: 4.25 }];
  const c = calc([{ date: "2026-09-20", lbs: 229.5 }], feeds, S, "last", "2026-09-23");
  assert.equal(c.rateNow, 4);
  assert.equal(c.rateOn("2026-09-28"), 4.25);
  assert.equal(c.rateOn("2026-08-19"), null);
});

// ---------------------------------------------------------------- two shows

const RUN = [["2026-08-30", 212], ["2026-09-06", 218], ["2026-09-13", 223.5], ["2026-09-20", 229.5], ["2026-09-27", 235], ["2026-10-04", 241.5]]
  .map(([date, lbs]) => ({ date, lbs }));

test("normalizeShows: new shape, sorting, legacy fallback and taper bounds", () => {
  const n = normalizeShows(TWO);
  assert.equal(n.shows.length, 2); assert.equal(n.shows[0].name, "Williamson County"); assert.equal(n.taperPct, 85);
  const unsorted = normalizeShows({ shows: [TWO.shows[1], TWO.shows[0]] });
  assert.equal(unsorted.shows[0].date, "2026-12-06");
  const legacy = normalizeShows(S);
  assert.deepEqual(legacy.shows, [{ name: "Show", date: "2026-12-06", min: 290, max: 290 }]);
  assert.equal(legacy.taperPct, 100);
  assert.equal(normalizeShows({ shows: [{ name: "x", date: "nope" }] }).shows.length, 0);
  assert.equal(normalizeShows({ shows: TWO.shows, taperPct: 500 }).taperPct, 100);
  const blankRange = normalizeShows({ shows: [{ date: "2026-12-06", min: "", max: "" }] }).shows[0];
  assert.equal(blankRange.min, null); assert.equal(blankRange.max, null); assert.equal(blankRange.name, "Show 1");
});

test("piecewise projection: current rate to show 1, tapered rate to show 2", () => {
  const c = calc(RUN, [], TWO, "last", "2026-10-06");
  const adg = 6.5 / 7;
  assert.equal(r2(c.adg), r2(adg));
  const [w, sa] = c.shows;
  assert.equal(w.daysFromLast, 63); assert.equal(w.effDays, 63); assert.equal(w.rateMult, 1);
  assert.equal(r2(w.proj), r2(241.5 + adg * 63));
  assert.equal(sa.daysFromLast, 141); assert.equal(sa.rateMult, 0.85);
  assert.equal(r2(sa.effDays), r2(63 + 78 * 0.85));
  assert.equal(r2(sa.proj), r2(241.5 + adg * (63 + 78 * 0.85)));
  assert.equal(c.next, w); assert.equal(c.proj, w.proj); assert.equal(c.daysLeft, 61);
  // with no taper the second leg runs at the same rate
  const flat = calc(RUN, [], { ...TWO, taperPct: 100 }, "last", "2026-10-06");
  assert.equal(r2(flat.shows[1].proj), r2(241.5 + adg * 141));
});

test("allowed gain band per show and the intersection for both", () => {
  const c = calc(RUN, [], TWO, "last", "2026-10-06");
  const [w, sa] = c.shows;
  assert.equal(r2(w.allowed.hi), r2((280 - 241.5) / 63));
  assert.ok(w.allowed.lo < 0); // 150 lb min is already behind us
  assert.equal(r2(sa.allowed.hi), r2((300 - 241.5) / sa.effDays));
  assert.equal(r2(sa.allowed.lo), r2((250 - 241.5) / sa.effDays));
  assert.equal(c.band.feasible, true);
  assert.equal(r2(c.band.lo), r2(sa.allowed.lo));
  assert.equal(r2(c.band.hi), r2(Math.min(w.allowed.hi, sa.allowed.hi)));
  // impossible pair: must stay under 245 at show 1 but reach 300 at show 2
  const bad = calc(RUN, [], { shows: [{ name: "A", date: "2026-12-06", max: 245 }, { name: "B", date: "2027-02-22", min: 300 }], taperPct: 100 }, "last", "2026-10-06");
  assert.equal(bad.band.feasible, false);
});

test("after show 1 passes: no taper, show 2 is next, show 1 reports as passed", () => {
  const later = RUN.concat([{ date: "2026-12-10", lbs: 275 }, { date: "2026-12-17", lbs: 279 }]);
  const c = calc(later, [], TWO, "last", "2026-12-18");
  assert.equal(c.shows[0].passed, true); assert.equal(c.shows[0].proj, null);
  assert.equal(c.next.name, "San Antonio"); assert.equal(c.next.rateMult, 1);
  assert.equal(c.next.effDays, days("2026-12-17", "2027-02-22"));
  assert.equal(r2(c.proj), r2(279 + (4 / 7) * c.next.effDays));
  const done = calc(later, [], TWO, "last", "2027-03-01");
  assert.equal(done.allPassed, true); assert.equal(done.next, null); assert.equal(done.proj, null); assert.equal(done.daysLeft, 0);
});

test("range status leans on the max", () => {
  const sh = { min: 250, max: 300 };
  assert.equal(rangeStatus(310, sh).level, "bad"); assert.match(rangeStatus(310, sh).text, /10\.0 lb over max/);
  assert.equal(rangeStatus(240, sh).level, "bad"); assert.match(rangeStatus(240, sh).text, /10\.0 lb under min/);
  assert.equal(rangeStatus(297, sh).level, "warn"); assert.match(rangeStatus(297, sh).text, /3\.0 lb from max/);
  assert.equal(rangeStatus(253, sh).level, "warn");
  assert.equal(rangeStatus(275, sh).level, "good"); assert.equal(rangeStatus(275, sh).text, "In range");
  assert.equal(rangeStatus(283, { min: null, max: 280 }).level, "bad");
  assert.equal(rangeStatus(100, { min: null, max: 280 }).level, "good");
  const single = { min: 290, max: 290 };
  assert.equal(rangeStatus(293, single).level, "good"); assert.equal(rangeStatus(296, single).level, "bad"); assert.match(rangeStatus(296, single).text, /over$/);
});
