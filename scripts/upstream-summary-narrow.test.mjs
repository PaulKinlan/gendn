// @fixture-permissions --allow-read --allow-net=127.0.0.1,localhost --allow-env
// gendn-25hn: a non-string upstream summary must degrade, never throw. The declared `summary: string`
// type in FeatureSummary is a compile-time claim only — getJson casts unchecked — and both render
// sites slice the field, so a number/boolean/object summary used to throw TypeError out of the
// renderer and 502 the whole page. Runtime narrow per the THREAT_MODEL.md §4.1 disposition
// (chromeStatusUrl()/milestonePathSegment() shape): non-string degrades to "", the cap itself is
// unchanged.

// Local stub of the chromestatus API (same shape as server-escape.test.mjs) so renderers fetch
// controlled hostile rows under --allow-net=127.0.0.1,localhost. Must be set BEFORE importing
// server.ts (BASE is captured at import time in lib/chromestatus.ts).
const XSSI = ")]}'";

// "Animatable zoom" → slug animatable-zoom, "CSS light-dark with image values" →
// css-light-dark-with-image-values, "Allow optional rounding parameter for polygon" →
// allow-optional-rounding-parameter-for-polygon and "Comma separated container queries" →
// comma-separated-container-queries are all real v150 doc folders, so the catalogue's
// featureHasDoc check passes and the row (and its summary handling) is actually constructed.
// The last entry has NO summary field at all (undefined after the unchecked cast).
const HOSTILE_FEATURES = [
  { id: 102, name: "Animatable zoom", summary: 12345 },
  { id: 103, name: "CSS light-dark with image values", summary: "x".repeat(300) },
  { id: 104, name: "Allow optional rounding parameter for polygon", summary: null },
  { id: 105, name: "Comma separated container queries" },
];

const stubServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
  const json = (body) => new Response(body, { headers: { "content-type": "application/json" } });
  if (url.pathname === "/features" && url.searchParams.get("milestone") === "150") {
    return json(
      `${XSSI}\n${
        JSON.stringify({
          features_by_type: { "Enabled by default": HOSTILE_FEATURES },
        })
      }`,
    );
  }
  if (url.pathname === "/channels") {
    return json(
      `${XSSI}\n${
        JSON.stringify({
          dev: { mstone: 151, version: 151, branch_point: "", stable_date: "" },
          beta: { mstone: 150, version: 150, branch_point: "", stable_date: "" },
          stable: { mstone: 149, version: 149, branch_point: "", stable_date: "" },
        })
      }`,
    );
  }
  return json(`${XSSI}\n${JSON.stringify({ features_by_type: {} })}`);
});

Deno.env.set("CHROMESTATUS_BASE", `http://127.0.0.1:${stubServer.addr.port}`);

const { handleRequest, renderFeaturesCatalogue } = await import("../server.ts");

let failures = 0;
function assert(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failures++;
}

try {
  // --- catalogue (/features): one malformed summary must not take the page down ---
  const channels = {
    dev: { mstone: 151, version: 151, branch_point: "", stable_date: "" },
    beta: { mstone: 150, version: 150, branch_point: "", stable_date: "" },
    stable: { mstone: 149, version: 149, branch_point: "", stable_date: "" },
  };
  // Pre-fix this call itself threw: TypeError: (f.summary ?? "").slice is not a function.
  const catalogueHtml = await renderFeaturesCatalogue(channels).catch((err) => {
    assert(
      `renderFeaturesCatalogue must not throw on a non-string summary (threw: ${
        String((err && err.message) || err).split("\n")[0]
      })`,
      false,
    );
    return null;
  });
  if (catalogueHtml !== null) {
    assert(
      "renderFeaturesCatalogue: renders despite a non-string upstream summary (no TypeError)",
      catalogueHtml.includes('data-mstone="150"') &&
        catalogueHtml.includes("/v150/animatable-zoom/"),
    );
    assert(
      "catalogue: non-string summary degrades to empty in data-search, not a throw and not coerced digits",
      catalogueHtml.includes('data-search="animatable zoom  shipped v150"') &&
        !catalogueHtml.includes("12345"),
    );
    assert(
      "catalogue: 220-char summary cap (gendn-1krm) still applies to real strings",
      catalogueHtml.includes("x".repeat(220)) && !catalogueHtml.includes("x".repeat(221)),
    );
    assert(
      "catalogue: null and missing (undefined) summaries still render doc-backed rows, never throw",
      catalogueHtml.includes("/v150/allow-optional-rounding-parameter-for-polygon/") &&
        catalogueHtml.includes("/v150/comma-separated-container-queries/") &&
        catalogueHtml.includes(
          'data-search="allow optional rounding parameter for polygon  shipped v150"',
        ),
    );
  }

  // --- release page (/v<N>/): same field, pre-existing crash site ---
  const releaseRes = await handleRequest(
    new Request(`http://127.0.0.1:${stubServer.addr.port}/v150/`),
  );
  const releaseHtml = await releaseRes.text();
  assert(
    "handleRequest /v150/: returns 200, not a 502 from a thrown .slice on a non-string summary",
    releaseRes.status === 200,
  );
  assert(
    "release page: non-string summary renders an empty paragraph, feature still listed and linked",
    releaseHtml.includes("<p></p>") &&
      releaseHtml.includes("chromestatus.com/feature/102") &&
      !releaseHtml.includes("12345"),
  );
  assert(
    "release page: null and missing (undefined) summaries render rows, never throw",
    releaseHtml.includes("Allow optional rounding parameter for polygon") &&
      releaseHtml.includes("Comma separated container queries"),
  );
  assert(
    "release page: long string summary still capped at 220 chars with ellipsis",
    releaseHtml.includes(`${"x".repeat(220)}...`) && !releaseHtml.includes("x".repeat(221)),
  );
} finally {
  await stubServer.shutdown();
}

if (failures) Deno.exit(1);
console.log("upstream-summary-narrow fixture: all assertions passed");
