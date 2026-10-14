// @fixture-permissions --allow-read --allow-run --allow-env
// scripts/gate-manifest.test.mjs — the map tests for the affected-path gate (gendn-xe6f).
//
// A wrong or incomplete changed-path map is the NEW silent skip: a suite that no rule can select
// looks exactly like a suite with nothing to do. So this fixture pins, without a browser and without
// a real diff:
//   - classification for every path class the map claims to handle (CSS/shared stylesheet, css-drift
//     code, server, leaf page, a changed pure test, a changed browser test, a path reached only
//     through a textual reference scan, documentation);
//   - that a path nothing explains comes back UNKNOWN, and that UNKNOWN escalates to the FULL tier;
//   - that an empty diff, an unavailable diff and a merge commit all escalate to the FULL tier
//     (never "nothing to run");
//   - that the REAL map is complete: every discovered fixture is named by a rule, no rule names a
//     fixture that no longer exists, and the CSS browser suite is actually reachable.
// The real-browser half of the CSS coverage itself is executed by `deno task test-css-drift-browser`
// (a mapped change selects it, and CI runs it unconditionally); this fixture must stay browser-free
// so that a change to the gate does not cost 29s of Chrome to verify.

import {
  BROWSER_RULES,
  buildDependents,
  changedPathsFromGit,
  classifyPaths,
  COMPONENT_OF,
  CSS_BROWSER_SUITE,
  decideTier,
  discover,
  fixturesReferencing,
  importedPaths,
  PAGE_SUITES,
  RULES,
  validateMap,
} from "./gate-map.mjs";

function assert(ok, reason) {
  if (!ok) throw new Error(reason);
}

const root = new URL("..", import.meta.url).pathname;

// A small synthetic universe: enough for every classification branch, small enough to read.
const fixtures = [
  "test-css-drift",
  "test-css-drift-startup",
  "test-cdp",
  "test-fetch-bounded",
  "test-surface-coverage",
  "test-mystery",
  "test-reference-contract",
  "test-verdict-emission",
];
const syntheticBrowserSuites = [CSS_BROWSER_SUITE, "test-reference-contract"];
const sources = {
  "test-mystery": `const { thing } = await import("../lib/mystery.ts");\n`,
  // A consumer with NO import statement: it sweeps the file as TEXT (test-chromestatus-units does
  // exactly this to server.ts). An import-only relation cannot see it (gendn-8wwm).
  "test-surface-coverage": `const scanAll = ["server.ts", ...libFiles];\n`,
};
// A synthetic dependency graph: test-mystery imports lib/mystery.ts, and test-cdp imports test-mystery.
const syntheticDependents = new Map([
  ["lib/mystery.ts", ["test-mystery", "test-cdp"]],
  ["server.ts", ["test-cdp"]],
  ["scripts/lib/private-root.mjs", ["test-reference-browser"]],
]);
const classify = (paths) =>
  classifyPaths(paths, {
    fixtures,
    browserSuites: syntheticBrowserSuites,
    sources,
    dependents: syntheticDependents,
  });

// 1. The CSS-drift sources and the shared stylesheet select the pure fixture AND the browser tier.
for (const path of ["public/styles.css", "scripts/lib/css-drift.mjs", "scripts/css-drift.mjs"]) {
  const result = classify([path]);
  assert(result.selected.has("test-css-drift"), `${path} must select test-css-drift`);
  assert(
    result.browser.has(CSS_BROWSER_SUITE),
    `${path} must make the CSS browser suite MANDATORY (browser tier), got ${
      [...result.browser].join(", ")
    }`,
  );
  assert(result.unknown.length === 0, `${path} must not be unknown`);
}
const cssEdit = classify(["public/styles.css"]);
assert(
  cssEdit.matched.some((item) =>
    item.path === "public/styles.css" && item.rule.includes("css-drift")
  ),
  "the manifest must be able to name the rule that selected the CSS browser suite",
);

// 2. server.ts selects the server-driven fixtures.
const server = classify(["server.ts"]);
assert(server.selected.has("test-transport-headers"), `server.ts -> ${[...server.selected]}`);

