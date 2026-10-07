#!/usr/bin/env -S deno run --allow-read --allow-write
// scripts/conformance-report.test.mjs — the tracked responsive report must not be TRUNCATED by a
// scoped run (gendn-jvh).
//
// THE DEFECT, measured during the gendn-sgc pilot: `deno task responsive --page <id>` is the
// documented way to check ONE page, but the reporter wrote only the pages it had scanned, so the
// scoped run rewrote the TRACKED reports/conformance/responsive.json from 198 rows to 1 - 2
// insertions / 3154 deletions in a tracked file, a diff that reads like a deliberate regeneration.
// A tracked generated file is a mutation target no assertion covered, which is why the fix pins the
// DECISION (wholesale vs merge) rather than only the merge arithmetic.
//
// WHY UNIT TEST THE REPORT AND SELECTION: a successful CLI scan needs Chrome; the report and
// selection decisions are pure and exported from scripts/conformance.mjs. Invalid CLI selectors
// also get a real subprocess assertion because they fail before browser boot. Importing the runner
// is side-effect-free (`if (import.meta.main) await main()`).
//
// Run: deno task test-conformance-report
//
// PERMISSIONS: --allow-read for the imports and --allow-write for the temp files that pin the
// tolerant reader's contract (a missing report, a corrupt one, and junk rows). The alternative was
// to leave those three cases as prose in a comment, which is exactly the 'described rather than
// pinned' shape this repo keeps paying for.

import {
  mergeReportRows,
  readReportRows,
  readResponsiveRows,
  responsiveReportLine,
  responsiveReportRows,
  runAllReportLine,
  scopedResultsReport,
  selectPublishedRootPages,
} from "./conformance.mjs";
import { collectPublishedPages } from "./lib/artifacts.mjs";

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

const row = (id, desktop = "ok", mobile = "ok") => ({ id, route: `/${id}/`, desktop, mobile });

// ---------- both --page modes select real published roots, never pass vacuously ---------------
// This is the shared decision used before browser launch. CI has no Chrome, so both rejected CLI
// modes are subprocess-tested; a valid selector is pinned at the pure seam and run in a focused
// browser check outside this fixture.
const published = [
  "v152/unframed-display-mode-for-isolated-web-apps/index.html",
  "v152/window-shape-api/index.html",
  "v152/window-drag/index.html",
];
const validSelector = selectPublishedRootPages(published, {
  hasSelector: true,
  selector: "v152/window-shape-api",
});
assert(
  "valid published-root selector runs exactly its one page",
  validSelector.error === null && validSelector.pages.length === 1 &&
    validSelector.pages[0] === "v152/window-shape-api/index.html",
);
const actualCatalogue = await collectPublishedPages(".");
const unscopedSelection = selectPublishedRootPages(actualCatalogue);
assert(
  "no-selector conformance/responsive modes enumerate the same full published-root catalogue",
  unscopedSelection.error === null && actualCatalogue.length > 0 &&
    unscopedSelection.pages.length === actualCatalogue.length &&
    unscopedSelection.pages.every((path, i) => path === actualCatalogue[i]),
  `count=${unscopedSelection.pages.length}`,
);
const trackedReportPaths = ["reports/conformance/results.json", "reports/conformance/index.html"];
const sameReportBytes = (before, after) =>
  before.every((bytes, i) =>
    bytes.length === after[i].length && bytes.every((byte, j) => byte === after[i][j])
  );
