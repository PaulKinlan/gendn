#!/usr/bin/env -S deno run --allow-all
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
// THE RECURSION GUARD IS NAME-INDEPENDENT (gendn-0bm/r3b): GENDN_FIXTURE_RUN carries the
// originating runner pid AND a depth. Discovery inside a fixture is refused; narrowed --tasks is
// legitimate, but incoming depth >= 3 refuses EVERY nesting path regardless of command spelling.
// The real chain is aggregate (depth 0) -> test-run-fixtures (1) -> narrowed runner -> fixture (2);
// depth 3 leaves one wrapper layer of headroom. An intentionally cleared environment can bypass
// an environment-carried guard; this bounds accidental recursion, not a hostile fixture. The
// name-keyed exclusion below is only a courtesy, not the load-bearing guard.
//
// TIMED-OUT FIXTURES AND THEIR DESCENDANTS (gendn-ebf): a fixture OWNS the processes it starts while
// it runs, and the runner does NOT touch them on SUCCESS — a fixture may legitimately leave a server
// up for a later step in its own suite, and killing on success would be a silent behaviour change.
// On TIMEOUT the contract is stronger than a group kill: the runner kills the fixture's process
// GROUP (as below), then SWEEPS for every process it can ATTRIBUTE to that fixture — including a
// child that used setsid and is therefore outside the group. Attribution is by a per-invocation
// TOKEN CHAIN in the environment (SWEEP_TOKEN below), read from /proc/<pid>/environ: a nested runner
// APPENDS its token rather than replacing its ancestor's, so an outer timeout can reclaim detached
// grandchildren even after setsid. Nothing is matched by NAME. At most SWEEP_MAX_PIDS are killed
// within a SWEEP_BUDGET_MS scan budget. Every scan reports whether it completed: if the deadline
// truncates either scan, the survivor count is UNKNOWN and a distinct SWEEP TRUNCATED failure is
// printed — never a false zero. A completed scan reports attributable survivors as LEAK. An
// unreadable /proc/<pid>/environ is SKIPPED (ownership unknown), not called a survivor; this
// prefers an explicitly unknown process to a false positive that could kill an unrelated process.
//
// WHY THE AGGREGATE TASK IS --allow-all (gendn-ebf): Deno refuses `Deno.readDir("/proc")` and
// `Deno.readFile("/proc/<pid>/environ")` under --allow-read, --allow-read=/proc and even
// --allow-read --allow-sys; the permission gate requires --allow-all (measured on deno 2.9.7: any
// narrower flag yields `NotCapable: Requires all access to "/proc"`). Reading a descendant's
// environment is the identity mechanism the sweep depends on, so the runner process needs it. This is
// NOT a capability widening in practice: the aggregate already holds --allow-run (it spawns
// `deno task` for every fixture), which is arbitrary code execution as this user, and Deno permissions
// are per-process, so a fixture keeps exactly the flags its own deno.json task declares.
//
// EXCLUSIONS are explicit and printed, never silent (see EXCLUDED below): the browser-backed
// reference suite runs as a dedicated CI step, where Chrome is available.
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
// Hard bounds on the post-timeout descendant sweep (gendn-ebf): at most this many pids killed per
// fixture, and never longer than this budget for the whole sweep (scan + kill + re-scan).
export const SWEEP_MAX_PIDS = 64;
export const SWEEP_BUDGET_MS = 5_000;
export const MAX_NESTING_DEPTH = 3;

// Excluded with a reason each, so the next reader can see the decision rather than infer it.
const EXCLUDED = new Map([
  [
    "test-fixtures",
    "the aggregate that owns this run (courtesy entry: the GENDN_FIXTURE_RUN marker is the load-bearing guard and also covers a renamed or second aggregate)",
  ],
  [
    "test-reference-contract",
    "browser-backed (spawns Chrome); CI runs it as a dedicated browser regression step",
  ],
]);

// REFUSE BEFORE DISCOVERY: if we are already inside a fixture run, do not even read deno.json.
// The decision is a PURE function of the environment (exported for the fixture), which is what makes
// it name-independent by construction: no task name is an input, so renaming an aggregate or reaching
// one through --tasks cannot evade it. Its sibling is the name-keyed EXCLUDED entry, which is only a
// courtesy for the one aggregate we know the name of.
export const RUN_MARKER = "GENDN_FIXTURE_RUN";
// A descendant inherits its fixture token AND every ancestor's token. A nested runner appends, never
// replaces, so an outer timeout can still identify detached grandchildren by its own token.
export const SWEEP_TOKEN = "GENDN_FIXTURE_TOKEN";

/** Parse the incoming fixture depth. Bare pre-r3b markers count as depth 1. */
export function incomingDepth(env) {
  const marker = env[RUN_MARKER];
  if (!marker) return 0;
  if (/^\d+$/.test(marker)) return 1;
  const match = /^\d+:(\d+)$/.exec(marker);
  if (!match) return 0; // malformed/cleared state is outside the accidental-recursion guard
  const depth = Number(match[1]);
  return Number.isSafeInteger(depth) ? depth : 0;
}

export function nextDepth(env) {
  return incomingDepth(env) + 1;
}

