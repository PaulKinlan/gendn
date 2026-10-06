// cdp.mjs — a small, dependency-free Chrome DevTools Protocol client for the conformance runner.
//
// The routine environment has `google-chrome-stable --headless=new` but no chrome-devtools-mcp, so
// the runner drives headless Chrome over the DevTools WebSocket directly. This is deterministic:
// fixed viewports, load-event waits, no random timing baked into results.
//
// Chrome profile dirs (TMPDIR/gendn-cdp-*) are a managed resource: every launch creates one,
// every close() removes it with retry/backoff (Chrome's crashpad/GPU helpers can outlive the main
// process and race a one-shot remove), a failed removal is LOUD (stderr warning — never a silent
// swallow), and every launch sweeps dirs orphaned by crashed/killed runs first. The sweep is safe
// against concurrent runs: dirs are pid-tagged and only reclaimed when the owning process is gone
// (or, for legacy untagged dirs, when no live Chrome holds the dir's SingletonLock and the dir is
// well past the spawn window).
//
// Usage:
//   const browser = await launch();
//   const page = await browser.newPage({ width, height, mobile, deviceScaleFactor });
//   await page.goto("http://localhost:3000/v149/webmcp/");
//   const ok = await page.evaluate("document.querySelector('h1') !== null");
//   await page.screenshot("/tmp/shot.png");
//   const { consoleErrors, failedRequests } = page.diagnostics();
//   await page.close(); await browser.close();

function findChrome() {
  const candidates = [
    Deno.env.get("CHROME_BIN"),
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "chrome",
  ].filter(Boolean);
  return candidates;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Chrome process termination ----------

// Terminate a spawned Chrome deterministically: SIGTERM with a bounded wait, then SIGKILL.
// An unbounded await on a wedged Chrome would hang the whole gate.
async function terminateChild(child) {
  try {
    child.kill();
  } catch {
    // already exited
  }
  try {
    const st = await Promise.race([child.status, sleep(5000).then(() => null)]);
    if (st === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      try {
        await Promise.race([child.status, sleep(5000).then(() => null)]);
      } catch {
        // ignore
      }
    }
  } catch {
    // status already settled
  }
}

// PIDs of any Chrome-family process still referencing this profile dir. The main browser
// carries --user-data-dir=<path>, but helper processes reference the dir differently (e.g.
// chrome_crashpad_handler is spawned with --database=<path>/Crashpad --metrics-dir=<path>...),
// and those helpers can outlive the main process and RE-CREATE profile files after a
// successful recursive remove — so they must be gone before we remove.
//
// Implemented via `ps`, NOT /proc: Deno categorically denies procfs reads under `deno run`
// ("Requires all access to /proc" unless --allow-all), and the gate tasks run with an
// explicit permission set — so a /proc-based scan silently degrades to a no-op in every
// real gate run. --allow-run is already required to launch Chrome, which makes `ps` the one
// dependable process-list primitive available in every caller. If `ps` itself fails we say
// so loudly instead of silently skipping the kill. The random temp dir name keeps a plain
// path substring match precise; the argv0/--user-data-dir checks mean we never signal
// unrelated processes (e.g. a concurrent `du /tmp/gendn-cdp-<that-exact-dir>`) that merely
// mention the path. Exported so the parse behaviour can be exercised by a fixture directly.
// Malformed matched-path lines we have already warned about (dedup: the kill loop calls the
// parser every ~100ms, and repeating the same warning would flood the gate log). Never pruned:
// growth is bounded by the number of DISTINCT anomalous lines — ~zero in a normal gate run.
const warnedParseAnomalies = new Set();

export function parseProcessListForDir(out, path) {
  const pids = [];
  for (const line of out.split("\n")) {
    if (!line.includes(path)) continue;
    const trimmed = line.trimStart();
    const sp = trimmed.indexOf(" ");
    const pid = sp < 0 ? NaN : Number(trimmed.slice(0, sp));
    if (!Number.isInteger(pid) || pid < 1) {
      // A ps line that references the dir but carries no parseable pid is an output anomaly.
      // Never silent (this file's original bug was a silent catch), never fatal: warn once,
      // skip the line, keep parsing the rest.
      if (!warnedParseAnomalies.has(line)) {
        warnedParseAnomalies.add(line);
        console.error(
          `[cdp] WARNING: ps line references ${path} but has no parseable pid ` +
            `(${JSON.stringify(line.slice(0, 120))}); skipping it — the pre-remove kill ` +
            `may miss a process`,
        );
      }
      continue;
    }
    if (pid === Deno.pid) continue;
    const args = trimmed.slice(sp + 1).trim();
    const argv0 = args.split(" ")[0] ?? "";
    if (args.includes(`--user-data-dir=${path}`) || argv0.includes("chrom")) pids.push(pid);
  }
  return pids;
}

async function pidsUsingDir(path) {
  try {
    const cmd = new Deno.Command("ps", { args: ["-eo", "pid=,args="], stdout: "piped" });
    const { stdout } = await cmd.output();
    return parseProcessListForDir(new TextDecoder().decode(stdout), path);
  } catch (err) {
    console.error(
      `[cdp] WARNING: cannot list processes (ps failed: ${err.message}); skipping the ` +
        `pre-remove kill for ${path} — removal may race lingering Chrome helpers`,
    );
    return [];
  }
}

async function killProcessesUsingDir(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = await pidsUsingDir(path);
    if (pids.length === 0) return true;
    for (const pid of pids) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await sleep(100);
  }
  return (await pidsUsingDir(path)).length === 0;
}

