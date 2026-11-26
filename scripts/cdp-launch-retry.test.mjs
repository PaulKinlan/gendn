#!/usr/bin/env node
// cdp-launch-retry.test.mjs: the Chrome launch readiness budget and bounded relaunch in
// scripts/lib/cdp.mjs, driven through launchWith() with a fake Chrome and a fake clock. No
// browser, no real waiting, no files: every assertion is about what launch() does when Chrome is
// quick, slow, wedged, dead or absent.
//
// Why it exists: on 2026-11-24 two CI runs (45367330002, 45417883999) failed at the first Chrome
// launch of the job with "Chrome DevTools endpoint did not come up on requested port 9333". The
// fixed-port wait was about 10s and that Chrome needed longer. See the LAUNCH READINESS comment in
// cdp.mjs for the three changes these fixtures pin.
import {
  Browser,
  LAUNCH_ATTEMPTS,
  LAUNCH_PROBE_INTERVAL_MS,
  LAUNCH_PROBE_TIMEOUT_MS,
  LAUNCH_READY_BUDGET_MS,
  LAUNCH_RETRY_DELAY_MS,
  launchWith,
} from "./lib/cdp.mjs";

let failures = 0;
function assert(desc, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${desc}${ok || !detail ? "" : ` :: ${detail}`}`);
  if (!ok) failures++;
}

const ATTEMPT_BOUND_MS = LAUNCH_READY_BUDGET_MS + LAUNCH_PROBE_TIMEOUT_MS +
  LAUNCH_PROBE_INTERVAL_MS;

// A fake world for launchWith(). `plans[n]` scripts the n-th Chrome that gets spawned:
//   readyAt      ms after its spawn at which DevTools starts answering (omit: never)
//   exitAt/exitCode  it exits by itself at that time
//   probe        what a probe gets before readyAt: "refuse" (default) or "hang" (accepts, then
//                the probe times out, which costs LAUNCH_PROBE_TIMEOUT_MS of clock)
//   noPid        Node's missing binary: a child with no pid whose status rejects
//   throwOnSpawn Deno's missing binary: spawn throws
//   ignoresKill  survives every signal
//   announceAt   port=0 only: when it writes DevToolsActivePort (omit: never)
//   badPortFile  port=0 only: its DevToolsActivePort is malformed
function world(plans, { bins = ["chrome-a"], removeOk = () => true, extra = {} } = {}) {
  const w = { clock: 0, events: [], warnings: [], sleeps: [], children: [], probes: 0, dirs: 0 };
  const advance = (ms) => {
    w.clock += ms;
    for (const c of w.children) {
      if (c.alive && c.plan.exitAt !== undefined && w.clock - c.spawnedAt >= c.plan.exitAt) {
        c.exit({ success: false, code: c.plan.exitCode ?? 1, signal: null });
      }
    }
  };
  const current = () => w.children[w.children.length - 1];
  w.deps = {
    bins: () => bins,
    // Async wherever the real dependency is, so the fakes yield where production yields.
    sweep: async () => {
      w.events.push("sweep");
    },
    makeProfileDir: async () => {
      const dir = `/fake/gendn-cdp-${++w.dirs}`;
      w.events.push(`mkdir ${dir}`);
      return dir;
    },
    spawn: (bin, args) => {
      const plan = plans[w.children.length] ?? {};
      const n = w.children.length + 1;
      const child = { n, bin, args, plan, spawnedAt: w.clock, alive: false, pid: undefined };
      w.children.push(child);
      w.events.push(`spawn ${n} ${bin}`);
      if (plan.throwOnSpawn) throw new Error(`Failed to spawn '${bin}': No such file`);
      let settle, fail;
      child.status = new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      child.status.catch(() => {});
      if (plan.noPid) {
        fail(new Error(`Failed to spawn '${bin}': No such file or directory`));
        return child;
      }
      child.pid = 4000 + n;
      child.alive = true;
      child.exit = (status) => {
        child.alive = false;
        settle(status);
      };
      child.kill = (signal = "SIGTERM") => {
        w.events.push(`kill ${n} ${signal}`);
        if (child.alive && !plan.ignoresKill) child.exit({ success: false, code: 143, signal });
      };
      advance(0); // an exitAt of 0 means it is dead on arrival
      return child;
    },
    fetch: async (url) => {
      w.probes++;
      const port = Number(new URL(url).port);
      const c = current();
      if (c.alive && c.plan.readyAt !== undefined && w.clock - c.spawnedAt >= c.plan.readyAt) {
        return {
          ok: true,
          status: 200,
          json: () => ({
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-${c.n}`,
          }),
        };
      }
      if (c.alive && c.plan.probe === "hang") {
        advance(LAUNCH_PROBE_TIMEOUT_MS);
        const timeout = new Error("The operation was aborted due to timeout");
        timeout.name = "TimeoutError";
        throw timeout;
      }
      const refused = new Error(`connect ECONNREFUSED 127.0.0.1:${port}`);
      refused.code = "ECONNREFUSED";
      throw new TypeError("fetch failed", { cause: refused });
    },
    ownedPort: async () => {
      const c = current();
      if (c.plan.badPortFile) throw new Error("Chrome wrote an invalid DevToolsActivePort");
      if (!c.alive || c.plan.announceAt === undefined) return null;
      return w.clock - c.spawnedAt >= c.plan.announceAt ? 45678 : null;
    },
    removeProfileDir: async (dir) => {
      w.events.push(`rm ${dir}`);
      return removeOk(dir);
    },
    sleep: async (ms) => {
      w.sleeps.push(ms);
      advance(ms);
    },
    now: () => w.clock,
    warn: (line) => w.warnings.push(line),
    ...extra,
  };
  w.launch = async (port = 9333) => {
    try {
      return { browser: await launchWith(w.deps, { port }) };
    } catch (error) {
      return { error };
    }
  };
  w.lifecycle = () => w.events.filter((e) => !e.startsWith("sweep")).join(" | ");
  return w;
}

