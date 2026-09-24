/* Tests for the pure helpers in apps-script/Code.gs (date parsing,
   validation, note sanitising) using stubs for the Apps Script globals. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const TZ = "America/Chicago";
const ctx = {
  SpreadsheetApp: { getActive: () => ({ getSpreadsheetTimeZone: () => TZ, getSheetByName: () => null }) },
  Session: { getScriptTimeZone: () => TZ },
  Utilities: {
    formatDate: (d, tz, fmt) => {
      assert.equal(fmt, "yyyy-MM-dd");
      const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
      const g = t => p.find(x => x.type === t).value;
      return g("year") + "-" + g("month") + "-" + g("day");
    },
    parseDate: (s, tz, fmt) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 6)); },
    getUuid: () => "0123456789abcdef0123456789abcdef"
  },
  LockService: {}, ContentService: {}
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8"), ctx);

// Midnight in Chicago on 2026-09-20 = 05:00Z (CDT)
const chicagoMidnight = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 5));

test("toDateStr_: real date cells use the spreadsheet timezone, not UTC", () => {
  assert.equal(ctx.toDateStr_(chicagoMidnight(2026, 9, 20)), "2026-09-20");
  assert.equal(ctx.toDateStr_(new Date(Date.UTC(2026, 0, 15, 6))), "2026-01-15"); // CST
  assert.equal(ctx.toDateStr_(new Date("invalid")), null);
});

test("toDateStr_: text dates in the common hand-typed formats", () => {
  assert.equal(ctx.toDateStr_("2026-09-20"), "2026-09-20");
  assert.equal(ctx.toDateStr_("2026-9-5"), "2026-09-05");
  assert.equal(ctx.toDateStr_("9/20/2026"), "2026-09-20");
  assert.equal(ctx.toDateStr_("9/20/26"), "2026-09-20");
  assert.equal(ctx.toDateStr_("09-20-2026"), "2026-09-20");
  assert.equal(ctx.toDateStr_(" 12/6/2026 "), "2026-12-06");
  assert.equal(ctx.toDateStr_("2026-09-20T05:00:00.000Z"), "2026-09-20");
});

test("toDateStr_: junk → null", () => {
  for (const v of ["", null, undefined, "soon", "2026-13-01", "2/30/2026", "20/9/2026"]) assert.equal(ctx.toDateStr_(v), null, String(v));
});

test("toDateStr_: spreadsheet serial numbers", () => {
  assert.equal(ctx.toDateStr_(46285), "2026-09-20");
});

test("toNum_: blank is null, not zero", () => {
  assert.equal(ctx.toNum_(""), null);
  assert.equal(ctx.toNum_(null), null);
  assert.equal(ctx.toNum_(0), 0);
  assert.equal(ctx.toNum_("4.25"), 4.25);
  assert.equal(ctx.toNum_("4.25 lb"), 4.25);
  assert.equal(ctx.toNum_("abc"), null);
});

test("requireNum_ enforces ranges from the spec", () => {
  assert.equal(ctx.requireNum_(229.5, 1, 1000, "x"), 229.5);
  assert.throws(() => ctx.requireNum_(0, 1, 1000, "Weight must be between 1 and 1000 lb."), /Weight/);
  assert.throws(() => ctx.requireNum_(1001, 1, 1000, "w"), /w/);
  assert.throws(() => ctx.requireNum_(31, 0, 30, "f"), /f/);
  assert.equal(ctx.requireNum_(0, 0, 30, "f"), 0);
  assert.throws(() => ctx.requireNum_("", 0, 30, "f"), /f/);
});

test("cleanNote_ strips formula prefixes and caps at 80", () => {
  assert.equal(ctx.cleanNote_("=HYPERLINK(\"x\")"), "HYPERLINK(\"x\")");
  assert.equal(ctx.cleanNote_("+1 more"), "1 more");
  assert.equal(ctx.cleanNote_("-2 lb"), "2 lb");
  assert.equal(ctx.cleanNote_("@import"), "import");
  assert.equal(ctx.cleanNote_("grower ration"), "grower ration");
  assert.equal(ctx.cleanNote_("a".repeat(100)).length, 80);
  assert.equal(ctx.cleanNote_(null), "");
  assert.equal(ctx.cleanNote_("line\nbreak"), "line break");
});

test("idFor_ falls back to the row number", () => {
  assert.equal(ctx.idFor_("w_abc", 7), "w_abc");
  assert.equal(ctx.idFor_("", 7), "row:7");
  assert.equal(ctx.idFor_(null, 7), "row:7");
});

test("newId_ shape", () => {
  assert.match(ctx.newId_("w"), /^w_[0-9a-f]{8}$/);
});
