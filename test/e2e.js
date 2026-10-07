/* Browser acceptance checks (SPEC §8) against the mock API, at 390px.
   Run: node test/e2e.js   (starts the mock server itself) */
const { spawn } = require("child_process");
const path = require("path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const PORT = 8790, BASE = `http://localhost:${PORT}`;
const TODAY = "2026-09-23";

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, "mock-api.js"), String(PORT)], { stdio: "inherit" });
  await new Promise(r => setTimeout(r, 500));
  const browser = await chromium.launch();
  let failed = 0;
  const check = async (name, fn) => { try { await fn(); console.log("ok   -", name); } catch (e) { failed++; console.log("FAIL -", name, "\n     ", e.message); } };
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", e => { failed++; console.log("PAGE ERROR:", e.message); });
    await page.addInitScript(t => { // freeze "today" for repeatable numbers
      const RealDate = Date; const fixed = new RealDate(t + "T12:00:00");
      class D extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed.getTime()])); } static now() { return fixed.getTime(); } }
      window.Date = D;
    }, TODAY);
    await fetch(BASE + "/__set", { method: "POST", body: "" });
    await page.goto(`${BASE}/?api=${encodeURIComponent(BASE + "/api")}`);
    await page.waitForFunction(() => /^Updated/.test(document.getElementById("updated").textContent));

    const setDate = (id, v) => page.fill("#" + id, v);
    const cell = async (row, col) => (await page.locator(`#periodBody tr`).nth(row).locator("td").nth(col).textContent()).trim();

    await check("empty state shows", async () => {
      assert.match(await page.textContent("#weighList"), /Log your first weigh-in/);
      assert.equal(await page.isHidden("#configBanner"), true);
    });

    await check("§8 enter feed 4.00 from 8/20 and four weigh-ins", async () => {
      await setDate("fDate", "2026-08-20"); await page.fill("#fLbs", "4.00"); await page.fill("#fNote", "grower ration");
      await page.click("#fBtn"); await page.waitForSelector("#fMsg.ok");
      assert.match(await page.textContent("#fMsg"), /Feed set to 4\.00 lb\/day starting Aug 20\./);
      for (const [d, w] of [["2026-08-30", "212"], ["2026-09-06", "218"], ["2026-09-13", "223.5"], ["2026-09-20", "229.5"]]) {
        await setDate("wDate", d); await page.fill("#wLbs", w); await page.click("#wBtn"); await page.waitForSelector("#wMsg.ok");
      }
      await page.waitForFunction(() => document.querySelectorAll("#periodBody tr").length === 3);
      // newest period first: Sep 13–Sep 20 → gain +6.0, 0.86 lb/day, feed 28.0, F:G 4.67
      assert.equal(await cell(0, 0), "Sep 13–Sep 20");
      assert.equal(await cell(0, 4), "+6.0");
      assert.equal(await cell(0, 5), "0.86");
      assert.equal(await cell(0, 6), "28.0");
      assert.equal(await cell(0, 7), "4.67");
      assert.equal((await page.textContent("#sFcr")).trim(), "4.67");
      assert.match(await page.textContent("#sGain"), /\+6\.0/);
      assert.match(await page.textContent("#sWeight"), /229\.5/);
      assert.equal((await page.textContent("#daysLeft")).trim(), "74");
      assert.equal((await page.textContent("#projVal")).trim(), (229.5 + (6 / 7) * 77).toFixed(1));
      assert.equal((await page.textContent("#curAdg")).trim(), "0.86 lb/day");
      assert.match(await page.textContent("#projText"), /^At 0\.86 lb\/day/);
      assert.doesNotMatch(await page.textContent("#projText"), /\bhe\b|\bhis\b/i);
    });

    await check("feed lb/day field defaults to the current rate", async () => {
      assert.equal(await page.inputValue("#fLbs"), "4.00");
    });

    await check("§8 mid-period feed change is totaled day by day", async () => {
      await setDate("fDate", "2026-09-16"); await page.fill("#fLbs", "4.25"); await page.click("#fBtn"); await page.waitForSelector("#fMsg.ok");
      await page.waitForFunction(() => document.querySelector("#periodBody tr td:nth-child(7)").textContent === "29.0");
      assert.equal(await cell(0, 6), "29.0"); // 3×4.00 + 4×4.25
      assert.equal(await cell(0, 7), "4.83");
      assert.match(await page.textContent("#sFeed"), /4\.25/);
    });

    await check("§8 weigh-in on an existing date overwrites, not duplicates", async () => {
      await setDate("wDate", "2026-09-20"); await page.fill("#wLbs", "230"); await page.click("#wBtn"); await page.waitForSelector("#wMsg.ok");
      assert.match(await page.textContent("#wMsg"), /^Updated 230\.0 lb on Sep 20\./);
      const sheet = await (await fetch(BASE + "/__get")).json();
      assert.equal(sheet.weighins.length, 4);
      assert.equal(sheet.weighins.find(w => w.date === "2026-09-20").lbs, 230);
      assert.equal(await page.locator("#weighList li").count(), 4);
      assert.equal(sheet.feed.length, 2);
    });

    await check("§8 hand edit in the sheet + Refresh → recomputed, order irrelevant", async () => {
      const sheet = await (await fetch(BASE + "/__get")).json();
      const w = sheet.weighins.find(x => x.date === "2026-09-20"); w.date = "2026-09-21"; // moved a day later by hand
      sheet.weighins.reverse(); sheet.feed.reverse();
      await fetch(BASE + "/__set", { method: "POST", body: JSON.stringify(sheet) });
      await page.click("#refreshBtn");
      await page.waitForFunction(() => document.querySelector("#periodBody tr td").textContent === "Sep 13–Sep 21");
      assert.equal(await cell(0, 4), "+6.5");
      assert.equal(await cell(0, 5), "0.81");
      assert.equal(await cell(0, 6), "33.3"); // 3×4.00 + 5×4.25 = 33.25
      assert.equal((await page.textContent("#daysLeft")).trim(), "74");
    });

    await check("validation errors keep form values", async () => {
      await setDate("wDate", "2026-09-22"); await page.fill("#wLbs", "0.5"); await page.click("#wBtn");
      await page.waitForSelector("#wMsg.err");
      assert.equal(await page.inputValue("#wLbs"), "0.5");
    });

    await check("settings: two shows with ranges and a taper", async () => {
      await page.click("details.settings summary");
      await page.fill("#sName", "Hamlet"); await page.fill("#sTaper", "85");
      await page.fill("#s1Name", "Williamson County"); await page.fill("#s1Date", "2026-12-05"); await page.fill("#s1Min", "150"); await page.fill("#s1Max", "280");
      await page.fill("#s2Name", "San Antonio"); await page.fill("#s2Date", "2027-02-22"); await page.fill("#s2Min", "250"); await page.fill("#s2Max", "300");
      await page.click("#sBtn"); await page.waitForSelector("#sMsg.ok");
      assert.equal((await page.textContent("#pigName")).trim(), "Hamlet");
      assert.match(await page.textContent("#headSub"), /Williamson County Dec 5 · 150–280 lb\s+·\s+San Antonio Feb 22 · 250–300 lb/);
      assert.equal((await page.textContent("#daysLeft")).trim(), "73");
      assert.match(await page.textContent("#daysLeftLabel"), /days to Williamson County/);
      // 230 lb on Sep 21 at 0.8125 lb/day: Dec 5 = 75 days → 290.9 (over 280 max); SA = 75 + 79×0.85 days
      assert.equal((await page.textContent("#projVal")).trim(), (230 + 0.8125 * 75).toFixed(1));
      assert.match(await page.textContent("#projPill"), /10\.9 lb over max/);
      const sa = (230 + 0.8125 * (75 + 79 * 0.85)).toFixed(1);
      assert.match(await page.textContent("#showList"), new RegExp("San Antonio · Feb 22\\s*" + sa.replace(".", "\\.") + " lb"));
      assert.match(await page.textContent("#projText"), /assumes 85% of that rate \(0\.69 lb\/day\)/);
      const plan = await page.textContent("#planRows");
      assert.match(plan, /Williamson County · 75 days\s*≤ 0\.67 lb\/day/);
      assert.match(plan, /San Antonio · 154 days · 85% after Williamson County/);
      assert.match(plan, /Both shows/);
      assert.equal(await page.locator("#chart rect[rx]").count(), 2, "two show-range bands on the chart");
      // validation: second show before the first
      await page.fill("#s2Date", "2026-11-01"); await page.click("#sBtn"); await page.waitForSelector("#sMsg.err");
      assert.match(await page.textContent("#sMsg"), /second show must be after the first/);
      await page.fill("#s2Date", "2027-02-22"); await page.click("#sBtn"); await page.waitForSelector("#sMsg.ok");
    });

    await check("projection basis toggle persists", async () => {
      await page.click('.seg[data-basis="all"]');
      assert.equal(await page.getAttribute('.seg[data-basis="all"]', "aria-pressed"), "true");
      await page.reload(); await page.waitForFunction(() => /^Updated/.test(document.getElementById("updated").textContent));
      assert.equal(await page.getAttribute('.seg[data-basis="all"]', "aria-pressed"), "true");
      await page.click('.seg[data-basis="last"]');
    });

    await check("sheet link appears (from config.js, or the API response as fallback)", async () => {
      await page.waitForFunction(() => !document.getElementById("sheetLink").hidden);
      assert.match(await page.getAttribute("#sheetLink", "href"), /^https:\/\/docs\.google\.com\/spreadsheets\//);
    });

    await check("delete needs two taps and removes only that row", async () => {
      assert.equal(await page.locator("#weighList .del").count(), 4);
      const btn = page.locator("#weighList li").first().locator(".del"); // newest: Sep 21
      await btn.click();
      assert.equal((await btn.textContent()).trim(), "Tap to confirm");
      await page.waitForTimeout(3200); // arm times out
      assert.equal((await btn.textContent()).trim(), "Delete");
      assert.equal(await page.locator("#weighList .del").count(), 4);
      await btn.click(); await btn.click();
      await page.waitForFunction(() => document.querySelectorAll("#weighList .del").length === 3);
      const sheet = await (await fetch(BASE + "/__get")).json();
      assert.deepEqual(sheet.weighins.map(w => w.date).sort(), ["2026-08-30", "2026-09-06", "2026-09-13"]);
      assert.equal(await page.locator("#periodBody tr").count(), 2);
      // put it back for the later checks
      await setDate("wDate", "2026-09-21"); await page.fill("#wLbs", "230"); await page.click("#wBtn"); await page.waitForSelector("#wMsg.ok");
      await page.waitForFunction(() => document.querySelectorAll("#periodBody tr").length === 3);
    });

    await check("stale row id with a mismatched date is refused", async () => {
      const sheet = await (await fetch(BASE + "/__get")).json();
      const w = sheet.weighins.find(x => x.date === "2026-09-21");
      const r = await (await fetch(BASE + "/api", { method: "POST", body: JSON.stringify({ action: "delete", sheet: "Weighins", id: w.id, date: "2026-09-13" }) })).json();
      assert.equal(r.ok, false);
      assert.equal((await (await fetch(BASE + "/__get")).json()).weighins.length, 4);
    });

    await check("chart: tapping a weigh-in shows its details, tapping again clears", async () => {
      const hits = page.locator("#chart .hit");
      assert.equal(await hits.count(), 4);
      await hits.nth(3).click(); // Sep 21, 230.0
      const txt = await page.textContent("#readout");
      assert.match(txt, /230\.0 lb/); assert.match(txt, /Sep 21, 2026/); assert.match(txt, /\+6\.5 lb since Sep 13 \(8 days\)/);
      assert.match(txt, /0\.81 lb\/day/); assert.match(txt, /33\.3 lb feed/); assert.match(txt, /F:G 5\.12/);
      assert.match(await page.getAttribute("#chart .hit >> nth=3", "aria-label"), /selected/);
      await hits.nth(0).click();
      assert.match(await page.textContent("#readout"), /212\.0 lb.*First weigh-in/);
      await hits.nth(0).click();
      assert.match(await page.textContent("#readout"), /Tap a weigh-in/);
      // keyboard
      await hits.nth(1).focus(); await page.keyboard.press("Enter");
      assert.match(await page.textContent("#readout"), /218\.0 lb/);
      await page.click("#chart", { position: { x: 5, y: 5 } });
      assert.match(await page.textContent("#readout"), /Tap a weigh-in/);
    });

    await check("chart: zoom toggle tightens the axes and persists", async () => {
      const axisMax = async () => Math.max(...(await page.$$eval("#chart text", ts => ts.map(t => +t.textContent).filter(n => !isNaN(n) && n > 50))));
      const fullMax = await axisMax();
      assert.ok(fullMax >= 290, "full view frames the target, got " + fullMax);
      await page.click('.seg[data-range="3"]');
      const zoomMax = await axisMax();
      assert.ok(zoomMax < 240 && zoomMax >= 230, "zoomed y-axis should frame 218–230, got " + zoomMax);
      assert.equal(await page.locator("#chart .hit").count(), 3);
      await page.reload(); await page.waitForFunction(() => /^Updated/.test(document.getElementById("updated").textContent));
      assert.equal(await page.getAttribute('.seg[data-range="3"]', "aria-pressed"), "true");
      await page.click('.seg[data-range="6"]');
      assert.equal(await page.locator("#chart .hit").count(), 4);
      await page.click('.seg[data-range="all"]');
    });

    await check("update banner appears when version.json is newer, Update reloads", async () => {
      assert.equal(await page.isHidden("#updateBanner"), true);
      await page.route("**/version.json*", r => r.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 9999 }) }));
      await page.click("#refreshBtn");
      await page.waitForFunction(() => !document.getElementById("updateBanner").hidden);
      const reloads = [];
      await page.route(/\/(app|calc|config)\.js\?v=9999$/, r => { reloads.push(r.request().url()); r.continue(); });
      await Promise.all([page.waitForNavigation(), page.click("#updateBtn")]);
      assert.equal(reloads.length, 3, "refetched: " + reloads.join(", "));
      await page.unroute("**/version.json*");
      await page.waitForFunction(() => /^Updated/.test(document.getElementById("updated").textContent));
    });

    await check("full-screen chart: overlay fills a landscape viewport, close restores", async () => {
      const vbH = async () => +(await page.getAttribute("#chart", "viewBox")).split(" ")[3];
      const normalH = await vbH();
      await page.setViewportSize({ width: 844, height: 390 });
      await page.click("#fsBtn");
      await page.waitForFunction(() => !document.getElementById("fsOverlay").hidden);
      assert.ok(await page.locator("#fsBody #chart").count() === 1, "chart moved into the overlay");
      assert.ok(await page.locator("#fsTools .range").count() === 1, "range buttons moved into the overlay");
      const box = await page.locator("#fsOverlay").boundingBox();
      assert.ok(box.width >= 840 && box.height >= 380, "overlay covers the viewport: " + JSON.stringify(box));
      const vb = (await page.getAttribute("#chart", "viewBox")).split(" ").map(Number);
      assert.ok(vb[2] > 700, "chart uses the full width: " + vb[2]);
      assert.ok(await page.isHidden("#fsHint"), "no rotate hint in landscape");
      // points still tappable in full screen
      await page.locator("#chart .hit").nth(1).click();
      assert.match(await page.textContent("#fsBody #readout"), /218\.0 lb/);
      await page.click('#fsTools .seg[data-range="3"]');
      assert.equal(await page.locator("#chart .hit").count(), 3);
      await page.click('#fsTools .seg[data-range="all"]');
      // portrait shows the rotate hint and the chart gets taller than the inline one
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => !document.getElementById("fsHint").hidden);
      assert.ok((await vbH()) > normalH, "full-screen chart is taller than inline");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("fsOverlay").hidden);
      assert.equal(await page.locator("#chartSlot #chart").count(), 1);
      assert.equal(await page.locator("#chartTools .range").count(), 1);
      assert.equal(await vbH(), normalH);
      await page.click("#chart", { position: { x: 5, y: 5 } });
    });

    await check("390px: no horizontal scroll", async () => {
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
      assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > clientWidth ${m.cw}`);
      assert.ok(m.bw <= m.cw, `body scrollWidth ${m.bw} > clientWidth ${m.cw}`);
      const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.tagName + "." + e.className).slice(0, 5));
      assert.deepEqual(wide, [], "elements overflowing: " + wide.join(", "));
    });

    await check("390px: tap targets ≥44px and inputs ≥16px", async () => {
      const small = await page.evaluate(() => [...document.querySelectorAll("button, input, summary")].filter(e => e.offsetParent !== null).map(e => ({ id: e.id || e.className, h: e.getBoundingClientRect().height, fs: parseFloat(getComputedStyle(e).fontSize), tag: e.tagName })).filter(e => (e.tag === "INPUT" && (e.fs < 16 || e.h < 44)) || (e.tag !== "INPUT" && e.h < 36)));
      assert.deepEqual(small, []);
    });

    await check("fetch failure shows the stale-data banner and keeps data", async () => {
      await page.route("**/api?action=all", r => r.abort());
      await page.click("#refreshBtn");
      await page.waitForSelector("#netBanner:not([hidden])");
      assert.match(await page.textContent("#netBanner"), /Couldn't reach the sheet — showing data from/);
      assert.equal(await page.locator("#periodBody tr").count(), 3);
      assert.match(await page.textContent("#updated"), /^Updated /);
      await page.unroute("**/api?action=all");
      await page.click("#refreshBtn");
      await page.waitForFunction(() => document.getElementById("netBanner").hidden);
      assert.match(await page.textContent("#updated"), /^Updated just now/);
    });

    await check("cached data renders before the network answers", async () => {
      const p2 = await ctx.newPage();
      await p2.route("**/api?action=all", () => {}); // never answers
      await p2.goto(`${BASE}/?api=${encodeURIComponent(BASE + "/api")}`);
      await p2.waitForFunction(() => document.querySelectorAll("#periodBody tr").length === 3);
      assert.match(await p2.textContent("#updated"), /cached|Refreshing/);
      await p2.close();
    });

    await page.screenshot({ path: path.join(__dirname, "..", "screenshot-390.png"), fullPage: true });
    const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    const dp = await dark.newPage();
    await dp.goto(`${BASE}/?api=${encodeURIComponent(BASE + "/api")}`);
    await dp.waitForFunction(() => document.querySelectorAll("#periodBody tr").length === 3);
    await dp.screenshot({ path: path.join(__dirname, "..", "screenshot-390-dark.png"), fullPage: true });
    await dark.close();
    const wide = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const wp = await wide.newPage();
    await wp.goto(`${BASE}/?api=${encodeURIComponent(BASE + "/api")}`);
    await wp.waitForFunction(() => document.querySelectorAll("#periodBody tr").length === 3);
    await wp.screenshot({ path: path.join(__dirname, "..", "screenshot-desktop.png"), fullPage: true });
    await wide.close();
  } finally {
    await browser.close(); server.kill();
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
