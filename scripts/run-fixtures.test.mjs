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

import {
  aggregateExitCode,
  appendSweepToken,
  depthRefusal,
  environHasToken,
  fixtureEnvironment,
  incomingDepth,
  isAggregateTaskCommand,
  MAX_NESTING_DEPTH,
  nextDepth,
  recursionRefusal,
  RUN_MARKER,
  scanForToken,
  SWEEP_BUDGET_MS,
  SWEEP_MAX_PIDS,
  SWEEP_TOKEN,
  sweepReport,
  sweepTargets,
} from "./run-fixtures.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const PROBE = "fixture-timeout-probe";
const PROBE_SCRIPT = "fixture-timeout-probe.mjs";
const BOUND_MS = 2000;

// Run the runner with the SAME permission flags its real task declares, so this fixture cannot pass
// under permissions production does not have (measured: the first gendn-ebf run spawned the runner
// with --allow-read, and Deno gates /proc behind --allow-all, so the sweep crashed and the test
// reported a false negative the real task never had). Derived from deno.json rather than copied, so
// adding a flag to the task cannot silently leave the fixture testing a weaker runner.
const RUNNER_TASK = JSON.parse(await Deno.readTextFile(`${REPO}deno.json`)).tasks["test-fixtures"];
const RUNNER_FLAGS = RUNNER_TASK.match(/--allow-[\w-]+(?:=[^\s]+)?/g) ?? [];
if (RUNNER_FLAGS.length === 0) {
  throw new Error(`could not parse permission flags from the test-fixtures task: ${RUNNER_TASK}`);
}

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
          "test-everything": "deno run --allow-all scripts/run-fixtures.mjs",
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