// ---------- Chrome profile dir lifecycle (gendn-cdp-*) ----------

const PROFILE_PREFIX = "gendn-cdp-";
// Profile dirs created by THIS process and not yet removed (tracked so the sweep never
// reclaims the dir of a browser we are still using during RECYCLE_EVERY relaunches).
const liveProfileDirs = new Set();

// Conservative liveness probe: signal 0 only checks existence/permissions. Unknown errors
// (e.g. PermissionDenied for another user's process) count as ALIVE so we never sweep on doubt.
function processAlive(pid) {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (err) {
    return !(err instanceof Deno.errors.NotFound);
  }
}

// Chrome holds <user-data-dir>/SingletonLock (a "hostname-<pid>" symlink) for the life of the
// browser. Used for legacy (untagged) dirs where we cannot ask the owning deno process. A
// parseable lock whose pid is DEAD is a stale lock — exactly what a SIGKILLed Chrome leaves
// behind — and must NOT count as live.
function chromeHoldsLock(dir) {
  let target = null;
  try {
    target = Deno.readLinkSync(`${dir}/SingletonLock`);
  } catch {
    // absent, or not a symlink
  }
  if (target) {
    const m = /-(\d+)$/.exec(target);
    if (m) return processAlive(Number(m[1]));
    return true; // present but unparseable: assume live
  }
  try {
    Deno.lstatSync(`${dir}/SingletonLock`); // lock present but unreadable: assume live
    return true;
  } catch (err) {
    // Absent → not held. Any OTHER failure (e.g. EACCES) means we cannot tell — assume
    // live, matching the conservative contract above; never report "not held" on doubt.
    return err instanceof Deno.errors.NotFound ? false : true;
  }
}

// Reclaim profile dirs orphaned by crashed/killed runs. Runs at every launch(). Never throws.
//
// Safety against concurrent runs on the same VM (two lanes can hold browser gates at once):
//  - pid-tagged dirs (gendn-cdp-<pid>-*) are skipped whenever that pid is still alive — a live
//    run's dir can never be reclaimed, whoever owns it. Our own pid is only reclaimed when the
//    dir is not one this process is currently using (leftovers from an earlier recycle).
//  - legacy untagged dirs (pre-fix code) are only reclaimed when no live Chrome holds their
//    SingletonLock AND they are older than the spawn window, so a just-launched browser from
//    old code can never be swept mid-run.
const LEGACY_MIN_AGE_MS = 15 * 60 * 1000;

// Single source of truth for where Chrome profile dirs live. Measured on deno 2.9.7:
// TMPDIR unset → makeTempDir creates absolute /tmp/<name>; TMPDIR="" → it creates a BARE
// RELATIVE name in the process CWD (during a gate run that is the repo worktree — untracked
// dirt a merger could push, and the selector's untracked-residue trap); a trailing slash is
// normalised by Deno itself, but we strip it so the root stays canonical. Empty TMPDIR is
// conventionally "unset/use the default", and we own the makeTempDir dir argument — so we
// override Deno's cwd-relative quirk (unset AND empty both → /tmp) instead of propagating
// profile dirs into the repo tree. The same function resolves the root consistently for
// both call sites (the launch-time sweep and makeTempDir's dir), so creation and sweeping
// can never disagree whatever TMPDIR says — even if someone later sets TMPDIR mid-process —
// and the ps substring match (string-exact) always sees the same path Chrome was given.
// Exported for the committed root-resolution fixture.
export function tmpRoot() {
  const raw = Deno.env.get("TMPDIR");
  if (raw === undefined || raw === "") return "/tmp"; // unset and empty both mean the default
  const abs = raw.startsWith("/") ? raw : `${Deno.cwd()}/${raw}`;
  return abs.replace(/\/+$/, "") || "/";
}

