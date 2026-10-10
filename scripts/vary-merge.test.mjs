// @fixture-permissions --allow-read --allow-env=PORT
// scripts/vary-merge.test.mjs — vary-header merging unit tests for withRevalidation (gendn-a3q).
//
// WHY THIS FILE EXISTS:
// In withRevalidation, a 304 response carries vary: accept-encoding when compression is accepted.
// Previously, headers.set("vary", "accept-encoding") clobbered any Vary header a future route
// had already set on the Response. RFC 9110 15.4.5 requires a 304 to carry the same Vary that a
// 200 to the same request would carry; Deno's runtime preserves and merges existing Vary values
// on 200 responses, so withRevalidation must merge (append) accept-encoding onto existing Vary
// headers rather than overwriting them.
//
// MUTATION PROOF:
// Reverting the merge logic in server.ts back to headers.set("vary", "accept-encoding") clobbers
// existing Vary values (e.g. "Accept-Language") and fails the assertion that checks for merged
// "Accept-Language, accept-encoding".
//
// Run: deno task test-fixtures --tasks test-vary-merge

import { withRevalidation } from "../server.ts";

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

// Compute the matching weak ETag for a given body string
async function computeEtag(body) {
  const bytes = new TextEncoder().encode(body);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return `W/"${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

const body = "test body for vary merge";
const etag = await computeEtag(body);

// 1. Existing behavior preserved: no prior Vary header on compressible 304 emits accept-encoding
{
  const req = new Request("http://localhost/test", {
    headers: { "accept-encoding": "gzip, br", "if-none-match": etag },
  });
  const res = new Response(body, { status: 200 });
  const out = await withRevalidation(req, res);
  assert("compressible 304 with no prior Vary is 304", out.status === 304);
  assert(
    "Vary is exactly accept-encoding when no prior Vary existed",
    out.headers.get("vary") === "accept-encoding",
    out.headers.get("vary") ?? "absent",
  );
}

// 2. Merging: existing Vary (e.g. Accept-Language) is merged, not clobbered
{
  const req = new Request("http://localhost/test", {
    headers: { "accept-encoding": "gzip, br", "if-none-match": etag },
  });
  const res = new Response(body, {
    status: 200,
    headers: { vary: "Accept-Language" },
  });
  const out = await withRevalidation(req, res);
  assert("compressible 304 with prior Vary is 304", out.status === 304);
  const vary = out.headers.get("vary") ?? "";
  assert(
    "prior Vary is preserved and accept-encoding is appended (merged)",
    vary === "Accept-Language, accept-encoding",
    vary,
  );
}

// 3. Deduplication: existing Vary already containing accept-encoding is not duplicated
{
  const req = new Request("http://localhost/test", {
    headers: { "accept-encoding": "gzip, br", "if-none-match": etag },
  });
  const res = new Response(body, {
    status: 200,
    headers: { vary: "accept-encoding" },
  });
  const out = await withRevalidation(req, res);
  assert("compressible 304 with existing accept-encoding is 304", out.status === 304);
  const vary = out.headers.get("vary") ?? "";
  assert(
    "existing accept-encoding is not duplicated",
    vary === "accept-encoding",
    vary,
  );
}

// 4. Case-insensitivity and list dedup: existing Vary with multiple tokens including Accept-Encoding
{
  const req = new Request("http://localhost/test", {
    headers: { "accept-encoding": "gzip, br", "if-none-match": etag },
  });
  const res = new Response(body, {
    status: 200,
    headers: { vary: "Accept-Language, Accept-Encoding" },
  });
  const out = await withRevalidation(req, res);
  assert(
    "compressible 304 with list already containing Accept-Encoding is 304",
    out.status === 304,
  );
  const vary = out.headers.get("vary") ?? "";
  assert(
    "existing list containing Accept-Encoding is preserved without duplication",
    vary === "Accept-Language, Accept-Encoding",
    vary,
  );
}

// 5. Existing Vary with multiple tokens not containing accept-encoding
{
  const req = new Request("http://localhost/test", {
    headers: { "accept-encoding": "gzip, br", "if-none-match": etag },
  });
  const res = new Response(body, {
    status: 200,
    headers: { vary: "Cookie, User-Agent" },
  });
  const out = await withRevalidation(req, res);
  const vary = out.headers.get("vary") ?? "";
  assert(
    "multi-token Vary without accept-encoding appends accept-encoding",
    vary === "Cookie, User-Agent, accept-encoding",
    vary,
  );
}

// 6. Request not accepting compression preserves existing Vary without adding accept-encoding
{
  const req = new Request("http://localhost/test", {
    headers: { "accept-encoding": "identity", "if-none-match": etag },
  });
  const res = new Response(body, {
    status: 200,
    headers: { vary: "Accept-Language" },
  });
  const out = await withRevalidation(req, res);
  assert("uncompressed 304 is 304", out.status === 304);
  const vary = out.headers.get("vary");
  assert(
    "uncompressed 304 preserves existing Vary without appending accept-encoding",
    vary === "Accept-Language",
    vary ?? "absent",
  );
}

// 7. Request not accepting compression and no prior Vary has no Vary
{
  const req = new Request("http://localhost/test", {
    headers: { "accept-encoding": "identity", "if-none-match": etag },
  });
  const res = new Response(body, { status: 200 });
  const out = await withRevalidation(req, res);
  assert(
    "uncompressed 304 with no prior Vary has no Vary header",
    out.headers.get("vary") === null,
  );
}

// 8. 200 response (mismatched etag) preserves route's Vary untouched
{
  const req = new Request("http://localhost/test", {
    headers: { "accept-encoding": "gzip, br", "if-none-match": 'W/"wrong"' },
  });
  const res = new Response(body, {
    status: 200,
    headers: { vary: "Accept-Language" },
  });
  const out = await withRevalidation(req, res);
  assert("mismatched etag returns 200", out.status === 200);
  assert(
    "200 response preserves route-set Vary untouched",
    out.headers.get("vary") === "Accept-Language",
    out.headers.get("vary") ?? "absent",
  );
}

if (failures > 0) {
  console.error(`vary-merge.test.mjs: ${failures} assertion(s) failed (${passed} passed)`);
  Deno.exit(1);
}
console.log(`PASS — vary merge (${passed} assertions)`);
