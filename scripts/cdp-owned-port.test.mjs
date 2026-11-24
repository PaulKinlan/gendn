// Hold a real local port while Chrome starts: port=0 must use the port THIS child bound,
// not a close-and-rebind guess that could collide with the occupied socket.
import * as sys from "./lib/sys.mjs";
import { launch, ownedDevToolsPort } from "./lib/cdp.mjs";

const held = sys.listen({ hostname: "127.0.0.1", port: 0 });
await held.ready;
let browser;
try {
  browser = await launch({ port: 0 });
  if (!browser.port || browser.port === held.addr.port) {
    throw new Error(`Chrome did not own a distinct assigned port: ${browser.port}`);
  }
  await browser.connect();
  const version = await browser.conn.send("Browser.getVersion");
  if (!version?.product?.includes("Chrome")) {
    throw new Error(
      `assigned DevTools port did not answer from Chrome: ${JSON.stringify(version)}`,
    );
  }
} finally {
  try {
    await browser?.close();
  } finally {
    held.close();
  }
}
const scratch = await sys.makeTempDir({ prefix: "gendn-cdp-port-proof-" });
try {
  if (await ownedDevToolsPort(scratch) !== null) {
    throw new Error("missing DevToolsActivePort was treated as an owned port");
  }
  await sys.writeTextFile(`${scratch}/DevToolsActivePort`, "not-a-port\n/devtools/browser/fake\n");
  let invalid;
  try {
    await ownedDevToolsPort(scratch);
  } catch (error) {
    invalid = error;
  }
  if (!invalid?.message.includes("invalid DevToolsActivePort")) {
    throw new Error(`malformed child port did not give a named diagnostic: ${invalid?.message}`);
  }
} finally {
  await sys.remove(scratch, { recursive: true });
}
// If the child dies before binding, the gate must say WHICH owned-port signal is missing and
// report the child exit, rather than a generic CDP connection error to an unrelated browser.
const fakeDir = await sys.makeTempDir({ prefix: "gendn-cdp-exit-proof-" });
const previousChrome = sys.env.get("CHROME_BIN");
try {
  const fake = `${fakeDir}/chrome-exits`;
  await sys.writeTextFile(fake, "#!/bin/sh\nexit 33\n");
  await sys.chmod(fake, 0o700);
  sys.env.set("CHROME_BIN", fake);
  let failure;
  try {
    await launch({ port: 0 });
  } catch (error) {
    failure = error;
  }
  if (
    !failure?.message.includes("Chrome did not establish its own DevTools port") ||
    !failure.message.includes("exit 33") ||
    !failure.message.includes("DevToolsActivePort")
  ) {
    throw new Error(`early Chrome exit had no named cause: ${failure?.message}`);
  }
} finally {
  if (previousChrome === undefined) sys.env.delete("CHROME_BIN");
  else sys.env.set("CHROME_BIN", previousChrome);
  await sys.remove(fakeDir, { recursive: true });
}
console.log(
  "CDP owned-port fixture: held-port collision avoided; malformed and exited-child causes named",
);
