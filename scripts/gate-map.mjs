#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
// scripts/gate-map.mjs — the AFFECTED-PATH gate: choose what runs, and SAY WHAT DID NOT (gendn-xe6f).
//
// WHY THIS EXISTS: the full gate costs ~117s today (measured 2026-10-14 at tree 7fedc80: `check`
// 855ms + `check-routes` 780ms + `test-fixtures` 115.8s, of which the CSS real-browser suite is
// ~29s and the bounded-fetch fixture ~30s), and it ran ALL 43 fixtures for EVERY landing including
// the overwhelming majority that cannot affect them. The opposite failure is worse, and this fleet
// has produced several findings about it: a gate that silently tests LESS is not a fast gate, it is
// a green light attached to nothing. So the map is FAIL-CLOSED and every run ends with a manifest that
// names each suite that ran and each suite that did not, with the rule and reason for each.
//
// TIERS
//   gate:fast   cheap iteration. Runs FOUR always-on steps, plus only the suites the changed paths
//               select. If any changed path is unmapped, or the diff cannot be computed, it ESCALATES
//               itself to the full tier (fail-closed: an unknown change runs MORE, never less).
//   gate:full   the landing gate. Runs the four always-on steps, ALL pure fixtures, and the CSS
//               browser suite UNCONDITIONALLY (measured ~29s - the whole reason for the split, and at
//               that price a landing verdict must have driven a browser). Any further browser suite
//               the map selects is run too.
//
// WHAT EVEN THE FULL TIER DOES NOT RUN, named here because that is the point: `deno task
// test-reference-contract` (the browser-backed reference-contract/reference-browser suite) is a
// dedicated CI step and has never been part of the fleet's landing gate. It is not silently
// discarded - the manifest prints it under NOT RUN with its reason, and CI runs it on every PR.
//
// NOT THE ROUTE/CONFORMANCE GATES: a touched LEAF PAGE needs page-specific evidence, which a fixed
// CSS sample never gave; page changes therefore select the page-artifact fixtures and are always
// subject to check-routes/validate-artifacts/check-conformance in both tiers.

import {
  discoverFixtures,
  fixtureCommand,
  fixturePermissions,
  scanForTokenViaPs,
  SWEEP_BUDGET_MS,
  SWEEP_MAX_PIDS,
  SWEEP_TOKEN,
  sweepByToken,
  sweepReport,
} from "./run-fixtures.mjs";
import { runGit } from "./lib/bounded-git.mjs";

/**
 * Steps that run in BOTH tiers. Every one of these is a value/identity ratchet that a change of any
 * shape could break, so they are not subject to path selection.
 *   check            typecheck + fmt --check + citation links + touched-page surface coverage
 *   check-routes     route/identity/binding regression gate (durable demo contract)
 *   validate-artifacts  lifecycle artifact schema + suiteHash + reference mappings
 *   check-conformance   touched-page conformance + implementation sufficiency
 */
export const ALWAYS = [
  {
    id: "check",
    command: ["deno", "task", "check"],
    reason:
      "typecheck + format + citation/coverage ratchets; a change of any shape can break these",
  },
  {
    id: "check-routes",
    command: ["deno", "task", "check-routes"],
    reason: "published route/identity/binding regression gate",
  },
  {
    id: "validate-artifacts",
    command: ["deno", "task", "validate-artifacts"],
    reason: "lifecycle artifact schema + suiteHash + reference-mapping ratchet",
  },
  {
    id: "check-conformance",
    command: ["deno", "task", "check-conformance"],
    reason:
      "touched-page conformance + implementation sufficiency (Chrome only for touched contracts)",
  },
];

/** The whole deterministic fixture tier; only the full gate runs all of it. */
export const ALL_FIXTURES_STEP = {
  id: "all-fixtures",
  command: ["deno", "task", "test-fixtures"],
};

/** The CSS real-browser suite. Unconditional in the full tier; map-selected in the fast tier. */
export const CSS_BROWSER_SUITE = "test-css-drift-browser";

/** Fixture names that are COMPONENTS of a composite suite. `test-reference-browser` is executed
 * inside `deno task test-reference-contract`; selecting it separately would launch the same Chrome
 * coverage twice in one merged union, which gendn-xe6f explicitly forbids. So it is not a suite the
 * map can select - it is named here so the NOT-RUN line can still account for it. */
export const COMPONENT_OF = new Map([["test-reference-browser", "test-reference-contract"]]);

/** Browser-backed suites and the paths that make them MANDATORY. */
export const BROWSER_RULES = [
  {
    id: "css-drift-browser",
    suites: [CSS_BROWSER_SUITE],
    exact: [
      "scripts/css-drift.mjs",
      "scripts/lib/css-drift.mjs",
      "scripts/css-drift.test.mjs",
      "scripts/css-drift-browser.test.mjs",
      "scripts/css-drift-startup.test.mjs",
      "scripts/lib/private-root.mjs",
      "scripts/lib/cdp.mjs",
      "scripts/lib/reference-browser.mjs",
      "public/styles.css",
    ],
    prefixes: [],
    reason:
      "computed-style capture, its disposable served tree, the browser-capture helpers or the shared stylesheet",
  },
  {
    id: "reference-contract-browser",
    suites: ["test-reference-contract"],
    exact: [
      "scripts/reference-browser.test.mjs",
      "scripts/lib/reference-contract.mjs",
      "scripts/cdp.test.mjs",
      "scripts/lib/reference-browser.mjs",
    ],
    prefixes: [],
    reason: "the reference-contract browser visibility suite is the only thing that covers these",
  },
];

/** Changed path -> the suites that cover it. Exact paths and directory prefixes only: no glob
 * engine, because a matcher bug here silently unmaps a path, which is the failure this file exists
 * to prevent. A path that matches nothing is UNKNOWN and escalates the fast tier to the full tier.
 *
 * COMPLETENESS IS ENFORCED, NOT ASSUMED (scripts/gate-manifest.test.mjs): every discovered fixture
 * must be named by a rule here or by PAGE_SUITES, so adding a fixture without mapping it is a RED
 * test rather than a suite that can silently never run in the fast tier. A path that is not listed
 * (a new lib file, a nested member reference) still gets a textual reference scan before it is
 * declared unknown. */
