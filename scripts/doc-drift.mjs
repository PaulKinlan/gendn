#!/usr/bin/env node
// scripts/doc-drift.mjs — Tier 2 staleness & fact-drift guard for gendn docs.
//
// Compares published pages under `v<N>/<slug>/` against the committed ChromeStatus milestone
// snapshots in `_data/features-*.json` + `_data/channels.json`, and optionally checks whether
// `built` pages have graduated onto MDN via `mdnHas()` (`--live-mdn`).
//
// Outbound network policy: NEVER uses bare `fetch()`; all live MDN HEAD probes go through
// `mdnHas()` in `lib/mdn.ts` (which uses `fetchBounded()`).
//
// Modes:
//   node scripts/doc-drift.mjs                       # offline drift check against _data/
//   node scripts/doc-drift.mjs --json                # machine-readable JSON output
//   node scripts/doc-drift.mjs --markdown            # Markdown summary (for $GITHUB_STEP_SUMMARY)
//   node scripts/doc-drift.mjs --live-mdn            # + opt-in MDN graduation HEAD probe pass
//   node scripts/doc-drift.mjs --max-age-days 90     # threshold for stale experimental docs

import * as fs from "node:fs";
import * as path from "node:path";
import * as sys from "./lib/sys.mjs";
import { metadataFromHtml, renderedMarkup } from "./lib/artifacts.mjs";
import { mdnHas } from "../lib/mdn.ts";

const DEFAULT_MAX_AGE_DAYS = 90;
const MDN_CONCURRENCY = 6;

const TRIAL_CLAIM_RE =
  /origin[ -]?trial|dev(?:eloper)?\s+trial|behind a(?:n experimental)? flag|not yet enabled by default|\bexperimental\b/i;
const SHIPPED_CLAIM_RE = /\b(?:shipped|enabled by default)\b/i;
const HISTORICAL_TRIAL_RE =
  /(?:recently\s+out\s+of|out\s+of|graduated\s+from|was\s+an?|former)\s+(?:a\s+)?(?:chrome\s+)?origin[ -]?trial|origin[ -]?trial\s+(?:ran|ended|stage|feature\s+name)/gi;

const SAFE_MDN_SEGMENT_RE = /^[A-Za-z0-9_@:-]+$/;

/**
 * Load all `_data/features-<N>.json` snapshots and build a Map:
 *   `chromestatusId -> { milestones: [{ milestone, category, name, isReleased }] }`
 */
export function loadDataIndex(dataDir) {
  const index = new Map();
  if (!fs.existsSync(dataDir)) return index;
  const files = fs.readdirSync(dataDir).sort();
  for (const file of files) {
    const match = file.match(/^features-(\d+)\.json$/);
    if (!match) continue;
    const milestone = Number(match[1]);
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
    const byType = parsed?.features_by_type;
    if (!byType || typeof byType !== "object" || Array.isArray(byType)) continue;
    for (const [category, list] of Object.entries(byType)) {
      if (!Array.isArray(list)) continue;
      for (const feat of list) {
        if (feat?.id == null) continue;
        const id = String(feat.id);
        if (!index.has(id)) index.set(id, { milestones: [] });
        index.get(id).milestones.push({
          milestone,
          category,
          name: String(feat.name ?? ""),
          isReleased: Boolean(feat.is_released),
        });
      }
    }
  }
  for (const record of index.values()) {
    record.milestones.sort((a, b) => a.milestone - b.milestone);
  }
  return index;
}

/** Return the set of milestone numbers that have a `_data/features-<N>.json` snapshot. */
export function loadAvailableMilestones(dataDir) {
  const milestones = new Set();
  if (!fs.existsSync(dataDir)) return milestones;
  for (const file of fs.readdirSync(dataDir)) {
    const match = file.match(/^features-(\d+)\.json$/);
    if (match) milestones.add(Number(match[1]));
  }
  return milestones;
}

/** Read the current Stable milestone from `_data/channels.json` (or `null` if unavailable). */
export function loadCurrentStable(dataDir) {
  const channelsPath = path.join(dataDir, "channels.json");
  if (!fs.existsSync(channelsPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(channelsPath, "utf8"));
    const mstone = Number(parsed?.stable?.mstone ?? parsed?.stable?.version);
    return Number.isInteger(mstone) && mstone > 0 ? mstone : null;
  } catch {
    return null;
  }
}

