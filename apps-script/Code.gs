/**
 * Show Pig Tracker — Google Apps Script backend.
 *
 * Paste this file into the Sheet's script editor (Extensions → Apps Script),
 * run setup() once, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). Put the /exec URL in config.js.
 *
 * Every code change needs Deploy → Manage deployments → Edit → New version,
 * or the /exec URL keeps serving the old code.
 */

var SHEET_FEED = "Feed";
var SHEET_WEIGH = "Weighins";
var SHEET_SETTINGS = "Settings";
var HEADERS = {
  Feed: ["Date", "LbsPerDay", "Note", "Id", "Created"],
  Weighins: ["Date", "Lbs", "Id", "Created"],
  Settings: ["Key", "Value"]
};
var DEFAULTS = { name: "", target: 290, showDate: "2026-12-06" };
var MAX_SHOWS = 2;

/** Run once from the editor to create the three tabs with headers. */
function setup() {
  ensureSheet_(SHEET_FEED);
  ensureSheet_(SHEET_WEIGH);
  var s = ensureSheet_(SHEET_SETTINGS);
  if (s.getLastRow() < 2) {
    s.getRange(2, 1, 6, 2).setValues([["PigName", ""], ["Show1Name", "Show"], ["Show1Date", DEFAULTS.showDate], ["Show1Min", 150], ["Show1Max", 280], ["TaperPct", 100]]);
    s.getRange(4, 2).setNumberFormat("@");
  }
}