export const RULES = [
  {
    id: "css-drift",
    exact: [
      "scripts/css-drift.mjs",
      "scripts/lib/css-drift.mjs",
      "scripts/css-drift.test.mjs",
      "scripts/css-drift-startup.test.mjs",
      "public/styles.css",
    ],
    // NO `prefixes: ["public/"]`: `public/` holds a JS probe as well as the stylesheet, and a
    // directory-wide prefix is a GUESS - it mapped public/probe-inert.js to the CSS suites while
    // skipping test-security-headers, the fixture that actually asserts on it (review round 2, P1).
    // A guess that lands a path on an UNRELATED suite is the same failure as one that rescues an
    // unmapped path. A new public asset is now UNKNOWN and escalates to the full tier: loud, safe.
    prefixes: [],
    suites: ["test-css-drift", "test-css-drift-startup"],
    reason: "CSS-drift selection/comparison logic and the shared stylesheet it samples",
  },
  {
    id: "public-probe",
    exact: ["public/probe-inert.js"],
    prefixes: [],
    suites: ["test-security-headers"],
    reason:
      "the committed MIME-seam probe; test-security-headers asserts text/plain + nosniff on it",
  },
  {
    id: "capture-helpers",
    exact: ["scripts/lib/cdp.mjs"],
    prefixes: [],
    suites: ["test-cdp", "test-cdp-owned-port"],
    reason: "the CDP launch/port/profile helpers every browser suite drives",
  },
  {
    id: "reference-contract",
    exact: ["scripts/lib/reference-contract.mjs"],
    prefixes: [],
    suites: ["test-reference-contract-order", "test-citation-canonical", "test-surface-coverage"],
    reason: "the source-derived contract surface and its citation rules",
  },
  {
    id: "reference-browser",
    exact: ["scripts/lib/reference-browser.mjs"],
    prefixes: [],
    suites: ["test-reference-browser-startup"],
    reason: "the served-root startup contract of the reference visibility pass",
  },
  {
    id: "server",
    exact: ["server.ts", "scripts/lib/security-probe.mjs"],
    prefixes: [],
    suites: [
      "test-transport-headers",
      "test-security-headers",
      "test-vary-merge",
      "test-server-escape",
      "test-route-contract",
      "test-speculation-rules",
    ],
    reason: "server.ts routing/header behaviour is driven end-to-end by these fixtures",
  },
  {
    id: "conformance-runner",
    exact: ["scripts/conformance.mjs", "scripts/check-verdict-emission.mjs"],
    prefixes: [],
    suites: ["test-conformance-http-status", "test-conformance-startup", "test-verdict-emission"],
    reason: "the conformance/responsive runner and its verdict-emission contract",
  },
  {
    id: "check-conformance",
    exact: ["scripts/check-conformance.mjs"],
    prefixes: [],
    suites: ["test-check-conformance", "test-conformance-report"],
    reason: "the touched-page conformance/sufficiency gate",
  },
  {
    id: "artifacts",
    exact: ["scripts/lib/artifacts.mjs"],
    prefixes: [],
    suites: ["test-artifacts-units", "test-suite-metadata", "test-support-record"],
    reason: "lifecycle artifact loading/validation shared by the page gates",
  },
  {
    id: "cps-conformance",
    exact: ["scripts/lib/cps-conformance.mjs", "scripts/gen-conformance.mjs"],
    prefixes: [],
    suites: ["test-cps-conformance", "test-gen-conformance"],
    reason: "chrome-platform-showcase conformance pointers and the generator that writes them",
  },
  {
    id: "iframe-posture",
    exact: ["scripts/lib/iframe-posture.mjs", "scripts/iframe-posture-sweep.mjs"],
    prefixes: [],
    suites: ["test-iframe-posture", "test-iframe-posture-sweep"],
    reason: "third-party iframe hardening and its sweep",
  },
  {
    id: "escape",
    exact: ["lib/html.ts"],
    prefixes: [],
    suites: ["test-server-escape", "test-external-url", "test-route-contract"],
    reason: "escapeHTML sanitises every interpolated string server-side (the XSS surface)",
  },
  {
    id: "upstream",
    exact: ["lib/chromestatus.ts"],
    prefixes: [],
    suites: [
      "test-fetch-bounded",
      "test-chromestatus-units",
      "test-upstream-group-shape",
      "test-upstream-summary-narrow",
    ],
    reason: "the bounded upstream fetch and the chromestatus payload shaping",
  },
  {
    id: "mdn",
    exact: ["lib/mdn.ts"],
    prefixes: [],
    suites: ["test-mdn-has"],
    reason: "the MDN redirect/stub decision",
  },
  {
    id: "external-url",
    exact: ["lib/external-url.ts"],
    prefixes: [],
    suites: ["test-external-url"],
    reason: "external-link classification",
  },
  {
    id: "lifecycle",
    exact: ["lib/lifecycle.ts"],
    prefixes: [],
    suites: ["test-lifecycle-units"],
    reason: "the critique/conformance lifecycle renderer",
  },
  {
    id: "corpus-path",
    exact: ["scripts/lib/plain-corpus-path.mjs"],
    prefixes: [],
    suites: ["test-citation-links", "test-surface-coverage"],
    reason: "plain-corpus path resolution used by the citation/coverage ratchets",
  },
  {
    id: "judged-content",
    exact: ["scripts/lib/judged-content.mjs"],
    prefixes: [],
    suites: ["test-route-contract"],
    reason: "judged-content extraction used by the route contract",
  },
  {
    id: "bindings",
    exact: [
      "route-bindings.json",
      "scripts/lib/binding-ledger.mjs",
      "scripts/refresh-bindings.mjs",
    ],
    prefixes: [],
    suites: ["test-binding-ledger", "test-refresh-bindings"],
    reason: "the committed route-binding ledger and the tool that regenerates it",
  },
  {
    id: "migrations",
    exact: ["migrations.json", ".route-manifest.baseline.json"],
    prefixes: [],
    suites: ["test-route-contract"],
    reason: "route migrations and the offline manifest baseline",
  },
  {
    id: "runner",
    exact: ["scripts/run-fixtures.mjs", "deno.json"],
    prefixes: [],
    suites: ["test-run-fixtures", "test-fast-typecheck"],
    reason: "the fixture runner and its task wiring",
  },
  {
    id: "gate",
    exact: ["scripts/gate-map.mjs"],
    prefixes: [],
    suites: ["test-gate-manifest", "test-run-fixtures"],
    reason: "this map and the tier manifest it prints",
  },
  {
    id: "mirror",
    exact: ["scripts/vendor-fonts.mjs"],
    prefixes: [],
    suites: ["test-vendor-fonts"],
    reason: "font mirroring",
  },
  {
    id: "fix-slugs",
    exact: [".claude/fix-slugs.py"],
    prefixes: [],
    suites: ["test-fix-slugs"],
    reason: "the destructive slug-repair tool",
  },
  {
    id: "threat-model",
    exact: ["THREAT_MODEL.md"],
    prefixes: [],
    suites: ["test-threat-model-citations"],
    reason: "the threat model's citation-resolution guard (executable prose)",
  },
];

