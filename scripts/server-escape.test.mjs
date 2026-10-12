// @fixture-permissions --allow-read --allow-write --allow-run --allow-net=127.0.0.1,localhost --allow-env
// gendn-7xq: route-derived values are escaped at interpolation; malformed request URLs are handled.

// Local stub of the chromestatus API (gendn-x53) so renderFeaturesCatalogue can fetch real rows
// under --allow-net=127.0.0.1,localhost without depending on live external network.
// Must be set BEFORE importing server.ts (BASE is captured at import time in lib/chromestatus.ts).
const XSSI = ")]}'";
const evil = `x"><script>alert(1)</script>`;

// gendn-1krm: an oversized upstream summary (bounded only by the 8 MiB fetchBounded ceiling)
// must be capped per field where it feeds SSR output. 5000 chars stands in for a malformed or
// adversarial payload; only the first SUMMARY_CAP (220) chars may reach the catalogue.
const oversizedSummary = `${"z".repeat(5000)}UNIQUE_TAIL_BEYOND_CAP`;

// gendn-kow4: the OTHER free-text fields on the same rows are the same untrusted class the
// summary cap closed. "Animatable zoom" + "!"*5000 reproduces the reviewer probe exactly: the
// "!" run is slug-inert (slugify strips it), so the row passes the hasDoc filter and — without
// a name cap — rendered a ~200 KB data-search attribute inside a ~406 KB response. The hostile
// category key is a features_by_type object key reaching data-status, cells and group titles.
const oversizedName = `Animatable zoom${"!".repeat(5000)}`;
const oversizedCategory = `${"c".repeat(5000)}CATEGORY_TAIL_BEYOND_CAP`;

let servedIndexHtml = "";
let servedCss = "";

const stubServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/") {
    return new Response(servedIndexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/public/styles.css") {
    return new Response(servedCss, {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  }
  const json = (body) => new Response(body, { headers: { "content-type": "application/json" } });
  if (url.pathname === "/features" && url.searchParams.get("milestone") === "150") {
    return json(`${XSSI}\n${
      JSON.stringify({
        features_by_type: {
          "Enabled by default": [
            {
              id: 101,
              name: "AccentColor and AccentColorText system colors",
              summary: evil,
            },
            {
              id: 102,
              name: "Animatable zoom",
              summary: oversizedSummary,
            },
          ],
          [oversizedCategory]: [
            {
              id: 103,
              name: oversizedName,
              summary: "short summary",
            },
          ],
        },
      })
    }`);
  }
  return json(`${XSSI}\n${JSON.stringify({ features_by_type: {} })}`);
});

Deno.env.set("CHROMESTATUS_BASE", `http://127.0.0.1:${stubServer.addr.port}`);

const { milestonePathSegment } = await import("../lib/chromestatus.ts");
const {
  crossReferenceTag,
  handleRequest,
  knownReleaseMilestones,
  referenceTag,
  renderFeaturesCatalogue,
  renderIndex,
  renderReleasePage,
} = await import("../server.ts");

let failures = 0;
function assert(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failures++;
}
for (
  const [name, html] of [
    ["referenceTag release", referenceTag(evil, "ok")],
    ["referenceTag slug", referenceTag("v1", evil)],
    ["crossReferenceTag", crossReferenceTag(`/v1/${evil}/`)],
  ]
) {
  assert(
    `${name}: no raw <script> or quote breakout`,
    !html.includes("<script>") && !html.includes('x">'),
  );
  assert(`${name}: escaped form present`, html.includes("&lt;script&gt;"));
}
assert(
  "honest slug renders unchanged",
  referenceTag("v150", "foo-bar") ===
    '<a class="tag tag-live" href="/v150/foo-bar/">reference &rarr;</a>',
);
const bad = await handleRequest({ url: "not a url" });
assert("malformed request URL returns handled 400", bad.status === 400);

