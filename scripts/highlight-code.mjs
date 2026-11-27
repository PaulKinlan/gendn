#!/usr/bin/env node
// scripts/highlight-code.mjs — idempotently apply subtle static syntax highlighting
// (<span class="hl-*">) to <pre><code> blocks across all published v<N>/**/*.html pages.
//
// Usage:
//   node scripts/highlight-code.mjs           # highlight all v<N>/**/*.html in place
//   node scripts/highlight-code.mjs --check   # exit 1 if any page is unhighlighted / out of sync
//   node scripts/highlight-code.mjs --page v157/cors-enforcement-for-background-fetch

import * as fs from "node:fs";
import * as path from "node:path";
import { highlightHtmlDocument } from "../lib/syntax-highlight.ts";

function walkHtml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkHtml(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const pageFlag = args.indexOf("--page");
const pageTarget = pageFlag >= 0 ? args[pageFlag + 1] : null;

const root = process.cwd();
let htmlFiles = [];
if (pageTarget) {
  const clean = pageTarget.replace(/^\/+|\/+$/g, "");
  const abs = path.join(root, clean);
  if (!fs.existsSync(abs)) {
    console.error(`highlight-code: page path not found: ${clean}`);
    process.exit(2);
  }
  htmlFiles = fs.statSync(abs).isDirectory() ? walkHtml(abs) : [abs];
} else {
  const releases = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const rel of releases) {
    walkHtml(path.join(root, rel), htmlFiles);
  }
}
htmlFiles.sort();

let filesChanged = 0;
let totalBlocks = 0;
let totalSkippedMarkup = 0;
const staleFiles = [];

for (const file of htmlFiles) {
  const original = fs.readFileSync(file, "utf8");
  const result = highlightHtmlDocument(original);
  totalBlocks += result.blocksHighlighted;
  totalSkippedMarkup += result.blocksSkippedWithMarkup;
  if (result.changed) {
    filesChanged++;
    const rel = path.relative(root, file);
    if (checkOnly) {
      staleFiles.push(rel);
    } else {
      fs.writeFileSync(file, result.html, "utf8");
    }
  }
}

if (checkOnly) {
  if (staleFiles.length > 0) {
    console.error(
      `highlight-code --check: ${staleFiles.length} file(s) need highlighting (run: npm run highlight-code)`,
    );
    for (const rel of staleFiles.slice(0, 20)) console.error(`  - ${rel}`);
    if (staleFiles.length > 20) console.error(`  ... and ${staleFiles.length - 20} more`);
    process.exit(1);
  }
  console.log(
    `highlight-code --check: PASS (${htmlFiles.length} HTML files, ${totalBlocks} code blocks up to date, ${totalSkippedMarkup} markup-bearing block(s) preserved)`,
  );
} else {
  console.log(
    `highlight-code: ${filesChanged} of ${htmlFiles.length} HTML file(s) updated (${totalBlocks} code blocks highlighted, ${totalSkippedMarkup} markup-bearing block(s) preserved)`,
  );
}
