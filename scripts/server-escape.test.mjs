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

// public/styles.css (gendn-f3t): .release-card-link:hover does not apply hover affordance to aria-disabled cards
const css = await Deno.readTextFile("public/styles.css");
assert(
  "public/styles.css: .release-card-link:hover does not apply to aria-disabled cards",
  !css.includes(".release-card-link:hover") &&
    css.includes('.release-card-link:not([aria-disabled="true"]):hover'),
);

await stubServer.shutdown();

if (failures) Deno.exit(1);
console.log("server-escape fixture: all assertions passed");
