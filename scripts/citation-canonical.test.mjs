// @fixture-permissions --allow-read
// scripts/citation-canonical.test.mjs — the citation-canonicalisation RULE and its negatives
// (gendn-4ck; moved out of reference-contract.test.mjs).
//
// WHY THIS FILE EXISTS: every assertion here is a pure string comparison over canonicalCitationUrl
// and hasHref — no browser, no network, sub-millisecond. They used to live in
// reference-contract.test.mjs, which was reached only by `deno task test-reference-contract`:
// ci.yml did not invoke it and gendn-cp7's aggregate excluded it as browser-backed. So the rule's
// POSITIVE behaviour was CI-guarded (check-conformance runs the validator over the real catalogue)
// while assertions proving it does not OVER-COLLAPSE relied on someone remembering a task name.
// A `test-*` task is discovered by the aggregate, which CI runs, so moving them here gave them
// automated reach. The DOM-backed visibility suite now has its own dedicated CI step.
//
// Run: deno task test-fixtures --tasks test-citation-canonical (file-discovered automatically)

import { canonicalCitationUrl, hasHref } from "./lib/reference-contract.mjs";

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

// ---- gendn-t77: citation canonicalisation ------------------------------------------------
// The rule is `new URL(s).href` on BOTH sides, and these assertions are mostly NEGATIVE: the
// burden is to show that nothing materially different can collapse into an equal citation.
const canonical = [
  // the incident itself: a bare host and its trailing-slash form are the same citation
  [
    "https://example.org",
    "https://example.org/",
    true,
    "bare host equals its canonical slash form",
  ],
  // ...and a PATH on that host is a different citation
  [
    "https://example.org",
    "https://example.org/guide",
    false,
    "a bare host does NOT equal a path on that host",
  ],
  [
    "https://example.org/",
    "https://example.org/guide",
    false,
    "the canonical bare host does NOT equal a path",
  ],
  // different hosts and subdomains stay distinct
  ["https://example.org/", "https://www.example.org/", false, "subdomain confusion is rejected"],
  ["https://example.org/", "https://example.net/", false, "different origins are rejected"],
  // a scheme downgrade is a different citation
  ["https://example.org/spec", "http://example.org/spec", false, "http does not equal https"],
  // the query is significant
  [
    "https://example.org/spec",
    "https://example.org/spec?section=2",
    false,
    "a query is not decoration",
  ],
  [
    "https://example.org/spec?a=1",
    "https://example.org/spec?a=2",
    false,
    "a different query is a different citation",
  ],
  // the FRAGMENT is significant, in both directions: a citation to a section is not the bare page,
  // and collapsing it would let a citation to the WRONG SECTION look present.
  [
    "https://example.org/spec",
    "https://example.org/spec#api",
    false,
    "a fragment-bearing citation is not the bare page",
  ],
  [
    "https://example.org/spec#api",
    "https://example.org/spec#events",
    false,
    "different fragments are different citations",
  ],
  [
    "https://example.org/spec#api",
    "https://example.org/spec#api",
    true,
    "the same fragment matches",
  ],
  // spelling differences a browser resolves identically are equal
  ["https://EXAMPLE.org/spec", "https://example.org/spec", true, "host case is not significant"],
  [
    "https://example.org:443/spec",
    "https://example.org/spec",
    true,
    "a default port is not significant",
  ],
  [
    "https://example.org/a/../spec",
    "https://example.org/spec",
    true,
    "dot-segments are resolved",
  ],
  // fail closed
  [null, "https://example.org/", false, "a null citation cannot be satisfied"],
  ["not a url", "https://example.org/", false, "an unparseable citation is never satisfied"],
  [
    "/relative/path",
    "https://example.org/relative/path",
    false,
    "a relative reference has no canonical absolute form",
  ],
];
for (const [contractUrl, pageHref, wantEqual, why] of canonical) {
  const a = canonicalCitationUrl(contractUrl);
  const b = canonicalCitationUrl(pageHref);
  const equal = a !== null && b !== null && a === b;
  assert(
    `${why}: contract ${JSON.stringify(contractUrl)} vs page ${JSON.stringify(pageHref)} -> ${
      wantEqual ? "EQUAL" : "not equal"
    }`,
    equal === wantEqual,
    `canonical: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  );
}

// GATE-LEVEL: the incident itself, through the function that decides whether a page links its
// cited source. Before gendn-t77 the first case could never pass, which is what made pages drift
// to matching the contract's spelling instead of the browser's.
const page = `<p>Source: <a href="https://example.org/">the spec</a></p>`;
assert(
  "the incident: a contract citing the BARE HOST matches a page linking its canonical slash form",
  hasHref(page, "https://example.org"),
  "this is the gendn-t77 defect",
);
assert(
  "the incident's negative: it does NOT match a page linking a PATH on that host",
  !hasHref(`<a href="https://example.org/guide">x</a>`, "https://example.org"),
);
assert(
  "no subdomain collapse",
  !hasHref(`<a href="https://www.example.org/">x</a>`, "https://example.org"),
);
assert(
  "no scheme downgrade",
  !hasHref(`<a href="http://example.org/spec">x</a>`, "https://example.org/spec"),
);
assert(
  "a different fragment is not satisfied",
  !hasHref(`<a href="https://example.org/spec#events">x</a>`, "https://example.org/spec#api"),
);
assert(
  "a different query is not satisfied",
  !hasHref(`<a href="https://example.org/spec?b=2">x</a>`, "https://example.org/spec?a=1"),
);
assert(
  "an entity-encoded href still matches its plain citation (the old tolerance is preserved)",
  hasHref(
    `<a href="https://example.org/spec?a=1&amp;b=2">x</a>`,
    "https://example.org/spec?a=1&b=2",
  ),
);
assert(
  "an unparseable citation is never satisfied, even by an identical string on the page",
  !hasHref(`<a href="not a url">x</a>`, "not a url"),
);

// ---- DETECTOR CASES (gendn-4ck) -----------------------------------------------------------------
// A negative suite that cannot fail does not close this class, so each distinction below is paired
// with a NAIVE canonicalisation that WOULD collapse it. If someone ever replaces the rule with a
// friendlier-looking one, these pairs are what catch it.

const naive = {
  stripTrailingSlash: (u) => canonicalCitationUrl(u)?.replace(/\/$/, ""),
  dropQueryAndFragment: (u) => {
    const p = new URL(u);
    p.search = "";
    p.hash = "";
    return p.href;
  },
  stripWww: (u) => new URL(u).href.replace("://www.", "://"),
  downgradeScheme: (u) => new URL(u).href.replace(/^https:/, "http:"),
};

const detectorPairs = [
  [
    "https://example.org/spec",
    "https://example.org/spec/",
    "stripTrailingSlash",
    "a trailing slash is a different path",
  ],
  [
    "https://example.org/spec?a=1",
    "https://example.org/spec?a=2",
    "dropQueryAndFragment",
    "a different query is a different citation",
  ],
  [
    "https://example.org/spec#api",
    "https://example.org/spec#events",
    "dropQueryAndFragment",
    "a different fragment is a different citation",
  ],
  [
    "https://example.org/spec#api",
    "https://example.org/spec",
    "dropQueryAndFragment",
    "a fragment citation is not the bare page",
  ],
  [
    "https://example.org/spec",
    "https://www.example.org/spec",
    "stripWww",
    "a subdomain is a different origin",
  ],
  ["https://example.org/spec", "http://example.org/spec", "downgradeScheme", "http is not https"],
];
for (const [a, b, naiveName, why] of detectorPairs) {
  const ruleSeparates = canonicalCitationUrl(a) !== canonicalCitationUrl(b);
  const naiveCollapses = naive[naiveName](a) === naive[naiveName](b);
  assert(
    `detector: the rule separates ${why}`,
    ruleSeparates,
    `${JSON.stringify(canonicalCitationUrl(a))} vs ${JSON.stringify(canonicalCitationUrl(b))}`,
  );
  assert(
    `detector: a naive canonicalisation WOULD collapse ${why} (so the assertion above can fail)`,
    naiveCollapses,
    `${naiveName}: ${JSON.stringify(naive[naiveName](a))}`,
  );
}
// ...and the property we must not LOSE while refusing to over-collapse.
assert(
  "detector: the incident pair still PASSES (bare host == its canonical slash form)",
  canonicalCitationUrl("https://example.org") === canonicalCitationUrl("https://example.org/"),
);

if (failures > 0) {
  console.error(`citation-canonical.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`citation-canonical fixture: all ${passed} assertions passed`);
