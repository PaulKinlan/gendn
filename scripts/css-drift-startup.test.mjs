// Startup diagnostics are a separate, browser-free fixture: the real CSS-drift fixture still
// drives the normal browser sweep and compares computed styles.
import { spawnCssServer } from "./css-drift.mjs";

const serverSource = await Deno.readTextFile(new URL("../server.ts", import.meta.url));
if (!serverSource.includes("Listening on http://localhost:${server.addr.port}")) {
  throw new Error("CSS drift readiness requires server.ts to print its own listening port");
}
let failure;
const started = performance.now();
try {
  await spawnCssServer({ script: "scripts/__missing_css_drift_fixture__.ts" });
} catch (error) {
  failure = error;
}
if (
  !failure?.message.includes("gendn server did not start for CSS drift:") ||
  !failure.message.includes("__missing_css_drift_fixture__.ts") ||
  !failure.message.includes("Module not found") ||
  !failure.message.includes("child exit 1") ||
  performance.now() - started >= 10_000
) {
  throw new Error(`early server failure did not name child cause: ${failure?.message}`);
}
const stalledScript = await Deno.makeTempFile({ prefix: "gendn-css-stalled-", suffix: ".mjs" });
try {
  await Deno.writeTextFile(
    stalledScript,
    'console.error("fixture CSS server blocked before listen"); setInterval(() => {}, 1000);\n',
  );
  let timedOut;
  try {
    await spawnCssServer({ script: stalledScript, startupTimeoutMs: 1500 });
  } catch (error) {
    timedOut = error;
  }
  if (
    !timedOut?.message.includes("startup timed out after 1500ms") ||
    !timedOut.message.includes("fixture CSS server blocked before listen") ||
    !timedOut.message.includes("signal SIGKILL")
  ) {
    throw new Error(`bounded startup failure lost diagnostics: ${timedOut?.message}`);
  }
} finally {
  await Deno.remove(stalledScript);
}
console.log("css-drift startup fixture: child exit and timeout name the actual cause");
