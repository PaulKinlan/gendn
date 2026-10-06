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

import { isAggregateTaskCommand, recursionRefusal, RUN_MARKER } from "./run-fixtures.mjs";

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

// ---- gendn-0bm: the recursion guard must not be keyed to a NAME ---------------------------------
// A scratch tree with a RENAMED aggregate, so no name-keyed exclusion can cover it. Two variants of
// the runner are placed there: the real one, and a copy with the marker guard removed — which is
// today's name-only protection reproduced, i.e. the DETECTOR PROOF, because the fixture must fail
// against that variant or it is not testing the thing 0bm exists for.

async function scratchTree({ stripMarkerGuard }) {
  const dir = await Deno.makeTempDir({ prefix: "run-fixtures-scratch-" });
  await Deno.mkdir(`${dir}/scripts`, { recursive: true });
  let runner = await Deno.readTextFile(`${REPO}scripts/run-fixtures.mjs`);
  if (stripMarkerGuard) {
    // Strip ONLY the refusal, not the marker CONSTANT: slicing from the comment also removed
    // `const RUN_MARKER`, so the variant crashed with a ReferenceError at level 1 and the detector
    // proof measured "no recursion" for the wrong reason (measured, then fixed).
    const start = runner.indexOf("const insideRun =");
    const end = runner.indexOf("const repoRoot =");
    if (start === -1 || end === -1) throw new Error("cannot locate the marker guard to strip");
    runner = runner.slice(0, start) + runner.slice(end);
    // Verify the REFUSAL is gone while the marker CONSTANT survived — checking for the message text
    // alone was wrong: the phrase legitimately survives in a comment, and an earlier narrower slice
    // removed the constant and made the variant crash rather than recurse.
    if (runner.includes("if (insideRun)") || !runner.includes("const RUN_MARKER")) {
      throw new Error(
        "the strip is not the name-only protection (refusal gone, marker constant kept)",
      );
    }
  }
  await Deno.writeTextFile(`${dir}/scripts/run-fixtures.mjs`, runner);
  await Deno.writeTextFile(`${dir}/scripts/noop.mjs`, 'console.log("noop fixture ok");\n');
  // The aggregate is deliberately named something ELSE: that is the whole point.
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify(
      {
        tasks: {
          "test-everything":
            "deno run --allow-read --allow-write --allow-run --allow-env scripts/run-fixtures.mjs",
          "test-noop": "deno run scripts/noop.mjs",
        },
      },
      null,
      2,
    ) + "\n",
  );
  return dir;
}

function runIn(dir, args) {
  return new Deno.Command(Deno.execPath(), {
    args: ["task", "test-everything", ...args],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
    // This fixture ITSELF runs inside the aggregate, so it carries the marker; a deliberate
    // TOP-LEVEL run of the scratch aggregate must clear it (an empty value means "not inside a
    // run", which is why the guard tests truthiness rather than presence).
    env: { [RUN_MARKER]: "" },
  }).output();
}

