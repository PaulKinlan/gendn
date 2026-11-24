// scripts/doc-tests.test.mjs — browser-free deterministic unit fixture for Tier 1
// (scripts/doc-tests.mjs) and Tier 2 (scripts/doc-drift.mjs).
//
// Tests both positive (valid docs pass) and negative (real syntax errors, missing contract
// symbols, shipped-after-trial drift, stale experimental docs, and MDN graduation) cases.
//
// Run: node scripts/doc-tests.test.mjs

import * as fs from "node:fs";
import * as path from "node:path";
import * as sys from "./lib/sys.mjs";
import {
  checkContractCoverage,
  classifySnippet,
  decodeHtmlEntities,
  extractCodeBlocks,
  runDocTests,
  validateCssSnippet,
  validateJsSnippet,
} from "./doc-tests.mjs";
import {
  deriveCandidateMdnPaths,
  detectMdnGraduation,
  detectStatusDrift,
  formatMarkdownReport,
  loadCurrentStable,
  loadDataIndex,
} from "./doc-drift.mjs";

let passed = 0;
let failures = 0;

function assert(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS: ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// ---------- 1. extractCodeBlocks + entity decoding ----------

{
  const html = [
    "<!doctype html>",
    '<pre><code data-doc-test="js">const ok = a &lt; b &amp;&amp; c &gt; 0;\nconst s = &quot;hi&quot; + &#39;!&#39; + &rsquo;s&amp;lt;;</code></pre>',
    '<pre class="code-wrap"><code class="language-css"><span class="sel">.card</span> { color: var(--ink); }</code></pre>',
  ].join("\n");

  const blocks = extractCodeBlocks(html);
  assert("extractCodeBlocks: finds both <pre><code> blocks", blocks.length === 2);
  assert(
    "extractCodeBlocks: records 1-based line numbers",
    blocks[0]?.line === 2 && blocks[1]?.line === 4,
    `lines=${blocks.map((b) => b.line).join(",")}`,
  );
  assert(
    "extractCodeBlocks: preserves data-doc-test and class attributes",
    blocks[0]?.docTest === "js" && blocks[1]?.className === "language-css",
  );
  assert(
    "extractCodeBlocks: decodes entities and decodes &amp; last (no double-unescape)",
    blocks[0]?.code === `const ok = a < b && c > 0;\nconst s = "hi" + '!' + 's&lt;;`,
    JSON.stringify(blocks[0]?.code),
  );
  assert(
    "extractCodeBlocks: strips inline <span> tags inside <code>",
    blocks[1]?.code === ".card { color: var(--ink); }",
    JSON.stringify(blocks[1]?.code),
  );
  assert(
    "decodeHtmlEntities: decodes numeric decimal and hex entities",
    decodeHtmlEntities("&#65;&#x42;&mdash;") === "AB—",
  );
}

// ---------- 2. classifySnippet ----------

{
  assert(
    "classifySnippet: respects explicit data-doc-test='js'",
    classifySnippet("not obviously js", { docTest: "js" }) === "js",
  );
  assert(
    "classifySnippet: respects explicit string attr 'runtime'",
    classifySnippet("window.x = 1;", "runtime") === "runtime",
  );
  assert(
    "classifySnippet: respects explicit data-doc-test='skip'",
    classifySnippet("const x = 1;", 'data-doc-test="skip"') === "skip",
  );
  assert(
    "classifySnippet: classifies WebIDL interface/partial/dictionary as idl",
    classifySnippet("partial interface Navigator {\n  readonly attribute boolean ok;\n};") ===
      "idl",
  );
  assert(
    "classifySnippet: classifies WebIDL union-arg operation as idl",
    classifySnippet(
      "undefined addEventListener(DOMString type, EventListener? cb, optional (AddEventListenerOptions or boolean) opts = {});",
    ) === "idl",
  );
  assert(
    "classifySnippet: classifies HTTP response/headers as http",
    classifySnippet("HTTP/1.1 200 OK\nPermissions-Policy: focus-without-user-activation=()") ===
      "http",
  );
  assert(
    "classifySnippet: classifies HTML markup as html",
    classifySnippet('<install manifest="https://app.example/manifest.json"></install>') === "html",
  );
  assert(
    "classifySnippet: classifies CSS with var(--custom) as css (not JS var!)",
    classifySnippet(
      ".badge {\n  background-color: var(--bg);\n  color: contrast-color(var(--bg));\n}",
    ) ===
      "css",
  );
  assert(
    "classifySnippet: classifies CLI flag snippet as shell",
    classifySnippet("--enable-blink-features=WindowOpenSplitTab") === "shell",
  );
  assert(
    "classifySnippet: classifies ES module imports as js-module",
    classifySnippet('import { foo } from "./mod.js";\nexport const bar = foo();') === "js-module",
  );
  assert(
    "classifySnippet: classifies classic JS as js",
    classifySnippet(
      "const ctx = new OfflineAudioContext({ numberOfChannels: 2, sampleRate: 48000 });",
    ) ===
      "js",
  );
  assert(
    "classifySnippet: skips unannotated pseudocode with bare '...' placeholder",
    classifySnippet("if (supported) {\n  ...\n}") === "skip",
  );
  assert(
    "classifySnippet: does NOT skip valid JS using rest/spread '...args' or '// ...' comment",
    classifySnippet("const fn = (...args) => {\n  // ...\n  return [...args];\n};") === "js",
  );
  assert(
    "classifySnippet: explicit data-doc-test='js' overrides pseudocode skip",
    classifySnippet("if (supported) {\n  ...\n}", { docTest: "js" }) === "js",
  );
}

// ---------- 3. validateJsSnippet ----------

{
  assert(
    "validateJsSnippet: valid classic JS passes",
    validateJsSnippet("const x = [1, 2, 3].map((n) => n * 2);").ok === true,
  );
  const brokenJs = validateJsSnippet("const x = (1 + 2;");
  assert(
    "validateJsSnippet: real JS syntax error fails with error message",
    brokenJs.ok === false && typeof brokenJs.error === "string" && brokenJs.error.length > 0,
    brokenJs.error ?? "",
  );
  assert(
    "validateJsSnippet: top-level await passes without executing",
    validateJsSnippet("const buf = await ctx.startRendering(48000);\nconsole.log(buf.length);")
      .ok === true,
  );
  const brokenAwait = validateJsSnippet("const buf = await ctx.startRendering((;");
  assert(
    "validateJsSnippet: broken JS with top-level await still fails",
    brokenAwait.ok === false,
    brokenAwait.error ?? "",
  );
  assert(
    "validateJsSnippet: ES module syntax passes with isModule: true",
    validateJsSnippet(
      'import { helper } from "./helper.js";\nexport const out = await helper(42);',
      { isModule: true },
    ).ok === true,
  );
  const brokenMod = validateJsSnippet(
    'import { helper } from "./helper.js";\nexport const out = helper(;',
    { isModule: true },
  );
  assert(
    "validateJsSnippet: broken ES module fails with isModule: true",
    brokenMod.ok === false,
    brokenMod.error ?? "",
  );
}

// ---------- 4. validateCssSnippet ----------

{
  assert(
    "validateCssSnippet: valid CSS with nested at-rule, strings, and comments passes",
    validateCssSnippet(
      `@supports (color: contrast-color(red)) {\n  /* brace in comment: { */\n  .chip::after { content: "}"; color: var(--ink); }\n}`,
    ).ok === true,
  );
  const unclosedBrace = validateCssSnippet(".card {\n  color: red;\n");
  assert(
    "validateCssSnippet: unclosed '{' fails",
    unclosedBrace.ok === false && /Unclosed '\{'/.test(unclosedBrace.error ?? ""),
    unclosedBrace.error ?? "",
  );
  const extraBrace = validateCssSnippet(".card { color: red; }}");
  assert(
    "validateCssSnippet: unexpected closing '}' fails",
    extraBrace.ok === false && /Unexpected closing '\}'/.test(extraBrace.error ?? ""),
    extraBrace.error ?? "",
  );
  const mismatch = validateCssSnippet(".card { width: calc(100% - 1rem]; }");
  assert(
    "validateCssSnippet: mismatched bracket ']' fails",
    mismatch.ok === false && /Mismatched/.test(mismatch.error ?? ""),
    mismatch.error ?? "",
  );
  const unclosedComment = validateCssSnippet("/* forgot to close\n.card { color: red; }");
  assert(
    "validateCssSnippet: unclosed CSS comment fails",
    unclosedComment.ok === false && /Unclosed CSS comment/.test(unclosedComment.error ?? ""),
    unclosedComment.error ?? "",
  );
  const unclosedStr = validateCssSnippet('.card::after { content: "unterminated; }');
  assert(
    "validateCssSnippet: unclosed CSS string fails",
    unclosedStr.ok === false && /Unclosed CSS string/.test(unclosedStr.error ?? ""),
    unclosedStr.error ?? "",
  );
}

// ---------- 5. checkContractCoverage ----------

{
  const contract = {
    inventory: [
      {
        id: "start",
        name: "OfflineAudioContext.startRendering",
        surfaceMarkers: ["startRendering", "chunkSize"],
      },
      { id: "close", name: "OfflineAudioContext.close", surfaceMarkers: ["ctx.close"] },
    ],
  };
  const goodHtml =
    "<main><p>Call <code>startRendering(chunkSize)</code> and then <code>ctx.close()</code>.</p></main>";
  const goodCov = checkContractCoverage(goodHtml, contract);
  assert(
    "checkContractCoverage: passes when all surfaceMarkers appear in HTML",
    goodCov.ok === true && goodCov.checked === 3 && goodCov.missing.length === 0,
  );

  const missingHtml = "<main><p>Call <code>startRendering()</code> only.</p></main>";
  const badCov = checkContractCoverage(missingHtml, contract);
  assert(
    "checkContractCoverage: detects missing surfaceMarkers",
    badCov.ok === false && badCov.missing.length === 2 &&
      badCov.missing.some((m) => m.marker === "chunkSize") &&
      badCov.missing.some((m) => m.marker === "ctx.close"),
    JSON.stringify(badCov.missing),
  );

  const splitTreeCov = checkContractCoverage(
    [
      "<main><code>startRendering(chunkSize)</code></main>",
      "<main><code>ctx.close()</code></main>",
    ],
    contract,
  );
  assert(
    "checkContractCoverage: supports multi-page HTML array (overview + child routes)",
    splitTreeCov.ok === true && splitTreeCov.checked === 3,
  );
}

// ---------- 6. Tier 1 end-to-end on temp page tree ----------

{
  const tmp = await sys.makeTempDir({ prefix: "doc-tests-fixture-" });
  try {
    const goodDir = path.join(tmp, "v160", "good-feature");
    const badDir = path.join(tmp, "v160", "bad-feature");
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(badDir, { recursive: true });

    fs.writeFileSync(
      path.join(goodDir, "index.html"),
      `<!doctype html><main><pre><code data-doc-test="js">const r = await Promise.resolve(1);</code></pre></main>`,
    );
    fs.writeFileSync(
      path.join(badDir, "index.html"),
      `<!doctype html><main><pre><code data-doc-test="js">const broken = (1 + ;</code></pre></main>`,
    );

    const goodRun = await runDocTests({ root: tmp, pageIds: ["v160/good-feature"] });
    assert(
      "runDocTests: valid annotated JS page passes",
      goodRun.ok === true && goodRun.summary.passed === 1 && goodRun.failures.length === 0,
    );

    const badRun = await runDocTests({ root: tmp, pageIds: ["v160/bad-feature"] });
    assert(
      "runDocTests: broken explicit data-doc-test='js' fails in default mode",
      badRun.ok === false && badRun.summary.explicitFailed === 1 && badRun.failures.length === 1,
    );
  } finally {
    await sys.remove(tmp, { recursive: true });
  }
}

// ---------- 7. Tier 2 loadDataIndex + detectStatusDrift ----------

{
  const tmpData = await sys.makeTempDir({ prefix: "doc-drift-data-" });
  try {
    fs.writeFileSync(
      path.join(tmpData, "channels.json"),
      JSON.stringify({ stable: { mstone: 159 } }),
    );
    fs.writeFileSync(
      path.join(tmpData, "features-148.json"),
      JSON.stringify({
        features_by_type: {
          "Origin trial": [
            { id: 111111, name: "Trial Feature", is_released: false },
            { id: 222222, name: "Still Trial", is_released: false },
            { id: 333333, name: "Future Ship Feature", is_released: false },
          ],
          "Enabled by default": [
            { id: 444444, name: "Already Shipped", is_released: true },
          ],
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpData, "features-157.json"),
      JSON.stringify({
        features_by_type: {
          "Enabled by default": [
            { id: 111111, name: "Trial Feature", is_released: true },
          ],
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpData, "features-160.json"),
      JSON.stringify({
        features_by_type: {
          "Enabled by default": [
            { id: 333333, name: "Future Ship Feature", is_released: false },
          ],
        },
      }),
    );

    const dataIndex = loadDataIndex(tmpData);
    const stable = loadCurrentStable(tmpData);
    assert("loadCurrentStable: reads stable.mstone from channels.json", stable === 159);
    assert(
      "loadDataIndex: aggregates multi-milestone records sorted ascending",
      dataIndex.get("111111")?.milestones.length === 2 &&
        dataIndex.get("111111")?.milestones[0].milestone === 148 &&
        dataIndex.get("111111")?.milestones[1].milestone === 157,
    );

    const now = new Date("2026-11-24T00:00:00Z");

    // Case A: Origin Trial page whose feature shipped in M157 (<= stable 159) -> shipped-after-trial
    const shippedDrift = detectStatusDrift(
      {
        id: "v148/trial-feature",
        milestone: 148,
        identity: "111111",
        status: "built",
        eyebrow: "v148 · origin trial · experimental",
        assessedAt: "2026-11-01",
      },
      dataIndex,
      { now, maxAgeDays: 90, currentStable: stable },
    );
    assert(
      "detectStatusDrift: Origin Trial -> Enabled by default triggers shipped-after-trial",
      shippedDrift.some((f) => f.kind === "shipped-after-trial" && f.shippedMilestone === 157),
      JSON.stringify(shippedDrift),
    );

    // Case B: Already-shipped page stays clean
    const cleanShipped = detectStatusDrift(
      {
        id: "v148/already-shipped",
        milestone: 148,
        identity: "444444",
        status: "built",
        eyebrow: "v148 · web api · enabled by default",
        assessedAt: "2026-01-01",
      },
      dataIndex,
      { now, maxAgeDays: 90, currentStable: stable },
    );
    assert(
      "detectStatusDrift: already-shipped page stays clean (no trial drift, no stale-experimental)",
      cleanShipped.length === 0,
      JSON.stringify(cleanShipped),
    );

    // Case C: Historical mention ("recently out of origin trial") on shipped page does NOT false-trigger
    const historicalMention = detectStatusDrift(
      {
        id: "v157/trial-feature",
        milestone: 157,
        identity: "111111",
        status: "built",
        eyebrow: "v157 · web api",
        warnText:
          "New API — recently out of origin trial. The API is enabled by default in Chrome 157.",
        assessedAt: "2026-11-01",
      },
      dataIndex,
      { now, maxAgeDays: 90, currentStable: stable },
    );
    assert(
      "detectStatusDrift: shipped page mentioning historical origin trial does NOT trigger shipped-after-trial",
      !historicalMention.some((f) => f.kind === "shipped-after-trial"),
      JSON.stringify(historicalMention),
    );

    // Case D: Trial feature scheduled for M160 (> stable 159) does NOT trigger shipped-after-trial
    const futureShip = detectStatusDrift(
      {
        id: "v148/future-ship",
        milestone: 148,
        identity: "333333",
        status: "built",
        eyebrow: "v148 · origin trial",
        assessedAt: "2026-11-01",
      },
      dataIndex,
      { now, maxAgeDays: 90, currentStable: stable },
    );
    assert(
      "detectStatusDrift: future milestone (> currentStable) does NOT trigger shipped-after-trial",
      !futureShip.some((f) => f.kind === "shipped-after-trial"),
      JSON.stringify(futureShip),
    );

    // Case E: Stale Origin Trial (> 90 days old) triggers stale-experimental
    const staleOt = detectStatusDrift(
      {
        id: "v148/still-trial",
        milestone: 148,
        identity: "222222",
        status: "built",
        eyebrow: "v148 · origin trial",
        reviewedAt: "2026-07-01",
      },
      dataIndex,
      { now, maxAgeDays: 90, currentStable: stable },
    );
    assert(
      "detectStatusDrift: stale OT > maxAgeDays triggers stale-experimental",
      staleOt.some((f) => f.kind === "stale-experimental" && f.ageDays > 90),
      JSON.stringify(staleOt),
    );

    // Case F: Missing ChromeStatus record in a milestone present in _data/
    const missingCs = detectStatusDrift(
      {
        id: "v148/vanished",
        milestone: 148,
        identity: "999999",
        status: "built",
        eyebrow: "v148 · web api · enabled by default",
      },
      dataIndex,
      { now, maxAgeDays: 90, currentStable: stable },
    );
    assert(
      "detectStatusDrift: feature absent from _data/features-148.json triggers missing-chromestatus-record",
      missingCs.some((f) => f.kind === "missing-chromestatus-record"),
      JSON.stringify(missingCs),
    );
  } finally {
    await sys.remove(tmpData, { recursive: true });
  }
}

// ---------- 8. Tier 2 detectMdnGraduation + Markdown formatting ----------

{
  const pages = [
    {
      id: "v158/graduated-api",
      status: "built",
      identity: "5001",
      candidateMdnPaths: ["/en-US/docs/Web/API/GraduatedApi"],
    },
    {
      id: "v158/not-on-mdn",
      status: "built",
      identity: "5002",
      candidateMdnPaths: ["/en-US/docs/Web/API/MissingApi"],
    },
    {
      id: "v158/mdn-timeout",
      status: "built",
      identity: "5003",
      candidateMdnPaths: ["/en-US/docs/Web/API/FlakyApi"],
    },
    {
      id: "v158/already-stub",
      status: "stub",
      identity: "5004",
      candidateMdnPaths: ["/en-US/docs/Web/API/GraduatedApi"],
    },
  ];

  const fakeMdnLookup = async (mdnPath) => {
    if (mdnPath.endsWith("GraduatedApi")) return { kind: "present" };
    if (mdnPath.endsWith("MissingApi")) return { kind: "missing" };
    return { kind: "unknown" };
  };

  const grad = await detectMdnGraduation(pages, fakeMdnLookup);
  assert(
    "detectMdnGraduation: flags ONLY built pages returning { kind: 'present' } (ignores missing, unknown, and stubs)",
    grad.length === 1 && grad[0].id === "v158/graduated-api" &&
      grad[0].kind === "mdn-graduated",
    JSON.stringify(grad),
  );

  const safePaths = deriveCandidateMdnPaths({
    interfaceNames: ["CloseWatcher", "../evil?x=1"],
    cssNames: ["object-fit"],
  });
  assert(
    "deriveCandidateMdnPaths: accepts clean tokens and rejects unsafe path characters",
    safePaths.includes("/en-US/docs/Web/API/CloseWatcher") &&
      safePaths.includes("/en-US/docs/Web/CSS/object-fit") &&
      !safePaths.some((p) => p.includes("evil")),
    JSON.stringify(safePaths),
  );

  const md = formatMarkdownReport({
    generatedAt: "2026-11-24T00:00:00.000Z",
    currentStable: 159,
    maxAgeDays: 90,
    liveMdn: true,
    summary: {
      pagesScanned: 4,
      dataFeaturesIndexed: 10,
      dataMilestones: [158],
      totalFindings: 1,
      byKind: { "mdn-graduated": 1 },
    },
    findings: grad,
  });
  assert(
    "formatMarkdownReport: emits Markdown summary heading and findings table",
    md.includes("## gendn Doc Drift & Staleness Report") && md.includes("v158/graduated-api"),
  );
}

console.log(`\ndoc-tests fixture: ${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
