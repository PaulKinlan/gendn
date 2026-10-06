// scripts/artifacts-units.test.mjs — direct unit coverage for scripts/lib/artifacts.mjs (gendn-dd7).
//
// THE GAP: the shared helpers derive published-page identity/status/demo, the immutable suite
// hash and JSON-schema validation for MULTIPLE gates (check-routes, check-conformance,
// validate-artifacts). Only isMdnStubHtml had a direct assertion elsewhere; a silent derivation
// or hash regression could make those gates green for the WRONG tree. This fixture pins the
// actual contracts, read from the module rather than from any sample.
//
// NO network, NO catalogue mutation: derivation cases run on synthesized HTML strings and a
// TEMP catalogue root; schema cases use inline mini-schemas plus the repo's REAL schemas
// read-only (one real on-disk conformance.json must validate clean; an empty object must not).
//
// DETECTOR PROOF (logs referenced on the bead, not inline): three deliberately wrong
// implementations were run against this suite and each FAILED it — (1) normalizeAssertions
// without the key sort (key order leaks into the hash: 2 FAILs), (2) collectPublishedPages
// without the v<N> directory filter (deep children and non-versioned dirs get collected: 1
// FAIL), (3) isMdnStubHtml reading the RAW html instead of renderedMarkup (commented, scripted
// and closed-details eyebrows flip pages to stubs: 3 FAILs). Each mutation was restored and the
// suite returned to 54/54 with an empty git diff of the module. A suite that has never been
// shown to fail on a plausible wrong implementation is a claim, not a detector.
//
// Run: deno task test-artifacts-units

import {
  collectCritiques,
  collectPublishedPages,
  collectSuites,
  conformancePath,
  critiquePath,
  isMdnStubHtml,
  loadSchema,
  loadSupport,
  metadataFromHtml,
  normalizeAssertions,
  readJson,
  renderedMarkup,
  SHOWCASE_HOST,
  suiteHash,
  supportForRoute,
  validate,
} from "./lib/artifacts.mjs";

const REPO = new URL("..", import.meta.url).pathname;

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

// ---------- metadataFromHtml: identity / status / demo derivation ----------------------
const BUILT_HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="/public/styles.css">
</head><body>
<p class="eyebrow">v900 · testing</p>
<h1>Widget <code>API</code></h1>
<p>An <em>experimental</em> feature in <strong>origin trial</strong>.</p>
<div class="warn-block">Enable via chrome://flags/#widget</div>
<h2 id="syntax">Syntax</h2>
<h2 id="examples">Examples</h2>
<figure class="example-embed"><iframe src="https://${SHOWCASE_HOST}/v900/widget-api/demo-one/" title="x"></iframe></figure>
<p>Sibling: <a href="https://${SHOWCASE_HOST}/v900/other-feature/thing/">other</a></p>
<p>Record: <a href="https://chromestatus.com/feature/1234567890">chromestatus</a></p>
<div class="byline">gendn</div>
<!-- <h2>commented-out section</h2> -->
<script>console.log("<h2>not a section</h2>")</script>
<details><summary>closed</summary><h2 id="hidden">Hidden Section</h2></details>
<details open><summary>open</summary><h2 id="open">Open Section</h2></details>
</body></html>`;

const meta = metadataFromHtml("v900/widget-api/index.html", BUILT_HTML);
assert(
  "identity from the chromestatus link",
  meta.identity === "1234567890",
  String(meta.identity),
);
assert(
  "id/route/release/slug/milestone derived from the path",
  meta.id === "v900/widget-api" && meta.route === "/v900/widget-api/" && meta.release === "v900" &&
    meta.slug === "widget-api" && meta.milestone === 900,
);
assert("status built when no MDN eyebrow", meta.status === "built");
assert("experimental = built AND experimental marker in the html", meta.experimental === true);
assert(
  "sections are extracted from the RAW html — comments, script strings and closed <details> h2s ARE counted (actual contract, pinned as-is; contrast: stub detection uses renderedMarkup). Counting a superset is the conservative direction for coverage gates, but the asymmetry is a FINDING reported on gendn-dd7, not something this fixture may 'fix' by re-deriving.",
  JSON.stringify(meta.sections) ===
    JSON.stringify([
      "Syntax",
      "Examples",
      "commented-out section",
      "not a section",
      "Hidden Section",
      "Open Section",
    ]),
  JSON.stringify(meta.sections),
);
assert("h1 strips inner tags", meta.h1 === "Widget API", meta.h1);
assert(
  "hasIframe/hasWarnBlock/hasByline/hasStylesheet flags",
  meta.hasIframe && meta.hasWarnBlock && meta.hasByline && meta.hasStylesheet,
);
assert(
  "demo prefers the page's OWN showcase route over an earlier sibling link",
  meta.demo === `https://${SHOWCASE_HOST}/v900/widget-api/demo-one/`,
  String(meta.demo),
);
assert("isRemoval false for a normal feature page", meta.isRemoval === false);