// gendn-sxn / gendn-x53: milestone values from channels are narrowed; hostile milestone values fall back to aria-disabled without attribute breakout
const hostileChannels = {
  dev: { mstone: '1" onmouseover="alert(1)', version: 151, branch_point: "", stable_date: "" },
  beta: { mstone: 150, version: 150, branch_point: "", stable_date: "" },
  stable: { mstone: 149, version: 149, branch_point: "", stable_date: "" },
};
const indexHtml = await renderIndex(hostileChannels);
assert(
  "renderIndex: hostile milestone does NOT inject onmouseover attribute into href",
  !indexHtml.includes('href="/v1" onmouseover'),
);
assert(
  "renderIndex: invalid milestone link drops href and marks aria-disabled, no clickable '#' fallback",
  !indexHtml.includes('href="#"') &&
    indexHtml.includes('<a class="release-card-link" aria-disabled="true">'),
);
assert(
  "renderIndex: hostile milestone label is escaped, no unescaped quote breakout",
  indexHtml.includes("&quot; onmouseover=&quot;alert(1)"),
);

const catalogueHtml = await renderFeaturesCatalogue(hostileChannels);
assert(
  "renderFeaturesCatalogue: renders real rows from local chromestatus stub (not empty)",
  catalogueHtml.includes('data-mstone="150"') &&
    catalogueHtml.includes("/v150/accentcolor-and-accentcolortext-system-colors/"),
);
assert(
  "renderFeaturesCatalogue: hostile channel milestone does NOT inject onmouseover attribute into href or option",
  !catalogueHtml.includes("onmouseover") &&
    catalogueHtml.includes('<option value="150">v150</option>'),
);
assert(
  "renderFeaturesCatalogue: hostile feature summary does NOT inject raw script or quote breakout into row attributes",
  !catalogueHtml.includes("<script>alert(1)</script>") &&
    !catalogueHtml.includes('x">') &&
    catalogueHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
);
assert(
  "renderFeaturesCatalogue: invalid milestone drops href and does not emit clickable '#' fallback",
  !catalogueHtml.includes('href="#"'),
);

// gendn-1krm: the untrusted upstream summary is capped per field (SUMMARY_CAP = 220, shared with
// renderReleasePage) before it feeds a catalogue row's data-search string, so the 5000-char stub
// payload contributes at most its first 220 chars and its tail never reaches the /features
// response that withRevalidation buffers and hashes whole.
{
  const zoomRow = catalogueHtml.match(
    /<tr data-search="[^"]*"[^>]*>\s*<td><a [^>]*>Animatable zoom<\/a>/,
  );
  const zoomSearch = zoomRow?.[0].match(/data-search="([^"]*)"/)?.[1] ?? "";
  assert(
    "renderFeaturesCatalogue: oversized-summary row is rendered (doc dir exists) and searchable by its capped prefix",
    zoomRow !== null && zoomSearch.includes("z".repeat(200)),
  );
  assert(
    "renderFeaturesCatalogue: no run of 221+ chars from the 5000-char summary survives the cap",
    !/z{221}/.test(catalogueHtml),
  );
  assert(
    "renderFeaturesCatalogue: content beyond the cap is absent from the entire response",
    // data-search is lowercased before interpolation, so assert the lowercased tail form.
    !catalogueHtml.includes("unique_tail_beyond_cap"),
  );
  assert(
    `renderFeaturesCatalogue: combined data-search stays bounded (name+220+category+milestone; got ${zoomSearch.length} chars)`,
    zoomSearch.length > 0 && zoomSearch.length <= 300,
  );
}