async function sweepStaleProfileDirs() {
  const root = tmpRoot();
  let reclaimed = 0;
  const failed = [];
  try {
    for (const entry of Deno.readDirSync(root)) {
      if (!entry.isDirectory || !entry.name.startsWith(PROFILE_PREFIX)) continue;
      const path = root === "/" ? `/${entry.name}` : `${root}/${entry.name}`;
      const m = /^gendn-cdp-(\d+)-/.exec(entry.name);
      if (m) {
        const pid = Number(m[1]);
        // Known limitation (retention, by design): if a new process RECYCLES a dead run's
        // pid, processAlive() reports true while the recycled pid stays alive, so the stale
        // dir is retained until that pid next exits — it leaks disk (visible as /tmp residue)
        // but can never delete a live run's dir, which is the safe direction. Rare on a large
        // pid space; the next reboot clears /tmp.
        if (pid !== Deno.pid && processAlive(pid)) continue; // another live run owns it
        if (pid === Deno.pid && liveProfileDirs.has(path)) continue; // our current browser
      } else {
        if (chromeHoldsLock(path)) continue;
        const mtime = await Deno.stat(path).then((s) => s.mtime?.getTime()).catch(() => undefined);
        if (mtime === undefined || Date.now() - mtime < LEGACY_MIN_AGE_MS) continue;
      }
      try {
        // The owning deno process is gone, but its Chrome may live on (reparented orphan) and
        // would recreate profile files after our remove — kill anything still using the dir.
        await killProcessesUsingDir(path);
        await Deno.remove(path, { recursive: true });
        reclaimed++;
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) failed.push(`${path} (${err.message})`);
      }
    }
  } catch (err) {
    console.error(`[cdp] sweep: could not scan ${root} for stale profile dirs: ${err.message}`);
    return;
  }
  if (reclaimed > 0) {
    console.error(
      `[cdp] sweep: reclaimed ${reclaimed} stale Chrome profile dir(s) under ${root} ` +
        `(leftovers from crashed/killed runs)`,
    );
  }
  for (const f of failed) console.error(`[cdp] sweep: could not remove ${f}`);
}

// Remove a profile dir deterministically: kill everything still using it first (see
// pidsUsingDir), then remove with retry/backoff to win any residual race. A persistent failure
// is NOT swallowed: warn on stderr so it is visible in the gate log, and leave the dir for the
// next run's sweep (its pid will be gone by then).
async function removeProfileDir(path, delays = [0, 150, 400, 900, 1900]) {
  try {
    await killProcessesUsingDir(path);
  } catch (err) {
    // Never let cleanup bookkeeping break the gate itself — but say it loudly.
    console.error(
      `[cdp] WARNING: pre-remove kill failed for ${path} (${err.message}); ` +
        `removal may race lingering Chrome helpers`,
    );
  }
  let lastErr = null;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      await Deno.remove(path, { recursive: true });
      liveProfileDirs.delete(path);
      return true;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        liveProfileDirs.delete(path); // already gone (e.g. concurrent sweep) — fine
        return true;
      }
      lastErr = err;
    }
  }
  liveProfileDirs.delete(path);
  console.error(
    `[cdp] WARNING: could not remove Chrome profile dir ${path} ` +
      `(${lastErr?.name}: ${lastErr?.message}); it stays on disk and the next run's sweep ` +
      `will reclaim it`,
  );
  return false;
}

