// scripts/threat-model-citations.test.mjs — the citation-resolution guard for THREAT_MODEL.md
// (gendn-zoq).
//
// The defect this pins: four source comments cited "THREAT_MODEL.md invariant #7/#8" while
// THREAT_MODEL.md DID NOT EXIST — the contract the code deferred to was unresolvable, and
// nothing failed. A comment that defers to a numbered invariant is a claim that the number
// resolves; this fixture makes that claim executable.
//
// It asserts:
//   1. THREAT_MODEL.md exists at the repo root and is a real document (not a stub).
//   2. Every "THREAT_MODEL.md invariant #N" citation anywhere in lib/, server.ts and scripts/
//      resolves to a numbered invariant entry in the document.
//   3. The four KNOWN citing files still cite — if a citation is removed or moves, the guard is
//      updated deliberately rather than silently narrowing.
//   4. Invariants #7 and #8 still contain the phrases the citing comments depend on ("timeout"
//      and "byte bound" for #7; "scheme-validated" and "allowlist" for #8) — so the document
//      cannot drift away from what the comments claim it says, or be renumbered past them.
//   5. The full numbered set 1-13 resolves, and the document still names the enforcement
//      anchors it was audited against (fetchBounded, safeExternalUrl, addSecurityHeaders).
//
// MEASURED BOUNDARY: this guard checks RESOLVABILITY and PHRASES, not semantic truth — it
// cannot tell whether invariant #7's TEXT is a true description of the code, only that the
// citation lands on a numbered entry carrying the words the citer quoted. The semantic audit is
// the document's provenance section (gendn-zoq, 2026-10-06) and the reviewer's job.
//
// Cwd-independent: the repo root is resolved from import.meta.url, so the fixture proves the
// same thing from any working directory (the 4l6/6q3 lesson).
//
// Run: deno task test-threat-model-citations  (or: deno run --allow-read scripts/threat-model-citations.test.mjs)

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const join = (...p) => `${ROOT}/${p.join("/")}`;

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

// ---- 1. the document exists and is real ----
let doc = null;
try {
  doc = await Deno.readTextFile(join("THREAT_MODEL.md"));
} catch {
  doc = null;
}
assert(
  "THREAT_MODEL.md exists at the repo root — the file four source comments cite",
  doc !== null,
  doc === null ? "read failed" : `${doc.length} chars`,
);
assert(
  "THREAT_MODEL.md is a real document, not a stub",
  doc !== null && doc.length > 4000 && doc.includes("## 6. Security Invariants"),
  doc === null ? "no document" : `${doc.length} chars`,
);

// ---- 2. every citation in code resolves to a numbered invariant ----
const CITATION_RE = /THREAT_MODEL\.md\s+invariant\s+#(\d+)/g;
const scanDirs = ["lib", "scripts"];
const scanFiles = ["server.ts"];
const sources = [];
for (const dir of scanDirs) {
  for await (const entry of Deno.readDir(join(dir))) {
    if (entry.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs"))) {
      // The guard's own comments DESCRIBE the citation pattern; that is not a deferral. Scanning
      // it would make the fixture a citer of itself (measured on first run: 5 citations across
      // 5 files, one of them this file).
      if (entry.name === "threat-model-citations.test.mjs") continue;
      sources.push(join(dir, entry.name));
    }
  }
}
for (const f of scanFiles) sources.push(join(f));

// The numbered invariant entries live in "## 6. Security Invariants". Scoping to that section
// is load-bearing, not cosmetic: §4 (Untrusted Attack Surfaces) is ALSO a numbered bold list, and
// an unscoped ^7\. \*\* match resolves to §4's item 7 (measured on the fixture's first run — #7
// "resolved" to "Browser-driven navigation in gates", and the #7/#8 phrase checks then failed).
const invariantsSection = (() => {
  if (doc === null) return "";
  const start = doc.indexOf("## 6. Security Invariants");
  if (start === -1) return "";
  const end = doc.indexOf("\n## 7.", start);
  // A sentinel heading keeps the entry regex's lookahead true for the LAST entry (#13): without
  // a following boundary the lazy match fails entirely and the entry reads as missing
  // (measured: "missing: 13" on the fixture's second run).
  return doc.slice(start, end === -1 ? doc.length : end) + "\n## (sentinel)\n";
})();

function invariantEntry(n) {
  // The numbered entry text: from "N. **" up to the next numbered entry or a bold/heading break.
  const m = invariantsSection.match(
    new RegExp(`^${n}\\. \\*\\*[\\s\\S]*?(?=^\\d+\\. \\*\\*|^## |^\\*\\*)`, "m"),
  );
  return m ? m[0] : null;
}

const citations = []; // { file, numbers[] }
for (const file of sources) {
  let text;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    continue;
  }
  const numbers = [...text.replace(/\s+/g, " ").matchAll(CITATION_RE)].map((m) => Number(m[1]));
  if (numbers.length > 0) citations.push({ file, numbers });
}

const allNumbers = citations.flatMap((c) => c.numbers);
assert(
  "at least one THREAT_MODEL.md invariant citation exists in the scanned sources (guard non-vacuity)",
  allNumbers.length > 0,
  `${allNumbers.length} citation(s) across ${citations.length} file(s)`,
);
for (const n of [...new Set(allNumbers)].sort((a, b) => a - b)) {
  const entry = invariantEntry(n);
  assert(
    `cited invariant #${n} resolves to a numbered entry in THREAT_MODEL.md`,
    entry !== null,
    entry === null ? "no entry found" : entry.slice(0, 60).replace(/\n/g, " "),
  );
}

// ---- 3. the four KNOWN citing files still cite ----
const KNOWN_CITERS = [
  "lib/mdn.ts",
  "lib/external-url.ts",
  "lib/html.ts",
  "scripts/mdn-has.test.mjs",
];
const citingRel = citations.map((c) => c.file.slice(ROOT.length + 1)).sort();
for (const known of KNOWN_CITERS) {
  assert(
    `known citer ${known} still cites THREAT_MODEL.md (guard scope is deliberate, not discovered)`,
    citingRel.includes(known),
    `citing files: ${citingRel.join(", ")}`,
  );
}

// ---- 4. #7 and #8 still carry the phrases the citing comments depend on ----
const seven = invariantEntry(7) ?? "";
assert(
  "invariant #7 still contains 'timeout' and 'byte bound' — the phrases lib/mdn.ts and scripts/mdn-has.test.mjs defer to",
  seven.includes("timeout") && seven.includes("byte bound"),
);
const eight = invariantEntry(8) ?? "";
assert(
  "invariant #8 still contains 'scheme-validated' and 'allowlist' — the phrases lib/external-url.ts quotes verbatim and lib/html.ts distinguishes",
  eight.includes("scheme-validated") && eight.toLowerCase().includes("allowlist"),
);

// ---- 5. the full numbered set and the audited anchors ----
const missing = [];
for (let n = 1; n <= 13; n++) if (invariantEntry(n) === null) missing.push(n);
assert(
  "all thirteen numbered invariants (1-13) resolve in the document",
  missing.length === 0,
  missing.length ? `missing: ${missing.join(", ")}` : "1-13 present",
);
for (const anchor of ["fetchBounded", "safeExternalUrl", "addSecurityHeaders"]) {
  assert(
    `document still names enforcement anchor ${anchor}`,
    doc?.includes(anchor) ?? false,
  );
}

if (failures > 0) {
  console.error(`threat-model-citations fixture: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`threat-model-citations fixture: all ${passed} assertions passed`);
