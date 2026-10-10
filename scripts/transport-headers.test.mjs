// @fixture-permissions --allow-read --allow-run --allow-net=127.0.0.1,localhost --allow-env
// scripts/transport-headers.test.mjs — transport-header fixtures (gendn-3ux).
//
// WHY THIS FILE EXISTS:
// The live deployment served HTML with NO content-encoding and NO cache-control, so every page crossed
// the wire raw and every back-navigation re-sent the whole document. A status code proves NOTHING about
// either: the defect IS a 200 whose transport is wrong.
//
// WHY THIS FILE SPEAKS RAW HTTP INSTEAD OF USING fetch():
// Deno's fetch TRANSPARENTLY DECODES a response it sees `content-encoding` on, so `arrayBuffer()` gives
// the decoded bytes while the header still reads `gzip`. An assertion that only checks the header would
// therefore pass while measuring nothing at all — measured while writing this fixture: a 200 with
// `content-encoding: gzip` whose body was the full 9601 uncompressed bytes, which made a naive gunzip
// fail with "incorrect header check". So the compressed cases below go over a raw TCP socket and inspect
// the actual octets on the wire, and every comparison is compress-then-DECODE-then-compare: comparing
// compressed bytes against raw bytes would prove nothing.
//
// The page used is DISCOVERED at run time (first v<N>/<slug>/index.html in the tree) rather than pinned,
// so a milestone rename cannot turn this fixture into a stale literal.
//
// This file is BROWSER-FREE and named `*.test.mjs`, so `deno task test-fixtures` discovers and enrols it
// automatically — the policy scripts/run-fixtures.mjs states in its own header, and why the equivalent
// guard was moved out of the browser-backed chain (gendn-4ck / gendn-kq4).
//
// BOUNDS: the server is spawned on an OS-assigned port (PORT=0), every await is bounded, and the process
// is unconditionally killed in a finally block.
//
// Run: deno task test-fixtures --tasks test-transport-headers
// The control is the runner's EXIT CODE, not a count of PASS lines (gendn-ijf).
import { brotliDecompressSync, gunzipSync } from "node:zlib";

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

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function indexOfCrlfCrlf(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

// Undo chunked transfer-encoding. The runtime drops content-length when it compresses, so a compressed
// response arrives chunked and the octets must be reassembled before they can be decompressed.
function dechunk(body) {
  const parts = [];
  let i = 0;
  while (i < body.length) {
    let j = i;
    while (j + 1 < body.length && !(body[j] === 13 && body[j + 1] === 10)) j++;
    const size = parseInt(new TextDecoder().decode(body.slice(i, j)).split(";")[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(body.slice(j + 2, j + 2 + size));
    i = j + 2 + size + 2;
  }
  return concat(parts);
}

// A raw HTTP/1.1 GET that returns the true wire bytes, a Map of response headers, and the status.
async function rawGet(port, path, headers, method = "GET") {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const request = [
      `${method} ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    await conn.write(new TextEncoder().encode(request));

    const chunks = [];
    const buf = new Uint8Array(1 << 16);
    while (true) {
      const n = await Promise.race([
        conn.read(buf),
        new Promise((resolve) => setTimeout(() => resolve(-1), 5000)),
      ]);
      if (n === null || n === -1) break;
      chunks.push(buf.slice(0, n));
    }

    const all = concat(chunks);
    const sep = indexOfCrlfCrlf(all);
    if (sep < 0) throw new Error("no header terminator in response");
    const [statusLine, ...headerLines] = new TextDecoder().decode(all.slice(0, sep)).split("\r\n");
    const responseHeaders = new Map();
    for (const line of headerLines) {
      const colon = line.indexOf(":");
      if (colon > 0) {
        responseHeaders.set(
          line.slice(0, colon).trim().toLowerCase(),
          line.slice(colon + 1).trim(),
        );
      }
    }
    const framed = all.slice(sep + 4);
    const chunked = (responseHeaders.get("transfer-encoding") ?? "").toLowerCase().includes(
      "chunked",
    );
    const payload = chunked ? dechunk(framed) : framed;
    return {
      status: Number(statusLine.split(" ")[1]),
      header: (name) => responseHeaders.get(name.toLowerCase()) ?? null,
      payload, // the octets the encoder produced (compressed payload, when one was used)
    };
  } finally {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
}

// Discover a real file-backed leaf page: its route, and the exact repo bytes it must serve.
function discoverLeaf() {
  for (const v of Deno.readDirSync(".")) {
    if (!v.isDirectory || !/^v\d+$/.test(v.name)) continue;
    for (const slug of Deno.readDirSync(v.name)) {
      if (!slug.isDirectory) continue;
      const file = `${v.name}/${slug.name}/index.html`;
      try {
        const bytes = Deno.readFileSync(file);
        if (bytes.length > 500) return { route: `/${v.name}/${slug.name}/`, file, bytes };
      } catch {
        // not a page directory
      }
    }
  }
  return null;
}

const sameBytes = (a, b) => a !== null && a.length === b.length && a.every((x, i) => x === b[i]);

const leaf = discoverLeaf();
assert("discovered a file-backed leaf page to test against", leaf !== null, leaf?.file ?? "");
if (!leaf) {
  console.error("transport-headers.test.mjs: no leaf page found");
  Deno.exit(1);
}

const serverProc = new Deno.Command("deno", {
  args: ["run", "--allow-net", "--allow-read", "--allow-env", "server.ts"],
  env: { ...Deno.env.toObject(), PORT: "0" },
  stdout: "piped",
  stderr: "null",
}).spawn();

try {
  // Bound the wait for the OS-assigned port.
  const reader = serverProc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 5000;
  let port = 0;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("port timeout")), 4000)),
    ]);
    if (done) break;
    output += decoder.decode(value, { stream: true });
    const match = /Listening on http:\/\/localhost:(\d+)/.exec(output);
    if (match) {
      port = Number(match[1]);
      break;
    }
  }
  reader.releaseLock();
  assert("server booted on an ephemeral port", port > 0, `port ${port}`);
  if (port === 0) throw new Error("could not read the server port");

  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    try {
      const probe = await rawGet(port, leaf.route, { "accept-encoding": "identity" });
      ready = probe.status === 200;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  assert("server answers the leaf route", ready);

  // 1. IDENTITY: no encoding is claimed, and the octets are the repo file's, exactly.
  const identity = await rawGet(port, leaf.route, { "accept-encoding": "identity" });
  assert("identity request is uncompressed", identity.header("content-encoding") === null);
  assert(
    "identity body is byte-identical to the repo file",
    sameBytes(identity.payload, leaf.bytes),
    `${identity.payload.length}B vs ${leaf.bytes.length}B`,
  );

  // 2. VALIDATORS on the response.
  const etag = identity.header("etag");
  assert(
    "response carries an etag validator",
    typeof etag === "string" && etag.length > 0,
    etag ?? "",
  );
  assert(
    "response carries cache-control",
    identity.header("cache-control") !== null,
    identity.header("cache-control") ?? "",
  );

  // 3. GZIP: advertised, decodes to the repo file, and genuinely smaller on the wire.
  const gzip = await rawGet(port, leaf.route, { "accept-encoding": "gzip" });
  assert(
    "gzip request is answered with content-encoding: gzip",
    gzip.header("content-encoding") === "gzip",
    gzip.header("content-encoding") ?? "none",
  );
  let gzipDecoded = null;
  try {
    gzipDecoded = new Uint8Array(gunzipSync(gzip.payload));
  } catch (err) {
    assert("gzip payload decodes", false, String(err));
  }
  assert(
    "gzip-decoded body is byte-identical to the repo file",
    sameBytes(gzipDecoded, leaf.bytes),
    `${gzip.payload.length}B wire -> ${gzipDecoded?.length ?? -1}B`,
  );
  assert(
    "gzip actually saves octets on the wire",
    gzip.payload.length < leaf.bytes.length,
    `${gzip.payload.length} < ${leaf.bytes.length}`,
  );
  assert(
    "a compressed response advertises vary: accept-encoding",
    (gzip.header("vary") ?? "").toLowerCase().includes("accept-encoding"),
    gzip.header("vary") ?? "absent",
  );

  // 4. BROTLI: what a real browser negotiates, decoded and compared again.
  const br = await rawGet(port, leaf.route, { "accept-encoding": "gzip, deflate, br, zstd" });
  assert(
    "browser-style request negotiates br",
    br.header("content-encoding") === "br",
    br.header("content-encoding") ?? "none",
  );
  let brDecoded = null;
  try {
    brDecoded = new Uint8Array(brotliDecompressSync(br.payload));
  } catch (err) {
    assert("brotli payload decodes", false, String(err));
  }
  assert(
    "brotli-decoded body is byte-identical to the repo file",
    sameBytes(brDecoded, leaf.bytes),
    `${br.payload.length}B wire -> ${brDecoded?.length ?? -1}B`,
  );

  // 5. REVALIDATION: a repeat request must be answered 304 with no body, not a refetched document.
  // IDENTITY is requested deliberately: it makes the "no content-length on a 304" assertion below a real
  // detector, because the same request WITHOUT the 304 branch returns a full identity 200 that does carry
  // content-length. (Review P2-4: with a compressed request that assertion could not fail.)
  const revalidated = await rawGet(port, leaf.route, {
    "if-none-match": etag ?? "",
    "accept-encoding": "identity",
  });
  assert(
    "a matching if-none-match is answered 304 Not Modified",
    revalidated.status === 304,
    String(revalidated.status),
  );
  assert(
    "the 304 carries no body (no refetch)",
    revalidated.payload.length === 0,
    `${revalidated.payload.length}B`,
  );
  assert(
    // NOT A MUTATION-DETECTOR IN THIS TREE, and that is deliberate rather than overlooked (review P2-4):
    // the runtime strips content-length from a bodiless 304 itself, and no route sets content-encoding, so
    // neither this assertion nor the deletes above can fail today. It pins the invariant for the case that
    // would change it - see the comment on those deletes.
    "the 304 advertises neither a length nor a coding for a body it does not have",
    revalidated.header("content-length") === null &&
      revalidated.header("content-encoding") === null,
  );

  // 6. DETECTOR: a non-matching validator must NOT be answered 304, or the fixture above is decoration.
  const mismatch = await rawGet(port, leaf.route, {
    "if-none-match": 'W/"0000000000000000000000000000000000000000"',
  });
  assert(
    "a wrong validator still gets the full document",
    mismatch.status === 200,
    String(mismatch.status),
  );
  assert(
    "...and that body is the repo file again",
    sameBytes(mismatch.payload, leaf.bytes),
    `${mismatch.payload.length}B`,
  );

  // 7. The security header set must survive onto the 304 as well.
  assert(
    "the 304 still carries nosniff",
    revalidated.header("x-content-type-options") === "nosniff",
  );
  assert(
    "the 304 still carries the CSP",
    (revalidated.header("content-security-policy") ?? "").includes("default-src 'self'"),
  );

  // 8. RFC 9110 13.1.2 for `If-None-Match: *`: that condition is FALSE only when the server DOES have a
  // current representation for the target. So "*" on an existing route is a 304, but "*" on a MISSING
  // route must let the 404 through. The first form of this fix hashed the 404 body and matched "*"
  // against it, answering 304 for a resource that does not exist - which tells a cache it is there.
  // This block makes that unrepresentable. (Found by review as a source-implied hypothesis; that
  // reviewer's tooling could not run a probe, so it is reproduced here as an executable assertion.)
  const wildcardExisting = await rawGet(port, leaf.route, { "if-none-match": "*" });
  assert(
    "'*' on an existing route is answered 304",
    wildcardExisting.status === 304,
    String(wildcardExisting.status),
  );
  const wildcardMissing = await rawGet(port, "/__definitely_missing__", { "if-none-match": "*" });
  assert(
    "'*' on a MISSING route is still 404, never 304",
    wildcardMissing.status === 404,
    String(wildcardMissing.status),
  );
  const plainMissing = await rawGet(port, "/__definitely_missing__", {});
  assert(
    "...and without a validator the same missing route is still that 404 (control)",
    plainMissing.status === 404,
    String(plainMissing.status),
  );
  assert(
    "a 404 carries no revalidation validator",
    plainMissing.header("etag") === null && plainMissing.header("cache-control") === null,
  );

  // 9. RFC 9110 15.4.5: a 304 MUST carry the Vary that a 200 to the SAME request would have carried. The
  // runtime adds vary: Accept-Encoding only when it compresses, and cannot add anything to a bodyless
  // 304, so the application has to. (Review P2-1: the 304 was dropping the Vary its own 200 sent.)
  const compressed304 = await rawGet(port, leaf.route, {
    "if-none-match": etag ?? "",
    "accept-encoding": "gzip, br",
  });
  assert(
    "a 304 for a compressible request is still 304",
    compressed304.status === 304,
    String(compressed304.status),
  );
  assert(
    "that 304 carries vary: accept-encoding, as a 200 to the same request would",
    (compressed304.header("vary") ?? "").toLowerCase().includes("accept-encoding"),
    compressed304.header("vary") ?? "absent",
  );

  // 10. RFC 9110 13.1.2 defines this condition in terms of "the request method is GET or HEAD". The first
  // form of this fix evaluated it for every method and answered 304 to POST/PUT. (Review P2-2.)
  const posted = await rawGet(port, leaf.route, { "if-none-match": "*" }, "POST");
  assert(
    "If-None-Match on a non-GET/HEAD method is NOT answered 304",
    posted.status !== 304,
    String(posted.status),
  );
} finally {
  try {
    serverProc.kill("SIGKILL");
  } catch {
    // already exited
  }
  await Promise.race([serverProc.status, new Promise((resolve) => setTimeout(resolve, 1500))]);
}

if (failures > 0) {
  console.error(`transport-headers.test.mjs: ${failures} assertion(s) failed (${passed} passed)`);
  Deno.exit(1);
}
console.log(`PASS — transport headers (${passed} assertions)`);