// 3. A published leaf page selects the page-artifact suites (and never claims CSS coverage).
const page = classify(["v152/sub-apps/index.html"]);
assert(page.selected.has("test-surface-coverage"), `leaf page -> ${[...page.selected]}`);
assert(
  !page.browser.has(CSS_BROWSER_SUITE),
  "a leaf page must not be treated as covered by the fixed-route CSS sample",
);
assert(
  PAGE_SUITES.every((name) => page.selected.has(name)),
  "every page-artifact suite must be selected for a leaf page",
);

// 4. A changed test runs ITSELF - and STILL evaluates the rules that also name it. The early
//    `continue` that used to skip that is how a changed css-drift fixture silently dropped its own
//    mandatory browser suite (review finding 2).
assert(
  classify(["scripts/fetch-bounded.test.mjs"]).selected.has("test-fetch-bounded"),
  "a changed pure test must run itself",
);
const changedBrowserTest = classify(["scripts/css-drift-browser.test.mjs"]);
assert(
  changedBrowserTest.browser.has(CSS_BROWSER_SUITE),
  "a changed browser test must select the browser tier, not the fast fixture set",
);
const changedCssFixture = classify(["scripts/css-drift.test.mjs"]);
assert(
  changedCssFixture.selected.has("test-css-drift") &&
    changedCssFixture.browser.has(CSS_BROWSER_SUITE),
  `a changed css-drift fixture must run itself AND its mandatory browser suite: ${
    JSON.stringify([[...changedCssFixture.selected], [...changedCssFixture.browser]])
  }`,
);
const changedRefContract = classify(["scripts/reference-contract.test.mjs"]);
assert(
  changedRefContract.browser.has("test-reference-contract"),
  `a changed reference-contract fixture must select that named browser suite, not three innocent ones: ${
    JSON.stringify([[...changedRefContract.selected], [...changedRefContract.browser]])
  }`,
);
const changedCdp = classify(["scripts/cdp.test.mjs"]);
assert(
  changedCdp.selected.has("test-cdp") && changedCdp.browser.has("test-reference-contract"),
  `scripts/cdp.test.mjs is both a pure fixture and a mandated browser input: ${
    JSON.stringify([[...changedCdp.selected], [...changedCdp.browser]])
  }`,
);
assert(
  classify(["scripts/check-verdict-emission.test.mjs"]).selected.has("test-verdict-emission"),
  "the runner's fixture-name rename (check-verdict-emission -> test-verdict-emission) must hold here too",
);

// 5. FAIL-CLOSED on undeclared paths (review findings 1 and 3). Textual string-containment is a
//    HINT, never a rescue - and neither is a dependency FACT: a file with no rule escalates to the full
//    tier even when the graph knows who imports it, because "nobody has judged this file" is exactly
//    the case where the judgement must not be inferred.
assert(
  classify(["lib/html.ts"]).selected.has("test-server-escape"),
  "lib/html.ts (escapeHTML) must select the escaping/route suites by RULE",
);
const undeclared = classify(["lib/mystery.ts"]);
assert(
  undeclared.unknown.includes("lib/mystery.ts") && !undeclared.selected.has("test-mystery"),
  `a lib path with no rule must be UNKNOWN, not rescued by a textual reference: ${
    JSON.stringify([[...undeclared.selected], [...undeclared.browser]])
  }`,
);
assert(
  undeclared.hints.some((hint) =>
    hint.path === "lib/mystery.ts" &&
    hint.candidates.includes("test-mystery")
  ),
  "an unknown path still reports which fixtures mention it, so the fix is obvious",
);
assert(
  fixturesReferencing("lib/mystery.ts", sources).includes("test-mystery"),
  "fixturesReferencing must match a dynamic import",
);
assert(
  classify(["lib/nobody-reads-this.ts"]).unknown.includes("lib/nobody-reads-this.ts"),
  "an unimported lib path must be UNKNOWN (fail-closed)",
);
assert(
  classify(["random/thing.txt"]).unknown.includes("random/thing.txt"),
  "an unrecognised path must be UNKNOWN",
);

