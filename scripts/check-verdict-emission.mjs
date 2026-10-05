#!/usr/bin/env -S deno run --allow-read
// check-verdict-emission.mjs — the verdict-emission check (sibling of check-routes.mjs,
// validate-artifacts.mjs, and check-conformance.mjs): given ONE gate log, assert that the
// conformance/responsive runner's end-of-run verdict block emitted exactly as many `verdict:` lines
// as the phase that produced the log owes.
//
// WHY IT READS THE LOG AND NOT THE SOURCE (gendn-aj6): the landing gate used to assert that the
// verdict block still prints with `grep -c "verdict:" scripts/conformance.mjs` == 4. That instrument
// was wrong twice over:
//   1. TRUE FOR THE WRONG REASON — the 5th occurrence on main 51514d32 was line 417, a doc comment
//      quoting the literal prefix, so the check fired on documentation rather than on an emission;
//   2. AN EXPECTED VALUE NO RUN EMITS — the four emission sites are mutually exclusive per phase
//      (the responsive arm prints exactly one of REVIEW-REQUIRED/GREEN; the run-all arm prints
//      exactly one of NOT-GREEN/GREEN), so a fully green gate emits TWO verdict lines across two
//      logs and "must be 4" is a source count that no observable run can satisfy.
//
// WHAT IT ASSERTS — emitted `verdict:` lines at column 0 of ONE log, against the expectation
// re-derived from that log's phase (never a constant carried over from a previous landing):
//
//   phase         recognised by the phase's summary line, which the runner prints immediately
//                 before its terminal verdict block                            owes
//   responsive    `responsive-check: <n> pages scanned ...`                   exactly 1
//   run-all       `run-all: <n> suites ...`                                   exactly 1
//   behavioural   neither summary — the landing gate's kill probe, killed before it reached its
//                 terminal verdict block, so a verdict line here is a contradiction
//                                                                            exactly 0
//
// The expectation is a function of the phase's OWN evidence, not a number handed down: the runner
// emits its verdict once per phase from a single terminal if/else whose two arms are mutually
// exclusive, so a phase that reached its summary line owes exactly one line and a phase that never
// reached it owes none.
//
// A COMPLETED single-suite run (`deno task conformance --page <id>`, the landing gate's behavioural
// accumulation runs) takes the run-all arm and prints `run-all: 1 suites ...`, so it is a run-all
// phase log and owes exactly 1 (measured in the gendn-jeq landing logs). Only the SIGKILLed probe
// log has no summary and owes 0.
//
// `--phase <name>` is an optional cross-check of the caller's label against the phase derived from
// the log, so a log cannot be checked against the wrong phase: the kill probe's log checked as
// `--phase run-all` FAILS (0 emissions where the run-all phase owes 1), and a completed `--page` run
// checked as `--phase behavioural` FAILS (1 emission where the behavioural probe owes 0).
//
// It never guesses whether the input is a log: an input with no completion summary and no verdict
// line has the killed-probe shape and is consistent (0 owes 0). What it does make impossible is a
// verdict being counted from prose (the column-0 anchor) or from the wrong phase (the cross-check).
//
// Exit codes: 0 = exactly the phase's expected emission; 1 = mismatch (missing, extra, or an empty
// log); 2 = usage error (bad arguments or an unreadable log).
//
// Usage:
//   deno run --allow-read scripts/check-verdict-emission.mjs <log-path> [--phase <name>]
//   deno task check-verdict-emission /tmp/gate-conformance.log --phase run-all

const VERDICT_LINE = /^verdict:/;

// The runner prints its verdict lines at column 0. Indented occurrences are derived detail
// (`  fail-assertion`, `  review-page`) or documentation prose, never an emission — which is exactly
// the distinction the old whole-file token grep could not make.
export function emittedVerdictLines(logText) {
  return logText.split("\n").filter((line) => VERDICT_LINE.test(line));
}

