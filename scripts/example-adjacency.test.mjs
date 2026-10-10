// @fixture-permissions --allow-read
// scripts/example-adjacency.test.mjs — published-example invariants that are about POSITION, not
// existence (gendn-rl0 bounce).
//
// WHY: a published reference example teaches by adjacency — a lead-in comment is read as describing
// the code immediately below it. The gendn-rl0 fix inserted two detection lines between the
// "Robust pattern" comment and the standalone/isMacPWA block that comment describes: the comment's
// TEXT was byte-unchanged, and every presence check stayed green, because a presence check cannot
// see a moved neighbour. That is the same failure class as the kill-probe evidence being accepted
// mid-log (gendn-3t2): an invariant checked for existence but not for position.
//
// This test reads the SOURCE of the published example and asserts the adjacency a reader relies on,
// then proves it is a detector by running the same assertion against a synthesized copy with the
// exact defect this bead introduced — it must fail there and pass on the real file.
//
// Run: deno task test-fixtures --tasks test-example-adjacency

const REPO = new URL("..", import.meta.url).pathname;
const EXAMPLE = "v152/notification-attribution-for-pwas-on-macos/requireinteraction/index.html";

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

/**
 * The invariant: the "Robust pattern" lead-in is IMMEDIATELY followed by the standalone/isMacPWA
 * detection it describes. "Immediately" means: after the comment's own lines, the next non-blank
 * line begins the isMacPWA declaration — no other statement may sit between them.
 */
function robustPatternIsAdjacent(html) {
  const comment = html.indexOf(
    '// Robust pattern: don\'t encode "must persist" in the notification',
  );
  if (comment === -1) return { ok: false, why: "the Robust pattern comment is missing entirely" };
  const after = html.slice(comment);
  // Skip the comment's own continuation lines, then require the isMacPWA declaration next.
  const lines = after.split("\n");
  let i = 1;
  while (i < lines.length && lines[i].trim().startsWith("//")) i++;
  // Skip blank lines between the comment and the code (formatting, not meaning).
  while (i < lines.length && lines[i].trim() === "") i++;
  const next = (lines[i] ?? "").trim();
  if (!next.startsWith("const isMacPWA")) {
    return { ok: false, why: `the comment is followed by ${JSON.stringify(next.slice(0, 60))}` };
  }
  return { ok: true, why: next.slice(0, 40) };
}

/** The platform detection must precede that block (it is a dependency), with its own lead-in. */
function platformDetectionPrecedes(html) {
  const platform = html.indexOf("const platform = navigator.userAgentData?.platform;");
  const macPwa = html.indexOf("const isMacPWA");
  if (platform === -1) return { ok: false, why: "the Client Hint detection is missing" };
  if (macPwa === -1) return { ok: false, why: "the isMacPWA declaration is missing" };
  if (platform > macPwa) return { ok: false, why: "the detection was placed after its use" };
  const lead = html.slice(Math.max(0, platform - 400), platform);
  if (!/Client Hint/.test(lead)) {
    return { ok: false, why: "the detection has no lead-in naming the Client Hint" };
  }
  return { ok: true, why: `${macPwa - platform} chars before the isMacPWA block` };
}

const html = await Deno.readTextFile(`${REPO}${EXAMPLE}`);

const adjacent = robustPatternIsAdjacent(html);
assert(
  `the "Robust pattern" comment is immediately followed by the isMacPWA/standalone detection`,
  adjacent.ok,
  adjacent.why,
);
const ordered = platformDetectionPrecedes(html);
assert(
  "the Client Hint detection precedes the block it feeds, with its own lead-in",
  ordered.ok,
  ordered.why,
);
assert(
  "the detection still carries the Baseline TODO for the non-Baseline fallback",
  /TODO\(baseline\/ua-client-hints\)/.test(html),
);
assert(
  "the detection still prefers the Client Hint over the legacy string",
  /platform \? platform === "macOS" : \/Mac OS X\/\.test\(navigator\.userAgent\)/.test(html),
);

// --- detector proof: the EXACT defect this bead shipped must fail the assertion ---------------
// The defect: the two detection lines inserted between the comment and the block it describes.
const defective = html.replace(
  '// Robust pattern: don\'t encode "must persist" in the notification —\n// surface critical state in-app as well.\nconst isMacPWA',
  '// Robust pattern: don\'t encode "must persist" in the notification —\n// surface critical state in-app as well.\nconst platform = navigator.userAgentData?.platform;\nconst isMacOS = platform ? platform === "macOS" : /Mac OS X/.test(navigator.userAgent);\nconst isMacPWA',
);
assert(
  "the check is a DETECTOR: the defect this bead introduced fails it",
  defective !== html && !robustPatternIsAdjacent(defective).ok,
  `synthetic defect: ${robustPatternIsAdjacent(defective).why}`,
);
// And a presence-only check would NOT have caught it — demonstrated, not asserted in prose.
assert(
  "…and the presence-only check that missed it still passes on the same defective source",
  defective.includes('// Robust pattern: don\'t encode "must persist" in the notification'),
  "that is why this test asserts adjacency",
);

if (failures > 0) {
  console.error(`example-adjacency.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`example-adjacency fixture: all ${passed} assertions passed`);
