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
//   run-all       full `run-all: <n> suites · assertions …` OR scoped             exactly 1
//                 `run-all: <n> suite(s) scanned (merged into …)`
//   responsive    its completion summary `responsive-check: <n> pages scanned …`   exactly 1
//   behavioural   no completion summary, PLUS probe-initiation evidence (the         exactly 0
//                 harness banner `Task <name> … scripts/conformance.mjs`), PLUS an
//                 explicit `--phase behavioural` from the caller, PLUS the kill
//                 EVIDENCE line written by scripts/kill-probe.sh
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
//   - the declaration alone was still a promise, not evidence (gendn-3t2): a truncated run-all log
//     carries the SAME banner as a probe, so declaring it `--phase behavioural` made it pass with
//     "owes 0". The gate now also REQUIRES the kill-evidence line that scripts/kill-probe.sh writes
//     — `kill-probe: signal=<NAME> exit=<code>` — and requires the recorded death to be a real
//     signal from the producer's own map with an exit status that AGREES with it (128 + signum,
//     e.g. TERM/143, KILL/137), because a probe that completed inside its kill window is not a
//     probe and a corrupted or hand-written line is not evidence either (that last part is
//     defence in depth: the same actor writes the evidence and runs the check, so it catches a
//     typo rather than tampering):
//       * a crashed/truncated run-all log carries no such line and FAILS, however it is declared;
//       * a wrapper run whose probe finished early records `signal=none` and FAILS;
//       * `signal=BANANA exit=137`, `signal=KILL exit=0` and `signal=TERM exit=137` all FAIL
//         (unknown signal name, and exit disagreeing with the signal);
//       * a probe that was actually killed carries `signal=KILL|TERM|…` and passes.
//     A signal leaves no trace in the command's OWN output, which is exactly why the wrapper writes
//     it: the evidence cannot be produced by a run that merely died.
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
// phase cannot be derived, an unsummarised log that was not declared as the probe, or a behavioural
// log without kill evidence; 2 = usage error (bad arguments or an unreadable log).
//
// Usage:
//   deno run --allow-read scripts/check-verdict-emission.mjs <log-path> [--phase <name>]
//   deno task check-verdict-emission /tmp/gate-conformance.log --phase run-all
//   deno task check-verdict-emission /tmp/gate-kill-probe.log --phase behavioural
//
// The behavioural log must have been produced by scripts/kill-probe.sh, which appends the required
// evidence line. A hand-run probe that bypasses the wrapper will be refused.

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
    // Both exact producer forms: a --page/--limit run reports the scan count AND the merged
    // report size. Do not accept a truncated or merely similar line as a completed run.
    summary:
      /^run-all: \d+ (?:suites · assertions \d+ pass \/ \d+ fail \/ \d+ blocked \(of \d+\)|suite\(s\) scanned \(merged into reports\/conformance\/results\.json; report now \d+ suites\))$/m,
    shape: "run-all: <n> suites · assertions … or run-all: <n> suite(s) scanned (merged into …)",
    command: "deno task conformance [--page <id>]",
  },
  responsive: {
    // The scoped form (gendn-jvh) reads `responsive-check: <n> page(s) scanned (merged into …)`
    // because a scoped run must not describe the REPORT's row count as pages scanned; both shapes
    // are the responsive phase completing, so recognising only the full one would misclassify a
    // scoped log and refuse it for missing kill evidence.
    summary: /^responsive-check: \d+ page\(?s\)? scanned\b/m,
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
// proof of the kill probe — the proof is the caller's `--phase behavioural` declaration PLUS the
// kill-evidence line below.
const PROBE_INITIATION = /^Task \S+\b[^\n]*scripts\/conformance\.mjs/m;

// EVIDENCE OF A KILL (gendn-3t2), written by scripts/kill-probe.sh as the last line of the probe
// log: `kill-probe: signal=<NAME|none> exit=<code>`. Its absence means the log was not produced by
// the probe wrapper, so it cannot be the probe — however it is declared. A recorded `signal=none`
// means the probe COMPLETED inside its kill window, which is a run, not a kill.
// Anchored to the END OF THE LOG, not the end of a line: the gendn-3t2 review found that an /m
// anchor with $ accepted a marker placed mid-log followed by more output, which breaks the property
// this evidence exists to establish — "the evidence is the last thing the log says". Trailing BLANK
// lines are tolerated (the producer prepends a separator unconditionally, and a final newline always
// leaves one); any non-blank line after the marker is not.
const KILL_EVIDENCE = /^kill-probe: signal=(\S+) exit=(\d+)$/;

// The producer's map (scripts/kill-probe.sh) and the shell convention that a signal death is
// reported as 128 + signum. Evidence that does not satisfy both is refused.
const SIGNAL_NUMBERS = { HUP: 1, INT: 2, QUIT: 3, ABRT: 6, KILL: 9, PIPE: 13, ALRM: 14, TERM: 15 };

/** null when the evidence is usable, otherwise the reason it is refused. */
export function killEvidenceProblem(kill) {
  if (!kill) {
    return "the behavioural phase requires KILL EVIDENCE and this log has none: expected a " +
      "`kill-probe: signal=<NAME> exit=<code>` line written by scripts/kill-probe.sh. A run " +
      "that crashed or was truncated looks identical to a probe in a log, so an unsummarised " +
      "log is only accepted as the probe when the wrapper recorded the kill — run the probe " +
      "through that script rather than declaring an arbitrary log as behavioural";
  }
  if (!kill.last) {
    return `the behavioural log's kill evidence is on line ${kill.lineNumber} but ${kill.linesAfter} ` +
      "non-blank line(s) of output follow it: the evidence must be the LAST thing the log says, " +
      "because a marker left behind mid-log proves the probe was still producing output after the " +
      "supposed kill";
  }
  if (kill.signal === "none") {
    return `the behavioural log records signal=none (exit ${kill.exit}): the probe COMPLETED ` +
      "inside its kill window, so it is a run and not a kill — there is no killed run to verify. " +
      "Give the probe less to do or leave the kill window long enough that it is still running";
  }
  const number = SIGNAL_NUMBERS[kill.signal];
  if (!number) {
    return `the behavioural log records signal=${kill.signal}, which is not a signal the producer ` +
      `writes (expected one of ${Object.keys(SIGNAL_NUMBERS).join("/")}) — evidence that no kill ` +
      "produced is not evidence";
  }
  const implied = 128 + number;
  if (kill.exit !== implied) {
    return `the behavioural log records signal=${kill.signal} exit=${kill.exit}, but a shell ` +
      `reports a signal death as 128 + ${number} = ${implied}: the line is internally ` +
      "inconsistent, so it is not evidence of a kill";
  }
  return null;
}

export function killEvidence(logText) {
  const lines = stripAnsi(logText).split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last < 0) return null;
  const tail = lines[last].trim();
  const m = tail.match(KILL_EVIDENCE);
  if (m) {
    return { signal: m[1], exit: Number(m[2]), line: tail, lineNumber: last + 1, last: true };
  }
  // Present, but the log says something else afterwards — reported specifically, because "no
  // evidence" and "evidence that is not last" are different mistakes.
  const idx = lines.findIndex((line) => KILL_EVIDENCE.test(line.trim()));
  if (idx !== -1) {
    const after = lines.slice(idx + 1).filter((line) => line.trim() !== "").length;
    return {
      signal: lines[idx].trim().match(KILL_EVIDENCE)[1],
      exit: Number(lines[idx].trim().match(KILL_EVIDENCE)[2]),
      line: lines[idx].trim(),
      lineNumber: idx + 1,
      last: false,
      linesAfter: after,
    };
  }
  return null;
}

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
      // Bounded BEFORE the value is consumed (gendn-yl1): a bare trailing `--phase` used to read
      // `undefined`, become `null`, and be treated as "no phase declared" — so the CLI silently
      // proceeded as though the flag were absent, and on a complete run-all log it derived run-all
      // and exited 0 without running the cross-check the caller asked for. It is a usage error.
      if (i + 1 >= args.length) {
        usage("--phase requires an argument");
        Deno.exit(2);
      }
      declared = args[++i];
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
  const kill = killEvidence(logText);

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
  if (derived.name === "behavioural") {
    console.log(
      `  kill-ev  : ${kill ? kill.line : "MISSING — run the probe through scripts/kill-probe.sh"}`,
    );
  }

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
    if (derived.name === "behavioural") {
      // The declaration is no longer the only evidence (gendn-3t2): the probe wrapper records how
      // the probe died, and a log without that record was not produced by the wrapper — a crashed
      // or truncated run carries the same banner, so without this a mis-declared run-all passed.
      const killProblem = killEvidenceProblem(kill);
      if (killProblem) problems.push(killProblem);
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
