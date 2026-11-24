// scripts/site-discovery.test.mjs — tests for Workers precomputed metadata, _data/ fallback
// resilience, SEO/perf head metadata, and discovery/AI surface routes (/robots.txt, /sitemap.xml,
// /llms.txt, /feed.xml, /api/features.json).
//
// Zero live network dependency: replaces globalThis.fetch with a failing stub when exercising
// the production _data/ fallback and SSR routes, and restores all globals in finally.
//
// Run: npm run test-fixtures -- --tasks test-site-discovery

import { clearChromestatusCache, getChannels, getMilestoneFeatures } from "../lib/chromestatus.ts";
import { indexedSiteFS, setSiteFS, siteFS } from "../lib/site-fs.ts";
import { getPrecomputedMeta, setPrecomputedMeta } from "../lib/site-index.ts";
import { serveRequest } from "../server.ts";

let failures = 0;
let passed = 0;

function assert(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS: ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const ORIGIN = "https://gendn.example";
const origFetch = globalThis.fetch;
const origFS = siteFS();

try {
  // --- 1. Dynamic Node siteFS() discovery routes ---
  const robotsRes = await serveRequest(new Request(`${ORIGIN}/robots.txt`));
  const robotsText = await robotsRes.text();
  assert(
    "/robots.txt returns 200 text/plain with security + revalidation headers",
    robotsRes.status === 200 &&
      (robotsRes.headers.get("content-type") ?? "").startsWith("text/plain") &&
      robotsRes.headers.get("x-content-type-options") === "nosniff" &&
      robotsRes.headers.get("cache-control") === "no-cache" &&
      (robotsRes.headers.get("etag") ?? "").startsWith('W/"'),
    `status=${robotsRes.status}; ct=${robotsRes.headers.get("content-type")}`,
  );
  assert(
    "/robots.txt allows all and points to origin sitemap",
    robotsText.includes("User-agent: *") &&
      robotsText.includes("Allow: /") &&
      robotsText.includes(`Sitemap: ${ORIGIN}/sitemap.xml`),
  );

  // Conditional 304 revalidation works on discovery routes too
  const robotsEtag = robotsRes.headers.get("etag") ?? "";
  const robots304 = await serveRequest(
    new Request(`${ORIGIN}/robots.txt`, { headers: { "if-none-match": robotsEtag } }),
  );
  assert("/robots.txt answers 304 on matching If-None-Match", robots304.status === 304);

  const sitemapRes = await serveRequest(new Request(`${ORIGIN}/sitemap.xml`));
  const sitemapXml = await sitemapRes.text();
  assert(
    "/sitemap.xml returns 200 application/xml",
    sitemapRes.status === 200 &&
      (sitemapRes.headers.get("content-type") ?? "").startsWith("application/xml"),
    `status=${sitemapRes.status}; ct=${sitemapRes.headers.get("content-type")}`,
  );
  assert(
    "/sitemap.xml is well-formed urlset containing core hubs, pages, and nested child routes",
    sitemapXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') &&
      sitemapXml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">') &&
      sitemapXml.includes(`<loc>${ORIGIN}/</loc>`) &&
      sitemapXml.includes(`<loc>${ORIGIN}/features</loc>`) &&
      sitemapXml.includes(`<loc>${ORIGIN}/conformance</loc>`) &&
      sitemapXml.includes(`<loc>${ORIGIN}/v149/</loc>`) &&
      sitemapXml.includes(`<loc>${ORIGIN}/v149/webmcp/</loc>`) &&
      sitemapXml.includes(`<loc>${ORIGIN}/v147/autofill-event/constructor/</loc>`) &&
      sitemapXml.includes(`<loc>${ORIGIN}/v147/web-printing-api/types/shared-values/</loc>`) &&
      sitemapXml.trimEnd().endsWith("</urlset>"),
  );

  const llmsRes = await serveRequest(new Request(`${ORIGIN}/llms.txt`));
  const llmsText = await llmsRes.text();
  assert(
    "/llms.txt returns 200 text/plain",
    llmsRes.status === 200 &&
      (llmsRes.headers.get("content-type") ?? "").startsWith("text/plain"),
  );
  assert(
    "/llms.txt links /api/features.json and /sitemap.xml and groups built pages newest-first",
    llmsText.startsWith("# gendn\n") &&
      llmsText.includes(`${ORIGIN}/api/features.json`) &&
      llmsText.includes(`${ORIGIN}/sitemap.xml`) &&
      llmsText.includes(`[WebMCP](${ORIGIN}/v149/webmcp/)`) &&
      llmsText.includes("[ChromeStatus #5117755740913664]"),
  );
  const idxV152 = llmsText.indexOf("## Chrome 152");
  const idxV147 = llmsText.indexOf("## Chrome 147");
  assert(
    "/llms.txt orders newer milestones before older milestones",
    idxV152 !== -1 && idxV147 !== -1 && idxV152 < idxV147,
    `v152@${idxV152}, v147@${idxV147}`,
  );

  const feedRes = await serveRequest(new Request(`${ORIGIN}/feed.xml`));
  const feedXml = await feedRes.text();
  assert(
    "/feed.xml returns 200 application/atom+xml",
    feedRes.status === 200 &&
      (feedRes.headers.get("content-type") ?? "").startsWith("application/atom+xml"),
  );
  assert(
    "/feed.xml is a valid Atom feed with entries",
    feedXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') &&
      feedXml.includes('<feed xmlns="http://www.w3.org/2005/Atom">') &&
      feedXml.includes(
        `<link href="${ORIGIN}/feed.xml" rel="self" type="application/atom+xml"/>`,
      ) &&
      feedXml.includes("<entry>") &&
      feedXml.trimEnd().endsWith("</feed>"),
  );

  const apiRes = await serveRequest(new Request(`${ORIGIN}/api/features.json`));
  const apiText = await apiRes.text();
  const apiJson = JSON.parse(apiText);
  assert(
    "/api/features.json returns 200 application/json with complete catalogue schema",
    apiRes.status === 200 &&
      (apiRes.headers.get("content-type") ?? "").startsWith("application/json") &&
      apiJson.generatedBy === "gendn" &&
      apiJson.counts.total > 200 &&
      apiJson.counts.total === apiJson.counts.built + apiJson.counts.stub &&
      Array.isArray(apiJson.features) &&
      apiJson.features.length === apiJson.counts.total,
    `total=${apiJson.counts.total}, built=${apiJson.counts.built}, stub=${apiJson.counts.stub}`,
  );
  const webmcp = apiJson.features.find((f) => f.id === "v149/webmcp");
  const autofill = apiJson.features.find((f) => f.id === "v147/autofill-event");
  assert(
    "/api/features.json includes identity, chromestatusUrl, contract summary, and childRoutes",
    webmcp !== undefined &&
      webmcp.status === "built" &&
      webmcp.identity === "5117755740913664" &&
      webmcp.chromestatusUrl === "https://chromestatus.com/feature/5117755740913664" &&
      webmcp.hasContract === true &&
      webmcp.contractSummary?.completeness === "implementation-sufficient" &&
      autofill !== undefined &&
      autofill.childRoutes.includes("/v147/autofill-event/constructor/"),
  );

  // --- 2. _data/ resilience fallback when live chromestatus.com fails ---
  clearChromestatusCache();
  globalThis.fetch = async () => {
    throw new Error("simulated chromestatus.com outage");
  };

  const fallbackChannels = await getChannels();
  assert(
    "getChannels() falls back to _data/channels.json when live fetch fails",
    typeof fallbackChannels?.stable?.mstone === "number" &&
      typeof fallbackChannels?.beta?.mstone === "number" &&
      typeof fallbackChannels?.dev?.mstone === "number",
    `stable=${fallbackChannels?.stable?.mstone}`,
  );

  const fallbackM150 = await getMilestoneFeatures(150);
  assert(
    "getMilestoneFeatures(150) falls back to _data/features-150.json when live fetch fails",
    fallbackM150.milestone === 150 && fallbackM150.total > 0 && fallbackM150.groups.length > 0,
    `total=${fallbackM150.total}`,
  );

  let missingErr = null;
  try {
    await getMilestoneFeatures(9999);
  } catch (err) {
    missingErr = err;
  }
  assert(
    "getMilestoneFeatures(9999) with no _data snapshot still rejects honestly",
    missingErr !== null,
  );

  // --- 3. SEO & performance <head> metadata on SSR routes (while upstream is down, proving fallback!) ---
  const ssrChecks = [
    { path: "/", canonical: `${ORIGIN}/` },
    { path: "/features", canonical: `${ORIGIN}/features` },
    { path: "/v150/", canonical: `${ORIGIN}/v150/` },
    { path: "/conformance", canonical: `${ORIGIN}/conformance` },
  ];
  for (const { path, canonical } of ssrChecks) {
    const res = await serveRequest(new Request(`${ORIGIN}${path}`));
    const html = await res.text();
    assert(
      `SSR ${path} returns 200 with description, canonical, Open Graph, and gstatic preconnect`,
      res.status === 200 &&
        /<meta name="description" content="[^"]+">/.test(html) &&
        html.includes(`<link rel="canonical" href="${canonical}">`) &&
        /<meta property="og:title" content="[^"]+">/.test(html) &&
        /<meta property="og:description" content="[^"]+">/.test(html) &&
        html.includes('<meta property="og:type" content="website">') &&
        html.includes('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'),
      `status=${res.status}`,
    );
  }

  // --- 4. Precomputed Worker metadata bypasses ASSETS.fetch & GitHub API ---
  let assetFetchCalls = 0;
  let githubFetchCalls = 0;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("api.github.com")) githubFetchCalls++;
    throw new Error(`unexpected network fetch in precomputed test: ${url}`);
  };
  setSiteFS(
    indexedSiteFS(["_data/channels.json"], async (path) => {
      assetFetchCalls++;
      if (path === "_data/channels.json") {
        return new TextEncoder().encode(
          JSON.stringify({
            stable: { mstone: 150, version: 150, branch_point: "", stable_date: "2026-01-01" },
            beta: { mstone: 151, version: 151, branch_point: "", stable_date: "2026-02-01" },
            dev: { mstone: 152, version: 152, branch_point: "", stable_date: "2026-03-01" },
          }),
        );
      }
      return null;
    }),
  );
  setPrecomputedMeta({
    commit: {
      sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      shortSha: "deadbee",
      date: "2026-11-24T10:00:00Z",
      htmlUrl:
        "https://github.com/PaulKinlan/gendn/commit/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    },
    identityIndex: { "9876543210": "/v150/synthetic-api/" },
    conformanceSuites: [
      {
        id: "v150/synthetic-api",
        route: "/v150/synthetic-api/",
        status: "built",
        assertionCount: 12,
        identity: "9876543210",
      },
    ],
    pages: [
      {
        id: "v150/synthetic-api",
        route: "/v150/synthetic-api/",
        milestone: 150,
        slug: "synthetic-api",
        title: "Synthetic API",
        description: "Precomputed synthetic test reference.",
        status: "built",
        identity: "9876543210",
        demo: null,
        hasContract: true,
        contractSummary: {
          kind: "web-api",
          completeness: "implementation-sufficient",
          inventoryCount: 3,
        },
        childRoutes: ["/v150/synthetic-api/method/"],
      },
    ],
  });
  assert("getPrecomputedMeta() returns installed metadata", getPrecomputedMeta() !== null);

  assetFetchCalls = 0;
  const preConf = await serveRequest(new Request(`${ORIGIN}/conformance`));
  const preConfHtml = await preConf.text();
  assert(
    "precomputed /conformance renders from site-meta with ZERO siteFS reads",
    preConf.status === 200 &&
      assetFetchCalls === 0 &&
      preConfHtml.includes("v150/synthetic-api") &&
      preConfHtml.includes("1 suites (1 built / 0 stub)"),
    `assetFetchCalls=${assetFetchCalls}`,
  );

  const preApi = await serveRequest(new Request(`${ORIGIN}/api/features.json`));
  const preApiText = await preApi.text();
  const preApiJson = JSON.parse(preApiText);
  assert(
    "precomputed /api/features.json serves synthetic page with ZERO siteFS reads and omits commit.htmlUrl",
    preApi.status === 200 &&
      assetFetchCalls === 0 &&
      preApiJson.counts.total === 1 &&
      preApiJson.features[0].id === "v150/synthetic-api" &&
      preApiJson.commit?.shortSha === "deadbee" &&
      !("htmlUrl" in (preApiJson.commit ?? {})),
  );

  const preFeed = await serveRequest(new Request(`${ORIGIN}/feed.xml`));
  const preFeedXml = await preFeed.text();
  assert(
    "precomputed /feed.xml uses build-time commit timestamp and synthetic entry with ZERO siteFS reads",
    preFeed.status === 200 &&
      assetFetchCalls === 0 &&
      preFeedXml.includes("<updated>2026-11-24T10:00:00.000Z</updated>") &&
      preFeedXml.includes("Synthetic API (Chrome 150)"),
  );

  const preHome = await serveRequest(new Request(`${ORIGIN}/`));
  const preHomeHtml = await preHome.text();
  assert(
    "precomputed / renders build-time commit link with ZERO GitHub API calls",
    preHome.status === 200 &&
      githubFetchCalls === 0 &&
      preHomeHtml.includes("deadbee") &&
      preHomeHtml.includes("https://github.com/PaulKinlan/gendn/commit/deadbeef"),
    `githubFetchCalls=${githubFetchCalls}`,
  );

  const missingRunAll = await serveRequest(new Request(`${ORIGIN}/conformance/run-all`));
  const missingRunAllText = await missingRunAll.text();
  assert(
    "missing /conformance/run-all guidance names npm run conformance (not deno task)",
    missingRunAll.status === 404 &&
      missingRunAllText.includes("npm run conformance") &&
      !missingRunAllText.includes("deno task"),
    missingRunAllText,
  );
} finally {
  setPrecomputedMeta(null);
  setSiteFS(origFS);
  clearChromestatusCache();
  globalThis.fetch = origFetch;
}

if (failures > 0) {
  console.error(`site-discovery.test.mjs: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log(`site-discovery fixture: all ${passed} assertions passed`);
