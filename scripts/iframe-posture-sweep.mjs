// scripts/iframe-posture-sweep.mjs — gendn-kjq acceptance sweep (MANUAL verification tool).
//
// Deliberately NOT registered as a deno.json test-* task: it drives the SERVED build in headless
// Chrome against the LIVE showcase origin over the network, so it is acceptance evidence for the
// posture change, not a deterministic fixture (a showcase outage must not red the aggregate).
// The deterministic guard is scripts/iframe-posture.test.mjs.
//
// For EVERY published page that embeds an iframe this proves, on the served build:
//   1. the raw served HTML carries sandbox + referrerpolicy (acceptance: served build, not source);
//   2. the framed showcase demo still WORKS under the sandbox: its OOPIF target exists, the frame
//      document is complete, has real content and interactive elements, and threw no uncaught
//      exceptions (a demo blanked by too-tight a sandbox is a regression, not hardening);
//   3. three sample pages are screenshotted for the record.
//
// One headless Chrome, OS-assigned ports, everything torn down in finally.
// Run: deno run --allow-read --allow-net --allow-run --allow-env --allow-write scripts/iframe-posture-sweep.mjs

import { launch } from "./lib/cdp.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const SHOWCASE = "https://chrome-platform-showcase.paulkinlan-ea.deno.net";
const OUT = "/tmp/kjq-sweep";

let failures = 0;
let passed = 0;
function assert(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS: ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function freePort() {
  const l = Deno.listen({ port: 0 });
  const { port } = l.addr;
  l.close();
  return port;
}

// --- discover the pages that embed iframes (same tree walk as the guard fixture) -------
async function* walkHtml(dir, prefix) {
  for await (const e of Deno.readDir(dir)) {
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory) yield* walkHtml(`${dir}/${e.name}`, rel);
    else if (e.name.endsWith(".html")) yield rel;
  }
}
const pages = [];
for await (const e of Deno.readDir(REPO)) {
  if (e.isDirectory && /^v\d+$/.test(e.name)) {
    for await (const rel of walkHtml(`${REPO}${e.name}`, e.name)) pages.push(rel);
  }
}
const embeds = []; // { route, src }
for (const rel of pages) {
  const text = await Deno.readTextFile(`${REPO}${rel}`);
  for (const m of text.matchAll(/<iframe\b[^>]*>/gs)) {
    const src = /src="([^"]+)"/.exec(m[0])?.[1];
    if (src) embeds.push({ route: `/${rel.replace(/index\.html$/, "")}`, src });
  }
}
console.log(`sweep: ${embeds.length} embed page(s) discovered`);

const serverPort = freePort();
const cdpPort = freePort();
const server = new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-net", "--allow-read", "--allow-env", "server.ts"],
  env: { ...Deno.env.toObject(), PORT: String(serverPort) },
  cwd: REPO,
  stdout: "null",
  stderr: "null",
}).spawn();
const base = `http://localhost:${serverPort}`;

