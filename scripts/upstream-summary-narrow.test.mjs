// @fixture-permissions --allow-read --allow-write --allow-run --allow-net=127.0.0.1,localhost --allow-env
// gendn-25hn: a non-string upstream summary must degrade, never throw. The declared `summary: string`
// type in FeatureSummary is a compile-time claim only — getJson casts unchecked — and both render
// sites slice the field, so a number/boolean/object summary used to throw TypeError out of the
// renderer and 502 the whole page. Runtime narrow per the THREAT_MODEL.md §4.1 disposition
// (chromeStatusUrl()/milestonePathSegment() shape): non-string degrades to "", the cap itself is
// unchanged.
// gendn-iued: the SAME disposition applied to f.name — the whole crash path, not just one
// consumer: slugify(f.name) threw first, and escapeHTML(f.name)/Row.name consumers would throw
// the same way, so both mappers narrow once at the head of the value's path. A nameless feature
// degrades to an empty heading on the release page and is honestly omitted from the catalogue
// (slug "" matches no doc directory; there is no v<N>/index.html).

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
  // gendn-iued: malformed names — null, number, object. Same class as the summary cases:
  // slugify(f.name) threw on these and 502'd BOTH surfaces (probe-verified at base ef12ba2:
  // /features and /v150/ both 502 for all three kinds).
  { id: 106, name: null, summary: "null name" },
  { id: 107, name: 12345, summary: "numeric name" },
  { id: 108, name: { hostile: true }, summary: "object name" },
  // gendn-iz07: a 245-unit name whose RAW slug ("animatable-zoom") differs from its
  // capped-at-220 slug (""). The slug must derive from the RAW string — route resolution
  // may not depend on a display cap — or this row (and its doc link) silently disappears.
  {
    id: 109,
    name: "\u{1F389}".repeat(115) + "Animatable zoom",
    summary: "emoji padded name",
  },
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
    assert(
      "catalogue: non-string names degrade — no coerced '[object Object]' anywhere",
      !catalogueHtml.includes("[object Object]"),
    );
    assert(
      "catalogue: nameless features are honestly omitted (no row, no chromestatus link for 106/107/108)",
      !catalogueHtml.includes("chromestatus.com/feature/106") &&
        !catalogueHtml.includes("chromestatus.com/feature/107") &&
        !catalogueHtml.includes("chromestatus.com/feature/108"),
    );
    assert(
      "catalogue: a name narrowed to '' because it was NOT a string is never reported as truncated " +
        "(the only data-truncated belongs to the genuinely-cut long-string row 109; nameless rows " +
        "are absent entirely — truncation is a property of a cut string, not a rejected value)",
      (catalogueHtml.match(/data-truncated/g)?.length ?? 0) === 1,
    );
    const longRow = catalogueHtml.match(/<tr [^>]*>[\s\S]*?<\/tr>/g)?.find((tr) =>
      tr.includes("chromestatus.com/feature/109")
    );
    assert(
      "catalogue: >NAME_CAP name keeps its row AND its raw-slug doc link (gendn-iz07: slug derives " +
        "from the RAW string, not the display cap)",
      longRow !== undefined && longRow.includes('href="/v150/animatable-zoom/"'),
    );
    assert(
      "catalogue: >NAME_CAP name is display-capped (110-emoji run + '...') and flagged data-truncated=name",
      longRow !== undefined &&
        longRow.includes("\u{1F389}".repeat(110) + "...") &&
        longRow.includes('data-truncated="name"'),
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
  assert(
    "release page: non-string names never throw and never coerce — no '12345', no '[object Object]'",
    !releaseHtml.includes("12345") && !releaseHtml.includes("[object Object]"),
  );
  assert(
    "release page: name narrowed for being non-string carries NO truncation marker (empty anchor, no '...')",
    releaseHtml.includes(
      '<h3><a href="https://chromestatus.com/feature/106" target="_blank" rel="noopener"></a></h3>',
    ) &&
      !releaseHtml.includes('rel="noopener">...</a></h3>'),
  );
  const longCard = releaseHtml.match(/<li class="demo-card">[\s\S]*?<\/li>/g)?.find((c) =>
    c.includes("chromestatus.com/feature/109")
  );
  assert(
    "release page: >NAME_CAP name keeps its RAW-slug doc link (gendn-iz07) while the heading " +
      "display-caps with the '...' marker",
    longCard !== undefined && longCard.includes('href="/v150/animatable-zoom/"') &&
      longCard.includes("\u{1F389}".repeat(110) + "..."),
  );
  assert(
    "release page: nameless feature still listed with its chromestatus identity and an empty heading",
    releaseHtml.includes(
      '<h3><a href="https://chromestatus.com/feature/106" target="_blank" rel="noopener"></a></h3>',
    ) && releaseHtml.includes("null name"),
  );
  assert(
    "release page: number and object names degrade the same way (107/108 linked, empty headings)",
    releaseHtml.includes(
      '<h3><a href="https://chromestatus.com/feature/107" target="_blank" rel="noopener"></a></h3>',
    ) &&
      releaseHtml.includes(
        '<h3><a href="https://chromestatus.com/feature/108" target="_blank" rel="noopener"></a></h3>',
      ) && releaseHtml.includes("numeric name") && releaseHtml.includes("object name"),
  );
} finally {
  await stubServer.shutdown();
}

if (failures) Deno.exit(1);
console.log("upstream-summary-narrow fixture: all assertions passed");
