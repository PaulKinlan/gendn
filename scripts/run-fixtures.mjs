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
//   deno task test-fixtures            # run every discovered fixture
//   deno task test-fixtures --list     # print what would run, and what is excluded, without running
//
// EXIT: 0 when every discovered fixture passed; 1 when one failed or timed out.

const FIXTURE_TIMEOUT_MS = 300_000;

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
const runnable = discovered.filter((name) => !EXCLUDED.has(name));
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
  const child = new Deno.Command("deno", {
    args: ["task", name],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, FIXTURE_TIMEOUT_MS);
  const { code, stdout, stderr } = await child.output();
  clearTimeout(timer);
  const ms = Date.now() - started;
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  const last = (out.trim().split("\n").pop() ?? err.trim().split("\n").pop() ?? "").slice(0, 120);
  results.push({ name, code, ms, last });
  console.log(`${code === 0 ? "PASS" : "FAIL"} ${name} (${ms}ms) :: ${last}`);
  if (code !== 0) {
    // Show the tail of a failing fixture inline: the aggregate is often the only place it is read.
    console.error(`--- ${name} output tail ---`);
    console.error(out.split("\n").slice(-15).join("\n"));
    console.error(err.split("\n").slice(-15).join("\n"));
  }
}

const failed = results.filter((r) => r.code !== 0);
console.log(
  `\ntest-fixtures: ${results.length - failed.length}/${results.length} fixture(s) passed` +
    (failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(", ")}` : ""),
);
Deno.exit(failed.length ? 1 : 0);
