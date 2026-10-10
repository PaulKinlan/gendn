// @fixture-permissions --allow-read
// gendn-i3yx: a concept's selected URL does not imply a same-path conformance suite.
// All replies are in-memory; failures demonstrate that missing/unrelated breadcrumbs cannot
// silently become invented feature-root links. No live network or immutable suite rewrites.
import { verifiedCpsConformance } from "./lib/cps-conformance.mjs";

const origin = "https://chrome-platform-showcase.paulkinlan-ea.deno.net";
const concept = "/v900/alpha/interactive-demo/";
const root = "/v900/alpha/";
const meta = { identity: "1234", demo: origin + concept };
const page = (html) =>
  new Response(html, { status: 200, headers: { "content-type": "text/html" } });
const json = (value) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const suite = { release: "v900", featureSlug: "alpha", chromestatusId: 1234 };
let passed = 0;
function assert(name, ok, detail = "") {
  if (!ok) throw new Error(`FAIL ${name}: ${detail}`);
  passed++;
  console.log(`PASS ${name}`);
}
async function scenario({ selected, rootSuite = suite, rootPage = true, rootHtml = true }) {
  const calls = [];
  const responses = new Map([
    [concept, page(selected)],
    [root + "conformance.json", json(rootSuite)],
    [root + "conformance", rootHtml ? page("feature suite") : new Response("", { status: 404 })],
  ]);
  if (rootPage) responses.set(root, page("feature root"));
  const fetcher = async (url, options) => {
    const parsed = new URL(url);
    const response = responses.get(parsed.pathname);
    calls.push({
      path: parsed.pathname,
      redirect: options.redirect,
      status: response?.status,
      type: response?.headers.get("content-type"),
    });
    return response?.clone() ?? new Response("not found", { status: 404 });
  };
  return { result: await verifiedCpsConformance(meta, fetcher), calls };
}
const linked =
  '<nav><a href="/v900/alpha/">Alpha feature</a><a href="/v900/alpha-sibling/">Wrong sibling</a></nav>';
let x = await scenario({ selected: linked });
assert(
  "verified feature breadcrumb + same-identity declared root yields the root contract",
  x.result.route === root + "conformance",
  JSON.stringify(x),
);
assert(
  "same-path concept conformance is never trusted",
  x.calls.some((c) => c.path === concept + "conformance.json") &&
    x.calls.every((c) => c.redirect === "manual"),
);
x = await scenario({ selected: '<a href="/v900/alpha-sibling/">Other feature</a>' });
assert(
  "no ancestor breadcrumb leaves NO contract even if an unlinked root suite exists",
  x.result.route === null && !x.calls.some((c) => c.path === root + "conformance.json"),
);
x = await scenario({ selected: linked, rootSuite: { ...suite, chromestatusId: 9999 } });
assert("different-feature parent suite leaves NO contract", x.result.route === null);
x = await scenario({ selected: linked, rootSuite: { ...suite, featureSlug: "other" } });
assert("same ID but wrong declared feature route leaves NO contract", x.result.route === null);
x = await scenario({
  selected: linked,
  rootSuite: { ...suite, featureSlug: "alpha/interactive-demo" },
});
assert("a nested slug cannot masquerade as a feature-root declaration", x.result.route === null);
x = await scenario({ selected: linked, rootPage: false });
assert("parent feature route itself must resolve", x.result.route === null);
x = await scenario({ selected: linked, rootHtml: false });
assert("parent conformance HTML must resolve as well as JSON", x.result.route === null);
const rootResult = await verifiedCpsConformance(
  { identity: "1234", demo: origin + root },
  async (url) => {
    const p = new URL(url).pathname;
    if (p === root) return page("root feature (no parent breadcrumb required)");
    if (p === root + "conformance.json") return json(suite);
    if (p === root + "conformance") return page("suite HTML");
    return new Response("", { status: 404 });
  },
);
assert(
  "selected feature-root page verifies its own suite without a parent breadcrumb",
  rootResult.route === root + "conformance",
);
console.log(`cps-conformance fixture: ${passed} assertions passed`);
