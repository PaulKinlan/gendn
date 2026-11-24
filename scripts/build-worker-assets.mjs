#!/usr/bin/env node
// Build step for the Cloudflare Worker (npm run build; wrangler runs it before every deploy/dev).
//
// Workers have no filesystem, so the files the server reads at request time are uploaded as
// static assets and the Worker reads them through the ASSETS binding (worker.ts). Workers also
// cannot list or stat assets, so this writes:
//   - dist/site-files.json: every uploaded path, turned into readDir()/exists() by indexedSiteFS().
//   - dist/site-meta.json:  precomputed commit metadata, cross-release identity index, compact
//                           conformance suite summaries, and published page catalogue so cold
//                           Worker isolates avoid hundreds of ASSETS.fetch reads.
//
// Copied into dist/site (exactly what server.ts, lib/lifecycle.ts, and lib/chromestatus.ts read):
//   v<N>/**/*.html                   release pages and nested child routes
//   v<N>/*/conformance.json          per-page suite view (/v<N>/<slug>/conformance)
//   v<N>/*/_questions.json           per-page critique view (/v<N>/<slug>/critique)
//   v<N>/**/inert-probe.js           committed MIME-seam probe (v150/focusgroup/inert-probe.js)
//   public/**                        shared styles, fonts, and public/probe-inert.js
//   _data/*.json                     embedded chromestatus resilience fallback snapshots
//   reports/conformance/index.html   /conformance/run-all
//   reports/conformance/results.json per-page conformance results
//
// Omitted from dist/site: reference-contract.json (summarized in dist/site-meta.json),
// browser-evidence.json, evidence *.png, critique *.md, and .gitkeep.
//
// wrangler.jsonc sets run_worker_first, so none of these is served directly: every request goes
// through serveRequest(), which keeps the inert-script MIME rule, CSP and revalidation.

import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  comparePagesDesc,
  extractFeatureIdentityFromHtml,
  parseConformanceSuiteSummary,
  parsePageMeta,
} from "../lib/site-index.ts";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "dist");
const site = join(out, "site");

function shouldKeepReleaseFile(relPath) {
  const name = basename(relPath);
  if (name.endsWith(".html")) return true;
  if (name === "conformance.json" || name === "_questions.json") return true;
  if (name === "inert-probe.js") return true;
  return false;
}

async function copyReleaseTree(srcDir, dstDir) {
  let copied = 0;
  for (const e of await readdir(srcDir, { withFileTypes: true })) {
    const from = join(srcDir, e.name);
    const to = join(dstDir, e.name);
    if (e.isDirectory()) {
      copied += await copyReleaseTree(from, to);
    } else if (e.isFile() && shouldKeepReleaseFile(from)) {
      await mkdir(dstDir, { recursive: true });
      await cp(from, to);
      copied++;
    }
  }
  return copied;
}

async function copyDataSnapshots() {
  const dataDir = join(root, "_data");
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const dstDir = join(site, "_data");
  let count = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    await mkdir(dstDir, { recursive: true });
    await cp(join(dataDir, e.name), join(dstDir, e.name));
    count++;
  }
  return count;
}

function readBuildCommit() {
  try {
    const raw = execFileSync("git", ["log", "-1", "--format=%H%n%h%n%cI"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [sha, shortSha, date] = raw.split("\n");
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return null;
    return {
      sha,
      shortSha: shortSha || sha.slice(0, 7),
      date: date || "",
      htmlUrl: `https://github.com/PaulKinlan/gendn/commit/${sha}`,
    };
  } catch {
    return null;
  }
}

async function collectChildHtmlRoutes(absDir, repoRelDir) {
  const outRoutes = [];
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return outRoutes;
  }
  for (const e of entries) {
    const childAbs = join(absDir, e.name);
    const childRel = `${repoRelDir}/${e.name}`;
    if (e.isDirectory()) {
      try {
        const s = await stat(join(childAbs, "index.html"));
        if (s.isFile()) outRoutes.push(`/${childRel}/`);
      } catch {
        // container dir without index.html
      }
      outRoutes.push(...await collectChildHtmlRoutes(childAbs, childRel));
    } else if (e.isFile() && e.name.endsWith(".html") && e.name !== "index.html") {
      outRoutes.push(`/${childRel}`);
    }
  }
  return outRoutes;
}

async function readTextOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function buildSiteMeta(releaseDirs) {
  const sortedReleases = [...releaseDirs].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );
  const identityIndex = {};
  const conformanceSuites = [];
  const pages = [];

  for (const release of sortedReleases) {
    const releaseAbs = join(root, release);
    const slugs = (await readdir(releaseAbs, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    for (const slug of slugs) {
      const slugAbs = join(releaseAbs, slug);
      const html = await readTextOptional(join(slugAbs, "index.html"));
      if (html !== null) {
        const identity = extractFeatureIdentityFromHtml(html);
        if (identity && !(identity in identityIndex)) {
          identityIndex[identity] = `/${release}/${slug}/`;
        }
        const [childRoutes, contractJson] = await Promise.all([
          collectChildHtmlRoutes(slugAbs, `${release}/${slug}`),
          readTextOptional(join(slugAbs, "reference-contract.json")),
        ]);
        pages.push(parsePageMeta(release, slug, html, childRoutes, contractJson));
      }

      const suiteRaw = await readTextOptional(join(slugAbs, "conformance.json"));
      if (suiteRaw !== null) {
        const summary = parseConformanceSuiteSummary(suiteRaw);
        if (summary) conformanceSuites.push(summary);
      }
    }
  }

  pages.sort(comparePagesDesc);
  conformanceSuites.sort((a, b) => a.id.localeCompare(b.id));

  return {
    commit: readBuildCommit(),
    identityIndex,
    conformanceSuites,
    pages,
  };
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

const entries = await readdir(root, { withFileTypes: true });
const releaseDirs = entries
  .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
  .map((e) => e.name)
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

await rm(out, { recursive: true, force: true });
await mkdir(site, { recursive: true });

for (const rel of releaseDirs) {
  await copyReleaseTree(join(root, rel), join(site, rel));
}

for (
  const src of ["public", "reports/conformance/index.html", "reports/conformance/results.json"]
) {
  const from = join(root, src);
  try {
    await stat(from);
  } catch {
    continue; // optional inputs (e.g. no conformance rollup yet)
  }
  await mkdir(join(site, src, ".."), { recursive: true });
  await cp(from, join(site, src), { recursive: true });
}

const snapshotCount = await copyDataSnapshots();
const files = (await listFiles(site)).sort();
const meta = await buildSiteMeta(releaseDirs);
const metaJson = JSON.stringify(meta) + "\n";

await writeFile(join(out, "site-files.json"), JSON.stringify(files) + "\n");
await writeFile(join(out, "site-meta.json"), metaJson);
console.log(
  `build-worker-assets: ${files.length} files (${snapshotCount} _data snapshots) -> dist/site; ` +
    `meta: ${meta.pages.length} pages, ${meta.conformanceSuites.length} suites, ` +
    `${Object.keys(meta.identityIndex).length} identities, commit=${
      meta.commit?.shortSha ?? "none"
    } (${Math.round(metaJson.length / 1024)} KB) -> dist/site-meta.json`,
);