/** Paths that are KNOWN to need no suite, each with the reason a reader can check. A path that is
 * neither here, nor matched by a rule, nor reference-scanned is UNKNOWN (see the fail-closed rule). */
export const NON_CODE = [
  { prefixes: ["docs/"], reason: "prose documentation; nothing executes it" },
  { prefixes: ["reports/"], reason: "generated evidence output, consumed by the conformance gate" },
  {
    prefixes: ["_data/"],
    reason: "fetched upstream data; its consumer lib/chromestatus.ts is mapped",
  },
  {
    prefixes: ["schema/"],
    reason: "JSON schemas; validate-artifacts evaluates them in both tiers",
  },
  { prefixes: [".github/"], reason: "CI wiring; CI runs the suites a change here would gate" },
  { prefixes: [".beads/"], reason: "task ledger" },
  { prefixes: [".claude/"], reason: "agent prompts and tooling config; no fixture executes them" },
  {
    exact: [
      "README.md",
      "CLAUDE.md",
      "AGENTS.md",
      "LICENSE",
      "goals.json",
      "responsive-support.json",
    ],
    reason: "prose or report metadata, not executable",
  },
];

const PAGE_PREFIX = /^v\d+\//;
/** Fixtures that describe published pages and their lifecycle artifacts. A touched leaf page keeps
 * these AND the always-on route/conformance ratchets; a fixed CSS sample never proved a leaf. */
export const PAGE_SUITES = [
  "test-artifacts-units",
  "test-suite-metadata",
  "test-support-record",
  "test-lifecycle-units",
  "test-surface-coverage",
  "test-citation-links",
  "test-citation-canonical",
  "test-conformance-report",
  "test-conformance-http-status",
  "test-conformance-startup",
  "test-example-adjacency",
  "test-iframe-posture",
  "test-source-disagreement",
];

/** The basename/relative form of a path as it appears in an import or a readTextFile call. */
function referenceKeys(path) {
  const keys = new Set([path]);
  const parts = path.split("/");
  if (parts.length > 1) keys.add(parts.slice(-1)[0]);
  if (parts.length > 2) keys.add(parts.slice(-2).join("/"));
  return [...keys];
}

/** Every fixture whose source text mentions this path (static OR dynamic - both are written
 * literally, and a textual scan is what catches `await import("../server.ts")`). */
export function fixturesReferencing(path, fixtureSources) {
  const keys = referenceKeys(path);
  const found = [];
  for (const [name, source] of Object.entries(fixtureSources)) {
    if (keys.some((key) => source.includes(key))) found.push(name);
  }
  return found.sort();
}

const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g, // import x from "...", export { x } from "..."
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // await import("...")
  /\bimport\s*["']([^"']+)["']/g, // side-effect import "..."
];

/** Collapse `.` and `..` in a repo-relative path. */
function normalizePath(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/**
 * The modules a source file REALLY imports, resolved against the known module set.
 *
 * This is the difference between a dependency fact and a hunch, and both review rounds turned on it. A
 * substring scan (the first draft, and what `fixturesReferencing` still does for HINTS) drags in every
 * file that merely MENTIONS a path - test-threat-model-citations quotes "lib/html.ts" in a citation and
 * would count as a consumer of the XSS escaper - and it chains those mentions through hubs, so one lib
 * change selected 28-32 of 44 fixtures. That is why only import syntax counts here, why a non-relative
 * specifier (a package or a URL) is skipped, and why an extensionless "./lib/x" is resolved against the
 * known set instead of assumed. It can still only ever WIDEN the selection; what it cannot do is invent
 * a dependency from prose.
 */
export function importedPaths(path, source, knownPaths) {
  const known = new Set(knownPaths);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
      const candidate = normalizePath(`${dir}${specifier}`);
      for (const suffix of ["", ".ts", ".mjs", ".js", "/index.ts", "/index.mjs"]) {
        if (known.has(candidate + suffix)) {
          found.add(candidate + suffix);
          break;
        }
      }
    }
  }
  return found;
}

/**
 * WHICH FIXTURES DEPEND ON WHICH FILE - the fact the rule table was missing (gendn-0jsg).
 *
 * A hand-written `suites: [...]` list is a claim about a file's consumers, and the review measured it
 * being WRONG: scripts/lib/artifacts.mjs has six importers and the rule named three, so the gate printed
 * "unaffected" for route-contract/check-conformance/conformance-report while they imported the very file
 * that had changed. That is the fast tier quietly testing less, which is the failure this whole map
 * exists to prevent. So the dependency is now DERIVED, not guessed: for every fixture, the transitive
 * closure of paths it references (a fixture importing a module that re-exports another depends on both),
 * inverted into path -> fixtures. The rule's own list stays as a declared minimum; this can only ADD.
 */
export function buildDependents({ modules, fixtures }) {
  const known = [...modules.keys()];
  const refs = new Map();
  for (const [path, source] of modules) refs.set(path, importedPaths(path, source, known));
  const dependents = new Map();
  for (const [suite, file] of fixtures) {
    const seen = new Set([file]);
    const queue = [file];
    while (queue.length) {
      const current = queue.shift();
      for (const ref of refs.get(current) ?? []) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        queue.push(ref);
        if (!dependents.has(ref)) dependents.set(ref, []);
        dependents.get(ref).push(suite);
      }
    }
  }
  return dependents;
}

/**
 * Classify changed paths into the suites they select. Pure: no git, no filesystem - the caller
 * supplies the discovered fixture names and their sources, so this is directly unit-testable.
 * Returns { selected, browser, matched, nonCode, unknown, hints }. `unknown` is the fail-closed
 * signal.
 *
 * TWO RULES THAT A REVIEW HAD TO TEACH ME (gendn-xe6f, review findings 1-3):
 *  1. A path is either DECLARED (a rule, a page, a changed test file, or an explained non-code path)
 *     or it is UNKNOWN. Textual string-containment is NOT a declaration: `lib/html.ts` matched
 *     `test-threat-model-citations` merely because that fixture quotes the filename in a citation,
 *     and the XSS-escaping suite was skipped on a fast PASS. The reference scan is now only a HINT
 *     attached to an unknown path ("add a rule, these fixtures mention it"), never a rescue.
 *  2. Nothing EXITS EARLY. A changed test file must add its own suite AND still be evaluated against
 *     the rules, because `scripts/css-drift.test.mjs` is also listed in the CSS browser rule - an
 *     early `continue` silently dropped the mandatory browser suite for its own fixture.
 */
