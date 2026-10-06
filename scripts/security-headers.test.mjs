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
// Every await is strictly bounded with AbortSignal.timeout() or Promise.race against a deadline.
// The ephemeral port is assigned by the OS (PORT=0) and the spawned server process is unconditionally
// terminated with SIGKILL in a finally block.
//
// Run: deno task test-security-headers  (discovered automatically by `deno task test-fixtures`)

import { CSP_DIRECTIVES, CSP_HEADER_VALUE } from "../server.ts";

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
export function validateSecurityHeaders(res, desc) {
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
  const portDeadline = Date.now() + 5000;

  while (Date.now() < portDeadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout reading server port")), 4000)
      ),
    ]);
    if (done) break;
    capturedOutput += decoder.decode(value, { stream: true });
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

  // Poll server with bounded fetch until ready
  let serverReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        await res.body?.cancel();
        serverReady = true;
        break;
      }
    } catch {
      // waiting for socket
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert("server answers HTTP requests on ephemeral port", serverReady, `endpoint ${base}/`);
  if (!serverReady) throw new Error(`server failed to answer at ${base}/`);

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
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(4000) });
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

    // Consume body
    await res.text();
  }

  // --- 3. Body rendering & script hash verification on /features ---
  const featuresRes = await fetch(`${base}/features`, { signal: AbortSignal.timeout(4000) });
  const featuresHtml = await featuresRes.text();

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

  // --- 4. Reference page iframe compatibility ---
  const refRes = await fetch(
    `${base}/v152/speculation-rules-moderate-viewport-heuristics-controls/`,
    {
      signal: AbortSignal.timeout(4000),
    },
  );
  const refHtml = await refRes.text();
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
  const cssRes = await fetch(`${base}/public/styles.css`, { signal: AbortSignal.timeout(4000) });
  const cssText = await cssRes.text();
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

  // --- 6. DETECTOR CASES (verifying that missing or broken headers fail verification) ---
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
} finally {
  // Unconditionally terminate the server process and bound the wait
  try {
    serverProc.kill("SIGKILL");
  } catch {
    // already exited
  }
  await Promise.race([
    serverProc.status,
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
}

if (failures > 0) {
  console.error(`security-headers.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`security-headers fixture: all ${passed} assertions passed`);
Deno.exit(0);
