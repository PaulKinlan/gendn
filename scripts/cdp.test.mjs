#!/usr/bin/env -S deno run
// cdp.test.mjs — committed fixtures for the cdp profile-dir tooling (gendn-bmi): the ps parse
// anomaly warning, its per-line dedupe, parse fidelity vs the merged dfc4c2c behaviour, and
// TMPDIR root resolution (incl. the empty-string → /tmp-like-unset case). No Chrome. Runs as
// `deno task test-cdp` and chained first in `deno task test-reference-contract`.
import {
  CDP_TIMEOUT_MAX_MS,
  CDP_TIMEOUT_MIN_MS,
  CDP_TIMEOUT_MS,
  classifyOrigin,
  configuredCdpTimeoutMs,
  Conn,
  isLocalNavigation,
  parseCdpTimeoutMs,
  parseProcessListForDir,
  tmpRoot,
} from "./lib/cdp.mjs";

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

// gendn-ybg4: the default remains bounded, and the optional override cannot disable it.
{
  const invalidWarnings = [];
  assert("unset CDP timeout keeps the 30s default", parseCdpTimeoutMs(undefined) === 30_000);
  assert(
    "valid override and inclusive bounds are interpreted as milliseconds",
    parseCdpTimeoutMs("45000") === 45_000 &&
      parseCdpTimeoutMs("1000") === CDP_TIMEOUT_MIN_MS &&
      parseCdpTimeoutMs("120000") === CDP_TIMEOUT_MAX_MS,
  );
  const invalid = ["", "0", "-1", "999", "120001", "1e6", "30000.5", " 30000 ", "NaN", "Infinity"];
  for (const raw of invalid) {
    assert(
      `invalid CDP timeout ${JSON.stringify(raw)} falls back to 30s`,
      parseCdpTimeoutMs(raw, (warning) => invalidWarnings.push(warning)) === CDP_TIMEOUT_MS,
    );
  }
  assert(
    "each invalid value warns without logging its raw contents",
    invalidWarnings.length === invalid.length &&
      invalidWarnings.every((warning) =>
        warning.includes("GENDN_CDP_TIMEOUT_MS") &&
        warning.includes("[1000, 120000]") && !warning.includes("Infinity")
      ),
  );

  const name = "GENDN_CDP_TIMEOUT_MS";
  const saved = Deno.env.get(name);
  try {
    Deno.env.delete(name);
    assert("lazy unset env uses default", configuredCdpTimeoutMs() === CDP_TIMEOUT_MS);
    Deno.env.set(name, "2500");
    assert("lazy env read picks up a new override", configuredCdpTimeoutMs() === 2500);
    Deno.env.set(name, "1000");
    const stub = new Conn({ send() {}, onmessage: null });
    let rejected = "";
    try {
      await stub.send("Runtime.evaluate"); // no explicit timeout: exercise the production default
    } catch (err) {
      rejected = err.message;
    }
    assert("the env override reaches CDP pendingCall", rejected.includes("within 1000ms"));
    assert("env-bounded call removes its pending entry", stub.pending.size === 0);

    Deno.env.set(name, "invalid-value");
    const warnings = [];
    const original = console.error;
    console.error = (...args) => warnings.push(args.join(" "));
    try {
      assert(
        "invalid env falls back rather than aborting the gate",
        configuredCdpTimeoutMs() === CDP_TIMEOUT_MS &&
          configuredCdpTimeoutMs() === CDP_TIMEOUT_MS,
      );
    } finally {
      console.error = original;
    }
    assert("invalid env warns once across repeated CDP calls", warnings.length === 1);
  } finally {
    if (saved === undefined) Deno.env.delete(name);
    else Deno.env.set(name, saved);
  }
}