export function classifyPaths(
  paths,
  { fixtures, browserSuites = [], sources, dependents = new Map() },
) {
  const selected = new Map(); // fixture name -> why
  const browser = new Map(); // browser suite name -> why
  const matched = [];
  const nonCode = [];
  const unknown = [];
  const hints = [];
  const browserSet = new Set(browserSuites);
  const add = (map, name, why) => {
    if (!map.has(name)) map.set(name, why);
  };
  for (const path of [...paths].sort()) {
    // The file's OWN suite, if the file is a fixture. run-fixtures.mjs renames one fixture on
    // purpose (check-verdict-emission.test.mjs is `test-verdict-emission`, see discoverFixtures),
    // so the name is derived by the SAME rule the runner uses and then looked up in the discovered
    // list rather than assumed from the filename.
    const stem = path.match(/^scripts\/([a-z0-9-]+)\.test\.mjs$/)?.[1];
    const ownCandidate = stem
      ? (stem === "check-verdict-emission" ? "test-verdict-emission" : `test-${stem}`)
      : undefined;
    const ownName = ownCandidate && fixtures.includes(ownCandidate) ? ownCandidate : undefined;
    const rules = RULES.filter((rule) => matches(rule, path));
    const browserRules = BROWSER_RULES.filter((rule) => matches(rule, path));
    const pageSuites = PAGE_PREFIX.test(path) ? PAGE_SUITES : [];
    const exempt = NON_CODE.find((entry) => matches(entry, path) && entry.reason);
    const declared = Boolean(
      ownName || rules.length || browserRules.length || pageSuites.length || exempt,
    );
    if (!declared) {
      unknown.push(path);
      const candidates = [...(dependents.get(path) ?? [])].sort().concat(
        fixturesReferencing(path, sources),
      );
      if (candidates.length) hints.push({ path, candidates: [...new Set(candidates)] });
      continue;
    }
    if (ownName) {
      if (browserSet.has(ownName)) add(browser, ownName, `${path} (changed test file)`);
      else add(selected, ownName, `${path} (changed test file)`);
    }
    for (const rule of browserRules) {
      for (const suite of rule.suites) add(browser, suite, `${path} via rule "${rule.id}"`);
    }
    for (const rule of rules) {
      for (const suite of rule.suites) add(selected, suite, `${path} via rule "${rule.id}"`);
    }
    for (const suite of pageSuites) add(selected, suite, `${path} (published page/artifact)`);
    // THE DEPENDENCY EXPANSION (gendn-0jsg): every fixture that imports this file - transitively - runs,
    // whatever the rule's own list says. This can only widen the selection, and a browser-backed
    // dependent is handled through the same COMPONENT_OF redirection as a rule suite would be, so a
    // fixture that is a component of a composite suite pulls in the composite instead of double-launching.
    //
    // PLUS THE SUPERSET ORACLE (gendn-8wwm): a consumer that never writes an `import` - a fixture that
    // spawns `deno run scripts/foo.mjs`, reads the file as TEXT to assert a source invariant, or hands
    // its path to a server - is invisible to an import-only relation. test-chromestatus-units is exactly
    // that shape for server.ts (it sweeps server.ts and lib/ for a construction site). A textual mention
    // in a FIXTURE (one hop, never chained) is treated as evidence of a consumer, so it selects them too.
    // Missed consumers are how a fast gate lies; an extra fixture only costs time.
    const imported = [...(dependents.get(path) ?? [])].sort();
    const referencing = [...fixturesReferencing(path, sources)].sort()
      .filter((name) => !imported.includes(name));
    for (const name of [...imported, ...referencing]) {
      const selectable = COMPONENT_OF.get(name) ?? name;
      if (selectable === ownName) continue;
      const why = `${path} (${imported.includes(name) ? "imported" : "referenced"} by ${name})`;
      if (browserSet.has(selectable)) add(browser, selectable, why);
      else add(selected, selectable, why);
    }
    if (!ownName && !rules.length && !browserRules.length && !pageSuites.length && exempt) {
      nonCode.push({ path, reason: exempt.reason });
      continue;
    }
    matched.push({
      path,
      rule: rules.map((rule) => rule.id).concat(browserRules.map((rule) => rule.id)).join("+") ||
        (pageSuites.length ? "published-page" : "changed-test-file"),
      suites: [
        ...new Set([
          ...(ownName ? [ownName] : []),
          ...rules.flatMap((rule) => rule.suites),
          ...browserRules.flatMap((rule) => rule.suites),
          ...pageSuites,
          ...imported.map((name) => COMPONENT_OF.get(name) ?? name),
          ...referencing.map((name) => COMPONENT_OF.get(name) ?? name),
        ]),
      ],
    });
  }
  return { selected, browser, matched, nonCode, unknown, hints };
}

function matches(rule, path) {
  if ((rule.exact ?? []).includes(path)) return true;
  return (rule.prefixes ?? []).some((prefix) => path.startsWith(prefix));
}

/**
 * The tier decision. Fail-closed in one direction only: anything the map cannot explain runs the
 * FULL tier. Never "nothing".
 */
/**
 * When the PROVEN consumer set is this large a share of the corpus, the change is not local and the
 * fast tier stops being a scoping device: the remaining fixtures are a small fraction of the run, and
 * the full tier is STRICTLY wider. Measured on 2026-10-14 over all 41 declared paths: median 4 of the
 * 44 pure fixtures, only 4 paths above 30%, and exactly ONE at or above this line - server.ts, the
 * root module the whole site's fixtures drive (22 importers/referencers). Escalating it costs the rest
 * of the fixture tier; selecting it costs whatever it MISSED, and three review rounds found misses
 * clustered on exactly the central files. The number is printed, so nobody has to guess which rule ran.
 */
export const SELECTION_ESCALATION_FRACTION = 0.5;