// ---------------------------------------------------------------- HTTP

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || "all";
  try {
    if (action === "all") return json_(readAll_());
    return json_({ ok: false, error: "Unknown action: " + action });
  } catch (err) {
    return json_({ ok: false, error: msg_(err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "");
  } catch (err) {
    return json_({ ok: false, error: "Request body must be JSON." });
  }
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    return json_({ ok: false, error: "The sheet is busy. Try again in a moment." });
  }
  try {
    switch (body.action) {
      case "addFeed": upsertFeed_(body); break;
      case "addWeighin": upsertWeighin_(body); break;
      case "saveSettings": saveSettings_(body); break;
      case "delete": deleteRow_(body); break;
      default: return json_({ ok: false, error: "Unknown action: " + body.action });
    }
    SpreadsheetApp.flush();
    return json_(readAll_());
  } catch (err) {
    return json_({ ok: false, error: msg_(err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function msg_(err) { return String((err && err.message) || err); }

// ---------------------------------------------------------------- read

function readAll_() {
  return {
    ok: true,
    settings: readSettings_(),
    feed: readFeed_(),
    weighins: readWeighins_(),
    sheetUrl: SpreadsheetApp.getActive().getUrl(),
    serverTime: new Date().toISOString()
  };
}

function readFeed_() {
  var out = [];
  rows_(SHEET_FEED).forEach(function (r) {
    var date = toDateStr_(r.v[0]);
    var lbs = toNum_(r.v[1]);
    if (!date || lbs === null || lbs < 0) return;  // blank amount is NOT zero
    out.push({ id: idFor_(r.v[3], r.row), date: date, lbs: lbs, note: String(r.v[2] == null ? "" : r.v[2]) });
  });
  return out;
}

function readWeighins_() {
  var out = [];
  rows_(SHEET_WEIGH).forEach(function (r) {
    var date = toDateStr_(r.v[0]);
    var lbs = toNum_(r.v[1]);
    if (!date || lbs === null || lbs <= 0) return;
    out.push({ id: idFor_(r.v[2], r.row), date: date, lbs: lbs });
  });
  return out;
}

/**
 * Settings tab → { name, shows:[{name,date,min,max}], taperPct, target, showDate }.
 * Keys (case-insensitive): PigName, Show1Name, Show1Date, Show1Min, Show1Max,
 * Show2Name, ... , TaperPct. The old TargetLbs/ShowDate pair is still read
 * and becomes show 1 when no Show1Date exists. target/showDate are echoed
 * for older copies of the page.
 */
function readSettings_() {
  var kv = {};
  rows_(SHEET_SETTINGS).forEach(function (r) {
    var key = String(r.v[0] || "").trim().toLowerCase();
    if (key) kv[key] = r.v[1];
  });
  var s = { name: DEFAULTS.name, shows: [], taperPct: 100, target: DEFAULTS.target, showDate: DEFAULTS.showDate };
  if (kv.pigname != null) s.name = String(kv.pigname).slice(0, 40);
  for (var i = 1; i <= MAX_SHOWS; i++) {
    var d = toDateStr_(kv["show" + i + "date"]);
    if (!d) continue;
    var mn = toNum_(kv["show" + i + "min"]), mx = toNum_(kv["show" + i + "max"]);
    s.shows.push({
      name: String(kv["show" + i + "name"] == null ? "" : kv["show" + i + "name"]).slice(0, 40) || ("Show " + i),
      date: d,
      min: mn !== null && mn > 0 ? mn : null,
      max: mx !== null && mx > 0 ? mx : null
    });
  }
  if (!s.shows.length) {
    var ld = toDateStr_(kv.showdate), lt = toNum_(kv.targetlbs);
    if (ld) s.shows.push({ name: "Show", date: ld, min: lt !== null && lt > 0 ? lt : null, max: lt !== null && lt > 0 ? lt : null });
  }
  var tp = toNum_(kv.taperpct);
  if (tp !== null && tp >= 0 && tp <= 200) s.taperPct = tp;
  if (s.shows.length) {
    s.showDate = s.shows[0].date;
    if (s.shows[0].max !== null) s.target = s.shows[0].max;
  }
  return s;
}

/** Data rows (row 2 onward) as {row, v:[...]}; blank rows skipped. */
function rows_(name) {
  var sh = sheet_(name);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, HEADERS[name].length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var blank = vals[i].every(function (c) { return c === "" || c === null; });
    if (!blank) out.push({ row: i + 2, v: vals[i] });
  }
  return out;
}

function idFor_(cell, row) {
  var id = String(cell == null ? "" : cell).trim();
  return id || ("row:" + row);
}

// ---------------------------------------------------------------- write

function upsertFeed_(b) {
  var date = requireDate_(b.date);
  var lbs = requireNum_(b.lbs, 0, 30, "Feed amount must be between 0 and 30 lb/day.");
  var note = cleanNote_(b.note);
  var sh = ensureSheet_(SHEET_FEED);
  var hit = findByDate_(SHEET_FEED, date);
  if (hit) {
    sh.getRange(hit.row, 2, 1, 2).setValues([[lbs, note]]);
    if (!String(hit.v[3] || "").trim()) sh.getRange(hit.row, 4).setValue(newId_("f"));
  } else {
    var row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, 5).setValues([[dateValue_(date), lbs, note, newId_("f"), new Date().toISOString()]]);
    sh.getRange(row, 1).setNumberFormat("yyyy-mm-dd");
  }
}

function upsertWeighin_(b) {
  var date = requireDate_(b.date);
  var lbs = requireNum_(b.lbs, 1, 1000, "Weight must be between 1 and 1000 lb.");
  var sh = ensureSheet_(SHEET_WEIGH);
  var hit = findByDate_(SHEET_WEIGH, date);
  if (hit) {
    sh.getRange(hit.row, 2).setValue(lbs);
    if (!String(hit.v[2] || "").trim()) sh.getRange(hit.row, 3).setValue(newId_("w"));
  } else {
    var row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, 4).setValues([[dateValue_(date), lbs, newId_("w"), new Date().toISOString()]]);
    sh.getRange(row, 1).setNumberFormat("yyyy-mm-dd");
  }
}

function saveSettings_(b) {
  var name = String(b.name == null ? "" : b.name).replace(/^[=+\-@]+/, "").trim().slice(0, 40);
  var shows = Array.isArray(b.shows) ? b.shows : [];
  // Old page: { target, showDate } → one show with min = max = target
  if (!shows.length && b.showDate) shows = [{ name: "Show", date: b.showDate, min: b.target, max: b.target }];
  if (!shows.length) throw new Error("At least one show is required.");
  if (shows.length > MAX_SHOWS) throw new Error("At most " + MAX_SHOWS + " shows.");
  var clean = [];
  for (var i = 0; i < shows.length; i++) {
    var sh = shows[i] || {};
    var d = requireDate_(sh.date);
    var mn = sh.min === null || sh.min === undefined || sh.min === "" ? null : requireNum_(sh.min, 1, 1000, "Show weights must be between 1 and 1000 lb.");
    var mx = sh.max === null || sh.max === undefined || sh.max === "" ? null : requireNum_(sh.max, 1, 1000, "Show weights must be between 1 and 1000 lb.");
    if (mn !== null && mx !== null && mn > mx) throw new Error("A show's min is above its max.");
    if (i > 0 && d <= clean[i - 1].date) throw new Error("Shows must be in date order.");
    clean.push({ name: String(sh.name == null ? "" : sh.name).replace(/^[=+\-@]+/, "").trim().slice(0, 40) || ("Show " + (i + 1)), date: d, min: mn, max: mx });
  }
  var taper = b.taperPct === null || b.taperPct === undefined || b.taperPct === "" ? 100 : requireNum_(b.taperPct, 0, 200, "Gain after first show must be 0–200%.");
  var sh2 = ensureSheet_(SHEET_SETTINGS);
  setKey_(sh2, "PigName", name, "@");
  for (var k = 1; k <= MAX_SHOWS; k++) {
    var c = clean[k - 1];
    setKey_(sh2, "Show" + k + "Name", c ? c.name : "", "@");
    setKey_(sh2, "Show" + k + "Date", c ? c.date : "", "@");
    setKey_(sh2, "Show" + k + "Min", c && c.min !== null ? c.min : "", null);
    setKey_(sh2, "Show" + k + "Max", c && c.max !== null ? c.max : "", null);
  }
  setKey_(sh2, "TaperPct", taper, null);
  // keep the old keys in step for anything still reading them
  setKey_(sh2, "TargetLbs", clean[0].max !== null ? clean[0].max : "", null);
  setKey_(sh2, "ShowDate", clean[0].date, "@");
}

function setKey_(sh, key, value, fmt) {
  var rows = rows_(SHEET_SETTINGS);
  var row = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].v[0] || "").trim().toLowerCase() === key.toLowerCase()) { row = rows[i].row; break; }
  }
  if (row === null) { row = sh.getLastRow() + 1; sh.getRange(row, 1).setValue(key); }
  var cell = sh.getRange(row, 2);
  if (fmt) cell.setNumberFormat(fmt);
  cell.setValue(value);
}