const REFUSED_9333 = "Chrome DevTools endpoint did not come up on requested port 9333: " +
  "DevTools port 9333 not ready: fetch failed (ECONNREFUSED)";

// The bounds themselves. A change here is a deliberate decision, not a drive-by.
assert("the relaunch count is bounded and small (2 attempts in total)", LAUNCH_ATTEMPTS === 2);
assert("every launch path waits the same 30s for DevTools", LAUNCH_READY_BUDGET_MS === 30_000);

// 1. Succeeds first time: one Chrome, nothing killed, nothing removed, nothing said.
{
  const w = world([{ readyAt: 300 }]);
  const { browser, error } = await w.launch();
  assert("a quick Chrome launches on the first attempt", browser instanceof Browser, `${error}`);
  assert(
    "the browser is the spawned child, on the requested port, in the profile dir it was given",
    browser?.child === w.children[0] && browser?.port === 9333 &&
      browser?.wsUrl === "ws://127.0.0.1:9333/devtools/browser/fake-1" &&
      browser?.userDataDir === "/fake/gendn-cdp-1",
  );
  assert(
    "Chrome is started with that profile dir and port",
    w.children[0].args.includes("--user-data-dir=/fake/gendn-cdp-1") &&
      w.children[0].args.includes("--remote-debugging-port=9333") &&
      w.children[0].args.includes("--headless=new"),
  );
  assert(
    "a first-time success spawns once and cleans up nothing",
    w.lifecycle() === "mkdir /fake/gendn-cdp-1 | spawn 1 chrome-a",
    w.lifecycle(),
  );
  assert("a first-time success prints no warning", w.warnings.length === 0);
}

