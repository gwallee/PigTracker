/* The version number must agree everywhere, or the update check misfires. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");

test("version.json, data-version, ?v= tags and footer stamp all match", () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, "version.json"), "utf8")).v;
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(Number.isInteger(v) && v > 0);
  assert.match(html, new RegExp(`<html[^>]*data-version="${v}"`));
  const tags = [...html.matchAll(/\?v=(\d+)"/g)].map(m => +m[1]);
  assert.equal(tags.length, 3);
  assert.ok(tags.every(t => t === v), "script tags: " + tags.join(","));
  assert.match(html, new RegExp(`Tracker v${v}\\b`));
});
