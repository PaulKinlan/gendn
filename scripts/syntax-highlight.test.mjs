// scripts/syntax-highlight.test.mjs — unit, security, idempotency, and corpus-fidelity tests
// for lib/syntax-highlight.ts and the subtle syntax-highlighting tokens in public/styles.css.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  decodeCodeEntities,
  detectLanguage,
  highlightCode,
  highlightHtmlDocument,
  stripHighlightSpans,
} from "../lib/syntax-highlight.ts";

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

// 1. Language detection across all supported web-platform code block types
assert(
  "detectLanguage honors explicit data-doc-test attribute",
  detectLanguage("foo()", { dataDocTest: "js" }) === "js" &&
    detectLanguage("foo", { dataDocTest: "idl" }) === "idl" &&
    detectLanguage("foo", { dataDocTest: "css" }) === "css" &&
    detectLanguage("foo", { dataDocTest: "http" }) === "http" &&
    detectLanguage("foo", { dataDocTest: "json" }) === "json" &&
    detectLanguage("foo", { dataDocTest: "shell" }) === "shell",
);

assert(
  "detectLanguage honors language-* CSS class",
  detectLanguage("foo", { className: "language-webidl" }) === "idl" &&
    detectLanguage("foo", { className: "lang-wgsl" }) === "wgsl",
);

assert(
  "detectLanguage auto-detects JS, IDL, HTML, CSS, HTTP, JSON, WGSL, Shell, and Plain",
  detectLanguage('const x = await fetch("/a");') === "js" &&
    detectLanguage(
        "[Exposed=Window]\ninterface Foo : Event {\n  readonly attribute DOMString name;\n};",
      ) ===
      "idl" &&
    detectLanguage('<form autocomplete="on"><input name="x"></form>') === "html" &&
    detectLanguage(".box {\n  display: grid;\n  color: #123456;\n}") === "css" &&
    detectLanguage("HTTP/1.1 200 OK\nAccess-Control-Allow-Origin: *") === "http" &&
    detectLanguage('{"name": "gendn", "count": 42, "ok": true}') === "json" &&
    detectLanguage("fn main(@builtin(global_invocation_index) idx: u32) {}") === "wgsl" &&
    detectLanguage("chrome --enable-blink-features=WebSpeechTimestamps") === "shell" &&
    detectLanguage("No DBSC session\n  ├─ registered → active") === "plain",
);

// 2. Mixed JS + HTTP block (v157/cors-enforcement-for-background-fetch pattern)
{
  const sample = [
    "// Client call",
    'const bg = await reg.backgroundFetch.fetch(id, [new Request("https://cdn.example/a", { mode: "cors" })], { downloadTotal: 10_485_760 });',
    "Access-Control-Allow-Origin: https://app.example",
    "Access-Control-Allow-Credentials: true",
  ].join("\n");
  const out = highlightCode(sample, "js");
  assert(
    "mixed JS + HTTP highlights JS keywords, constructors, strings, numbers, and HTTP headers",
    out.includes('<span class="hl-cm">// Client call</span>') &&
      out.includes('<span class="hl-kw">const</span>') &&
      out.includes('<span class="hl-kw">await</span>') &&
      out.includes('<span class="hl-ty">Request</span>') &&
      out.includes('<span class="hl-num">10_485_760</span>') &&
      out.includes('<span class="hl-ty">Access-Control-Allow-Origin</span>') &&
      out.includes('<span class="hl-str">https://app.example</span>') &&
      out.includes('<span class="hl-ty">Access-Control-Allow-Credentials</span>') &&
      out.includes('<span class="hl-num">true</span>'),
  );
  assert(
    "mixed JS + HTTP preserves exact textContent",
    decodeCodeEntities(stripHighlightSpans(out)) === sample,
  );
}

// 3. Template literals with ${...} expressions and member property access after dots
{
  const sample = "const msg = `Failed (${failureReason})`; obj.default = obj.return;";
  const out = highlightCode(sample, "js");
  assert(
    "template literal highlights delimiters and keeps interpolated identifier clean",
    out.includes(
      '<span class="hl-str">`Failed (</span><span class="hl-pun">${</span>failureReason<span class="hl-pun">}</span><span class="hl-str">)`</span>',
    ),
  );
  assert(
    "member names after dots are not mis-highlighted as keywords",
    !out.includes('.<span class="hl-kw">default</span>') &&
      !out.includes('.<span class="hl-kw">return</span>'),
  );
  assert(
    "template literal snippet preserves exact textContent",
    decodeCodeEntities(stripHighlightSpans(out)) === sample,
  );
}

