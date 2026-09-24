/* Local stand-in for the Apps Script API, used by the acceptance tests.
   Serves the static site from the repo root and the JSON API at /api,
   with the same semantics as Code.gs (upsert by date, validation).
   A debug endpoint POST /__set replaces the in-memory "sheet" so tests
   can simulate hand edits.  Usage: node test/mock-api.js [port] */
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PORT = +(process.argv[2] || process.env.PORT || 8787);

let sheet = fresh();
function fresh() { return { settings: { name: "", target: 290, showDate: "2026-12-06" }, feed: [], weighins: [] }; }
const id = p => p + "_" + Math.random().toString(36).slice(2, 10);
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const all = () => ({ ok: true, settings: sheet.settings, feed: sheet.feed, weighins: sheet.weighins, serverTime: new Date().toISOString() });

function handle(body) {
  const num = (v, lo, hi, m) => { const n = +v; if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(m); return Math.round(n * 100) / 100; };
  switch (body.action) {
    case "addFeed": {
      if (!isDate(body.date)) throw new Error("Date must be YYYY-MM-DD.");
      const lbs = num(body.lbs, 0, 30, "Feed amount must be between 0 and 30 lb/day.");
      const note = String(body.note || "").replace(/^[=+\-@\s]+/, "").slice(0, 80);
      const hit = sheet.feed.find(f => f.date === body.date);
      if (hit) { hit.lbs = lbs; hit.note = note; } else sheet.feed.push({ id: id("f"), date: body.date, lbs, note });
      break;
    }
    case "addWeighin": {
      if (!isDate(body.date)) throw new Error("Date must be YYYY-MM-DD.");
      const lbs = num(body.lbs, 1, 1000, "Weight must be between 1 and 1000 lb.");
      const hit = sheet.weighins.find(w => w.date === body.date);
      if (hit) hit.lbs = lbs; else sheet.weighins.push({ id: id("w"), date: body.date, lbs });
      break;
    }
    case "saveSettings":
      if (!isDate(body.showDate)) throw new Error("Date must be YYYY-MM-DD.");
      sheet.settings = { name: String(body.name || "").slice(0, 40), target: num(body.target, 1, 1000, "Target must be between 1 and 1000 lb."), showDate: body.showDate };
      break;
    case "delete": {
      const arr = body.sheet === "Feed" ? sheet.feed : body.sheet === "Weighins" ? sheet.weighins : null;
      if (!arr) throw new Error("sheet must be Feed or Weighins.");
      const i = arr.findIndex(x => x.id === body.id); if (i < 0) throw new Error("That entry is no longer in the sheet.");
      arr.splice(i, 1); break;
    }
    default: throw new Error("Unknown action: " + body.action);
  }
  return all();
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(obj)); };
  const readBody = () => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(b)); });
  if (url.pathname === "/api") {
    if (req.method === "GET") return send(200, url.searchParams.get("action") === "all" ? all() : { ok: false, error: "Unknown action" });
    return readBody().then(b => { try { send(200, handle(JSON.parse(b))); } catch (e) { send(200, { ok: false, error: e.message }); } });
  }
  if (url.pathname === "/__set" && req.method === "POST") return readBody().then(b => { sheet = b ? { ...fresh(), ...JSON.parse(b) } : fresh(); send(200, all()); });
  if (url.pathname === "/__get") return send(200, sheet);
  // static
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
});
server.listen(PORT, () => console.log("mock API + site at http://localhost:" + PORT + "/  (api: /api)"));
