#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
// check-verdict-emission.test.mjs — fail-closed regression tests for the verdict-emission check
// (gendn-aj6). Runs as `deno task test-verdict-emission` and as a CI step, so the check cannot
// silently stop failing: every FAIL case below asserts the exit code a landing gate would read.
//
// The log fixtures are byte-faithful to the real gate logs of the gendn-jeq landing — the summary
// line shape, the verdict line shape, and the two-space-indented detail lines (`fail-assertion`,
// `review-page`) are copied from /tmp/merger-l5-conformance.log and /tmp/merger-l5b-responsive.log,
// and the harness banner (with its real ANSI escapes) from /tmp/merger-l5-conformance.log line 2
// and /tmp/merger-l5b-kill.log.
//
// The three cases the reviewer of the first version of this check REQUIRED to be demonstrated as
// assertions, not prose, are marked [BLOCKER], [MAJOR] and [REAL CASE] below: the crashed/truncated
// run-all log must exit non-zero WITH and WITHOUT --phase, an arbitrary file must not pass as the
// behavioural probe, and a byte-real kill-probe log must still exit 0.
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
  return checkPath(logPath, extraArgs);
}

async function checkPath(logPath, extraArgs = []) {
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

// The landing-gate harness' banner, colour escapes included, as measured on disk.
const HARNESS_BANNER =
  "\x1b[0m\x1b[32mTask\x1b[0m \x1b[0m\x1b[36mconformance\x1b[0m deno run --allow-read " +
  "--allow-write --allow-run --allow-net --allow-env scripts/conformance.mjs";
const SUITE_LINE = (id, tested, pass, fail, blocked) =>
  `${id}  tested ${tested}/24  pass ${pass}  fail ${fail}  blocked ${blocked}`;

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
  // The landing gate's kill probe as it really looked: the harness banner, then SIGKILL.
  killProbe:
    "Task conformance deno run --allow-read scripts/conformance.mjs '--page' 'v149/webmcp'",
  // The same log byte-for-byte, colour escapes included (that is what /tmp/merger-l5b-kill.log is).
  killProbeRealBytes: `${HARNESS_BANNER} '--page' 'v149/webmcp'`,
  // [BLOCKER] A run-all that CRASHED or was TRUNCATED before its terminal verdict block: the
  // harness banner and fifty lines of suite output, then nothing — no summary, no verdict. The
  // first version of this check derived this as the behavioural phase, expected 0, found 0, and
  // printed PASS. The banner is present on purpose: a crashed run carries it too, which is why the
  // probe needs the caller's declaration on top of the banner.
  crashedRunAll: [
    "===== GATE conformance (start 13:14:12) =====",
    HARNESS_BANNER,
    ...Array.from({ length: 48 }, (_, i) => SUITE_LINE(`v14${i % 10}/page-${i}`, 19, 19, 0, 5)),
  ].join("\n"),
  // A log from something that is not the gate at all.
  notAGateLog: "make: entering directory '/build/other-project'\nnpm warn deprecated foo@1.0.0",
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
// [REAL CASE] The genuine kill probe must keep exiting 0 — a fix that also breaks the real case is
// not a fix. The probe log cannot prove its own phase (a crash looks identical in a log), so it is
// checked with the declaration the kill probe is documented to carry.
r = await checkLog(LOGS.killProbeRealBytes, ["--phase", "behavioural"]);
assert(
  "[REAL CASE] the byte-real kill-probe log (ANSI banner, no summary) passes with --phase behavioural",
  r.code === 0 && r.out.includes("phase    : behavioural") && r.out.includes("emitted  : 0") &&
    r.out.includes("expected : 0"),
);
r = await checkLog(LOGS.killProbe, ["--phase", "behavioural"]);
assert(
  "the plain-text kill probe passes with --phase behavioural and names its evidence",
  r.code === 0 && r.out.includes("Task conformance"),
);
r = await checkLog(LOGS.runAllNotGreen, ["--phase", "run-all"]);
assert("--phase run-all cross-checks the run-all log", r.code === 0);
r = await checkLog(LOGS.responsiveGreen, ["--phase", "responsive"]);
assert("--phase responsive cross-checks the responsive log", r.code === 0);
// Anchoring: documentation prose naming the token is NOT an emission (the gendn-aj6 defect).
r = await checkLog(
  `${LOGS.runAllNotGreen}\n// "  fail-assertion ...") or its "verdict:" prefix.`,
);
assert(
  "an indented prose line naming the token is not counted (anchored to column 0)",
  r.code === 0 && r.out.includes("emitted  : 1"),
);

// --- the check FAILS: the point of the instrument -------------------------------------------

// [BLOCKER] An unsummarised log is not silently the behavioural phase any more. The crashed log
// keeps the harness banner (a crash leaves it there), so it fails on the declaration it cannot
// supply; a truncated log whose banner never landed fails on the phase being underivable at all.
r = await checkLog(LOGS.crashedRunAll);
assert(
  "[BLOCKER] FAILS (exit 1, no PASS) on a crashed/truncated run-all log with NO --phase",
  r.code === 1 && !r.out.includes("PASS") && r.err.includes("no completion summary") &&
    r.err.includes("--phase behavioural"),
);
r = await checkLog(LOGS.crashedRunAll, ["--phase", "run-all"]);
assert(
  "[BLOCKER] FAILS (exit 1, no PASS) on the same crashed/truncated run-all log WITH --phase run-all",
  r.code === 1 && !r.out.includes("PASS") &&
    r.err.includes("no `run-all: <n> suites` completion") &&
    r.err.includes("was never verified"),
);
r = await checkLog(LOGS.crashedRunAll.replace(HARNESS_BANNER, ""));
assert(
  "[BLOCKER] FAILS (exit 1) on an unsummarised log with no banner either (phase UNKNOWN), with or without --phase",
  r.code === 1 && r.err.includes("UNKNOWN") &&
    (await checkLog(LOGS.crashedRunAll.replace(HARNESS_BANNER, ""), ["--phase", "run-all"]))
        .code === 1,
);
// [MAJOR] behavioural is no longer reachable from an arbitrary file: it needs BOTH the caller's
// declaration and probe-initiation evidence in the log.
const hosts = await checkPath("/etc/hosts", ["--phase", "behavioural"]);
assert(
  "[MAJOR] FAILS (exit 1) on /etc/hosts declared --phase behavioural (no probe-initiation evidence)",
  hosts.code === 1 && hosts.err.includes("probe-initiation evidence"),
);
const runnerSource = await checkPath(
  new URL("./conformance.mjs", import.meta.url).pathname,
  ["--phase", "behavioural"],
);
assert(
  "[MAJOR] FAILS (exit 1) on the runner's own source declared --phase behavioural",
  runnerSource.code === 1 && runnerSource.err.includes("probe-initiation evidence"),
);
r = await checkLog(LOGS.notAGateLog, ["--phase", "behavioural"]);
assert(
  "[MAJOR] FAILS (exit 1) on an unrelated build log declared --phase behavioural",
  r.code === 1 && r.err.includes("probe-initiation evidence"),
);
r = await checkLog(LOGS.killProbe);
assert(
  "[BLOCKER] the unsummarised probe log is REFUSED without a declaration (a crash has the same shape)",
  r.code === 1 && r.err.includes("--phase behavioural"),
);
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
r = await checkLog(`${LOGS.killProbe}\n${RUN_ALL_GREEN}`, ["--phase", "behavioural"]);
assert(
  "FAILS (exit 1) when the kill probe emits a verdict line (phase owes 0)",
  r.code === 1 && r.err.includes("emitted 1"),
);
r = await checkLog(LOGS.killProbe, ["--phase", "run-all"]);
assert(
  "FAILS (exit 1) on a kill-probe log mislabelled --phase run-all",
  r.code === 1 && r.err.includes("declared --phase run-all"),
);
assert(
  "the mislabelled-probe message reports BOTH expectations: the caller's (run-all owes 1) and the derived one (behavioural owes 0)",
  r.err.includes("--phase run-all (owes 1)") && r.err.includes("behavioural log (owes 0)"),
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
const noArgsErr = new TextDecoder().decode(noArgs.stderr);
assert(
  "the usage string lists the phases in the documented order (run-all|responsive|behavioural)",
  noArgsErr.includes("<log-path> [--phase run-all|responsive|behavioural]"),
);
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
  classifyPhase(LOGS.singleSuite).name === "run-all",
);
assert(
  "[BLOCKER] an unsummarised log with no probe banner classifies as unknown, never as behavioural",
  classifyPhase("make: *** [build] Error 1").name === "unknown" &&
    classifyPhase(LOGS.crashedRunAll.replace(HARNESS_BANNER, "")).name === "unknown",
);
assert(
  "[MAJOR] the byte-real kill probe classifies as behavioural from its ANSI-coloured banner",
  classifyPhase(LOGS.killProbeRealBytes).name === "behavioural" &&
    classifyPhase(LOGS.killProbeRealBytes).evidence.startsWith("Task conformance"),
);

// --- the wiring says where real runner output is read ---------------------------------------

const ci = await Deno.readTextFile(
  new URL("../.github/workflows/ci.yml", import.meta.url).pathname,
);
assert(
  "the CI step names its own scope (it self-tests the CHECKER, it is not evidence about the runner)",
  /name: Verdict-emission checker self-test \(validates the checker/.test(ci) &&
    ci.includes("run: deno task test-verdict-emission"),
);
const claude = await Deno.readTextFile(new URL("../CLAUDE.md", import.meta.url).pathname);
assert(
  "CLAUDE.md says the check meets REAL gate logs and that the probe carries --phase behavioural",
  /check-verdict-emission <log>[^\n]*LANDING GATE/.test(claude) &&
    /test-verdict-emission[^\n]*CHECKER/.test(claude) &&
    /--phase behavioural[^\n]*kill probe|kill probe[^\n]*--phase behavioural/.test(claude),
);

await Deno.remove(root, { recursive: true });

if (failures > 0) {
  console.error(`check-verdict-emission.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log("check-verdict-emission self-test: all assertions passed");
