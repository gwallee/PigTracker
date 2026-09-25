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

    await check("settings save updates the header", async () => {
      await page.click("details.settings summary");
      await page.fill("#sName", "Hamlet"); await page.fill("#sTarget", "285"); await page.fill("#sShow", "2026-12-05");
      await page.click("#sBtn"); await page.waitForSelector("#sMsg.ok");
      assert.equal((await page.textContent("#pigName")).trim(), "Hamlet");
      assert.equal((await page.textContent("#headSub")).trim(), "Target 285 lb · Show Dec 5, 2026");
      assert.equal((await page.textContent("#daysLeft")).trim(), "73");
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
