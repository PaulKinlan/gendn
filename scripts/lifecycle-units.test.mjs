// @fixture-permissions --allow-read --allow-write --allow-run=deno
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
// gendn-xt9 ADDED the site-local pins further down, because the aggregate "hostile fields appear
// ESCAPED" assertion is a PRESENCE check: the escaped payload is present from ANY hostile field, so
// a site interpolating raw at its own site can satisfy it (the name overstates what it asserts -
// the less urgent and MORE dangerous of the two weak-check shapes). Proofs for the additions, each
// mutation restored to green with an empty module diff: dropping esc() at the describe, category,
// kind, deviceClass or reason site FAILS that site's own row pin (and the aggregate net, which
// names only the suite) - never a neighbouring row; and a VALID prefix-style whitelist, which keeps
// every older assertion green, FAILS the s-status row pin plus gendn-imh's two count canaries.
// ONE CORRECTION FOUND BY RUNNING IT, not reading it: my first draft of the s-status pin also
// asserted "no raw payload anywhere in the suite", so every unrelated site mutation tripped it - a
// site pin failing for reasons outside its site is the same mislabelling defect this bead is about,
// one level up. It is now the s-status ROW alone, and the suite-wide check is a separate assertion
// whose name says AGGREGATE.
//
// Run: deno task test-fixtures --tasks test-lifecycle-units

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
// gendn-xt9 site-local payload: a DIFFERENT literal from EVIL so a site pin can never be satisfied
// by an escaped form that leaked in from the other fixtures.
const SITE = `<script>alert(7)</script>`;
const EVIL_ATTR = `"><script>alert(9)</script>`;
// gendn-imh: a status that a PREFIX-style whitelist would wave through. The value never reaches
// markup (only the whitelisted state does), so the only way to tell an exact whitelist from a
// startsWith one is which STATE the row gets - hence the count-based canaries below.
const PREFIX_VERDICT = `pass${EVIL_ATTR}`;

