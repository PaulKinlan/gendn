// scripts/chromestatus-units.test.mjs — direct unit coverage for lib/chromestatus.ts (gendn-14o).
//
// THE GAP: fetchBounded/readCapped already have the fetch-bounded fixture, but getJson's XSSI
// stripping, non-ok rejection, cache TTL/isolation, getMilestoneFeatures grouping/total, and
// slugify's canonical-route naming had NO direct tests. An external response-shape change or a
// slug-normalization drift silently orphans published routes, because server.ts names every
// v<N>/<slug>/ folder with slugify(listing name).
//
// NO LIVE DEPENDENCY: the fixture sets CHROMESTATUS_BASE to a local HTTP stub BEFORE importing
// the module (the wrapper's documented test seam), so every response shape below is deliberate.
//
// DETECTORS — each section kills a plausible wrong implementation, stated inline:
//   - a XSSI parser that blindly slices 4 chars corrupts PLAIN JSON (pinned: plain parses);
//   - one that requires a newline after )]}' breaks the no-newline shape (pinned);
//   - a getJson that swallows non-ok statuses returns garbage instead of throwing (pinned);
//   - a cache that never expires or never keys per path (pinned via request counts + a Date.now
//     patch across the TTL boundary);
//   - a grouping that keeps empty categories or miscounts total (pinned);
//   - a slugify on NFC instead of NFD keeps accents (pinned), one that maps each non-alnum to its
//     own dash breaks collapse (pinned), one that truncates BEFORE stripping edge dashes differs
//     at the 80 boundary (pinned), and one that uppercases survives (pinned).
//
// PARITY: slugify is compared against .claude/fix-slugs.py's slugify (the script that renames
// published folders to canonical routes) — live via python3 when available, else against the
// embedded table generated from it on 2026-10-06. ONE REPRESENTATIVE DIVERGENCE is pinned here;
// the divergence CLASS was measured to be broader (three categories, including one with the
// OPPOSITE polarity) — see the MEASURED BOUNDARY comment at the pin for the full rule:
// combining marks with a non-zero class OUTSIDE U+0300-U+036F (e.g. U+20D0) are dropped by the
// python (category/class-based) but become a dash in the TS regex range. Changing either side
// would rename published routes, so the divergence is recorded, tested as-is, and reported on the
// bead rather than "fixed" here.
//
// Run: deno task test-chromestatus-units

const REPO = new URL("..", import.meta.url).pathname;

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

// --- local stub of the chromestatus API ------------------------------------------------
const reqCount = new Map();
function bump(key) {
  reqCount.set(key, (reqCount.get(key) ?? 0) + 1);
}
const XSSI = ")]}'";
const feat = (id, name) => ({ id, name, summary: `s${id}` });

const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
  const key = url.pathname + url.search;
  bump(key);
  const json = (body, status = 200) =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  if (url.pathname === "/channels") {
    return json(
      `${XSSI}\n${
        JSON.stringify({
          stable: { mstone: 141, version: 141, branch_point: "b", stable_date: "d" },
          beta: { mstone: 142, version: 142, branch_point: "b", stable_date: "d" },
          dev: { mstone: 143, version: 143, branch_point: "b", stable_date: "d" },
        })
      }`,
    );
  }
  if (url.pathname === "/features/2") return json(`${XSSI}{"id":2,"name":"No Newline"}`);
  if (url.pathname === "/features/3") return json(`{"id":3,"name":"Plain JSON"}`);
  if (url.pathname === "/features/4") return json(`${XSSI}\n{oops not json`);
  if (url.pathname === "/features/9") return json(XSSI); // prefix only, empty body
  if (url.pathname === "/features/404") return json("nope", 404);
  if (url.pathname === "/features/500") return json("boom", 500);
  if (url.pathname === "/features/7") return json(`${XSSI}\n{"id":7,"name":"Cached"}`);
  if (url.pathname === "/features/71") return json(`${XSSI}\n{"id":71,"name":"Iso A"}`);
  if (url.pathname === "/features/72") return json(`${XSSI}\n{"id":72,"name":"Iso B"}`);
  if (url.pathname === "/features" && url.searchParams.get("milestone") === "111") {
    return json(
      `${XSSI}\n${
        JSON.stringify({
          features_by_type: {
            "Enabled by default": [feat(1, "A"), feat(2, "B")],
            "Origin trial": [],
            "Deprecated": [feat(3, "C")],
          },
        })
      }`,
    );
  }
  if (url.pathname === "/features" && url.searchParams.get("milestone") === "112") {
    return json(`${XSSI}\n${JSON.stringify({ features_by_type: { "Origin trial": [] } })}`);
  }
  return json("not found", 404);
});
const base = `http://127.0.0.1:${server.addr.port}`;

