// scripts/fetch-bounded.test.mjs — fixtures for the bounded upstream fetch (gendn-snd).
//
// Proves the two guards are real rather than paper, against a LOCAL server (no network):
//   - a healthy response still passes
//   - a SLOW-but-working response still passes inside the timeout (too short a timeout turns a
//     slow upstream into an outage, which is worse than the exposure)
//   - a HUNG connection fails fast and bounded (AbortSignal.timeout)
//   - a MID-BODY hang (headers arrive, some body arrives, then silence) is bounded too — that is
//     the phase a streaming cap exists to protect, and A TRUNCATED BODY IS NEVER RETURNED
//   - a large partial body followed by silence trips the byte cap DURING the stall, i.e. before
//     the timeout would
//   - an OVERSIZED response is refused twice over: declared content-length, and streamed bytes
//     that lie about / omit content-length
//   - a non-ok status is returned to the caller (fetchBounded does not throw on status; the
//     caller decides, and server.ts's error handling is the single place that shapes responses)
//   - a 3xx redirect destination is bounded against an explicit allowlist (gendn-lkj), and
//     that bound is enforced BEFORE the hop: an off-allowlist destination receives ZERO
//     requests (gendn-lr61 - the destination hit counter is the discriminating assertion)
//
// Run: deno task test-fetch-bounded  (or: deno run scripts/fetch-bounded.test.mjs)

import { ALLOWED_ORIGINS, fetchBounded, readCapped } from "../lib/chromestatus.ts";

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

const BIG = 12 * 1024 * 1024;

// Each stalling endpoint parks a request on purpose; keep EVERY cleanup so the test can release
// them all before shutdown (Deno's server.shutdown() waits for in-flight requests). This is an
// ARRAY, not a single slot: a scalar would be overwritten by each endpoint and only the last
// teardown would run, which is a latent hung suite — Deno happens to survive today only because
// the client abort severs the connection.
const hangCleanups = [];
function onRelease(fn) {
  hangCleanups.push(fn);
}

const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/ok") {
    return new Response(JSON.stringify({ ok: true, n: 42 }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (path === "/slow") {
    return new Promise((resolve) => {
      setTimeout(() => resolve(new Response("slow but fine")), 400);
    });
  }
  if (path === "/midhang") {
    // Headers arrive immediately, then a partial body, then silence: the mid-body phase.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("PARTIAL-BODY"));
        onRelease(() => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });
    return new Response(stream, { headers: { "content-type": "text/plain" } });
  }
  if (path === "/midhang-big") {
    // 2 MiB immediately, then silence: the byte tally must fire during the stall, not at the
    // timeout.
    const big = new Uint8Array(2 * 1024 * 1024);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(big);
        onRelease(() => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });
    return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
  }
  if (path === "/hang") {
    // Never respond on its own; the client must give up on its own bound. The resolver is kept
    // so shutdown() can complete.
    return new Promise((resolve) => {
      onRelease(() => resolve(new Response("released")));
    });
  }
  if (path === "/big") {
    // Declared size above the cap (content-length path).
    return new Response(new Uint8Array(BIG), { headers: { "content-length": String(BIG) } });
  }
  if (path === "/redirect-other-origin") {
    return new Response(null, {
      status: 302,
      headers: { location: `${destBase}/dest` },
    });
  }
  if (path === "/redirect-no-location") {
    // gendn-lr61 review coverage: a redirect status with no Location header must throw,
    // not fall through to the caller as a 3xx.
    return new Response(null, { status: 302 });
  }
  if (path === "/redirect-loop") {
    // gendn-lr61 review coverage: a redirect chain that never terminates must hit the hop
    // cap, not loop forever.
    return new Response(null, {
      status: 302,
      headers: { location: `${base}/redirect-loop` },
    });
  }
  if (path === "/liar") {
    // Streaming body that lies about its size (no content-length, chunked), so only the
    // streaming cap can stop it.
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (sent >= BIG) {
            controller.close();
            return;
          }
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );
  }
  return new Response("nope", { status: 404 });
});
// Stand-in for an off-allowlist destination origin (distinct port on loopback).
// gendn-lr61: the destination server counts every request it receives. The
// off-allowlist assertion below is discriminated by this counter staying at ZERO - a
// thrown error alone does not prove the destination was never contacted (the old
// guard threw AFTER following the redirect, having already reached it).
let destHits = 0;
const destServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/dest") {
    destHits++;
    return new Response("off-allowlist destination reached", {
      headers: { "content-type": "text/plain" },
    });
  }
  if (path === "/redirect-relative") {
    // gendn-lr61 review coverage: a RELATIVE Location must resolve against the current URL.
    return new Response(null, { status: 302, headers: { location: "dest" } });
  }
  if (path === "/redirect-head") {
    // gendn-lr61 review coverage: HEAD must stay HEAD through a hop.
    return new Response(null, { status: 302, headers: { location: `${destBase}/dest` } });
  }
  return new Response("nope", { status: 404 });
});
const destBase = `http://127.0.0.1:${destServer.addr.port}`;
const destOrigin = new URL(destBase).origin;

