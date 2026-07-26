#!/usr/bin/env -S deno run --allow-read --allow-write
// gen-conformance.mjs — derive a genuine immutable conformance suite for every published page.
//
// Assertions are DERIVED from each page's own real metadata (chromestatus feature id, route,
// built/stub status, section headings, experimental flag, embedded showcase link) plus per-status
// templates — they are real doc-quality contracts, not fabricated checks. These are REFERENCE-SITE
// assertions (identity/route/structure/links/content/a11y/responsive/runtime/guidance); platform
// BEHAVIOR belongs to chrome-platform-showcase's own conformance contract, which a page that wraps a
// CPS feature REFERENCES via `cpsFeature` rather than forking here.
//
// Immutable: an existing conformance.json is NEVER overwritten or weakened. The generator only
// writes suites for pages that don't have one yet (coverage grows; the contract never shrinks).
// To grow an existing suite, add assertions by hand — never regenerate to go green.
//
// Usage:
//   deno run --allow-read --allow-write scripts/gen-conformance.mjs           # write missing suites
//   deno run --allow-read --allow-write scripts/gen-conformance.mjs --dry-run # report only
//   deno run --allow-read --allow-write scripts/gen-conformance.mjs --page v149/webmcp

import {
  collectPublishedPages,
  conformancePath,
  metadataFromHtml,
  SHOWCASE_HOST,
  suiteHash,
} from "./lib/artifacts.mjs";

const GENERATED_AT = "2026-07-19T00:00:00Z"; // fixed → deterministic suiteHash across regens
const AUTHOR = "gen-conformance/v1 (derived from page metadata)";

const OVERFLOW = "document.documentElement.scrollWidth <= (window.innerWidth + 1)";