// gendn-kow4: name and category complete the per-field bound for the whole upstream-derived row.
// The hostile row's search string is name(220 max) + summary + category(96 max) + milestone, so a
// hostile row can no longer inflate the combined /features document that withRevalidation
// buffers and SHA-1 hashes whole. The row href must still target the slug hasDoc validated
// (carried from the RAW name, not re-derived from the capped display name).
{
  const hostileTr = catalogueHtml.match(/<tr data-search="[^"]*![^"]*"[^>]*>[\s\S]*?<\/tr>/);
  const hostileSearch = hostileTr?.[0].match(/data-search="([^"]*)"/)?.[1] ?? "";
  // Internal doc href only (the name cell's chromestatus link is https://, excluded by the pattern).
  const hostileHref = hostileTr?.[0].match(/href="\/v\d+\/[^"]*"/)?.[0] ?? "";
  assert(
    "renderFeaturesCatalogue: oversized-name/category row is rendered (slug-inert suffix keeps the doc dir match)",
    hostileTr !== null,
  );
  assert(
    "renderFeaturesCatalogue: hostile row href targets the hasDoc-validated slug",
    hostileHref === 'href="/v150/animatable-zoom/"',
  );
  assert(
    `renderFeaturesCatalogue: combined data-search stays bounded with name+summary+category (got ${hostileSearch.length} chars)`,
    hostileSearch.length > 0 && hostileSearch.length <= 600,
  );
  assert(
    "renderFeaturesCatalogue: name caps at 220 chars (205-char ! run present, 206+ absent)",
    /!{205}/.test(catalogueHtml) && !/!{206}/.test(catalogueHtml),
  );
  assert(
    "renderFeaturesCatalogue: category caps at 96 chars in data-status (96-char c run present, 97+ absent)",
    /data-status="c{96}"/.test(catalogueHtml) && !/c{97}/.test(catalogueHtml),
  );
  assert(
    "renderFeaturesCatalogue: content beyond either cap is absent from the entire response",
    !catalogueHtml.includes("CATEGORY_TAIL_BEYOND_CAP") &&
      !catalogueHtml.includes("category_tail_beyond_cap"),
  );

  const releaseHtml = await renderReleasePage("v150", 150);
  assert(
    "renderReleasePage: oversized name caps in the card heading (205-char ! run present, 206+ absent)",
    releaseHtml.includes("Animatable zoom") && /!{205}/.test(releaseHtml) &&
      !/!{206}/.test(releaseHtml),
  );
  assert(
    "renderReleasePage: oversized category caps in the group title (96-char c run present, 97+ absent)",
    /group-title">c{96} /.test(releaseHtml) && !/c{97}/.test(releaseHtml),
  );
  assert(
    "renderReleasePage: content beyond either cap is absent from the release page too",
    !releaseHtml.includes("CATEGORY_TAIL_BEYOND_CAP"),
  );
}

// gendn-f3t: knownReleaseMilestones is the boundary filtering hostile or unbounded channel data
// before milestones reach catalogue options, feature fetches, or route dispatch.
// If the milestonePathSegment narrow in knownReleaseMilestones is removed (mutated to set.add(Number(raw))),
// hostile non-numeric strings become NaN, and out-of-range milestone values (e.g. 99999, 10000, 0, -1)
// pollute the admitted set.
const known = await knownReleaseMilestones(hostileChannels);
assert(
  "knownReleaseMilestones: hostile channel milestone does not inject NaN or non-milestone into known set",
  !known.has(NaN) &&
    ![...known].some((m) => typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 9999),
);
assert(
  "knownReleaseMilestones: every admitted milestone strictly satisfies milestonePathSegment bound (1..9999)",
  [...known].every((m) =>
    milestonePathSegment(m) !== null && Number(milestonePathSegment(m)) === m
  ),
);

const outOfBoundsChannels = {
  dev: { mstone: 99999, version: 151, branch_point: "", stable_date: "" },
  beta: { mstone: 10000, version: 150, branch_point: "", stable_date: "" },
  stable: { mstone: 0, version: 149, branch_point: "", stable_date: "" },
};
const knownOutOfBounds = await knownReleaseMilestones(outOfBoundsChannels);
assert(
  "knownReleaseMilestones: out-of-range channel milestones (99999, 10000, 0, -1) are filtered",
  !knownOutOfBounds.has(99999) &&
    !knownOutOfBounds.has(10000) &&
    !knownOutOfBounds.has(0) &&
    !knownOutOfBounds.has(-1),
);

// BROWSER COMPUTED-STYLE HOVER AFFORDANCE TEST (gendn-f3t Option A):
// Drive headless Chrome over CDP to verify real visual/pointer affordances on the rendered
// renderIndex(hostileChannels) output using the actual public/styles.css stylesheet:
// 1. Live card (Chrome 150 - derived from channels.beta.mstone, NOT from a v154/ directory) lifts (transform: matrix(1, 0, 0, 1, -2, -2)), deepens shadow (6px), and recolours link (rgb(0, 34, 255)).
// 2. Disabled card (Chrome 1" onmouseover="alert(1)) does NOT lift (transform: none), retains flat shadow (4px), and retains text color (rgb(0, 0, 0)).
const { launch } = await import("./lib/cdp.mjs");
const css = await Deno.readTextFile("public/styles.css");
servedCss = css;
servedIndexHtml = indexHtml;