/** Is the selection so broad that running everything is the honest, cheaper answer? */
export function selectionIsBroad({ selected, browser, pure }) {
  const total = selected + browser;
  return total >= Math.ceil(pure * SELECTION_ESCALATION_FRACTION);
}

export function decideTier(
  {
    requested,
    changed,
    diffAvailable,
    mergeCommit,
    unknownPaths,
    graphComplete = true,
    selectionBroad,
    selectionCount,
    corpusSize,
  },
) {
  const escalate = [];
  if (requested === "full") return { tier: "full", escalate: [], reason: "requested" };
  if (!diffAvailable) {
    escalate.push("the changed-path diff could not be computed (no origin/main baseline)");
  }
  if (mergeCommit) {
    escalate.push("HEAD is a merge commit: a merge/squash union cannot be scoped by path");
  }
  if (changed.length === 0) {
    escalate.push(
      "the diff is EMPTY: an empty change set cannot be scoped, so it is not treated as 'nothing to run'",
    );
  }
  if (unknownPaths.length) {
    escalate.push(`unmapped path(s): ${unknownPaths.join(", ")}`);
  }
  if (!graphComplete) {
    // THE INVERTED DEFAULT (gendn-8wwm). The fast tier claims ISOLATION: that nothing outside the
    // selected set can be affected by the change. That claim rests entirely on the dependency graph
    // being complete, so an unbuildable graph is not a smaller gate - it is a claim with no basis, and
    // it escalates. Three review rounds found the graph's completeness assumption wrong in three
    // different places; this is the one place that survives the next one.
    escalate.push(
      "the dependency graph is NOT complete, so no path can be proven isolated from its consumers",
    );
  }
  if (selectionBroad) {
    escalate.push(
      `the proven consumer set is ${selectionCount} of ${corpusSize} fixtures - this change is not ` +
        `local, so the full tier is the honest gate (see SELECTION_ESCALATION_FRACTION)`,
    );
  }
  return escalate.length
    ? { tier: "full", escalate, reason: escalate.join("; ") }
    : { tier: "fast", escalate: [], reason: "scoped by changed paths" };
}

/** Changed paths against origin/main, including staged, unstaged and untracked files. Returns
 * { available, mergeCommit, paths }. `available: false` is the fail-closed signal. */
export async function changedPathsFromGit(root) {
  const run = async (args) => {
    const result = await runGit(args, { cwd: root, stdout: "piped", stderr: "piped" });
    return result.code === 0 ? result.stdout : null;
  };
  if (!(await run(["rev-parse", "--verify", "--quiet", "origin/main"]))) {
    return { available: false, mergeCommit: false, paths: [] };
  }
  const parents = await run(["rev-list", "--parents", "-n", "1", "HEAD"]);
  if (parents === null) return { available: false, mergeCommit: false, paths: [] };
  // "sha parent..." - more than one parent is a merge.
  const mergeCommit = parents.trim().split(/\s+/).length > 2;
  const base = await run(["merge-base", "origin/main", "HEAD"]);
  if (base === null || !base.trim()) return { available: false, mergeCommit, paths: [] };
  const tracked = await run([
    "diff",
    "--name-only",
    "--diff-filter=ACMRTD",
    "-z",
    base.trim(),
    "--",
  ]);
  const untracked = await run(["ls-files", "--others", "--exclude-standard", "-z", "--"]);
  if (tracked === null || untracked === null) {
    return { available: false, mergeCommit, paths: [] };
  }
  const split = (value) => value.split("\0").filter(Boolean);
  return {
    available: true,
    mergeCommit,
    paths: [...new Set([...split(tracked), ...split(untracked)])].sort(),
  };
}

