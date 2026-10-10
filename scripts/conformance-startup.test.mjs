// @fixture-permissions --allow-read --allow-write --allow-run --allow-net --allow-env
// Force failures before the conformance runner opens Chrome. The gate must name its child
// process error or startup timeout, and never mistake another server's port for readiness.
import { spawnServer } from "./conformance.mjs";

const serverSource = await Deno.readTextFile(new URL("../server.ts", import.meta.url));
if (!serverSource.includes("Listening on http://localhost:${server.addr.port}")) {
  throw new Error("conformance readiness requires server.ts to print its own listening port");
}
let failure;
const started = performance.now();
try {
  await spawnServer(0, { script: "scripts/__missing_conformance_fixture__.ts" });
} catch (error) {
  failure = error;
}
if (
  !failure?.message.includes("gendn server did not start:") ||
  !failure.message.includes("__missing_conformance_fixture__.ts") ||
  !failure.message.includes("Module not found") ||
  !failure.message.includes("child exit 1") ||
  performance.now() - started >= 10_000
) {
  throw new Error(`missing child error was not reported promptly: ${failure?.message}`);
}
const stalledScript = await Deno.makeTempFile({
  prefix: "gendn-conformance-stalled-",
  suffix: ".mjs",
});
try {
  await Deno.writeTextFile(
    stalledScript,
    'console.error("fixture conformance startup blocked"); setInterval(() => {}, 1000);\n',
  );
  let timedOut;
  try {
    await spawnServer(0, { script: stalledScript, startupTimeoutMs: 1500 });
  } catch (error) {
    timedOut = error;
  }
  if (
    !timedOut?.message.includes("startup timed out after 1500ms") ||
    !timedOut.message.includes("fixture conformance startup blocked") ||
    !timedOut.message.includes("signal SIGKILL")
  ) {
    throw new Error(`bounded startup failure hid child output: ${timedOut?.message}`);
  }
} finally {
  await Deno.remove(stalledScript);
}
console.log("conformance startup fixture: early exit and timeout name the child cause");
