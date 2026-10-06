// fixture-detach-probe.mjs — the probe that gendn-ebf's descendant sweep is tested on.
//
// It starts a DETACHED child (`setsid --fork`), which puts that child in its OWN session and therefore
// outside the fixture's process group — exactly the descendant a group kill cannot reach. The child
// records ITS OWN pid (the shell writes $$ and then execs sleep, so the recorded pid IS the sleeper),
// and then this fixture either:
//
//   PROBE_MODE=hang  — waits past the fixture bound, so run-fixtures.mjs times it out and must sweep
//                      the detached child by the inherited GENDN_FIXTURE_TOKEN; or
//   PROBE_MODE=exit  — returns promptly, the NEGATIVE CONTROL that pins "on success the runner does
//                      not touch a fixture's children" (the detached child must still be alive).
//
// It is deliberately NOT a `test-*` task: discovery would enrol it into the aggregate, where the hang
// mode would sleep for the full bound (and the exit mode would leak a sleeper) in CI.
//
// BOUND (gendn-vxp): this is a TEST HARNESS, not something to run interactively. HANG mode
// self-limits to PROBE_HANG_MS (default 120000 ms, ~27x the tests' 4.5s fixture timeout; NOTE the runner's default fixture timeout is 300s, so a manual default-timeout run ends by natural exit and no sleeper is spawned without a pid file) and then
// exits on its own. A sleeper is spawned ONLY when PROBE_CHILD_PID_FILE is set, so every sleeper
// is attributable by a recorded pid; without it the probe refuses to spawn one and says so.
// (EXIT mode's sleeper is the negative control and is reaped by the test's finally, by pid.)
//
// WORST-CASE PROCESS COUNT — bounded, not a fork bomb: this invocation starts exactly ONE setsid
// child, which forks exactly ONE sleeper, then no other processes. Counting the runner, task shells,
// this script, and the transient setsid launcher gives at most 10 command-launched processes under
// the current task chain (plus the test harness parent), not an unbounded recursion. The test kills
// the detached sleeper by its recorded pid in a `finally`. The earlier unbounded proof in this area
// reached 1292 processes / 6 GB before the VM reaper killed it; this probe is intentionally finite.

const ownPidFile = Deno.env.get("PROBE_PID_FILE");
const childPidFile = Deno.env.get("PROBE_CHILD_PID_FILE");
const mode = Deno.env.get("PROBE_MODE") ?? "hang";

if (ownPidFile) await Deno.writeTextFile(ownPidFile, String(Deno.pid));

// Pass the FULL environment explicitly rather than relying on merge semantics, because the detached
// child MUST inherit GENDN_FIXTURE_TOKEN — that token is the only thing that makes it attributable.
const env = { ...Deno.env.toObject(), PROBE_CHILD_PID_FILE: childPidFile ?? "" };
let child = null;
if (childPidFile) {
  child = new Deno.Command("setsid", {
    args: ["--fork", "sh", "-c", 'printf %s "$$" > "$PROBE_CHILD_PID_FILE"; exec sleep 600'],
    stdout: "null",
    stderr: "null",
    env,
  }).spawn();
} else {
  console.log(
    "fixture-detach-probe: PROBE_CHILD_PID_FILE unset; refusing to spawn an unrecorded detached sleeper",
  );
}
console.log(`fixture-detach-probe: mode=${mode} own=${Deno.pid} detached=${child?.pid ?? "none"}`);

// Wait until the sleeper has recorded its own pid, so the test's pid assertions are never racing the
// child's startup. Bounded, so a broken probe fails fast instead of sleeping for the whole bound.
if (childPidFile) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = await Deno.readTextFile(childPidFile).catch(() => "");
    if (Number(text.trim()) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

if (mode === "hang") {
  // A pending TIMER-backed promise, not a never-resolving top-level await: Deno reports "Top-level await promise
  // never resolved" and exits for the latter, which would make the probe pass-by-exiting.
  // Self-limited (gendn-vxp): exits on its own after PROBE_HANG_MS so a manual run cannot leak.
  const hangMs = Number(Deno.env.get("PROBE_HANG_MS")) || 120_000;
  await new Promise((resolve) => setTimeout(resolve, hangMs));
}