// CI has no Chrome, so a browser-backed valid-run fixture would break it. Instead, copy the REAL
// tracked results.json to an isolated temp file and exercise the same valid-root selector and
// scoped report merge that a valid run uses. The unchanged/changed comparator controls here prove
// the rejected-run byte pin below is not vacuous. A real valid browser run was observed separately
// during acceptance (it changed results.json and was restored); that observation is NOT a fixture.
const trackedResults = trackedReportPaths[0];
const originalResults = await Deno.readFile(trackedResults);
const controlDir = await Deno.makeTempDir({ prefix: "gendn-scoped-report-control-" });
try {
  const tempResults = `${controlDir}/results.json`;
  await Deno.writeFile(tempResults, originalResults);
  const unchanged = await Deno.readFile(tempResults);
  assert(
    "comparator reports SAME for an unchanged copy of the real tracked results report",
    sameReportBytes([originalResults], [unchanged]),
  );
  const sourceReport = JSON.parse(new TextDecoder().decode(unchanged));
  const sourceSuite = sourceReport.suites.find((s) =>
    s.pass > 0 && actualCatalogue.includes(`${s.id}/index.html`)
  );
  if (!sourceSuite) {
    assert("comparator control has a valid published suite with a passing result", false);
  } else {
    const selected = selectPublishedRootPages(actualCatalogue, {
      hasSelector: true,
      selector: sourceSuite.id,
    });
    const passIndex = sourceSuite.results.findIndex((r) => r.status === "pass");
    const scannedSuite = {
      ...sourceSuite,
      pass: sourceSuite.pass - 1,
      fail: sourceSuite.fail + 1,
      results: sourceSuite.results.map((r, i) =>
        i === passIndex
          ? { ...r, status: "fail", reason: "fixture-generated scoped observation" }
          : r
      ),
    };
    const merged = scopedResultsReport({
      existing: sourceReport.suites,
      scanned: [scannedSuite],
      scoped: true,
    });
    await Deno.writeTextFile(
      tempResults,
      JSON.stringify(
        { generatedAt: sourceReport.generatedAt, agg: merged.agg, suites: merged.suites },
        null,
        2,
      ) + "\n",
    );
    const changed = await Deno.readFile(tempResults);
    assert(
      "valid published-root scoped report replacement makes SAME comparator report CHANGED",
      selected.error === null && selected.pages.length === 1 && passIndex >= 0 &&
        merged.suites.length === sourceReport.suites.length &&
        merged.suites.find((s) => s.id === sourceSuite.id)?.fail === sourceSuite.fail + 1 &&
        !sameReportBytes([unchanged], [changed]),
    );
    assert(
      "isolated valid scoped report control does not write the tracked source report",
      sameReportBytes([originalResults], [await Deno.readFile(trackedResults)]),
    );
  }
} finally {
  await Deno.remove(controlDir, { recursive: true });
}
for (const selector of ["v152/window-shape-api/setshape", "v152/window-shape-apix"]) {
  const miss = selectPublishedRootPages(published, { hasSelector: true, selector });
  assert(
    `zero-match --page ${selector} fails with the selector, root-only rule and nearest parent`,
    miss.pages.length === 0 && miss.error?.includes(selector) &&
      miss.error?.includes("only published root routes are selectable") &&
      miss.error?.includes("v152/window-shape-api"),
    miss.error ?? "unexpected match",
  );
  // An actual CLI exit check catches a future caller that ignores the pure decision. This is
  // pre-boot: the child process has only --allow-read and cannot spawn Chrome or a server.
  for (const mode of ["responsive", "conformance"]) {
    const output = await new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "scripts/conformance.mjs",
        ...(mode === "responsive" ? ["--responsive"] : []),
        "--page",
        selector,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assert(
      `zero-match ${mode} CLI --page ${selector} exits nonzero before browser/report work`,
      output.code === 2 && stderr.includes(selector) &&
        stderr.includes("only published root routes are selectable") &&
        stderr.includes("v152/window-shape-api") && !stdout.includes("verdict:") &&
        !stdout.includes("responsive-check:") && !stdout.includes("run-all:"),
      `code=${output.code} stdout=${stdout.trim()} stderr=${stderr.trim()}`,
    );
  }
  // Unlike the restricted CLI checks above, this is the real task with write permission. A
  // rejected selector must not mutate either tracked report; the isolated comparator control
  // above proves that the same comparison detects a valid scoped replacement.
  const before = await Promise.all(trackedReportPaths.map((path) => Deno.readFile(path)));
  const real = await new Deno.Command("deno", {
    args: ["task", "conformance", "--page", selector],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const realOut = new TextDecoder().decode(real.stdout);
  const realErr = new TextDecoder().decode(real.stderr);
  const after = await Promise.all(trackedReportPaths.map((path) => Deno.readFile(path)));
  assert(
    `real-permission rejected conformance --page ${selector} fails before report generation`,
    real.code === 2 && realErr.includes(selector) &&
      realErr.includes("only published root routes are selectable") &&
      !realOut.includes("run-all:") && !realOut.includes("verdict:"),
    `code=${real.code} stdout=${realOut.trim()} stderr=${realErr.trim()}`,
  );
  assert(
    `real-permission rejected conformance --page ${selector} preserves both tracked reports byte-for-byte`,
    sameReportBytes(before, after),
    trackedReportPaths.join(", "),
  );
}
for (const selector of [undefined, "", "--screenshots"]) {
  const malformed = selectPublishedRootPages(published, { hasSelector: true, selector });
  assert(
    `missing/empty/option --page ${JSON.stringify(selector)} does not run the full matrix`,
    malformed.pages.length === 0 && malformed.error?.includes("published root route ID"),
    malformed.error ?? "unexpected match",
  );
}
// ---------- explicit --limit must be a positive integer in BOTH modes -------------------------
for (const rawLimit of ["0", "-1", "foo", "0.5", "1.5", "Infinity", "", "--page", undefined]) {
  for (const selector of [null, "v152/window-shape-api"]) {
    const invalid = selectPublishedRootPages(actualCatalogue, {
      hasSelector: selector !== null,
      selector,
      hasLimit: true,
      rawLimit,
    });
    assert(
      `invalid --limit ${JSON.stringify(rawLimit)} with ${
        selector ?? "no --page"
      } fails before any selection`,
      invalid.pages.length === 0 && invalid.error?.includes("must be a positive integer"),
      invalid.error ?? "unexpected match",
    );
  }
}
const previousZeroGuard = selectPublishedRootPages(published, {
  hasSelector: true,
  selector: "v152/window-shape-api",
  limit: 0,
});
assert(
  "a direct zero limit with --page still fails with task-neutral wording",
  previousZeroGuard.pages.length === 0 &&
    previousZeroGuard.error?.includes("positive integer") &&
    !previousZeroGuard.error?.includes("responsive pass"),
);
for (const [rawLimit, expected] of [["1", 1], ["202", actualCatalogue.length]]) {
  const selection = selectPublishedRootPages(actualCatalogue, { hasLimit: true, rawLimit });
  assert(
    `positive --limit ${rawLimit} without --page preserves ${expected} selected pages`,
    selection.error === null && selection.pages.length === expected &&
      selection.pages.every((path, i) => path === actualCatalogue[i]),
  );
  const withPage = selectPublishedRootPages(actualCatalogue, {
    hasSelector: true,
    selector: "v152/window-shape-api",
    hasLimit: true,
    rawLimit,
  });
  assert(
    `positive --limit ${rawLimit} with --page preserves the one exact root`,
    withPage.error === null && withPage.pages.length === 1 &&
      withPage.pages[0] === "v152/window-shape-api/index.html",
  );
}
// Use the actual task permissions on the failing path: a regression could otherwise write a
// tracked report before printing an error, which a restricted subprocess would not detect.
for (const rawLimit of ["0", "-1", "foo"]) {
  for (const mode of ["conformance", "responsive"]) {
    // Only conformance writes these TWO tracked reports. Responsive writes the gitignored
    // responsive.json, so comparing conformance's tracked outputs there would pass vacuously.
    // Its rc2/no-verdict/no-responsive-check assertions below pin rejection before browser work.
    const before = mode === "conformance"
      ? await Promise.all(trackedReportPaths.map((path) => Deno.readFile(path)))
      : null;
    const output = await new Deno.Command("deno", {
      args: ["task", mode, "--limit", rawLimit],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assert(
      `${mode} --limit ${rawLimit} rejects pre-boot without a green zero-work verdict`,
      output.code === 2 && stderr.includes(`--limit "${rawLimit}"`) &&
        stderr.includes("must be a positive integer") &&
        !stdout.includes("verdict:") && !stdout.includes("run-all:") &&
        !stdout.includes("responsive-check:"),
      `code=${output.code} stdout=${stdout.trim()} stderr=${stderr.trim()}`,
    );
    if (mode === "conformance") {
      const after = await Promise.all(trackedReportPaths.map((path) => Deno.readFile(path)));
      assert(
        `${mode} --limit ${rawLimit} preserves both tracked reports byte-for-byte`,
        sameReportBytes(before, after),
        trackedReportPaths.join(", "),
      );
    }
  }
}
for (const mode of ["conformance", "responsive"]) {
  const output = await new Deno.Command("deno", {
    args: ["task", mode, "--page", "v152/window-shape-api", "--limit", "0"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(output.stderr);
  assert(
    `${mode} --page valid --limit 0 remains rejected with task-neutral wording`,
    output.code === 2 && stderr.includes("must be a positive integer") &&
      !stderr.includes("vacuous responsive pass"),
    `code=${output.code} stderr=${stderr.trim()}`,
  );
}

// ---------- a FULL run still regenerates wholesale -------------------------------------------
// This is what carries catalogue additions and REMOVALS into the report, so it must not be turned
// into a merge while fixing the scoped case.
const full = responsiveReportRows({
  existing: [row("v1/a"), row("v1/b")],
  scanned: [row("v1/c")],
  scoped: false,
});
assert(
  "a FULL run regenerates wholesale (removals still reach the report)",
  full.length === 1 && full[0].id === "v1/c",
  JSON.stringify(full.map((r) => r.id)),
);

// ---------- the reported incident, encoded ---------------------------------------------------
// 198 existing rows, ONE page scanned: the result must still be 198 rows. Under the old code this
// was 1 - the truncated report is exactly this value.
const incident = responsiveReportRows({
  existing: Array.from({ length: 198 }, (_, i) => row(`v1/p${i}`)),
  scanned: [row("v1/p7", "REVIEW", "REVIEW")],
  scoped: true,
});
assert(
  "the measured incident: a scoped run over a 198-row report keeps 198 rows (was 1)",
  incident.length === 198,
  `length=${incident.length}`,
);
// Guarded so the assertions below DESCRIBE the truncation instead of aborting on it (gendn-jvh
// review P2): dereferencing incident[7] when the report collapsed to one row throws a TypeError and
// silences every later assertion, which makes a mutation's output less informative than the defect.
{
  const bad = incident.length !== 198;
  assert(
    bad
      ? "the scanned page's row is REPLACED with the fresh result (skipped: the report is the wrong size)"
      : "the scanned page's row is REPLACED with the fresh result",
    !bad && incident[7].desktop === "REVIEW" && incident[7].mobile === "REVIEW",
  );
  assert(
    bad
      ? "the replacement stays IN PLACE, so the tracked diff is one row, not a reordering (skipped)"
      : "the replacement stays IN PLACE, so the tracked diff is one row, not a reordering",
    !bad && incident[7].id === "v1/p7" && incident.every((r, i) => r.id === `v1/p${i}`),
  );
  assert(
    bad
      ? "pages the scan did not touch keep their rows byte-for-byte (skipped)"
      : "pages the scan did not touch keep their rows byte-for-byte",
    !bad && JSON.stringify(incident[6]) === JSON.stringify(row("v1/p6")) &&
      JSON.stringify(incident[8]) === JSON.stringify(row("v1/p8")),
  );
}

// ---------- a page the report has never carried appends ------------------------------------
const grown = responsiveReportRows({
  existing: [row("v1/a")],
  scanned: [row("v1/new")],
  scoped: true,
});
assert(
  "a newly scanned page is APPENDED (existing order untouched)",
  grown.length === 2 && grown[0].id === "v1/a" && grown[1].id === "v1/new",
);

// ---------- the console line must not describe a scoped run as a full one --------------------
// The old line said "<n> pages scanned" with n = the row count, which is how a 1-page run reported
// itself as a full report and nobody noticed the file had shrunk to match.
const scopedLine = responsiveReportLine(1, 198, true);
assert(
  "a scoped run's line names the scope AND the report size (never '1 pages scanned' as if complete)",
  scopedLine.includes("1 page(s) scanned") && scopedLine.includes("198 rows"),
  scopedLine,
);
assert(
  "a FULL run's line keeps its original shape",
  responsiveReportLine(201, 201, false) ===
    "responsive-check: 201 pages scanned → reports/conformance/responsive.json",
  responsiveReportLine(201, 201, false),
);

// ---------- the tolerant reader's contract, expressed as the merge's degenerate cases ---------
assert(
  "a first-ever scoped run (no existing report) writes just its own rows",
  responsiveReportRows({ existing: [], scanned: [row("v1/a")], scoped: true }).length === 1,
);
assert(
  "an empty scan merges to the existing rows rather than emptying the report",
  responsiveReportRows({ existing: [row("v1/a")], scanned: [], scoped: true }).length === 1,
);

// ---------- the tolerant reader, PINNED rather than described in prose (review P2) ------------
// A missing report is the ordinary first-run case and must stay silent; a CORRUPT one is the
// dangerous case, because a scoped merge would rewrite it to just the scanned pages - so it warns
// while still degrading gracefully.
const tmp = await Deno.makeTempDir({ prefix: "gendn-responsive-report-" });
// The warn spy is CAPTURED, not a no-op: an assertion named "stays silent" that passes because it
// never looked is the same mislabelling defect this branch exists to fix (gendn-jvh delta review).
let missingWarned = "";
const missing = await readResponsiveRows(`${tmp}/absent.json`, {
  warn: (m) => (missingWarned = m),
});
assert(
  "a MISSING report reads as empty and stays silent (the first scoped run)",
  missing.length === 0 && missingWarned === "",
  missingWarned ? `unexpected warning: ${missingWarned}` : "",
);
// Write the corrupt file FIRST: reading an absent path is the MISSING case above, which must stay
// SILENT, so asserting the warning against a path that does not exist yet tests the wrong branch
// (my first draft did exactly that and the assertion caught it).
await Deno.writeTextFile(`${tmp}/corrupt.json`, "{ not json");
let warned = "";
const corrupt = await readResponsiveRows(`${tmp}/corrupt.json`, { warn: (m) => (warned = m) });
assert(
  "a CORRUPT report reads as empty AND says so (a scoped run would otherwise reset it silently)",
  corrupt.length === 0 && /unreadable/.test(warned),
  warned || "(no warning emitted)",
);
await Deno.writeTextFile(`${tmp}/wrong-shape.json`, JSON.stringify({ rows: [] }));
let shapeWarned = "";
await readResponsiveRows(`${tmp}/wrong-shape.json`, { warn: (m) => (shapeWarned = m) });
assert(
  "valid JSON that is not a row ARRAY is reported too (it is not the empty case either)",
  /not an array/.test(shapeWarned),
  shapeWarned || "(no warning emitted)",
);
await Deno.writeTextFile(
  `${tmp}/shapes.json`,
  JSON.stringify([{ id: "keep" }, null, 7, { noId: 1 }]),
);
const shapes = await readResponsiveRows(`${tmp}/shapes.json`, { warn: () => {} });
assert(
  "rows without a string id are dropped rather than merged as junk",
  shapes.length === 1 && shapes[0].id === "keep",
);
await Deno.remove(tmp, { recursive: true });

// ---- gendn-502: THE SAME CLASS IN THE RUNNER'S OWN REPORT -------------------------------------
// jvh fixed it for reports/conformance/responsive.json; the same runner's OTHER output had it too -
// `deno task conformance --page <id>`, the documented evidence command, rewrote the tracked
// results.json from 198 suites to 1 and the index rollup from 229 lines to 32. So the class is
// closed once, in mergeReportRows, and both reports call it. These assertions pin the DECISION
// (wholesale vs merge) for the second report and the two shapes the shared reader must accept.
const suite = (id, pass) => ({ id, total: pass, pass, fail: 0, blocked: 0 });
const existingSuites = [suite("a", 1), suite("b", 2), suite("c", 3)];
const mergedSuites = mergeReportRows({
  existing: existingSuites,
  scanned: [suite("b", 9)],
  scoped: true,
});
assert(
  "502: a scoped run MERGES - the scanned suite replaces its own row IN PLACE, order intact",
  JSON.stringify(mergedSuites.map((s) => s.id)) === JSON.stringify(["a", "b", "c"]) &&
    mergedSuites[1].pass === 9 && mergedSuites[0].pass === 1 && mergedSuites[2].pass === 3,
  JSON.stringify(mergedSuites.map((s) => `${s.id}:${s.pass}`)),
);
assert(
  "502: a suite the report has never carried is APPENDED",
  JSON.stringify(
    mergeReportRows({ existing: existingSuites, scanned: [suite("z", 1)], scoped: true }).map((s) =>
      s.id
    ),
  ) === JSON.stringify(["a", "b", "c", "z"]),
);
// THE INVERSE, pinned for the same reason jvh pinned it: a full run MUST regenerate wholesale, or a
// suite whose page was removed from the catalogue could never leave the report.
assert(
  "502: a FULL run does NOT merge (catalogue removals must still be able to leave the report)",
  JSON.stringify(
    mergeReportRows({ existing: existingSuites, scanned: [suite("b", 9)], scoped: false }),
  ) ===
    JSON.stringify([suite("b", 9)]),
);
// The two reports have DIFFERENT SHAPES - the responsive one is an array of rows keyed `id`, the
// run-all one is an object carrying `suites` - so the merge is keyed and the reader takes a key.
assert(
  "502: the shared merge is keyed, so an object-shaped report merges by its own key too",
  JSON.stringify(
    mergeReportRows({
      existing: [{ page: "x" }, { page: "y" }],
      scanned: [{ page: "y", v: 9 }],
      scoped: true,
      key: "page",
    }),
  ) === JSON.stringify([{ page: "x" }, { page: "y", v: 9 }]),
);
{
  const tmp2 = await Deno.makeTempDir({ prefix: "gendn-502-" });
  const objectReport = `${tmp2}/results.json`;
  await Deno.writeTextFile(objectReport, JSON.stringify({ agg: {}, suites: existingSuites }));
  const readBack = await readReportRows(objectReport, { what: "suites", key: "suites" });
  assert(
    "502: the shared reader reads an OBJECT report through its key",
    JSON.stringify(readBack.map((s) => s.id)) === JSON.stringify(["a", "b", "c"]),
  );
  // THIS ONE IS THE BUG I SHIPPED AND CAUGHT BY RUNNING THE COMMAND: the reader accepted only
  // top-level arrays, so on the real (object) report it returned [] while WARNING, the merge had
  // nothing to merge into, and the scoped run still truncated 198 suites to 1. A missing key must
  // warn rather than quietly produce an empty merge.
  let shapeWarned = "";
  const noKey = await readReportRows(objectReport, {
    what: "suites",
    warn: (m) => (shapeWarned = m),
  });
  assert(
    "502: reading an OBJECT report without its key WARNS instead of silently merging nothing",
    noKey.length === 0 && shapeWarned.includes("not an array of suites"),
    shapeWarned,
  );
}
// THE DECISION ITSELF, now that it is a pure seam: wholesale vs merge AND which aggregate the file
// carries. Without this, the fixture would pass while the write site ignored the scope entirely -
// which is exactly the wiring gap that made my first attempt look fixed at unit level and still
// truncate the report end to end.
const scopedReport = scopedResultsReport({
  existing: existingSuites,
  scanned: [suite("b", 9)],
  scoped: true,
});
assert(
  "502: the run-all report DECISION merges on a scoped run (198 suites cannot become 1)",
  scopedReport.merged === true && scopedReport.suites.length === 3,
  JSON.stringify(scopedReport.suites.map((s) => `${s.id}:${s.pass}`)),
);
assert(
  "502: the report's aggregate covers the MERGED set, not just the scan",
  scopedReport.agg.pass === 1 + 9 + 3 && scopedReport.agg.total === 1 + 9 + 3,
  JSON.stringify(scopedReport.agg),
);
const fullReport = scopedResultsReport({
  existing: existingSuites,
  scanned: [suite("b", 9)],
  scoped: false,
});
assert(
  "502: the run-all report DECISION is wholesale on a full run, with the scan's own aggregate",
  fullReport.suites.length === 1 && fullReport.agg.pass === 9,
  JSON.stringify(fullReport.agg),
);

assert(
  "502: the FULL run-all line is byte-identical to the pinned shape (the landing gate sends it)",
  runAllReportLine({
    scannedSuites: 5,
    totalSuites: 5,
    scoped: false,
    agg: { pass: 1, fail: 0, blocked: 0, total: 1 },
  }) === "run-all: 5 suites · assertions 1 pass / 0 fail / 0 blocked (of 1)",
);
assert(
  "502: a scoped run's line names the merge AND the report's size, not the scan's",
  runAllReportLine({ scannedSuites: 1, totalSuites: 198, scoped: true, agg: {} }).includes(
    "merged into reports/conformance/results.json",
  ) &&
    runAllReportLine({ scannedSuites: 1, totalSuites: 198, scoped: true, agg: {} }).includes(
      "report now 198 suites",
    ),
);

console.log(`\nconformance-report fixture: all ${passed} assertions passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  Deno.exit(1);
}