function deriveAssertions(meta) {
  const a = [];
  const push = (o) => a.push(o);

  // --- identity + route (canonical ChromeStatus id + milestone mapping + stable route) ---
  push({
    id: "route-resolves",
    category: "route",
    describe: `The stable route ${meta.route} responds 200 (durable-demo contract).`,
    kind: "http-status",
    test: meta.route,
    expect: 200,
    deviceClass: "both",
  });
  push({
    id: "chromestatus-identity-link",
    category: "identity",
    describe:
      `Page carries its canonical chromestatus.com/feature/${meta.identity} link — the immutable feature identity (CLAUDE.md invariant #3) and the milestone-${meta.milestone} mapping's self-heal.`,
    kind: "dom-query",
    selector: `a[href*="chromestatus.com/feature/${meta.identity}"]`,
    deviceClass: "both",
  });
  push({
    id: "title-nonempty",
    category: "structure",
    describe: "Document has a non-empty <title> for the reference page.",
    kind: "js-eval",
    test: "document.title.trim().length > 0",
    deviceClass: "both",
  });
  push({
    id: "single-h1",
    category: "structure",
    describe: "Exactly one <h1> — the API name (listing name), MDN-shaped article heading.",
    kind: "js-eval",
    test: "document.querySelectorAll('h1').length === 1",
    deviceClass: "both",
  });
  push({
    id: "main-landmark",
    category: "a11y",
    describe: "A single <main> landmark wraps the article content.",
    kind: "js-eval",
    test: "document.querySelectorAll('main').length === 1",
    deviceClass: "both",
  });
  push({
    id: "stylesheet-linked",
    category: "structure",
    describe: "Shared editorial design system /public/styles.css is linked.",
    kind: "dom-query",
    selector: 'link[rel="stylesheet"][href="/public/styles.css"]',
    deviceClass: "both",
  });
  push({
    id: "viewport-meta",
    category: "responsive",
    describe: "Responsive viewport meta present (width=device-width) for mobile+desktop parity.",
    kind: "dom-query",
    selector: 'meta[name="viewport"]',
    deviceClass: "both",
  });
  push({
    id: "crumb-to-release",
    category: "structure",
    describe: `Breadcrumb links back to the /${meta.release}/ release index.`,
    kind: "dom-query",
    selector: `a[href="/${meta.release}/"]`,
    deviceClass: "both",
  });
  push({
    id: "byline-footer",
    category: "structure",
    describe: "Byline footer present (article provenance).",
    kind: "dom-query",
    selector: ".byline",
    deviceClass: "both",
  });

  // --- links validity + security ---
  push({
    id: "external-links-rel-safe",
    category: "links",
    describe:
      "Every target=_blank link carries rel=noopener (no reverse-tabnabbing; MDN-style external link hygiene).",
    kind: "js-eval",
    test:
      "[...document.querySelectorAll('a[target=\"_blank\"]')].every(el => (el.rel||'').includes('noopener'))",
    deviceClass: "both",
  });
  push({
    id: "no-empty-anchors",
    category: "links",
    describe: "No anchor has an empty or placeholder (#) href.",
    kind: "js-eval",
    test:
      "[...document.querySelectorAll('a')].every(el => { const h = el.getAttribute('href'); return h && h !== '#'; })",
    deviceClass: "both",
  });

  // --- runtime cleanliness (mobile+desktop) ---
  push({
    id: "no-console-errors",
    category: "runtime",
    describe: "Page loads with no console errors.",
    kind: "no-console-errors",
    deviceClass: "both",
  });
  push({
    id: "no-failed-requests",
    category: "runtime",
    describe: "No failed (>=400 / net-error) network requests on load.",
    kind: "no-failed-requests",
    deviceClass: "both",
  });

  // --- responsive parity (both device classes exercised) ---
  push({
    id: "no-horizontal-overflow-desktop",
    category: "responsive",
    describe: "No unintended horizontal overflow at desktop (1280x800).",
    kind: "js-eval",
    test: OVERFLOW,
    deviceClass: "desktop",
  });
  push({
    id: "no-horizontal-overflow-mobile",
    category: "responsive",
    describe: "No unintended horizontal overflow at narrow mobile (360x740, DPR3).",
    kind: "js-eval",
    test: OVERFLOW,
    deviceClass: "mobile",
  });
  push({
    id: "legible-desktop",
    category: "responsive",
    describe:
      "Desktop render is legible, contrast passes WCAG AA, controls/text not clipped (screenshot review).",
    kind: "manual-evidenced",
    deviceClass: "desktop",
  });
  push({
    id: "legible-mobile",
    category: "responsive",
    describe:
      "Mobile render is legible with adequate tap targets and no clipped text/controls (screenshot review).",
    kind: "manual-evidenced",
    deviceClass: "mobile",
  });

  // --- factual/source fidelity + guidance (process) ---
  push({
    id: "h1-matches-listing-name",
    category: "content",
    describe:
      "The <h1> is the chromestatus milestone-listing name for this feature (not the broader detail name) — factual/source fidelity.",
    kind: "manual-evidenced",
    deviceClass: "n/a",
  });
  push({
    id: "guidance-consulted",
    category: "guidance",
    describe:
      "Frontend implementation consulted modern-web-guidance for its UI/responsive/a11y topics and applied or justified them (recorded in _questions.json guidanceConsulted).",
    kind: "manual-evidenced",
    deviceClass: "n/a",
  });

  if (meta.status === "built") {
    push({
      id: "min-sections",
      category: "structure",
      describe: "Built reference has at least three <h2> sections (MDN-shaped depth).",
      kind: "js-eval",
      test: "document.querySelectorAll('main h2').length >= 3",
      deviceClass: "both",
    });
    if (!meta.isRemoval) {
      push({
        id: "browser-support-section",
        category: "content",
        describe:
          "Cross-browser support is documented (a support/compat/baseline section, or a reference table stating Baseline / Shipped-in / standards positions) — accurate messaging, not implied support.",
        kind: "js-eval",
        test:
          "[...document.querySelectorAll('main h2')].some(h => /support|compat|baseline|availab|standards? position/i.test(h.textContent)) || /baseline|shipped in|standards? position|cross-browser|browser compat/i.test(document.querySelector('main').textContent)",
        deviceClass: "both",
      });
      push({
        id: "example-surface-present",
        category: "content",
        describe:
          "Built reference includes a usable example surface (<pre> code and/or a live embed).",
        kind: "js-eval",
        test: "!!document.querySelector('main pre, main iframe')",
        deviceClass: "both",
      });
    }
    push({
      id: "code-example-integrity",
      category: "content",
      describe:
        "Code/IDL examples are correctly escaped (no attribute/element injection, invariant #4) and trace to the cited spec/IDL — no invented members (source review).",
      kind: "manual-evidenced",
      deviceClass: "n/a",
    });
    if (meta.experimental) {
      push({
        id: "warn-block-experimental",
        category: "content",
        describe:
          "Experimental / origin-trial / behind-a-flag feature shows the mandatory .warn-block with enable steps (CLAUDE.md invariant #7).",
        kind: "dom-query",
        selector: ".warn-block",
        deviceClass: "both",
      });
    }
    if (meta.hasIframe) {
      push({
        id: "demo-embed-own-feature",
        category: "demo-link",
        describe:
          `Embedded live example points at THIS feature's chrome-platform-showcase route (${SHOWCASE_HOST}/${meta.release}/${meta.slug}...) — the canonical demo identity, never repointed.`,
        kind: "js-eval",
        test:
          `[...document.querySelectorAll('iframe')].some(f => (f.src||'').includes('${SHOWCASE_HOST}/${meta.release}/${meta.slug}'))`,
        deviceClass: "both",
      });
      push({
        id: "demo-embed-loads",
        category: "interaction",
        describe:
          "The embedded chrome-platform-showcase demo actually renders (not a blank box or error frame); its platform behavior is governed by the CPS conformance contract referenced in cpsFeature, not re-asserted here.",
        kind: "manual-evidenced",
        deviceClass: "desktop",
      });
    }
  } else {
    // stub (MDN-covered redirect) — gendn's honest `blocked` analogue
    push({
      id: "mdn-card-present",
      category: "structure",
      describe: "Stub shows the 'documented on MDN' card explaining gendn doesn't duplicate MDN.",
      kind: "dom-query",
      selector: ".mdn-card",
      deviceClass: "both",
    });
    push({
      id: "mdn-outbound-link",
      category: "links",
      describe: "Stub links out to the canonical developer.mozilla.org page for the feature.",
      kind: "js-eval",
      test: "!!document.querySelector('a[href*=\"developer.mozilla.org/en-US/docs/Web\"]')",
      deviceClass: "both",
    });
    push({
      id: "mdn-coverage-accurate",
      category: "content",
      describe:
        "The linked MDN page genuinely covers this feature (has Specifications + Browser compat) — accurate 'covered on MDN' claim (source review).",
      kind: "manual-evidenced",
      deviceClass: "n/a",
    });
  }
  return a;
}

