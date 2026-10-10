// @fixture-permissions --allow-read --allow-env --allow-net=127.0.0.1,localhost
// scripts/speculation-rules.test.mjs — unit tests for same-origin speculation-rules prefetch (gendn-xdw).
//
// Verifies:
//   1. server.ts exports SPECULATION_RULES declaration with required format and moderate eagerness.
//   2. Prerender is OFF (pages embed cross-origin showcase iframes; prefetch only).
//   3. Server-rendered routes (/, /v<N>/, /features) emit the block.
//   4. Static leaf reference pages do not contain the block (recommendation B: no churn on 201+ files).
//   5. CSP script-src includes the exact SHA-256 hash of the speculation rules script.

const XSSI = ")]}'";
const stubServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
  const json = (body) => new Response(body, { headers: { "content-type": "application/json" } });
  if (url.pathname === "/channels") {
    return json(`${XSSI}\n${
      JSON.stringify({
        canary: { mstone: 151, version: "151.0.0.0" },
        dev: { mstone: 150, version: "150.0.0.0" },
        beta: { mstone: 149, version: "149.0.0.0" },
        stable: { mstone: 148, version: "148.0.0.0", stable_date: "2026-01-01T00:00:00Z" },
      })
    }`);
  }
  if (url.pathname === "/features") {
    return json(`${XSSI}\n${JSON.stringify({ features_by_type: {} })}`);
  }
  return new Response("Not found", { status: 404 });
});

Deno.env.set("CHROMESTATUS_BASE", `http://127.0.0.1:${stubServer.addr.port}`);

const { CSP_DIRECTIVES, handleRequest, SPECULATION_RULES } = await import("../server.ts");

let passed = 0;
let failed = 0;

function assert(desc, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS: ${desc}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`FAIL: ${desc}${detail ? ` :: ${detail}` : ""}`);
  }
}

try {
  // 1. Structure of SPECULATION_RULES
  assert("SPECULATION_RULES is exported", typeof SPECULATION_RULES === "string");
  const expectedBlock =
    '<script type="speculationrules">{"prefetch":[{"source":"document","where":{"href_matches":"/v*/**"},"eagerness":"moderate"}]}</script>';
  assert("SPECULATION_RULES matches exact approved contract", SPECULATION_RULES === expectedBlock);

  const match = /<script type="speculationrules">([\s\S]*?)<\/script>/i.exec(SPECULATION_RULES);
  assert("SPECULATION_RULES is enclosed in script[type=speculationrules]", match !== null);

  const json = JSON.parse(match[1]);
  assert(
    "speculation rules declares prefetch array",
    Array.isArray(json.prefetch) && json.prefetch.length === 1,
  );
  assert("prefetch source is 'document'", json.prefetch[0].source === "document");
  assert("prefetch href_matches is '/v*/**'", json.prefetch[0].where?.href_matches === "/v*/**");
  assert("prefetch eagerness is 'moderate'", json.prefetch[0].eagerness === "moderate");
  assert("prerender is OFF (undefined)", json.prerender === undefined);

  // 2. CSP script-src includes exact SHA-256 hash of the block content
  const bytes = new TextEncoder().encode(match[1]);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const expectedHash = `'sha256-${b64}'`;

  const scriptSrcDirective = CSP_DIRECTIVES.find((d) => d.startsWith("script-src "));
  assert("CSP has script-src directive", scriptSrcDirective !== undefined);
  assert(
    `CSP script-src includes speculation rules hash (${expectedHash})`,
    scriptSrcDirective.includes(expectedHash),
    `script-src: ${scriptSrcDirective}`,
  );

  // 3. SSR routes emit the block
  const homeRes = await handleRequest(new Request("http://localhost/"));
  assert("GET / returns 200", homeRes.status === 200);
  const homeHtml = await homeRes.text();
  assert("GET / contains SPECULATION_RULES", homeHtml.includes(SPECULATION_RULES));

  const hubRes = await handleRequest(new Request("http://localhost/v148/"));
  assert("GET /v148/ returns 200", hubRes.status === 200);
  const hubHtml = await hubRes.text();
  assert("GET /v148/ contains SPECULATION_RULES", hubHtml.includes(SPECULATION_RULES));

  const featRes = await handleRequest(new Request("http://localhost/features"));
  assert("GET /features returns 200", featRes.status === 200);
  const featHtml = await featRes.text();
  assert("GET /features contains SPECULATION_RULES", featHtml.includes(SPECULATION_RULES));

  // 4. Static leaf reference page does NOT contain speculation rules (recommendation B)
  const leafRes = await handleRequest(new Request("http://localhost/v147/autofill-event/"));
  assert("GET /v147/autofill-event/ returns 200", leafRes.status === 200);
  const leafHtml = await leafRes.text();
  assert(
    "GET /v147/autofill-event/ leaves static leaf unchurned",
    !leafHtml.includes("speculationrules"),
  );
} finally {
  await stubServer.shutdown();
}

console.log(`\nspeculation-rules unit tests: ${passed} passed, ${failed} failed`);
if (failed > 0) Deno.exit(1);
