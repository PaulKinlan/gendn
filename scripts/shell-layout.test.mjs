// scripts/shell-layout.test.mjs — unit and CSP-hash tests for the print-editorial site shell
// (lib/shell.ts, homepage active channels/archive/colophon, milestone pager/filter toolbar,
// unified masthead/footer across /, /v<N>/, /features, and /conformance).
//
// Zero external network dependency: uses a local ChromeStatus stub server on 127.0.0.1:0.
// Run: node scripts/shell-layout.test.mjs

import * as sys from "./lib/sys.mjs";
import {
  channelTone,
  formatStableDate,
  RELEASE_FILTER_SCRIPT,
  RELEASE_FILTER_SCRIPT_SHA256,
  renderSiteFooter,
  renderSiteHeader,
  statusBadgeFor,
} from "../lib/shell.ts";

const XSSI = ")]}'";
const stubServer = sys.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
  const json = (body) => new Response(body, { headers: { "content-type": "application/json" } });
  if (url.pathname === "/channels") {
    return json(`${XSSI}\n${
      JSON.stringify({
        dev: { mstone: 161, version: "161.0.0.0", branch_point: "", stable_date: "2027-01-19" },
        beta: { mstone: 160, version: "160.0.0.0", branch_point: "", stable_date: "2027-01-05" },
        stable: { mstone: 159, version: "159.0.0.0", branch_point: "", stable_date: "2026-12-08" },
      })
    }`);
  }
  if (url.pathname === "/features" && url.searchParams.get("milestone") === "159") {
    return json(`${XSSI}\n${
      JSON.stringify({
        features_by_type: {
          "Enabled by default": [
            {
              id: 5811907077472256,
              name: "SpeechRecognitionResult Timestamps (WebSpeech API)",
              summary: "Exposes segment-level speech start and end timestamps.",
            },
          ],
          "Origin trial": [
            {
              id: 999000111222333,
              name: "Synthetic Pending Feature",
              summary: "An undocumented feature to verify pending coverage filtering.",
            },
          ],
        },
      })
    }`);
  }
  return json(`${XSSI}\n${JSON.stringify({ features_by_type: {} })}`);
});
await stubServer.ready;
sys.env.set("CHROMESTATUS_BASE", `http://127.0.0.1:${stubServer.addr.port}`);

const { CSP_DIRECTIVES, handleRequest } = await import("../server.ts");