// 8. A DIRECTORY-WIDE PREFIX IS A GUESS, and both of the review's P1s were guesses that landed a path
//    on the WRONG suite. `public/` holds the stylesheet AND a JS MIME-seam probe, so the CSS rules
//    now declare exact paths only: the probe goes to the fixture that actually asserts on it, and a
//    NEW public asset is UNKNOWN (escalate) rather than silently assigned to CSS drift.
assert(
  classify(["public/styles.css"]).selected.has("test-css-drift") &&
    classify(["public/styles.css"]).browser.has(CSS_BROWSER_SUITE),
  "the shared stylesheet must still select the CSS suites and the browser tier",
);
const probe = classify(["public/probe-inert.js"]);
assert(
  probe.selected.has("test-security-headers"),
  `public/probe-inert.js must select the fixture that asserts on it: ${
    JSON.stringify([...probe.selected])
  }`,
);
assert(
  !probe.browser.has(CSS_BROWSER_SUITE),
  "a JS probe is not a CSS change; it must not drag in the 30s browser suite",
);
assert(
  classify(["public/new-thing.css"]).unknown.includes("public/new-thing.css"),
  "a NEW public asset has no declared rule: escalate rather than guess",
);

// 7. THE DEPENDENCY EXPANSION (gendn-0jsg): a declared path selects the fixtures that IMPORT it, not
//    only the ones a human listed. The rule's own list is a MINIMUM - expansion can only widen it - and
//    a browser-backed dependent pulls in its COMPOSITE suite, never the component (no double Chrome).
assert(
  classify(["server.ts"]).selected.has("test-transport-headers"),
  "the rule's own suite list must still apply",
);
const expanded = classify(["server.ts"]).selected;
assert(
  expanded.has("test-cdp"),
  `an importer the rule does not name must run: ${JSON.stringify([...expanded])}`,
);
assert(
  /imported by test-cdp/.test(expanded.get("test-cdp") ?? ""),
  `the manifest must say WHY a suite ran: ${expanded.get("test-cdp")}`,
);
const privateRoot = classify(["scripts/lib/private-root.mjs"]);
assert(
  privateRoot.browser.has("test-reference-contract"),
  `a browser-backed dependent must select its composite suite: ${
    JSON.stringify([
      ...privateRoot.browser,
    ])
  }`,
);
assert(
  !privateRoot.browser.has("test-reference-browser"),
  "a component suite must never be launched separately (the ADR forbids a second Chrome launch)",
);

// 7b. THE SUPERSET ORACLE: a consumer that never writes an import is still a consumer. A fixture that
//     reads a declared file as text, spawns it as a subprocess, or receives its path must run.
assert(
  classify(["server.ts"]).selected.has("test-surface-coverage"),
  `a fixture that only MENTIONS a declared path must still be selected: ${
    JSON.stringify([...classify(["server.ts"]).selected])
  }`,
);

// 8. Known non-code paths are explained, never silently dropped.
const docs = classify(["docs/css-drift.md"]);
assert(docs.unknown.length === 0 && docs.nonCode.length === 1, "docs/ must be known non-code");
assert(docs.nonCode[0].reason.length > 10, "a non-code path must carry a real reason");

// 7. decideTier: fast only when the change set is scoped and complete; FULL otherwise.
const fast = decideTier({
  requested: "fast",
  changed: ["public/styles.css"],
  diffAvailable: true,
  mergeCommit: false,
  unknownPaths: [],
});
assert(fast.tier === "fast", `a scoped diff must stay fast: ${JSON.stringify(fast)}`);
for (
  const [label, input] of [
    ["an unmapped path", { changed: ["lib/mystery.ts"], unknownPaths: ["lib/mystery.ts"] }],
    ["an EMPTY diff", { changed: [], unknownPaths: [] }],
    ["an unavailable baseline", { changed: ["server.ts"], unknownPaths: [], diffAvailable: false }],
    ["a merge tip", { changed: ["server.ts"], unknownPaths: [], mergeCommit: true }],
    // THE INVERTED DEFAULT (gendn-8wwm): the fast tier claims isolation, and that claim is only as good
    // as the graph behind it. No graph -> no claim -> full tier.
    ["an unbuildable dependency graph", {
      changed: ["server.ts"],
      unknownPaths: [],
      graphComplete: false,
    }],
    // ...and a proven consumer set that is no longer a scoping device (measured: only server.ts today).
    ["a selection that is half the corpus", {
      changed: ["server.ts"],
      unknownPaths: [],
      selectionBroad: true,
      selectionCount: 22,
      corpusSize: 44,
    }],
  ]
) {
  const decision = decideTier({
    requested: "fast",
    changed: ["server.ts"],
    diffAvailable: true,
    mergeCommit: false,
    unknownPaths: [],
    ...input,
  });
  assert(
    decision.tier === "full",
    `${label} must escalate to the full tier: ${JSON.stringify(decision)}`,
  );
  assert(decision.escalate.length > 0, `${label} must say WHY it escalated`);
}
assert(
  decideTier({
    requested: "full",
    changed: [],
    diffAvailable: false,
    mergeCommit: true,
    unknownPaths: ["x"],
  }).tier === "full",
  "an explicit full request is the full tier",
);

