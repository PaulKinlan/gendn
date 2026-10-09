// Guards collectReferenceContracts' INPUT-ORDER error reporting (gendn-kq4).
//
// WHY THIS IS NOT JUST A BLOCK INSIDE reference-contract.test.mjs (gendn-kq4 review P1). That file is
// chained into `test-reference-contract`, which scripts/run-fixtures.mjs EXCLUDES as browser-backed,
// because the chain also runs cdp.test.mjs and reference-browser.test.mjs. Before the dedicated CI
// browser step was added, a guard written there was reached by nothing automatic: CI did not invoke
// that task, and the aggregate excluded it. This file remains browser-free and aggregate-discovered
// so its input-order guard runs without Chrome as well. Same reasoning
// that moved the pure citation assertions into citation-canonical.test.mjs (gendn-4ck).
//
// THE CONTROL FOR THIS FILE IS THE RUNNER'S EXIT CODE, NOT A COUNT OF ITS PASS LINES (gendn-ijf).
//     deno task test-reference-contract-order; echo "exit=$?"      <- the verdict is the exit code
//
// WHAT IT LOCKS IN. collectReferenceContracts() used to await readJson() one ownerId at a time and report
// the FIRST failing ownerId in INPUT order. Its first concurrent form used Promise.all, which reports
// whichever rejection SETTLES first - a flaky gate message: measured, three different outcomes in twelve
// runs of a two-failure fixture. The shipped form uses allSettled and rethrows the first rejection IN
// INPUT ORDER, which reproduces the serial behaviour exactly.
//
// Each order is repeated several times because the failure mode is INTERMITTENT, not a stable reversal:
// with Promise.all substituted back, this guard was measured failing on 17/17 runs, but 2 of those
// needed more than one attempt - so a single-attempt guard would be green roughly 12% of the time.
import { collectReferenceContracts } from "./lib/reference-contract.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = await Deno.makeTempDir({ prefix: "gendn-reference-contract-order-" });
try {
  await Deno.mkdir(`${root}/err-a`, { recursive: true });
  await Deno.mkdir(`${root}/err-b`, { recursive: true });
  // Two DIFFERENT malformed bodies, so the error text identifies WHICH ownerId failed.
  await Deno.writeTextFile(`${root}/err-a/reference-contract.json`, "[1,\n"); // -> Unexpected end of JSON input
  await Deno.writeTextFile(`${root}/err-b/reference-contract.json`, "{bad}\n"); // -> Expected property name ...

  const attempts = 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let ab = "";
    try {
      await collectReferenceContracts(root, ["err-a", "err-b"]);
    } catch (err) {
      ab = String(err.message);
    }
    assert(
      ab.includes("Unexpected end of JSON input"),
      `collectReferenceContracts must report the FIRST failing id in INPUT order ` +
        `(err-a,err-b attempt ${attempt}): got ${JSON.stringify(ab)}`,
    );

    let ba = "";
    try {
      await collectReferenceContracts(root, ["err-b", "err-a"]);
    } catch (err) {
      ba = String(err.message);
    }
    assert(
      ba.includes("Expected property name"),
      `collectReferenceContracts must report the FIRST failing id in INPUT order ` +
        `(err-b,err-a attempt ${attempt}): got ${JSON.stringify(ba)}`,
    );
  }

  console.log("PASS — reference-contract input-order error guards");
} finally {
  await Deno.remove(root, { recursive: true });
}