/** Narrowed fixture runs may nest through depth 2; refuse incoming depth 3 or higher. */
export function depthRefusal(env) {
  const depth = incomingDepth(env);
  return depth >= MAX_NESTING_DEPTH
    ? `fixture recursion depth ${depth} reached the maximum of ${MAX_NESTING_DEPTH}; ` +
      "invoke a specific fixture with --tasks <name>, or check whether a fixture shells out to an aggregate"
    : null;
}

/** Append a new token to the inherited chain without replacing ancestor attribution. */
export function appendSweepToken(parent, token) {
  return [...(parent ? parent.split(",").filter(Boolean) : []), token].join(",");
}

/** The ONE spawn-env block that increments depth and preserves every ancestor's token. */
export function fixtureEnvironment(env, pid, name, counter) {
  const marker = env[RUN_MARKER] ?? "";
  const origin = /^\d+(?::\d+)?$/.test(marker) ? marker.split(":")[0] : String(pid);
  // A comma separates chain entries, so encode any comma in a task name before making its token.
  const token = `${pid}-${encodeURIComponent(name)}-${counter}`;
  return {
    token,
    childEnv: {
      [RUN_MARKER]: `${origin}:${nextDepth(env)}`,
      [SWEEP_TOKEN]: appendSweepToken(env[SWEEP_TOKEN], token),
    },
  };
}

/** The exact single-token `KEY=value` entry; a chain extends the value with comma delimiters. */
export function tokenEntry(token) {
  return `${SWEEP_TOKEN}=${token}`;
}

/** Match the exact variable name AND a complete token in its chain, never a name/prefix substring. */
export function environHasToken(environText, token) {
  const prefix = `${SWEEP_TOKEN}=`;
  return environText.split("\0").some((entry) =>
    entry.startsWith(prefix) && entry.slice(prefix.length).split(",").includes(token)
  );
}

/**
 * Scan /proc within a deadline. `truncated` is load-bearing: a partial scan cannot establish zero
 * survivors. Injectable inputs let the fixture prove a deadline crossing with TWO fake pids and no
 * unbounded side effect. Unreadable envs are skipped, never falsely attributed.
 */
export async function scanForToken(
  token,
  deadline,
  {
    entries = Deno.readDir("/proc"),
    readEnviron = (pid) => Deno.readFile(`/proc/${pid}/environ`),
    now = Date.now,
  } = {},
) {
  const started = now();
  const found = [];
  let unreadable = 0;
  let scanned = 0;
  let truncated = false;
  for await (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === Deno.pid) continue;
    if (now() > deadline) {
      truncated = true;
      break;
    }
    scanned++;
    let raw;
    try {
      raw = await readEnviron(pid);
    } catch {
      unreadable++; // cannot attribute -> skip; never a false survivor
      continue;
    }
    if (environHasToken(new TextDecoder().decode(raw), token)) found.push(pid);
  }
  const elapsedMs = Math.max(0, now() - started);
  return { found, unreadable, scanned, elapsedMs, truncated: truncated || now() > deadline };
}

/** The load-bearing 64-pid cap, pure so the 65th candidate is testable without spawning it. */
export function sweepTargets(pids, maxPids = SWEEP_MAX_PIDS) {
  return pids.slice(0, maxPids);
}

/** Kill at most `maxPids`, then re-scan within the SAME deadline; never invent a zero on truncation. */
async function sweepByToken(token, { maxPids, budgetMs }) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const first = await scanForToken(token, deadline);
  const capped = first.found.length > maxPids;
  const targets = sweepTargets(first.found, maxPids);
  let killed = 0;
  let attempted = 0;
  for (const pid of targets) {
    if (Date.now() > deadline) break;
    attempted++;
    try {
      Deno.kill(pid, "SIGKILL");
      killed++;
    } catch {
      // Already exited between the scan and the kill: nothing to reclaim.
    }
  }
  // Always re-scan (including when the first scan found zero): a detached child may have appeared
  // after the first snapshot. SIGKILL settles for at most the remaining 250ms budget.
  const remaining = Math.max(0, deadline - Date.now());
  if (targets.length && remaining) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  }
  const after = Date.now() < deadline
    ? await scanForToken(token, deadline)
    : { found: [], unreadable: 0, scanned: 0, elapsedMs: 0, truncated: true };
  return {
    identified: first.found.length,
    killed,
    survivors: after.found,
    capped,
    unreadable: first.unreadable + after.unreadable,
    truncated: first.truncated || after.truncated || attempted < targets.length,
    scanned: first.scanned + after.scanned,
    elapsedMs: Date.now() - started,
  };
}