// 8. The REAL map: complete, and every name in it still exists.
const {
  pure,
  browserSuites,
  sources: realSources,
  modules: realModules,
  commands,
  suiteFiles: realSuiteFiles,
  dependents: realDependents,
  graphComplete: realGraphComplete,
  graphReason: realGraphReason,
  mapErrors: discoveryErrors,
} = await discover(
  root,
);
assert(pure.length >= 40, `expected the real fixture corpus, found ${pure.length}`);
const mapErrors = [
  ...validateMap({ pure, browserSuites, sources: realSources, commands }),
  ...discoveryErrors,
];
assert(mapErrors.length === 0, `the real changed-path map is incomplete:\n${mapErrors.join("\n")}`);
const named = new Set([
  ...RULES.flatMap((rule) => rule.suites),
  ...BROWSER_RULES.flatMap((rule) => rule.suites),
  ...PAGE_SUITES,
]);
for (const name of pure) {
  assert(
    named.has(name),
    `fixture ${name} is named by no rule - it could never run in the fast tier`,
  );
}
assert(named.has(CSS_BROWSER_SUITE), "the CSS browser suite must be reachable from the map");
assert(
  BROWSER_RULES.some((rule) => rule.suites.includes(CSS_BROWSER_SUITE) && rule.exact.length > 0),
  "the CSS browser suite needs at least one exact path that mandates it",
);

