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
//   phase         recognised by                                                    owes
//   run-all       its completion summary `run-all: <n> suites …`                   exactly 1
//   responsive    its completion summary `responsive-check: <n> pages scanned …`   exactly 1
//   behavioural   no completion summary, PLUS probe-initiation evidence (the         exactly 0
//                 harness banner `Task <name> … scripts/conformance.mjs`) PLUS an
//                 explicit `--phase behavioural` from the caller
//
// The expectation is a function of the phase's OWN evidence, not a number handed down: the runner
// emits its verdict once per phase from a single terminal if/else whose two arms are mutually
// exclusive, so a phase that reached its summary line owes exactly one line and a phase that never
// reached it owes none.
//
// WHY BEHAVIOURAL IS NOT A FALLBACK (gendn-aj6 review): an unsummarised log used to default to the
// behavioural phase, which owes 0 — so a run-all that CRASHED or was TRUNCATED before its terminal
// verdict block (suite output, no summary, no verdict) derived as behavioural, expected 0, found 0,
// and passed. An unsummarised log is now UNKNOWN and fails closed, and behavioural is accepted only
// when the caller declares it and the log carries probe-initiation evidence:
//   - a bare `--phase behavioural /etc/hosts`, or the runner's own source, FAILS: neither is a gate
//     log, so neither carries the banner;
//   - the declaration is load-bearing, not decorative: a SIGKILLed probe and a run that crashed at
//     the same point have the SAME log shape (banner, no summary, no verdict — a signal leaves no
//     trace in a log), so the caller's `--phase behavioural` is the assertion that this file is the
//     probe rather than a run that died before its terminal block. The check does not guess it, and
//     it demands the banner as corroboration, so an arbitrary file can never be checked as the probe.
//
// A COMPLETED single-suite run (`deno task conformance --page <id>`, the landing gate's behavioural
// accumulation runs) takes the run-all arm and prints `run-all: 1 suites …`, so it is a run-all
// phase log and owes exactly 1 (measured in the gendn-jeq landing logs). Only the SIGKILLed probe
// log has no summary and owes 0.
//
// `--phase <name>` cross-checks the caller's label against the phase derived from the log, so a log
// cannot be checked against the wrong phase: the kill probe's log checked as `--phase run-all`
// FAILS (0 emissions where run-all owes 1), and a completed `--page` run checked as `--phase
// behavioural` FAILS (1 emission where the behavioural probe owes 0). A mismatch reports BOTH
// expectations — the caller's phase and the derived one — because the caller asked about theirs.
//
// WHERE IT RUNS: the landing gate runs this against the REAL log of the phase it just ran, which is
// the only place a regression in the runner's own output can be observed. `deno task
// test-verdict-emission` (and the CI step that calls it) exercises the CHECKER against synthetic
// logs: it is a property of this script and NOT evidence about the runner — if scripts/conformance.mjs
// stopped printing `verdict:` altogether, only a real-log landing run would notice.
//
// Exit codes: 0 = exactly the phase's expected emission; 1 = mismatch, an unsummarised log whose
// phase cannot be derived, an unsummarised log that was not declared as the probe, or an empty log;
// 2 = usage error (bad arguments or an unreadable log).
//
// Usage:
//   deno run --allow-read scripts/check-verdict-emission.mjs <log-path> [--phase <name>]
//   deno task check-verdict-emission /tmp/gate-conformance.log --phase run-all
//   deno task check-verdict-emission /tmp/gate-kill-probe.log --phase behavioural

const VERDICT_LINE = /^verdict:/;

// The landing gate's harness writes an ANSI-coloured `Task <name> <command>` banner at the head of
// every log it captures — measured on the gendn-jeq landing logs, where the run-all log, the
// responsive log, the completed `--page` logs and the kill probe all carry it. Normalising the
// escapes away first makes the anchors below match the real bytes (`/tmp/merger-l5b-kill.log` is a
// single coloured line) instead of only the plain-text fixtures.
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

// The runner prints its verdict lines at column 0. Indented occurrences are derived detail
// (`  fail-assertion`, `  review-page`) or documentation prose, never an emission — which is exactly
// the distinction the old whole-file token grep could not make.
export function emittedVerdictLines(logText) {
  return logText.split("\n").filter((line) => VERDICT_LINE.test(line));
}

// Each phase's expectation is derived from whether the phase carries a completion summary — i.e.
// whether the run reached the point at which its terminal verdict block lives. The key order is the
// order the CLI documents (run-all|responsive|behavioural).
const PHASES = {
  "run-all": {
    summary: /^run-all: \d+ suites\b/m,
    shape: "run-all: <n> suites",
    command: "deno task conformance [--page <id>]",
  },
  responsive: {
    summary: /^responsive-check: \d+ pages scanned\b/m,
    shape: "responsive-check: <n> pages scanned",
    command: "deno task responsive",
  },
  behavioural: {
    summary: null,
    shape: null,
    command: "the kill probe (a run killed before its terminal verdict block)",
  },
};