/** Format one sweep result; UNKNOWN is distinct from zero, LEAK distinct from a clean timeout. */
export function sweepReport(name, sweep) {
  const base =
    `fixture ${name}: timeout sweep — ${sweep.identified} token-attributed process(es), ` +
    `${sweep.killed} signalled${sweep.capped ? ` (kill cap ${SWEEP_MAX_PIDS} reached)` : ""}`;
  if (sweep.truncated) {
    return {
      kind: "TRUNCATED",
      line:
        `${base}; scan TRUNCATED after ${sweep.scanned} pid check(s) and ${sweep.elapsedMs}ms; ` +
        `survivor count UNKNOWN${
          sweep.survivors.length ? ` (${sweep.survivors.length} known alive)` : ""
        }`,
    };
  }
  return {
    kind: sweep.survivors.length ? "LEAK" : "CLEAN",
    line: `${base}, ${sweep.survivors.length} attributable survivor(s)` +
      (sweep.survivors.length ? ` (pids ${sweep.survivors.join(", ")})` : "") +
      `; ${sweep.unreadable} unreadable environ read(s) skipped (ownership unknown)`,
  };
}

/** A sweep failure or survivor must fail the run even if all fixture exit codes say zero. */
export function aggregateExitCode(results, leaks, sweepFailures) {
  return results.some((result) => result.code !== 0) || leaks.length || sweepFailures.length
    ? 1
    : 0;
}

/**
 * null when a run may start; the refusal reason when this run would recurse.
 *
 * THREE layers, added as measurements found gaps in the prior layer:
 *   depth          : incoming depth >= 3 refuses EVERY run, including narrowed aliases/wrappers.
 *   discovery      : inside a fixture run, a DISCOVERY-mode run would recurse — refuse it.
 *   aggregate task : the separate --tasks command-content check below refuses known aggregate
 *                    commands early; its spelling match is a courtesy, not the hard bound.
 *
 * An explicitly narrowed run below the depth bound is legitimate and proceeds.
 */
export function recursionRefusal(env, { discovery }) {
  const depth = depthRefusal(env);
  if (depth) return depth; // bounded by the ACT of nesting, regardless of command spelling
  const inside = env[RUN_MARKER];
  if (!inside) return null;
  if (!discovery) return null; // narrowed: legitimate below the depth bound
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
  const leaks = [];
  const sweepFailures = [];
  let fixtureCounter = 0;
  for (const name of runnable) {
    const started = Date.now();
    // Both inherited states are set in ONE place: nesting increments and attribution extends rather
    // than resetting. This is the common fix for the two environment-overwrite hazards.
    const { token, childEnv } = fixtureEnvironment(
      Deno.env.toObject(),
      Deno.pid,
      name,
      ++fixtureCounter,
    );
    // The fixture runs in its OWN PROCESS GROUP via setsid, with its output redirected to a FILE
    // rather than to pipes (gendn-cp7 review). Both halves matter:
    //  - signalling the task process alone leaves the Deno script it spawned alive;
    //  - that orphan inherits the stdout/stderr PIPES, so reading them blocks FOREVER even though the
    //    timeout was detected — the runner would identify the timeout and then hang on it, which is
    //    the worst possible place for this bug (a loaded CI job instead of a 300s failure).
    // A group kill plus file redirection removes both: nothing of ours is a pipe the orphan can hold.
    const logPath = await Deno.makeTempFile({ prefix: `fixture-${name.replace(/\W+/g, "_")}-` });
    try {
      const child = new Deno.Command("setsid", {
        args: ["sh", "-c", `deno task ${name} > ${JSON.stringify(logPath)} 2>&1`],
        cwd: repoRoot,
        stdout: "null",
        stderr: "null",
        // The ONE env block built by fixtureEnvironment increments depth and APPENDS the token chain.
        // Shell, task, script and detached children inherit both; an outer timeout can still attribute
        // a nested runner's grandchildren without matching a process NAME.
        env: childEnv,
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
          console.error(
            `fixture ${name}: the process group did not exit within ${KILL_GRACE_MS}ms`,
          );
        }
        // The group kill cannot reach a descendant that detached with setsid, so sweep by the token the
        // fixture's children inherited. Always report the sweep, even when it found nothing: "we looked
        // and found none" is the fact that makes a leak attributable later.
        const sweep = await sweepByToken(token, {
          maxPids: SWEEP_MAX_PIDS,
          budgetMs: SWEEP_BUDGET_MS,
        }).catch((err) => {
          // "Could not look" is never "looked and found none".
          sweepFailures.push(name);
          console.error(`fixture ${name}: timeout sweep FAILED (${err}); survivor count UNKNOWN`);
          return null;
        });
        if (sweep) {
          const report = sweepReport(name, sweep);
          console.error(report.line);
          if (report.kind === "TRUNCATED") sweepFailures.push(name);
          if (sweep.survivors.length > 0) {
            leaks.push(name);
            console.error(
              `LEAK ${name}: ${sweep.survivors.length} known attributable survivor(s) ` +
                `(pids ${sweep.survivors.join(", ")})`,
            );
          }
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
    } finally {
      await Deno.remove(logPath).catch(() => {});
    }
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log(
    `\ntest-fixtures: ${results.length - failed.length}/${results.length} fixture(s) passed` +
      (failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(", ")}` : "") +
      (leaks.length ? ` — LEAKED: ${leaks.join(", ")}` : "") +
      (sweepFailures.length ? ` — SWEEP FAILED: ${sweepFailures.join(", ")}` : ""),
  );
  Deno.exit(aggregateExitCode(results, leaks, sweepFailures));
}
