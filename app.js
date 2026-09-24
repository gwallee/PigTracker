/* Show Pig Tracker — page logic.
   Data comes from the Apps Script API (config.js → API_URL). All math is
   in calc.js; this file handles fetching, caching, forms, rendering and
   the chart. */
(function () {
  "use strict";
  const { todayStr, days, addDays, calc, isDateStr } = PigCalc;
  const DEFAULTS = { name: "", target: 290, showDate: "2026-12-06" };
  const CACHE_KEY = "pigtracker.cache.v1", BASIS_KEY = "pigtracker.basis";

  // ?api=http://localhost:8787/api overrides config.js (used by the tests).
  const apiOverride = new URLSearchParams(location.search).get("api");
  const apiUrl = apiOverride || (typeof API_URL === "string" ? API_URL : "");
  const connected = /^https?:\/\//.test(apiUrl) && !/PASTE_YOUR/.test(apiUrl);
  const allowDelete = typeof ALLOW_DELETE !== "undefined" && ALLOW_DELETE === true;
  const fcrT = (typeof FCR_THRESHOLDS !== "undefined" && FCR_THRESHOLDS) || null;

  const state = {
    weights: [], feeds: [], settings: { ...DEFAULTS },
    basis: "last", updatedAt: null, fromCache: false, loaded: false, busy: false
  };
  try { const b = localStorage.getItem(BASIS_KEY); if (["last", "recent", "all"].includes(b)) state.basis = b; } catch (_) {}

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
  function applyData(j, at, fromCache) {
    const d = normalize(j);
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
    document.querySelectorAll(".seg").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.basis === state.basis)));

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
      if (allowDelete) li.appendChild(delBtn("Weighins", w.id));
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
      if (allowDelete) li.appendChild(delBtn("Feed", f.id));
      fList.appendChild(li);
    });

    drawChart(c);
    tickUpdated();
  }

  function delBtn(sheet, id) {
    const b = document.createElement("button"); b.className = "del"; b.type = "button"; b.textContent = "Delete";
    let t = null;
    b.onclick = async () => {
      if (!b.classList.contains("arm")) {
        b.classList.add("arm"); b.textContent = "Tap to confirm";
        t = setTimeout(() => { b.classList.remove("arm"); b.textContent = "Delete"; }, 3000); return;
      }
      clearTimeout(t); b.disabled = true; b.textContent = "Deleting…";
      try { await save("delete", { sheet, id }); }
      catch (err) { b.disabled = false; b.classList.remove("arm"); b.textContent = "Delete"; alert("Couldn't delete: " + err.message); }
    };
    return b;
  }

  // ---------- chart ----------
  function drawChart(c) {
    const svg = $("chart"), s = state.settings;
    const W = Math.max(300, Math.round(svg.parentNode.clientWidth || 720)), narrow = W < 520;
    const L = narrow ? 36 : 46, R = 12, T = 14, PB = narrow ? 190 : 210, FT = PB + 24, FB = PB + 60, XA = PB + 80;
    svg.setAttribute("viewBox", "0 0 " + W + " " + (XA + 8));
    const NS = "http://www.w3.org/2000/svg";
    svg.innerHTML = "";
    const el = (tag, attrs, txt) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (txt != null) e.textContent = txt; svg.appendChild(e); return e; };
    if (!c.W.length) {
      el("text", { x: W / 2, y: 150, "text-anchor": "middle" }, "Your weight curve appears after the first weigh-in");
      return;
    }
    const start = c.W[0].date;
    const end = s.showDate > c.today ? addDays(s.showDate, 2) : addDays(c.today, 2);
    const span = Math.max(1, days(start, end));
    const X = d => L + (days(start, d) / span) * (W - L - R);

    const ys = [...c.W.map(w => w.lbs), s.target]; if (c.proj != null) ys.push(c.proj);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const step = (hi - lo) > 120 ? 40 : (hi - lo) > 50 ? 20 : 10;
    lo = Math.floor((lo - 5) / step) * step; hi = Math.ceil((hi + 5) / step) * step;
    const Y = v => PB - (v - lo) / (hi - lo) * (PB - T);

    const line = "var(--line)", ink3 = "var(--ink-3)";
    for (let v = lo; v <= hi; v += step) {
      el("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: line, "stroke-width": 1 });
      el("text", { x: L - 8, y: Y(v) + 4, "text-anchor": "end" }, v);
    }
    const maxTicks = Math.max(3, Math.floor((W - L - R) / 62)); let every = 7; while (span / every > maxTicks) every += 7;
    for (let k = 0; k <= span; k += every) {
      const d = addDays(start, k);
      el("line", { x1: X(d), x2: X(d), y1: T, y2: FB, stroke: line, "stroke-width": 1, "stroke-dasharray": "2 4" });
      el("text", { x: X(d), y: XA, "text-anchor": "middle" }, fmtD(d));
    }
    if (c.today >= start && c.today <= end) {
      el("line", { x1: X(c.today), x2: X(c.today), y1: T, y2: FB, stroke: ink3, "stroke-width": 1 });
      el("text", { x: X(c.today) + 4, y: T + 10, "text-anchor": "start" }, "today");
    }
    // target
    el("line", { x1: L, x2: W - R, y1: Y(s.target), y2: Y(s.target), stroke: "var(--good)", "stroke-width": 1.5, "stroke-dasharray": "6 4" });
    if (s.showDate >= start && s.showDate <= end) {
      el("circle", { cx: X(s.showDate), cy: Y(s.target), r: 6, fill: "var(--surface)", stroke: "var(--good)", "stroke-width": 2.5 });
      el("text", { x: X(s.showDate) - 10, y: Y(s.target) - 10, "text-anchor": "end" }, s.target + " lb target").style.fill = "var(--good)";
    } else {
      el("text", { x: W - R, y: Y(s.target) - 6, "text-anchor": "end" }, s.target + " lb target").style.fill = "var(--good)";
    }
    // projection
    if (c.proj != null) {
      el("line", { x1: X(c.last.date), y1: Y(c.last.lbs), x2: X(s.showDate), y2: Y(c.proj), stroke: "var(--ribbon)", "stroke-width": 2.5, "stroke-dasharray": "7 5" });
      el("circle", { cx: X(s.showDate), cy: Y(c.proj), r: 5, fill: "var(--ribbon)" });
      const pl = el("text", { x: X(s.showDate) - 10, y: Y(c.proj) + (c.proj >= s.target ? -10 : 18), "text-anchor": "end" }, f1(c.proj) + " projected");
      pl.style.fill = "var(--ribbon)";
      if (Math.abs(Y(c.proj) - Y(s.target)) < 16) pl.setAttribute("y", c.proj >= s.target ? Y(s.target) - 24 : Y(s.target) + 30);
    }
    // weights
    const pts = c.W.map(w => X(w.date) + "," + Y(w.lbs));
    if (c.W.length > 1) {
      el("polygon", { points: X(c.W[0].date) + "," + PB + " " + pts.join(" ") + " " + X(c.last.date) + "," + PB, fill: "var(--ink)", "fill-opacity": .06 });
      el("polyline", { points: pts.join(" "), fill: "none", stroke: "var(--ink)", "stroke-width": 2.5, "stroke-linejoin": "round" });
    }
    c.W.forEach((w, i) => {
      const isLast = i === c.W.length - 1;
      el("circle", { cx: X(w.date), cy: Y(w.lbs), r: isLast ? 5.5 : 4, fill: isLast ? "var(--ink)" : "var(--surface)", stroke: "var(--ink)", "stroke-width": 2 });
    });
    el("text", { x: X(c.last.date), y: Y(c.last.lbs) - 12, "text-anchor": "middle" }, f1(c.last.lbs)).style.fill = "var(--ink)";

    // feed strip
    el("text", { x: L - 8, y: FT + 4, "text-anchor": "end" }, "feed");
    el("line", { x1: L, x2: W - R, y1: FB, y2: FB, stroke: line });
    const rates = c.F.map(f => f.lbs);
    if (rates.length) {
      const fmax = Math.max(...rates) * 1.1 || 1, fmin = Math.min(0, Math.min(...rates));
      const FY = v => FB - (v - fmin) / (fmax - fmin) * (FB - FT);
      const inRange = [];
      const r0 = c.rateOn(start); if (r0 != null) inRange.push({ date: start, lbs: r0 });
      c.F.forEach(f => { if (f.date > start && f.date <= end) inRange.push(f); });
      let path = "";
      inRange.forEach((f, i) => {
        const x = X(f.date), y = FY(f.lbs);
        path += (i === 0 ? "M" + x + "," + y : " H" + x + " V" + y);
        el("text", { x: x + 4, y: y - 5, "text-anchor": "start" }, f2(f.lbs)).style.fill = "var(--feed)";
      });
      if (inRange.length) { path += " H" + (W - R); el("path", { d: path, fill: "none", stroke: "var(--feed)", "stroke-width": 2.5 }); }
    }
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
  document.querySelectorAll(".seg").forEach(b => b.addEventListener("click", () => {
    state.basis = b.dataset.basis; try { localStorage.setItem(BASIS_KEY, state.basis); } catch (_) {} render();
  }));
  $("refreshBtn").addEventListener("click", load);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  setInterval(tickUpdated, 30000);

  // ---------- boot ----------
  fillSettings(); render();
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
