#!/usr/bin/env -S deno run --allow-read --allow-run
// run-fixtures.mjs — run EVERY fixture task this repo declares, so a new fixture cannot be added
// and then forgotten (gendn-cp7, the reach question).
//
// WHY THIS EXISTS, measured rather than assumed: `deno task X` is only enforced if something CALLS
// it. When the vendor-fonts guard was added, `grep -rn test-vendor-fonts` across the repo returned
// exactly two hits — deno.json and the fixture's own header comment. CI ran six gates and NO fixture
// task except test-verdict-emission, and the other fixture tasks were in the same position: present,
// green when typed, and invoked by nothing. A guard no gate invokes is one commit away from being
// deleted by accident, so this task makes enrolment AUTOMATIC: it discovers every `test-*` task from
// deno.json and runs it, which means forgetting a fixture requires deleting a task, not merely
// failing to remember it.
//
// THE RECURSION GUARD IS NAME-INDEPENDENT (gendn-0bm): this runner sets GENDN_FIXTURE_RUN in each
// fixture's environment, and REFUSES to start when that marker is already present. A fixture that
// invokes an aggregate therefore stops at one level instead of recursing, whether the aggregate is
// called test-fixtures or anything else, and whether it was reached by discovery or by --tasks.
// The name-keyed exclusion below is a COURTESY (it avoids spawning a child that would refuse
// immediately); the marker is the load-bearing guard, because a renamed or second aggregate is not
// covered by any name-based entry.
//
// EXCLUSIONS are explicit and printed, never silent (see EXCLUDED below): browser-backed suites run
// at the landing gate, where a Chrome is available.
//
// USAGE
//   deno task test-fixtures                     # run every discovered fixture
//   deno task test-fixtures --list               # print what would run, and what is excluded
//   deno task test-fixtures --tasks a,b          # run only these (used by the timeout fixture)
//
// BOUNDS: each fixture gets FIXTURE_TIMEOUT_MS (GENDN_FIXTURE_TIMEOUT_MS overrides it, for tests).
// A fixture that exceeds it is reported FAILED and the runner KEEPS GOING — see the kill below for
// why that needs a process GROUP and file-redirected output rather than kill() on the task process.
//
// EXIT: 0 when every discovered fixture passed; 1 when one failed or timed out.

const FIXTURE_TIMEOUT_MS = Number(Deno.env.get("GENDN_FIXTURE_TIMEOUT_MS") ?? 300_000);
// How long to wait for the group kill to take effect before giving up on a fixture's output.
const KILL_GRACE_MS = 10_000;

// Excluded with a reason each, so the next reader can see the decision rather than infer it.
const EXCLUDED = new Map([
  [
    "test-fixtures",
    "the aggregate that owns this run (courtesy entry: the GENDN_FIXTURE_RUN marker is the load-bearing guard and also covers a renamed or second aggregate)",
  ],
  [
    "test-reference-contract",
    "browser-backed (spawns Chrome); the landing gate runs it with a browser",
  ],
]);

// REFUSE BEFORE DISCOVERY: if we are already inside a fixture run, do not even read deno.json.
// The decision is a PURE function of the environment (exported for the fixture), which is what makes
// it name-independent by construction: no task name is an input, so renaming an aggregate or reaching
// one through --tasks cannot evade it. Its sibling is the name-keyed EXCLUDED entry, which is only a
// courtesy for the one aggregate we know the name of.
export const RUN_MARKER = "GENDN_FIXTURE_RUN";

/**
 * null when a run may start; the refusal reason when this run would recurse.
 *
 * TWO rules, both name-independent, and the SECOND one was added because the first was too blunt
 * (measured: the fixture that TESTS this runner is itself invoked BY the aggregate, so it carries the
 * marker and its own deliberate `--tasks <fixture>` invocations were refused):
 *
 *   discovery      : inside a fixture run, a DISCOVERY-mode run is what recurses — refuse it.
 *   aggregate task : a --tasks entry whose command invokes this runner recurses regardless of the
 *                    marker, so refuse it by CONTENT (rename-proof and argument-proof).
 *
 * An explicitly narrowed run (--tasks <real fixture>) is legitimate and proceeds.
 */
export function recursionRefusal(env, { discovery }) {
  const inside = env[RUN_MARKER];
  if (!inside) return null;
  if (!discovery) return null; // narrowed: the per-entry content check below covers the aggregate case
  return `already inside a fixture run (${RUN_MARKER}=${inside}), and this would run the whole suite again`;
}

/** Does this task COMMAND invoke the fixture runner (i.e. is it an aggregate)? Content, not name. */
export function isAggregateTaskCommand(command) {
  return typeof command === "string" && /run-fixtures\.mjs/.test(command);
}

