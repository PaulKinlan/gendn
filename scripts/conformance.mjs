#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-net --allow-env
// conformance.mjs — deterministic, headless-Chrome-backed runner for gendn's conformance suites,
// plus the mobile+desktop responsive-check harness.
//
// It boots the gendn server on an ephemeral port, drives headless Chrome over CDP (scripts/lib/
// cdp.mjs), runs each suite's auto assertions, and emits exact counts: tested / total / pass / fail
// / blocked. `blocked` is explicit and NEVER a pass — it is either a manual-evidenced assertion with
// no recorded verdict (manual-pending) or a device/feature genuinely unavailable. Determinism: fixed
// viewports, load-event waits, a fixed settle window, and same-origin-only network-failure scope
// (external showcase iframes / CDNs are out of gendn's control and don't fail the doc-quality gate).
//
// Modes:
//   deno task conformance                      # run all suites, CLI + HTML rollup
//   deno task conformance --page v149/webmcp   # run one suite, CLI table
//   deno task responsive                       # mobile+desktop responsive-check across pages
//   deno task responsive --page v149/webmcp --screenshots  # + save screenshots for agent review
//   (--limit N samples the first N pages; --update-support writes responsive-support.json)
//
// Outputs: reports/conformance/results.json, reports/conformance/index.html (run-all rollup),
// and, in responsive mode, reports/conformance/shots/*.png when --screenshots is given.

import { launch } from "./lib/cdp.mjs";
import {
  collectPublishedPages,
  collectSuites,
  loadSupport,
  metadataFromHtml,
  readJson,
  SUPPORT_SIDECAR,
} from "./lib/artifacts.mjs";

const DESKTOP = { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 };
const MOBILE = { width: 360, height: 740, mobile: true, deviceScaleFactor: 3 };
const OUT_DIR = "reports/conformance";
const AUTO_KINDS = new Set([
  "http-status",
  "dom-query",
  "dom-count",
  "dom-text-contains",
  "js-eval",
  "no-console-errors",
  "no-failed-requests",
]);

function sameOrigin(url, origin) {
  return typeof url === "string" && url.startsWith(origin);
}

// ---------- server boot ----------

