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

  /* Everything the page shows, derived from raw rows + settings.
     basis: "last" | "recent" | "all". today: YYYY-MM-DD. */
  function calc(weights, feeds, settings, basis, today) {
    today = today || todayStr();
    const { W, F } = clean(weights, feeds);
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

    let proj = null, daysToShow = null, needAdg = null;
    if (last) {
      daysToShow = days(last.date, settings.showDate);
      if (adg != null && daysToShow >= 0) proj = last.lbs + adg * daysToShow;
      if (daysToShow > 0) needAdg = (settings.target - last.lbs) / daysToShow;
    }
    const lastFcr = [...periods].reverse().find(p => p.fcr != null)?.fcr ?? null;
    const showPassed = settings.showDate < today;
    const daysLeft = Math.max(0, days(today, settings.showDate));

    return { W, F, periods, last, adg, proj, daysToShow, needAdg, lastFcr,
      rateNow: rateOn(today), rateOn, today, showPassed, daysLeft };
  }

  return { todayStr, isDateStr, days, addDays, slope, clean, calc };
});