// Everything below runs only when this file IS the program: the pure guards above are imported
// by the fixture, and top-level code here would otherwise execute the whole suite on import
// (measured: the fixture died instantly because importing the runner refused and exited).
if (import.meta.main) {
  // Arguments are parsed FIRST: the refusal decision needs to know whether this is a discovery run
  // (the recursion case) or a narrowed --tasks run (legitimate). Referencing `requested` before its
  // declaration was a crash, and it is why the wrapped block must start here.
  const requestedFlag = Deno.args.indexOf("--tasks");
  const requestedArg = requestedFlag === -1 ? null : (Deno.args[requestedFlag + 1] ?? "");
  const requested = requestedArg === null
    ? null
    : requestedArg.split(",").map((t) => t.trim()).filter(Boolean);
  const listOnly = Deno.args.includes("--list");
  const refusal = listOnly
    ? null
    : recursionRefusal(Deno.env.toObject(), { discovery: requested === null });
  if (refusal) {
    console.error(`test-fixtures: REFUSING — ${refusal}.`);
    console.error(
      "  A fixture must not invoke an aggregate: that recurses, and no name-based exclusion can " +
        "prevent it when the aggregate is renamed or reached through --tasks. Invoke a specific " +
        "fixture with --tasks <name>, or check whether a fixture shells out to an aggregate task.",
    );
    Deno.exit(1);
  }

  const repoRoot = new URL("..", import.meta.url).pathname;
  const denoJson = JSON.parse(await Deno.readTextFile(`${repoRoot}deno.json`));

  const tasks = denoJson.tasks ?? {};
  if (requested) {
    const aggregates = requested.filter((name) => isAggregateTaskCommand(tasks[name]));
    if (aggregates.length) {
      console.error(
        `test-fixtures: REFUSING — ${aggregates.join(", ")} would run this aggregate recursively ` +
          "(detected by the task's COMMAND, not its name, so renaming it changes nothing).",
      );
      Deno.exit(1);
    }
  }

  const discovered = Object.keys(tasks)
    .filter((name) => name.startsWith("test-"))
    .sort();
  const runnable = requested ??
    discovered.filter((name) => !EXCLUDED.has(name));
  const excluded = discovered.filter((name) => EXCLUDED.has(name));

  console.log(`test-fixtures: discovered ${discovered.length} test-* task(s) in deno.json`);
  console.log(`  running  (${runnable.length}): ${runnable.join(", ") || "none"}`);
  for (const name of excluded) console.log(`  excluded (${name}): ${EXCLUDED.get(name)}`);

  if (Deno.args.includes("--list")) {
    Deno.exit(0);
  }
  if (runnable.length === 0) {
    console.error("test-fixtures: no fixture tasks were discovered — refusing to report success");
    Deno.exit(1);
  }

  const results = [];
  for (const name of runnable) {
    const started = Date.now();
    // The fixture runs in its OWN PROCESS GROUP via setsid, with its output redirected to a FILE
    // rather than to pipes (gendn-cp7 review). Both halves matter:
    //  - signalling the task process alone leaves the Deno script it spawned alive;
    //  - that orphan inherits the stdout/stderr PIPES, so reading them blocks FOREVER even though the
    //    timeout was detected — the runner would identify the timeout and then hang on it, which is
    //    the worst possible place for this bug (a loaded CI job instead of a 300s failure).
    // A group kill plus file redirection removes both: nothing of ours is a pipe the orphan can hold.
    const logPath = await Deno.makeTempFile({ prefix: `fixture-${name.replace(/\W+/g, "_")}-` });
    const child = new Deno.Command("setsid", {
      args: ["sh", "-c", `deno task ${name} > ${JSON.stringify(logPath)} 2>&1`],
      cwd: repoRoot,
      stdout: "null",
      stderr: "null",
      // Set the marker for the child, which the shell, the fixture task, its script and anything they
      // spawn all inherit — so a nested aggregate refuses instead of recursing (gendn-0bm). Deno
      // merges this with the inherited environment.
      env: { [RUN_MARKER]: String(Deno.pid) },
    }).spawn();
    const pid = child.pid;

    let timedOut = false;
    const waited = await Promise.race([
      child.output().then(() => "exited"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), FIXTURE_TIMEOUT_MS)),
    ]);
    let code;
    if (waited === "timeout") {
      timedOut = true;
      // Kill the whole GROUP: `setsid` made the task a group leader, so -pid reaches the task and
      // every descendant it spawned.
      try {
        // `--` is REQUIRED: GNU kill parses a bare `-<pgid>` as a SIGNAL NUMBER, so
        // `kill -KILL -12345` fails (silently, since this is wrapped) and the group survives — measured
        // as orphans plus a 10s grace wait. `kill -KILL -- -12345` reaches the group.
        new Deno.Command("kill", { args: ["-KILL", "--", `-${pid}`] }).outputSync();
      } catch (err) {
        // Already gone, or kill refused: either way do not hide it, because the next step is a wait
        // that will time out and the operator needs to know why.
        console.error(`fixture ${name}: group kill of -${pid} failed: ${err}`);
      }
      const settled = await Promise.race([
        child.output().then(({ code }) => code),
        new Promise((resolve) => setTimeout(() => resolve(null), KILL_GRACE_MS)),
      ]);
      code = settled ?? 137;
      if (settled === null) {
        // Even the group kill did not settle it: report and move on rather than hanging the suite.
        console.error(`fixture ${name}: the process group did not exit within ${KILL_GRACE_MS}ms`);
      }
    } else {
      code = (await child.output()).code;
    }

    const ms = Date.now() - started;
    const log = await Deno.readTextFile(logPath).catch(() => "");
    const last = (log.trim().split("\n").pop() ?? "").slice(0, 120);
    const verdict = timedOut ? "TIMEOUT" : code === 0 ? "PASS" : "FAIL";
    if (timedOut) code = code === 0 ? 124 : code;
    results.push({ name, code: timedOut ? 124 : code, ms, last });
    console.log(
      `${verdict} ${name} (${ms}ms) :: ${timedOut ? `exceeded ${FIXTURE_TIMEOUT_MS}ms` : last}`,
    );
    if (code !== 0 || timedOut) {
      // Show the tail of a failing fixture inline: the aggregate is often the only place it is read.
      console.error(`--- ${name} output tail ---`);
      console.error(log.split("\n").slice(-15).join("\n"));
    }
    await Deno.remove(logPath).catch(() => {});
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log(
    `\ntest-fixtures: ${results.length - failed.length}/${results.length} fixture(s) passed` +
      (failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(", ")}` : ""),
  );
  Deno.exit(failed.length ? 1 : 0);
}