// 8b. THE REVIEWER'S INVARIANT, ON THE REAL TREE (gendn-0jsg), WITH ITS OWN WHOLE-REPO UNIVERSE
//     (gendn-8wwm). The rule table claimed scripts/lib/artifacts.mjs had three consumers when it had at
//     least six; then the FIRST version of this very check shared the implementation's "lib/ + scripts/"
//     scope, so it could not see that root-level server.ts was absent from the graph while three
//     fixtures import it. So: walk the whole repository from the ROOT with this file's own resolver (a
//     URL join), assert the production graph covers that same universe, and only then assert selection.
//     A check that looks where the code looks is a restatement, not an invariant.
async function ownWalk(dir, out = new Map()) {
  for await (const entry of Deno.readDir(dir)) {
    if ([".git", "node_modules", ".beads"].includes(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) await ownWalk(path, out);
    else if (/\.(?:ts|mjs|js|cjs)$/.test(entry.name)) {
      out.set(path.slice(root.length), await Deno.readTextFile(path));
    }
  }
  return out;
}
const ownUniverse = await ownWalk(root.replace(/\/$/, ""));
const uncovered = [...ownUniverse.keys()].filter((path) => !realModules.has(path));
assert(
  uncovered.length === 0,
  `the dependency graph must cover the whole repository, not a directory list: ${
    uncovered.slice(0, 10).join(", ")
  }`,
);
assert(
  realGraphComplete === true,
  `the real graph must be buildable, or every run escalates: ${realGraphReason}`,
);
function testImports(file, source, known) {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const found = new Set();
  const pattern = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier.startsWith(".")) continue;
    const joined = new URL(specifier, `file:///${dir}`).pathname.slice(1);
    for (const suffix of ["", ".ts", ".mjs", ".js"]) {
      if (known.has(joined + suffix)) {
        found.add(joined + suffix);
        break;
      }
    }
  }
  return found;
}
const knownModules = new Set(ownUniverse.keys());
const suiteOfFile = new Map();
for (const [name, files] of Object.entries(realSuiteFiles)) {
  for (const file of files) suiteOfFile.set(file, COMPONENT_OF.get(name) ?? name);
}
const underSelected = [];
const declaredPaths = [
  ...new Set([...RULES, ...BROWSER_RULES].flatMap((rule) => rule.exact)),
];
for (const path of declaredPaths) {
  const result = classifyPaths([path], {
    fixtures: [...pure, ...browserSuites],
    browserSuites: [...browserSuites],
    sources: realSources,
    dependents: realDependents,
  });
  for (const [file, source] of ownUniverse) {
    const suite = suiteOfFile.get(file);
    if (!suite) continue; // not a fixture: nothing to select
    if (!testImports(file, source, knownModules).has(path)) continue;
    if (!result.selected.has(suite) && !result.browser.has(suite)) {
      underSelected.push(
        `${path} is imported by ${file} (${suite}), which the map does not select`,
      );
    }
  }
}
assert(
  underSelected.length === 0,
  `a declared path must select every fixture that imports it:\n${underSelected.join("\n")}`,
);
assert(
  realDependents.get("scripts/lib/artifacts.mjs")?.includes("test-route-contract"),
  "the shared artifacts module's importer set must be derived, not hand-written (regression: gendn-0jsg)",
);
// The ROOT-LEVEL case by name, because a directory list is exactly how it was missed (gendn-8wwm).
assert(
  (realDependents.get("server.ts") ?? []).includes("test-chromestatus-units"),
  "a root-level module's importers must be in the graph, not outside a lib/+scripts/ scan",
);
assert(
  importedPaths(
    "scripts/lib/artifacts.mjs",
    // The side-effect form must be RELATIVE: `import "side.js"` is a bare package specifier, not a path.
    `import { x } from "./b.mjs";\nawait import("../lib/c.ts");\nimport "./side.js";`,
    ["scripts/lib/b.mjs", "scripts/lib/c.ts", "scripts/lib/side.js"],
  ).size === 3,
  "static, dynamic and side-effect imports must all resolve",
);
assert(
  importedPaths("scripts/lib/artifacts.mjs", `import x from "npm:zod";`, ["npm:zod"]).size === 0,
  "a bare/URL specifier is not a repo module and must be ignored",
);

// 9. Test rename / stale name: a fixture the map does not name is RED, and a rule naming a suite
//    nobody can run is RED - the two ways a map rots into a silent skip.
const renamed = validateMap({
  pure: [...pure, "test-brand-new-fixture"],
  browserSuites,
  sources: realSources,
  commands,
});
assert(
  renamed.some((error) => error.includes("test-brand-new-fixture")),
  `an unmapped new fixture must fail the map: ${renamed.join(" | ")}`,
);
const withoutOne = pure.filter((name) => name !== "test-fetch-bounded");
const stale = validateMap({ pure: withoutOne, browserSuites, sources: realSources, commands });
assert(
  stale.some((error) => error.includes("test-fetch-bounded")),
  `a rule naming a fixture that no longer exists must fail the map: ${stale.join(" | ")}`,
);

// 10. The real git read: whatever it reports, the tier decision must stay fail-closed.
const git = await changedPathsFromGit(root);
assert(
  typeof git.available === "boolean" && typeof git.mergeCommit === "boolean" &&
    Array.isArray(git.paths),
  `changedPathsFromGit shape: ${JSON.stringify(git)}`,
);
const realDecision = decideTier({
  requested: "fast",
  changed: git.paths,
  diffAvailable: git.available,
  mergeCommit: git.mergeCommit,
  unknownPaths: [],
});
if (!git.available || git.mergeCommit || git.paths.length === 0) {
  assert(
    realDecision.tier === "full",
    `an unscopable tree must run the full tier: ${JSON.stringify({ git, realDecision })}`,
  );
}

console.log(
  `gate-manifest fixture: all map assertions passed (${pure.length} fixtures, ${RULES.length} path rules, ` +
    `${BROWSER_RULES.length} browser rules)`,
);