async function spawnServer(port) {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-read", "--allow-env", "server.ts"],
    env: { ...Deno.env.toObject(), PORT: String(port) },
    stdout: "null",
    stderr: "null",
  });
  const child = cmd.spawn();
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${base}/`);
      const ok = res.ok;
      await res.body?.cancel();
      if (ok) return { child, base, origin: base, port };
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    child.kill();
  } catch {
    // ignore
  }
  throw new Error("gendn server did not start");
}

async function startServer() {
  const port = 3200 + Math.floor(Math.random() * 400);
  return await spawnServer(port);
}

// Health-check the long-lived server; if it died (cumulative resource pressure over a full 155-page
// run), respawn it on the SAME port so ctx.base stays valid. Keeps a run-all deterministic + robust.
async function ensureServer(server) {
  try {
    const res = await fetch(`${server.base}/`, { signal: AbortSignal.timeout(4000) });
    const ok = res.ok;
    await res.body?.cancel();
    if (ok) return server;
  } catch {
    // down — restart below
  }
  try {
    server.child.kill();
  } catch {
    // ignore
  }
  try {
    await server.child.status;
  } catch {
    // ignore
  }
  const fresh = await spawnServer(server.port);
  server.child = fresh.child;
  return server;
}

// ---------- assertion evaluation ----------

function coerce(v) {
  if (typeof v === "string" && v.startsWith("__THREW__")) {
    return { ok: false, reason: v.slice("__THREW__:".length) };
  }
  return { ok: !!v };
}

async function evalAuto(page, a, origin) {
  switch (a.kind) {
    case "dom-query":
      return coerce(await page.evaluate(`!!document.querySelector(${JSON.stringify(a.selector)})`));
    case "dom-count":
      return coerce(
        await page.evaluate(
          `document.querySelectorAll(${JSON.stringify(a.selector)}).length >= ${a.min ?? 1}`,
        ),
      );
    case "dom-text-contains":
      return coerce(
        await page.evaluate(
          `[...document.querySelectorAll(${
            JSON.stringify(a.selector)
          })].some(e => e.textContent.includes(${JSON.stringify(String(a.expect))}))`,
        ),
      );
    case "js-eval":
      return coerce(await page.evaluate(a.test));
    case "no-console-errors": {
      const errs = page.diagnostics().consoleErrors;
      return { ok: errs.length === 0, reason: errs.slice(0, 2).join(" | ") };
    }
    case "no-failed-requests": {
      const fails = page.diagnostics().failedRequests.filter((f) => sameOrigin(f.url, origin));
      return { ok: fails.length === 0, reason: fails.slice(0, 2).map((f) => f.error).join(" | ") };
    }
    default:
      return { ok: false, reason: `unknown kind ${a.kind}` };
  }
}

async function runSuite(suite, ctx) {
  const { base, origin, desktop, mobile } = ctx;
  const results = [];

  // http-status assertions are checked with a direct request (deterministic).
  const httpAsserts = suite.assertions.filter((a) => a.kind === "http-status");
  const httpStatuses = {};
  for (const a of httpAsserts) {
    try {
      const res = await fetch(`${base}${a.test}`, { redirect: "manual" });
      httpStatuses[a.id] = res.status;
      await res.body?.cancel();
    } catch {
      httpStatuses[a.id] = 0;
    }
  }

  // Load desktop once, mobile once.
  await desktop.goto(`${base}${suite.route}`);
  await mobile.goto(`${base}${suite.route}`);

  for (const a of suite.assertions) {
    if (a.kind === "manual-evidenced") {
      results.push({
        id: a.id,
        category: a.category,
        deviceClass: a.deviceClass,
        status: "blocked",
        reason: "manual-pending (needs agent screenshot/source review)",
      });
      continue;
    }
    if (!AUTO_KINDS.has(a.kind)) {
      results.push({ id: a.id, status: "blocked", reason: `non-auto kind ${a.kind}` });
      continue;
    }
    let outcome;
    if (a.kind === "http-status") {
      const got = httpStatuses[a.id];
      outcome = { ok: got === (a.expect ?? 200), reason: `HTTP ${got}` };
    } else {
      const page = a.deviceClass === "mobile" ? mobile : desktop;
      outcome = await evalAuto(page, a, origin);
    }
    results.push({
      id: a.id,
      category: a.category,
      deviceClass: a.deviceClass,
      status: outcome.ok ? "pass" : "fail",
      reason: outcome.ok ? undefined : (outcome.reason || "assertion false"),
    });
  }

  const total = results.length;
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const blocked = results.filter((r) => r.status === "blocked").length;
  return {
    id: suite.id,
    route: suite.route,
    status: suite.status,
    total,
    pass,
    fail,
    blocked,
    results,
  };
}

// ---------- responsive-check harness ----------

// Discriminating overflow check (gendn-z5w, same defect as gendn-uce).
//
// The previous expression compared scrollWidth against window.innerWidth. Under CDP mobile
// emulation window.innerWidth tracks the CONTENT width: a mutation-proof harness measured it
// equal to scrollWidth (507 and 453) exactly when the page overflowed, which makes
// `scrollWidth <= innerWidth + 1` tautological - it passed on pages whose text was visibly cut
// off by `body { overflow-x: hidden }`. A green check on a broken page is the whole reason
// gendn-uce exists. documentElement.clientWidth is the true viewport (360 in the mobile class).
//
// The harness mutation-proved this exact form on three pages: mutated (fix absent) fails at
// 507 vs 360, fixed passes at 360 vs 360, and a known-clean control passes in both arms.
//
// It also refuted the tempting alternative, which is why the obvious shape is NOT used here:
// a position check over getBoundingClientRect().right measures the BORDER BOX, not glyph paint,
// so it misses long-word text overflow entirely (an h1 whose box right is 336 while its glyphs
// paint to 478.4), and it flagged `pre > code` - a legitimate horizontal scroller - as a
// permanent false positive. Measuring real overflow beats measuring the box that contains it.
const OVERFLOW =
  "document.documentElement.scrollWidth <= (document.documentElement.clientWidth + 1)";

// Single source of truth for a device class's responsive verdict (gendn-jeq): the same
// four-field conjunction used to be written twice — inline for the per-page ok/REVIEW tokens
// and again in the end-of-run summary — and two copies of a classification can drift, which
// would make the summary headline contradict the per-page detail. One helper, both callers.
function classOk(d) {
  return d.noOverflow && d.controlsInView && d.consoleClean && d.networkClean;
}

async function responsiveCheck(pageId, meta, ctx, { screenshots }) {
  const { base, origin, desktop, mobile } = ctx;
  const route = meta.route;
  const out = { id: pageId, route, desktop: {}, mobile: {} };

  for (const [cls, page] of [["desktop", desktop], ["mobile", mobile]]) {
    await page.goto(`${base}${route}`);
    const noOverflow = coerce(await page.evaluate(OVERFLOW)).ok;
    // No interactive control positioned off the viewport horizontally (gendn-1ml).
    //
    // The old expression compared control rects against window.innerWidth, which under CDP mobile
    // emulation tracks the CONTENT width (the OVERFLOW check above was recalibrated off it for the
    // same reason). Once z5w removed the pages' real overflow the viewport was honestly 360, and
    // routes whose links sit inside horizontal .table-wrap scrollers were flagged. Measured on the
    // failing set (gendn-1ml): 54 of 54 offending elements were <a> links inside a .table-wrap
    // (0 outside a scroller), no route had document-level overflow, and scrolling each wrapper to
    // its end (scrollLeft 0 to 232) brought every flagged link back inside the viewport (right
    // edges 168.6-317.1 against 360). A control is therefore in-view when it is within
    // documentElement.clientWidth, OR when it has an ancestor (parentElement walk up to
    // documentElement) whose computed overflowX is auto|scroll and which is itself within the
    // viewport - i.e. it is reachable by scrolling rather than clipped.
    const controlsInView = coerce(
      await page.evaluate(
        "[...document.querySelectorAll('a,button,input,select,summary,[tabindex]')].every(el => { const r = el.getBoundingClientRect(); if (r.width === 0) return true; const vw = document.documentElement.clientWidth; if (r.left >= -1 && r.right <= vw + 1) return true; for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) { const ox = getComputedStyle(n).overflowX; if (ox === 'auto' || ox === 'scroll') { const nr = n.getBoundingClientRect(); return nr.left >= -1 && nr.right <= vw + 1; } } return false; })",
      ),
    ).ok;
    const consoleClean = page.diagnostics().consoleErrors.length === 0;
    const networkClean = page.diagnostics().failedRequests.filter((f) =>
      sameOrigin(f.url, origin)
    ).length === 0;
    out[cls] = { noOverflow, controlsInView, consoleClean, networkClean };
    if (screenshots) {
      const shot = `${OUT_DIR}/shots/${pageId.replace(/\//g, "__")}.${cls}.png`;
      await Deno.mkdir(`${OUT_DIR}/shots`, { recursive: true });
      await page.screenshot(shot);
      out[cls].screenshot = shot;
    }
  }
  return out;
}

