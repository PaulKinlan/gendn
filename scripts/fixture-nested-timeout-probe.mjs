// A finite nested-runner detector for gendn-ebf/r3b. The outer runner starts THIS fixture at depth
// 1. It invokes a narrowed inner runner (allowed at depth 1), which starts exactly ONE detach-hang
// fixture at depth 2. The outer bound fires first; the inner fixture's setsid group and its own
// detached sleeper escape the outer group kill, so the outer token sweep must still reach them.
//
// No discovery, no recursion, no unbounded spawning: exactly one narrowed inner runner, one inner
// fixture and one sleeper, plus a fixed shell/setsid launch chain (at most 20 command-launched
// processes under these task definitions). The test records and cleans up the inner fixture and
// sleeper by their OWN PIDs if a broken sweep leaves either alive.
const env = { ...Deno.env.toObject(), GENDN_FIXTURE_TIMEOUT_MS: "15000" };
const inner = new Deno.Command(Deno.execPath(), {
  args: ["task", "test-fixtures", "--tasks", "fixture-detach-hang"],
  cwd: new URL("..", import.meta.url).pathname,
  env,
  stdout: "null",
  stderr: "null",
}).spawn();
await inner.status;