function pageClaimsTrialStatus(pageMeta) {
  if (pageMeta.status === "stub") return false;
  const hasStructuredFields = pageMeta.eyebrow !== undefined || pageMeta.warnText !== undefined;
  const eyebrow = String(pageMeta.eyebrow ?? "");
  const warnText = String(pageMeta.warnText ?? "");

  if (eyebrow) {
    if (TRIAL_CLAIM_RE.test(eyebrow)) return true;
    if (SHIPPED_CLAIM_RE.test(eyebrow)) return false;
  }
  if (warnText) {
    if (/\bnot yet enabled by default\b/i.test(warnText)) return true;
    const cleanedWarn = warnText.replace(HISTORICAL_TRIAL_RE, "");
    const claimsEnabledByDefault =
      /\b(?:is|are|ships?|records?\s+this\s+feature)\s+enabled by default\b/i.test(cleanedWarn);
    if (!claimsEnabledByDefault && TRIAL_CLAIM_RE.test(cleanedWarn)) return true;
  }
  if (!hasStructuredFields && typeof pageMeta.experimental === "boolean") {
    return pageMeta.experimental;
  }
  return false;
}

function parseIsoDateMs(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

function latestReviewDate(pageMeta) {
  const candidates = [
    { field: "assessedAt", raw: pageMeta.assessedAt, ms: parseIsoDateMs(pageMeta.assessedAt) },
    { field: "reviewedAt", raw: pageMeta.reviewedAt, ms: parseIsoDateMs(pageMeta.reviewedAt) },
  ].filter((c) => c.ms !== null);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.ms - a.ms);
  return candidates[0];
}

/**
 * Pure drift detector for one published page against the `_data/` ChromeStatus index.
 *
 * Detects:
 *   1. `shipped-after-trial` — page claims Origin Trial / Developer Trial / behind a flag, yet
 *      `_data/` records the same `chromestatusId` as `"Enabled by default"` at `<= currentStable`.
 *   2. `stale-experimental` — page is Origin Trial / Developer Trial / experimental and its most
 *      recent `assessedAt` / `reviewedAt` timestamp is older than `maxAgeDays`.
 *   3. `milestone-moved` / `missing-chromestatus-record` — page's milestone has a `_data/`
 *      snapshot, yet the feature ID moved to a different milestone or is absent from `_data/`.
 */
export function detectStatusDrift(
  pageMeta,
  dataIndex,
  {
    now = new Date(),
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    currentStable = null,
    availableMilestones = null,
  } = {},
) {
  const findings = [];
  const identity = pageMeta?.identity != null ? String(pageMeta.identity) : null;
  const record = identity ? dataIndex.get(identity) ?? null : null;
  const claimsTrial = pageClaimsTrialStatus(pageMeta);

  // 1. Shipped-after-trial drift
  if (claimsTrial && record) {
    const shipped = record.milestones.find(
      (entry) =>
        entry.category === "Enabled by default" &&
        (currentStable === null || entry.milestone <= currentStable),
    );
    if (shipped) {
      findings.push({
        kind: "shipped-after-trial",
        severity: "high",
        id: pageMeta.id,
        route: pageMeta.route ?? `/${pageMeta.id}/`,
        identity,
        pageMilestone: pageMeta.milestone,
        shippedMilestone: shipped.milestone,
        featureName: shipped.name || pageMeta.h1 || "",
        message:
          `Page documents trial/flag status (v${pageMeta.milestone}), but ChromeStatus ${identity} ` +
          `is now "Enabled by default" in Chrome ${shipped.milestone}` +
          (currentStable !== null ? ` (current stable: ${currentStable})` : ""),
      });
    }
  }

  // 2. Expired / stale experimental doc
  if (claimsTrial) {
    const latest = latestReviewDate(pageMeta);
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (latest && Number.isFinite(nowMs)) {
      const ageDays = Math.floor((nowMs - latest.ms) / 86_400_000);
      if (ageDays > maxAgeDays) {
        findings.push({
          kind: "stale-experimental",
          severity: "medium",
          id: pageMeta.id,
          route: pageMeta.route ?? `/${pageMeta.id}/`,
          identity,
          pageMilestone: pageMeta.milestone,
          lastReviewed: latest.raw,
          ageDays,
          maxAgeDays,
          message:
            `Experimental/trial doc last reviewed ${latest.raw} (${ageDays}d ago, threshold ${maxAgeDays}d)`,
        });
      }
    }
  }

  // 3. Missing / moved ChromeStatus record (only when this page's milestone exists in _data/)
  const milestoneSet = availableMilestones ?? deriveMilestonesFromIndex(dataIndex);
  if (identity && Number.isInteger(pageMeta.milestone) && milestoneSet.has(pageMeta.milestone)) {
    if (!record) {
      findings.push({
        kind: "missing-chromestatus-record",
        severity: "low",
        id: pageMeta.id,
        route: pageMeta.route ?? `/${pageMeta.id}/`,
        identity,
        pageMilestone: pageMeta.milestone,
        message:
          `ChromeStatus ${identity} is not present in _data/features-${pageMeta.milestone}.json ` +
          `(feature may have moved, been unlisted, or been dropped)`,
      });
    } else if (!record.milestones.some((m) => m.milestone === pageMeta.milestone)) {
      const seen = [...new Set(record.milestones.map((m) => `M${m.milestone}:${m.category}`))];
      findings.push({
        kind: "milestone-moved",
        severity: "low",
        id: pageMeta.id,
        route: pageMeta.route ?? `/${pageMeta.id}/`,
        identity,
        pageMilestone: pageMeta.milestone,
        observedMilestones: record.milestones.map((m) => m.milestone),
        message: `ChromeStatus ${identity} is not listed under v${pageMeta.milestone} in _data/; ` +
          `found under ${seen.join(", ")}`,
      });
    }
  }

  return findings;
}