// identity missing -> null (never fabricated)
const noId = metadataFromHtml("v900/no-id/index.html", `<html><body><h1>No ID</h1></body></html>`);
assert(
  "missing chromestatus link yields identity null, status built, demo null",
  noId.identity === null && noId.status === "built" && noId.demo === null,
);

// stub detection: the eyebrow must say "covered on MDN" and be VISIBLE
const stubVisible =
  `<html><body><p class="eyebrow">v900 · Covered on MDN — see the link</p><h1>Thing</h1></body></html>`;
const stubHidden =
  `<html><body><details><summary>s</summary><p class="eyebrow">Covered on MDN</p></details><h1>Thing</h1></body></html>`;
const stubComment =
  `<html><body><!-- <p class="eyebrow">Covered on MDN</p> --><h1>Thing</h1></body></html>`;
const stubInsideScript =
  `<html><body><script>var x = '<p class="eyebrow">Covered on MDN</p>';</script><h1>Thing</h1></body></html>`;
assert(
  "visible MDN eyebrow -> stub",
  isMdnStubHtml(stubVisible) &&
    metadataFromHtml("v900/t/index.html", stubVisible).status === "stub",
);
assert(
  "MDN eyebrow hidden inside a CLOSED <details> -> NOT a stub (rendered-markup check)",
  !isMdnStubHtml(stubHidden),
);
assert("MDN eyebrow inside a comment -> NOT a stub", !isMdnStubHtml(stubComment));
assert("MDN eyebrow inside a <script> string -> NOT a stub", !isMdnStubHtml(stubInsideScript));
assert(
  "a stub is never experimental even with experimental text",
  metadataFromHtml(
    "v900/t/index.html",
    stubVisible.replace("Covered on MDN", "Covered on MDN (experimental)"),
  ).experimental === false,
);

// isRemoval triggers
assert(
  "isRemoval from a deprecate- slug prefix",
  metadataFromHtml("v900/deprecate-thing/index.html", "<h1>Thing</h1>").isRemoval === true,
);
assert(
  "isRemoval from the h1 text",
  metadataFromHtml("v900/thing/index.html", "<h1>Thing: Removal plan</h1>").isRemoval === true,
);
assert(
  "isRemoval from an h2 mentioning deprecation",
  metadataFromHtml("v900/thing/index.html", "<h1>Thing</h1><h2>Deprecation timeline</h2>")
    .isRemoval === true,
);

// demo fallback: no own-prefix link -> the FIRST showcase link wins; own prefix found later overrides
const fallback = metadataFromHtml(
  "v900/thing/index.html",
  `<a href="https://${SHOWCASE_HOST}/v900/other/a/">a</a><a href="https://${SHOWCASE_HOST}/v900/thing/b/">b</a>`,
);
assert(
  "demo: an own-prefix match later in the document still wins over an earlier foreign link",
  fallback.demo === `https://${SHOWCASE_HOST}/v900/thing/b/`,
  String(fallback.demo),
);
const foreignOnly = metadataFromHtml(
  "v900/thing/index.html",
  `<a href="https://${SHOWCASE_HOST}/v900/other/a/">a</a><a href="https://${SHOWCASE_HOST}/v900/other/b/">b</a>`,
);
assert(
  "demo: with no own-prefix link, the FIRST showcase link is the fallback",
  foreignOnly.demo === `https://${SHOWCASE_HOST}/v900/other/a/`,
  String(foreignOnly.demo),
);

// ---------- renderedMarkup: nesting to a fixed point ------------------------------------
const nested =
  `<div hidden><details><summary>s</summary><div aria-hidden="true">DEEP</div></details></div>VISIBLE`;
assert(
  "renderedMarkup strips NESTED hidden constructs to a fixed point (one pass would leave DEEP)",
  !renderedMarkup(nested).includes("DEEP") && renderedMarkup(nested).includes("VISIBLE"),
);
const styled = `<section style="display:none">GONE</section><p>KEPT</p>`;
assert(
  "renderedMarkup strips display:none blocks",
  !renderedMarkup(styled).includes("GONE") && renderedMarkup(styled).includes("KEPT"),
);
assert(
  "renderedMarkup keeps content of an OPEN details",
  renderedMarkup(`<details open><summary>s</summary>OPEN-CONTENT</details>`).includes(
    "OPEN-CONTENT",
  ),
);

