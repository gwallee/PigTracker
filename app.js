/* Show Pig Tracker — page logic.
   Data comes from the Apps Script API (config.js → API_URL). All math is
   in calc.js; this file handles fetching, caching, forms, rendering and
   the chart. */
(function () {
  "use strict";
  const { todayStr, days, addDays, calc, isDateStr } = PigCalc;
  const DEFAULTS = { name: "", target: 290, showDate: "2026-12-06" };
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
    const target = Number(s.target);
    return {
      weights: Array.isArray(j.weighins) ? j.weighins : [],
      feeds: Array.isArray(j.feed) ? j.feed : [],
      settings: {
        name: typeof s.name === "string" ? s.name : "",
        target: Number.isFinite(target) && target > 0 ? target : DEFAULTS.target,
        showDate: isDateStr(s.showDate) ? s.showDate : DEFAULTS.showDate
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
      else if (action === "saveSettings") { state.settings = { name: payload.name, target: payload.target, showDate: payload.showDate }; render(); }
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
    $("headSub").textContent = "Target " + s.target + " lb · Show " + fmtDY(s.showDate);
    $("daysLeft").textContent = c.daysLeft;
    $("daysLeftLabel").textContent = c.showPassed ? "show day passed" : c.daysLeft === 1 ? "day to show" : "days to show";
    $("projDate").textContent = fmtD(s.showDate);
    $("needTarget").textContent = s.target;

    // projection
    const pill = $("projPill");
    if (c.proj != null) {
      $("projVal").textContent = f1(c.proj);
      const diff = c.proj - s.target;
      if (Math.abs(diff) <= 5) { pill.className = "pill good"; pill.textContent = "On target (" + sign(diff) + " lb)"; }
      else if (diff > 0) { pill.className = "pill warn"; pill.textContent = f1(diff) + " lb over"; }
      else { pill.className = "pill bad"; pill.textContent = f1(-diff) + " lb under"; }
      const basisTxt = { last: "the most recent weigh period", recent: "a trend line through the last 3 weigh-ins", all: "a trend line through every weigh-in" }[state.basis];
      $("projText").textContent = "At " + f2(c.adg) + " lb/day (" + basisTxt + "), " + f1(c.last.lbs) + " lb on " + fmtD(c.last.date) +
        " becomes about " + f1(c.proj) + " lb in " + c.daysToShow + (c.daysToShow === 1 ? " day." : " days.");
    } else if (c.last && c.daysToShow < 0) {
      $("projVal").textContent = "—"; pill.className = "pill none"; pill.textContent = "Show day has passed";
      $("projText").textContent = "The last weigh-in is after the show date. Update the show date in settings to project again.";
    } else {
      $("projVal").textContent = "—"; pill.className = "pill none"; pill.textContent = "Need 2 weigh-ins";
      $("projText").textContent = "Log at least two weigh-ins to project the show weight.";
    }
    document.querySelectorAll(".seg[data-basis]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.basis === state.basis)));
    document.querySelectorAll(".seg[data-range]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.range === state.range)));

    if (c.last && c.daysToShow > 0) {
      const g = s.target - c.last.lbs;
      $("needGain").textContent = sign(g) + " lb";
      $("needAdg").textContent = f2(c.needAdg) + " lb/day";
      $("needFeed").textContent = (c.lastFcr != null && c.needAdg > 0) ? f2(c.needAdg * c.lastFcr) + " lb" : "—";
    } else { $("needGain").textContent = "—"; $("needAdg").textContent = "—"; $("needFeed").textContent = "—"; }
    $("curAdg").textContent = c.adg != null ? f2(c.adg) + " lb/day" : "—";

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
      end = s.showDate > c.today ? addDays(s.showDate, 2) : addDays(c.today, 2);
    }
    const span = Math.max(1, days(start, end));
    const X = d => L + (days(start, d) / span) * (W - L - R);
    const inX = d => d >= start && d <= end;

    // ----- y scale: whole run frames target + projection; zoom frames only the visible weigh-ins
    const ys = vis.map(w => w.lbs);
    if (!zoomN) { ys.push(s.target); if (c.proj != null) ys.push(c.proj); }
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
    // ----- target
    if (inY(s.target)) {
      el("line", { x1: L, x2: W - R, y1: Y(s.target), y2: Y(s.target), stroke: "var(--good)", "stroke-width": 1.5, "stroke-dasharray": "6 4" });
      if (inX(s.showDate)) {
        el("circle", { cx: X(s.showDate), cy: Y(s.target), r: 6, fill: "var(--surface)", stroke: "var(--good)", "stroke-width": 2.5 });
        el("text", { x: X(s.showDate) - 10, y: Y(s.target) - 10, "text-anchor": "end" }, s.target + " lb target").style.fill = "var(--good)";
      } else {
        el("text", { x: W - R, y: Y(s.target) - 6, "text-anchor": "end" }, s.target + " lb target").style.fill = "var(--good)";
      }
    }
    // ----- projection (clipped when zoomed)
    if (c.proj != null) {
      el("line", { x1: X(c.last.date), y1: Y(c.last.lbs), x2: X(s.showDate), y2: Y(c.proj), stroke: "var(--ribbon)", "stroke-width": 2.5, "stroke-dasharray": "7 5" }, null, plot);
      if (!zoomN) {
        el("circle", { cx: X(s.showDate), cy: Y(c.proj), r: 5, fill: "var(--ribbon)" });
        const pl = el("text", { x: X(s.showDate) - 10, y: Y(c.proj) + (c.proj >= s.target ? -10 : 18), "text-anchor": "end" }, f1(c.proj) + " projected");
        pl.style.fill = "var(--ribbon)";
        if (Math.abs(Y(c.proj) - Y(s.target)) < 16) pl.setAttribute("y", c.proj >= s.target ? Y(s.target) - 24 : Y(s.target) + 30);
      }
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

    // ----- hit targets (on top, ≥32px, keyboard reachable)
    c.W.forEach((w, i) => {
      if (!inX(w.date)) return;
      const x = X(w.date), y = Y(w.lbs);
      const hit = el("circle", { class: "hit", cx: x, cy: y, r: 16, tabindex: 0, role: "button",
        "aria-label": f1(w.lbs) + " lb on " + fmtDY(w.date) + (state.selected === w.date ? ", selected" : "") });
      el("circle", { class: "focus-ring", cx: x, cy: y, r: 12 });
      const pick = () => { state.selected = state.selected === w.date ? null : w.date; state.hover = null; drawChart(lastCalc); };
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
    const name = $("sName").value.trim().slice(0, 40), target = Math.round(parseFloat($("sTarget").value)), showDate = $("sShow").value;
    if (!(target >= 1 && target <= 1000)) return flash("sMsg", "Enter a target between 1 and 1000 lb.", false);
    if (!isDateStr(showDate)) return flash("sMsg", "Pick a show date.", false);
    await submit($("sBtn"), "sMsg", "saveSettings", { name, target, showDate }, "Settings saved.");
  });
  function fillSettings() {
    const s = state.settings;
    if (document.activeElement && document.activeElement.form === $("setForm")) return; // don't clobber while editing
    $("sName").value = s.name || ""; $("sTarget").value = s.target; $("sShow").value = s.showDate;
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
