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
  ["test-fixtures", "this task"],
  [
    "test-reference-contract",
    "browser-backed (spawns Chrome); the landing gate runs it with a browser",
  ],
]);

const repoRoot = new URL("..", import.meta.url).pathname;
const denoJson = JSON.parse(await Deno.readTextFile(`${repoRoot}deno.json`));

const discovered = Object.keys(denoJson.tasks ?? {})
  .filter((name) => name.startsWith("test-"))
  .sort();
const requestedFlag = Deno.args.indexOf("--tasks");
const requested = requestedFlag === -1
  ? null
  : (Deno.args[requestedFlag + 1] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
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