// ---------- normalizeAssertions / suiteHash: stability + change detection ----------------
const A = { id: "a", kind: "http-status", test: "/x/", expect: 200 };
const B = { id: "b", note: "n" };
const reorderedKeys = { expect: 200, test: "/x/", kind: "http-status", id: "a" };
assert(
  "normalizeAssertions is stable under key insertion order",
  normalizeAssertions([A, B]) === normalizeAssertions([reorderedKeys, B]),
);
assert(
  "normalizeAssertions is stable under array order (sorted by id)",
  normalizeAssertions([A, B]) === normalizeAssertions([B, A]),
);
assert(
  "normalizeAssertions DOES change when a value changes (no over-normalization)",
  normalizeAssertions([A, B]) !== normalizeAssertions([{ ...A, expect: 404 }, B]),
);
const h1 = await suiteHash([A, B]);
const h2 = await suiteHash([B, reorderedKeys]);
const h3 = await suiteHash([{ ...A, expect: 404 }, B]);
const h4 = await suiteHash([A, B, { id: "c" }]);
assert(
  "suiteHash: same semantics -> same hash (key order + array order)",
  h1 === h2,
  `${h1.slice(0, 12)} ${h2.slice(0, 12)}`,
);
assert("suiteHash: a changed VALUE changes the hash (weakening is detectable)", h1 !== h3);
assert("suiteHash: an ADDED assertion changes the hash", h1 !== h4);
assert("suiteHash is a 64-char lowercase hex sha256", /^[0-9a-f]{64}$/.test(h1), h1.slice(0, 16));

// ---------- validate: the mini-schema contract ------------------------------------------
const MINI = {
  type: "object",
  additionalProperties: false,
  required: ["name", "count", "kind"],
  properties: {
    name: { type: "string", minLength: 2, pattern: "^[a-z]+$" },
    count: { type: "integer", minimum: 1, maximum: 10 },
    kind: { enum: ["x", "y"] },
    tags: { type: "array", minItems: 1, items: { type: "string" } },
    extra: { $ref: "#/definitions/pos" },
  },
  patternProperties: { "^meta_": { type: "boolean" } },
  definitions: { pos: { type: "number", minimum: 0 } },
};
assert(
  "validate: a conforming document passes",
  validate(MINI, { name: "abc", count: 3, kind: "x", tags: ["t"], extra: 1.5, meta_a: true })
    .length === 0,
);
assert(
  "validate: missing required property is reported",
  validate(MINI, { name: "abc", count: 3 }).some((e) => /missing required property "kind"/.test(e)),
);
assert(
  "validate: type mismatch short-circuits downstream noise",
  validate(MINI, { name: 1, count: 3, kind: "x" }).some((e) => /expected type "string"/.test(e)),
);
assert(
  "validate: enum miss is reported",
  validate(MINI, { name: "abc", count: 3, kind: "z" }).some((e) => /not in enum/.test(e)),
);
assert(
  "validate: pattern + minLength on strings",
  validate(MINI, { name: "A", count: 3, kind: "x" }).length >= 1,
);
assert(
  "validate: minimum/maximum on numbers, integer type",
  validate(MINI, { name: "abc", count: 11, kind: "x" }).some((e) => /> maximum/.test(e)) &&
    validate(MINI, { name: "abc", count: 1.5, kind: "x" }).some((e) =>
      /expected type "integer"/.test(e)
    ),
);
assert(
  "validate: minItems + items on arrays",
  validate(MINI, { name: "abc", count: 3, kind: "x", tags: [] }).some((e) =>
    /fewer than minItems/.test(e)
  ) && validate(MINI, { name: "abc", count: 3, kind: "x", tags: [1] }).some((e) => /\[0\]/.test(e)),
);
assert(
  "validate: additionalProperties:false is enforced",
  validate(MINI, { name: "abc", count: 3, kind: "x", nope: 1 }).some((e) =>
    /additional property not allowed/.test(e)
  ),
);
assert(
  "validate: patternProperties route unknown keys",
  validate(MINI, { name: "abc", count: 3, kind: "x", meta_a: "notbool" }).some((e) =>
    /meta_a/.test(e)
  ),
);
assert(
  "validate: intra-document $ref resolves and applies",
  validate(MINI, { name: "abc", count: 3, kind: "x", extra: -1 }).some((e) =>
    /< minimum 0/.test(e)
  ),
);
assert(
  "validate: const is checked by JSON identity",
  validate({ const: "v1" }, "v1").length === 0 && validate({ const: "v1" }, "v2").length === 1,
);

