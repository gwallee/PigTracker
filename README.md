# Show Pig Tracker

A mobile-first web page for tracking a market show pig: daily feed amount,
periodic weigh-ins, gain and feed conversion per weigh period, and a
projected show-day weight against your target.

- **Frontend:** static site on GitHub Pages. Plain HTML, CSS and JavaScript, no build step.
- **Backend:** a Google Sheet plus a small Google Apps Script web app that serves it as JSON.
- **Access:** anyone with the page link can view and add entries. No login.
- **Source of truth:** the Sheet. Edit it by hand any time; the page recomputes on the next load or Refresh.

```
index.html              page markup and CSS
app.js                  fetching, caching, forms, rendering, chart
calc.js                 all the math (periods, feed totals, projection); shared with the tests
config.js               API_URL, SHEET_URL, ALLOW_DELETE, FCR_THRESHOLDS  ← the only file you edit
apps-script/Code.gs     Apps Script source, pasted into the Sheet's script editor
apps-script/appsscript.json   optional manifest (timezone + web app settings)
test/                   unit tests, a local mock of the API, and browser acceptance checks
```

---

## Setup (about 15 minutes)

### 1. Create the Google Sheet

1. Go to [sheets.new](https://sheets.new) and name the spreadsheet, for example **Show Pig Tracker**.
2. **File → Settings**: set *Locale* to **United States** and *Time zone* to **(GMT-05:00) Central Time – Chicago** (or your own zone). Save.
   This matters: the script normalizes dates in the spreadsheet's timezone, and hand-typed dates like `9/20/2026` parse as month/day only in a US locale.
3. You don't need to create the tabs by hand. The script's `setup()` function (next step) creates them:

   | Tab | Columns |
   |---|---|
   | **Feed** | Date · LbsPerDay · Note · Id · Created |
   | **Weighins** | Date · Lbs · Id · Created |
   | **Settings** | Key · Value (PigName, TargetLbs, ShowDate) |

   If you'd rather paste in history, type dates in the Date column as `2026-09-20` or `9/20/2026` and leave Id and Created blank. The script fills Ids in as it goes and tolerates blank rows and unsorted rows.

### 2. Add the Apps Script

1. In the Sheet: **Extensions → Apps Script**.
2. Delete the contents of `Code.gs` in the editor and paste in this repo's [`apps-script/Code.gs`](apps-script/Code.gs). Save (💾 or Ctrl/Cmd+S).
3. In the function dropdown next to ▶ Run, choose **setup** and click **Run**.
   The first time, Google asks you to authorize the script. Click **Review permissions**, pick your account, then **Advanced → Go to Show Pig Tracker (unsafe) → Allow**. The "unsafe" warning appears because it's your own unpublished script, not a verified app.
4. Switch back to the Sheet: the three tabs now exist with headers.
5. *(Optional)* In the script editor, **Project Settings (⚙) → check "Show appsscript.json manifest file"**, then replace its contents with [`apps-script/appsscript.json`](apps-script/appsscript.json). This pins the script's timezone to America/Chicago.

### 3. Deploy it as a web app

1. In the script editor: **Deploy → New deployment**.
2. Click the gear next to *Select type* and choose **Web app**.
3. Settings:
   - Description: anything, e.g. `v1`
   - **Execute as: Me**
   - **Who has access: Anyone**
4. Click **Deploy**, authorize again if asked, and copy the **Web app URL**. It looks like
   `https://script.google.com/macros/s/AKfycb.../exec`.
5. Test it: open that URL with `?action=all` on the end in a browser tab. You should see JSON starting with `{"ok":true,...}`.

> **Google Workspace (work/school) accounts:** your admin may not allow *Who has access: Anyone*. If the only choice is "Anyone within your organization", the page will not work for people outside it. Create the Sheet and script from a personal Gmail account instead.

> **Every later code change** needs **Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy**. Saving the code alone does nothing; the `/exec` URL keeps serving the old version until you publish a new one.

### 4. Set the API URL and publish the page

1. In this repo, edit [`config.js`](config.js) and replace `PASTE_YOUR_APPS_SCRIPT_URL_HERE` with the Web app URL from step 3. Commit.
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, then choose the branch (usually `main`) and folder `/ (root)`. Save.
3. After a minute the page is live at `https://<your-user>.github.io/<repo>/`. Open it on your phone and add it to the home screen.

That's it. The page fetches the Sheet on load, after every save, whenever you return to the tab, and when you tap **Refresh**.

**After changing the site's code**, bump the `?v=` number on the three `<script>` tags at the bottom of `index.html`. Browsers (phones especially) cache the old files otherwise, and a new version number forces them to fetch the new ones.

---

## Using it

- **Change feed amount** records that from a start date onward the pig gets X lb/day. Enter one row each time the amount changes; the page fills in every day in between. A start date in the future is shown as *Scheduled* and kicks in on that date.
- **Log a weigh-in** records the scale reading for a date, to a tenth of a pound. The projection needs two.
- **Re-entering a date overwrites** that day's row (feed or weigh-in). That's how you fix a typo from the page.
- **Delete** on a weigh-in or feed row asks you to tap twice. It removes that row from the Sheet.
- **Everything else is fixed in the Sheet**: change a date, paste in history. The **Open sheet** link next to Refresh takes you there. Tap **Refresh** afterwards. Row order and formatting don't matter. Blank amounts are skipped, not counted as zero.
- **Undo** is the Sheet's own **File → Version history**.

### How the numbers are computed

Nothing is stored except the raw rows. Everything is recomputed on every load.

- **Weigh period:** each pair of consecutive weigh-ins. Gain = end − start; lb/day = gain ÷ days.
- **Feed per period:** the sum of the daily feed amount for every day from the first weigh-in (inclusive) up to the next (exclusive). Days before your first feed row are unknown, shown with `*` on the total.
- **Feed : gain (F:G):** feed ÷ gain for the period, only when gain is positive. Lower is better.
- **Projected show weight:** last weight + daily gain × days until show. The three buttons pick which daily gain: the last period, a trend line through the last three weigh-ins, or a trend line through all of them. Your choice is remembered on that device.
- **To hit target:** the gain still needed, the daily gain that would get there, and an estimated feed per day (required gain × latest F:G). It's a starting point, not a ration.

### Configuration flags (`config.js`)

| Flag | Default | What it does |
|---|---|---|
| `API_URL` | placeholder | The Apps Script `/exec` URL. Until it's set, the page runs in a preview mode where nothing is saved. |
| `SHEET_URL` | `""` | Adds an **Open sheet** link next to Refresh. Optional: a script deployed from this repo's `Code.gs` already returns the Sheet's URL, so the link appears without setting this. |
| `ALLOW_DELETE` | `true` | Shows two-tap Delete buttons on weigh-ins and feed rows. Anyone with the page link can use them, so set it to `false` if the link gets around. |
| `FCR_THRESHOLDS` | `null` | Colour-codes the F:G column and tile, e.g. `{ good: 3.0, mid: 4.0 }`: at or below `good` is green, at or below `mid` amber, above red. |

---

## Development

No dependencies for the site itself. The tests use Node 18+ and Playwright.

```bash
node --test test/*.test.js        # math + Code.gs helper unit tests
node test/mock-api.js 8787        # local site + fake API at http://localhost:8787/?api=http://localhost:8787/api
node test/e2e.js                  # SPEC §8 acceptance checks in headless Chromium at 390px (needs `npm i -D playwright`)
```

`test/mock-api.js` mimics the Apps Script API in memory (same validation and upsert-by-date rules) so the whole page can be exercised without a Google account. Adding `?api=<url>` to the page URL overrides `API_URL` for that visit.

### API

`GET  <API_URL>?action=all` → `{ ok, settings:{name,target,showDate}, feed:[{id,date,lbs,note}], weighins:[{id,date,lbs}], sheetUrl, serverTime }`

`POST <API_URL>` with a JSON body sent as `Content-Type: text/plain` (avoids a CORS preflight, which Apps Script can't answer):

```json
{ "action": "addFeed",      "date": "2026-09-29", "lbs": 4.25, "note": "bump" }
{ "action": "addWeighin",   "date": "2026-09-26", "lbs": 236.5 }
{ "action": "saveSettings", "name": "Hamlet", "target": 290, "showDate": "2026-12-06" }
{ "action": "delete",       "sheet": "Weighins", "id": "w_1a2b3c4d", "date": "2026-09-26" }
```

Every POST returns the same shape as `action=all`, or `{ "ok": false, "error": "..." }`. Writes take a script lock, upsert by date, and validate: weigh-ins 1–1000 lb, feed 0–30 lb/day, notes ≤ 80 characters with leading `=`, `+`, `-`, `@` stripped. A delete whose `date` doesn't match the row is refused, which protects hand-typed rows (id `row:N`) from being deleted by a stale row number.
