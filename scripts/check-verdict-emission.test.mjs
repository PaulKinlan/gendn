#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
// check-verdict-emission.test.mjs — fail-closed regression tests for the verdict-emission check
// (gendn-aj6). Runs as `deno task test-verdict-emission` and as a CI step, so the check cannot
// silently stop failing: every FAIL case below asserts the exit code a landing gate would read.
//
// The log fixtures are byte-faithful to the real gate logs of the gendn-jeq landing — the summary
// line shape, the verdict line shape, and the two-space-indented detail lines (`fail-assertion`,
// `review-page`) are copied from /tmp/merger-l5-conformance.log and /tmp/merger-l5b-responsive.log.
import {
  classifyPhase,
  emittedVerdictLines,
  expectedVerdictLines,
} from "./check-verdict-emission.mjs";

const CHECKER = new URL("./check-verdict-emission.mjs", import.meta.url).pathname;
let failures = 0;
function assert(desc, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${desc}`);
  if (!ok) failures++;
}

const root = await Deno.makeTempDir({ prefix: "gendn-verdict-emission-" });
let logSeq = 0;

// Drive the checker exactly as the landing gate would: as a process, reading the exit code.
async function checkLog(logText, extraArgs = []) {
  const logPath = `${root}/gate-${logSeq++}.log`;
  await Deno.writeTextFile(logPath, logText);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", CHECKER, logPath, ...extraArgs],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const decoder = new TextDecoder();
  return { code, out: decoder.decode(stdout), err: decoder.decode(stderr) };
}

// --- fixtures: the real gate's output shapes ------------------------------------------------

const RUN_ALL_SUMMARY =
  "run-all: 201 suites · assertions 3769 pass / 18 fail / 1048 blocked (of 4835)";
const SINGLE_SUITE_SUMMARY = "run-all: 1 suites · assertions 19 pass / 0 fail / 5 blocked (of 24)";
const RESPONSIVE_SUMMARY =
  "responsive-check: 201 pages scanned → reports/conformance/responsive.json";
const RUN_ALL_NOT_GREEN =
  "verdict: NOT-GREEN - 18 failing assertions on 15 of 201 suites (exit code unchanged for run-all; single-page runs still exit 2)";
const RUN_ALL_GREEN = "verdict: GREEN - 0 failing assertions across 1 suites";
const RESPONSIVE_REVIEW =
  "verdict: REVIEW-REQUIRED - 11 page(s) flagged (desktop 0 / mobile 11 REVIEW of 201 scanned), exit code unchanged";
const RESPONSIVE_GREEN = "verdict: GREEN - all 201 scanned pages ok on both classes";

const LOGS = {
  runAllNotGreen: [
    "v149/webmcp  tested 19/24  pass 19  fail 0  blocked 5",
    "",
    RUN_ALL_SUMMARY,
    "rollup → reports/conformance/index.html · results → reports/conformance/results.json",
    RUN_ALL_NOT_GREEN,
    "  fail-assertion no-console-errors pages=3 :: v149/a v149/b v149/c",
  ].join("\n"),
  // A completed single-suite run: the landing gate's behavioural ACCUMULATION shape.
  singleSuite: [
    "v149/webmcp  tested 19/24  pass 19  fail 0  blocked 5",
    "",
    SINGLE_SUITE_SUMMARY,
    RUN_ALL_GREEN,
  ].join("\n"),
  responsiveReview: [
    "v147/css-border-shape  desktop:ok  mobile:REVIEW",
    "",
    RESPONSIVE_SUMMARY,
    RESPONSIVE_REVIEW,
    "  review-page v147/css-border-shape desktop:ok mobile:REVIEW",
  ].join("\n"),
  responsiveGreen: [
    "v147/css-border-shape  desktop:ok  mobile:ok",
    "",
    RESPONSIVE_SUMMARY,
    RESPONSIVE_GREEN,
  ].join("\n"),
  // The landing gate's kill probe as it really looked: the task banner, then SIGKILL.
  killProbe:
    "Task conformance deno run --allow-read scripts/conformance.mjs '--page' 'v149/webmcp'",
};

// --- the check PASSES on real phase logs ----------------------------------------------------

let r = await checkLog(LOGS.runAllNotGreen);
assert(
  "run-all log (201 suites, NOT-GREEN) passes with exactly 1 emission",
  r.code === 0 && r.out.includes("phase    : run-all") && r.out.includes("emitted  : 1"),
);
r = await checkLog(LOGS.singleSuite);
assert(
  "completed single-suite --page log is a run-all phase log owing 1, and passes",
  r.code === 0 && r.out.includes("phase    : run-all") && r.out.includes("expected : 1"),
);
r = await checkLog(LOGS.responsiveReview);
assert(
  "responsive log (REVIEW-REQUIRED) passes with exactly 1 emission",
  r.code === 0 && r.out.includes("phase    : responsive") && r.out.includes("emitted  : 1"),
);
r = await checkLog(LOGS.responsiveGreen);
assert("responsive GREEN log passes with exactly 1 emission", r.code === 0);
r = await checkLog(LOGS.killProbe);
assert(
  "behavioural kill probe (no completion summary) passes with exactly 0 emissions",
  r.code === 0 && r.out.includes("phase    : behavioural") && r.out.includes("expected : 0"),
);
r = await checkLog(LOGS.runAllNotGreen, ["--phase", "run-all"]);
assert("--phase run-all cross-checks the run-all log", r.code === 0);
r = await checkLog(LOGS.responsiveGreen, ["--phase", "responsive"]);
assert("--phase responsive cross-checks the responsive log", r.code === 0);
r = await checkLog(LOGS.killProbe, ["--phase", "behavioural"]);
assert("--phase behavioural cross-checks the kill-probe log", r.code === 0);
// Anchoring: documentation prose naming the token is NOT an emission (the gendn-aj6 defect).
r = await checkLog(
  `${LOGS.runAllNotGreen}\n// "  fail-assertion ...") or its "verdict:" prefix.`,
);
assert(
  "an indented prose line naming the token is not counted (anchored to column 0)",
  r.code === 0 && r.out.includes("emitted  : 1"),
);