function deriveMilestonesFromIndex(dataIndex) {
  const set = new Set();
  for (const record of dataIndex.values()) {
    for (const m of record.milestones ?? []) set.add(m.milestone);
  }
  return set;
}

/**
 * Derive conservative, URL-safe candidate MDN documentation paths for a `built` page.
 * Validates each path segment strictly so untrusted/page-derived text cannot inject URL syntax.
 */
export function deriveCandidateMdnPaths(pageMeta) {
  if (Array.isArray(pageMeta.candidateMdnPaths)) {
    return pageMeta.candidateMdnPaths.filter(
      (p) => typeof p === "string" && p.startsWith("/en-US/docs/"),
    );
  }
  const paths = new Set();

  // Prefer explicit WebIDL interface inventory names from reference-contract.json
  for (const name of pageMeta.interfaceNames ?? []) {
    const clean = String(name).trim();
    if (/^[A-Z][A-Za-z0-9]+$/.test(clean) && SAFE_MDN_SEGMENT_RE.test(clean)) {
      paths.add(`/en-US/docs/Web/API/${encodeURIComponent(clean)}`);
    }
  }

  // Prefer explicit CSS property/selector inventory names from reference-contract.json
  for (const cssName of pageMeta.cssNames ?? []) {
    const clean = String(cssName).trim().replace(/^::?/, "");
    if (/^[a-z][a-z0-9-]+$/.test(clean) && SAFE_MDN_SEGMENT_RE.test(clean)) {
      paths.add(`/en-US/docs/Web/CSS/${encodeURIComponent(clean)}`);
    }
  }

  // Fallback: single PascalCase API interface token in h1 (e.g., "CloseWatcher API")
  if (paths.size === 0 && typeof pageMeta.h1 === "string") {
    const apiMatch = pageMeta.h1.match(/\b([A-Z][a-z]+[A-Z][A-Za-z0-9]+)\b/);
    if (apiMatch && SAFE_MDN_SEGMENT_RE.test(apiMatch[1])) {
      paths.add(`/en-US/docs/Web/API/${encodeURIComponent(apiMatch[1])}`);
    }
  }

  return [...paths].slice(0, 2);
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Check whether any `built` page's candidate MDN URL now returns `{ kind: "present" }`.
 * Accepts an injectable `mdnLookupFn` (defaults to `mdnHas` from `lib/mdn.ts`).
 * Explicitly ignores `{ kind: "missing" }` and `{ kind: "unknown" }`.
 */
export async function detectMdnGraduation(pages, mdnLookupFn = mdnHas) {
  const builtPages = pages.filter((p) => p && p.status === "built");
  const checks = [];
  for (const page of builtPages) {
    const candidates = deriveCandidateMdnPaths(page);
    if (candidates.length > 0) checks.push({ page, candidates });
  }

  const findings = [];
  await mapConcurrent(checks, MDN_CONCURRENCY, async ({ page, candidates }) => {
    for (const mdnPath of candidates) {
      const result = await mdnLookupFn(mdnPath);
      if (result?.kind === "present") {
        findings.push({
          kind: "mdn-graduated",
          severity: "info",
          id: page.id,
          route: page.route ?? `/${page.id}/`,
          identity: page.identity ?? null,
          mdnPath,
          mdnUrl: `https://developer.mozilla.org${mdnPath}`,
          message:
            `Built page ${page.id} has a live MDN page at https://developer.mozilla.org${mdnPath} ` +
            `(verify whether MDN now covers this feature)`,
        });
        break;
      }
    }
  });

  findings.sort((a, b) => a.id.localeCompare(b.id));
  return findings;
}

// ---------- corpus loading ----------

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function loadPublishedPagesMeta(root = ".") {
  const pages = [];
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const rel of entries) {
    if (!rel.isDirectory() || !/^v\d+$/.test(rel.name)) continue;
    const relDir = path.join(root, rel.name);
    const slugs = fs.readdirSync(relDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const pageDir = path.join(relDir, slug.name);
      const idxPath = path.join(pageDir, "index.html");
      if (!fs.existsSync(idxPath)) continue;
      const html = fs.readFileSync(idxPath, "utf8");
      const pagePath = `${rel.name}/${slug.name}/index.html`;
      const meta = metadataFromHtml(pagePath, html);
      const visible = renderedMarkup(html);
      const eyebrow = visible.match(
        /<p\b[^>]*class=["'][^"']*\beyebrow\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
      )?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";
      const warnText = visible.match(
        /<div\b[^>]*class=["'][^"']*\bwarn-block\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      )?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";

      const contract = readJsonSafe(path.join(pageDir, "reference-contract.json"));
      const questions = readJsonSafe(path.join(pageDir, "_questions.json"));

      const interfaceNames = [];
      const cssNames = [];
      for (const item of contract?.inventory ?? []) {
        if (item.kind === "interface" && typeof item.name === "string") {
          const token = item.name.split(/[\s.(]/)[0];
          if (token) interfaceNames.push(token);
        } else if (
          (item.kind === "css-property" || item.kind === "css-descriptor") &&
          typeof item.name === "string"
        ) {
          const token = item.name.split(/[\s:(]/)[0];
          if (token) cssNames.push(token);
        }
      }

      pages.push({
        ...meta,
        eyebrow,
        warnText,
        assessedAt: contract?.assessedAt ?? null,
        reviewedAt: questions?.reviewedAt ?? null,
        interfaceNames,
        cssNames,
      });
    }
  }
  return pages;
}

export async function runDocDrift({
  root = ".",
  now = new Date(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  liveMdn = false,
  mdnLookupFn = mdnHas,
} = {}) {
  const dataDir = path.join(root, "_data");
  const dataIndex = loadDataIndex(dataDir);
  const availableMilestones = loadAvailableMilestones(dataDir);
  const currentStable = loadCurrentStable(dataDir);
  const pages = loadPublishedPagesMeta(root);

  // Track which identities already have a newer published page at/after the shipped milestone.
  const pagesByIdentity = new Map();
  for (const p of pages) {
    if (!p.identity) continue;
    if (!pagesByIdentity.has(p.identity)) pagesByIdentity.set(p.identity, []);
    pagesByIdentity.get(p.identity).push(p);
  }

  const statusFindings = [];
  for (const page of pages) {
    const pageFindings = detectStatusDrift(page, dataIndex, {
      now,
      maxAgeDays,
      currentStable,
      availableMilestones,
    });
    for (const f of pageFindings) {
      if (f.kind === "shipped-after-trial" && f.identity) {
        const siblings = (pagesByIdentity.get(f.identity) ?? [])
          .filter((s) => s.id !== f.id && s.milestone >= f.shippedMilestone)
          .map((s) => s.id);
        if (siblings.length > 0) f.newerPublishedSibling = siblings;
      }
      statusFindings.push(f);
    }
  }

  const mdnFindings = liveMdn ? await detectMdnGraduation(pages, mdnLookupFn) : [];
  const findings = [...statusFindings, ...mdnFindings];

  const counts = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;

  return {
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    currentStable,
    maxAgeDays,
    liveMdn,
    summary: {
      pagesScanned: pages.length,
      dataFeaturesIndexed: dataIndex.size,
      dataMilestones: [...availableMilestones].sort((a, b) => a - b),
      totalFindings: findings.length,
      byKind: counts,
    },
    findings,
  };
}

export function formatMarkdownReport(report) {
  const s = report.summary;
  const lines = [
    "## gendn Doc Drift & Staleness Report",
    "",
    `- **Pages scanned:** ${s.pagesScanned}`,
    `- **ChromeStatus snapshots:** ${s.dataFeaturesIndexed} features across ${s.dataMilestones.length} milestones (current stable: ${
      report.currentStable ?? "unknown"
    })`,
    `- **Live MDN probe:** ${report.liveMdn ? "enabled" : "skipped (offline mode)"}`,
    `- **Stale experimental threshold:** ${report.maxAgeDays} days`,
    `- **Total findings:** ${s.totalFindings}`,
    "",
  ];

  const groups = [
    ["shipped-after-trial", "Shipped After Trial (High)"],
    ["stale-experimental", "Stale Experimental Docs (Medium)"],
    ["milestone-moved", "Milestone Moved in ChromeStatus (Low)"],
    ["missing-chromestatus-record", "Missing ChromeStatus Snapshot Record (Low)"],
    ["mdn-graduated", "Potential MDN Graduations (Info)"],
  ];

  for (const [kind, heading] of groups) {
    const items = report.findings.filter((f) => f.kind === kind);
    if (items.length === 0) continue;
    lines.push(`### ${heading} (${items.length})`, "");
    lines.push("| Page | ChromeStatus | Details |");
    lines.push("| --- | --- | --- |");
    for (const item of items) {
      const cs = item.identity
        ? `[${item.identity}](https://chromestatus.com/feature/${item.identity})`
        : "—";
      const siblingNote = item.newerPublishedSibling?.length
        ? ` _(newer sibling: \`${item.newerPublishedSibling.join("`, `")}\`)_`
        : "";
      const detail = item.message.replace(/\|/g, "\\|") + siblingNote;
      lines.push(`| \`${item.id}\` | ${cs} | ${detail} |`);
    }
    lines.push("");
  }

  if (report.findings.length === 0) {
    lines.push("No drift or staleness findings detected.");
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = { json: false, markdown: false, liveMdn: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--markdown") opts.markdown = true;
    else if (arg === "--live-mdn") opts.liveMdn = true;
    else if (arg === "--max-age-days" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`Invalid --max-age-days value: ${argv[i]}`);
        process.exit(2);
      }
      opts.maxAgeDays = n;
    } else if (arg.startsWith("--max-age-days=")) {
      const n = Number(arg.slice("--max-age-days=".length));
      if (!Number.isFinite(n) || n < 0) {
        console.error(`Invalid --max-age-days value: ${arg}`);
        process.exit(2);
      }
      opts.maxAgeDays = n;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/doc-drift.mjs [--json] [--markdown] [--live-mdn] [--max-age-days N]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

if (sys.isMain(import.meta.url)) {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const opts = parseArgs(sys.args);
  const report = await runDocDrift({
    root,
    maxAgeDays: opts.maxAgeDays,
    liveMdn: opts.liveMdn,
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (opts.markdown) {
    console.log(formatMarkdownReport(report));
  } else {
    const s = report.summary;
    const byKind = Object.entries(s.byKind)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(
      `doc-drift: ${s.pagesScanned} pages scanned against ${s.dataFeaturesIndexed} ChromeStatus ` +
        `features (current stable: ${report.currentStable ?? "unknown"})`,
    );
    console.log(
      `  findings: ${s.totalFindings}${byKind ? ` [${byKind}]` : " (none)"}` +
        (opts.liveMdn ? " [live-mdn=on]" : " [live-mdn=off]"),
    );
    for (const f of report.findings) {
      const sibling = f.newerPublishedSibling?.length
        ? ` (newer sibling: ${f.newerPublishedSibling.join(", ")})`
        : "";
      console.log(`  [${f.severity.toUpperCase()} ${f.kind}] ${f.id} — ${f.message}${sibling}`);
    }
  }
}