let passed = 0;
let failures = 0;
function assert(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS: ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function sha256Token(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return `'sha256-${b64}'`;
}

try {
  // --- 1. Shared shell helpers ---
  assert(
    "channelTone maps all Chrome release states cleanly",
    channelTone("Dev") === "dev" &&
      channelTone("Upcoming") === "dev" &&
      channelTone("Beta") === "beta" &&
      channelTone("Rolling out") === "rolling" &&
      channelTone("Stable (live)") === "stable" &&
      channelTone("Archive") === "archive",
  );

  const sampleChannels = {
    dev: { mstone: 161, version: "161", branch_point: "", stable_date: "2027-01-19" },
    beta: { mstone: 160, version: "160", branch_point: "", stable_date: "2027-01-05" },
    stable: { mstone: 159, version: "159", branch_point: "", stable_date: "2026-12-08" },
  };
  assert(
    "statusBadgeFor classifies dev, beta, rolling out, live stable, released, and upcoming",
    statusBadgeFor(sampleChannels, 161) === "Dev" &&
      statusBadgeFor(sampleChannels, 160) === "Beta" &&
      statusBadgeFor(sampleChannels, 159) === "Rolling out" &&
      statusBadgeFor(sampleChannels, 158) === "Stable (live)" &&
      statusBadgeFor(sampleChannels, 150) === "Released" &&
      statusBadgeFor(sampleChannels, 162) === "Upcoming",
  );

  assert(
    "formatStableDate formats ISO dates and ignores invalid inputs",
    formatStableDate("2026-12-08") === "8 Dec 2026" &&
      formatStableDate("not-a-date") === "" &&
      formatStableDate(undefined) === "",
  );

  const headerHtml = renderSiteHeader("features", "catalogue-main");
  assert(
    "renderSiteHeader emits skip-link to custom mainId, brand mark, and active aria-current",
    headerHtml.includes('href="#catalogue-main"') &&
      headerHtml.includes('<span class="site-mark" aria-hidden="true">gd</span>') &&
      headerHtml.includes('class="site-nav-link is-active" href="/features" aria-current="page"'),
  );

  const footerDefault = renderSiteFooter();
  const footerLifecycle = renderSiteFooter({ includeShowcaseLink: false });
  assert(
    "renderSiteFooter includes chrome-platform-showcase.com by default and omits it when disabled",
    footerDefault.includes('href="https://chrome-platform-showcase.com/"') &&
      !footerLifecycle.includes("chrome-platform-showcase."),
  );

  // --- 2. RELEASE_FILTER_SCRIPT CSP hash + DOM safety ---
  const actualHash = await sha256Token(RELEASE_FILTER_SCRIPT);
  assert(
    "RELEASE_FILTER_SCRIPT_SHA256 matches exact SHA-256 of RELEASE_FILTER_SCRIPT",
    actualHash === RELEASE_FILTER_SCRIPT_SHA256,
    actualHash,
  );
  const mutatedHash = await sha256Token(`${RELEASE_FILTER_SCRIPT} `);
  assert(
    "CSP hash detector: 1-byte mutation of RELEASE_FILTER_SCRIPT produces a different hash",
    mutatedHash !== RELEASE_FILTER_SCRIPT_SHA256,
  );
  const scriptSrc = CSP_DIRECTIVES.find((d) => d.startsWith("script-src ")) ?? "";
  assert(
    "CSP_DIRECTIVES script-src includes RELEASE_FILTER_SCRIPT_SHA256 without 'unsafe-inline'",
    scriptSrc.includes(RELEASE_FILTER_SCRIPT_SHA256) && !scriptSrc.includes("'unsafe-inline'"),
  );
  assert(
    "RELEASE_FILTER_SCRIPT avoids unsafe DOM sinks (no innerHTML, outerHTML, eval, document.write)",
    !/\b(innerHTML|outerHTML|eval|document\.write)\b/.test(RELEASE_FILTER_SCRIPT),
  );

  // --- 3. Full SSR shell routes ---
  const homeRes = await handleRequest(new Request("http://127.0.0.1/"));
  const homeHtml = await homeRes.text();
  assert(
    "GET / renders refined shell-page masthead, active channels, explore grid, archive strip, colophon, and footer",
    homeRes.status === 200 &&
      homeHtml.includes('<body class="shell-page">') &&
      homeHtml.includes('<header class="site-header">') &&
      homeHtml.includes('<ol class="channel-grid">') &&
      homeHtml.includes("channel-pill-dev") &&
      homeHtml.includes("channel-pill-beta") &&
      homeHtml.includes("channel-pill-rolling") &&
      homeHtml.includes("channel-pill-stable") &&
      homeHtml.includes('<ul class="hub-grid">') &&
      homeHtml.includes('<ol class="archive-grid">') &&
      homeHtml.includes('<div class="colophon-box">') &&
      homeHtml.includes('<footer class="byline site-footer">'),
  );

  const v159Res = await handleRequest(new Request("http://127.0.0.1/v159/"));
  const v159Html = await v159Res.text();
  const v159ScriptMatch = /<script>([\s\S]*?)<\/script>/.exec(v159Html);
  assert(
    "GET /v159/ renders shell masthead, prev/next pager, channel pill, category jumps, filter toolbar, and exact CSP-hashed filter script",
    v159Res.status === 200 &&
      v159Html.includes('<body class="shell-page">') &&
      v159Html.includes('<nav class="release-pager"') &&
      v159Html.includes('rel="prev" href="/v158/"') &&
      v159Html.includes('rel="next" href="/v160/"') &&
      v159Html.includes("channel-pill-rolling") &&
      v159Html.includes('<nav class="group-jumps"') &&
      v159Html.includes('id="release-filter-form"') &&
      v159Html.includes('id="release-search"') &&
      v159Html.includes('id="release-coverage"') &&
      v159ScriptMatch !== null &&
      v159ScriptMatch[1] === RELEASE_FILTER_SCRIPT,
  );

  const featRes = await handleRequest(new Request("http://127.0.0.1/features"));
  const featHtml = await featRes.text();
  assert(
    "GET /features renders unified shell-page masthead and colophon footer",
    featRes.status === 200 &&
      featHtml.includes('<body class="shell-page">') &&
      featHtml.includes('class="site-nav-link is-active" href="/features" aria-current="page"') &&
      featHtml.includes('<footer class="byline site-footer">'),
  );

  const confRes = await handleRequest(new Request("http://127.0.0.1/conformance"));
  const confHtml = await confRes.text();
  assert(
    "GET /conformance renders unified shell-page masthead and colophon footer",
    confRes.status === 200 &&
      confHtml.includes('<body class="shell-page">') &&
      confHtml.includes(
        'class="site-nav-link is-active" href="/conformance" aria-current="page"',
      ) &&
      confHtml.includes('<footer class="byline site-footer">'),
  );
} finally {
  await stubServer.shutdown();
}

if (failures > 0) {
  console.error(`shell-layout.test.mjs: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log(`shell-layout fixture: all ${passed} assertions passed`);