// 4. HTML with embedded <script> and <style> blocks
{
  const sample = [
    '<div class="card">',
    "  <style>.card { color: #333; }</style>",
    "  <script>const ok = true;</script>",
    '  <script type="speculationrules">{"prerender": []}</script>',
    "</div>",
  ].join("\n");
  const out = highlightCode(sample, "html");
  assert(
    "HTML recursively highlights embedded <style>, JS <script>, and JSON speculationrules",
    out.includes('<span class="hl-ty">div</span>') &&
      out.includes('<span class="hl-attr">class</span>') &&
      out.includes('<span class="hl-attr">color</span>') &&
      out.includes('<span class="hl-kw">const</span>') &&
      out.includes('<span class="hl-attr">"prerender"</span>'),
  );
  assert(
    "HTML embedded-block snippet preserves exact textContent",
    decodeCodeEntities(stripHighlightSpans(out)) === sample,
  );
}

// 5. XSS / HTML-injection safety: raw tags inside code are always escaped
{
  const hostile = 'const s = "<img src=x onerror=alert(1)>"; // </script><script>alert(2)</script>';
  const out = highlightCode(hostile, "js");
  assert(
    "hostile HTML inside code is escaped (only whitelisted .hl-* spans are emitted)",
    !out.includes("<img") && !out.includes("<script") &&
      stripHighlightSpans(out).indexOf("<") === -1,
  );
  assert(
    "hostile HTML snippet round-trips to exact original text",
    decodeCodeEntities(stripHighlightSpans(out)) === hostile,
  );
}

// 6. Idempotency + preservation of authored inline markup inside <code>
{
  const doc = [
    '<pre tabindex="0"><code data-doc-test="js">const n = 42; // ok</code></pre>',
    '<pre><code>&lt;?marker name="<em>name</em>"&gt;</code></pre>',
  ].join("\n");
  const pass1 = highlightHtmlDocument(doc);
  const pass2 = highlightHtmlDocument(pass1.html);
  assert(
    "highlightHtmlDocument highlights plain block and preserves authored <em> block",
    pass1.blocksHighlighted === 1 &&
      pass1.blocksSkippedWithMarkup === 1 &&
      pass1.html.includes('<span class="hl-kw">const</span>') &&
      pass1.html.includes("<em>name</em>"),
  );
  assert(
    "highlightHtmlDocument is strictly idempotent on re-run",
    !pass2.changed && pass2.html === pass1.html,
  );
}

// 7. public/styles.css carries all 7 subtle syntax tokens in light/dark themes
{
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const expectedClasses = ["hl-cm", "hl-kw", "hl-str", "hl-num", "hl-ty", "hl-attr", "hl-pun"];
  const allPresent = expectedClasses.every((cls) =>
    css.includes(`--${cls}-light:`) &&
    css.includes(`--${cls}-dark:`) &&
    css.includes(`--${cls}: light-dark(`) &&
    css.includes(`pre code .${cls}`)
  );
  assert(
    "public/styles.css defines all 7 .hl-* tokens across light, dark, light-dark(), and pre code selectors",
    allPresent,
  );
}

// 8. Corpus-wide textContent round-trip invariant across every published v<N>/**/*.html page
{
  const repoRoot = new URL("..", import.meta.url).pathname;
  const htmlFiles = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".html")) htmlFiles.push(full);
    }
  }
  for (const e of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (e.isDirectory() && /^v\d+$/.test(e.name)) walk(path.join(repoRoot, e.name));
  }
  let totalBlocks = 0;
  let mismatches = 0;
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    const r1 = highlightHtmlDocument(html);
    const r2 = highlightHtmlDocument(r1.html);
    totalBlocks += r1.blocksHighlighted;
    if (r2.changed) mismatches++;
  }
  assert(
    `corpus round-trip & idempotency across ${htmlFiles.length} HTML files (${totalBlocks} code blocks)`,
    totalBlocks > 900 && mismatches === 0,
    `${mismatches} idempotency mismatch(es)`,
  );
}

if (failures > 0) {
  console.error(`syntax-highlight.test.mjs: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log(`syntax-highlight fixture: all ${passed} assertions passed`);
