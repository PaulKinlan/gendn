// scripts/run-fixtures.test.mjs — the fixture for the fixture RUNNER (gendn-cp7 review).
//
// WHY: the first version of run-fixtures.mjs detected a timed-out fixture and then hung on it. It
// applied FIXTURE_TIMEOUT_MS by killing the `deno task` process only, which orphaned the Deno script
// that task had spawned; the orphan inherited the stdout/stderr PIPES, so awaiting them blocked
// forever. The timeout was identified and the runner could not unblock itself — the worst place for
// that bug, because this runner exists to make guards enforced and it runs on the CI path, where a
// hang is a multi-hour job rather than a 300s failure.
//
// This test pins the fixed behaviour: a fixture that sleeps past a shortened bound is reported as a
// TIMEOUT, the runner EXITS promptly, and NOTHING is left behind. A second case pins the naming
// decision that keeps the probe out of the aggregate.
//
// Run: deno task test-run-fixtures

const REPO = new URL("..", import.meta.url).pathname;
const PROBE = "fixture-timeout-probe";
const PROBE_SCRIPT = "fixture-timeout-probe.mjs";
const BOUND_MS = 2000;

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

// The probe records its own pid, and liveness is checked BY PID. Pattern-matching was tried first and
// removed after it matched this test's own `bash -c` command line twice — the second time the cleanup
// SIGKILLed the shell running the test (exit 137). A pid cannot be confused with a string.
const pidFile = `${await Deno.makeTempDir({ prefix: "run-fixtures-test-" })}/probe.pid`;

function alive(pid) {
  try {
    Deno.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch {
    return false;
  }
}

async function recordedPid() {
  const text = await Deno.readTextFile(pidFile).catch(() => "");
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function runRunner(args, env = {}) {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      `${REPO}scripts/run-fixtures.mjs`,
      ...args,
    ],
    cwd: REPO,
    env: { ...Deno.env.toObject(), ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
}

try {
  await Deno.remove(pidFile).catch(() => {});

  // 1. A fixture that sleeps past a shortened bound: reported TIMEOUT, runner exits promptly.
  const started = Date.now();
  const timed = await runRunner(["--tasks", PROBE], {
    GENDN_FIXTURE_TIMEOUT_MS: String(BOUND_MS),
    PROBE_PID_FILE: pidFile,
  });
  const elapsed = Date.now() - started;
  const out = new TextDecoder().decode(timed.stdout);
  const err = new TextDecoder().decode(timed.stderr);
  assert(
    "a fixture sleeping past the bound is reported TIMEOUT and exits non-zero",
    timed.code !== 0 && /TIMEOUT/.test(out),
    `exit=${timed.code} ${out.trim().split("\n").pop()?.slice(0, 100)}`,
  );
  // The bound plus the kill grace; anywhere near a full hang (the old behaviour) fails this.
  assert(
    "the runner EXITS within seconds of the bound (the old version hung forever on the orphan)",
    elapsed < BOUND_MS + 12_000,
    `${elapsed}ms for a ${BOUND_MS}ms bound`,
  );
  assert(
    "...and it says the fixture exceeded the bound",
    new RegExp(`exceeded ${BOUND_MS}ms`).test(out),
    out.split("\n").find((l) => l.includes("TIMEOUT"))?.trim() ?? "",
  );
  assert(
    "...and no kill failure was reported",
    !/group kill of .* failed/.test(err),
    err.trim().slice(0, 120),
  );

  // 2. NOTHING left behind: the process-group kill must take the task AND the script it spawned.
  await new Promise((r) => setTimeout(r, 500));
  const pid = await recordedPid();
  assert(
    "the probe actually started and recorded its pid",
    pid !== null,
    pid === null ? `no pid in ${pidFile}` : `pid ${pid}`,
  );
  assert(
    "no probe process is left behind by the group kill",
    pid !== null && !alive(pid),
    pid === null ? "probe never started" : `pid ${pid} alive=${alive(pid)}`,
  );

  // 3. The probe is deliberately NOT a `test-*` task, so discovery never enrols it into the
  //    aggregate (which would sleep in CI). --list is the cheap way to pin that.
  const listed = await runRunner(["--list"]);
  const listOut = new TextDecoder().decode(listed.stdout);
  assert(
    "the sleeping probe is NOT discovered by the aggregate (it has no test- prefix)",
    listed.code === 0 && !listOut.includes(PROBE),
    listOut.split("\n").slice(0, 3).join(" | "),
  );
  assert(
    "...while the real fixtures ARE discovered",
    /test-vendor-fonts/.test(listOut) && /test-fetch-bounded/.test(listOut),
    "",
  );
} finally {
  // Leave no probe behind even if an assertion threw partway through — by exact pid.
  const pid = await recordedPid();
  if (pid !== null && alive(pid)) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await Deno.remove(pidFile).catch(() => {});
}

if (failures > 0) {
  console.error(`run-fixtures.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`run-fixtures fixture: all ${passed} assertions passed`);