// ---------- rollup rendering ----------

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRollup(runAll) {
  const agg = runAll.reduce(
    (o, s) => {
      o.total += s.total;
      o.pass += s.pass;
      o.fail += s.fail;
      o.blocked += s.blocked;
      return o;
    },
    { total: 0, pass: 0, fail: 0, blocked: 0 },
  );
  const rows = runAll.map((s) => {
    const tested = s.pass + s.fail;
    const cls = s.fail > 0 ? "fail" : "ok";
    return `<tr class="${cls}"><td><a href="${esc(s.route)}">${esc(s.id)}</a></td><td>${
      esc(s.status)
    }</td><td>${tested}/${s.total}</td><td class="p">${s.pass}</td><td class="f">${s.fail}</td><td class="b">${s.blocked}</td></tr>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>conformance rollup — gendn</title>
<link rel="stylesheet" href="/public/styles.css">
<style>
  main { max-width: 1100px; }
  table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: 0.85rem; }
  th, td { padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--border-black); text-align: left; }
  th { background: var(--bg-stone); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; }
  tr.fail td { background: color-mix(in srgb, var(--accent-rose, #b00) 8%, transparent); }
  td.p { color: var(--accent-emerald, #087); } td.f { color: var(--accent-rose, #b00); } td.b { color: var(--text-muted); }
  .summary { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
  .stat { border: 2px solid var(--border-black); padding: 0.6rem 1rem; box-shadow: var(--thin-shadow); }
  .stat .n { font-family: var(--font-display); font-size: 1.8rem; }
  .stat .l { font-family: var(--font-mono); font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); }
  @media (max-width:640px){ main{padding:1rem;} table,thead,tbody,tr,td{display:block;width:100%;} thead{display:none;} tr{border:2px solid var(--border-black);margin-bottom:0.6rem;padding:0.5rem;} td{border:none;} }
</style></head>
<body><main>
  <p class="crumbs"><a href="/">&larr; home</a></p>
  <header class="lede-block"><p class="eyebrow">conformance</p><h1>conformance rollup</h1>
  <p class="lede">Deterministic headless-Chrome run of every reference page's immutable conformance suite. Blocked = manual-evidenced (needs agent review) or genuinely unavailable — never a pass.</p></header>
  <div class="summary">
    <div class="stat"><div class="n">${runAll.length}</div><div class="l">suites</div></div>
    <div class="stat"><div class="n">${agg.total}</div><div class="l">assertions</div></div>
    <div class="stat"><div class="n">${agg.pass}</div><div class="l">pass</div></div>
    <div class="stat"><div class="n">${agg.fail}</div><div class="l">fail</div></div>
    <div class="stat"><div class="n">${agg.blocked}</div><div class="l">blocked</div></div>
  </div>
  <table><thead><tr><th>page</th><th>status</th><th>tested/total</th><th>pass</th><th>fail</th><th>blocked</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <footer class="byline">generated by scripts/conformance.mjs</footer>
</main></body></html>`;
}

// ---------- main ----------

// A scoped run merges into whatever the report already holds; a missing or unparseable report is
// treated as empty rather than aborting the scan (the scan's own results are still written).
export async function readResponsiveRows(path, { warn = console.error } = {}) {
  return await readReportRows(path, { warn, what: "rows" });
}

// The reader the merge depends on, shared for the same reason the merge is (gendn-502). It has to
// handle BOTH report shapes, because they differ: the responsive report is a top-level ARRAY of
// rows, while results.json is an OBJECT carrying its array at `suites`. My first version of this
// only handled the array, and the unit probe passed because it fed the shared helper arrays - the
// end-to-end scoped run still truncated 198 suites to 1 with the warning filtered out of sight.
export async function readReportRows(
  path,
  { warn = console.error, what = "entries", key = null } = {},
) {
  const shape = key ? `an object carrying an array of ${what} at ${key}` : `an array of ${what}`;
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    const rows = Array.isArray(parsed)
      ? parsed
      : (key && Array.isArray(parsed?.[key]) ? parsed[key] : null);
    if (!rows) {
      warn(`! ${path} is not ${shape} - treating it as empty`);
      return [];
    }
    return rows.filter((row) => row && typeof row === "object" && typeof row.id === "string");
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return []; // first scoped run: nothing to merge into
    // A CORRUPT report is the dangerous case, not the missing one: the merge would silently rewrite
    // it to just the pages this run scanned, so say so rather than degrade it quietly (gendn-jvh
    // review P2). The tolerant behaviour stays - the scan's own results are still worth writing.
    warn(
      `! ${path} is unreadable (${err.message}) - treating it as empty; a scoped run will write ` +
        `only the entries it scanned`,
    );
    return [];
  }
}

// ---------- the tracked responsive report: WHOLESALE on a full run, MERGED on a scoped run -------
// gendn-jvh, measured during the sgc pilot: `responsive --page <id>` is the documented way to check
// ONE page, but the reporter wrote only the pages it had scanned, so a scoped run TRUNCATED the
// tracked reports/conformance/responsive.json from 198 rows to 1 (2 insertions / 3154 deletions in
// a tracked file). A tracked generated file is a mutation target no assertion covered, and the
// resulting diff reads like a deliberate regeneration. So the scope decides: a FULL run still
// regenerates wholesale (that is how catalogue additions and removals reach the report), while a
// SCOPED run merges - other pages keep their rows, the scanned pages replace their own rows IN
// PLACE so the file order stays stable, and a newly scanned page is appended.
// ---------- THE SHARED SHAPE (gendn-502): a tracked report must be WHOLESALE on a full run and
// MERGED on a scoped one, for EVERY report this runner writes, not just the responsive one --------
// gendn-jvh found the class on reports/conformance/responsive.json (a `responsive --page` run
// truncated 198 rows to 1). gendn-502 found the same shape in the SAME runner's own output: a
// `conformance --page` run rewrote reports/conformance/results.json from 198 suites to 1 and the
// index rollup from 229 lines to 32, so a lane running the documented evidence command and then
// committing would ship a diff that READS as a routine report refresh while deleting 197 suites.
// Per the gendn-8q2 decision (close the CLASS, not the instance) the merge lives HERE once and both
// reports call it, rather than a second hand-rolled copy per report - the copy is how the third
// artefact stays broken.
export function mergeReportRows({ existing = [], scanned = [], scoped = false, key = "id" } = {}) {
  if (!scoped) return scanned;
  const rows = [...existing];
  const indexOf = new Map(rows.map((row, i) => [row?.[key], i]));
  for (const row of scanned) {
    const at = indexOf.get(row?.[key]);
    if (at === undefined) {
      indexOf.set(row?.[key], rows.length); // an entry the report has never carried
      rows.push(row);
    } else {
      rows[at] = row; // replace IN PLACE so the file's order stays stable
    }
  }
  return rows;
}

export function responsiveReportRows({ existing = [], scanned = [], scoped = false } = {}) {
  return mergeReportRows({ existing, scanned, scoped });
}

// A scoped run must not describe itself as a full one: the row count it reports is the REPORT's
// size, not the number of pages scanned, and conflating them is how the truncation went unnoticed.
export function responsiveReportLine(scannedCount, totalRows, scoped) {
  return scoped
    ? `responsive-check: ${scannedCount} page(s) scanned (merged into ${OUT_DIR}/responsive.json; report now ${totalRows} rows)`
    : `responsive-check: ${scannedCount} pages scanned → ${OUT_DIR}/responsive.json`;
}

// The run-all summary line, same discipline: the FULL shape is pinned by check-verdict-emission (it
// is the shape the landing gate sends) and stays byte-identical, while a scoped run says out loud
// that it merged and how big the report now is (gendn-502).
export function runAllReportLine({ scannedSuites, totalSuites, scoped, agg }) {
  if (scoped) {
    return `run-all: ${scannedSuites} suite(s) scanned (merged into ${OUT_DIR}/results.json; report now ${totalSuites} suites)`;
  }
  return `run-all: ${scannedSuites} suites · assertions ${agg.pass} pass / ${agg.fail} fail / ${agg.blocked} blocked (of ${agg.total})`;
}

// The DECISION for the run-all report, extracted so a fixture can pin it rather than only the merge
// arithmetic (gendn-502). The write site itself needs Chrome and the whole scan harness, so the
// choice of wholesale-vs-merge AND which aggregate the file carries are gathered here. The `agg`
// returned is the REPORT's aggregate over the MERGED set - not the scan's - and that distinction is
// a bug I introduced and caught only by running the command: reassigning the scan's aggregate to the
// merged set made a one-suite scoped run announce the whole catalogue's failures as its verdict.
export function scopedResultsReport({ existing = [], scanned = [], scoped = false } = {}) {
  const suites = mergeReportRows({ existing, scanned, scoped });
  const agg = suites.reduce((o, s) => {
    o.total += s.total;
    o.pass += s.pass;
    o.fail += s.fail;
    o.blocked += s.blocked;
    return o;
  }, { total: 0, pass: 0, fail: 0, blocked: 0 });
  return { suites, agg, merged: scoped };
}

// Match the responsive selector against the same published-root catalogue used by the runner.
// A child path or typo must not masquerade as a successful zero-page browser check.
function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function selectResponsivePages(
  pages,
  { hasSelector = false, selector, limit = Infinity } = {},
) {
  const rootId = (path) => path.replace(/\/index\.html$/, "");
  const roots = pages.map(rootId);
  if (
    hasSelector &&
    (typeof selector !== "string" || !selector.trim() || selector.startsWith("--"))
  ) {
    return {
      pages: [],
      error: `--page ${
        JSON.stringify(selector ?? "<missing>")
      } requires a published root route ID (e.g. v152/window-shape-api); only published root routes are selectable, not child paths`,
    };
  }
  const selected = hasSelector ? pages.filter((path) => rootId(path) === selector) : pages;
  if (hasSelector && selected.length === 0) {
    const nearest = roots.map((id) => ({ id, distance: editDistance(selector, id) }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
      .slice(0, 3).map(({ id }) => id);
    return {
      pages: [],
      error: `--page ${
        JSON.stringify(selector)
      } matched zero published root routes; only published root routes are selectable, not child paths. Nearest published roots: ${
        nearest.join(", ")
      }`,
    };
  }
  const considered = Number.isFinite(limit) ? selected.slice(0, limit) : selected;
  if (hasSelector && considered.length === 0) {
    return {
      pages: [],
      error: `--page ${
        JSON.stringify(selector)
      } selected zero published root routes after --limit ${limit}; refusing a vacuous responsive pass`,
    };
  }
  return { pages: considered, error: null };
}

async function main() {
  const args = Deno.args;
  const pageIdx = args.indexOf("--page");
  const only = pageIdx >= 0 ? args[pageIdx + 1] : null;
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
  const responsive = args.includes("--responsive");
  const screenshots = args.includes("--screenshots");
  const updateSupport = args.includes("--update-support");

  // Resolve the selector before any report writes, server spawn, or Chrome launch.
  const pages = await collectPublishedPages(".");
  const selection = responsive
    ? selectResponsivePages(pages, { hasSelector: pageIdx >= 0, selector: only, limit })
    : {
      pages: pages.filter((p) => !only || p.replace(/\/index\.html$/, "") === only),
      error: null,
    };
  if (selection.error) {
    console.error(`ERROR: ${selection.error}`);
    Deno.exitCode = 2;
    return;
  }
  let considered = selection.pages;
  if (!responsive && Number.isFinite(limit)) considered = considered.slice(0, limit);

  await Deno.mkdir(OUT_DIR, { recursive: true });
  const server = await startServer();
  const RECYCLE_EVERY = 40; // relaunch Chrome periodically to bound memory over a 155-page run
  let browser = await launch();
  const ctx = {
    base: server.base,
    origin: server.origin,
    desktop: await browser.newPage(DESKTOP),
    mobile: await browser.newPage(MOBILE),
  };
  async function recycleBrowser() {
    try {
      await ctx.desktop.close();
      await ctx.mobile.close();
      await browser.close();
    } catch {
      // ignore
    }
    browser = await launch();
    ctx.desktop = await browser.newPage(DESKTOP);
    ctx.mobile = await browser.newPage(MOBILE);
  }

  try {
    if (responsive) {
      const support = await loadSupport(".");
      const rows = [];
      let n = 0;
      for (const p of considered) {
        if (n > 0 && n % RECYCLE_EVERY === 0) await recycleBrowser();
        await ensureServer(server);
        n++;
        const id = p.replace(/\/index\.html$/, "");
        const html = await Deno.readTextFile(`./${p}`);
        const meta = metadataFromHtml(p, html);
        const r = await responsiveCheck(id, meta, ctx, { screenshots });
        rows.push(r);
        const okD = classOk(r.desktop);
        const okM = classOk(r.mobile);
        console.log(
          `${id}  desktop:${okD ? "ok" : "REVIEW"}  mobile:${okM ? "ok" : "REVIEW"}` +
            (okD && okM ? "" : `  (${JSON.stringify({ d: r.desktop, m: r.mobile })})`),
        );
        if (updateSupport) {
          // Automated scan only ever proposes needs-review / broken — never `ok` (that needs an
          // agent to read the screenshots). Never downgrade an existing `ok`/`unsupported`.
          const prev = support.routes[meta.route] ?? { desktop: "untested", mobile: "untested" };
          const propose = (ok, cur) => {
            if (cur === "ok" || cur === "unsupported") return cur; // monotonic; agent-set stays
            return ok ? "needs-review" : "broken";
          };
          support.routes[meta.route] = {
            ...prev,
            desktop: propose(okD, prev.desktop),
            mobile: propose(okM, prev.mobile),
            method: "auto-scan",
            checkedAt: new Date().toISOString().slice(0, 10),
          };
        }
      }
      if (updateSupport) {
        support.updatedAt = new Date().toISOString();
        await Deno.writeTextFile(`./${SUPPORT_SIDECAR}`, JSON.stringify(support, null, 2) + "\n");
        console.log(`\nwrote ${SUPPORT_SIDECAR} (${Object.keys(support.routes).length} routes)`);
      }
      const scoped = Boolean(only) || Number.isFinite(limit);
      const existingRows = scoped ? await readResponsiveRows(`${OUT_DIR}/responsive.json`) : [];
      const reportRows = responsiveReportRows({ existing: existingRows, scanned: rows, scoped });
      await Deno.writeTextFile(
        `${OUT_DIR}/responsive.json`,
        JSON.stringify(reportRows, null, 2) + "\n",
      );
      console.log(`\n${responsiveReportLine(rows.length, reportRows.length, scoped)}`);
      // Verdict visibility (gendn-m9j): the scan's summary line above carries no verdict, so
      // REVIEW pages were only visible in per-page output. Print them explicitly at the end —
      // additive only; per-page lines and exit code (0) are unchanged. The classification is
      // classOk() — the exact helper behind the per-page tokens — so headline and detail
      // cannot disagree.
      //
      // Gate-output grep anchoring (gendn-jeq): per-page verdict rows start at column 0 with
      // the route id ("v153/scroll-axis-lock  desktop:ok  mobile:REVIEW"); every derived
      // end-of-run line is distinguishable by its two-space indent ("  review-page ...",
      // "  fail-assertion ...") or its "verdict:" prefix. A raw whole-log token grep
      // DOUBLE-COUNTS flagged pages — each flagged responsive page prints BOTH a per-page row
      // and a review-page line — so count per-page verdicts with ^<route-id> anchoring and
      // summary items with the indent/prefix forms.
      const clsVerdict = (d) => (classOk(d) ? "ok" : "REVIEW");
      const flagged = rows
        .map((r) => ({ id: r.id, desktop: clsVerdict(r.desktop), mobile: clsVerdict(r.mobile) }))
        .filter((v) => v.desktop !== "ok" || v.mobile !== "ok");
      const nD = flagged.filter((v) => v.desktop !== "ok").length;
      const nM = flagged.filter((v) => v.mobile !== "ok").length;
      if (flagged.length > 0) {
        console.log(
          `verdict: REVIEW-REQUIRED - ${flagged.length} page(s) flagged ` +
            `(desktop ${nD} / mobile ${nM} REVIEW of ${rows.length} scanned), exit code unchanged`,
        );
        for (const v of flagged) {
          console.log(`  review-page ${v.id} desktop:${v.desktop} mobile:${v.mobile}`);
        }
      } else {
        console.log(`verdict: GREEN - all ${rows.length} scanned pages ok on both classes`);
      }
    } else {
      const runAll = [];
      let n = 0;
      for (const p of considered) {
        if (n > 0 && n % RECYCLE_EVERY === 0) await recycleBrowser();
        await ensureServer(server);
        n++;
        const id = p.replace(/\/index\.html$/, "");
        const suite = await readJson(`./${id}/conformance.json`);
        if (!suite) {
          console.error(`! ${id}: no conformance suite`);
          continue;
        }
        const r = await runSuite(suite, ctx);
        runAll.push(r);
        console.log(
          `${id}  tested ${
            r.pass + r.fail
          }/${r.total}  pass ${r.pass}  fail ${r.fail}  blocked ${r.blocked}` +
            (r.fail
              ? "\n    FAILED: " +
                r.results.filter((x) => x.status === "fail").map((x) => `${x.id} (${x.reason})`)
                  .join(", ")
              : ""),
        );
      }
      // SCOPED RUNS MERGE (gendn-502): `--page`/`--limit` is the documented way to run ONE suite,
      // and the reporter used to write only what it had scanned, so a scoped run truncated the
      // tracked catalogue report from 198 suites to 1 (and the rollup from 229 lines to 32). The
      // scope decides, exactly as it does for the responsive report: a full run regenerates
      // WHOLESALE (that is how catalogue additions and removals reach the report), a scoped run
      // keeps the other suites, replaces the scanned ones IN PLACE, and appends a new one. The
      // aggregate is recomputed over the MERGED set, because it describes the report rather than
      // the scan.
      const scopedRun = Boolean(only) || Number.isFinite(limit);
      const report = scopedResultsReport({
        existing: scopedRun
          ? await readReportRows(`${OUT_DIR}/results.json`, { what: "suites", key: "suites" })
          : [],
        scanned: runAll,
        scoped: scopedRun,
      });
      const suites = report.suites;
      const reportAgg = report.agg;
      const agg = runAll.reduce((o, s) => {
        o.total += s.total;
        o.pass += s.pass;
        o.fail += s.fail;
        o.blocked += s.blocked;
        return o;
      }, { total: 0, pass: 0, fail: 0, blocked: 0 });
      await Deno.writeTextFile(
        `${OUT_DIR}/results.json`,
        JSON.stringify(
          { generatedAt: new Date().toISOString(), agg: reportAgg, suites },
          null,
          2,
        ) +
          "\n",
      );
      await Deno.writeTextFile(`${OUT_DIR}/index.html`, renderRollup(suites));
      console.log(
        `\n${
          runAllReportLine({
            scannedSuites: runAll.length,
            totalSuites: suites.length,
            scoped: scopedRun,
            agg,
          })
        }`,
      );
      console.log(`rollup → ${OUT_DIR}/index.html · results → ${OUT_DIR}/results.json`);
      // Verdict visibility (gendn-m9j): a full run-all EXITS 0 by design (it is the backlog
      // snapshot), so the exit code is not a verdict. Print an explicit end-of-run summary of
      // the failing assertions, grouped by assertion name with the affected page ids —
      // additive only; the totals line and exit codes are unchanged.
      const byAssertion = new Map();
      for (const s of runAll) {
        for (const f of s.results.filter((x) => x.status === "fail")) {
          if (!byAssertion.has(f.id)) byAssertion.set(f.id, []);
          byAssertion.get(f.id).push(s.id);
        }
      }
      if (agg.fail > 0) {
        const pagesWithFails = new Set(
          runAll.filter((s) => s.fail > 0).map((s) => s.id),
        ).size;
        console.log(
          `verdict: NOT-GREEN - ${agg.fail} failing assertions on ${pagesWithFails} of ${runAll.length} suites ` +
            `(exit code unchanged for run-all; single-page runs still exit 2)`,
        );
        // Sort by code-unit order (not localeCompare's default locale) so the printed order
        // is deterministic across environments; assertion ids are lowercase ASCII today.
        const sorted = [...byAssertion.entries()].sort((a, b) =>
          a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
        );
        for (const [name, pages] of sorted) {
          console.log(`  fail-assertion ${name} pages=${pages.length} :: ${pages.join(" ")}`);
        }
      } else {
        console.log(`verdict: GREEN - 0 failing assertions across ${runAll.length} suites`);
      }
      // Single-page runs are the routine's per-page gate: don't push a red page. A full run-all is
      // the backlog snapshot (many known gaps during burn-down), so it reports without failing.
      if (agg.fail > 0 && only) Deno.exitCode = 2;
    }
  } finally {
    try {
      await ctx.desktop.close();
      await ctx.mobile.close();
      await browser.close();
    } catch {
      // ignore
    }
    try {
      server.child.kill();
    } catch {
      // ignore
    }
    try {
      await server.child.status;
    } catch {
      // ignore
    }
  }
}

if (import.meta.main) await main();
