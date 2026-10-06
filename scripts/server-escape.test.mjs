// gendn-7xq: route-derived values are escaped at interpolation; malformed request URLs are handled.

// Local stub of the chromestatus API (gendn-x53) so renderFeaturesCatalogue can fetch real rows
// under --allow-net=127.0.0.1,localhost without depending on live external network.
// Must be set BEFORE importing server.ts (BASE is captured at import time in lib/chromestatus.ts).
const XSSI = ")]}'";
const evil = `x"><script>alert(1)</script>`;

const stubServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
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

// CSS HOVER AFFORDANCE GUARD (gendn-f3t):
// A non-interactive release card (rendered with aria-disabled="true" on its link) must not
// display ANY hover affordance:
//   1. The parent .release-card must not transform or raise box-shadow on hover.
//   2. The child .release-card-link must not recolour to accent-blue on hover.
//   3. Live cards (.release-card without disabled link) and .demo-card must retain hover behavior.
//
// FIDELITY / RUNTIME NOTE:
// This fixture (scripts/server-escape.test.mjs) runs in headless Deno without a DOM or browser
// layout engine (no document, no getComputedStyle; CDP/Chrome is reserved for landing-gate
// browser fixtures like test-reference-contract to keep fast fixtures lightweight).
// Therefore, a runtime computed-style hover test cannot run inside this file.
// Rather than asserting on a loose substring (Rule 153), we parse the CSS rule tree of public/styles.css
// to verify the structural contract of all hover rules touching release cards:
const css = await Deno.readTextFile("public/styles.css");
const strippedCss = css.replace(/\/\*[\s\S]*?\*\//g, "");
const cssRuleRe = /([^{}]+)\{([^{}]+)\}/g;
const cssRules = [];
let match;
while ((match = cssRuleRe.exec(strippedCss)) !== null) {
  const selectors = match[1].split(",").map((s) => s.trim()).filter(Boolean);
  const declarations = match[2].trim();
  cssRules.push({ selectors, declarations });
}

// Check 1: No release-card selector may apply :hover without gating on aria-disabled="true".
const releaseHoverSelectors = cssRules
  .flatMap((r) => r.selectors)
  .filter((s) => s.includes(".release-card") && s.includes(":hover"));

assert(
  "public/styles.css: all release-card hover selectors gate on the absence of aria-disabled='true'",
  releaseHoverSelectors.length > 0 &&
    releaseHoverSelectors.every((s) => s.includes(":not(") && s.includes('aria-disabled="true"')),
);
assert(
  "public/styles.css: no ungated .release-card:hover or .release-card-link:hover selector exists",
  !releaseHoverSelectors.some((s) => /^(\.release-card|\.release-card-link):hover$/.test(s)),
);

// Check 2: Parent card hover rule applies transform/box-shadow to enabled release-card AND preserves demo-card hover.
const cardLiftRule = cssRules.find(
  (r) =>
    r.declarations.includes("translate(-2px, -2px)") &&
    r.selectors.some((s) => s.includes(".release-card")),
);
assert(
  "public/styles.css: card-lift hover rule exists and gates .release-card on :not(:has([aria-disabled='true']))",
  cardLiftRule !== undefined &&
    cardLiftRule.selectors.includes('.release-card:not(:has([aria-disabled="true"])):hover'),
);
assert(
  "public/styles.css: card-lift hover rule preserves .demo-card:hover affordance",
  cardLiftRule !== undefined && cardLiftRule.selectors.includes(".demo-card:hover"),
);

// Check 3: Link recolour rule gates .release-card-link on :not([aria-disabled="true"]).
const linkColorRule = cssRules.find(
  (r) =>
    r.declarations.includes("var(--accent-blue)") &&
    r.selectors.some((s) => s.includes(".release-card-link")),
);
assert(
  "public/styles.css: link recolour rule gates on .release-card-link:not([aria-disabled='true']):hover",
  linkColorRule !== undefined &&
    linkColorRule.selectors.includes('.release-card-link:not([aria-disabled="true"]):hover'),
);

await stubServer.shutdown();

if (failures) Deno.exit(1);
console.log("server-escape fixture: all assertions passed");
