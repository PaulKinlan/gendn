#!/usr/bin/env -S deno run --allow-read
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
// WHY A UNIT FIXTURE RATHER THAN A CLI RUN: the write site needs Chrome and the whole scan harness.
// The decision and the merge are pure, so they are exported from scripts/conformance.mjs and driven
// here directly - importing that module is side-effect-free (`if (import.meta.main) await main()`).
//
// Run: deno task test-conformance-report

import { responsiveReportLine, responsiveReportRows } from "./conformance.mjs";

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
assert(
  "the scanned page's row is REPLACED with the fresh result",
  incident[7].desktop === "REVIEW" && incident[7].mobile === "REVIEW",
);
assert(
  "the replacement stays IN PLACE, so the tracked diff is one row, not a reordering",
  incident[7].id === "v1/p7" && incident.every((r, i) => r.id === `v1/p${i}`),
);
assert(
  "pages the scan did not touch keep their rows byte-for-byte",
  JSON.stringify(incident[6]) === JSON.stringify(row("v1/p6")) &&
    JSON.stringify(incident[8]) === JSON.stringify(row("v1/p8")),
);

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

console.log(`\nconformance-report fixture: all ${passed} assertions passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  Deno.exit(1);
}
