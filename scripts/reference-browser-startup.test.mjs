// Force a server startup failure without Chrome or an occupied shared port. The gate must
// report the actual child error, not just an exhausted readiness probe.
import { spawnServer } from "./lib/reference-browser.mjs";

const serverSource = await Deno.readTextFile(new URL("../server.ts", import.meta.url));
if (!serverSource.includes("Listening on http://localhost:${server.addr.port}")) {
  throw new Error("reference-browser readiness requires server.ts to print its own listening port");
}

let failure;
const started = performance.now();
try {
  await spawnServer({ script: "scripts/__missing_reference_browser_fixture__.ts" });
} catch (error) {
  failure = error;
}
if (
  !failure?.message.includes("gendn server did not start for reference visibility validation") ||
  !failure.message.includes("__missing_reference_browser_fixture__.ts") ||
  !failure.message.includes("Module not found") ||
  !failure.message.includes("child exit 1") ||
  performance.now() - started >= 10_000
) {
  throw new Error(`startup diagnostic did not name the real fast failure: ${failure?.message}`);
}
// A child that stays alive without listening must also report its own stderr at the bound,
// rather than an unexplained "did not start" after the old 120 silent probes.
const stalledScript = await Deno.makeTempFile({
  prefix: "gendn-reference-stalled-",
  suffix: ".mjs",
});
try {
  await Deno.writeTextFile(
    stalledScript,
    'console.error("fixture startup blocked before listen"); setInterval(() => {}, 1000);\n',
  );
  let timedOut;
  try {
    await spawnServer({ script: stalledScript, startupTimeoutMs: 1500 });
  } catch (error) {
    timedOut = error;
  }
  if (
    !timedOut?.message.includes("startup timed out after 1500ms") ||
    !timedOut.message.includes("fixture startup blocked before listen") ||
    !timedOut.message.includes("signal SIGKILL")
  ) {
    throw new Error(`startup deadline did not include child diagnostics: ${timedOut?.message}`);
  }
} finally {
  await Deno.remove(stalledScript);
}
console.log("reference-browser startup fixture: child exit and timeout both name the real cause");