let browser = null;
const frameErrors = new Map(); // sessionId -> string[]
try {
  // readiness poll of the server THIS script spawned (loopback, bounded by the attempt count)
  let up = false;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        up = true;
        await r.body?.cancel();
        break;
      }
      await r.body?.cancel();
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error("gendn server did not come up");

  browser = await launch({ port: cdpPort });
  await browser.connect();
  // Global listener: collect uncaught exceptions/console errors per CDP session (incl. OOPIFs).
  browser.conn.on((msg) => {
    if (!msg.sessionId) return;
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      const list = frameErrors.get(msg.sessionId) ?? [];
      list.push(`exception: ${d.exception?.description ?? d.text}`);
      frameErrors.set(msg.sessionId, list);
    } else if (
      msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error"
    ) {
      const list = frameErrors.get(msg.sessionId) ?? [];
      list.push(
        `console: ${(msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`,
      );
      frameErrors.set(msg.sessionId, list);
    }
  });

  const page = await browser.newPage({ width: 1280, height: 900 });
  const samples = new Set([
    embeds[0]?.route,
    embeds[Math.floor(embeds.length / 2)]?.route,
    embeds[embeds.length - 1]?.route,
  ]);
  await Deno.mkdir(OUT, { recursive: true });

  for (const { route, src } of embeds) {
    const label = route.replace(/\/$/, "");
    // 1. raw SERVED html carries the posture (acceptance: served build, not source)
    const raw = await (await fetch(`${base}${route}`, { signal: AbortSignal.timeout(10000) }))
      .text();
    const servedOk = /<iframe\b[^>]*sandbox="allow-scripts allow-same-origin"[^>]*>/s.test(raw) &&
      /<iframe\b[^>]*referrerpolicy="strict-origin-when-cross-origin"[^>]*>/s.test(raw);
    assert(`served HTML carries sandbox+referrerpolicy: ${label}`, servedOk);

    // 2. drive the page: the framed demo must still work under the sandbox
    await page.goto(`${base}${route}`, { timeout: 25000 });
    await page.evaluate(
      `(() => { const f = document.querySelector('iframe'); if (f) f.scrollIntoView({block:'center'}); return !!f; })()`,
    );
    const attrs = await page.evaluate(
      `(() => { const f = document.querySelector('iframe'); return f ? { sandbox: f.getAttribute('sandbox'), rp: f.getAttribute('referrerpolicy') } : null; })()`,
    );
    assert(
      `served DOM iframe attributes: ${label}`,
      attrs?.sandbox === "allow-scripts allow-same-origin" &&
        attrs?.rp === "strict-origin-when-cross-origin",
      JSON.stringify(attrs),
    );

    // find the OOPIF target for the showcase src (poll: lazy-loaded frame may take a moment)
    let frame = null;
    for (let i = 0; i < 40 && !frame; i++) {
      const { targetInfos } = await browser.conn.send("Target.getTargets");
      frame = targetInfos.find(
        (t) => t.type === "iframe" && t.url.startsWith(SHOWCASE) && t.url === src,
      ) ?? null;
      if (!frame) await new Promise((r) => setTimeout(r, 500));
    }
    if (!frame) {
      assert(`framed demo loads under sandbox: ${label}`, false, `no OOPIF target for ${src}`);
      continue;
    }
    const { sessionId } = await browser.conn.send("Target.attachToTarget", {
      targetId: frame.targetId,
      flatten: true,
    });
    await browser.conn.send("Runtime.enable", {}, sessionId);
    await new Promise((r) => setTimeout(r, 3500)); // let the demo boot and settle
    const evalIn = async (expr) => {
      const res = await browser.conn.send(
        "Runtime.evaluate",
        {
          expression:
            `(function(){ try { return (${expr}); } catch(e){ return "__THREW__:"+e.message; } })()`,
          returnByValue: true,
        },
        sessionId,
      );
      return res.result?.value;
    };
    const state = await evalIn(
      `{ ready: document.readyState, kids: document.body ? document.body.childElementCount : -1, textLen: (document.body?.innerText || '').length, interactive: document.querySelectorAll('button,input,select,textarea,canvas,a,[onclick]').length }`,
    );
    const errs = frameErrors.get(sessionId) ?? [];
    assert(
      `framed demo WORKS under sandbox (loaded, non-blank, interactive, no uncaught errors): ${label}`,
      state?.ready === "complete" && state.kids > 0 && state.textLen > 20 &&
        state.interactive > 0 && errs.length === 0,
      `${JSON.stringify(state)}; errors=${errs.length}${
        errs.length ? ": " + errs.slice(0, 2).join(" | ").slice(0, 220) : ""
      }`,
    );

    if (samples.has(route)) {
      const file = `${OUT}/${label.replaceAll("/", "_")}.png`;
      await page.screenshot(file);
      console.log(`screenshot: ${file}`);
    }
    await browser.conn.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
  await page.close();
} finally {
  try {
    await browser?.close();
  } catch {
    // ignore
  }
  try {
    server.kill("SIGTERM");
  } catch {
    // ignore
  }
}

if (failures > 0) {
  console.error(`iframe-posture sweep: ${failures} assertion(s) FAILED (${passed} passed)`);
  Deno.exit(1);
}
console.log(
  `iframe-posture sweep: all ${passed} assertions passed across ${embeds.length} embed page(s)`,
);
