/* Show Pig Tracker — page logic.
   Data comes from the Apps Script API (config.js → API_URL). All math is
   in calc.js; this file handles fetching, caching, forms, rendering and
   the chart. */
(function () {
  "use strict";
  const { todayStr, days, addDays, calc, isDateStr, normalizeShows } = PigCalc;
  const DEFAULTS = { name: "", shows: [{ name: "Show", date: "2026-12-06", min: 150, max: 280 }], taperPct: 100 };
  const CACHE_KEY = "pigtracker.cache.v1", BASIS_KEY = "pigtracker.basis", RANGE_KEY = "pigtracker.range";

  // ?api=http://localhost:8787/api overrides config.js (used by the tests).
  const apiOverride = new URLSearchParams(location.search).get("api");
  const apiUrl = apiOverride || (typeof API_URL === "string" ? API_URL : "");
  const connected = /^https?:\/\//.test(apiUrl) && !/PASTE_YOUR/.test(apiUrl);
  const allowDelete = typeof ALLOW_DELETE !== "undefined" && ALLOW_DELETE === true;
  const fcrT = (typeof FCR_THRESHOLDS !== "undefined" && FCR_THRESHOLDS) || null;
  let sheetUrl = (typeof SHEET_URL === "string" && /^https:\/\//.test(SHEET_URL)) ? SHEET_URL : "";

  const state = {
    weights: [], feeds: [], settings: { ...DEFAULTS },
    basis: "last", range: "all", selected: null, hover: null,
    updatedAt: null, fromCache: false, loaded: false, busy: false
  };
  try { const b = localStorage.getItem(BASIS_KEY); if (["last", "recent", "all"].includes(b)) state.basis = b; } catch (_) {}
  try { const r = localStorage.getItem(RANGE_KEY); if (["all", "6", "3"].includes(r)) state.range = r; } catch (_) {}

  // ---------- formatting ----------
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtD = s => { const [, m, d] = s.split("-").map(Number); return MON[m - 1] + " " + d; };
  const fmtDY = s => { const [y, m, d] = s.split("-").map(Number); return MON[m - 1] + " " + d + ", " + y; };
  const f1 = n => (Math.round(n * 10) / 10).toFixed(1);
  const f2 = n => (Math.round(n * 100) / 100).toFixed(2);
  const sign = n => (n > 0 ? "+" : n < 0 ? "−" : "") + f1(Math.abs(n));
  const $ = id => document.getElementById(id);
  const fmtAgo = ms => {
    const s = Math.round(ms / 1000);
    if (s < 45) return "just now";
    const m = Math.round(s / 60); if (m < 60) return m + " min ago";
    const h = Math.round(m / 60); if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    return Math.round(h / 24) + " days ago";
  };
  const fmtTime = t => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // ---------- data layer ----------
  function normalize(j) {
    const s = j.settings || {};
    const { shows, taperPct } = normalizeShows(s);
    return {
      weights: Array.isArray(j.weighins) ? j.weighins : [],
      feeds: Array.isArray(j.feed) ? j.feed : [],
      settings: {
        name: typeof s.name === "string" ? s.name : "",
        shows: shows.length ? shows : DEFAULTS.shows.map(x => ({ ...x })),
        taperPct,
        // true when the Apps Script predates multi-show settings (it then can't store them)
        legacyScript: !Array.isArray(s.shows)
      }
    };
  }
  function showSheetLink() {
    const a = $("sheetLink");
    if (sheetUrl) { a.href = sheetUrl; a.hidden = false; }
  }
  function applyData(j, at, fromCache) {
    const d = normalize(j);
    if (!sheetUrl && typeof j.sheetUrl === "string" && /^https:\/\/docs\.google\.com\//.test(j.sheetUrl)) { sheetUrl = j.sheetUrl; showSheetLink(); }
    state.weights = d.weights; state.feeds = d.feeds; state.settings = d.settings;
    state.updatedAt = at; state.fromCache = !!fromCache; state.loaded = true;
    if (!fromCache) { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at, data: j })); } catch (_) {} }
    fillSettings(); render();
  }
  async function api(body) {
    const res = body
      ? await fetch(apiUrl, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "text/plain;charset=utf-8" } })
      : await fetch(apiUrl + (apiUrl.includes("?") ? "&" : "?") + "action=all", { cache: "no-store" });
    let j;
    try { j = await res.json(); } catch (_) { throw new Error("The sheet returned something that isn't JSON (HTTP " + res.status + ")."); }
    if (!j || j.ok !== true) throw new Error((j && j.error) || "Request failed (HTTP " + res.status + ").");
    return j;
  }
  async function load() {
    if (!connected || state.busy) return;
    state.busy = true; $("refreshBtn").disabled = true; $("updated").textContent = "Refreshing…";
    try {
      const j = await api(null);
      applyData(j, Date.now(), false);
      $("netBanner").hidden = true;
    } catch (err) {
      const when = state.updatedAt ? "showing data from " + fmtTime(state.updatedAt) + "." : "nothing to show yet.";
      $("netBanner").textContent = "Couldn't reach the sheet — " + when + " (" + err.message + ")";
      $("netBanner").hidden = false;
    } finally { state.busy = false; $("refreshBtn").disabled = false; tickUpdated(); }
  }
  // In-memory fallback when API_URL isn't set (local preview only).
  function localWrite(kind, body) {
    const arr = kind === "weighins" ? state.weights : state.feeds;
    const dup = arr.find(x => x.date === body.date);
    if (dup) Object.assign(dup, body);
    else arr.push({ id: "m" + Math.random().toString(36).slice(2), ...body });
    state.loaded = true; render();
  }
  async function save(action, payload) {
    if (!connected) {
      if (action === "addWeighin") localWrite("weighins", { date: payload.date, lbs: payload.lbs });
      else if (action === "addFeed") localWrite("feed", { date: payload.date, lbs: payload.lbs, note: payload.note });
      else if (action === "saveSettings") { const n = normalizeShows(payload); state.settings = { name: payload.name, shows: n.shows, taperPct: n.taperPct }; render(); }
      else if (action === "delete") { const arr = payload.sheet === "Weighins" ? state.weights : state.feeds; const i = arr.findIndex(x => x.id === payload.id); if (i >= 0) arr.splice(i, 1); render(); }
      return;
    }
    const j = await api({ action, ...payload });
    applyData(j, Date.now(), false);
    $("netBanner").hidden = true;
  }

  // ---------- render ----------
  function tickUpdated() {
    const el = $("updated");
    if (!connected) { el.textContent = "Not connected · entries are not saved"; return; }
    if (state.busy) return;
    if (!state.updatedAt) { el.textContent = "Loading…"; return; }
    el.textContent = "Updated " + fmtAgo(Date.now() - state.updatedAt) + (state.fromCache ? " (cached)" : "");
  }
  function fcrClass(v) {
    if (!fcrT || v == null) return "";
    return v <= fcrT.good ? "fcr-good" : v <= fcrT.mid ? "fcr-mid" : "fcr-bad";
  }
  function render() {
    const s = state.settings, c = calc(state.weights, state.feeds, s, state.basis, todayStr());

    $("pigName").textContent = s.name || "Show Pig";
    document.title = (s.name ? s.name + " · " : "") + "Show Pig Tracker";
    const rangeTxt = sh => sh.min != null && sh.max != null ? (sh.min === sh.max ? sh.max + " lb" : sh.min + "–" + sh.max + " lb")
      : sh.max != null ? "max " + sh.max + " lb" : sh.min != null ? "min " + sh.min + " lb" : "no range";
    $("headSub").textContent = c.shows.map(sh => sh.name + " " + fmtD(sh.date) + " · " + rangeTxt(sh)).join("  ·  ") || "No show set";
    $("daysLeft").textContent = c.daysLeft;
    $("daysLeftLabel").textContent = c.allPassed ? "shows are done" : c.next ? (c.daysLeft === 1 ? "day to " : "days to ") + c.next.name : "days to show";
    $("projLabel").textContent = c.next ? "Projected weight · " + c.next.name + " " + fmtD(c.next.date) : "Projected show weight";

    // projection
    const pill = $("projPill");
    const showList = $("showList"); showList.innerHTML = "";
    if (c.proj != null && c.next) {
      $("projVal").textContent = f1(c.proj);
      pill.className = "pill " + c.next.status.level; pill.textContent = c.next.status.text;
      const basisTxt = { last: "the most recent weigh period", recent: "a trend line through the last 3 weigh-ins", all: "a trend line through every weigh-in" }[state.basis];
      let txt = "At " + f2(c.adg) + " lb/day (" + basisTxt + "), " + f1(c.last.lbs) + " lb on " + fmtD(c.last.date) +
        " becomes about " + f1(c.proj) + " lb in " + c.next.daysFromLast + (c.next.daysFromLast === 1 ? " day." : " days.");
      const later = c.shows.filter(sh => sh !== c.next && sh.proj != null);
      if (later.length && c.taperPct !== 100) txt += " After " + c.next.name + " the plan assumes " + c.taperPct + "% of that rate (" + f2(c.adg * c.taper) + " lb/day).";
      else if (later.length) txt += " The same rate is assumed after " + c.next.name + ".";
      $("projText").textContent = txt;
      // one line per upcoming show
      c.shows.filter(sh => !sh.passed).forEach(sh => {
        const li = document.createElement("li");
        const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = sh.name + " · " + fmtD(sh.date);
        const v = document.createElement("span"); v.className = "num"; v.textContent = sh.proj != null ? f1(sh.proj) + " lb" : "—";
        const rg = document.createElement("span"); rg.className = "rg"; rg.textContent = "range " + rangeTxt(sh);
        li.append(nm, v, rg);
        if (sh.status) { const p = document.createElement("span"); p.className = "pill " + sh.status.level; p.textContent = sh.status.text; li.appendChild(p); }
        showList.appendChild(li);
      });
    } else if (c.last && c.allPassed) {
      $("projVal").textContent = "—"; pill.className = "pill none"; pill.textContent = "Shows are done";
      $("projText").textContent = "Every show date has passed. Set a new show in settings to project again.";
    } else if (c.last && c.next && c.next.daysFromLast < 0) {
      $("projVal").textContent = "—"; pill.className = "pill none"; pill.textContent = "Weigh-in after show date";
      $("projText").textContent = "The last weigh-in is after " + c.next.name + "'s date. Check the dates in settings.";
    } else {
      $("projVal").textContent = "—"; pill.className = "pill none"; pill.textContent = "Need 2 weigh-ins";
      $("projText").textContent = "Log at least two weigh-ins to project the show weight.";
    }
    document.querySelectorAll(".seg[data-basis]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.basis === state.basis)));
    document.querySelectorAll(".seg[data-range]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.range === state.range)));

    // gain plan: the band of current daily gain that lands inside each show's range
    const plan = $("planRows"); plan.innerHTML = "";
    const bandTxt = b => {
      if (!b) return "—";
      const lo = b.lo == null || b.lo <= 0 ? null : b.lo, hi = b.hi == null ? null : b.hi;
      if (hi != null && hi < 0) return "already over · needs " + f2(hi) + " lb/day";
      if (lo != null && hi != null) return (lo <= hi ? f2(lo) + "–" + f2(hi) : "none") + " lb/day";
      if (hi != null) return "≤ " + f2(hi) + " lb/day";
      if (lo != null) return "≥ " + f2(lo) + " lb/day";
      return "any rate";
    };
    const row = (label, value, cls, sub) => {
      const r = document.createElement("div"); r.className = "need-row" + (cls ? " " + cls : "") + (sub ? " sub" : "");
      const a = document.createElement("span"); a.textContent = label;
      const b = document.createElement("span"); b.className = "num"; b.textContent = value;
      r.append(a, b); plan.appendChild(r); return b;
    };
    const upcoming = c.shows.filter(sh => sh.allowed);
    if (c.last && upcoming.length) {
      upcoming.forEach(sh => {
        const lbl = sh.name + " · " + sh.daysFromLast + " days" + (sh.rateMult !== 1 ? " · " + Math.round(sh.rateMult * 100) + "% after " + c.next.name : "");
        row(lbl, bandTxt(sh.allowed), "", upcoming.length > 1);
      });
      if (upcoming.length > 1) {
        const v = row("Both shows", c.band.feasible ? bandTxt(c.band) : "No single rate makes both", "band");
        if (!c.band.feasible) v.classList.add("bad");
      }
      if (c.adg != null && c.band && c.band.feasible) {
        const v = plan.querySelector(".band .num") || plan.querySelector(".num");
        const lo = c.band.lo == null ? -Infinity : c.band.lo, hi = c.band.hi == null ? Infinity : c.band.hi;
        v.classList.add(c.adg > hi || c.adg < lo ? "bad" : (hi - c.adg < 0.1 || c.adg - lo < 0.1) ? "warn" : "good");
      }
      // feed estimate for the middle of the band
      let mid = null;
      if (c.band && c.band.feasible) {
        const lo = c.band.lo == null || c.band.lo < 0 ? 0 : c.band.lo, hi = c.band.hi;
        mid = hi == null ? null : (lo + hi) / 2;
      }
      $("needFeed").textContent = (mid != null && mid > 0 && c.lastFcr != null) ? f2(mid * c.lastFcr) + " lb at " + f2(mid) + " lb/day" : "—";
    } else {
      row("Allowed daily gain", c.last ? "—" : "Log a weigh-in first");
      $("needFeed").textContent = "—";
    }
    $("curAdg").textContent = c.adg != null ? f2(c.adg) + " lb/day" : "—";
    $("planNote").textContent = c.taperPct !== 100 && upcoming.length > 1
      ? "Rates are the gain between now and " + c.next.name + "; the plan assumes " + c.taperPct + "% of that afterwards. Feed estimate = rate × latest feed conversion; a starting point, not a ration."
      : "Rates are daily gain from the last weigh-in. Feed estimate = rate × latest feed conversion; a starting point, not a ration.";

    // stats
    if (c.last) { $("sWeight").innerHTML = f1(c.last.lbs) + "<small>lb</small>"; $("sWeightD").textContent = "Weighed " + fmtD(c.last.date); }
    else { $("sWeight").textContent = "—"; $("sWeightD").textContent = "No weigh-ins yet"; }
    const lp = c.periods[c.periods.length - 1];
    if (lp) { $("sGain").innerHTML = sign(lp.gain) + "<small>lb</small>"; $("sGainD").textContent = f2(lp.adg) + " lb/day over " + lp.n + " days"; }
    else { $("sGain").textContent = "—"; $("sGainD").textContent = "Needs 2 weigh-ins"; }
    $("sFcr").textContent = c.lastFcr != null ? f2(c.lastFcr) : "—";
    $("sFcr").className = "v num " + fcrClass(c.lastFcr);
    $("sFcrD").textContent = c.lastFcr != null ? "lb feed per lb gain, last period" : "Needs feed + 2 weigh-ins";
    if (c.rateNow != null) {
      $("sFeed").innerHTML = f2(c.rateNow) + "<small>lb/day</small>";
      const next = c.F.find(f => f.date > c.today);
      $("sFeedD").textContent = next ? "Going to " + f2(next.lbs) + " on " + fmtD(next.date) : "Per day";
    } else { $("sFeed").textContent = "—"; $("sFeedD").textContent = "No feed amount set"; }

    // feed form default = current rate, unless the user has typed something
    const fl = $("fLbs");
    if (!fl.dataset.dirty && c.rateNow != null && document.activeElement !== fl) fl.value = f2(c.rateNow);

    // periods table (newest first)
    const tb = $("periodBody"); tb.innerHTML = "";
    $("periodEmpty").hidden = c.periods.length > 0;
    [...c.periods].reverse().forEach((p, i) => {
      const tr = document.createElement("tr"); if (i === 0) tr.className = "latest";
      const feedTxt = p.missing === p.n ? "—" : f1(p.feed) + (p.missing ? "*" : "");
      const cells = [
        ["txt", fmtD(p.a.date) + "–" + fmtD(p.b.date)], ["hide-sm", p.n], ["hide-sm", f1(p.a.lbs)], ["hide-sm", f1(p.b.lbs)],
        ["", sign(p.gain)], ["", f2(p.adg)], ["", feedTxt], [fcrClass(p.fcr), p.fcr != null ? f2(p.fcr) : "—"]
      ];
      for (const [cls, txt] of cells) { const td = document.createElement("td"); if (cls) td.className = cls; td.textContent = txt; tr.appendChild(td); }
      if (p.missing && p.missing < p.n) tr.title = p.missing + " day(s) before your first feed entry aren't counted";
      tb.appendChild(tr);
    });

    // lists
    const wl = $("weighList"); wl.innerHTML = "";
    if (!c.W.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "Log your first weigh-in to start the curve."; wl.appendChild(li); }
    [...c.W].reverse().forEach(w => {
      const li = document.createElement("li");
      const d = document.createElement("span"); d.className = "d"; d.textContent = fmtD(w.date);
      const v = document.createElement("span"); v.className = "w"; v.textContent = f1(w.lbs) + " lb";
      li.append(d, v);
      if (allowDelete) li.appendChild(delBtn("Weighins", w.id, w.date));
      wl.appendChild(li);
    });
    const fList = $("feedList"); fList.innerHTML = "";
    if (!c.F.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "Set a daily feed amount to start tracking feed : gain."; fList.appendChild(li); }
    [...c.F].reverse().forEach(f => {
      const li = document.createElement("li");
      const d = document.createElement("span"); d.className = "d"; d.textContent = fmtD(f.date);
      const w = document.createElement("span"); w.className = "w"; w.textContent = f2(f.lbs) + " lb/day";
      if (f.note) { const n = document.createElement("span"); n.className = "note"; n.textContent = f.note; w.appendChild(n); }
      li.append(d, w);
      if (f.date > c.today) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "Scheduled"; li.appendChild(t); }
      if (allowDelete) li.appendChild(delBtn("Feed", f.id, f.date));
      fList.appendChild(li);
    });

    drawChart(c);
    tickUpdated();
  }

  function delBtn(sheet, id, date) {
    const b = document.createElement("button"); b.className = "del"; b.type = "button"; b.textContent = "Delete";
    let t = null;
    b.onclick = async () => {
      if (!b.classList.contains("arm")) {
        b.classList.add("arm"); b.textContent = "Tap to confirm";
        t = setTimeout(() => { b.classList.remove("arm"); b.textContent = "Delete"; }, 3000); return;
      }
      clearTimeout(t); b.disabled = true; b.textContent = "Deleting…";
      try { await save("delete", { sheet, id, date }); }
      catch (err) { b.disabled = false; b.classList.remove("arm"); b.textContent = "Delete"; alert("Couldn't delete: " + err.message); }
    };
    return b;
  }

  // ---------- chart ----------
  let lastCalc = null;
  function pickStep(span, targets) { for (const t of targets) if (span / t <= 6) return t; return targets[targets.length - 1]; }

  function drawChart(c) {
    lastCalc = c;
    const svg = $("chart"), s = state.settings;
    const W = Math.max(300, Math.round(svg.parentNode.clientWidth || 720)), narrow = W < 520;
    const L = narrow ? 36 : 46, R = 12, T = 14, PB = narrow ? 190 : 210, FT = PB + 24, FB = PB + 60, XA = PB + 80;
    svg.setAttribute("viewBox", "0 0 " + W + " " + (XA + 8));
    const NS = "http://www.w3.org/2000/svg";
    svg.innerHTML = "";
    const el = (tag, attrs, txt, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (txt != null) e.textContent = txt; (parent || svg).appendChild(e); return e; };
    if (!c.W.length) {
      el("text", { x: W / 2, y: 150, "text-anchor": "middle" }, "Your weight curve appears after the first weigh-in");
      updateReadout();
      return;
    }
    // ----- range
    const zoomN = state.range === "all" ? 0 : Math.min(+state.range, c.W.length);
    const vis = zoomN ? c.W.slice(-zoomN) : c.W;
    let start, end;
    if (zoomN) {
      start = vis[0].date;
      const tail = c.today > c.last.date ? c.today : c.last.date;
      const pad = Math.max(2, Math.round(days(start, tail) * 0.15));
      start = addDays(start, -Math.max(1, Math.round(pad / 2))); end = addDays(tail, pad);
    } else {
      start = c.W[0].date;
      const lastDate = c.lastShow && c.lastShow.date > c.today ? c.lastShow.date : c.today;
      end = addDays(lastDate, 2);
    }
    const span = Math.max(1, days(start, end));
    const X = d => L + (days(start, d) / span) * (W - L - R);
    const inX = d => d >= start && d <= end;

    // ----- y scale: whole run frames target + projection; zoom frames only the visible weigh-ins
    const ys = vis.map(w => w.lbs);
    if (!zoomN) {
      const lowest = Math.min(...c.W.map(w => w.lbs));
      c.shows.forEach(sh => {
        if (sh.max != null) ys.push(sh.max);
        if (sh.min != null && sh.min >= lowest - 20) ys.push(sh.min); // a far-below min just runs off the bottom
        if (sh.proj != null) ys.push(sh.proj);
      });
    }
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const step = pickStep(Math.max(1, hi - lo), [1, 2, 5, 10, 20, 40, 100]);
    const margin = zoomN ? step * 0.6 : 5;
    lo = Math.floor((lo - margin) / step) * step; hi = Math.ceil((hi + margin) / step) * step;
    if (hi === lo) hi = lo + step;
    const Y = v => PB - (v - lo) / (hi - lo) * (PB - T);
    const inY = v => v >= lo && v <= hi;

    // clip for anything that may run past the plot edges when zoomed
    const defs = el("defs", {}); const cp = el("clipPath", { id: "plotClip" }, null, defs);
    el("rect", { x: L, y: 0, width: W - L - R, height: FB + 1 }, null, cp);
    const plot = el("g", { "clip-path": "url(#plotClip)" });

    const line = "var(--line)", ink3 = "var(--ink-3)";
    for (let v = lo; v <= hi + 1e-9; v += step) {
      el("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: line, "stroke-width": 1 });
      el("text", { x: L - 8, y: Y(v) + 4, "text-anchor": "end" }, Number.isInteger(step) ? Math.round(v) : v.toFixed(1));
    }
    const maxTicks = Math.max(3, Math.floor((W - L - R) / 62));
    let every = [1, 2, 3, 7, 14, 21, 28, 35, 42, 56, 70, 84].find(e => span / e <= maxTicks) || 84;
    const tick0 = every >= 7 ? 0 : 0;
    for (let k = tick0; k <= span; k += every) {
      const d = addDays(start, k);
      el("line", { x1: X(d), x2: X(d), y1: T, y2: FB, stroke: line, "stroke-width": 1, "stroke-dasharray": "2 4" });
      el("text", { x: X(d), y: XA, "text-anchor": "middle" }, fmtD(d));
    }
    if (inX(c.today)) {
      el("line", { x1: X(c.today), x2: X(c.today), y1: T, y2: FB, stroke: ink3, "stroke-width": 1 });
      el("text", { x: X(c.today) + 4, y: T + 10, "text-anchor": "start" }, "today");
    }
    // ----- show ranges: a band at each show date from min to max (open at the bottom if min is off-scale)
    const bandW = narrow ? 10 : 14;
    c.shows.forEach(sh => {
      if (!inX(sh.date) || (sh.min == null && sh.max == null)) return;
      const x = X(sh.date), top = sh.max != null ? Y(Math.min(sh.max, hi)) : T, bot = sh.min != null && inY(sh.min) ? Y(sh.min) : PB;
      el("rect", { x: x - bandW / 2, y: top, width: bandW, height: Math.max(2, bot - top), rx: 3, fill: "var(--good)", "fill-opacity": .18 });
      el("line", { x1: x - bandW / 2, x2: x + bandW / 2, y1: top, y2: top, stroke: "var(--good)", "stroke-width": 2.5 });
      if (sh.min != null && inY(sh.min)) el("line", { x1: x - bandW / 2, x2: x + bandW / 2, y1: bot, y2: bot, stroke: "var(--good)", "stroke-width": 2.5 });
      const lbl = (narrow ? "" : sh.name + " ") + (sh.min != null && sh.max != null && sh.min !== sh.max ? sh.min + "–" + sh.max : (sh.max != null ? sh.max : sh.min));
      const anchor = x < L + 120 ? "start" : "end", lx = anchor === "end" ? x - bandW / 2 - 6 : x + bandW / 2 + 6;
      sh._labelY = top - 6; sh._labelAnchor = anchor;
      el("text", { x: lx, y: top - 6, "text-anchor": anchor }, lbl).style.fill = "var(--good)";
    });
    // dashed ceiling for the next show's max
    if (c.next && c.next.max != null && inY(c.next.max) && !zoomN) {
      el("line", { x1: L, x2: W - R, y1: Y(c.next.max), y2: Y(c.next.max), stroke: "var(--good)", "stroke-width": 1, "stroke-dasharray": "6 4", "stroke-opacity": .7 });
    }
    // ----- projection: last weigh-in → each upcoming show (clipped when zoomed)
    if (c.proj != null) {
      const stops = c.shows.filter(sh => sh.proj != null);
      let px = X(c.last.date), py = Y(c.last.lbs);
      stops.forEach((sh, i) => {
        const x = X(sh.date), y = Y(sh.proj);
        el("line", { x1: px, y1: py, x2: x, y2: y, stroke: "var(--ribbon)", "stroke-width": 2.5, "stroke-dasharray": "7 5", "stroke-opacity": i === 0 ? 1 : .75 }, null, plot);
        if (!zoomN) {
          el("circle", { cx: x, cy: y, r: 5, fill: "var(--ribbon)" });
          // right of the point by default; the band label sits on the left, so they only meet at the right edge
          const anchor = x > W - 100 ? "end" : "start", lx = anchor === "end" ? x - 10 : x + 10;
          let ly = y - 8;
          // keep clear of every range label sitting at about the same height
          const bandYs = c.shows.map(o => o._labelY).filter(v => v != null);
          for (let guard = 0; guard < 3 && bandYs.some(by => Math.abs(ly - by) < 14); guard++) ly -= 14;
          if (ly < T + 10) ly = y + 16;
          const pl = el("text", { x: lx, y: ly, "text-anchor": anchor }, f1(sh.proj) + (i === 0 ? " projected" : ""));
          pl.style.fill = "var(--ribbon)";
        }
        px = x; py = y;
      });
    }
    // ----- weights
    const pts = c.W.map(w => X(w.date) + "," + Y(w.lbs));
    if (c.W.length > 1) {
      el("polygon", { points: X(c.W[0].date) + "," + PB + " " + pts.join(" ") + " " + X(c.last.date) + "," + PB, fill: "var(--ink)", "fill-opacity": .06 }, null, plot);
      el("polyline", { points: pts.join(" "), fill: "none", stroke: "var(--ink)", "stroke-width": 2.5, "stroke-linejoin": "round" }, null, plot);
    }
    const selDate = state.selected, hovDate = state.hover;
    c.W.forEach((w, i) => {
      if (!inX(w.date)) return;
      const isLast = i === c.W.length - 1, isSel = w.date === selDate, isHov = w.date === hovDate && !selDate;
      const x = X(w.date), y = Y(w.lbs);
      if (isSel || isHov) el("line", { x1: x, x2: x, y1: T, y2: PB, stroke: "var(--ribbon)", "stroke-width": 1, "stroke-dasharray": isSel ? "" : "3 3" });
      if (isSel) el("circle", { cx: x, cy: y, r: 10, fill: "var(--ribbon)", "fill-opacity": .18 });
      el("circle", { cx: x, cy: y, r: isLast || isSel ? 5.5 : 4, fill: isLast || isSel ? "var(--ink)" : "var(--surface)", stroke: isSel ? "var(--ribbon)" : "var(--ink)", "stroke-width": isSel ? 2.5 : 2 });
    });
    if (inX(c.last.date) && c.last.date !== selDate) el("text", { x: X(c.last.date), y: Y(c.last.lbs) - 12, "text-anchor": "middle" }, f1(c.last.lbs)).style.fill = "var(--ink)";
    if (selDate) {
      const w = c.W.find(p => p.date === selDate);
      if (w && inX(w.date)) {
        const x = X(w.date), anchor = x > W - 70 ? "end" : x < L + 40 ? "start" : "middle";
        const t = el("text", { x, y: Y(w.lbs) - 16, "text-anchor": anchor, "font-weight": "600" }, f1(w.lbs) + " lb · " + fmtD(w.date)); t.style.fill = "var(--ribbon)";
      }
    }

    // ----- feed strip
    el("text", { x: L - 8, y: FT + 4, "text-anchor": "end" }, "feed");
    el("line", { x1: L, x2: W - R, y1: FB, y2: FB, stroke: line });
    const rates = c.F.map(f => f.lbs);
    if (rates.length) {
      const fmax = Math.max(...rates) * 1.1 || 1, fmin = Math.min(0, Math.min(...rates));
      const FY = v => FB - (v - fmin) / (fmax - fmin) * (FB - FT);
      const inRange = [];
      const r0 = c.rateOn(start); if (r0 != null) inRange.push({ date: start, lbs: r0, carried: true });
      c.F.forEach(f => { if (f.date > start && f.date <= end) inRange.push(f); });
      let path = "";
      inRange.forEach((f, i) => {
        const x = X(f.date), y = FY(f.lbs);
        path += (i === 0 ? "M" + x + "," + y : " H" + x + " V" + y);
        el("text", { x: x + 4, y: y - 5, "text-anchor": "start" }, f2(f.lbs)).style.fill = "var(--feed)";
      });
      if (inRange.length) { path += " H" + (W - R); el("path", { d: path, fill: "none", stroke: "var(--feed)", "stroke-width": 2.5 }); }
    }

    // ----- hit targets. Per-point circles (keyboard reachable) sized so
    // neighbours never overlap, plus a nearest-point layer underneath so a
    // tap anywhere near the curve still picks the closest weigh-in.
    const visPts = c.W.filter(w => inX(w.date));
    let minGap = Infinity;
    for (let i = 1; i < visPts.length; i++) minGap = Math.min(minGap, X(visPts[i].date) - X(visPts[i - 1].date));
    const hitR = Math.max(6, Math.min(16, minGap / 2 - 1));
    const pickDate = d => { state.selected = state.selected === d ? null : d; state.hover = null; drawChart(lastCalc); };
    const nearest = px => { let best = null, bd = 24; for (const w of visPts) { const d = Math.abs(X(w.date) - px); if (d < bd) { bd = d; best = w; } } return best; };
    const svgX = e => { const r = svg.getBoundingClientRect(); return (e.clientX - r.left) * (W / r.width); };
    const layer = el("rect", { x: L, y: T, width: W - L - R, height: PB - T, fill: "transparent" });
    layer.addEventListener("click", e => { const w = nearest(svgX(e)); if (w) { e.stopPropagation(); pickDate(w.date); } });
    layer.addEventListener("pointermove", e => { if (e.pointerType !== "mouse" || state.selected) return; const w = nearest(svgX(e)); const d = w ? w.date : null; if (d !== state.hover) { state.hover = d; drawChart(lastCalc); } });
    layer.addEventListener("pointerleave", e => { if (e.pointerType === "mouse" && state.hover) { state.hover = null; drawChart(lastCalc); } });
    c.W.forEach((w, i) => {
      if (!inX(w.date)) return;
      const x = X(w.date), y = Y(w.lbs);
      const hit = el("circle", { class: "hit", cx: x, cy: y, r: hitR, tabindex: 0, role: "button",
        "aria-label": f1(w.lbs) + " lb on " + fmtDY(w.date) + (state.selected === w.date ? ", selected" : "") });
      el("circle", { class: "focus-ring", cx: x, cy: y, r: Math.min(12, hitR + 2) });
      const pick = () => pickDate(w.date);
      hit.addEventListener("click", e => { e.stopPropagation(); pick(); });
      hit.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      hit.addEventListener("pointerenter", e => { if (e.pointerType === "mouse" && !state.selected && state.hover !== w.date) { state.hover = w.date; drawChart(lastCalc); } });
      hit.addEventListener("pointerleave", e => { if (e.pointerType === "mouse" && state.hover === w.date) { state.hover = null; drawChart(lastCalc); } });
    });
    updateReadout();
  }
  $("chart").addEventListener("click", () => { if (state.selected) { state.selected = null; drawChart(lastCalc); } });

  function updateReadout() {
    const box = $("readout"); box.innerHTML = "";
    const c = lastCalc, date = state.selected || state.hover;
    const add = (cls, txt) => { const e = document.createElement(cls === "b" ? "b" : "span"); if (cls !== "b") e.className = cls; e.textContent = txt; box.appendChild(e); return e; };
    const sep = () => add("sep", "·");
    if (!c || !date) {
      add("hint", c && c.W.length ? "Tap a weigh-in on the chart for its details." : "Log your first weigh-in to start the curve.");
      return;
    }
    const i = c.W.findIndex(w => w.date === date); if (i < 0) { add("hint", "Tap a weigh-in on the chart for its details."); return; }
    const w = c.W[i], prev = c.W[i - 1], period = c.periods.find(p => p.b.date === w.date);
    add("b", f1(w.lbs) + " lb"); add("when", fmtDY(w.date));
    if (period) {
      sep(); add("", sign(period.gain) + " lb since " + fmtD(prev.date) + " (" + period.n + (period.n === 1 ? " day" : " days") + ")");
      sep(); add("", f2(period.adg) + " lb/day");
      if (period.missing < period.n) { sep(); add("", f1(period.feed) + (period.missing ? "*" : "") + " lb feed"); }
      if (period.fcr != null) { sep(); add("", "F:G " + f2(period.fcr)); }
    } else if (prev) {
      sep(); add("", "Same day as the previous weigh-in");
    } else {
      sep(); add("", "First weigh-in");
    }
    const next = c.W[i + 1];
    if (!next) { sep(); add("", days(w.date, c.today) === 0 ? "Today" : days(w.date, c.today) + " days ago"); }
  }

  // ---------- forms ----------
  function flash(id, txt, ok) {
    const m = $(id); m.textContent = txt; m.className = "msg " + (ok ? "ok" : "err");
    if (ok) setTimeout(() => { if (m.textContent === txt) m.textContent = ""; }, 5000);
  }
  async function submit(btn, msgId, action, payload, okText) {
    const label = btn.textContent; btn.disabled = true; btn.textContent = "Saving…";
    const m = $(msgId); m.textContent = ""; m.className = "msg";
    try { await save(action, payload); flash(msgId, okText, true); return true; }
    catch (err) { flash(msgId, "Couldn't save — " + err.message, false); return false; }
    finally { btn.disabled = false; btn.textContent = label; }
  }
  $("wDate").value = todayStr(); $("fDate").value = todayStr();
  $("fLbs").addEventListener("input", () => { $("fLbs").dataset.dirty = "1"; });

  $("weighForm").addEventListener("submit", async e => {
    e.preventDefault();
    const date = $("wDate").value, lbs = Math.round(parseFloat($("wLbs").value) * 10) / 10;
    if (!isDateStr(date)) return flash("wMsg", "Pick a date.", false);
    if (!(lbs >= 1 && lbs <= 1000)) return flash("wMsg", "Enter a weight between 1 and 1000 lb.", false);
    const existed = state.weights.some(w => w.date === date);
    const ok = await submit($("wBtn"), "wMsg", "addWeighin", { date, lbs },
      (existed ? "Updated " : "Saved ") + f1(lbs) + " lb on " + fmtD(date) + ".");
    if (ok) $("wLbs").value = "";
  });
  $("feedForm").addEventListener("submit", async e => {
    e.preventDefault();
    const date = $("fDate").value, lbs = Math.round(parseFloat($("fLbs").value) * 100) / 100, note = $("fNote").value.trim();
    if (!isDateStr(date)) return flash("fMsg", "Pick a start date.", false);
    if (!(lbs >= 0 && lbs <= 30)) return flash("fMsg", "Enter a daily amount between 0 and 30 lb.", false);
    const ok = await submit($("fBtn"), "fMsg", "addFeed", { date, lbs, note },
      "Feed set to " + f2(lbs) + " lb/day starting " + fmtD(date) + ".");
    if (ok) { $("fNote").value = ""; delete $("fLbs").dataset.dirty; }
  });
  $("setForm").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("sName").value.trim().slice(0, 40);
    const numOrNull = id => { const v = $(id).value.trim(); if (v === "") return null; const n = Math.round(parseFloat(v)); return Number.isFinite(n) ? n : NaN; };
    const readShow = (k, fallbackName) => ({ name: $(k + "Name").value.trim().slice(0, 40) || fallbackName, date: $(k + "Date").value, min: numOrNull(k + "Min"), max: numOrNull(k + "Max") });
    const s1 = readShow("s1", "First show"), s2 = readShow("s2", "Second show");
    if (!isDateStr(s1.date)) return flash("sMsg", "Pick a date for the first show.", false);
    const shows = [s1]; if (s2.date || s2.min != null || s2.max != null) { if (!isDateStr(s2.date)) return flash("sMsg", "Pick a date for the second show, or clear its fields.", false); shows.push(s2); }
    for (const sh of shows) {
      for (const k of ["min", "max"]) if (sh[k] != null && !(sh[k] >= 1 && sh[k] <= 1000)) return flash("sMsg", sh.name + ": weights must be between 1 and 1000 lb.", false);
      if (sh.min != null && sh.max != null && sh.min > sh.max) return flash("sMsg", sh.name + ": min is above max.", false);
    }
    if (shows.length === 2 && shows[1].date <= shows[0].date) return flash("sMsg", "The second show must be after the first.", false);
    const tv = $("sTaper").value.trim(); const taperPct = tv === "" ? 100 : Math.round(parseFloat(tv));
    if (!(taperPct >= 0 && taperPct <= 200)) return flash("sMsg", "Gain after first show must be 0–200%.", false);
    if (state.settings.legacyScript && connected) return flash("sMsg", "The Apps Script needs updating before shows can be saved: paste the new Code.gs and deploy a new version.", false);
    await submit($("sBtn"), "sMsg", "saveSettings", { name, shows, taperPct }, "Settings saved.");
  });
  function fillSettings() {
    const s = state.settings;
    if (document.activeElement && document.activeElement.form === $("setForm")) return; // don't clobber while editing
    $("sName").value = s.name || "";
    $("sTaper").value = s.taperPct === 100 ? "" : s.taperPct;
    [["s1", s.shows[0]], ["s2", s.shows[1]]].forEach(([k, sh]) => {
      $(k + "Name").value = sh ? sh.name : ""; $(k + "Date").value = sh ? sh.date : "";
      $(k + "Min").value = sh && sh.min != null ? sh.min : ""; $(k + "Max").value = sh && sh.max != null ? sh.max : "";
    });
  }
  document.querySelectorAll(".seg[data-basis]").forEach(b => b.addEventListener("click", () => {
    state.basis = b.dataset.basis; try { localStorage.setItem(BASIS_KEY, state.basis); } catch (_) {} render();
  }));
  document.querySelectorAll(".seg[data-range]").forEach(b => b.addEventListener("click", () => {
    state.range = b.dataset.range; try { localStorage.setItem(RANGE_KEY, state.range); } catch (_) {} render();
  }));
  $("refreshBtn").addEventListener("click", () => { load(); checkForUpdate(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { load(); checkForUpdate(); } });
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  setInterval(tickUpdated, 30000);

  // ---------- update check ----------
  // GitHub Pages lets phones cache index.html for a long time, so new
  // releases don't show up on their own. version.json is fetched fresh;
  // if it's newer than the page we're running, offer a one-tap update
  // that refetches the files past the cache and reloads.
  const pageVersion = parseInt(document.documentElement.dataset.version, 10) || 0;
  const SITE_FILES = ["index.html", "app.js", "calc.js", "config.js"];
  let newerVersion = null;
  async function checkForUpdate() {
    if (!pageVersion || location.protocol === "file:") return;
    try {
      const r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
      const j = await r.json();
      if (Number.isInteger(j.v) && j.v > pageVersion) { newerVersion = j.v; $("updateBanner").hidden = false; }
    } catch (_) { /* offline or not deployed: ignore */ }
  }
  async function applyUpdate() {
    const btn = $("updateBtn"); btn.disabled = true; btn.textContent = "Updating…";
    const v = newerVersion || Date.now();
    try {
      // cache: "reload" bypasses the cache and stores the fresh copy under the URL the page uses
      await Promise.all(SITE_FILES.map(f => fetch(f === "index.html" ? location.pathname : f + "?v=" + v, { cache: "reload" })));
      await fetch("./", { cache: "reload" }).catch(() => {});
    } catch (_) { /* fall through to reload anyway */ }
    location.reload();
  }
  $("updateBtn").addEventListener("click", applyUpdate);

  // ---------- boot ----------
  fillSettings(); render(); showSheetLink(); checkForUpdate();
  if (!connected) {
    $("configBanner").hidden = false; $("refreshBtn").hidden = true; tickUpdated();
  } else {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cached && cached.data && cached.data.ok) applyData(cached.data, cached.at, true);
    } catch (_) {}
    load();
  }
})();