// Each phase's expectation is derived from whether the phase carries a completion summary — i.e.
// whether the run reached the point at which its terminal verdict block lives.
const PHASES = {
  responsive: {
    summary: /^responsive-check: \d+ pages scanned\b/m,
    command: "deno task responsive",
  },
  "run-all": {
    summary: /^run-all: \d+ suites\b/m,
    command: "deno task conformance [--page <id>]",
  },
  behavioural: {
    summary: null,
    command: "the kill probe (a run killed before its terminal verdict block)",
  },
};

export const PHASE_NAMES = Object.keys(PHASES);

export function classifyPhase(logText) {
  for (const [name, phase] of Object.entries(PHASES)) {
    const match = phase.summary ? logText.match(phase.summary) : null;
    if (match) return { name, evidence: match[0].trim() };
  }
  return { name: "behavioural", evidence: null };
}

export function expectedVerdictLines(phaseName) {
  // Re-derived per phase, never carried: one verdict block reached => its single terminal if/else
  // prints exactly one line; never reached (killed) => no line.
  return PHASES[phaseName].summary ? 1 : 0;
}

function usage(message) {
  if (message) console.error(`check-verdict-emission: ${message}`);
  console.error(
    "usage: deno run --allow-read scripts/check-verdict-emission.mjs <log-path> [--phase " +
      PHASE_NAMES.join("|") + "]",
  );
}

async function main() {
  const args = Deno.args;
  let logPath = null;
  let declared = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--phase") {
      declared = args[++i] ?? null;
      continue;
    }
    if (logPath === null && !args[i].startsWith("-")) {
      logPath = args[i];
      continue;
    }
    usage(`unexpected argument: ${args[i]}`);
    Deno.exit(2);
  }
  if (logPath === null) {
    usage("a log path is required");
    Deno.exit(2);
  }
  if (declared !== null && !PHASE_NAMES.includes(declared)) {
    usage(`unknown phase: ${declared}`);
    Deno.exit(2);
  }

  let logText;
  try {
    logText = await Deno.readTextFile(logPath);
  } catch (error) {
    usage(`cannot read ${logPath}: ${error.message}`);
    Deno.exit(2);
  }

  const emitted = emittedVerdictLines(logText);
  const derived = classifyPhase(logText);
  const expected = expectedVerdictLines(derived.name);

  console.log(`check-verdict-emission: ${logPath}`);
  console.log(
    `  phase    : ${derived.name}` +
      (derived.evidence
        ? ` (summary "${derived.evidence}")`
        : " (no completion summary: killed before its terminal verdict block)"),
  );
  console.log(`  command  : ${PHASES[derived.name].command}`);
  console.log(`  emitted  : ${emitted.length}`);
  for (const line of emitted) console.log(`    | ${line}`);
  console.log(`  expected : ${expected} (re-derived from the ${derived.name} phase)`);

  const problems = [];
  if (logText.trim() === "") problems.push("the log is empty: no phase to verify");
  if (declared !== null && declared !== derived.name) {
    problems.push(
      `declared --phase ${declared} but this is a ${derived.name} log` +
        (derived.evidence ? ` (summary "${derived.evidence}")` : " (no completion summary)") +
        `, and the ${derived.name} phase owes ${expected} verdict line(s)`,
    );
  }
  if (emitted.length !== expected) {
    const reason = emitted.length === 0
      ? "the terminal verdict block is MISSING from this log"
      : `${emitted.length} verdict lines: the phase prints exactly ${expected}`;
    problems.push(
      `${derived.name} owes ${expected} verdict line(s), emitted ${emitted.length} — ${reason}`,
    );
  }

  if (problems.length) {
    console.error(`\nFAIL — ${problems.length} verdict-emission problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    Deno.exit(1);
  }
  console.log(`\nPASS — the ${derived.name} phase emitted exactly ${expected} verdict line(s).`);
}

if (import.meta.main) await main();