function deleteRow_(b) {
  var name = b.sheet === "Feed" ? SHEET_FEED : b.sheet === "Weighins" ? SHEET_WEIGH : null;
  if (!name) throw new Error("sheet must be Feed or Weighins.");
  var id = String(b.id || "").trim();
  if (!id) throw new Error("Missing id.");
  var sh = sheet_(name);
  if (!sh) throw new Error("Sheet not found.");
  var idCol = name === SHEET_FEED ? 3 : 2;
  var date = b.date ? toDateStr_(b.date) : null;
  var rows = rows_(name);
  for (var i = 0; i < rows.length; i++) {
    if (idFor_(rows[i].v[idCol], rows[i].row) !== id) continue;
    // Row-number ids can go stale if rows were added or removed since the
    // page loaded, so double-check the date before deleting anything.
    if (date && toDateStr_(rows[i].v[0]) !== date) break;
    sh.deleteRow(rows[i].row);
    return;
  }
  throw new Error("That entry is no longer in the sheet. Refresh and try again.");
}

function findByDate_(name, date) {
  var rows = rows_(name);
  for (var i = 0; i < rows.length; i++) {
    if (toDateStr_(rows[i].v[0]) === date) return rows[i];
  }
  return null;
}

// ---------------------------------------------------------------- helpers

function sheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name); }

function ensureSheet_(name) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight("bold");
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function tz_() {
  return SpreadsheetApp.getActive().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
}

function pad_(n) { return (n < 10 ? "0" : "") + n; }

function ymd_(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  var dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return y + "-" + pad_(m) + "-" + pad_(d);
}

/**
 * Cell value → "YYYY-MM-DD" or null. Real date cells are formatted in the
 * spreadsheet's timezone (never via UTC). Text accepts 2026-09-20,
 * 9/20/2026, 9/20/26 and 9-20-2026.
 */
function toDateStr_(v) {
  if (v === null || v === undefined || v === "") return null;
  if (Object.prototype.toString.call(v) === "[object Date]") {
    if (isNaN(v.getTime())) return null;
    return Utilities.formatDate(v, tz_(), "yyyy-MM-dd");
  }
  if (typeof v === "number") { // spreadsheet serial (days since 1899-12-30)
    var d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return Utilities.formatDate(d, "UTC", "yyyy-MM-dd");
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) return ymd_(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})$/);
  if (m) { var y = +m[3]; if (y < 100) y += 2000; return ymd_(y, +m[1], +m[2]); }
  return null;
}

/** "YYYY-MM-DD" → Date at local midnight in the spreadsheet's timezone. */
function dateValue_(s) {
  return Utilities.parseDate(s, tz_(), "yyyy-MM-dd");
}

function toNum_(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  var n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return isFinite(n) ? n : null;
}

function requireDate_(v) {
  var d = toDateStr_(v);
  if (!d) throw new Error("Date must be YYYY-MM-DD.");
  return d;
}

function requireNum_(v, lo, hi, message) {
  var n = toNum_(v);
  if (n === null || n < lo || n > hi) throw new Error(message);
  return Math.round(n * 100) / 100;
}

/** Notes: ≤80 chars, no leading formula characters, no control characters. */
function cleanNote_(v) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/^[=+\-@\s]+/, "").trim().slice(0, 80);
}

function newId_(prefix) {
  return prefix + "_" + Utilities.getUuid().replace(/-/g, "").slice(0, 8);
}