// 2. The CI case: a cold Chrome that needs 12s on a fixed port. The old 10s wait killed it.
{
  const w = world([{ readyAt: 12_000 }]);
  const { browser, error } = await w.launch();
  assert(
    "a fixed-port Chrome that needs 12s is waited for, not killed at 10s",
    browser instanceof Browser && w.children.length === 1 && w.warnings.length === 0,
    `${error}`,
  );
  assert(
    "the wait took as long as Chrome needed and no longer",
    w.clock >= 12_000 && w.clock < 12_500,
  );
  const edge = world([{ readyAt: LAUNCH_READY_BUDGET_MS - LAUNCH_PROBE_INTERVAL_MS }]);
  assert(
    "a Chrome that is ready just inside the budget still launches on the first attempt",
    (await edge.launch()).browser instanceof Browser && edge.children.length === 1,
  );
}

// 3. Succeeds after a transient failure, and cleans up between attempts.
{
  const w = world([{}, { readyAt: 300 }]);
  const { browser, error } = await w.launch();
  assert(
    "a Chrome that never came up is relaunched, and the relaunch succeeds",
    browser instanceof Browser,
    `${error}`,
  );
  assert(
    "the browser returned is the SECOND Chrome with the second profile dir",
    browser?.child === w.children[1] && browser?.userDataDir === "/fake/gendn-cdp-2" &&
      browser?.wsUrl.endsWith("fake-2"),
  );
  assert(
    "the first Chrome is killed and its profile dir removed BEFORE the second is spawned",
    w.lifecycle() ===
      "mkdir /fake/gendn-cdp-1 | spawn 1 chrome-a | kill 1 SIGTERM | rm /fake/gendn-cdp-1 | " +
        "mkdir /fake/gendn-cdp-2 | spawn 2 chrome-a",
    w.lifecycle(),
  );
  assert(
    "the first Chrome is really gone",
    w.children[0].alive === false && w.children[1].alive === true,
  );
  assert(
    "each attempt runs the stale-profile sweep",
    w.events.filter((e) => e === "sweep").length === 2,
  );
  assert(
    "the relaunch is announced: attempt number, the bound, and the first attempt's own error",
    w.warnings.length === 2 &&
      w.warnings[0].startsWith("[cdp] WARNING: Chrome launch attempt 1/2 failed: ") &&
      w.warnings[0].includes(REFUSED_9333) && w.warnings[0].includes("Chrome was still running") &&
      w.warnings[1].includes("attempt 2/2 succeeded"),
    w.warnings.join("\n"),
  );
  assert(
    "the first attempt used its whole budget and no more, then one short pause",
    w.sleeps.includes(LAUNCH_RETRY_DELAY_MS) && w.clock >= LAUNCH_READY_BUDGET_MS &&
      w.clock <= ATTEMPT_BOUND_MS + LAUNCH_RETRY_DELAY_MS + 500,
    `${w.clock}ms`,
  );

  const crash = world([{ exitAt: 500, exitCode: 139 }, { readyAt: 300 }]);
  const crashed = await crash.launch();
  assert(
    "a Chrome that crashes during startup is relaunched at once, not after the full budget",
    crashed.browser?.child === crash.children[1] && crash.clock < 2_000 &&
      crash.warnings[0].includes("Chrome exited before DevTools was ready (exit 139)"),
    `${crashed.error} at ${crash.clock}ms`,
  );
}