function runRunner(args, env = {}, flags = RUNNER_FLAGS) {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      ...flags,
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

  // ---- gendn-r3b: depth, not command SPELLING, bounds accidental recursion ---------------------
  // The deepest real chain is aggregate (0) -> test-run-fixtures (1) -> narrowed runner's fixture
  // (2); max 3 leaves one wrapper layer. The proof is finite arithmetic, NEVER running recursion.
  {
    const table = [
      [{}, 0],
      [{ [RUN_MARKER]: "12345" }, 1], // legacy 0bm marker
      [{ [RUN_MARKER]: "12345:2" }, 2],
      [{ [RUN_MARKER]: "not-a-marker" }, 0],
    ];
    for (const [env, expected] of table) {
      assert(
        `r3b depth: ${JSON.stringify(env)} parses as ${expected}`,
        incomingDepth(env) === expected && nextDepth(env) === expected + 1,
      );
    }
    for (let depth = 0; depth <= 5; depth++) {
      const env = depth ? { [RUN_MARKER]: `12345:${depth}` } : {};
      const refusal = recursionRefusal(env, { discovery: false });
      assert(
        `r3b decision: narrowed run at incoming depth ${depth} ${
          depth < MAX_NESTING_DEPTH ? "runs" : "REFUSES"
        }`,
        depth < MAX_NESTING_DEPTH
          ? refusal === null && depthRefusal(env) === null
          : typeof refusal === "string" && refusal.includes(`depth ${depth}`) &&
            refusal.includes("maximum of 3") && refusal.includes("--tasks"),
      );
    }
    const candidates = Array.from({ length: SWEEP_MAX_PIDS + 1 }, (_, i) => i + 1);
    const targets = sweepTargets(candidates);
    assert(
      "ebf cap: exactly 64 of 65 candidate PIDs can be signalled; 65th remains for survivor report",
      SWEEP_MAX_PIDS === 64 && SWEEP_BUDGET_MS === 5000 && targets.length === 64 &&
        targets.at(-1) === 64 && !targets.includes(65),
    );
    const nested = fixtureEnvironment(
      { [RUN_MARKER]: "12345:1", [SWEEP_TOKEN]: "ancestor-token" },
      67890,
      "fixture-depth-probe",
      1,
    );
    assert(
      "r3b/ebf: ONE spawn-env block increments depth AND extends ancestor token",
      nested.childEnv[RUN_MARKER] === "12345:2" &&
        nested.childEnv[SWEEP_TOKEN] === "ancestor-token,67890-fixture-depth-probe-1" &&
        nested.token === "67890-fixture-depth-probe-1",
    );
    assert(
      "r3b: a comma in a task name cannot split a generated token",
      fixtureEnvironment({}, 67890, "name,other", 2).token === "67890-name%2Cother-2",
    );
  }

  // Two single-fixture invocations, not recursion: the legitimate narrowed path at depth 1 runs;
  // incoming depth 3 refuses BEFORE spawning anything, with a reason naming the depth.
  {
    const allowed = await runRunner(["--tasks", "fixture-depth-probe"], {
      [RUN_MARKER]: "12345:1",
      [SWEEP_TOKEN]: "ancestor-token",
    });
    const allowedOut = new TextDecoder().decode(allowed.stdout);
    assert(
      "r3b end-to-end: depth 1 narrowed run reaches a fixture at depth 2, preserving ancestor token",
      allowed.code === 0 && /PASS fixture-depth-probe/.test(allowedOut) &&
        /marker=12345:2 tokens=ancestor-token,\d+-fixture-depth-probe-1/.test(allowedOut),
      allowedOut.trim().split("\n").slice(-2).join(" | ").slice(0, 200),
    );
    const refused = await runRunner(["--tasks", "fixture-depth-probe"], {
      [RUN_MARKER]: "12345:3",
    });
    const refusedText = new TextDecoder().decode(refused.stdout) +
      new TextDecoder().decode(refused.stderr);
    assert(
      "r3b end-to-end: incoming depth 3 REFUSES without spawning a fixture",
      refused.code !== 0 &&
        /fixture recursion depth 3 reached the maximum of 3/.test(refusedText) &&
        !/PASS fixture-depth-probe/.test(refusedText),
      refusedText.trim().split("\n")[0]?.slice(0, 200) ?? "",
    );
  }

  // ---- gendn-ebf: a timed-out fixture's DETACHED descendants are swept by TOKEN, not by name ----

  // Pure discrimination first, so the sweep's identity check is assertable without spawning anything.
  {
    assert(
      "ebf: the sweep matches the exact NUL-separated token entry",
      environHasToken(`A=1\0${SWEEP_TOKEN}=t1\0B=2`, "t1"),
    );
    assert(
      "ebf: ...and does NOT match a token that is only a PREFIX of another (t1 vs t10)",
      !environHasToken(`A=1\0${SWEEP_TOKEN}=t10\0`, "t1"),
    );
    assert(
      "ebf: ...and does not match when the variable is absent",
      !environHasToken("A=1\0B=2", "t1"),
    );
  }

  // A chain retains ancestor identity while requiring COMPLETE token matches, not substrings.
  {
    assert(
      "ebf: nested runner APPENDS rather than replacing the ancestor's token",
      appendSweepToken("outer", "inner") === "outer,inner" &&
        environHasToken(`${SWEEP_TOKEN}=outer,inner\0`, "outer") &&
        environHasToken(`${SWEEP_TOKEN}=outer,inner\0`, "inner"),
    );
    assert(
      "ebf: a sibling token/prefix cannot be swept through the chain",
      !environHasToken(`${SWEEP_TOKEN}=outer,inner10\0`, "inner") &&
        !environHasToken(`OTHER_${SWEEP_TOKEN}=outer,inner\0`, "outer"),
    );
  }

  // A deterministic deadline crossing with TWO fake /proc pids. The first pid is observed; the
  // second is never read. The actual scanner MUST say TRUNCATED (survivor count UNKNOWN), not 0.
  {
    async function* fakeEntries() {
      yield { name: "900001" };
      yield { name: "900002" };
    }
    let ticks = 0;
    const scan = await scanForToken("needle", 5, {
      entries: fakeEntries(),
      readEnviron: async () => new TextEncoder().encode(`${SWEEP_TOKEN}=needle\0`),
      now: () => (++ticks <= 2 ? 0 : 10),
    });
    assert(
      "ebf detector: deadline after one of TWO pids is explicitly TRUNCATED",
      scan.truncated && scan.scanned === 1 && scan.found.length === 1 &&
        scan.found[0] === 900001,
      JSON.stringify(scan),
    );
    const truncated = sweepReport("probe", {
      identified: scan.found.length,
      killed: 1,
      survivors: [],
      capped: false,
      unreadable: 0,
      truncated: scan.truncated,
      scanned: scan.scanned,
      elapsedMs: 5000,
    });
    assert(
      "ebf: TRUNCATED prints survivor count UNKNOWN and fails even if fixture exit is zero",
      truncated.kind === "TRUNCATED" &&
        /scan TRUNCATED after 1 pid check\(s\)/.test(truncated.line) &&
        /survivor count UNKNOWN/.test(truncated.line) &&
        !/0 attributable survivor/.test(truncated.line) &&
        aggregateExitCode([{ code: 0 }], [], ["probe"]) === 1,
      truncated.line,
    );
    const leak = sweepReport("probe", {
      identified: 1,
      killed: 0,
      survivors: [900001],
      capped: false,
      unreadable: 0,
      truncated: false,
      scanned: 2,
      elapsedMs: 10,
    });
    assert(
      "ebf: known LEAK reports recorded pid and fails even if fixture exit is zero",
      leak.kind === "LEAK" && leak.line.includes("900001") &&
        aggregateExitCode([{ code: 0 }], ["probe"], []) === 1,
      leak.line,
    );
  }

  // CASE A (detector): a fixture that DETACHES a child (setsid --fork, so its own session) and then
  // exceeds its bound. The group kill cannot reach that child; before gendn-ebf it survived the
  // timeout silently, which is exactly the leak this proves is now reclaimed.
  {
    const dir = await Deno.makeTempDir({ prefix: "run-fixtures-detach-" });
    const childPidFile2 = `${dir}/child.pid`;
    const detachBound = 4000;
    const startedA = Date.now();
    const r = await runRunner(["--tasks", "fixture-detach-hang"], {
      GENDN_FIXTURE_TIMEOUT_MS: String(detachBound),
      PROBE_PID_FILE: `${dir}/own.pid`,
      PROBE_CHILD_PID_FILE: childPidFile2,
    });
    const elapsedA = Date.now() - startedA;
    const outA = new TextDecoder().decode(r.stdout);
    const bothA = outA + new TextDecoder().decode(r.stderr);
    const childPid2 = Number((await Deno.readTextFile(childPidFile2).catch(() => "")).trim());
    try {
      assert(
        "ebf: a fixture with a DETACHED child is reported TIMEOUT and exits non-zero",
        r.code !== 0 && /TIMEOUT fixture-detach-hang/.test(outA),
        `exit=${r.code} ${outA.trim().split("\n").pop()?.slice(0, 80)}`,
      );
      assert(
        "ebf: the runner EXITS promptly despite the detached child",
        elapsedA < detachBound + 20_000,
        `${elapsedA}ms for a ${detachBound}ms bound`,
      );
      assert(
        "ebf: the sweep IDENTIFIED the detached descendant by its token",
        /timeout sweep — 1 token-attributed process\(es\)/.test(bothA),
        bothA.split("\n").find((l) => l.includes("timeout sweep"))?.trim() ?? "no sweep line",
      );
      assert(
        "ebf: ...and it was signalled with no attributable survivor reported",
        /1 signalled/.test(bothA) && /0 attributable survivor\(s\)/.test(bothA),
        "",
      );
      assert(
        "ebf: no LEAK was reported for the swept fixture",
        !/^LEAK /m.test(bothA),
        "",
      );
      assert(
        "ebf: the detached child's RECORDED pid is DEAD after the sweep",
        Number.isInteger(childPid2) && childPid2 > 0 && !alive(childPid2),
        Number.isInteger(childPid2) && childPid2 > 0
          ? `pid ${childPid2} alive=${alive(childPid2)}`
          : "the probe never recorded a detached child pid",
      );
    } finally {
      if (Number.isInteger(childPid2) && childPid2 > 0 && alive(childPid2)) {
        try {
          Deno.kill(childPid2, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }

  // CASE B (negative control): the SAME detached child, but the fixture COMPLETES inside its bound.
  // The runner must NOT touch it — the sweep is a TIMEOUT behaviour, not a general reaper. This is the
  // assertion that keeps a fix for a leak from becoming a worse defect (killing a fixture's own server).
  {
    const dir = await Deno.makeTempDir({ prefix: "run-fixtures-detach-" });
    const childPidFile3 = `${dir}/child.pid`;
    const r = await runRunner(["--tasks", "fixture-detach-exit"], {
      GENDN_FIXTURE_TIMEOUT_MS: "15000",
      PROBE_PID_FILE: `${dir}/own.pid`,
      PROBE_CHILD_PID_FILE: childPidFile3,
    });
    const outB = new TextDecoder().decode(r.stdout);
    const childPid3 = Number((await Deno.readTextFile(childPidFile3).catch(() => "")).trim());
    try {
      assert(
        "ebf NEGATIVE CONTROL: a fixture with a detached child that COMPLETES is PASS",
        r.code === 0 && /PASS fixture-detach-exit/.test(outB),
        `exit=${r.code} ${outB.trim().split("\n").pop()?.slice(0, 80)}`,
      );
      assert(
        "ebf NEGATIVE CONTROL: on success the runner does NOT kill the fixture's detached child",
        Number.isInteger(childPid3) && childPid3 > 0 && alive(childPid3),
        Number.isInteger(childPid3) && childPid3 > 0
          ? `pid ${childPid3} alive=${alive(childPid3)}`
          : "the probe never recorded a detached child pid",
      );
    } finally {
      if (Number.isInteger(childPid3) && childPid3 > 0 && alive(childPid3)) {
        try {
          Deno.kill(childPid3, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }

  // CASE C (nested detector): the outer timeout must reclaim a GRANDCHILD launched by a narrowed
  // inner runner. Without the token chain, the inner runner overwrites outer attribution and this
  // recorded setsid sleeper SURVIVES. One inner invocation, one fixture, one sleeper — no recursion.
  {
    const dir = await Deno.makeTempDir({ prefix: "run-fixtures-nested-" });
    const own = `${dir}/inner.pid`;
    const detached = `${dir}/child.pid`;
    const bound = 4500;
    try {
      const startedNested = Date.now();
      const r = await runRunner(["--tasks", "fixture-nested-timeout-probe"], {
        GENDN_FIXTURE_TIMEOUT_MS: String(bound),
        PROBE_PID_FILE: own,
        PROBE_CHILD_PID_FILE: detached,
      });
      const duration = Date.now() - startedNested;
      const stdout = new TextDecoder().decode(r.stdout);
      const output = stdout + new TextDecoder().decode(r.stderr);
      const childPid = Number((await Deno.readTextFile(detached).catch(() => "")).trim());
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert(
        "ebf/r3b nested: outer runner reports TIMEOUT and exits non-zero promptly",
        r.code !== 0 && /TIMEOUT fixture-nested-timeout-probe/.test(stdout) &&
          duration < bound + 15_000,
        `exit=${r.code} duration=${duration}ms`,
      );
      assert(
        "ebf/r3b nested: outer token sweep observes and signals descendants, no UNKNOWN or LEAK",
        /timeout sweep — [1-9]\d* token-attributed process\(es\), [1-9]\d* signalled, 0 attributable survivor\(s\)/
          .test(output) && !/scan TRUNCATED|^LEAK /m.test(output),
        output.split("\n").find((line) => line.includes("timeout sweep"))?.slice(0, 200) ?? "",
      );
      assert(
        "ebf/r3b nested: detached grandchild's RECORDED pid is dead after OUTER sweep",
        Number.isInteger(childPid) && childPid > 0 && !alive(childPid),
        `pid=${childPid} alive=${Number.isInteger(childPid) && childPid > 0 && alive(childPid)}`,
      );
    } finally {
      for (const file of [own, detached]) {
        const pid = Number((await Deno.readTextFile(file).catch(() => "")).trim());
        if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
          try {
            Deno.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }

  // CASE D: the sweep genuinely cannot read /proc under weaker Deno permissions. The runner must
  // still exit non-zero and say SWEEP FAILED / survivor count UNKNOWN, not misreport a clean zero.
  {
    const dir = await Deno.makeTempDir({ prefix: "run-fixtures-denied-" });
    const probeFile = `${dir}/probe.pid`;
    try {
      const r = await runRunner(
        ["--tasks", PROBE],
        { GENDN_FIXTURE_TIMEOUT_MS: "1500", PROBE_PID_FILE: probeFile },
        ["--allow-read", "--allow-write", "--allow-run", "--allow-env"],
      );
      const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
      assert(
        "ebf: permission-denied /proc scan reports SWEEP FAILED and UNKNOWN, exits non-zero",
        r.code !== 0 && /TIMEOUT/.test(out) && /timeout sweep FAILED/.test(out) &&
          /survivor count UNKNOWN/.test(out) && /SWEEP FAILED: fixture-timeout-probe/.test(out),
        out.split("\n").find((line) => line.includes("sweep FAILED"))?.slice(0, 200) ?? "",
      );
    } finally {
      const pid = Number((await Deno.readTextFile(probeFile).catch(() => "")).trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
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
