#!/usr/bin/env node
// Build step for the Cloudflare Worker (npm run build; wrangler runs it before every deploy/dev).
//
// Workers have no filesystem, so the files the server reads at request time are uploaded as
// static assets and the Worker reads them through the ASSETS binding (worker.ts). Workers also
// cannot list or stat assets, so this writes dist/site-files.json: every uploaded path, which
// lib/site-fs.ts's indexedSiteFS() turns into readDir()/exists() answers.
//
// Copied (exactly what server.ts and lib/lifecycle.ts read):
//   v<N>/**                          release pages, lifecycle artifacts, child routes
//   public/**                        shared styles and fonts
//   reports/conformance/index.html   /conformance/run-all
//   reports/conformance/results.json per-page conformance results
//
// wrangler.jsonc sets run_worker_first, so none of these is served directly: every request goes
// through serveRequest(), which keeps the inert-script MIME rule, CSP and revalidation.

import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "dist");
const site = join(out, "site");

const entries = await readdir(root, { withFileTypes: true });
const sources = [
  ...entries.filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name),
  "public",
  "reports/conformance/index.html",
  "reports/conformance/results.json",
];

await rm(out, { recursive: true, force: true });
await mkdir(site, { recursive: true });

for (const src of sources) {
  const from = join(root, src);
  try {
    await stat(from);
  } catch {
    continue; // optional inputs (e.g. no conformance rollup yet)
  }
  await mkdir(join(site, src, ".."), { recursive: true });
  await cp(from, join(site, src), { recursive: true });
}

async function listFiles(dir) {
  const files = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...await listFiles(full));
    else if (e.isFile()) files.push(relative(site, full).split("\\").join("/"));
  }
  return files;
}

const files = (await listFiles(site)).sort();
await writeFile(join(out, "site-files.json"), JSON.stringify(files) + "\n");
console.log(`build-worker-assets: ${files.length} files -> dist/site, index dist/site-files.json`);