export async function discover(root) {
  const denoJson = JSON.parse(await Deno.readTextFile(`${root}deno.json`));
  const files = [];
  for await (const entry of Deno.readDir(`${root}scripts`)) {
    if (entry.isFile && entry.name.endsWith(".test.mjs")) files.push(entry.name);
  }
  const discovered = discoverFixtures(files, denoJson.tasks ?? {});
  const browserSuites = new Set(BROWSER_RULES.flatMap((rule) => rule.suites));
  const pure = [...discovered.keys()].filter((name) =>
    !browserSuites.has(name) && !COMPONENT_OF.has(name) && name !== "test-fixtures"
  );
  const sources = {};
  // THE DEPENDENCY FACTS, AND THE PROOF THAT THEY ARE COMPLETE (gendn-0jsg, gendn-8wwm).
  //
  // Three review rounds found the same defect in three shapes: a filename substring rescued a
  // rule-free path; fixtures that IMPORT a changed lib file were called "unaffected"; importers of a
  // ROOT-LEVEL module (server.ts) were invisible. Each round the graph only missed the shape the
  // reviewer happened to test, because the universe was a hand-written directory list ("lib",
  // "scripts") - enumerating dependents cannot be trusted when the enumeration itself has holes.
  //
  // So the universe is no longer a directory list: it is EVERY TRACKED SOURCE FILE, straight from
  // git, which cannot silently omit a directory - a new root module or a new top-level directory is
  // in it the moment it is committed. And if git cannot answer, the graph is NOT complete, which is
  // now a first-class state (graphComplete=false) that escalates instead of pretending to isolate.
  const modules = new Map();
  let graphComplete = true;
  let graphReason = "";
  try {
    const listed = await runGit(["ls-files", "-z", "--", "*.ts", "*.mjs", "*.js", "*.cjs"], {
      stdout: "piped",
      stderr: "piped",
      cwd: root,
    });
    if (listed.code !== 0) throw new Error(`git ls-files exited ${listed.code}: ${listed.stderr}`);
    const paths = listed.stdout.split("\0").filter((path) => path.length > 0);
    if (paths.length === 0) {
      graphComplete = false;
      graphReason = "git ls-files returned no source files";
    }
    for (const relative of paths) {
      modules.set(relative, await Deno.readTextFile(`${root}${relative}`));
    }
  } catch (error) {
    // "Could not look" is never "looked and found nothing": an unbuildable graph cannot prove
    // isolation, so the run escalates rather than selecting from a partial universe.
    graphComplete = false;
    graphReason = `the dependency graph could not be built: ${error}`;
  }
  // Commands come from the RUNNER's own helpers, never from a hand-written list: most fixtures have
  // no deno.json task at all (that is the runner's premise), so `deno task test-fetch-bounded` would
  // fail outright. fixtureCommand/fixturePermissions are exactly what run-fixtures.mjs executes,
  // including the retained composite tasks and test-mdn-has's prepended typecheck.
  const commands = {};
  const mapErrors = [];
  // A rule that names a path which does not exist is a SILENT UNMATCH: the file it was meant to cover
  // falls through to UNKNOWN (or worse, to nothing) and the reviewer's finding 4 stays invisible. So
  // every exact path is checked against the tree, and a stale one makes the gate refuse to run.
  for (const rule of [...RULES, ...BROWSER_RULES]) {
    for (const path of rule.exact) {
      if (!(await pathExists(`${root}${path}`))) {
        mapErrors.push(`rule "${rule.id}" names a path that does not exist: ${path}`);
      }
    }
  }
  for (const [name, file] of discovered) {
    if (!file) {
      commands[name] = fixtureCommand(name, file, null);
      continue;
    }
    const source = await Deno.readTextFile(`${root}${file}`);
    try {
      commands[name] = fixtureCommand(name, file, fixturePermissions(source, file));
    } catch (error) {
      mapErrors.push(`${name}: ${error.message}`);
    }
    if (!COMPONENT_OF.has(name) && name !== "test-fixtures") sources[name] = source;
  }
  // fleet-check's coverage reader matches CHANGED FILES against the tokens on the marker line, and a
  // token with NO file extension can only ever match a Python candidate (remote/check-coverage.py:
  // `if not s_ext and c_ext != ".py": continue`). Emitting task names (`test-css-drift`) therefore
  // made every changed fixture look unexercised and every mapped suite look omitted - measured at
  // tree 34d59c8: "10 unmapped changed file(s)" while all 9 of those suites had in fact run. So the
  // machine line carries the FILE each executed suite runs; a retained composite task names its files
  // in its own deno.json command, and a bare fixture IS its file.
  const suiteFiles = {};
  for (const name of discovered.keys()) {
    const task = denoJson.tasks?.[name];
    const taskCommand = typeof task === "string" ? task : task?.command ?? "";
    const fromTask = `${commands[name] ?? ""} ${taskCommand}`.match(/[\w./-]+\.test\.mjs/g) ?? [];
    suiteFiles[name] = [
      ...new Set(fromTask.map((path) => path.replace(/^\.\//, ""))),
    ];
    const file = discovered.get(name);
    if (file && !suiteFiles[name].includes(file)) suiteFiles[name].unshift(file);
  }
  const dependents = buildDependents({
    modules,
    fixtures: new Map(
      [...discovered].filter(([, file]) => file).map(([name, file]) => [name, file]),
    ),
  });
  return {
    discovered: [...discovered.keys()],
    pure,
    browserSuites,
    sources,
    modules,
    commands,
    suiteFiles,
    dependents,
    graphComplete,
    graphReason,
    mapErrors,
  };
}

/** Every .ts/.mjs/.js file under a directory, recursively - kept for callers that need a plain walk.
 * The GATE's dependency universe does NOT use this any more (gendn-8wwm): it uses git ls-files, so a
 * directory nobody thought to list cannot become a blind spot. */
async function* walkSources(dir) {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkSources(path);
    else if (entry.isFile && /\.(?:ts|mjs|js)$/.test(entry.name)) yield path;
  }
}

/** Refuse a map that names a suite nobody can run, or a fixture no rule can ever select: those are
 * the two ways a map turns into a silent skip. */
export function validateMap({ pure, browserSuites, sources, commands }) {
  const known = new Set([...pure, ...browserSuites]);
  const errors = [];
  for (const name of [...RULES.flatMap((rule) => rule.suites), ...PAGE_SUITES]) {
    if (!known.has(name)) errors.push(`rule names an unknown suite: ${name}`);
  }
  for (const name of known) {
    if (!commands?.[name]) errors.push(`no runnable command for suite: ${name}`);
  }
  const reachable = new Set([
    ...RULES.flatMap((rule) => rule.suites),
    ...BROWSER_RULES.flatMap((rule) => rule.suites),
    ...PAGE_SUITES,
  ]);
  for (const name of pure) {
    if (reachable.has(name)) continue;
    errors.push(`fixture is unreachable from the map (no rule selects it): ${name}`);
  }
  if (!sources[CSS_BROWSER_SUITE]) errors.push(`missing source for ${CSS_BROWSER_SUITE}`);
  return errors;
}

async function pathExists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return false;
  }
}

/** How long a step's process GROUP gets to settle after the group kill before we report and move on. */
const STEP_KILL_GRACE_MS = 10_000;

/**
 * Run one step under a hard bound.
 *
 * A TIMEOUT MUST RECLAIM THE STEP'S DESCENDANTS (gendn-j3ug). Every suite command is `sh -c`, and most
 * are compound (`deno check lib/mdn.ts && deno run ...`), so sh does NOT exec-replace itself: killing sh
 * alone leaves the deno process - and any Chrome it launched via --allow-run - running and still holding
 * the served port that the NEXT browser step is about to use. So the step is spawned under `setsid`,
 * which makes it a process-group leader, and on timeout the whole group is killed. A descendant that
 * detached from the group again with its own setsid is then reclaimed by the runner's env-token sweep
 * (the same mechanism, the same cap and the same reporting as run-fixtures.mjs - not a third one).
 * The sweep scans via `ps eww`, NOT /proc: Deno denies procfs reads without --allow-all, which these
 * gate tasks deliberately do not have, so a /proc scan here would be a silent no-op in every real gate
 * run (the trap scripts/lib/cdp.mjs already documents). The sweep is REPORTED even when it finds
 * nothing: "we looked and found none" is what makes a later leak attributable, and a sweep that could
 * not run is reported as UNKNOWN rather than as zero.
 */