export const PHASE_NAMES = Object.keys(PHASES);

// The phase of a log that shows PROBE INITIATION but no completion. It is not silently treated as
// the behavioural probe: see the header — a crashed run and a killed probe share this shape, so the
// caller has to declare that this log is the probe.
export const PHASE_UNKNOWN = "unknown";

// Probe-initiation evidence: the harness banner naming a task that runs the conformance runner. A
// run that crashed carries the same banner, which is why this is evidence of a GATE LOG and not
// proof of the kill probe — the proof is the caller's `--phase behavioural` declaration.
const PROBE_INITIATION = /^Task \S+\b[^\n]*scripts\/conformance\.mjs/m;

export function classifyPhase(logText) {
  const text = stripAnsi(logText);
  for (const [name, phase] of Object.entries(PHASES)) {
    const match = phase.summary ? text.match(phase.summary) : null;
    if (match) return { name, evidence: match[0].trim() };
  }
  const probe = text.match(PROBE_INITIATION);
  if (probe) return { name: "behavioural", evidence: probe[0].trim() };
  return { name: PHASE_UNKNOWN, evidence: null };
}

export function expectedVerdictLines(phaseName) {
  const phase = PHASES[phaseName];
  if (!phase) throw new Error(`unknown phase: ${phaseName}`);
  // Re-derived per phase, never carried: one verdict block reached => its single terminal if/else
  // prints exactly one line; never reached (killed) => no line.
  return phase.summary ? 1 : 0;
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
    logText = stripAnsi(await Deno.readTextFile(logPath));
  } catch (error) {
    usage(`cannot read ${logPath}: ${error.message}`);
    Deno.exit(2);
  }

  const emitted = emittedVerdictLines(logText);
  const derived = classifyPhase(logText);
  const declaredExpected = declared === null ? null : expectedVerdictLines(declared);
  const derivedKnown = derived.name !== PHASE_UNKNOWN;
  const expected = derivedKnown ? expectedVerdictLines(derived.name) : null;

  console.log(`check-verdict-emission: ${logPath}`);
  console.log(`  phase    : ${derived.name}`);
  console.log(
    `  evidence : ${
      derived.evidence ?? "none — no completion summary and no probe-initiation banner"
    }`,
  );
  console.log(`  command  : ${derivedKnown ? PHASES[derived.name].command : "unknown phase"}`);
  console.log(`  emitted  : ${emitted.length}`);
  for (const line of emitted) console.log(`    | ${line}`);
  console.log(
    derivedKnown
      ? `  expected : ${expected} (re-derived from the ${derived.name} phase)`
      : "  expected : — the phase cannot be derived from this log, so nothing is verifiable",
  );
  if (declared !== null) console.log(`  declared : ${declared} (owes ${declaredExpected})`);

  const problems = [];
  if (logText.trim() === "") problems.push("the log is empty: no phase to verify");

  if (!derivedKnown) {
    // The blocker: an unsummarised log used to default to behavioural and pass on 0 == 0.
    problems.push(
      "this log is UNKNOWN: it carries neither a completion summary (" +
        PHASE_NAMES.filter((n) => PHASES[n].shape).map((n) => `\`${PHASES[n].shape}\``).join(
          " / ",
        ) +
        ") nor probe-initiation evidence (the harness' " +
        "`Task <name> … scripts/conformance.mjs` banner)" +
        (declared === null
          ? ""
          : `, so it cannot be verified as --phase ${declared} (owes ${declaredExpected})`) +
        " — a run that crashed, was killed, or was truncated before its terminal verdict block " +
        "must not pass",
    );
  } else if (derived.name === "behavioural" && declared !== "behavioural") {
    problems.push(
      declared === null
        ? "this log has no completion summary, only probe-initiation evidence: an unsummarised log " +
          "is accepted as the kill probe only when the caller declares it with --phase behavioural " +
          "— a run that crashed or was truncated before its terminal verdict block has the same " +
          "shape (banner, no summary, no verdict) and nothing in a log tells them apart, so do not " +
          `re-check such a run as the probe — evidence: ${derived.evidence}`
        : `declared --phase ${declared} (owes ${declaredExpected}) but this is a behavioural log ` +
          `(owes 0): this log has no \`${PHASES[declared].shape}\` completion summary, so the ` +
          `${declared} phase's terminal verdict block was never verified — the kill probe looks ` +
          "the same in a log and is accepted only when the caller declares --phase behavioural " +
          `— evidence: ${derived.evidence}`,
    );
  } else {
    if (declared !== null && declared !== derived.name) {
      problems.push(
        `declared --phase ${declared} (owes ${declaredExpected}) but this is a ${derived.name} log ` +
          `(owes ${expected}) — evidence: ${derived.evidence}`,
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
  }

  if (problems.length) {
    console.error(`\nFAIL — ${problems.length} verdict-emission problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    Deno.exit(1);
  }
  console.log(`\nPASS — the ${derived.name} phase emitted exactly ${expected} verdict line(s).`);
}

if (import.meta.main) await main();
