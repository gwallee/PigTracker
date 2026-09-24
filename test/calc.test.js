/* Unit tests for calc.js — run with: node --test test/ */
const test = require("node:test");
const assert = require("node:assert/strict");
const { calc, days, addDays, slope } = require("../calc.js");

const S = { name: "", target: 290, showDate: "2026-12-06" };
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
  assert.equal(r2(c.needAdg), r2((290 - 229.5) / 77));
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
  assert.equal(r2(c1.needAdg), r2(60.5 / 77));
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
