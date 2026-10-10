// @fixture-permissions --allow-read --allow-net=127.0.0.1
// scripts/mdn-has.test.mjs — the gendn-5fk acceptance fixture.
//
// The finding: lib/mdn.ts issued `fetch(url, { method: "HEAD" })` with no timeout and no size
// bound (the last unbounded fetch in the repo, violating THREAT_MODEL.md invariant #7), and its
// catch cached ANY transport error for the 1-hour TTL as a definitive exists:false — so a network
// blip was remembered as "MDN has no page".
//
// This drives the real module against a REAL local HTTP server (loopback only, real fetch, real
// timeouts) and asserts:
//   1. a stalling endpoint fails BOUNDED rather than hanging;
//   2. a timed-out call does NOT poison the cache — a later good response is present;
//   3. a genuine 200 caches { kind: "present" } and is served from cache on the second call;
//   4. a genuine 404 returns { kind: "missing" } and is cached (a real negative answer);
//   5. a 5xx returns { kind: "unknown" } and is NOT cached;
//   5b. a caller must distinguish an UNKNOWN transport failure from a definitive 404;
//   6. no bare fetch() survives in lib/mdn.ts (source-level check for acceptance item 3);
//   7. (gendn-5ua) mdnApiUrl/mdnCssUrl produce EXACT documented URLs; a drifted base path or locale
//      segment must fail here. (These builders are currently UNCALLED — the pages' reference links
//      are hardcoded hrefs, and the routine prompt writes its MDN URLs by hand. See the gendn-76k
//      note beside the pins for why that matters.)
//
// Run: deno task test-fixtures --tasks test-mdn-has (includes deno check lib/mdn.ts first)

import { mdnApiUrl, mdnCssUrl, mdnHas } from "../lib/mdn.ts";

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

// --- local MDN stand-in ---------------------------------------------------------
const hits = { ok: 0, missing: 0, error: 0, flaky: 0, stall: 0 };
let flakyShouldStall = true;
const hangResolvers = [];

const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/ok") {
    hits.ok++;
    return new Response("<!doctype html><p>exists</p>", {
      headers: { "content-type": "text/html" },
    });
  }
  if (path === "/missing") {
    hits.missing++;
    return new Response("nope", { status: 404 });
  }
  if (path === "/error") {
    hits.error++;
    return new Response("boom", { status: 500 });
  }
  if (path === "/flaky") {
    hits.flaky++;
    if (flakyShouldStall) {
      // Simulate a transport that never answers, so the caller's bound is the only way out.
      return new Promise((resolve) => hangResolvers.push(() => resolve(new Response("late"))));
    }
    return new Response("<!doctype html><p>back</p>", {
      headers: { "content-type": "text/html" },
    });
  }
  if (path === "/stall") {
    hits.stall++;
    return new Promise((resolve) => hangResolvers.push(() => resolve(new Response("late"))));
  }
  return new Response("nope", { status: 404 });
});
const base = `http://127.0.0.1:${server.addr.port}`;

