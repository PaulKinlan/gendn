// scripts/lifecycle-units.test.mjs — direct renderer coverage for lib/lifecycle.ts (gendn-lny).
//
// THE GAP: /conformance, /conformance/run-all, /v<N>/<slug>/conformance and .../critique
// interpolate artifact fields (suite + critique JSON, runner results) into HTML with NO test
// protection: a hostile description/evidence/author/status could inject markup, and a corrupt
// results.json status landed raw in a class ATTRIBUTE — the module's one un-esc()'d
// interpolation. Missing artifacts must yield documented null states, and a blocked/unknown
// verdict must never render as pass.
//
// FOUND AND FIXED WITH THIS FIXTURE (gendn-lny): renderSuite took `v?.status ?? "n/a"` and put
// it into `class="v v-${state}"` UNESCAPED; a results.json status of `"><script>…` escaped the
// attribute. The status is now whitelisted to pass|fail|blocked (anything else renders "n/a"),
// which closes the attribute injection AND enforces "unknown verdict is never a pass" in one
// move. Pinned below; the mutation that reverts the whitelist FAILS this suite.
//
// SHAPE: the renderers read from CWD ("." / relative artifact paths), so each case runs in a
// SUBPROCESS whose cwd is a synthesized temp root — no injectable-root production seam needed,
// no mutation of real pages/reports, no network. The subprocess imports lib/lifecycle.ts by
// absolute path and prints the rendered strings as JSON.
//
// MUTATION PROOFS (logs on the bead, not inline): (1) reverting the verdict whitelist to
// `v?.status ?? "n/a"` FAILS the injection + unknown-verdict pins; (2) dropping esc() from the
// suite author interpolation FAILS the escaping pins. Each restored to green with an empty
// module diff. A suite that has never been shown to fail on a plausible wrong implementation
// is a claim, not a detector.
//
// Run: deno task test-lifecycle-units

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LIB = `file://${REPO}/lib/lifecycle.ts`;

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

// ---------- synthesize a temp catalogue root with hostile + benign artifacts ---------------
const tmp = await Deno.makeTempDir({ prefix: "lifecycle-units-" });
const j = (o) => JSON.stringify(o, null, 1);

const EVIL = `<script>alert(1)</script>`;
const EVIL_ATTR = `"><script>alert(9)</script>`;

