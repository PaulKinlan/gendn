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

const OVERFLOW = "document.documentElement.scrollWidth <= (window.innerWidth + 1)";

async function responsiveCheck(pageId, meta, ctx, { screenshots }) {
  const { base, origin, desktop, mobile } = ctx;
  const route = meta.route;
  const out = { id: pageId, route, desktop: {}, mobile: {} };

  for (const [cls, page] of [["desktop", desktop], ["mobile", mobile]]) {
    await page.goto(`${base}${route}`);
    const noOverflow = coerce(await page.evaluate(OVERFLOW)).ok;
    // No interactive control positioned off the viewport horizontally.
    const controlsInView = coerce(
      await page.evaluate(
        "[...document.querySelectorAll('a,button,input,select,summary,[tabindex]')].every(el => { const r = el.getBoundingClientRect(); return r.width === 0 || (r.left >= -1 && r.right <= window.innerWidth + 1); })",
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

async function main() {
  const args = Deno.args;
  const pageIdx = args.indexOf("--page");
  const only = pageIdx >= 0 ? args[pageIdx + 1] : null;
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
  const responsive = args.includes("--responsive");
  const screenshots = args.includes("--screenshots");
  const updateSupport = args.includes("--update-support");

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
    const pages = await collectPublishedPages(".");
    let considered = pages.filter((p) => {
      const id = p.replace(/\/index\.html$/, "");
      return !only || id === only;
    });
    if (Number.isFinite(limit)) considered = considered.slice(0, limit);

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
        const okD = r.desktop.noOverflow && r.desktop.controlsInView && r.desktop.consoleClean &&
          r.desktop.networkClean;
        const okM = r.mobile.noOverflow && r.mobile.controlsInView && r.mobile.consoleClean &&
          r.mobile.networkClean;
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
      await Deno.writeTextFile(`${OUT_DIR}/responsive.json`, JSON.stringify(rows, null, 2) + "\n");
      console.log(`\nresponsive-check: ${rows.length} pages scanned → ${OUT_DIR}/responsive.json`);
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
      const agg = runAll.reduce((o, s) => {
        o.total += s.total;
        o.pass += s.pass;
        o.fail += s.fail;
        o.blocked += s.blocked;
        return o;
      }, { total: 0, pass: 0, fail: 0, blocked: 0 });
      await Deno.writeTextFile(
        `${OUT_DIR}/results.json`,
        JSON.stringify({ generatedAt: new Date().toISOString(), agg, suites: runAll }, null, 2) +
          "\n",
      );
      await Deno.writeTextFile(`${OUT_DIR}/index.html`, renderRollup(runAll));
      console.log(
        `\nrun-all: ${runAll.length} suites · assertions ${agg.pass} pass / ${agg.fail} fail / ${agg.blocked} blocked (of ${agg.total})`,
      );
      console.log(`rollup → ${OUT_DIR}/index.html · results → ${OUT_DIR}/results.json`);
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
