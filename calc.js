/* Show Pig Tracker — pure calculation helpers.
   Loaded by the page as a plain script (window.PigCalc) and by the Node
   tests via require(). No DOM, no network, no dates from the system clock
   except todayStr(). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PigCalc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const pad = n => String(n).padStart(2, "0");
  const todayStr = () => {
    const d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  };
  const isDateStr = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const toUTC = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const days = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
  const addDays = (s, n) => {
    const d = new Date(toUTC(s) + n * 86400000);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  };
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  /* Least-squares slope in lb/day through a list of {date, lbs}. */
  function slope(pts) {
    if (pts.length < 2) return null;
    const x0 = pts[0].date;
    const xs = pts.map(p => days(x0, p.date)), ys = pts.map(p => p.lbs);
    const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    return den ? num / den : null;
  }

  /* Blank cells arrive as "", null or undefined: never treat them as 0. */
  const num = v => (v === "" || v === null || v === undefined || typeof v === "boolean") ? NaN : +v;

  /* Drop rows the page can't use (bad dates, non-numeric amounts) and sort. */
  function clean(weights, feeds) {
    const W = (weights || [])
      .filter(w => w && isDateStr(w.date) && Number.isFinite(num(w.lbs)) && num(w.lbs) > 0)
      .map(w => ({ ...w, lbs: +w.lbs })).sort(byDate);
    const F = (feeds || [])
      .filter(f => f && isDateStr(f.date) && Number.isFinite(num(f.lbs)) && num(f.lbs) >= 0)
      .map(f => ({ ...f, lbs: +f.lbs, note: f.note || "" })).sort(byDate);
    return { W, F };
  }

  /* Settings → list of shows the page tracks. Accepts the new shape
     ({shows:[{name,date,min,max}], taperPct}) and the legacy one
     ({target, showDate}), which becomes one show with min = max = target. */
  function normalizeShows(settings) {
    const s = settings || {};
    let shows = Array.isArray(s.shows) ? s.shows : [];
    shows = shows
      .filter(x => x && isDateStr(x.date))
      .map((x, i) => {
        let min = +x.min, max = +x.max;
        if (!Number.isFinite(min) || min <= 0) min = null;
        if (!Number.isFinite(max) || max <= 0) max = null;
        if (min != null && max != null && min > max) { const t = min; min = max; max = min === t ? min : t; }
        return { name: (typeof x.name === "string" && x.name.trim()) || ("Show " + (i + 1)), date: x.date, min, max };
      })
      .sort(byDate);
    if (!shows.length && isDateStr(s.showDate)) {
      const t = Number.isFinite(+s.target) && +s.target > 0 ? +s.target : null;
      shows = [{ name: "Show", date: s.showDate, min: t, max: t }];
    }
    let taper = +s.taperPct;
    if (!Number.isFinite(taper) || taper < 0 || taper > 200) taper = 100;
    return { shows, taperPct: taper };
  }

  /* Where a weight sits against a show's range. tol: lb of warning margin. */
  function rangeStatus(w, show, tol) {
    tol = tol == null ? 5 : tol;
    const { min, max } = show;
    const single = min != null && min === max;
    if (max != null && w > max + (single ? tol : 0)) return { level: "bad", diff: w - max, text: f1(w - max) + (single ? " lb over" : " lb over max") };
    if (min != null && w < min - (single ? tol : 0)) return { level: "bad", diff: w - min, text: f1(min - w) + (single ? " lb under" : " lb under min") };
    if (min === max && min != null) return { level: "good", diff: w - max, text: "On target (" + sign(w - max) + " lb)" };
    if (max != null && max - w <= tol) return { level: "warn", diff: w - max, text: "In range, " + f1(max - w) + " lb from max" };
    if (min != null && w - min <= tol) return { level: "warn", diff: w - min, text: "In range, " + f1(w - min) + " lb from min" };
    return { level: "good", diff: null, text: "In range" };
  }
  const f1 = n => (Math.round(n * 10) / 10).toFixed(1);
  const sign = n => (n > 0 ? "+" : n < 0 ? "−" : "") + f1(Math.abs(n));

  /* Everything the page shows, derived from raw rows + settings.
     basis: "last" | "recent" | "all". today: YYYY-MM-DD. */
  function calc(weights, feeds, settings, basis, today) {
    today = today || todayStr();
    const { W, F } = clean(weights, feeds);
    const { shows, taperPct } = normalizeShows(settings);
    const taper = taperPct / 100;
    const rateOn = d => { let r = null; for (const f of F) { if (f.date <= d) r = f.lbs; else break; } return r; };

    const periods = [];
    for (let i = 1; i < W.length; i++) {
      const a = W[i - 1], b = W[i], n = days(a.date, b.date);
      if (n <= 0) continue;
      let feed = 0, missing = 0;
      for (let k = 0; k < n; k++) { const r = rateOn(addDays(a.date, k)); if (r == null) missing++; else feed += r; }
      const gain = b.lbs - a.lbs;
      periods.push({ a, b, n, gain, adg: gain / n, feed, missing,
        fcr: (gain > 0 && missing < n) ? feed / gain : null });
    }

    const last = W[W.length - 1] || null;
    let adg = null;
    if (periods.length) {
      if (basis === "recent") adg = slope(W.slice(-3));
      else if (basis === "all") adg = slope(W);
      else adg = periods[periods.length - 1].adg;
    }

    /* Piecewise projection. From the last weigh-in to the first upcoming
       show at the current rate; after that show at rate × taper. A show
       that is already past (before today) gets no projection and no taper
       is applied after it, since the measured rate is already post-show.
       effDays = "effective days at the current rate": the multiplier that
       turns a current ADG into weight gained by that show's date. */
    let firstUpcoming = -1;
    const showCalc = shows.map((sh, i) => {
      const passed = sh.date < today;
      if (!passed && firstUpcoming < 0) firstUpcoming = i;
      return { ...sh, passed, daysFromLast: last ? days(last.date, sh.date) : null, daysLeft: Math.max(0, days(today, sh.date)) };
    });
    let cursorDate = last ? last.date : null, effDays = 0, rateMult = 1;
    showCalc.forEach((sc, i) => {
      sc.effDays = null; sc.proj = null; sc.status = null; sc.rateMult = null; sc.allowed = null;
      if (!last || sc.passed || sc.daysFromLast < 0) return;
      const seg = days(cursorDate, sc.date);
      effDays += seg * rateMult;
      sc.effDays = effDays; sc.rateMult = rateMult;
      if (adg != null) { sc.proj = last.lbs + adg * effDays; sc.status = rangeStatus(sc.proj, sc); }
      if (effDays > 0) {
        sc.allowed = {
          lo: sc.min != null ? (sc.min - last.lbs) / effDays : null,
          hi: sc.max != null ? (sc.max - last.lbs) / effDays : null
        };
      }
      cursorDate = sc.date;
      if (i === firstUpcoming) rateMult *= taper;
    });
    // Band of current daily gain that lands inside every upcoming show's range.
    let band = null;
    const bands = showCalc.filter(sc => sc.allowed).map(sc => sc.allowed);
    if (bands.length) {
      const lo = Math.max(...bands.map(b => b.lo == null ? -Infinity : b.lo));
      const hi = Math.min(...bands.map(b => b.hi == null ? Infinity : b.hi));
      band = { lo: lo === -Infinity ? null : lo, hi: hi === Infinity ? null : hi, feasible: lo <= hi };
    }
    const next = firstUpcoming >= 0 ? showCalc[firstUpcoming] : null;
    const lastShow = showCalc.length ? showCalc[showCalc.length - 1] : null;

    // legacy single-show fields, kept for the chart/readout code paths
    const proj = next ? next.proj : null;
    const daysToShow = next ? next.daysFromLast : (last && lastShow ? days(last.date, lastShow.date) : null);
    const lastFcr = [...periods].reverse().find(p => p.fcr != null)?.fcr ?? null;
    const allPassed = showCalc.length > 0 && !next;
    const daysLeft = next ? next.daysLeft : 0;

    return { W, F, periods, last, adg, proj, daysToShow, lastFcr, rateOn, today,
      shows: showCalc, next, lastShow, band, taperPct, taper, allPassed, showPassed: allPassed, daysLeft,
      rateNow: rateOn(today) };
  }

  return { todayStr, isDateStr, days, addDays, slope, clean, calc, normalizeShows, rangeStatus };
});
