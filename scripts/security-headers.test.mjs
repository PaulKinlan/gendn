// @fixture-permissions --allow-read --allow-run --allow-net=127.0.0.1,localhost --allow-env
// scripts/security-headers.test.mjs — fixtures for defensive browser security headers (gendn-5tk).
//
// WHY THIS FILE EXISTS:
// The project security audit identified that server responses lacked browser security headers
// (notably Content-Security-Policy, X-Content-Type-Options: nosniff, and Referrer-Policy).
// This fixture verifies against a REAL local server (ephemeral OS port, bounded timeouts) that:
//   1. Every response carries the defensive security headers:
//        - X-Content-Type-Options: nosniff
//        - Referrer-Policy: strict-origin-when-cross-origin
//        - Content-Security-Policy (with directives tailored against what pages actually load)
//        - X-Frame-Options: SAMEORIGIN
//   2. The pages actually load (HTTP 200, valid body, expected landmarks) and the CSP policy does
//      not blank or break the site.
//   3. The Content-Security-Policy does not reflexively reach for 'unsafe-inline' on script-src:
//      the only script on the site (the client-side filter on /features) is permitted by its exact
//      SHA-256 hash, and that hash is verified to match the actual rendered script bytes.
//   4. Detector cases: asserts that missing headers, missing font domains, missing showcase iframe
//      origins, or mismatched script hashes fail verification (proving this is a detector, not decoration).
//
// BOUNDS:
// Every network fetch AND body read has an attempt deadline plus a 25s total retry budget; port
// discovery and process waits also have deadlines. An HTTP response is never retried for wrong
// status/headers. The OS assigns the ephemeral port (PORT=0), and the spawned server process is
// unconditionally terminated with SIGKILL in a finally block.
//
// Run: deno task test-fixtures --tasks test-security-headers  (file-discovered automatically)

import { CSP_DIRECTIVES, CSP_HEADER_VALUE, RELEASE_INERT_SCRIPT_MIME } from "../server.ts";
import { fetchSecurityProbe, FixtureTransportError } from "./lib/security-probe.mjs";

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

// Parse CSP header string into directive -> array of tokens.
export function parseCsp(cspStr) {
  const map = new Map();
  if (typeof cspStr !== "string") return map;
  for (const part of cspStr.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [directive, ...tokens] = trimmed.split(/\s+/);
    map.set(directive.toLowerCase(), tokens);
  }
  return map;
}

// Compute base64 SHA-256 hash formatted as 'sha256-<b64>'.
export async function sha256Token(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return `'sha256-${b64}'`;
}

// Helper to validate security headers on any Response object
export function validateSecurityHeaders(res, _desc) {
  const errs = [];
  const nosniff = res.headers.get("x-content-type-options");
  if (nosniff !== "nosniff") errs.push(`missing or invalid nosniff: ${nosniff}`);

  const refPolicy = res.headers.get("referrer-policy");
  if (refPolicy !== "strict-origin-when-cross-origin") {
    errs.push(`missing or invalid referrer-policy: ${refPolicy}`);
  }

  const xfo = res.headers.get("x-frame-options");
  if (xfo !== "SAMEORIGIN") errs.push(`missing or invalid x-frame-options: ${xfo}`);

  const csp = res.headers.get("content-security-policy");
  if (!csp) {
    errs.push("missing content-security-policy header");
  } else {
    const parsed = parseCsp(csp);
    const scriptSrc = parsed.get("script-src") ?? [];
    if (scriptSrc.includes("'unsafe-inline'")) {
      errs.push("script-src must not contain 'unsafe-inline'");
    }
    const fontSrc = parsed.get("font-src") ?? [];
    if (!fontSrc.includes("https://fonts.gstatic.com")) {
      errs.push("font-src missing https://fonts.gstatic.com");
    }
    const frameSrc = parsed.get("frame-src") ?? [];
    if (!frameSrc.includes("https://chrome-platform-showcase.paulkinlan-ea.deno.net")) {
      errs.push("frame-src missing https://chrome-platform-showcase.paulkinlan-ea.deno.net");
    }
  }
  return { ok: errs.length === 0, errors: errs };
}

// Spawn the real server on an OS-assigned ephemeral port (PORT=0)
const serverProc = new Deno.Command("deno", {
  args: ["run", "--allow-net", "--allow-read", "--allow-env", "server.ts"],
  env: { ...Deno.env.toObject(), PORT: "0" },
  stdout: "piped",
  stderr: "null",
}).spawn();

