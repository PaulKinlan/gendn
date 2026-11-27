// Browser-backed visibility gate for implementation-sufficiency contracts.
// Static validation rejects comments and common hidden containers; this pass uses Chromium's
// computed layout/style so stylesheet-hidden, opacity-zero, closed-disclosure, and zero-box content
// cannot satisfy a touched feature's contract.

import * as sys from "./sys.mjs";
import { launch } from "./cdp.mjs";
import { canonicalCitationUrl, REQUIRED_DIMENSIONS } from "./reference-contract.mjs";

const VIEWPORTS = [
  ["desktop", { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 }],
  ["mobile", { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 }],
];

// The port is assigned by the OS, and readiness comes from THIS child's own startup line.
// Probing a guessed port could otherwise accept another lane's healthy server while this child
// has already failed; discarding its stderr hid the actual startup cause (gendn-4ok7).
export async function spawnServer({ script = "serve.ts", startupTimeoutMs = 30_000, cwd } = {}) {
  const child = new sys.Command(sys.execPath(), {
    args: [script],
    env: { ...sys.env.toObject(), PORT: "0" },
    ...(cwd ? { cwd } : {}),
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let stdout = "", stderr = "", resolveReady;
  const ready = new Promise((resolve) => resolveReady = resolve);
  const capture = (stream, onText) => {
    const decoder = new TextDecoder();
    return stream.pipeTo(
      new WritableStream({
        write(bytes) {
          onText(decoder.decode(bytes, { stream: true }));
        },
      }),
    ).catch(() => {});
  };
  const stdoutDone = capture(child.stdout, (text) => {
    stdout = (stdout + text).slice(-4096);
    const match = stdout.match(/Listening on http:\/\/localhost:(\d+)/);
    if (match) resolveReady(Number(match[1]));
  });
  const stderrDone = capture(child.stderr, (text) => stderr = (stderr + text).slice(-4096));
  let exited = null;
  const status = child.status.then((value) => exited = value);
  let timer;
  try {
    const first = await Promise.race([
      ready.then((port) => ({ port })),
      status.then((exit) => ({ exit })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), startupTimeoutMs);
      }),
    ]);
    if (!first.port) {
      throw new Error(
        first.timeout
          ? `startup timed out after ${startupTimeoutMs}ms`
          : "child exited before listening",
      );
    }
    const base = `http://localhost:${first.port}`;
    const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(15_000) });
    const ok = response.ok;
    await response.body?.cancel();
    if (!ok) throw new Error(`readiness GET / returned HTTP ${response.status}`);
    return { child, base };
  } catch (error) {
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already stopped.
      }
    }
    await status;
    await Promise.all([stdoutDone, stderrDone]);
    throw new Error(
      `gendn server did not start for reference visibility validation: ${error.message}; ` +
        `child ${exited?.signal ? `signal ${exited.signal}` : `exit ${exited?.code}`}; ` +
        `stderr: ${stderr.trim() || "(empty)"}; stdout: ${stdout.trim() || "(empty)"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// `cwd` is the served root and the root every route below resolves against. The real gate passes
// nothing (the checkout is the subject); a fixture passes its own private root so the pages it
// synthesizes are never written into, or read out of, the shared checkout (gendn-gvoq).
export async function validateReferenceContractsInBrowser(records, { cwd } = {}) {
  if (records.length === 0) return [];
  const errors = [];
  const server = await spawnServer(cwd ? { cwd } : {});
  let browser;
  const pages = [];
  try {
    // port: 0 = an OS-assigned DevTools port owned by this run, so an overlapping run in another
    // worktree cannot attach to this Chrome (the fixed default port allowed that).
    browser = await launch({ port: 0 });
    for (const [name, viewport] of VIEWPORTS) {
      pages.push({ name, page: await browser.newPage(viewport) });
    }
    // Group checks by unique route so a contract with N inventory items on the same page
    // navigates ONCE per viewport and evaluates every selector/citation in a single CDP round-trip,
    // preserving identical checkVisibility / getBoundingClientRect / canonicalCitationUrl semantics.
    const routeJobs = new Map();
    for (const { ownerId, contract } of records) {
      for (const doc of contract.documentation ?? []) {
        const route = documentationRoute(ownerId, doc.href);
        if (!route) {
          errors.push(`${ownerId}: ${doc.inventoryId}: browser check cannot resolve ${doc.href}`);
          continue;
        }
        let job = routeJobs.get(route);
        if (!job) {
          job = { docs: [], selectors: new Set(), wantedUrls: new Set() };
          routeJobs.set(route, job);
        }
        const dims = [];
        for (const dimension of REQUIRED_DIMENSIONS) {
          const coverage = doc.dimensions?.[dimension];
          if (!coverage || coverage.status === "missing" || !coverage.selector) continue;
          dims.push({ dimension, selector: coverage.selector });
          job.selectors.add(coverage.selector);
        }
        const sources = [];
        for (const url of sourceUrlsForDocumentation(contract, doc)) {
          // The BROWSER side of the same comparison, normalised through the same rule (gendn-t77):
          // `a.href` is already the DOM's canonical absolute form, so canonicalising the CONTRACT
          // value here makes both sides speak the same dialect — without this, a contract citing a
          // bare host could never match a link the browser resolved to its trailing-slash form.
          const wanted = canonicalCitationUrl(url) ?? url;
          sources.push({ url, wanted });
          job.wantedUrls.add(wanted);
        }
        job.docs.push({ ownerId, inventoryId: doc.inventoryId, dims, sources });
      }
    }

    for (const [route, job] of routeJobs) {
      const selectorList = [...job.selectors];
      const wantedList = [...job.wantedUrls];
      const evalExpr = `(() => {
        const isVisible = (el) => {
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          const visible = typeof el.checkVisibility === "function"
            ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })
            : style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
          return { ok: visible && box.width > 0 && box.height > 0,
            reason: visible ? "zero box " + box.width + "x" + box.height : "computed hidden" };
        };
        const selectors = {};
        for (const sel of ${JSON.stringify(selectorList)}) {
          const el = document.querySelector(sel);
          selectors[sel] = el ? isVisible(el) : { ok: false, reason: "selector missing" };
        }
        const anchors = [...document.querySelectorAll("a[href]")];
        const byHref = new Map();
        for (const a of anchors) {
          let list = byHref.get(a.href);
          if (!list) { list = []; byHref.set(a.href, list); }
          list.push(a);
        }
        const urls = {};
        for (const wanted of ${JSON.stringify(wantedList)}) {
          const links = byHref.get(wanted) ?? [];
          urls[wanted] = links.some((link) => isVisible(link).ok);
        }
        return { selectors, urls };
      })()`;
      const perViewport = await Promise.all(
        pages.map(async ({ name: deviceClass, page }) => {
          await page.goto(`${server.base}${route}`);
          const batch = await page.evaluate(evalExpr);
          const localErrors = [];
          for (const doc of job.docs) {
            for (const { dimension, selector } of doc.dims) {
              const result = batch?.selectors?.[selector];
              if (!result?.ok) {
                localErrors.push(
                  `${doc.ownerId}: ${doc.inventoryId}.${dimension} ${selector} is not visibly rendered on ${deviceClass} at ${route} (${
                    result?.reason ?? "unknown"
                  })`,
                );
              }
            }
            for (const { url, wanted } of doc.sources) {
              if (!batch?.urls?.[wanted]) {
                localErrors.push(
                  `${doc.ownerId}: ${doc.inventoryId}: cited source is not a visible clickable link on ${deviceClass} at ${route}: ${url}`,
                );
              }
            }
          }
          return localErrors;
        }),
      );
      for (const localErrors of perViewport) errors.push(...localErrors);
    }
  } finally {
    for (const { page } of pages) {
      try {
        await page.close();
      } catch {
        // Continue closing the other page and browser.
      }
    }
    try {
      await browser?.close();
    } catch {
      // Best-effort cleanup.
    }
    try {
      server.child.kill();
    } catch {
      // Already stopped.
    }
    try {
      await server.child.status;
    } catch {
      // Ignore cleanup races.
    }
  }
  return errors;
}

function sourceUrlsForDocumentation(contract, doc) {
  const urls = new Set();
  const sourceById = new Map((contract.sources ?? []).map((source) => [source.id, source]));
  const inventory = (contract.inventory ?? []).find((item) => item.id === doc.inventoryId);
  for (const ref of inventory?.sourceRefs ?? []) {
    if (sourceById.get(ref)?.url) urls.add(sourceById.get(ref).url);
  }
  for (const coverage of Object.values(doc.dimensions ?? {})) {
    for (const ref of coverage.sourceRefs ?? []) {
      if (sourceById.get(ref)?.url) urls.add(sourceById.get(ref).url);
    }
  }
  return urls;
}

function documentationRoute(ownerId, href) {
  if (typeof href !== "string" || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
    return null;
  }
  const path = href.split("#")[0];
  if (!path) return `/${ownerId}/`;
  const route = path.startsWith("/") ? path : `/${ownerId}/${path}`;
  return route.endsWith("/") || /\.[a-z0-9]+$/i.test(route) ? route : `${route}/`;
}