// NAVIGATION WHITELIST (gendn-8na). The gate Chrome runs with --no-sandbox (decision below), so the
// control that actually bounds the exposure is that it only ever navigates to LOCAL gendn routes.
// NOT a control: CSP frame-src. It limits which origins gendn may embed; it says nothing about what
// an embedded origin does, and it does not apply to top-level navigation at all.
// Other controls: the only third-party content is the operator's own showcase iframes, all
// loading="lazy" and below the fold, so a gate that never scrolls never loads them (if a gate starts
// scrolling, or an iframe moves above the fold, lazy stops being a control); tests evaluate only
// same-origin DOM.
export function isLocalNavigation(url) {
  if (url === "about:blank") return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

// POSTURE DECISION (gendn-8na): keep --no-sandbox. Chrome does start with its sandbox on this VM
// (verified as uid 1000), but the gates also run in CI/containers where unprivileged user
// namespaces are commonly unavailable and the sandboxed launch fails outright. Enabling it by
// default would trade a hard gate failure for marginal protection given the whitelist above.
export async function launch({ port = 9333 } = {}) {
  const bins = findChrome();
  await sweepStaleProfileDirs();
  const userDataDir = await Deno.makeTempDir({
    dir: tmpRoot(),
    prefix: `${PROFILE_PREFIX}${Deno.pid}-`,
  });
  liveProfileDirs.add(userDataDir);
  let child = null;
  let lastErr = null;
  for (const bin of bins) {
    try {
      const cmd = new Deno.Command(bin, {
        args: [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--hide-scrollbars",
          "--no-first-run",
          "--disable-extensions",
          "--disable-background-networking",
          `--user-data-dir=${userDataDir}`,
          `--remote-debugging-port=${port}`,
          "about:blank",
        ],
        stdout: "null",
        stderr: "null",
      });
      child = cmd.spawn();
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!child) {
    await removeProfileDir(userDataDir);
    throw new Error(`could not launch Chrome (tried ${bins.join(", ")}): ${lastErr}`);
  }

  // Wait for the debugging endpoint.
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        wsUrl = (await res.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!wsUrl) {
    await terminateChild(child);
    await removeProfileDir(userDataDir);
    throw new Error("Chrome DevTools endpoint did not come up");
  }
  return new Browser(child, wsUrl, userDataDir, port);
}

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = id && sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
}

export class Browser {
  constructor(child, wsUrl, userDataDir, port) {
    this.child = child;
    this.wsUrl = wsUrl;
    this.userDataDir = userDataDir;
    this.port = port;
    this.ws = null;
    this.conn = null;
  }
  async connect() {
    if (this.conn) return;
    const ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? e}`));
    });
    this.ws = ws;
    this.conn = new Conn(ws);
  }
  async newPage({ width = 1280, height = 800, mobile = false, deviceScaleFactor = 1 } = {}) {
    await this.connect();
    const { targetId } = await this.conn.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.conn.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const page = new Page(this.conn, sessionId, targetId);
    await page.init({ width, height, mobile, deviceScaleFactor });
    return page;
  }
  async close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    await terminateChild(this.child);
    await removeProfileDir(this.userDataDir);
  }
}

class Page {
  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.consoleErrors = [];
    this.failedRequests = [];
    this._reqUrls = new Map();
    this._loadWaiters = [];
  }
  cmd(method, params) {
    return this.sendSession(method, params);
  }
  sendSession(method, params = {}) {
    // send with sessionId (flat protocol)
    const id = this.conn.nextId++;
    return new Promise((resolve, reject) => {
      this.conn.pending.set(id, { resolve, reject });
      this.conn.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    });
  }
  async init({ width, height, mobile, deviceScaleFactor }) {
    this.conn.on((msg) => {
      if (msg.sessionId !== this.sessionId) return;
      if (msg.method === "Runtime.consoleAPICalled") {
        if (msg.params.type === "error") {
          this.consoleErrors.push(
            (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "),
          );
        }
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        this.consoleErrors.push(d?.exception?.description ?? d?.text ?? "exception");
      } else if (msg.method === "Network.requestWillBeSent") {
        this._reqUrls.set(msg.params.requestId, msg.params.request?.url ?? "");
      } else if (msg.method === "Network.loadingFailed") {
        // Ignore intentional aborts (e.g. lazy iframes not fetched); record real failures.
        if (!msg.params.canceled) {
          const url = this._reqUrls.get(msg.params.requestId) ?? "";
          this.failedRequests.push({ url, error: `${msg.params.type}: ${msg.params.errorText}` });
        }
      } else if (msg.method === "Network.responseReceived") {
        const s = msg.params.response?.status ?? 0;
        if (s >= 400) {
          this.failedRequests.push({ url: msg.params.response.url, error: `HTTP ${s}` });
        }
      } else if (msg.method === "Page.loadEventFired") {
        for (const w of this._loadWaiters) w();
        this._loadWaiters = [];
      }
    });
    await this.sendSession("Page.enable");
    await this.sendSession("Runtime.enable");
    await this.sendSession("Network.enable");
    await this.sendSession("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
  }
  async goto(url, { timeout = 20000 } = {}) {
    this.consoleErrors = [];
    this.failedRequests = [];
    this._reqUrls = new Map();
    if (!isLocalNavigation(url)) {
      throw new Error(`gate browser refused non-local navigation: ${url}`);
    }
    const loaded = new Promise((resolve) => this._loadWaiters.push(resolve));
    await this.sendSession("Page.navigate", { url });
    await Promise.race([
      loaded,
      new Promise((r) => setTimeout(r, timeout)),
    ]);
    // Give lazily-scheduled work a brief, fixed settle window (deterministic).
    await new Promise((r) => setTimeout(r, 400));
  }
  async evaluate(expr) {
    const res = await this.sendSession("Runtime.evaluate", {
      expression:
        `(function(){ try { return (${expr}); } catch(e){ return "__THREW__:"+e.message; } })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }
  async screenshot(path) {
    const { data } = await this.sendSession("Page.captureScreenshot", { format: "png" });
    await Deno.writeFile(path, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  }
  diagnostics() {
    return { consoleErrors: this.consoleErrors, failedRequests: this.failedRequests };
  }
  async close() {
    try {
      await this.conn.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      // ignore
    }
  }
}
