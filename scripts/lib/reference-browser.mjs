// Browser-backed visibility gate for implementation-sufficiency contracts.
// Static validation rejects comments and common hidden containers; this pass uses Chromium's
// computed layout/style so stylesheet-hidden, opacity-zero, closed-disclosure, and zero-box content
// cannot satisfy a touched feature's contract.

import { launch } from "./cdp.mjs";
import { REQUIRED_DIMENSIONS } from "./reference-contract.mjs";

const VIEWPORTS = [
  ["desktop", { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 }],
  ["mobile", { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 }],
];

async function spawnServer() {
  const port = 3600 + Math.floor(Math.random() * 300);
  const child = new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-read", "--allow-env", "server.ts"],
    env: { ...Deno.env.toObject(), PORT: String(port) },
    stdout: "null",
    stderr: "null",
  }).spawn();
  const base = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${base}/`);
      const ok = response.ok;
      await response.body?.cancel();
      if (ok) return { child, base };
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  throw new Error("gendn server did not start for reference visibility validation");
}

export async function validateReferenceContractsInBrowser(records) {
  if (records.length === 0) return [];
  const errors = [];
  const server = await spawnServer();
  const browser = await launch();
  const pages = await Promise.all(VIEWPORTS.map(async ([name, viewport]) => ({
    name,
    page: await browser.newPage(viewport),
  })));
  try {
    for (const { ownerId, contract } of records) {
      for (const doc of contract.documentation ?? []) {
        const route = documentationRoute(ownerId, doc.href);
        if (!route) {
          errors.push(`${ownerId}: ${doc.inventoryId}: browser check cannot resolve ${doc.href}`);
          continue;
        }
        const sourceUrls = sourceUrlsForDocumentation(contract, doc);
        for (const { name: deviceClass, page } of pages) {
          await page.goto(`${server.base}${route}`);
          for (const dimension of REQUIRED_DIMENSIONS) {
            const coverage = doc.dimensions?.[dimension];
            if (!coverage || coverage.status === "missing" || !coverage.selector) continue;
            const result = await page.evaluate(`(() => {
              const element = document.querySelector(${JSON.stringify(coverage.selector)});
              if (!element) return { ok: false, reason: "selector missing" };
              const style = getComputedStyle(element);
              const box = element.getBoundingClientRect();
              const visible = typeof element.checkVisibility === "function"
                ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })
                : style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
              return { ok: visible && box.width > 0 && box.height > 0,
                reason: visible ? "zero box " + box.width + "x" + box.height : "computed hidden" };
            })()`);
            if (!result?.ok) {
              errors.push(
                `${ownerId}: ${doc.inventoryId}.${dimension} ${coverage.selector} is not visibly rendered on ${deviceClass} at ${route} (${
                  result?.reason ?? "unknown"
                })`,
              );
            }
          }
          for (const url of sourceUrls) {
            const result = await page.evaluate(`(() => {
              const links = [...document.querySelectorAll("a[href]")].filter(a => a.href === ${
              JSON.stringify(url)
            });
              return links.some(link => {
                const style = getComputedStyle(link);
                const box = link.getBoundingClientRect();
                const visible = typeof link.checkVisibility === "function"
                  ? link.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })
                  : style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
                return visible && box.width > 0 && box.height > 0;
              });
            })()`);
            if (!result) {
              errors.push(
                `${ownerId}: ${doc.inventoryId}: cited source is not a visible clickable link on ${deviceClass} at ${route}: ${url}`,
              );
            }
          }
        }
      }
    }
  } finally {
    try {
      for (const { page } of pages) await page.close();
      await browser.close();
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
