// @fixture-permissions --allow-read --allow-write --allow-run --allow-net=127.0.0.1,localhost --allow-env
// scripts/css-drift.test.mjs — the DETERMINISTIC half of the CSS-drift coverage (gendn-xe6f).
//
// This file holds every assertion that needs no browser, no served tree and no git: route glob/list
// selection, changed-path scoping (including the fail-closed cases), the capture expression, and
// snapshot comparison. It is auto-discovered by scripts/run-fixtures.mjs and therefore runs in the
// FAST tier whenever its own file, scripts/lib/css-drift.mjs, or a page changes.
//
// The five REAL-BROWSER scenarios (record / refuse-overwrite / no-drift compare / mismatched corpus
// / a real CSS mutation detected at both widths, plus the --changed scoping pass against a live
// server) moved to the NAMED suite scripts/css-drift-browser.test.mjs, invoked as
// `deno task test-css-drift-browser`. They are deliberately NOT auto-discovered: they cost ~29s of
// real Chrome, and paying that for an unrelated landing is what gendn-ohot is about. The changed-path
// map in scripts/gate-map.mjs makes that suite MANDATORY for changes to the CSS-drift sources, the
// shared stylesheet, routing/server code or the browser-capture helpers, and reports it as
// "SKIPPED (unaffected: <rule>)" - with the rule named - when nothing relevant changed. CI runs it
// unconditionally, so the fast tier's skip can never be the only thing that ever looks.
import {
  captureExpression,
  compareSnapshots,
  selectChangedRoutes,
  selectRoutes,
  VIEWPORTS,
} from "./lib/css-drift.mjs";

function assert(ok, reason) {
  if (!ok) throw new Error(reason);
}

const routes = ["/v147/a/", "/v148/b/", "/v149/c/"];
assert(
  JSON.stringify(selectRoutes(routes, "v147/*,/v149/c")) === JSON.stringify([routes[0], routes[2]]),
  "glob/list selection",
);
assert(
  JSON.stringify(selectRoutes(routes, "/v148/b/")) === JSON.stringify([routes[1]]),
  "absolute route selection",
);
assert(captureExpression().includes("getComputedStyle"), "browser collects computed CSS");
const nested = ["/v147/a/", "/v147/a/member/", "/v148/b/"];
assert(
  JSON.stringify(selectChangedRoutes(nested, ["v147/a/index.html"])) ===
    JSON.stringify(nested.slice(0, 1)),
  "changed leaf selects only its route",
);
assert(
  JSON.stringify(selectChangedRoutes(nested, ["v147/a/local.css"])) ===
    JSON.stringify(nested.slice(0, 2)),
  "changed parent asset includes nested routes",
);
assert(
  JSON.stringify(selectChangedRoutes(nested, ["v147/a/member/index.html", "v148/b/index.html"])) ===
    JSON.stringify([nested[1], nested[2]]),
  "changed member and another leaf select their exact routes",
);
for (
  const paths of [[], ["public/styles.css"], ["v149/new/index.html"], [
    "v147/a/index.html",
    "server.ts",
  ]]
) {
  let refused = false;
  try {
    selectChangedRoutes(nested, paths);
  } catch {
    refused = true;
  }
  assert(refused, `unsafe changed set must fail closed: ${JSON.stringify(paths)}`);
}
for (const pattern of ["", "v199/*", "../*"]) {
  let refused = false;
  try {
    selectRoutes(routes, pattern);
  } catch {
    refused = true;
  }
  assert(refused, `invalid/empty route selection must fail: ${pattern}`);
}
const baseline = {
  version: 1,
  viewports: VIEWPORTS,
  pages: {
    "/v147/a/": {
      desktop: { "main:0": { color: "red", display: "block" } },
      mobile: { "main:0": { color: "blue", display: "block" } },
    },
  },
};
assert(
  compareSnapshots(baseline, structuredClone(baseline)).length === 0,
  "unchanged snapshot is green",
);
const changed = structuredClone(baseline);
changed.pages["/v147/a/"].desktop["main:0"].color = "green";
changed.pages["/v147/a/"].mobile["a:0"] = { color: "blue" };
const diff = compareSnapshots(baseline, changed);
assert(
  diff.length === 2 &&
    diff.some((d) => d.property === "color" && d.before === "red" && d.after === "green") &&
    diff.some((d) => d.selector === "a:0"),
  "style and selector drift recorded",
);
const lost = structuredClone(baseline);
delete lost.pages["/v147/a/"];
assert(compareSnapshots(baseline, lost).length === 2, "missing route fails at both widths");

console.log(
  "css-drift fixture: all selection/comparison assertions passed (browser half: deno task test-css-drift-browser)",
);