function cpsFeatureRef(meta) {
  if (!meta.demo) return null;
  // demo is https://<host>/v<N>/<slug>/[concept/]
  const path = meta.demo.replace(`https://${SHOWCASE_HOST}`, "").replace(/\/$/, "");
  return {
    host: SHOWCASE_HOST,
    route: `${path}/`,
    conformanceRoute: `${path}/conformance`,
    note:
      "The chrome-platform-showcase suite at conformanceRoute governs only the assertions it explicitly lists; it does not prove unasserted native, hardware, permission, backend, or other behavior. gendn references that listed contract without forking it.",
  };
}

async function buildSuite(meta) {
  const assertions = deriveAssertions(meta);
  return {
    schemaVersion: 1,
    id: meta.id,
    route: meta.route,
    identity: meta.identity,
    milestone: meta.milestone,
    status: meta.status,
    demo: meta.demo,
    cpsFeature: cpsFeatureRef(meta),
    immutable: true,
    suiteHash: await suiteHash(assertions),
    generatedAt: GENERATED_AT,
    author: AUTHOR,
    assertions,
  };
}

async function main() {
  const args = Deno.args;
  const dryRun = args.includes("--dry-run");
  const pageIdx = args.indexOf("--page");
  const only = pageIdx >= 0 ? args[pageIdx + 1] : null;

  const pages = await collectPublishedPages(".");
  let written = 0, skipped = 0, total = 0;
  for (const pagePath of pages) {
    const pageId = pagePath.replace(/\/index\.html$/, "");
    if (only && pageId !== only) continue;
    total++;
    const outPath = conformancePath(pageId, ".");
    try {
      await Deno.stat(outPath);
      skipped++;
      continue; // immutable: never overwrite an existing suite
    } catch {
      // absent — generate
    }
    const html = await Deno.readTextFile(`./${pagePath}`);
    const meta = metadataFromHtml(pagePath, html);
    if (!meta.identity) {
      console.error(`! ${pageId}: no chromestatus identity — skipping (fix the page first)`);
      continue;
    }
    const suite = await buildSuite(meta);
    if (dryRun) {
      console.log(`would write ${outPath} (${suite.assertions.length} assertions)`);
    } else {
      await Deno.writeTextFile(outPath, JSON.stringify(suite, null, 2) + "\n");
      written++;
    }
  }
  console.log(
    `gen-conformance: ${written} written, ${skipped} already present (immutable), ${total} pages considered`,
  );
}

if (import.meta.main) await main();