const timed = async (fn) => {
  const t0 = performance.now();
  try {
    return { ok: true, value: await fn(), ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { ok: false, err, ms: Math.round(performance.now() - t0) };
  }
};

try {
  // 1. STALLING endpoint: must settle within the bound, not hang.
  const stall = await timed(() => mdnHas("/stall", { base, timeoutMs: 300 }));
  assert(
    "stalling endpoint fails BOUNDED (settles, does not hang)",
    stall.ok && stall.value?.kind === "unknown" && stall.ms < 2000,
    `${stall.ms}ms, bound 300ms, kind=${stall.value?.kind}`,
  );

  // 2. A TIMED-OUT call must not poison the cache: the second call sees a good response.
  const first = await timed(() => mdnHas("/flaky", { base, timeoutMs: 300 }));
  assert(
    "flaky first call (transport never answers) returns unknown bounded",
    first.ok && first.value?.kind === "unknown",
    `${first.ms}ms`,
  );
  flakyShouldStall = false;
  const second = await timed(() => mdnHas("/flaky", { base, timeoutMs: 5000 }));
  assert(
    "SECOND call after a transport failure is NOT answered from cache (returns present)",
    second.ok && second.value?.kind === "present",
    `value=${second.value}, hits=${hits.flaky}`,
  );
  assert("the flaky endpoint was actually re-requested", hits.flaky >= 2, `hits=${hits.flaky}`);

  // 3. genuine 200: true, and cached.
  const ok1 = await mdnHas("/ok", { base, timeoutMs: 5000 });
  const ok2 = await mdnHas("/ok", { base, timeoutMs: 5000 });
  assert(
    "genuine 200 returns present",
    ok1.kind === "present" && ok2.kind === "present",
    `${ok1.kind}/${ok2.kind}`,
  );
  assert("genuine 200 is cached (one request for two calls)", hits.ok === 1, `hits=${hits.ok}`);

  // 4. genuine 404: missing, and cached (a definitive negative stays definitive).
  const miss1 = await mdnHas("/missing", { base, timeoutMs: 5000 });
  const miss2 = await mdnHas("/missing", { base, timeoutMs: 5000 });
  assert(
    "genuine 404 returns missing",
    miss1.kind === "missing" && miss2.kind === "missing",
    `${miss1.kind}/${miss2.kind}`,
  );
  assert(
    "genuine 404 is cached (one request for two calls)",
    hits.missing === 1,
    `hits=${hits.missing}`,
  );

  // 5. 5xx: unknown and NOT cached, because a server error says nothing about the page.
  const err1 = await mdnHas("/error", { base, timeoutMs: 5000 });
  const err2 = await mdnHas("/error", { base, timeoutMs: 5000 });
  assert(
    "5xx returns unknown",
    err1.kind === "unknown" && err2.kind === "unknown",
    `${err1.kind}/${err2.kind}`,
  );
  assert("5xx is NOT cached (both calls hit the server)", hits.error === 2, `hits=${hits.error}`);

  // 5b. An actual caller must branch on the discriminant, not treat UNKNOWN as a
  // definitive negative. Ambiguous MDN coverage still generates the page rather than
  // redirecting (THREAT_MODEL.md invariant #6), but must be labeled as ambiguous.
  const decision = (lookup) => {
    switch (lookup.kind) {
      case "present":
        return "redirect";
      case "missing":
        return "generate-known-missing";
      case "unknown":
        return "generate-ambiguous";
      default:
        throw new Error(`unhandled MDN lookup state: ${lookup.kind}`);
    }
  };
  assert(
    "caller distinguishes a real transport failure from a genuine 404",
    decision(stall.value) === "generate-ambiguous" &&
      decision(miss1) === "generate-known-missing" &&
      decision(ok1) === "redirect" &&
      stall.value?.kind !== miss1.kind,
    `stall=${stall.value?.kind}; 404=${miss1.kind}; 200=${ok1.kind}`,
  );
} finally {
  for (const release of hangResolvers) {
    try {
      release();
    } catch {
      // already closed
    }
  }
  try {
    await server.shutdown();
  } catch {
    // ignore
  }
}

// 6. Source check: no bare fetch() left in lib/mdn.ts (acceptance item 3).
const src = await Deno.readTextFile(new URL("../lib/mdn.ts", import.meta.url));
const bareFetches = [...src.matchAll(/(^|[^A-Za-z])fetch\s*\(/g)].filter((m) =>
  !m[0].includes("fetchBounded")
);
assert(
  "lib/mdn.ts contains no bare fetch() (bounded helper is the only transport call)",
  bareFetches.length === 0,
  `${bareFetches.length} bare fetch( occurrence(s)`,
);

// 7. (gendn-5ua) mdnApiUrl / mdnCssUrl exact-output pins. The builders are pure template
// interpolation into fixed en-US base paths — NO escaping or encoding is applied, and these
// assertions pin that ACTUAL contract (per the bead: do not invent semantics). A plausible
// wrong base path (Web/Api, /docs/Web/API/, a different locale) fails the exact-equality pins;
// mutation evidence is recorded on the bead.
//
// CONSEQUENCE, stated so a reader does not mistake this for an endorsement (gendn-76k): these pins
// record the CURRENT behaviour of CURRENTLY-UNUSED builders - nothing outside this fixture calls
// them, and the routine prompt builds its MDN URLs by hand in prose. So the raw-interpolation pin is
// a TRIPWIRE placed where the hazard would enter, not a claim that raw interpolation is correct. If
// a caller appears, escaping must be added BEFORE it is used, and that is a deliberate change which
// updates this pin rather than merely failing it.
const API_BASE = "https://developer.mozilla.org/en-US/docs/Web/API/";
const CSS_BASE = "https://developer.mozilla.org/en-US/docs/Web/CSS/";
assert(
  "mdnApiUrl: a normal interface name yields the exact en-US Web/API URL",
  mdnApiUrl("PaymentRequest") === `${API_BASE}PaymentRequest`,
  mdnApiUrl("PaymentRequest"),
);
assert(
  "mdnCssUrl: a normal property name yields the exact en-US Web/CSS URL",
  mdnCssUrl("grid-template-areas") === `${CSS_BASE}grid-template-areas`,
  mdnCssUrl("grid-template-areas"),
);
assert(
  "mdnApiUrl: empty input yields the bare base (actual contract — no validation, no throw)",
  mdnApiUrl("") === API_BASE,
  mdnApiUrl(""),
);
assert(
  "mdnCssUrl: empty input yields the bare base (actual contract)",
  mdnCssUrl("") === CSS_BASE,
  mdnCssUrl(""),
);
assert(
  "mdnApiUrl: interpolated raw — spaces/slashes are NOT escaped (actual contract: callers pass canonical identifiers; pinned so any future escaping change is deliberate)",
  mdnApiUrl("a b/c") === `${API_BASE}a b/c`,
  mdnApiUrl("a b/c"),
);

if (failures > 0) {
  console.error(`mdn-has.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`mdn-has fixture: all ${passed} assertions passed`);