// real repo schemas, read-only: a real committed suite must validate CLEAN; junk must not
const conformanceSchema = await loadSchema("conformance.schema.json", REPO.replace(/\/$/, ""));
const realSuite = await readJson(
  `${REPO}v152/notification-attribution-for-pwas-on-macos/conformance.json`,
);
assert(
  "loadSchema + readJson: the real conformance schema and a real committed suite load",
  !!conformanceSchema && !!realSuite,
);
assert(
  "validate: a REAL committed conformance.json passes its REAL schema (the gates' happy path)",
  realSuite ? validate(conformanceSchema, realSuite).length === 0 : false,
  realSuite ? validate(conformanceSchema, realSuite).slice(0, 2).join(" | ") : "suite unreadable",
);
assert(
  "validate: an empty object FAILS the real conformance schema (the validator can say no)",
  validate(conformanceSchema, {}).length > 0,
);

// ---------- support sidecar defaults ------------------------------------------------------
assert(
  "supportForRoute: a missing route defaults to untested/untested (never a fabricated ok)",
  JSON.stringify(supportForRoute({ routes: {} }, "/v9/x/")) ===
    JSON.stringify({ desktop: "untested", mobile: "untested" }),
);
assert(
  "supportForRoute: an existing record is returned as-is",
  supportForRoute({ routes: { "/v9/x/": { desktop: "ok", mobile: "broken" } } }, "/v9/x/")
    .mobile === "broken",
);

// ---------- temp-catalogue boundaries ------------------------------------------------------
const tmp = await Deno.makeTempDir({ prefix: "artifacts-units-" });
try {
  await Deno.mkdir(`${tmp}/v900/alpha`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/v900/alpha/index.html`, "<h1>Alpha</h1>");
  await Deno.writeTextFile(
    `${tmp}/v900/alpha/conformance.json`,
    JSON.stringify({ id: "v900/alpha", assertions: [A] }),
  );
  await Deno.writeTextFile(`${tmp}/v900/alpha/_questions.json`, JSON.stringify({ q: 1 }));
  await Deno.mkdir(`${tmp}/v900/beta`, { recursive: true }); // no index.html -> unpublished
  await Deno.mkdir(`${tmp}/v900/gamma/child`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/v900/gamma/child/index.html`, "<h1>Child</h1>"); // deep child: NOT a published page
  await Deno.mkdir(`${tmp}/v901/delta`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/v901/delta/index.html`, "<h1>Delta</h1>");
  await Deno.mkdir(`${tmp}/notversioned/page`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/notversioned/page/index.html`, "<h1>Nope</h1>");
  await Deno.writeTextFile(`${tmp}/v900/stray-file.html`, "x"); // file, not a slug dir

  const pages = await collectPublishedPages(tmp);
  assert(
    "collectPublishedPages: exactly v<N>/<slug>/index.html, sorted — deep children, non-v dirs and stray files excluded",
    JSON.stringify(pages) === JSON.stringify(["v900/alpha/index.html", "v901/delta/index.html"]),
    JSON.stringify(pages),
  );
  const suites = await collectSuites(tmp);
  assert(
    "collectSuites: only pages WITH a conformance.json contribute",
    suites.length === 1 && suites[0].id === "v900/alpha",
  );
  const critiques = await collectCritiques(tmp);
  assert(
    "collectCritiques: only pages WITH a _questions.json contribute",
    critiques.length === 1 && critiques[0].q === 1,
  );
  assert(
    "conformancePath/critiquePath shape",
    conformancePath("v9/x", tmp) === `${tmp}/v9/x/conformance.json` &&
      critiquePath("v9/x", tmp) === `${tmp}/v9/x/_questions.json`,
  );

  // loadSupport: no sidecar -> a well-formed empty default; with sidecar -> the raw record
  const noSupport = await loadSupport(tmp);
  assert(
    "loadSupport: missing sidecar yields {schemaVersion,updatedAt,routes:{}} (never undefined)",
    noSupport && noSupport.schemaVersion === 1 && JSON.stringify(noSupport.routes) === "{}",
  );
  await Deno.writeTextFile(
    `${tmp}/responsive-support.json`,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: "x",
      routes: { "/v900/alpha/": { desktop: "ok", mobile: "ok" } },
    }),
  );
  const withSupport = await loadSupport(tmp);
  assert(
    "loadSupport: an existing sidecar is returned and supportForRoute reads it",
    supportForRoute(withSupport, "/v900/alpha/").desktop === "ok",
  );

  // readJson: missing -> null; malformed -> THROWS (a corrupt suite must never look absent)
  assert(
    "readJson: missing file returns null",
    (await readJson(`${tmp}/v900/alpha/absent.json`)) === null,
  );
  await Deno.writeTextFile(`${tmp}/v900/alpha/bad.json`, "{oops");
  let threw = false;
  try {
    await readJson(`${tmp}/v900/alpha/bad.json`);
  } catch {
    threw = true;
  }
  assert("readJson: malformed JSON THROWS rather than returning null (corrupt != absent)", threw);
} finally {
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
}

if (failures > 0) {
  console.error(`artifacts-units.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`artifacts-units fixture: all ${passed} assertions passed`);
