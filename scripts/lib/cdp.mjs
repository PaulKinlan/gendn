// cdp.mjs — a small, dependency-free Chrome DevTools Protocol client for the conformance runner.
//
// The routine environment has `google-chrome-stable --headless=new` but no chrome-devtools-mcp, so
// the runner drives headless Chrome over the DevTools WebSocket directly. This is deterministic:
// fixed viewports, load-event waits, no random timing baked into results.
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

export async function launch({ port = 9333 } = {}) {
  const bins = findChrome();
  const userDataDir = await Deno.makeTempDir({ prefix: "gendn-cdp-" });
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
  if (!child) throw new Error(`could not launch Chrome (tried ${bins.join(", ")}): ${lastErr}`);

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
    try {
      child.kill();
    } catch {
      // ignore
    }
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
    try {
      this.child.kill();
    } catch {
      // ignore
    }
    try {
      await this.child.status;
    } catch {
      // ignore
    }
    try {
      await Deno.remove(this.userDataDir, { recursive: true });
    } catch {
      // ignore
    }
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