// --- the check FAILS: the point of the instrument -------------------------------------------

r = await checkLog(LOGS.runAllNotGreen.replace(RUN_ALL_NOT_GREEN, ""));
assert(
  "FAILS (exit 1) when a run-all log is MISSING its verdict line",
  r.code === 1 && r.err.includes("MISSING"),
);
r = await checkLog(`${LOGS.runAllNotGreen}\n${RUN_ALL_GREEN}`);
assert(
  "FAILS (exit 1) when a run-all log carries an EXTRA verdict line",
  r.code === 1 && r.err.includes("emitted 2"),
);
r = await checkLog(`${LOGS.responsiveReview}\n${RESPONSIVE_GREEN}`);
assert(
  "FAILS (exit 1) when a responsive log emits both arms' verdict lines",
  r.code === 1 && r.err.includes("emitted 2"),
);
r = await checkLog(LOGS.singleSuite.replace(RUN_ALL_GREEN, ""));
assert(
  "FAILS (exit 1) when a completed single-suite run is missing its verdict line",
  r.code === 1 && r.err.includes("MISSING"),
);
r = await checkLog(`${LOGS.killProbe}\n${RUN_ALL_GREEN}`);
assert(
  "FAILS (exit 1) when the kill probe emits a verdict line (phase owes 0)",
  r.code === 1 && r.err.includes("emitted 1"),
);
r = await checkLog(LOGS.killProbe, ["--phase", "run-all"]);
assert(
  "FAILS (exit 1) on a kill-probe log mislabelled --phase run-all",
  r.code === 1 && r.err.includes("declared --phase run-all"),
);
r = await checkLog(LOGS.singleSuite, ["--phase", "behavioural"]);
assert(
  "FAILS (exit 1) on a completed --page log mislabelled --phase behavioural (the old check's trap)",
  r.code === 1 && r.err.includes("declared --phase behavioural"),
);
r = await checkLog("");
assert("FAILS (exit 1) on an empty log", r.code === 1 && r.err.includes("empty"));

// --- usage errors (exit 2) ------------------------------------------------------------------

const noArgs = await new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-read", CHECKER],
  stdout: "piped",
  stderr: "piped",
}).output();
assert("exit 2 with no arguments", noArgs.code === 2);
r = await checkLog(LOGS.runAllNotGreen, ["--phase", "nonsense"]);
assert("exit 2 on an unknown --phase", r.code === 2);
const missing = await new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-read", CHECKER, `${root}/does-not-exist.log`],
  stdout: "piped",
  stderr: "piped",
}).output();
assert("exit 2 on an unreadable log path", missing.code === 2);
r = await checkLog(LOGS.runAllNotGreen, ["./extra-positional"]);
assert("exit 2 on an unexpected extra argument", r.code === 2);

// --- unit assertions on the derivation ------------------------------------------------------

const source = await Deno.readTextFile(
  new URL("./conformance.mjs", import.meta.url).pathname,
);
assert(
  "the repo's own conformance.mjs has 0 emitted verdict lines at column 0 despite 5 token occurrences",
  emittedVerdictLines(source).length === 0 && (source.match(/verdict:/g) ?? []).length === 5,
);
assert(
  "an indented verdict line is not an emission",
  emittedVerdictLines("  verdict: NOT-AN-EMISSION").length === 0,
);
assert(
  "expectations are re-derived per phase: responsive 1, run-all 1, behavioural 0",
  expectedVerdictLines("responsive") === 1 &&
    expectedVerdictLines("run-all") === 1 &&
    expectedVerdictLines("behavioural") === 0,
);
assert(
  "a completed single-suite log classifies as the run-all phase",
  classifyPhase(LOGS.singleSuite).name === "run-all" &&
    classifyPhase(LOGS.killProbe).name === "behavioural",
);

await Deno.remove(root, { recursive: true });

if (failures > 0) {
  console.error(`check-verdict-emission.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log("check-verdict-emission self-test: all assertions passed");