// 4. Fails after the bounded number of attempts, with the original error preserved.
{
  // The two attempts fail DIFFERENTLY (refused, then accepted-but-silent) so the assertions can
  // tell the first error from the last. A third Chrome WOULD work; it must never be tried.
  const w = world([{}, { probe: "hang" }, { readyAt: 0 }]);
  const { browser, error } = await w.launch();
  assert("a Chrome that never comes up fails the launch", !browser && error instanceof Error);
  assert(
    `exactly ${LAUNCH_ATTEMPTS} Chromes are spawned, never a third`,
    w.children.length === LAUNCH_ATTEMPTS,
  );
  assert(
    "the error starts with the first attempt's message, word for word",
    error?.message.startsWith(`${REFUSED_9333} [waited `) &&
      error.message.startsWith(error.cause?.message),
    error?.message,
  );
  assert(
    "the original error object is preserved as the cause, and every attempt's error is kept",
    error?.cause instanceof Error && error.attempts?.length === LAUNCH_ATTEMPTS &&
      error.attempts[0] === error.cause && error.cause.message.includes("ECONNREFUSED") &&
      !error.cause.message.includes("aborted due to timeout"),
  );
  assert(
    "the error names the later attempt and says Chrome was still running each time",
    error?.message.includes(
      "; launch attempt 2/2 also failed: Chrome DevTools endpoint did not come up on requested " +
        "port 9333: DevTools port 9333 not ready: The operation was aborted due to timeout",
    ) &&
      error.message.split("Chrome was still running").length === 3,
    error?.message,
  );
  assert(
    "both failed Chromes are killed and both profile dirs removed",
    w.lifecycle() ===
        "mkdir /fake/gendn-cdp-1 | spawn 1 chrome-a | kill 1 SIGTERM | rm /fake/gendn-cdp-1 | " +
          "mkdir /fake/gendn-cdp-2 | spawn 2 chrome-a | kill 2 SIGTERM | rm /fake/gendn-cdp-2" &&
      w.children.every((c) => !c.alive),
    w.lifecycle(),
  );
  assert(
    "the total wait is bounded by attempts x (budget + one probe) + the pause",
    w.clock <= LAUNCH_ATTEMPTS * ATTEMPT_BOUND_MS + LAUNCH_RETRY_DELAY_MS,
    `${w.clock}ms`,
  );
  assert("one relaunch warning, and no success line", w.warnings.length === 1);
}

// 5. A wedged port is bounded by the clock, not by a probe count: 300 probes x 2.1s was 630s.
{
  const w = world([{ probe: "hang" }, { probe: "hang" }]);
  const { error } = await w.launch();
  assert(
    "a port that accepts but never answers still fails within the wall-clock bound",
    error?.message.includes("The operation was aborted due to timeout") &&
      w.clock <= LAUNCH_ATTEMPTS * ATTEMPT_BOUND_MS + LAUNCH_RETRY_DELAY_MS,
    `${w.clock}ms :: ${error?.message}`,
  );
  assert("it stops probing when the time is up", w.probes <= 2 * 16, `${w.probes} probes`);
}

// 6. A fixed-port Chrome that is already dead does not burn the budget.
{
  const w = world([{ exitAt: 0, exitCode: 33 }, { exitAt: 0, exitCode: 33 }]);
  const { error } = await w.launch();
  assert(
    "a fixed-port Chrome that exits at once fails fast and names its exit code",
    error?.message.includes("Chrome exited before DevTools was ready (exit 33)") &&
      error.message.includes("Chrome had exited (exit 33)") && w.clock <= LAUNCH_RETRY_DELAY_MS,
    `${w.clock}ms :: ${error?.message}`,
  );
  assert("it is still relaunched once and only once", w.children.length === LAUNCH_ATTEMPTS);
  assert(
    "one probe per dead Chrome, not a budget of them",
    w.probes === LAUNCH_ATTEMPTS,
    `${w.probes}`,
  );
}

// 7. No relaunch on top of cleanup that could not be confirmed.
{
  const gaveUp = [];
  const w = world([{ ignoresKill: true }, { readyAt: 0 }], {
    extra: { terminate: async (child) => gaveUp.push(child.n) }, // the real one would wait 10s for real
  });
  const { error } = await w.launch();
  assert(
    "a Chrome that cannot be confirmed dead is NOT followed by a relaunch",
    w.children.length === 1 && gaveUp.join() === "1" && w.warnings.length === 0 &&
      error?.message.startsWith(REFUSED_9333) &&
      error.message.endsWith(
        "not relaunching: the failed attempt's Chrome process could not be confirmed dead",
      ),
    error?.message,
  );
  const stuck = world([{}, { readyAt: 0 }], { removeOk: () => false });
  const stuckResult = await stuck.launch();
  assert(
    "a profile dir that could not be removed is NOT followed by a relaunch",
    stuck.children.length === 1 && stuckResult.error?.cause instanceof Error &&
      stuckResult.error.message.endsWith(
        "not relaunching: the failed attempt's profile dir /fake/gendn-cdp-1 could not be removed",
      ),
    stuckResult.error?.message,
  );
}

