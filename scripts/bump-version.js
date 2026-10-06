#!/usr/bin/env node
/* Bump the site version everywhere it appears: version.json, the
   data-version attribute, the ?v= script tags and the footer stamp.
   Usage: node scripts/bump-version.js        (increments by one)
          node scripts/bump-version.js 12     (sets an exact number) */
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const vj = path.join(root, "version.json"), ih = path.join(root, "index.html");
const cur = JSON.parse(fs.readFileSync(vj, "utf8")).v;
const next = process.argv[2] ? parseInt(process.argv[2], 10) : cur + 1;
if (!Number.isInteger(next) || next <= 0) { console.error("Version must be a positive integer"); process.exit(1); }
fs.writeFileSync(vj, JSON.stringify({ v: next }) + "\n");
let html = fs.readFileSync(ih, "utf8");
html = html.replace(/data-version="\d+"/, `data-version="${next}"`)
  .replace(/\?v=\d+"/g, `?v=${next}"`)
  .replace(/Tracker v\d+/, `Tracker v${next}`);
fs.writeFileSync(ih, html);
console.log(`version ${cur} → ${next}`);