// The seam must be set BEFORE the module is imported (BASE is captured at import time).
Deno.env.set("CHROMESTATUS_BASE", base);
const { getChannels, getFeature, getMilestoneFeatures, slugify } = await import(
  "../lib/chromestatus.ts"
);

const rejects = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};
// Happy-path calls are SETTLED, not awaited raw: against a wrong implementation they reject, and
// the fixture must report a clean FAIL and keep running rather than crash on the first one (a
// crash is still a non-zero exit, but it hides which assertions the wrong impl would trip).
const settled = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, err };
  }
};

try {
  // --- XSSI parsing via the public API --------------------------------------------------
  const chR = await settled(() => getChannels());
  assert(
    "XSSI prefix + newline is stripped and the JSON parses (getChannels)",
    chR.ok && chR.value.stable.mstone === 141 && chR.value.dev.version === 143,
    chR.ok ? JSON.stringify(chR.value.stable) : String(chR.err?.message ?? chR.err).slice(0, 120),
  );
  const f2R = await settled(() => getFeature(2));
  assert(
    "XSSI prefix with NO newline parses (trimStart, not a fixed slice of the first line)",
    f2R.ok && f2R.value.name === "No Newline",
    f2R.ok ? JSON.stringify(f2R.value) : String(f2R.err?.message ?? f2R.err).slice(0, 120),
  );
  const f3R = await settled(() => getFeature(3));
  assert(
    "PLAIN JSON (no prefix) is NOT corrupted — kills a parser that blindly slices 4 chars",
    f3R.ok && f3R.value.name === "Plain JSON" && f3R.value.id === 3,
    f3R.ok ? JSON.stringify(f3R.value) : String(f3R.err?.message ?? f3R.err).slice(0, 120),
  );

  // --- malformed / non-ok: loud, never silent garbage ---------------------------------
  const malformed = await rejects(() => getFeature(4));
  assert(
    "malformed JSON after the prefix REJECTS (never returns partial garbage)",
    malformed !== null,
    String(malformed?.message ?? malformed).slice(0, 120),
  );
  const prefixOnly = await rejects(() => getFeature(9));
  assert("a prefix-only body (empty JSON) REJECTS", prefixOnly !== null);
  const nf = await rejects(() => getFeature(404));
  assert(
    "non-ok 404 REJECTS with the status in the message — kills a getJson that swallows status",
    nf !== null && /404/.test(String(nf.message)),
    String(nf?.message).slice(0, 120),
  );
  const srv = await rejects(() => getFeature(500));
  assert(
    "non-ok 500 REJECTS with the status in the message",
    srv !== null && /500/.test(String(srv.message)),
  );

  // --- cache: hit within TTL, expiry across it, per-path isolation ----------------------
  const c1R = await settled(() => getFeature(7));
  const c2R = await settled(() => getFeature(7));
  assert(
    "second call within TTL is a CACHE HIT (stub saw exactly one request)",
    c1R.ok && c2R.ok && c1R.value.name === "Cached" && reqCount.get("/features/7") === 1,
    `requests=${reqCount.get("/features/7")}${
      c1R.ok ? "" : ` err=${String(c1R.err?.message).slice(0, 80)}`
    }`,
  );
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 301_000; // TTL_MS is 300_000: cross the boundary
    const expired = await settled(() => getFeature(7));
    assert(
      "call past the TTL REFETCHES (a cache that never expires fails here)",
      expired.ok && reqCount.get("/features/7") === 2,
      `requests=${reqCount.get("/features/7")}`,
    );
    const fresh = await settled(() => getFeature(7));
    assert(
      "immediately after the refetch the entry is fresh again (hit)",
      fresh.ok && reqCount.get("/features/7") === 2,
      `requests=${reqCount.get("/features/7")}`,
    );
  } finally {
    Date.now = realNow;
  }
  await settled(() => getFeature(71));
  await settled(() => getFeature(72));
  await settled(() => getFeature(71));
  assert(
    "cache is keyed PER PATH (71 cached, 72 separate) — a single-slot cache fails here",
    reqCount.get("/features/71") === 1 && reqCount.get("/features/72") === 1,
    `71=${reqCount.get("/features/71")} 72=${reqCount.get("/features/72")}`,
  );

  // --- getMilestoneFeatures: grouping, empty-drop, order, total -------------------------
  const mR = await settled(() => getMilestoneFeatures(111));
  const m = mR.ok ? mR.value : null;
  assert(
    "grouping drops EMPTY categories, keeps order, and total counts FEATURES not groups",
    !!m && m.milestone === 111 && m.groups.length === 2 &&
      m.groups[0].category === "Enabled by default" && m.groups[0].features.length === 2 &&
      m.groups[1].category === "Deprecated" && m.total === 3,
    m
      ? JSON.stringify({
        groups: m.groups.map((g) => [g.category, g.features.length]),
        total: m.total,
      })
      : String(mR.err?.message ?? mR.err).slice(0, 120),
  );
  const m2R = await settled(() => getMilestoneFeatures(112));
  const m2 = m2R.ok ? m2R.value : null;
  assert(
    "an all-empty milestone yields zero groups and total 0 (not a phantom empty group)",
    !!m2 && m2.groups.length === 0 && m2.total === 0 && m2.milestone === 112,
  );

  // --- slugify: canonical-route naming ---------------------------------------------------
  const CASES = [
    ["Café Déjà—Vu API?!", "cafe-deja-vu-api"], // NFD accent folding + em dash + punctuation
    ["  --Hello   World-- ", "hello-world"], // edge + repeated separators collapse and strip
    ["foo_bar.baz", "foo-bar-baz"], // underscore/dot are separators
    ["A  B?? C", "a-b-c"], // runs collapse — kills a per-char dash mapping
    ["WebGPU  Subgroup Size CONTROL!", "webgpu-subgroup-size-control"], // lowercasing
    ["???", ""], // nothing slug-worthy
    ["a".repeat(79) + " " + "bbbbb", "a".repeat(79) + "-"], // 80-cap AFTER strip: may end in "-"
  ];
  for (const [input, expected] of CASES) {
    const got = slugify(input);
    assert(
      `slugify(${JSON.stringify(input.slice(0, 30))}${input.length > 30 ? "…" : ""})`,
      got === expected,
      got === expected
        ? expected
        : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
    );
  }
  assert(
    "the 80-char cap truncates AFTER edge-stripping (truncates before strip would differ)",
    slugify("a".repeat(79) + " bbbbb").length === 80,
  );
  assert(
    "listing-vs-detail parity: formatting variants of one name converge on ONE canonical slug",
    slugify("WebGPU  Subgroup Size CONTROL!") === slugify("webgpu subgroup size control") &&
      slugify(" WebGPU Subgroup Size Control ") === slugify("webgpu-subgroup-size-control"),
  );

  // --- parity with .claude/fix-slugs.py (the folder-renaming script) ----------------------
  const PARITY_INPUTS = CASES.map(([input]) => input).concat([
    "ÁBÇ 123",
    "feature — with — dashes",
    "b\u20D0c", // KNOWN DIVERGENCE input, handled separately below
  ]);
  const TS_RESULTS = PARITY_INPUTS.map((s) => slugify(s));
  const DIVERGENCE_INDEX = PARITY_INPUTS.indexOf("b\u20D0c");
  let pyResults = null;
  try {
    const py = new Deno.Command("python3", {
      args: [
        "-c",
        `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("fixslugs", ".claude/fix-slugs.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps([m.slugify(n) for n in json.loads(sys.argv[1])]))`,
        JSON.stringify(PARITY_INPUTS),
      ],
      cwd: REPO,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await py.output();
    if (out.code === 0) pyResults = JSON.parse(new TextDecoder().decode(out.stdout));
  } catch {
    // python3 unavailable — embedded fallback below
  }
  if (!pyResults) {
    // Generated from .claude/fix-slugs.py slugify on 2026-10-06 (python3 absent at run time).
    pyResults = [
      "cafe-deja-vu-api",
      "hello-world",
      "foo-bar-baz",
      "a-b-c",
      "webgpu-subgroup-size-control",
      "",
      "a".repeat(79) + "-",
      "abc-123",
      "feature-with-dashes",
      "bc", // the divergence: python drops U+20D0 (non-zero combining class), TS dashes it
    ];
  }
  let parityOk = true;
  let divergenceOk = false;
  const mismatches = [];
  for (let i = 0; i < PARITY_INPUTS.length; i++) {
    if (i === DIVERGENCE_INDEX) {
      // PINNED KNOWN DIVERGENCE: TS keeps non-U+0300-036F combining marks as dashes; python
      // drops them by combining class. Both outputs are asserted AS-IS — "fixing" either side
      // renames published routes, which the bead forbids. Reported on gendn-14o instead.
      //
      // MEASURED BOUNDARY (gendn-puw, corrected in review round two, 2026-10-06 — the first
      // version claimed EXACTLY and U+034F falsified it; re-swept and re-verified on both
      // sides. Full input table and reproduction on the bead; this comment is the durable
      // referent.)
      // MECHANISM: TS strips a CODEPOINT RANGE (U+0300-U+036F, any combining class) after
      //   NFD; python strips by COMBINING CLASS (non-zero, any codepoint) after NFD. The
      //   divergence set is the SYMMETRIC DIFFERENCE of the two removal sets, surfacing only
      //   when such a character sits BETWEEN two [a-z0-9] characters (position rule: at
      //   string edges or adjacent to a non-alnum the outputs converge, because TS's
      //   dash-run collapse + edge-strip absorbs what python simply deletes).
      // RULE — divergence occurs exactly for characters whose NFD expansion contains a
      //   character in exactly ONE of the two removal sets:
      //   (a) 811 non-zero-class combining marks OUTSIDE U+0300-U+036F (e.g. U+20D0,
      //       U+0483): python drops (joins the neighbours), TS dashes — py "bc" vs ts "b-c".
      //   (b) 3 class-0 codepoints whose NFD yields only out-of-block non-zero-class marks —
      //       U+0F73, U+0F75, U+0F81 (Tibetan vowel signs): same polarity as (a). Class-0
      //       decomposables leaving an out-of-block class-0 residue (U+0F76, U+0F78) AGREE
      //       (residue dashes on both sides); the ~700 precomposed Latin/Greek/Cyrillic
      //       letters decompose into in-block marks both sides strip: AGREE.
      //   (c) 1 class-0 codepoint INSIDE U+0300-U+036F — U+034F COMBINING GRAPHEME JOINER:
      //       TS's range strips it (joins), python's class filter keeps it (dashes) —
      //       OPPOSITE polarity: py "b-c" vs ts "bc".
      //   Measured totals: 815 medial divergences (811 + 3 + 1) over the swept sets — all
      //   922 non-zero-class codepoints, the whole U+0300-U+036F block, and every class-0
      //   codepoint that NFD-decomposes into marks; ZERO leading/trailing divergences.
      // ROUTE CONSEQUENCE today: NONE — 0 divergences over all 201 published slugs. The
      //   class only bites at creation of a future listing name carrying such a character
      //   between alnums: fix-slugs (python) and TS consumers would derive different slugs —
      //   a loud gate mismatch, not a silent rename of anything published.
      // ACCIDENTAL AGREEMENTS + GROWTH ASYMMETRY: edge-mark agreement rides on TS's edge
      //   dash-strip; the strip-then-truncate ORDER matches only because both sides
      //   independently chose it (each now fixture-pinned); python's class-based set tracks
      //   its Unicode DB while the TS range is frozen, so category (a) widens silently with
      //   each Unicode version — and NOTHING currently detects that widening (this pin holds
      //   one codepoint and the parity table is fixed-input).
      divergenceOk = TS_RESULTS[i] === "b-c" && pyResults[i] === "bc";
      continue;
    }
    if (TS_RESULTS[i] !== pyResults[i]) {
      parityOk = false;
      mismatches.push(
        `${JSON.stringify(PARITY_INPUTS[i])}: ts=${JSON.stringify(TS_RESULTS[i])} py=${
          JSON.stringify(pyResults[i])
        }`,
      );
    }
  }
  assert(
    "slugify parity with .claude/fix-slugs.py across the shared table (canonical-route naming must not drift)",
    parityOk,
    mismatches.join(" | ") || `${PARITY_INPUTS.length - 1} input(s) identical`,
  );
  assert(
    "ONE REPRESENTATIVE divergence of the measured three-category class is pinned as-is on both sides (the class includes in-block U+034F with opposite polarity — see MEASURED BOUNDARY)",
    divergenceOk,
    `ts=${JSON.stringify(TS_RESULTS[DIVERGENCE_INDEX])} py=${
      JSON.stringify(pyResults[DIVERGENCE_INDEX])
    }`,
  );
} finally {
  try {
    await server.shutdown();
  } catch {
    // ignore
  }
}

// ---------- growth-asymmetry tripwire (gendn-cps) -------------------------------------------
// The divergence class documented at the pin above GROWS SILENTLY: python's drop-set follows
// its Unicode database (any codepoint with class != 0) while the TS strip range is frozen at
// U+0300-U+036F, so each new out-of-block mark widens the class without either file changing
// — and a single-codepoint pin plus a fixed parity table cannot notice. This tripwire turns
// the documented class into a DETECTED one: both slugifies are recomputed over boundary
// codepoints and must produce the measured DIVERGENT pair. If either side is ever harmonised
// ("fixed" toward the other), the pair collapses to agreement and this assertion fails — the
// route-surface decision is forced into the open instead of drifting. Table spans BOTH
// polarities of the measured boundary (gendn-puw, sweep of 922 marks + block + decomposables):
//   U+0483 / U+20D0 / U+FE20 — out-of-block class != 0: python drops (joins), TS dashes.
//   U+034F — in-block COMBINING GRAPHEME JOINER, class 0: TS's range strips (joins),
//            python's class filter keeps (dashes) — the opposite polarity.
// A Unicode DB reclassification of any of these (e.g. a class change for U+034F) ALSO trips
// this — correctly: the measured boundary moved, so the pin's comment and the route analysis
// must be re-derived, not silently trusted.
{
  const TRIPWIRE = [
    { input: "b\u0483c", ts: "b-c", py: "bc" },
    { input: "b\u20D0c", ts: "b-c", py: "bc" },
    { input: "b\uFE20c", ts: "b-c", py: "bc" },
    { input: "b\u034Fc", ts: "bc", py: "b-c" },
  ];
  let pyTw = null;
  try {
    const py = new Deno.Command("python3", {
      args: [
        "-c",
        `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("fixslugs", ".claude/fix-slugs.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps([m.slugify(n) for n in json.loads(sys.argv[1])]))`,
        JSON.stringify(TRIPWIRE.map((t) => t.input)),
      ],
      cwd: REPO,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await py.output();
    if (out.code === 0) pyTw = JSON.parse(new TextDecoder().decode(out.stdout));
  } catch {
    // python3 unavailable — embedded fallback below
  }
  if (!pyTw) {
    // Generated from .claude/fix-slugs.py slugify on 2026-10-06 (python3 absent at run time).
    // The live path requires python3 on PATH; this fallback is a FROZEN SNAPSHOT, so a run
    // without the interpreter proves less than it looks like it proves — it can miss
    // python-only drift in .claude/fix-slugs.py made after the snapshot date.
    pyTw = ["bc", "bc", "bc", "b-c"];
  }
  const broken = TRIPWIRE.map((t, i) => {
    const problems = [];
    const ts = slugify(t.input);
    if (ts !== t.ts) problems.push(`ts=${JSON.stringify(ts)} expected ${JSON.stringify(t.ts)}`);
    if (pyTw[i] !== t.py) {
      problems.push(`py=${JSON.stringify(pyTw[i])} expected ${JSON.stringify(t.py)}`);
    }
    return problems.length ? `${JSON.stringify(t.input)}: ${problems.join("; ")}` : null;
  }).filter(Boolean);
  assert(
    "divergence tripwire: the four boundary codepoints still produce the measured DIVERGENT pair in both slugifies — agreement on any of them means one side was harmonised (a silent route-rename surface) or the Unicode DB moved the boundary",
    broken.length === 0,
    broken.join(" | ") || "4/4 boundary codepoints diverge as measured (both polarities)",
  );
}

if (failures > 0) {
  console.error(`chromestatus-units.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`chromestatus-units fixture: all ${passed} assertions passed`);
