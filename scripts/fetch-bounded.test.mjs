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
//
// Run: deno task test-fetch-bounded  (or: deno run scripts/fetch-bounded.test.mjs)

import { fetchBounded, readCapped } from "../lib/chromestatus.ts";

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

// The /hang handler parks a request forever on purpose; keep its resolver so the test can
// release it before shutdown (Deno's server.shutdown() waits for in-flight requests).
let releaseHang = null;

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
        releaseHang = () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
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
        releaseHang = () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
      },
    });
    return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
  }
  if (path === "/hang") {
    // Never respond on its own; the client must give up on its own bound. The resolver is kept
    // so shutdown() can complete.
    return new Promise((resolve) => {
      releaseHang = () => resolve(new Response("released"));
    });
  }
  if (path === "/big") {
    // Declared size above the cap (content-length path).
    return new Response(new Uint8Array(BIG), { headers: { "content-length": String(BIG) } });
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
} finally {
  try {
    releaseHang?.();
    await server.shutdown();
  } catch {
    // ignore
  }
}

if (failures > 0) {
  console.error(`fetch-bounded.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`fetch-bounded fixture: all ${passed} assertions passed`);