// gendn-8na: the gate browser's navigation whitelist (the control that bounds --no-sandbox).
assert("localhost route allowed", isLocalNavigation("http://localhost:3000/v150/x/"));
assert("127.0.0.1 allowed", isLocalNavigation("http://127.0.0.1:4000/"));
assert("about:blank allowed", isLocalNavigation("about:blank"));
assert("off-site https refused", !isLocalNavigation("https://example.com/"));
assert(
  "showcase origin refused",
  !isLocalNavigation("https://chrome-platform-showcase.paulkinlan-ea.deno.net/v1/x"),
);
assert("lookalike host refused", !isLocalNavigation("http://localhost.evil.example/"));
assert("userinfo trick refused", !isLocalNavigation("http://localhost@evil.example/"));
assert("IPv6 loopback allowed", isLocalNavigation("http://[::1]:3000/"));
assert("IPv4-mapped IPv6 refused", !isLocalNavigation("http://[::ffff:8.8.8.8]/"));
assert(
  "chrome-error classified as navigation failure",
  classifyOrigin("chrome-error://chromewebdata/") === "navigation-failed",
);
assert("local href classified local", classifyOrigin("http://127.0.0.1:1234/x") === "local");
assert(
  "external href classified off-origin",
  classifyOrigin("https://example.com/") === "off-origin",
);
assert(
  "other localhost port stays local (hostname-only, documented)",
  classifyOrigin("http://localhost:9/") === "local",
);
assert("file: refused", !isLocalNavigation("file:///etc/passwd"));
assert("garbage refused", !isLocalNavigation("not a url"));

// gendn-8na: lazy loading is the control that keeps third-party iframes unloaded by a non-scrolling
// gate. If any external iframe loses loading="lazy", that control is gone: fail.
{
  const bad = [];
  let external = 0;
  for await (const rel of Deno.readDir(".")) {
    if (!(rel.isDirectory && /^v\d+$/.test(rel.name))) continue;
    for await (const slug of Deno.readDir(rel.name)) {
      if (!slug.isDirectory) continue;
      const page = `${rel.name}/${slug.name}/index.html`;
      let html;
      try {
        html = await Deno.readTextFile(page);
      } catch {
        continue;
      }
      for (const m of html.matchAll(/<iframe\b[^>]*>/gi)) {
        if (!/\bsrc\s*=\s*["']?https?:\/\//i.test(m[0])) continue;
        external++;
        if (!/\bloading\s*=\s*["']?lazy/i.test(m[0])) bad.push(page);
      }
    }
  }
  assert(
    `every third-party iframe is loading=lazy (${external} checked)`,
    external > 0 && bad.length === 0,
  );
  if (bad.length) console.error(bad.join("\n"));
}

// A DEAD TARGET MUST NOT HANG THE GATE (gendn-1tu). Conn.send parked its {resolve,reject} in the
// pending map and never deleted or bounded it, so a wedged Chrome target hung the caller forever -
// at the top of a gate that is "Top-level await promise never resolved" with zero output. This uses
// a stub socket, so it needs no Chrome.
{
  const stub = new Conn({ send() {}, onmessage: null });
  const started = performance.now();
  let rejected = "";
  try {
    await stub.send("Runtime.evaluate", {}, undefined, 25);
  } catch (err) {
    rejected = err.message;
  }
  assert(
    "a CDP call that never gets a reply REJECTS instead of hanging",
    rejected.includes("did not reply within 25ms") && rejected.includes("Runtime.evaluate"),
    rejected || "(resolved - the bound did not fire)",
  );
  assert(
    "the timed-out call is removed from the pending map",
    stub.pending.size === 0,
    `pending=${stub.pending.size}`,
  );
  assert(
    "the bound is applied, not bypassed",
    performance.now() - started >= 20,
    `${Math.round(performance.now() - started)}ms`,
  );
  // ...and the happy path still resolves, with the timer cleared (no spurious late rejection).
  const socket = {
    sent: null,
    send(payload) {
      this.sent = JSON.parse(payload);
    },
    onmessage: null,
  };
  const stub2 = new Conn(socket);
  const call = stub2.send("Runtime.evaluate", {}, undefined, 5000);
  socket.onmessage({ data: JSON.stringify({ id: socket.sent.id, result: { value: 7 } }) });
  const resolved = await call;
  assert("a replied CDP call still resolves", resolved.value === 7, JSON.stringify(resolved));
  assert("a replied call leaves nothing pending", stub2.pending.size === 0);
}

if (failures > 0) {
  console.error(`cdp.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log("cdp parse fixture: all assertions passed");
