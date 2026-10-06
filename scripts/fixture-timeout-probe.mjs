// fixture-timeout-probe.mjs — the deliberately slow fixture the runner's TIMEOUT path is tested on.
//
// This is NOT a test: it never passes. It exists so scripts/run-fixtures.test.mjs can prove that a
// fixture exceeding its bound is reported FAILED, that the runner still EXITS, and that the runner's
// group kill leaves no orphan behind (gendn-cp7 review: the first version killed only the task
// process and then blocked forever reading a pipe the orphan still held).
//
// It is named without the `test-` prefix ON PURPOSE: run-fixtures.mjs discovers every `test-*` task,
// so a probe named test-* would enrol itself into the aggregate and sleep there in CI.

// Record our own pid FIRST: the fixture checks liveness by PID rather than by matching a process
// pattern, because any pattern can also appear in the command line of the shell that launched the
// test (measured twice, once with the cleanup killing its own shell).
const pidFile = Deno.env.get("PROBE_PID_FILE") ?? "/tmp/gendn-fixture-timeout-probe.pid";
await Deno.writeTextFile(pidFile, String(Deno.pid));
console.log(
  `fixture-timeout-probe: pid ${Deno.pid} recorded in ${pidFile}; sleeping until the bound`,
);
// A pending TIMER, not a never-resolving top-level await: Deno reports "Top-level await promise
// never resolved" and exits for the latter, which would make the probe pass-by-exiting instead of
// hanging long enough to be timed out.
setInterval(() => {}, 60_000);