const browser = await launch();
let page;
try {
  page = await browser.newPage({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${stubServer.addr.port}/`);

  // Unhovered baseline (mouse at origin)
  await page.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  const baseline = await page.evaluate(`(() => {
  const liveCard = document.querySelector(".release-card:has(a[href*='/v150/'])");
  const liveLink = liveCard.querySelector(".release-card-link");
  const disabledCard = document.querySelector(".release-card:has(a[aria-disabled='true'])");
  const disabledLink = disabledCard.querySelector(".release-card-link");
  return {
    liveTransform: getComputedStyle(liveCard).transform,
    liveShadow: getComputedStyle(liveCard).boxShadow,
    liveColor: getComputedStyle(liveLink).color,
    disabledTransform: getComputedStyle(disabledCard).transform,
    disabledShadow: getComputedStyle(disabledCard).boxShadow,
    disabledColor: getComputedStyle(disabledLink).color,
  };
})()`);

  assert("browser baseline: live card is unhovered", baseline.liveTransform === "none");
  assert("browser baseline: disabled card is unhovered", baseline.disabledTransform === "none");

  // Hover over live card
  const liveCoords = await page.evaluate(`(() => {
  const liveCard = document.querySelector(".release-card:has(a[href*='/v150/'])");
  liveCard.scrollIntoView({ block: "center" });
  const r = liveCard.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
  await page.cmd("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: liveCoords.x,
    y: liveCoords.y,
  });
  await new Promise((r) => setTimeout(r, 250));

  const liveHovered = await page.evaluate(`(() => {
  const liveCard = document.querySelector(".release-card:has(a[href*='/v150/'])");
  const liveLink = liveCard.querySelector(".release-card-link");
  return {
    cardTransform: getComputedStyle(liveCard).transform,
    cardShadow: getComputedStyle(liveCard).boxShadow,
    linkColor: getComputedStyle(liveLink).color,
  };
})()`);

  assert(
    "browser hover: live card lifts (-2px, -2px)",
    liveHovered.cardTransform === "matrix(1, 0, 0, 1, -2, -2)",
  );
  assert(
    "browser hover: live card raises box-shadow (6px)",
    liveHovered.cardShadow === "rgb(0, 0, 0) 6px 6px 0px 0px",
  );
  assert(
    "browser hover: live card link recolours to accent-blue",
    liveHovered.linkColor === "rgb(0, 34, 255)",
  );

  // Reset pointer to origin
  await page.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  await new Promise((r) => setTimeout(r, 250));

  // Hover over disabled card
  const disabledCoords = await page.evaluate(`(() => {
  const disabledCard = document.querySelector(".release-card:has(a[aria-disabled='true'])");
  disabledCard.scrollIntoView({ block: "center" });
  const r = disabledCard.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
  await page.cmd("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: disabledCoords.x,
    y: disabledCoords.y,
  });
  await new Promise((r) => setTimeout(r, 250));

  const disabledHovered = await page.evaluate(`(() => {
  const disabledCard = document.querySelector(".release-card:has(a[aria-disabled='true'])");
  const disabledLink = disabledCard.querySelector(".release-card-link");
  return {
    cardTransform: getComputedStyle(disabledCard).transform,
    cardShadow: getComputedStyle(disabledCard).boxShadow,
    linkColor: getComputedStyle(disabledLink).color,
  };
})()`);

  assert(
    "browser hover: disabled card does NOT lift (transform remains none)",
    disabledHovered.cardTransform === "none",
  );
  assert(
    "browser hover: disabled card does NOT raise box-shadow (remains 4px flat shadow)",
    disabledHovered.cardShadow === "rgb(0, 0, 0) 4px 4px 0px 0px",
  );
  assert(
    "browser hover: disabled card link does NOT recolour (remains text-black)",
    disabledHovered.linkColor === "rgb(0, 0, 0)",
  );
} finally {
  // ALWAYS release the browser, even when a CDP call THROWS rather than returning an error (e.g. the
  // 30s CDP timeout in lib/cdp.mjs) - otherwise page.close()/browser.close() are skipped and Chrome
  // plus its temp profile dir are orphaned. page is guarded because newPage() itself can throw.
  if (page) {
    try {
      await page.close();
    } catch {
      // already gone
    }
  }
  await browser.close();
  await stubServer.shutdown();
}

if (failures) Deno.exit(1);
console.log("server-escape fixture: all assertions passed");