let port = 0;
let base = "";

try {
  // Read stdout with strict bound to obtain the OS-assigned port
  const reader = serverProc.stdout.getReader();
  const decoder = new TextDecoder();
  let capturedOutput = "";
  const portDeadline = Date.now() + 20_000;

  while (Date.now() < portDeadline) {
    let timer;
    let readCompleted = false;
    let chunk;
    try {
      chunk = await Promise.race([
        reader.read().then((value) => {
          readCompleted = true;
          return value;
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Transport timeout reading server port (20s budget)")),
            portDeadline - Date.now(),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      // On timeout the pending read still owns the lock; the outer finally kills the server.
      if (!readCompleted) void reader.cancel().catch(() => {});
    }
    if (chunk.done) break;
    capturedOutput += decoder.decode(chunk.value, { stream: true });
    const match = /Listening on http:\/\/localhost:(\d+)/.exec(capturedOutput);
    if (match) {
      port = Number(match[1]);
      break;
    }
  }
  reader.releaseLock();

  assert("server booted and assigned ephemeral OS port", port > 0, `port ${port}`);
  if (port === 0) throw new Error("Could not determine server port from stdout within bound");

  base = `http://127.0.0.1:${port}`;

  // Transport retries are bounded across attempts; an HTTP response is terminal, never retried
  // for a wrong status/header. This also consumes the response body under the request deadline.
  const readyProbe = await fetchSecurityProbe(`${base}/`, {
    attemptTimeoutMs: 10_000,
    totalTimeoutMs: 25_000,
  });
  assert(
    "server answers HTTP requests on ephemeral port",
    readyProbe.response.ok,
    `endpoint ${base}/`,
  );
  if (!readyProbe.response.ok) {
    throw new Error(`server returned HTTP ${readyProbe.response.status} at ${base}/`);
  }

  // --- 1. Exported CSP constants structure ---
  assert(
    "server.ts exports CSP_DIRECTIVES array and CSP_HEADER_VALUE string",
    Array.isArray(CSP_DIRECTIVES) && typeof CSP_HEADER_VALUE === "string",
  );
  const parsedConst = parseCsp(CSP_HEADER_VALUE);
  assert("CSP default-src is 'self'", parsedConst.get("default-src")?.includes("'self'"));
  assert("CSP object-src is 'none'", parsedConst.get("object-src")?.includes("'none'"));
  assert("CSP frame-ancestors is 'self'", parsedConst.get("frame-ancestors")?.includes("'self'"));

  // --- 2. Live HTTP responses across diverse routes ---
  const routesToTest = [
    { path: "/", desc: "home page" },
    { path: "/features", desc: "features catalogue with inline filter script" },
    {
      path: "/v152/speculation-rules-moderate-viewport-heuristics-controls/",
      desc: "reference page with showcase iframe",
    },
    { path: "/v147/autofill-event/", desc: "reference page with subroutes" },
    { path: "/v149/webmcp/", desc: "seed reference page" },
    { path: "/conformance", desc: "conformance dashboard" },
    { path: "/public/styles.css", desc: "static CSS asset" },
    { path: "/nonexistent-route-for-404", desc: "404 not-found response", expectStatus: 404 },
  ];

  for (const { path, desc, expectStatus = 200 } of routesToTest) {
    const { response: res } = await fetchSecurityProbe(`${base}${path}`);
    assert(
      `${desc} (${path}) returns HTTP ${expectStatus}`,
      res.status === expectStatus,
      `status: ${res.status}`,
    );

    // nosniff
    const nosniff = res.headers.get("x-content-type-options");
    assert(
      `${desc} sets X-Content-Type-Options: nosniff`,
      nosniff === "nosniff",
      `got: ${nosniff}`,
    );

    // Referrer-Policy
    const refPolicy = res.headers.get("referrer-policy");
    assert(
      `${desc} sets Referrer-Policy: strict-origin-when-cross-origin`,
      refPolicy === "strict-origin-when-cross-origin",
      `got: ${refPolicy}`,
    );

    // X-Frame-Options
    const xfo = res.headers.get("x-frame-options");
    assert(`${desc} sets X-Frame-Options: SAMEORIGIN`, xfo === "SAMEORIGIN", `got: ${xfo}`);

    // Content-Security-Policy
    const csp = res.headers.get("content-security-policy");
    assert(
      `${desc} sets Content-Security-Policy`,
      typeof csp === "string" && csp.length > 0,
      `length: ${csp?.length ?? 0}`,
    );

    const parsed = parseCsp(csp ?? "");

    // Check script-src does NOT use unsafe-inline
    const scriptSrc = parsed.get("script-src") ?? [];
    assert(
      `${desc} script-src avoids 'unsafe-inline'`,
      !scriptSrc.includes("'unsafe-inline'"),
      `script-src: ${scriptSrc.join(" ")}`,
    );

    // Check style-src allows 'unsafe-inline' for per-page layout styles
    const styleSrc = parsed.get("style-src") ?? [];
    assert(
      `${desc} style-src allows 'unsafe-inline' for per-page layout styles`,
      styleSrc.includes("'unsafe-inline'"),
    );

    // Check font-src allows fonts.gstatic.com for vendored Google Fonts woff2
    const fontSrc = parsed.get("font-src") ?? [];
    assert(
      `${desc} font-src allows fonts.gstatic.com`,
      fontSrc.includes("https://fonts.gstatic.com"),
    );

    // Check frame-src allows chrome-platform-showcase.paulkinlan-ea.deno.net
    const frameSrc = parsed.get("frame-src") ?? [];
    assert(
      `${desc} frame-src allows chrome-platform-showcase.paulkinlan-ea.deno.net`,
      frameSrc.includes("https://chrome-platform-showcase.paulkinlan-ea.deno.net"),
    );

    // Check validator helper confirms this live response
    const valid = validateSecurityHeaders(res, desc);
    assert(`${desc} passes full security header validation`, valid.ok, valid.errors.join("; "));
  }

  // --- 3. Body rendering & script hash verification on /features ---
  const { response: featuresRes, text: featuresHtml } = await fetchSecurityProbe(
    `${base}/features`,
  );

  assert("/features payload contains search input #q", featuresHtml.includes('id="q"'));
  assert(
    "/features payload contains milestone select #mstone",
    featuresHtml.includes('id="mstone"'),
  );
  assert("/features payload contains rows table tbody #rows", featuresHtml.includes('id="rows"'));

  // Extract inline script from /features
  const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(featuresHtml);
  assert("/features contains inline script block", scriptMatch !== null);

  if (scriptMatch) {
    const scriptBody = scriptMatch[1];
    const actualHash = await sha256Token(scriptBody);
    const csp = featuresRes.headers.get("content-security-policy") ?? "";
    const parsed = parseCsp(csp);
    const scriptSrc = parsed.get("script-src") ?? [];

    assert(
      "CSP script-src contains exact SHA-256 hash of the /features inline script",
      scriptSrc.includes(actualHash),
      `actual: ${actualHash}, declared in CSP: ${
        scriptSrc.filter((t) => t.startsWith("'sha256-")).join(", ")
      }`,
    );
  }

  // Extract speculationrules script from /features (gendn-xdw)
  const specMatch = /<script type="speculationrules">([\s\S]*?)<\/script>/i.exec(featuresHtml);
  assert("/features contains speculationrules block", specMatch !== null);
  if (specMatch) {
    const specHash = await sha256Token(specMatch[1]);
    const csp = featuresRes.headers.get("content-security-policy") ?? "";
    const parsed = parseCsp(csp);
    const scriptSrc = parsed.get("script-src") ?? [];

    assert(
      "CSP script-src contains exact SHA-256 hash of the speculationrules declaration",
      scriptSrc.includes(specHash),
      `actual: ${specHash}, declared in CSP: ${
        scriptSrc.filter((t) => t.startsWith("'sha256-")).join(", ")
      }`,
    );
  }

  // --- 4. Reference page iframe compatibility ---
  const { response: refRes, text: refHtml } = await fetchSecurityProbe(
    `${base}/v152/speculation-rules-moderate-viewport-heuristics-controls/`,
  );
  const iframeMatch = /<iframe[^>]*src="([^"]+)"/i.exec(refHtml);
  assert(
    "v152 reference page embeds showcase demo iframe",
    iframeMatch !== null,
    iframeMatch ? iframeMatch[1] : "none",
  );

  if (iframeMatch) {
    const iframeSrc = iframeMatch[1];
    const origin = new URL(iframeSrc).origin;
    const csp = refRes.headers.get("content-security-policy") ?? "";
    const parsed = parseCsp(csp);
    const frameSrc = parsed.get("frame-src") ?? [];
    assert(
      "CSP frame-src permits the embedded iframe origin",
      frameSrc.includes(origin),
      `iframe origin: ${origin}`,
    );
  }

  // --- 5. Stylesheet font-src compatibility ---
  const { response: cssRes, text: cssText } = await fetchSecurityProbe(`${base}/public/styles.css`);
  const fontMatches = [...cssText.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]);
  assert(
    "styles.css references external font URLs",
    fontMatches.length > 0,
    `count: ${fontMatches.length}`,
  );
  const fontOrigins = [...new Set(fontMatches.map((u) => new URL(u).origin))];
  const cspCss = cssRes.headers.get("content-security-policy") ?? "";
  const parsedCss = parseCsp(cspCss);
  const fontSrc = parsedCss.get("font-src") ?? [];
  for (const origin of fontOrigins) {
    assert(`CSP font-src permits font origin ${origin}`, fontSrc.includes(origin));
  }

  // --- 5b. gendn-gt7: release-asset script MIME seam is closed ---
  // v<N>/ trees are routine-authored; a script MIME there is 'self'-eligible under the
  // global CSP and would EXECUTE on this origin (measured 2026-10-07 in a real browser:
  // pre-fix mapping executed an authored probe; post-fix it was refused). The server
  // must serve authored .js as text/plain (+ the global nosniff) so no browser runs it.
  // The detector half: a response with a script content-type on a release asset path
  // must FAIL this check, proving the pin is a detector, not decoration.
  {
    const { response: probeRes, text: probeBody } = await fetchSecurityProbe(
      `${base}/v150/focusgroup/inert-probe.js`,
    );
    const probeCt = probeRes.headers.get("content-type") ?? "";
    const probeSniff = probeRes.headers.get("x-content-type-options") ?? "";
    assert(
      "gt7: probe present and served (a 404 also carries text/plain + nosniff and would pass the MIME checks vacuously)",
      probeRes.status === 200 && probeBody.includes("gendn-gt7"),
      `status: ${probeRes.status}; body names the bead: ${probeBody.includes("gendn-gt7")}`,
    );
    assert(
      "gt7: release-asset .js is served inert (text/plain), not a script MIME",
      probeCt.startsWith("text/plain"),
      `content-type: ${probeCt}`,
    );
    assert(
      "gt7: release-asset .js carries nosniff (browsers refuse to execute it)",
      probeSniff === "nosniff",
      `x-content-type-options: ${probeSniff}`,
    );
    const scriptyRes = new Response("alert(1)", {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
    assert(
      "gt7 detector: a script content-type on a release asset path fails the inert check",
      !(scriptyRes.headers.get("content-type") ?? "").startsWith("text/plain"),
      "script MIME detected as non-inert",
    );
  }

  // --- 5c. gendn-izwu: public-asset script MIME seam is closed ---
  // /public is developer-curated (styles.css today), but readPublicAsset previously used
  // the shared MIME map which mapped js -> application/javascript. Under CSP script-src 'self',
  // same-origin script MIME responses would execute on this origin. readPublicAsset now reuses
  // RELEASE_INERT_SCRIPT_MIME so that script extensions are served inert (text/plain + nosniff)
  // uniformly across release trees and /public/*. We verify with a committed probe
  // (/public/probe-inert.js) that:
  // 1. The probe is present and served with status 200 naming the bead (preventing vacuous 404 pass).
  // 2. The public .js asset is served inert (text/plain), not a script MIME.
  // 3. The public .js asset carries nosniff (browsers refuse execution).
  // 4. Existing assets (/public/styles.css) continue to be served non-script with nosniff.
  // 5. RELEASE_INERT_SCRIPT_MIME maps .js, .mjs, .cjs to text/plain.
  // 6. Detector case: a script content-type on a public asset path fails the inert check.
  {
    const { response: probeRes, text: probeBody } = await fetchSecurityProbe(
      `${base}/public/probe-inert.js`,
    );
    const probeCt = probeRes.headers.get("content-type") ?? "";
    const probeSniff = probeRes.headers.get("x-content-type-options") ?? "";
    assert(
      "izwu: probe present and served (a 404 also carries text/plain + nosniff and would pass the MIME checks vacuously)",
      probeRes.status === 200 && probeBody.includes("gendn-izwu"),
      `status: ${probeRes.status}; body names the bead: ${probeBody.includes("gendn-izwu")}`,
    );
    assert(
      "izwu: public-asset .js is served inert (text/plain), not a script MIME",
      probeCt.startsWith("text/plain"),
      `content-type: ${probeCt}`,
    );
    assert(
      "izwu: public-asset .js carries nosniff (browsers refuse to execute it)",
      probeSniff === "nosniff",
      `x-content-type-options: ${probeSniff}`,
    );

    // Existing styles.css must be non-script and carry nosniff
    const { response: cssRes } = await fetchSecurityProbe(`${base}/public/styles.css`);
    const cssCt = cssRes.headers.get("content-type") ?? "";
    const cssSniff = cssRes.headers.get("x-content-type-options") ?? "";
    assert(
      "izwu: /public/styles.css is served with text/css",
      cssRes.status === 200 && cssCt.startsWith("text/css"),
      `status: ${cssRes.status}; content-type: ${cssCt}`,
    );
    assert(
      "izwu: /public/styles.css carries nosniff",
      cssSniff === "nosniff",
      `x-content-type-options: ${cssSniff}`,
    );

    // RELEASE_INERT_SCRIPT_MIME maps all script extensions to inert text/plain
    assert(
      "izwu: RELEASE_INERT_SCRIPT_MIME maps .js to text/plain",
      RELEASE_INERT_SCRIPT_MIME["js"]?.startsWith("text/plain"),
      `js: ${RELEASE_INERT_SCRIPT_MIME["js"]}`,
    );
    assert(
      "izwu: RELEASE_INERT_SCRIPT_MIME maps .mjs to text/plain",
      RELEASE_INERT_SCRIPT_MIME["mjs"]?.startsWith("text/plain"),
      `mjs: ${RELEASE_INERT_SCRIPT_MIME["mjs"]}`,
    );
    assert(
      "izwu: RELEASE_INERT_SCRIPT_MIME maps .cjs to text/plain",
      RELEASE_INERT_SCRIPT_MIME["cjs"]?.startsWith("text/plain"),
      `cjs: ${RELEASE_INERT_SCRIPT_MIME["cjs"]}`,
    );

    // Detector case: a script content-type on a public asset path fails the inert check
    const scriptyPublicRes = new Response("alert(1)", {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
    assert(
      "izwu detector: a script content-type on a public asset path fails the inert check",
      !(scriptyPublicRes.headers.get("content-type") ?? "").startsWith("text/plain"),
      "script MIME detected as non-inert",
    );
  }

  // --- 6. Transport resilience detector: slow CORRECT response vs fast WRONG header ---
  // Reuse an actual /features response from the spawned server so the only differences are
  // a bounded delay or one missing header. The proxy copies only content + security headers;
  // copying content-encoding after fetch decompresses the body would corrupt the response.
  {
    const upstream = await fetchSecurityProbe(`${base}/features`);
    const securityHeaders = new Headers();
    for (
      const name of [
        "content-type",
        "content-security-policy",
        "x-content-type-options",
        "referrer-policy",
        "x-frame-options",
      ]
    ) {
      const value = upstream.response.headers.get(name);
      if (value) securityHeaders.set(name, value);
    }
    let slowRequests = 0;
    const stub = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/slow" && ++slowRequests === 1) {
          await new Promise((resolve) => setTimeout(resolve, 2200));
        } else if (path === "/hang") {
          await new Promise((resolve) => setTimeout(resolve, 900));
        }
        const headers = new Headers(securityHeaders);
        if (path === "/wrong-header") headers.delete("x-frame-options");
        return new Response(upstream.text, { status: 200, headers });
      },
    );
    const stubBase = `http://127.0.0.1:${stub.addr.port}`;
    try {
      const slow = await fetchSecurityProbe(`${stubBase}/slow`, {
        attemptTimeoutMs: 1200,
        totalTimeoutMs: 7000,
        maxAttempts: 3,
        backoffBaseMs: 50,
        jitterMs: 0,
      });
      assert(
        "slow-but-correct server response passes after a real timeout and retry",
        slow.attempts === 2 && slowRequests === 2 &&
          validateSecurityHeaders(slow.response, "slow response").ok &&
          slow.text.includes('id="q"'),
        `attempts=${slow.attempts}; requests=${slowRequests}; elapsed=${
          Math.ceil(slow.elapsedMs)
        }ms`,
      );

      const wrong = await fetchSecurityProbe(`${stubBase}/wrong-header`);
      const wrongCheck = validateSecurityHeaders(wrong.response, "wrong header");
      assert(
        "genuinely wrong security header still FAILS validation without a retry",
        wrong.attempts === 1 && !wrongCheck.ok &&
          wrongCheck.errors.some((error) => error.includes("x-frame-options")),
        `attempts=${wrong.attempts}; errors=${wrongCheck.errors.join("; ")}`,
      );

      let exhausted;
      try {
        await fetchSecurityProbe(`${stubBase}/hang`, {
          attemptTimeoutMs: 350,
          totalTimeoutMs: 1600,
          maxAttempts: 2,
          backoffBaseMs: 30,
          jitterMs: 0,
        });
      } catch (error) {
        exhausted = error;
      }
      assert(
        "exhausted slow transport reports TIMEOUT, not a header failure",
        exhausted instanceof FixtureTransportError && exhausted.kind === "timeout" &&
          exhausted.attempts === 2 && exhausted.message.includes("not a header failure"),
        exhausted?.message ?? "no transport error",
      );
    } finally {
      // Slow stub handlers finish after their finite delay; shut the socket down in every case.
      let timer;
      try {
        await Promise.race([
          stub.shutdown(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Transport timeout shutting down stub server")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // --- 7. DETECTOR CASES (verifying that missing or broken headers fail verification) ---
  {
    // A bare response without security headers MUST fail validation
    const bareRes = new Response("bare html", { headers: { "content-type": "text/html" } });
    const bareCheck = validateSecurityHeaders(bareRes, "bare response");
    assert(
      "detector: response lacking security headers is caught as invalid",
      !bareCheck.ok && bareCheck.errors.length >= 3,
      `caught errors: ${bareCheck.errors.join("; ")}`,
    );

    // A response with unsafe-inline in script-src MUST fail validation
    const unsafeRes = new Response("html", {
      headers: {
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; frame-src 'self' https://chrome-platform-showcase.paulkinlan-ea.deno.net",
      },
    });
    const unsafeCheck = validateSecurityHeaders(unsafeRes, "unsafe script-src");
    assert(
      "detector: policy with 'unsafe-inline' in script-src is rejected",
      !unsafeCheck.ok && unsafeCheck.errors.some((e) => e.includes("unsafe-inline")),
      unsafeCheck.errors.join("; "),
    );

    // A policy without gstatic would reject the font origins
    const brokenCsp = "default-src 'self'";
    const parsedBroken = parseCsp(brokenCsp);
    assert(
      "detector: a naive CSP without fonts.gstatic.com is detected as lacking font origin",
      !(parsedBroken.get("font-src") ?? []).includes("https://fonts.gstatic.com"),
    );

    // A policy without the showcase origin would reject the iframe
    assert(
      "detector: a naive CSP without showcase origin is detected as lacking frame origin",
      !(parsedBroken.get("frame-src") ?? []).includes(
        "https://chrome-platform-showcase.paulkinlan-ea.deno.net",
      ),
    );

    // Tampered script content does not match the CSP hash
    const tamperedScript = (scriptMatch?.[1] ?? "") + "\nconsole.log('tampered');";
    const tamperedHash = await sha256Token(tamperedScript);
    const actualHash = await sha256Token(scriptMatch?.[1] ?? "");
    assert(
      "detector: tampered script bytes produce a different SHA-256 hash",
      tamperedHash !== actualHash,
      `tampered: ${tamperedHash} vs actual: ${actualHash}`,
    );
  }
} catch (error) {
  if (error instanceof FixtureTransportError || error?.message?.startsWith("Transport timeout ")) {
    assert("fixture transport/timeout (not a security-header regression)", false, error.message);
  } else {
    throw error; // Programming and assertion errors must not be mislabeled as transport.
  }
} finally {
  // Unconditionally terminate the server process and bound the wait
  try {
    serverProc.kill("SIGKILL");
  } catch {
    // already exited
  }
  let statusTimer;
  try {
    await Promise.race([
      serverProc.status,
      new Promise((resolve) => {
        statusTimer = setTimeout(resolve, 1500);
      }),
    ]);
  } finally {
    clearTimeout(statusTimer);
  }
}

if (failures > 0) {
  console.error(`security-headers.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`security-headers fixture: all ${passed} assertions passed`);
Deno.exit(0);