const discoveryBanners = (text) => (text.match(/discovered \d+ test-\* task\(s\)/g) ?? []).length;

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
    env: { ...Deno.env.toObject(), [RUN_MARKER]: "", ...env },
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

  // ---- gendn-0bm: recursion is refused by ACT, not by name -------------------------------------

  // TRIGGER 1 — default discovery: the renamed aggregate IS discovered (no name-keyed entry covers
  // it), the runner invokes it, and the nested run refuses instead of recursing.
  {
    const tree = await scratchTree({ stripMarkerGuard: false });
    try {
      const r = await runIn(tree, []);
      const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
      assert(
        "0bm discovery trigger: a RENAMED aggregate does not recurse (nested run REFUSES, outer non-zero)",
        r.code !== 0 && /already inside a fixture run/.test(out) && discoveryBanners(out) === 1,
        `exit=${r.code}, discovery banners=${discoveryBanners(out)}`,
      );
    } finally {
      await Deno.remove(tree, { recursive: true }).catch(() => {});
    }
  }

  // TRIGGER 2 — --tasks: this path bypasses discovery AND the exclusion list entirely.
  {
    const tree = await scratchTree({ stripMarkerGuard: false });
    try {
      const r = await runIn(tree, ["--tasks", "test-everything"]);
      const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
      // No discovery banner is expected here: the --tasks entry is refused by CONTENT before
      // discovery runs, which is the point (fail fast, and independently of any name).
      assert(
        "0bm --tasks trigger: naming the aggregate as a fixture is REFUSED, not recursed",
        r.code !== 0 && /would run this aggregate recursively/.test(out) && !/PASS test-/.test(out),
        `exit=${r.code}, refusal=${/recursively/.test(out)}`,
      );
    } finally {
      await Deno.remove(tree, { recursive: true }).catch(() => {});
    }
  }

  // DETECTOR PROOF as a DECISION TABLE rather than a fork bomb. This deliberately does NOT run the
  // unguarded recursion: an earlier version did, and it could not be bounded — every level spawns its
  // children with setsid, so each level is its own process group and the root group kill cannot reach
  // descendants; it grew to 1292 processes / 6 GB and the VM's reaper killed it. A test that runs in
  // CI must not contain an unbounded side effect, so the proof is a finite table over the DECISION:
  //
  //   1. inside a fixture run + DISCOVERY mode  -> refused (this is the recursion)
  //   2. inside a fixture run + narrowed --tasks -> allowed (the fixture that tests this runner does
  //      exactly that; the first version refused it — a false positive the fixture caught)
  //   3. a --tasks entry whose COMMAND invokes this runner -> refused by content, marker or not,
  //      which is what makes it rename-proof and argument-proof
  //   4. top level, no marker -> runs
  {
    const table = [
      [
        { [RUN_MARKER]: "12345" },
        { discovery: true },
        "refuse",
        "inside a fixture run + discovery",
      ],
      [
        { [RUN_MARKER]: "12345" },
        { discovery: false },
        null,
        "inside a fixture run + narrowed --tasks (legitimate)",
      ],
      [{}, { discovery: true }, null, "top level, no marker"],
      [{}, { discovery: false }, null, "top level, narrowed --tasks"],
    ];
    for (const [env, mode, want, why] of table) {
      const got = recursionRefusal(env, mode);
      assert(
        `0bm decision: ${why} -> ${want === null ? "runs" : "refuses"}`,
        want === null ? got === null : typeof got === "string" && got.includes("already inside"),
        JSON.stringify(got),
      );
    }
    assert(
      "0bm: the aggregate is detected by its COMMAND, not its name",
      isAggregateTaskCommand("deno run --allow-read scripts/run-fixtures.mjs") &&
        !isAggregateTaskCommand("deno run scripts/vendor-fonts.test.mjs"),
    );
    // The name-keyed protection alone is insufficient, stated as the property it lacks.
    const runnerSource = await Deno.readTextFile(`${REPO}scripts/run-fixtures.mjs`);
    // Tolerates both shapes deno fmt produces: ["name", …] on one line and the name on its own
    // line after a bare bracket (an earlier regex only matched the first and reported "excluded: []").
    const excludedNames = [...runnerSource.matchAll(/^\s*\[?\s*"(test-[a-z-]+)"/gm)].map((m) =>
      m[1]
    );
    assert(
      "0bm: the name-keyed exclusion covers only known names, which is why the marker is the guard",
      excludedNames.includes("test-fixtures") && !excludedNames.includes("test-everything"),
      `excluded: ${excludedNames.join(", ")}`,
    );
  }

  // SECONDARY, repo-local only (see my argument on the bead): the aggregate's task still exists and
  // real discovery is non-empty. The CI-invocation half is deliberately NOT here — a fixture cannot
  // observe its own non-invocation, so that witness is the documented invariant plus coord's
  // landing-time check.
  {
    const tasks = JSON.parse(await Deno.readTextFile(`${REPO}deno.json`)).tasks;
    assert(
      "0bm: the aggregate task is still defined in deno.json (discovery depends on it)",
      typeof tasks["test-fixtures"] === "string" &&
        /run-fixtures\.mjs/.test(tasks["test-fixtures"]),
    );
    const listed = await runRunner(["--list"]);
    const listText = new TextDecoder().decode(listed.stdout);
    assert(
      "0bm: real discovery is non-empty and names the known fixtures",
      /test-vendor-fonts/.test(listText) && /test-fetch-bounded/.test(listText),
      listText.split("\n")[1]?.slice(0, 90) ?? "",
    );
  }
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