// 8. No Chrome binary is not a transient failure: it throws at once and is never retried.
{
  for (
    const [label, plan] of [["no pid (Node)", { noPid: true }], ["a throw (Deno)", {
      throwOnSpawn: true,
    }]]
  ) {
    const w = world([plan, plan, { readyAt: 0 }], { bins: ["chrome-a", "chrome-b"] });
    const { error } = await w.launch();
    assert(
      `a missing binary reported as ${label} tries each candidate once, then fails without relaunching`,
      error?.message.startsWith("could not launch Chrome (tried chrome-a, chrome-b): ") &&
        error.message.includes("Failed to spawn 'chrome-b'") &&
        w.lifecycle() ===
          "mkdir /fake/gendn-cdp-1 | spawn 1 chrome-a | spawn 2 chrome-b | rm /fake/gendn-cdp-1" &&
        w.warnings.length === 0 && w.clock === 0,
      `${error?.message} :: ${w.lifecycle()}`,
    );
  }
  const w = world([{ noPid: true }, { readyAt: 100 }], { bins: ["missing", "chrome-b"] });
  const { browser } = await w.launch();
  assert(
    "a missing first candidate falls through to the next one within the same attempt",
    browser?.child === w.children[1] && w.children[1].bin === "chrome-b" && w.dirs === 1 &&
      w.warnings.length === 0,
  );
}

// 9. port=0 keeps its own-port contract and gets the same relaunch.
{
  const w = world([{ exitAt: 0, exitCode: 33 }, { announceAt: 200, readyAt: 300 }]);
  const { browser, error } = await w.launch(0);
  assert(
    "port=0: a Chrome that dies before announcing its port is relaunched, and the port is the announced one",
    browser?.port === 45678 && browser.child === w.children[1] &&
      w.warnings[0].includes(
        "Chrome did not establish its own DevTools port: Chrome exited before announcing its " +
          "DevTools port (exit 33); DevToolsActivePort in /fake/gendn-cdp-1",
      ),
    `${error} :: ${w.warnings.join("\n")}`,
  );
  assert(
    "port=0: the --remote-debugging-port=0 request is preserved on both attempts",
    w.children.every((c) => c.args.includes("--remote-debugging-port=0")),
  );
  const silent = world([{}, {}]);
  const silentResult = await silent.launch(0);
  assert(
    "port=0: nothing is probed until Chrome announces a port, and the wait is the same budget",
    silent.probes === 0 && silentResult.error?.message.includes("endpoint not ready") &&
      silent.clock <= LAUNCH_ATTEMPTS * ATTEMPT_BOUND_MS + LAUNCH_RETRY_DELAY_MS &&
      silent.clock >= LAUNCH_ATTEMPTS * LAUNCH_READY_BUDGET_MS,
    `${silent.probes} probes, ${silent.clock}ms`,
  );
  const bad = world([{ badPortFile: true }, { badPortFile: true }]);
  const badResult = await bad.launch(0);
  assert(
    "port=0: a malformed DevToolsActivePort keeps its named error, and Chrome is still cleaned up",
    badResult.error?.message.startsWith("Chrome wrote an invalid DevToolsActivePort") &&
      badResult.error.cause?.message === "Chrome wrote an invalid DevToolsActivePort" &&
      bad.children.length === LAUNCH_ATTEMPTS && bad.children.every((c) => !c.alive) &&
      bad.events.filter((e) => e.startsWith("rm ")).length === LAUNCH_ATTEMPTS,
    badResult.error?.message,
  );
}

if (failures > 0) {
  console.error(`cdp-launch-retry.test.mjs: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("cdp launch-retry fixture: all assertions passed (no browser, fake clock)");