await Deno.mkdir(`${tmp}/v900/evil`, { recursive: true });
await Deno.writeTextFile(
  `${tmp}/v900/evil/conformance.json`,
  j({
    id: "v900/evil",
    route: "javascript:alert(4)//",
    identity: `1234${EVIL}`,
    milestone: 900,
    status: `built${EVIL}`,
    demo: null,
    cpsFeature: {
      host: `chrome-platform-showcase.paulkinlan-ea.deno.net.evil.test`,
      route: "/x/",
      conformanceRoute: "/v900/evil/conformance",
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
      { id: "a-prefix", category: "c", describe: "d", kind: "k", deviceClass: "both" },
      { id: "a-skipped", category: "c", describe: "d", kind: "k", deviceClass: "both" },
    ],
  }),
);
await Deno.writeTextFile(
  `${tmp}/v900/evil/_questions.json`,
  j({
    id: `v900/evil${EVIL}`,
    route: `//evil.test/${EVIL_ATTR}`,
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
    cpsFeature: {
      host: "chrome-platform-showcase.paulkinlan-ea.deno.net",
      route: "/v900/ok/",
      conformanceRoute: "/v900/ok/conformance",
      note: "verified",
    },
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
// gendn-i3yx: unverified CPS contracts must be plain text, never a fabricated href.
await Deno.mkdir(`${tmp}/v900/unverified`, { recursive: true });
await Deno.writeTextFile(
  `${tmp}/v900/unverified/conformance.json`,
  j({
    id: "v900/unverified",
    route: "/v900/unverified/",
    identity: "4321",
    milestone: 900,
    status: "stub",
    demo: "https://chrome-platform-showcase.paulkinlan-ea.deno.net/v900/unverified/concept/",
    cpsFeature: {
      host: "chrome-platform-showcase.paulkinlan-ea.deno.net",
      route: "/v900/unverified/concept/",
      conformanceRoute: null,
      note: "No same-feature suite was verified.",
    },
    suiteHash: "ab".repeat(32),
    generatedAt: "2026-01-01",
    author: "gendn",
    assertions: [{ id: "a", category: "c", describe: "d", kind: "k", deviceClass: "both" }],
  }),
);
// gendn-xt9: SITE-LOCAL rows. Each row is hostile in exactly ONE field, so the escaped literal
// can only have come from that site, and each pin hardcodes the ENTIRE row markup (never esc(),
// which would just assert the function agrees with itself). A leak at one site therefore fails
// that row's pin and nothing else - unlike the presence check below, whose name ("appear ESCAPED")
// overstates it, because any OTHER field's escaped form satisfies it.
await Deno.mkdir(`${tmp}/v900/sites`, { recursive: true });
await Deno.writeTextFile(
  `${tmp}/v900/sites/conformance.json`,
  j({
    id: "v900/sites",
    route: "/v900/sites/",
    identity: "900",
    milestone: 900,
    status: "built",
    demo: null,
    cpsFeature: null,
    suiteHash: "ef".repeat(32),
    generatedAt: "2026-01-01",
    author: "gendn",
    assertions: [
      { id: "s-describe", describe: SITE, category: "C", kind: "K", deviceClass: "B" },
      { id: "s-category", describe: "D", category: SITE, kind: "K", deviceClass: "B" },
      { id: "s-kind", describe: "D", category: "C", kind: SITE, deviceClass: "B" },
      { id: "s-device", describe: "D", category: "C", kind: "K", deviceClass: SITE },
      { id: "s-reason", describe: "D", category: "C", kind: "K", deviceClass: "B" },
      { id: "s-status", describe: "D", category: "C", kind: "K", deviceClass: "B" },
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
          { id: "a-prefix", status: PREFIX_VERDICT },
          { id: "a-skipped", status: "skipped" },
        ],
      },
      {
        id: "v900/sites",
        results: [
          { id: "s-describe", status: "pass" },
          { id: "s-category", status: "pass" },
          { id: "s-kind", status: "pass" },
          { id: "s-device", status: "pass" },
          { id: "s-reason", status: "blocked", reason: SITE },
          { id: "s-status", status: `pass${EVIL_ATTR}` },
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
  suiteUnverified: await renderSuite("v900", "unverified"),
  suiteSites: await renderSuite("v900", "sites"),
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

// ---------- gendn-xt9: SITE-LOCAL escaping pins ----------------------------------------------
// The aggregate assertion above ("hostile fields appear ESCAPED") is a PRESENCE check whose name
// overstates it: the escaped form of the payload is present in the render from ANY hostile field,
// so a specific site interpolating RAW at its own site can still satisfy it (the leak would be
// caught by the "no raw <script>" guard, but that guard cannot say WHICH field). A check that can
// fail without asserting the thing it names is the shape this bead closes. Below, each row of the
// v900/sites suite is hostile in exactly ONE field and the pin hardcodes the ROW'S ENTIRE MARKUP,
// so a leak localises to one failing assertion - and the expected bytes are literals, never esc(),
// which would only assert that the function agrees with itself.
assert(
  "site s-describe: escaped at its OWN <td>, and the rest of the row byte-exact",
  R.suiteSites.includes(
    `<tr><td><code>s-describe</code></td><td>&lt;script&gt;alert(7)&lt;/script&gt;</td><td><span class="tag">C</span></td><td>K</td><td>B</td><td><span class="v v-pass">pass</span></td></tr>`,
  ),
);
assert(
  'site s-category: escaped inside its OWN <span class="tag">',
  R.suiteSites.includes(
    `<tr><td><code>s-category</code></td><td>D</td><td><span class="tag">&lt;script&gt;alert(7)&lt;/script&gt;</span></td><td>K</td><td>B</td><td><span class="v v-pass">pass</span></td></tr>`,
  ),
);
assert(
  "site s-kind: escaped in its OWN bare <td>",
  R.suiteSites.includes(
    `<tr><td><code>s-kind</code></td><td>D</td><td><span class="tag">C</span></td><td>&lt;script&gt;alert(7)&lt;/script&gt;</td><td>B</td><td><span class="v v-pass">pass</span></td></tr>`,
  ),
);
assert(
  "site s-device: escaped in the deviceClass cell, not the kind cell beside it",
  R.suiteSites.includes(
    `<tr><td><code>s-device</code></td><td>D</td><td><span class="tag">C</span></td><td>K</td><td>&lt;script&gt;alert(7)&lt;/script&gt;</td><td><span class="v v-pass">pass</span></td></tr>`,
  ),
);
assert(
  'site s-reason: escaped inside its OWN <div class="meta">',
  R.suiteSites.includes(
    `<tr><td><code>s-reason</code></td><td>D</td><td><span class="tag">C</span></td><td>K</td><td>B</td><td><span class="v v-blocked">blocked</span><div class="meta">&lt;script&gt;alert(7)&lt;/script&gt;</div></td></tr>`,
  ),
);
// SHAPE 1 (audit's stronger whitelist canary): a status of `pass"><script>…` must land as n/a.
// Also SITE-LOCAL: the assertion is the s-status ROW, so a mutation at any OTHER site cannot make
// it fail (my first draft also checked the whole suite here, which meant every unrelated leak
// tripped it - a site pin that fails for reasons outside its site is the same mislabelling defect
// this bead is about, one level up). This kills a startsWith-style whitelist, which a count-based
// canary alone cannot: the widening renders the row as PASS-styled while the suite stays green.
assert(
  "site s-status: an attribute-breakout status renders v-n/a in its OWN row",
  R.suiteSites.includes(
    `<tr><td><code>s-status</code></td><td>D</td><td><span class="tag">C</span></td><td>K</td><td>B</td><td><span class="v v-n/a">n/a</span></td></tr>`,
  ),
);
// The belt-and-braces net, named as an AGGREGATE so nobody reads it as site-local: it can only
// say "somewhere in this suite", never which site - that is what the five row pins above are for.
assert(
  "AGGREGATE (not site-local): no raw hostile payload survives anywhere in the site suite",
  !R.suiteSites.includes(SITE) && !R.suiteSites.includes("<script>alert(9)"),
);

// ---------- missing-artifact contracts -------------------------------------------------------
assert(
  "renderSuite: missing conformance.json returns null (documented absent state)",
  R.suiteMissing === null,
);
assert("renderCritique: missing _questions.json returns null", R.critiqueMissing === null);
assert(
  "unverified CPS contract has honest explanatory text and no fabricated link",
  R.suiteUnverified.includes("No independently verified same-feature") &&
    !R.suiteUnverified.includes("/null") &&
    !R.suiteUnverified.includes("/undefined") &&
    !R.suiteUnverified.includes('href="https://chrome-platform-showcase.paulkinlan-ea.deno.net'),
);
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
// gendn-b2s review finding 2: the lifecycle seam's BEHAVIOUR with the hostile identity — a
// source-presence check is a proxy; this asserts on the rendered index HTML itself. The narrow's
// null fallback must keep the hostile identity out of every href, while a benign STRING identity
// still links canonically (the fallback is not universal — non-vacuity).
assert(
  "b2s seam (conformance index): the hostile suite identity produces NO chromestatus href in any form (raw or encoded)",
  !R.index.includes("feature/1234&lt;") && !R.index.includes("feature/1234<"),
);
assert(
  "b2s seam (conformance index): a benign STRING identity ('4321') renders the canonical link — the narrow accepts real ids through the string path",
  R.index.includes('href="https://chromestatus.com/feature/4321"'),
);

// ---------- link narrowing: malicious artifacts degrade to text, valid routes still link ------
assert(
  "hostile suite route is plain text in the index, never a navigable javascript: href",
  R.index.includes("v900/evil</td>") && !R.index.includes('href="javascript:') &&
    R.index.includes('href="/v900/ok/conformance"'),
);
assert(
  "hostile suite route is plain text in both crumbs; benign suite retains both links",
  R.suiteEvil.includes("&larr; v900/evil") && !R.suiteEvil.includes('href="javascript:') &&
    R.suiteEvil.includes(" &middot; critique &middot; ") &&
    R.suiteOk.includes('href="/v900/ok/"') &&
    R.suiteOk.includes('href="/v900/ok/critique"'),
);
assert(
  "protocol-relative critique route is plain text in both crumbs",
  R.critiqueEvil.includes("&larr; v900/evil") &&
    !R.critiqueEvil.includes('href="//evil.test') &&
    R.critiqueEvil.includes(" &middot; conformance</p>"),
);
assert(
  "hostile CPS host is plain text despite a plausible path; verified host retains its link",
  R.suiteEvil.includes("/v900/evil/conformance (referenced, not forked)") &&
    !R.suiteEvil.includes('href="https://chrome-platform-showcase.') &&
    R.suiteOk.includes(
      'href="https://chrome-platform-showcase.paulkinlan-ea.deno.net/v900/ok/conformance"',
    ),
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
// gendn-imh: the whitelist must be EXACT, not prefix-style. A startsWith-shaped whitelist keeps all
// three real verdicts working (so every assertion above still passes) and additionally waves through
// `pass"><script>…`, restoring the attribute-injection hole the lny fix closed - with the suite green.
// The row's STATE is the only thing that differs, so these two canaries count states rather than
// looking for the payload text (which never reaches markup either way).
const passRows = (R.suiteEvil.match(/class="v v-pass">pass</g) ?? []).length;
const naRows = (R.suiteEvil.match(/class="v v-n\/a">n\/a</g) ?? []).length;
assert(
  "the verdict whitelist is EXACT: a status with a valid PREFIX and a hostile suffix must NOT be styled as its prefix (exactly one pass-styled row, from the genuine pass)",
  passRows === 1,
  `${passRows} pass-styled row(s) in the hostile suite`,
);
assert(
  "an unknown-but-BENIGN status (skipped) renders the fallback itself: exactly four n/a rows (hostile, weird, prefix-hostile, skipped) and no unrecognised status text echoed",
  naRows === 4 && !R.suiteEvil.includes(">skipped<") &&
    !R.suiteEvil.includes("weird-unknown-status"),
  `${naRows} n/a row(s)`,
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
// 4 = v900/evil + v900/ok + v900/sites + v900/unverified (gendn-i3yx null CPS fixture).
assert("index counts every suite in the catalogue", R.index.includes("4 suites"));
assert(
  "suite page carries the hash prefix and author",
  R.suiteOk.includes("cdcdcdcdcdcdcdcd") && R.suiteOk.includes("gendn"),
);
assert(
  "cpsFeature block renders only when present",
  R.suiteEvil.includes("Chrome-platform-showcase conformance (listed assertions only):") &&
    R.suiteOk.includes("chrome-platform-showcase.paulkinlan-ea.deno.net"),
);
assert(
  "CPS contract copy does not claim every linked demo is embedded",
  R.suiteEvil.includes("Chrome-platform-showcase conformance (listed assertions only):") &&
    !R.suiteEvil.includes("Embedded demo behavior governed"),
);

await Deno.remove(tmp, { recursive: true }).catch(() => {});
await Deno.remove(tmp2, { recursive: true }).catch(() => {});

if (failures > 0) {
  console.error(`lifecycle-units.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`lifecycle-units fixture: all ${passed} assertions passed`);