await Deno.mkdir(`${tmp}/v900/evil`, { recursive: true });
await Deno.writeTextFile(
  `${tmp}/v900/evil/conformance.json`,
  j({
    id: "v900/evil",
    route: "/v900/evil/",
    identity: `1234${EVIL}`,
    milestone: 900,
    status: `built${EVIL}`,
    demo: null,
    cpsFeature: {
      host: `showcase.test${EVIL_ATTR}`,
      route: "/x/",
      conformanceRoute: `/x/conformance/${EVIL}`,
      note: "n",
    },
    suiteHash: "ab".repeat(32),
    generatedAt: "2026-01-01",
    author: `gendn${EVIL}`,
    assertions: [
      {
        id: "a-pass",
        category: `cat${EVIL}`,
        describe: `<img src=x onerror=alert(5)>`,
        kind: "js-eval",
        deviceClass: "both",
      },
      { id: "a-inject", category: "c", describe: "d", kind: "k", deviceClass: "both" },
      {
        id: "a-blocked",
        category: "c",
        describe: "d",
        kind: "manual-evidenced",
        deviceClass: "both",
      },
      { id: "a-unknown", category: "c", describe: "d", kind: "k", deviceClass: "both" },
    ],
  }),
);
await Deno.writeTextFile(
  `${tmp}/v900/evil/_questions.json`,
  j({
    id: `v900/evil${EVIL}`,
    route: `/v900/evil/${EVIL_ATTR}`,
    identity: "1234",
    status: "critiqued",
    revision: 1,
    reviewedAt: `2026-01-01${EVIL}`,
    reviewer: `reviewer${EVIL}`,
    rubric: [{
      dimension: `dim${EVIL}`,
      score: 3,
      severity: `sev${EVIL}`,
      evidence: `ev${EVIL}`,
      notes: `notes${EVIL_ATTR}`,
    }],
    guidanceConsulted: [{
      query: `q${EVIL}`,
      recommendation: `rec${EVIL}`,
      appliedOrException: `applied${EVIL}`,
      evidence: `e${EVIL}`,
    }],
    openQuestions: [`why${EVIL}`],
    followUpGoals: [{ goal: `goal${EVIL}`, kind: `kind${EVIL}`, priority: `p1${EVIL}` }],
    summary: `sum${EVIL}`,
  }),
);
await Deno.mkdir(`${tmp}/v900/ok`, { recursive: true });
await Deno.writeTextFile(
  `${tmp}/v900/ok/conformance.json`,
  j({
    id: "v900/ok",
    route: "/v900/ok/",
    identity: "4321",
    milestone: 900,
    status: "built",
    demo: null,
    cpsFeature: null,
    suiteHash: "cd".repeat(32),
    generatedAt: "2026-01-01",
    author: "gendn",
    assertions: [
      { id: "s-pass", category: "c", describe: "d", kind: "k", deviceClass: "both" },
      { id: "s-fail", category: "c", describe: "d", kind: "k", deviceClass: "both" },
      { id: "s-blocked", category: "c", describe: "d", kind: "k", deviceClass: "both" },
    ],
  }),
);
await Deno.mkdir(`${tmp}/reports/conformance`, { recursive: true });
await Deno.writeTextFile(
  `${tmp}/reports/conformance/results.json`,
  j({
    generatedAt: `2026-01-02T00:00:00Z${EVIL}`,
    suites: [
      {
        id: "v900/evil",
        results: [
          { id: "a-pass", status: "pass" },
          { id: "a-inject", status: EVIL_ATTR },
          { id: "a-blocked", status: "blocked", reason: `manual evidence pending ${EVIL}` },
          { id: "a-unknown", status: "weird-unknown-status" },
        ],
      },
      {
        id: "v900/ok",
        results: [
          { id: "s-pass", status: "pass" },
          { id: "s-fail", status: "fail", reason: "demo route 404" },
          { id: "s-blocked", status: "blocked", reason: "needs a human" },
        ],
      },
    ],
  }),
);
const ROLLUP = `<!doctype html><html><body>ROLLUP-EXACT-CONTENT</body></html>`;
await Deno.writeTextFile(`${tmp}/reports/conformance/index.html`, ROLLUP);

// ---------- render everything in a subprocess whose CWD is the temp root --------------------
const HARNESS = `
import { renderConformanceIndex, renderRunAll, renderSuite, renderCritique } from "${LIB}";
const out = {
  index: await renderConformanceIndex(),
  runAll: await renderRunAll(),
  suiteEvil: await renderSuite("v900", "evil"),
  suiteOk: await renderSuite("v900", "ok"),
  suiteMissing: await renderSuite("v900", "absent"),
  critiqueEvil: await renderCritique("v900", "evil"),
  critiqueMissing: await renderCritique("v900", "absent"),
};
console.log(JSON.stringify(out));
`;
await Deno.writeTextFile(`${tmp}/_harness.ts`, HARNESS);
const proc = await new Deno.Command("deno", {
  args: ["run", "--allow-read", "_harness.ts"],
  cwd: tmp,
  stdout: "piped",
  stderr: "piped",
}).output();
if (proc.code !== 0) {
  console.error(
    `FAIL: render subprocess exited ${proc.code}\n${new TextDecoder().decode(proc.stderr)}`,
  );
  Deno.exit(1);
}
const R = JSON.parse(new TextDecoder().decode(proc.stdout));

// run-all missing case: a second, reports-less root
const tmp2 = await Deno.makeTempDir({ prefix: "lifecycle-units-empty-" });
await Deno.writeTextFile(
  `${tmp2}/_harness.ts`,
  `
import { renderRunAll, renderConformanceIndex } from "${LIB}";
console.log(JSON.stringify({ runAll: await renderRunAll(), index: await renderConformanceIndex() }));
`,
);
const proc2 = await new Deno.Command("deno", {
  args: ["run", "--allow-read", "_harness.ts"],
  cwd: tmp2,
  stdout: "piped",
  stderr: "piped",
}).output();
if (proc2.code !== 0) {
  console.error(
    `FAIL: empty-root subprocess exited ${proc2.code}\n${new TextDecoder().decode(proc2.stderr)}`,
  );
  Deno.exit(1);
}
const R2 = JSON.parse(new TextDecoder().decode(proc2.stdout));

