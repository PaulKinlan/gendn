// @fixture-permissions --allow-read
// scripts/external-url.test.mjs — the gendn-0cu acceptance test.
//
// The finding: server.ts stored `html_url` verbatim from api.github.com and interpolated
// escapeHTML(...) into `<a href="...">`. escapeHTML encodes characters and performs NO scheme
// check, so a javascript:/data: URL would have rendered a live same-origin script link.
//
// This drives BOTH the helper and the RENDERING PATH (the assertion that matters is on the
// resulting HTML: no dangerous href may appear), plus a control proving a real GitHub commit URL
// still renders as a working link, unchanged.
//
// Run: deno task test-fixtures --tasks test-external-url   (or: deno run --allow-read scripts/external-url.test.mjs)

import { renderCommitAnchor, safeExternalUrl } from "../lib/external-url.ts";

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

// --- helper: allowlist accepts http/https ---------------------------------------
const GOOD = [
  [
    "https://github.com/PaulKinlan/gendn/commit/16f93cf",
    "https://github.com/PaulKinlan/gendn/commit/16f93cf",
  ],
  ["http://example.com/a?b=c#d", "http://example.com/a?b=c#d"],
  ["  https://github.com/x/y  ", "https://github.com/x/y"],
];
for (const [input, expected] of GOOD) {
  const got = safeExternalUrl(input);
  assert(`safeExternalUrl accepts ${JSON.stringify(input)}`, got === expected, `-> ${got}`);
}

// --- helper: allowlist rejects everything else ----------------------------------
const BAD = [
  ["javascript:alert(1)", "javascript scheme"],
  ["JavaScript:alert(1)", "mixed-case javascript scheme"],
  ["  javascript:alert(1)", "javascript with leading whitespace"],
  ["data:text/html,<script>alert(1)</script>", "data scheme"],
  ["vbscript:msgbox(1)", "vbscript scheme"],
  ["blob:https://evil.example/abc", "blob scheme"],
  ["file:///etc/passwd", "file scheme"],
  ["//evil.example.com/x", "protocol-relative reference"],
  ["/relative/path", "relative reference"],
  ["not a url", "unparseable string"],
  ["", "empty string"],
  ["   ", "whitespace only"],
  [null, "null"],
  [undefined, "undefined"],
  [42, "number"],
  [{ href: "javascript:alert(1)" }, "object"],
];
for (const [input, why] of BAD) {
  const got = safeExternalUrl(input);
  assert(`safeExternalUrl rejects ${why}`, got === null, `-> ${JSON.stringify(got)}`);
}

// --- THE RENDERING PATH: no dangerous href may appear in the HTML ---------------
const DANGEROUS = [
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "blob:https://evil.example/abc",
];
for (const url of DANGEROUS) {
  const html = renderCommitAnchor(url, "16f93cf");
  assert(
    `renderCommitAnchor emits NO href for ${JSON.stringify(url)}`,
    !html.includes("href"),
    html,
  );
  assert(
    `renderCommitAnchor still emits the commit text for ${JSON.stringify(url)}`,
    html.includes("<code>16f93cf</code>"),
    html,
  );
}

// A scheme-VALID url containing a quote is allowed as a link, and must not be able to break out of
// the attribute. Two layers cover it: new URL() percent-encodes the quote (%22), and escapeHTML is
// still applied to whatever comes out. This is the case that belongs here rather than in the
// no-href list — the scheme is fine, so refusing the link would be the wrong fix.
const injected = renderCommitAnchor('https://github.com/x?a="onmouseover="alert(1)', "abc1234");
assert(
  "a quote in an http(s) URL is attribute-escaped (cannot inject an event handler)",
  injected.includes("href=") && !injected.includes('"onmouseover='),
  injected,
);

// --- CONTROL: a real GitHub commit URL still renders as a working link ----------
const CONTROL =
  "https://github.com/PaulKinlan/gendn/commit/16f93cf6d5bce3e8f67bccc939c6711e56acc9fe";
const control = renderCommitAnchor(CONTROL, "16f93cf");
assert(
  "CONTROL: real commit URL renders as a link to that exact href",
  control === `<a href="${CONTROL}" target="_blank" rel="noopener"><code>16f93cf</code></a>`,
  control,
);

// --- the regression itself: the OLD code's expression, for contrast -------------
// Before the fix the renderer was `escapeHTML(c.htmlUrl)` inside the href, i.e. unvalidated.
const oldStyle = (u) => `<a href="${u}" target="_blank" rel="noopener"><code>16f93cf</code></a>`;
assert(
  "the OLD unvalidated expression would have produced a javascript: href (why this is a real finding)",
  oldStyle("javascript:alert(1)").includes('href="javascript:alert(1)"'),
);

if (failures > 0) {
  console.error(`external-url.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`external-url fixture: all ${passed} assertions passed`);