const base = `http://127.0.0.1:${server.addr.port}`;

const timed = async (label, fn) => {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { label, ok: true, value, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { label, ok: false, err, ms: Math.round(performance.now() - t0) };
  }
};

try {
  // 1. healthy response passes and parses
  const ok = await timed("ok", async () => {
    const { res, text } = await fetchBounded(`${base}/ok`, { timeoutMs: 5000 });
    return { status: res.status, body: JSON.parse(text) };
  });
  assert(
    "healthy response passes",
    ok.ok && ok.value.body.n === 42,
    JSON.stringify(ok.value ?? ok.err),
  );

  // 2. slow-but-working passes inside a generous timeout (the deliberate-timeout property)
  const slow = await timed(
    "slow",
    () => fetchBounded(`${base}/slow`, { timeoutMs: 5000 }).then((r) => r.text),
  );
  assert(
    "slow-but-working response still passes (timeout is not policing latency)",
    slow.ok && slow.value === "slow but fine",
    `${slow.ms}ms`,
  );

  // 3. hung connection fails FAST and bounded
  const hang = await timed("hang", () => fetchBounded(`${base}/hang`, { timeoutMs: 300 }));
  assert(
    "hung upstream is bounded by AbortSignal.timeout",
    !hang.ok && hang.ms < 2000,
    `rejected after ${hang.ms}ms (bound 300ms); ${hang.err?.name ?? hang.err}`,
  );

  // 4. oversized declared body is refused without reading it all
  const big = await timed(
    "big",
    () => fetchBounded(`${base}/big`, { timeoutMs: 5000, maxBytes: 1024 * 1024 }),
  );
  assert(
    "oversized response refused via declared content-length",
    !big.ok && /too large/.test(String(big.err?.message)),
    `${big.ms}ms; ${big.err?.message}`,
  );

  // 5. streaming body that lies about / omits size is refused by the byte cap
  const liar = await timed(
    "liar",
    () => fetchBounded(`${base}/liar`, { timeoutMs: 5000, maxBytes: 1024 * 1024 }),
  );
  assert(
    "oversized streamed response refused by the byte cap",
    !liar.ok && /exceeded the .*cap/.test(String(liar.err?.message)),
    `${liar.ms}ms; ${liar.err?.message}`,
  );

  // 5b. MID-BODY hang: headers + partial body + silence must be bounded, and no truncated body
  // may escape as a successful return.
  const midhang = await timed("midhang", () => fetchBounded(`${base}/midhang`, { timeoutMs: 300 }));
  assert(
    "mid-body hang is bounded by the same timeout (headers alone do not settle it)",
    !midhang.ok && midhang.ms < 2000 && /timeout/i.test(String(midhang.err?.name)),
    `rejected after ${midhang.ms}ms (bound 300ms); ${midhang.err?.name}: ${midhang.err?.message}`,
  );
  assert(
    "mid-body hang never returns a TRUNCATED body",
    !midhang.ok && midhang.value === undefined,
    `value=${JSON.stringify(midhang.value)}`,
  );

  // 5c. a large partial body followed by silence trips the cap DURING the stall — proof the
  // tally is incremental rather than a post-read length check.
  const midbig = await timed(
    "midhang-big",
    () => fetchBounded(`${base}/midhang-big`, { timeoutMs: 5000, maxBytes: 1024 * 1024 }),
  );
  assert(
    "large partial body then stall trips the byte cap before the timeout",
    !midbig.ok && /exceeded the .*cap/.test(String(midbig.err?.message)) && midbig.ms < 1000,
    `rejected after ${midbig.ms}ms (timeout was 5000ms); ${midbig.err?.message}`,
  );

  // 5d. The cleanup registry itself: all three stalling endpoints must have registered their own
  // teardown. A scalar slot would leave this at 1, which is the latent hung-suite hazard.
  assert(
    "each stalling endpoint registered its own cleanup (no overwritten slot)",
    hangCleanups.length === 3,
    `registered ${hangCleanups.length} of 3`,
  );

  // 6. a non-ok status is RETURNED, not thrown — the caller shapes the response
  const nf = await timed("404", () => fetchBounded(`${base}/missing`, { timeoutMs: 5000 }));
  assert(
    "non-ok status is returned to the caller (not thrown)",
    nf.ok && nf.value.res.status === 404 && nf.value.text === "nope",
    `status=${nf.value?.res?.status}`,
  );

  // 7. readCapped works standalone too (server.ts uses fetchBounded; this pins the primitive)
  const direct = await timed("readCapped", () => readCapped(new Response("abc"), 1024));
  assert("readCapped returns the body under the cap", direct.ok && direct.value === "abc");

  // 8. redirect destination is bounded: following a 3xx to an off-allowlist origin is refused
  // (gendn-lkj; THREAT_MODEL.md invariant #7).
  const redir = await timed(
    "redirect-off-allowlist",
    () => fetchBounded(`${base}/redirect-other-origin`, { timeoutMs: 5000 }),
  );
  assert(
    "redirect to off-allowlist origin is refused",
    !redir.ok && /fetchBounded: redirected off-allowlist to/.test(String(redir.err?.message)),
    `rejected: ${redir.err?.message}`,
  );
  assert(
    "gendn-lr61: the off-allowlist destination received ZERO requests (validated before the hop, not after)",
    destHits === 0,
    `destHits: ${destHits}`,
  );
  const noLoc = await timed(
    "redirect-no-location",
    () => fetchBounded(`${base}/redirect-no-location`, { timeoutMs: 5000 }),
  );
  assert(
    "gendn-lr61: a redirect status without a Location header throws",
    !noLoc.ok && /without a Location header/.test(String(noLoc.err?.message)),
    `rejected: ${noLoc.err?.message}`,
  );
  const loop = await timed(
    "redirect-loop",
    () => fetchBounded(`${base}/redirect-loop`, { timeoutMs: 5000 }),
  );
  assert(
    "gendn-lr61: a self-redirecting chain hits the hop cap",
    !loop.ok && /exceeded 5 redirect hops/.test(String(loop.err?.message)),
    `rejected: ${loop.err?.message}`,
  );

  // 8b. positive path: when the destination origin is in ALLOWED_ORIGINS, following succeeds
  ALLOWED_ORIGINS.add(destOrigin);
  try {
    const allowedRedir = await timed(
      "redirect-allowlist-positive",
      () => fetchBounded(`${base}/redirect-other-origin`, { timeoutMs: 5000 }),
    );
    assert(
      "redirect to allowlisted origin succeeds and returns body",
      allowedRedir.ok && allowedRedir.value?.text === "off-allowlist destination reached",
      `status=${allowedRedir.value?.res?.status}`,
    );
    assert(
      "gendn-lr61: an allowlisted redirect IS followed (the destination was reached exactly once)",
      destHits === 1,
      `destHits: ${destHits}`,
    );
    const before = destHits;
    const rel = await timed(
      "redirect-relative",
      () => fetchBounded(`${destBase}/redirect-relative`, { timeoutMs: 5000 }),
    );
    assert(
      "gendn-lr61: a RELATIVE Location resolves against the current URL and is followed",
      rel.ok && rel.value?.text === "off-allowlist destination reached",
      `text=${rel.value?.text ?? rel.err?.message}`,
    );
    const head = await timed(
      "redirect-head",
      () => fetchBounded(`${destBase}/redirect-head`, { timeoutMs: 5000, method: "HEAD" }),
    );
    assert(
      "gendn-lr61: HEAD stays HEAD through a hop (final status 200, empty body - not a 404 fallback)",
      head.ok && head.value?.res?.status === 200,
      `status=${head.value?.res?.status ?? head.err?.message}`,
    );
    assert(
      "gendn-lr61 review: positive-path hops reached the destination exactly twice more",
      destHits === before + 2,
      `destHits delta: ${destHits - before}`,
    );
  } finally {
    ALLOWED_ORIGINS.delete(destOrigin);
  }

  // 8c. ALLOWED_ORIGINS contains all canonical caller origins across the repo
  assert(
    "ALLOWED_ORIGINS includes the vendor-fonts caller origin https://fonts.googleapis.com",
    ALLOWED_ORIGINS.has("https://fonts.googleapis.com"),
  );
  assert(
    "ALLOWED_ORIGINS contains exactly chromestatus, github, mdn, and google fonts",
    ALLOWED_ORIGINS.has("https://chromestatus.com") &&
      ALLOWED_ORIGINS.has("https://api.github.com") &&
      ALLOWED_ORIGINS.has("https://developer.mozilla.org") &&
      ALLOWED_ORIGINS.has("https://fonts.googleapis.com") &&
      ALLOWED_ORIGINS.size === 4,
    `size=${ALLOWED_ORIGINS.size}`,
  );

  // 8d. a redirect to each allowlisted origin (including fonts.googleapis.com) is allowed (passes),
  // while an off-allowlist redirect still throws.
  const origFetch = globalThis.fetch;
  try {
    for (const origin of ALLOWED_ORIGINS) {
      globalThis.fetch = async () => {
        const resp = new Response(`content from ${origin}`, { status: 200 });
        Object.defineProperty(resp, "redirected", { value: true });
        Object.defineProperty(resp, "url", { value: `${origin}/endpoint` });
        return resp;
      };
      const allowed = await timed(
        `redirect-to-${origin}`,
        () => fetchBounded("http://127.0.0.1:0/mock-redirect", { timeoutMs: 1000 }),
      );
      assert(
        `redirect to allowlisted origin ${origin} is allowed (passes)`,
        allowed.ok && allowed.value?.text === `content from ${origin}`,
        `${allowed.err?.message}`,
      );
    }

    globalThis.fetch = async () => {
      const resp = new Response("evil", { status: 200 });
      Object.defineProperty(resp, "redirected", { value: true });
      Object.defineProperty(resp, "url", { value: "https://evil.example.com/exploit" });
      return resp;
    };
    const offMock = await timed(
      "redirect-mock-off-allowlist",
      () => fetchBounded("http://127.0.0.1:0/mock-redirect", { timeoutMs: 1000 }),
    );
    assert(
      "redirect to off-allowlist origin throws (simulated)",
      !offMock.ok &&
        /fetchBounded: redirected off-allowlist to https:\/\/evil\.example\.com/.test(
          String(offMock.err?.message),
        ),
      `rejected: ${offMock.err?.message}`,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
} finally {
  // Drain every cleanup, each wrapped so one failure cannot skip the rest.
  for (const cleanup of hangCleanups) {
    try {
      cleanup();
    } catch {
      // ignore
    }
  }
  try {
    await server.shutdown();
  } catch {
    // ignore
  }
  try {
    await destServer.shutdown();
  } catch {
    // ignore
  }
}

if (failures > 0) {
  console.error(`fetch-bounded.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`fetch-bounded fixture: all ${passed} assertions passed`);