// ---------- missing-artifact contracts -------------------------------------------------------
assert(
  "renderSuite: missing conformance.json returns null (documented absent state)",
  R.suiteMissing === null,
);
assert("renderCritique: missing _questions.json returns null", R.critiqueMissing === null);
assert("renderRunAll: missing reports/conformance/index.html returns null", R2.runAll === null);
assert(
  "renderRunAll: present rollup is passed through BYTE-EXACT (documented trust boundary: the runner-generated report is served as-is, not re-rendered)",
  R.runAll === ROLLUP,
);
assert(
  "renderConformanceIndex: an empty catalogue still renders a well-formed page (0 suites)",
  R2.index.includes("0 suites") && R2.index.includes("<!doctype html>"),
);

// ---------- escaping: hostile artifact fields never reach markup raw --------------------------
const ALL = [R.index, R.suiteEvil, R.critiqueEvil].join("\n");
assert(
  "no raw <script> from ANY hostile field (identity/status/author/category/route/summary/reviewer/rubric/goals)",
  !ALL.includes("<script>alert"),
  "raw script found",
);
assert("no raw attribute-breakout sequence from hostile fields", !ALL.includes(`"><script>`));
assert(
  "hostile fields appear ESCAPED (the content is rendered, inert)",
  R.suiteEvil.includes("&lt;script&gt;alert(1)&lt;/script&gt;") &&
    R.critiqueEvil.includes("&lt;script&gt;"),
);
assert(
  "hostile img/onerror payload escaped in describe",
  R.suiteEvil.includes("&lt;img src=x onerror=alert(5)&gt;") &&
    !R.suiteEvil.includes("<img src=x onerror"),
);
assert(
  "index escapes hostile suite identity",
  R.index.includes("1234&lt;script&gt;") || R.index.includes("#1234&lt;script&gt;"),
);

// ---------- verdicts: the class-attribute injection + whitelist --------------------------------
assert(
  "results.json status CANNOT inject the class attribute (the gendn-lny fix: whitelisted states only; escaped occurrences of the payload text elsewhere are inert and fine)",
  !R.suiteEvil.includes(EVIL_ATTR) && !R.suiteEvil.includes(`<script>alert(9)`),
);
assert(
  "an UNKNOWN verdict status renders as n/a — never borrowing pass/fail/blocked styling",
  R.suiteEvil.includes(`v-n/a">n/a`) && !R.suiteEvil.includes("weird-unknown-status"),
);
assert("pass renders as pass", R.suiteOk.includes(`v-pass">pass`));
assert(
  "fail renders as fail with its reason",
  R.suiteOk.includes(`v-fail">fail`) && R.suiteOk.includes("demo route 404"),
);
assert(
  "blocked renders as BLOCKED (never pass) with its reason escaped",
  R.suiteOk.includes(`v-blocked">blocked`) && R.suiteOk.includes("needs a human") &&
    !R.suiteOk.includes(`v-pass">blocked`),
);
assert(
  "blocked reason with hostile content is escaped, not raw",
  R.suiteEvil.includes("manual evidence pending &lt;script&gt;") &&
    !R.suiteEvil.includes("<script>alert(10)"),
);
assert(
  "results.generatedAt hostile content escaped in the lede",
  R.suiteEvil.includes("2026-01-02T00:00:00Z&lt;script&gt;") &&
    !R.suiteEvil.includes("00:00:00Z<script>"),
);

// ---------- structure sanity -------------------------------------------------------------------
assert("index counts every suite in the catalogue", R.index.includes("2 suites"));
assert(
  "suite page carries the hash prefix and author",
  R.suiteOk.includes("cdcdcdcdcdcdcdcd") && R.suiteOk.includes("gendn"),
);
assert(
  "cpsFeature block renders only when present",
  R.suiteEvil.includes("chrome-platform-showcase") &&
    !R.suiteOk.includes("chrome-platform-showcase"),
);

await Deno.remove(tmp, { recursive: true }).catch(() => {});
await Deno.remove(tmp2, { recursive: true }).catch(() => {});

if (failures > 0) {
  console.error(`lifecycle-units.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`lifecycle-units fixture: all ${passed} assertions passed`);
