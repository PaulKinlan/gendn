#!/usr/bin/env -S deno run
// cdp.test.mjs — committed fixtures for the cdp profile-dir tooling (gendn-bmi): the ps parse
// anomaly warning, its per-line dedupe, parse fidelity vs the merged dfc4c2c behaviour, and
// TMPDIR root resolution (incl. the empty-string → /tmp-like-unset case). No Chrome. Runs as
// `deno task test-cdp` and chained first in `deno task test-reference-contract`.
import { parseProcessListForDir, tmpRoot } from "./lib/cdp.mjs";

const DIR = "/tmp/gendn-cdp-424242-fixture";
let failures = 0;
function assert(desc, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${desc}`);
  if (!ok) failures++;
}

// Capture stderr without changing the module's API: intercept console.error for the run.
const warnings = [];
const origError = console.error;
console.error = (...args) => warnings.push(args.join(" "));

const wellFormed = [
  `48933 /bin/google-chrome-stable --headless=new --user-data-dir=${DIR} --remote-debugging-port=9333 about:blank`,
  `48972 /opt/google/chrome/chrome --type=utility --utility-sub-type=network.mojom.NetworkService --user-data-dir=${DIR}`,
  `60001 du -sb ${DIR}`, // references the dir, not Chrome-family: never signalled
  `${Deno.pid} /bin/google-chrome-stable --user-data-dir=${DIR}`, // self: never signalled
  "1 /sbin/init --log-target=syslog", // unrelated: filtered before any pid parse
  "1234 /usr/bin/not-ours --user-data-dir=/tmp/other-dir-x", // different dir entirely
].join("\n");

// (d) parse fidelity: exact pid set — same as the merged dfc4c2c parse for well-formed input
// (du/self/unrelated/other-dir excluded; no widening), and no warnings on clean lines.
assert(
  "well-formed input parses to exactly the Chrome pids (du/self/unrelated excluded)",
  JSON.stringify(parseProcessListForDir(wellFormed, DIR)) === "[48933,48972]",
);
assert("well-formed input produces no warnings", warnings.length === 0);

// (a) a malformed line whose args contain the target dir warns exactly once.
const badPid = `  12x /opt/google/chrome/chrome --user-data-dir=${DIR}`;
parseProcessListForDir(badPid, DIR);
assert("malformed line warns exactly once", warnings.length === 1);

// (b) a duplicated identical line adds no further warning (dedupe on the raw line).
parseProcessListForDir([badPid, badPid].join("\n"), DIR);
assert("duplicated identical line adds no warning", warnings.length === 1);

// (c) distinct malformed shapes still warn (no-space garbage, pid 0, negative pid).
parseProcessListForDir(`garbage-line-referencing-${DIR}-without-any-space`, DIR);
parseProcessListForDir(`0 /opt/google/chrome/chrome --user-data-dir=${DIR}`, DIR);
parseProcessListForDir(`-5 /opt/google/chrome/chrome --user-data-dir=${DIR}`, DIR);
assert("distinct malformed shapes each warn", warnings.length === 4);
assert(
  "warnings carry the WARNING tag and the path",
  warnings.every((w) => w.includes("[cdp] WARNING") && w.includes(DIR)),
);

console.error = origError;

// TMPDIR root-resolution pins (env manipulated then restored). These pin the single source
// of truth shared by makeTempDir's dir and the sweep: whatever TMPDIR says, creation and
// sweeping must resolve to the same absolute root.
const savedTmpdir = Deno.env.get("TMPDIR");
Deno.env.delete("TMPDIR");
assert('unset TMPDIR resolves to "/tmp"', tmpRoot() === "/tmp");
Deno.env.set("TMPDIR", "");
assert(
  'TMPDIR="" resolves to "/tmp" like unset (we own the makeTempDir dir, so Deno\'s cwd-relative quirk is overridden)',
  tmpRoot() === "/tmp",
);
Deno.env.set("TMPDIR", "/tmp/");
assert('TMPDIR="/tmp/" strips the trailing slash', tmpRoot() === "/tmp");
Deno.env.set("TMPDIR", "rel/dir");
assert("relative TMPDIR resolves against the CWD", tmpRoot() === `${Deno.cwd()}/rel/dir`);
if (savedTmpdir === undefined) Deno.env.delete("TMPDIR");
else Deno.env.set("TMPDIR", savedTmpdir);

if (failures > 0) {
  console.error(`cdp.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log("cdp parse fixture: all assertions passed");