export async function runStep(step, timeoutMs) {
  const started = Date.now();
  // A UNIQUE process marker for this step's descendants, so a timed-out step can be reclaimed by the
  // runner's env-token sweep. Deliberately NOT fixtureEnvironment(): that also sets the runner's
  // recursion marker (GENDN_FIXTURE_RUN), which asserts "we are already inside a fixture run" - and
  // `deno task test-fixtures` then REFUSES to run by its own aggregate guard, which is how the first
  // version of this wiring broke the FULL tier while every fast-tier run stayed green (a tier that
  // never runs all-fixtures cannot see it). The gate is not a fixture; it needs a token to sweep by.
  const token = `${Deno.pid}-gate-${step.id}-${Date.now().toString(36)}`;
  const childEnv = { ...Deno.env.toObject(), [SWEEP_TOKEN]: token };
  const child = new Deno.Command("setsid", {
    args: step.command,
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv,
  }).spawn();
  const pid = child.pid;
  const outcome = await Promise.race([
    child.status.then((status) => ({ status })),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeoutMs)),
  ]);
  if (!outcome.timeout) {
    return { id: step.id, code: outcome.status.code, ms: Date.now() - started, timeout: false };
  }
  // `--` is REQUIRED: GNU kill parses a bare `-<pgid>` as a signal NUMBER, so `kill -KILL -12345`
  // fails silently (measured in run-fixtures.mjs as orphans plus a 10s grace wait).
  try {
    new Deno.Command("kill", { args: ["-KILL", "--", `-${pid}`] }).outputSync();
  } catch (error) {
    console.error(`gate step ${step.id}: group kill of -${pid} failed: ${error}`);
  }
  const settled = await Promise.race([
    child.status.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), STEP_KILL_GRACE_MS)),
  ]);
  if (!settled) {
    console.error(
      `gate step ${step.id}: the process group did not exit within ${STEP_KILL_GRACE_MS}ms`,
    );
  }
  let sweepLine;
  try {
    const sweep = await sweepByToken(token, {
      maxPids: SWEEP_MAX_PIDS,
      budgetMs: SWEEP_BUDGET_MS,
      scan: scanForTokenViaPs,
    });
    sweepLine = sweepReport(step.id, sweep);
  } catch (error) {
    // "Could not look" is never "looked and found none".
    sweepLine = {
      kind: "UNKNOWN",
      line: `gate step ${step.id}: timeout sweep FAILED (${error}); survivors UNKNOWN`,
    };
  }
  console.error(sweepLine.line);
  return {
    id: step.id,
    code: 124,
    ms: Date.now() - started,
    timeout: true,
    sweep: sweepLine,
  };
}

async function main() {
  const args = Deno.args;
  let tier = "fast";
  let explain = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier") {
      tier = args[++i];
      if (!["fast", "full"].includes(tier)) {
        console.error(`gate: unknown tier "${tier}"; use fast or full`);
        Deno.exit(2);
      }
    } else if (args[i] === "--explain") {
      explain = true;
    } else {
      console.error(`gate: unknown argument "${args[i]}"`);
      Deno.exit(2);
    }
  }

  const root = new URL("..", import.meta.url).pathname;
  const {
    pure,
    browserSuites,
    sources,
    modules,
    commands,
    suiteFiles,
    dependents,
    graphComplete,
    graphReason,
    mapErrors: discoveryErrors,
  } = await discover(
    root,
  );
  const mapErrors = [
    ...validateMap({ pure, browserSuites, sources, commands }),
    ...discoveryErrors,
  ];
  if (mapErrors.length) {
    console.error("gate: REFUSING — the changed-path map is not trustworthy:");
    for (const error of mapErrors) console.error(`  - ${error}`);
    // The gate ran nothing, so its coverage must read as UNKNOWN rather than as "no suites needed".
    console.log(`fast-gate: unknown: the changed-path map refused (${mapErrors[0]})`);
    Deno.exit(2);
  }
  if (explain) {
    console.log(
      `gate: ${pure.length} pure fixture(s) + ${[...browserSuites].length} browser suite(s)`,
    );
    for (const rule of RULES) {
      console.log(
        `  rule ${rule.id}: ${rule.suites.join(", ")} <- ${
          [...rule.exact, ...rule.prefixes].join(", ")
        }`,
      );
    }
    for (const rule of BROWSER_RULES) {
      console.log(
        `  browser ${rule.id}: ${rule.suites.join(", ")} <- ${
          [...rule.exact, ...rule.prefixes].join(", ")
        }`,
      );
    }
    return;
  }

  const { available, mergeCommit, paths } = await changedPathsFromGit(root);
  const classification = classifyPaths(paths, {
    fixtures: [...pure, ...browserSuites],
    browserSuites: [...browserSuites],
    sources,
    dependents,
  });
  const selectionBroad = selectionIsBroad({
    selected: classification.selected.size,
    browser: classification.browser.size,
    pure: pure.length,
  });
  const decision = decideTier({
    requested: tier,
    changed: paths,
    diffAvailable: available,
    mergeCommit,
    unknownPaths: classification.unknown,
    graphComplete,
    selectionBroad,
    selectionCount: classification.selected.size + classification.browser.size,
    corpusSize: pure.length,
  });
  const effective = decision.tier;

  const head = (await runGit(["rev-parse", "--short", "HEAD"], { cwd: root, stdout: "piped" }))
    .stdout.trim();
  console.log(`gate: tier=${effective} tree=${head} changed=${paths.length}`);
  if (decision.escalate.length) {
    console.log(`gate: ESCALATED to the full tier (fail-closed): ${decision.reason}`);
  }
  for (const path of paths) {
    const hit = classification.matched.find((item) => item.path === path);
    const exempt = classification.nonCode.find((item) => item.path === path);
    if (hit) console.log(`gate: path ${path} -> rule "${hit.rule}" -> ${hit.suites.join(", ")}`);
    else if (exempt) console.log(`gate: path ${path} -> no suite (${exempt.reason})`);
    else {
      const hint = classification.hints.find((item) => item.path === path);
      console.log(
        `gate: path ${path} -> UNMAPPED (no rule declares it` +
          (hint ? `; textual references suggest ${hint.candidates.join(", ")}` : "") +
          `) -> escalating to the full tier`,
      );
    }
  }

  // Every suite is invoked with the RUNNER's own command string (see discover): most fixtures have no
  // deno.json task, and one of them needs a prepended typecheck. `sh -c` because those commands are
  // shell strings by construction, exactly as run-fixtures.mjs executes them.
  const suiteStep = (kind, name, reason) => {
    const command = commands[name];
    if (!command) throw new Error(`no runnable command for suite ${name}`);
    return { id: `${kind}:${name}`, command: ["sh", "-c", command], reason, suite: name };
  };
  const steps = [...ALWAYS.map((step) => ({ ...step, tier: "both" }))];
  const browserSelected = effective === "full"
    ? [...new Set([CSS_BROWSER_SUITE, ...classification.browser.keys()])]
    : [...classification.browser.keys()];
  if (effective === "full") {
    steps.push({ ...ALL_FIXTURES_STEP, reason: "the full tier runs every deterministic fixture" });
    for (const name of browserSelected) {
      steps.push(
        suiteStep(
          "browser",
          name,
          name === CSS_BROWSER_SUITE
            ? "full tier: the CSS browser suite is UNCONDITIONAL (no browser-driven verdict is claimed without it)"
            : classification.browser.get(name),
        ),
      );
    }
  } else {
    for (const name of classification.selected.keys()) {
      steps.push(suiteStep("fixture", name, classification.selected.get(name)));
    }
    for (const name of browserSelected) {
      steps.push(suiteStep("browser", name, classification.browser.get(name)));
    }
  }
  console.log(`---- GATE COVERAGE (tier=${effective}) ----`);
  for (const step of steps) console.log(`RAN       ${step.id}`);

  const ranNames = new Set(steps.map((step) => step.id));
  const skipped = [];
  if (effective === "fast") {
    for (const name of pure) {
      if (!ranNames.has(`fixture:${name}`)) {
        skipped.push({
          name,
          why:
            `unaffected: no changed path maps to it (see the rule table: deno task gate:fast --explain)`,
        });
      }
    }
    for (const name of browserSuites) {
      if (!browserSelected.includes(name)) {
        const rules = BROWSER_RULES.filter((rule) => rule.suites.includes(name));
        skipped.push({
          name,
          why: `unaffected: no changed path matched ${
            rules.map((rule) => `"${rule.id}" -> ${[...rule.exact, ...rule.prefixes].join(", ")}`)
              .join(" or ")
          }`,
        });
      }
    }
  }
  for (const item of skipped) console.log(`SKIPPED   ${item.name} — ${item.why}`);
  if (effective === "full") {
    const notRun = [...browserSuites].filter((name) => !browserSelected.includes(name));
    for (const name of notRun) {
      const components = [...COMPONENT_OF].filter(([, parent]) => parent === name).map(
        ([child]) => child,
      );
      console.log(
        `NOT-RUN   ${name} — not part of the fleet full gate: CI runs it as its own step (deno task ${name}` +
          (components.length ? `, which executes ${components.join(", ")}` : "") +
          ") - this manifest is how a reader knows it did not run here",
      );
    }
  } else {
    console.log(
      `NOT-RUN   the full fixture tier (deno task test-fixtures) — fast tier ran ${steps.length} scoped step(s); the merger's full gate runs all ${pure.length} pure fixtures`,
    );
  }

  let failed = 0;
  const results = [];
  for (const step of steps) {
    console.log(`\n---- ${step.id} :: ${step.command.join(" ")} :: ${step.reason} ----`);
    const result = await runStep(step, step.id === "all-fixtures" ? 1800_000 : 900_000);
    results.push(result);
    if (result.code !== 0) {
      failed++;
      console.error(
        `gate: step ${step.id} FAILED (exit ${result.code}${result.timeout ? ", timeout" : ""})`,
      );
    }
  }

  console.log("\n---- GATE VERDICT ----");
  for (const result of results) {
    console.log(
      `  ${result.code === 0 ? "PASS" : "FAIL"}  ${result.id}  ${(result.ms / 1000).toFixed(1)}s`,
    );
    // A timed-out step must never read as a bare 124 (gendn-j3ug): the group kill and the token sweep
    // are reported here too, so "we reclaimed N descendants" and "we could not look" both survive into
    // the artefact instead of scrolling past on stderr.
    if (result.sweep) console.log(`        ${result.sweep.kind}  ${result.sweep.line}`);
  }
  const total = results.reduce((sum, result) => sum + result.ms, 0);
  // MARKER VOCABULARY FOR THE FLEET'S OWN READER (fleet-check -> remote/check-coverage.py reads the
  // gate log): `fast-gate: passed:|ran:|failed: <suites...>` is positive evidence of what executed,
  // `fast-gate: unmapped: <paths...>` names paths the gate could not classify, and
  // `fast-gate: unknown: <reason>` says coverage cannot be stated at all. Without them the reader
  // reports "coverage UNKNOWN - N changed files NOT demonstrated to be exercised" for EVERY run
  // (measured on this branch before these lines existed): honest, but it discards the one thing this
  // gate knows exactly - which suites ran. `ran:` rather than `failed:` when a step failed, because
  // the suites still RAN and a failed suite is not a suite whose coverage is unknown.
  const ranSuites = effective === "full"
    ? [...pure, ...browserSelected]
    : [...classification.selected.keys(), ...browserSelected];
  const ranFiles = ranSuites.flatMap((name) => suiteFiles[name] ?? []);
  console.log(`fast-gate: ${failed ? "ran" : "passed"}: ${[...new Set(ranFiles)].join(" ")}`);
  if (classification.unknown.length) {
    console.log(`fast-gate: unmapped: ${classification.unknown.join(" ")}`);
  }
  console.log(
    `GATE-COVERAGE-MANIFEST tier=${effective} tree=${head} changed=${paths.length} ran=${results.length} ` +
      `skipped=${skipped.length} browser=${
        browserSelected.length ? browserSelected.join("|") : "none"
      } ` +
      `unknown=${classification.unknown.length} escalated=${
        decision.escalate.length ? "yes" : "no"
      } ` +
      // The isolation claim's own basis, on the artefact (gendn-8wwm): which universe the dependency
      // graph was built from, how big it is, and whether it could be built at all. `complete=no`
      // escalates the run, so a reader never has to infer that the selection was made from a graph.
      `graph=${graphComplete ? `git-ls-files(${modules.size})` : `INCOMPLETE`} ` +
      `failed=${failed} total_ms=${total}`,
  );
  if (!graphComplete) {
    console.log(
      `gate: DEPENDENCY GRAPH INCOMPLETE (${graphReason}) - no path can be proven isolated, so this ` +
        `run escalated to the full tier rather than selecting from a partial graph.`,
    );
  }
  if (effective === "fast") {
    console.log(
      `gate: FAST TIER — ${results.length} step(s) ran; ${skipped.length} suite(s) were NOT run (named above with their reason). ` +
        `No browser-driven verdict is claimed unless a browser suite is listed in RAN above.`,
    );
  } else {
    console.log(
      `gate: FULL TIER — ${results.length} step(s) ran, including the CSS browser suite; ` +
        `the browser-backed ${
          [...browserSuites].filter((n) => !browserSelected.includes(n)).join(", ") || "none"
        } ` +
        `is NOT run by this gate (CI-only step).`,
    );
  }
  Deno.exit(failed ? 1 : 0);
}

if (import.meta.main) {
  await main();
}
