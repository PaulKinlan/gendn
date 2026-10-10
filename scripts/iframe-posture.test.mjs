// @fixture-permissions --allow-read
// scripts/iframe-posture.test.mjs — the gendn-kjq guard fixture.
//
// THE FINDING: 36 published pages embedded the cross-origin Chrome Platform Showcase demo in
// iframes with NO sandbox and NO referrerpolicy — a shared pattern, generated from the template in
// .claude/routine-prompt.md step 6. Every such embed lets the framed third party run without a
// deliberate posture (it could navigate the top window, open popups, submit forms) and leaks the
// embedding page's full URL to it by default.
//
// THE FIX FOR A PATTERN IS A GUARD, NOT A SWEEP: this fixture scans EVERY published static page
// and fails when any <iframe> lacks the posture, so the next generated page cannot reintroduce
// the defect quietly. The 36 existing embeds were fixed in place (sandbox="allow-scripts
// allow-same-origin" referrerpolicy="strict-origin-when-cross-origin"; rationale in
// .claude/routine-prompt.md step 6) and the template was fixed at the source.
//
// RULES:
//   1. EVERY <iframe> must carry a referrerpolicy attribute (full-URL leakage is never needed).
//   2. A THIRD-PARTY iframe (absolute http(s) src to a host that is not first-party) must also
//      carry a sandbox whose VALUE is sanctioned — it must include allow-scripts and stay within
//      the sanctioned token set unless recorded as a SANDBOX_VARIANTS entry with a reason — or a
//      named exemption in EXEMPTIONS below. Presence alone is not enough: sandbox="" blanks the
//      demo and sandbox="allow-forms" permits nothing a demo needs, yet both satisfy a presence
//      check while doing the wrong thing.
//   3. A FIRST-PARTY iframe (relative src, srcdoc, or a host in FIRST_PARTY_HOSTS) is NOT forced
//      to be sandboxed: it is this site, and sandboxing your own iframe flips it to an opaque
//      origin, which can silently break it (storage/IDB/same-origin fetch). It still needs a
//      referrerpolicy and, if unsandboxed, must be listed in FIRST_PARTY_UNSANDBOXED with a
//      reason — deliberate, never default.
//   4. PENDING_HARDENING (scripts/lib/iframe-posture.mjs) is an exact-file, reasoned, self-
//      expiring deferral list: originally 5 built pages with no reference-contract.json could not
//      be touched without tripping check-conformance's touched-page ratchet (coord ruling 2026-10-06,
//      option c: split and file). All 5 pages (v152/sub-apps, v151/speculation-rules-form-submission-field,
//      v150/speculative-load-measurement, v150/webrtc-diagnostic-logging-api, and
//      v151/algorithm-updates-in-webcrypto) have now gained contracts, hardened their iframes, and
//      delisted; the list is currently empty. A new unsandboxed third-party iframe on ANY page
//      still fails.
//
// DETECTOR PROOF: the canary section runs the SAME rule function against synthesized tags —
// including the exact pre-fix shape (third-party iframe, no sandbox, no referrerpolicy), a
// PRESENCE-BUT-WRONG sandbox (sandbox="" and sandbox="allow-forms"), and an unrecorded variant
// adding allow-top-navigation — and requires every one to be flagged. A guard that cannot fail is
// decoration.
//
// KNOWN LIMITS — state them so greenness is never read as more than it is:
//   - This is a STATIC source check over checked-in HTML. An iframe injected at RUNTIME by
//     JavaScript (createElement/innerHTML) is invisible to it; the served-build equivalence is
//     demonstrated by the (manual, networked) scripts/iframe-posture-sweep.mjs, not by this file.
//   - Server-rendered templates (server.ts) are not scanned as HTML; they are covered only insofar
//     as they embed none today (verified 2026-10-06) and the served-build sweep would catch one.
//   - Attribute parsing is regex-grade: it reads sandbox/referrerpolicy/src tokens from the tag
//     text. Exotic encodings (entity-escaped attribute values, tags split by template logic) could
//     evade or confuse it — another reason the canaries pin the rule function, not the prose.
//   - PENDING_HARDENING in scripts/lib/iframe-posture.mjs is currently empty: all 5 originally
//     deferred pages have now been postured with contracts (gendn-sgc / gendn-cwd). All 36
//     showcase embed pages carry deliberate postures. The deferral mechanism remains in place
//     for future deferrals if needed.
//
// Run: deno task test-fixtures --tasks test-iframe-posture

import { PENDING_HARDENING, SANCTIONED_SANDBOX } from "./lib/iframe-posture.mjs";

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

// Hosts that are THIS site (gendn) itself. Relative-src and srcdoc iframes are first-party by
// shape and need no entry here. The gendn deployment origin may be added when it is pinned.
const FIRST_PARTY_HOSTS = new Set([
  // (none yet)
]);

// Named exemptions: a third-party iframe that genuinely must not be sandboxed, with the reason a
// reviewer will read. Empty today — all 36 showcase embeds carry the deliberate posture.
const EXEMPTIONS = [
  // { file: "v150/foo/index.html", why: "..." },
];

// First-party iframes deliberately left unsandboxed (rule 3), with reasons. Empty today.
const FIRST_PARTY_UNSANDBOXED = [
  // { file: "...", why: "..." },
];

// The sanctioned sandbox value for third-party demo embeds comes from the shared module (single
// source of truth with the sweep); anything beyond it is a per-embed variant and must be listed
// here WITH the reason it is required — a variant that silently adds allow-top-navigation changes
// the risk story, not just the demo.
const SANCTIONED_SANDBOX_TOKENS = new Set(SANCTIONED_SANDBOX.split(/\s+/).filter(Boolean));
const SANDBOX_VARIANTS = [
  // { file: "...", sandbox: "...", why: "..." },
];

/** Classify an iframe src: "first-party" | "third-party" | "opaque" (srcdoc/about/data/blob). */
export function classifySrc(src, pageUrl = "https://gendn.invalid/page/") {
  if (src === null) return "first-party"; // no src / srcdoc: the document is the embedder's own
  try {
    const u = new URL(src, pageUrl);
    if (u.protocol === "about:" || u.protocol === "srcdoc:") return "first-party";
    if (u.protocol === "data:" || u.protocol === "blob:") return "opaque";
    if (u.protocol !== "http:" && u.protocol !== "https:") return "opaque";
    if (!src.match(/^[a-z][a-z0-9+.-]*:/i)) return "first-party"; // relative reference
    return FIRST_PARTY_HOSTS.has(u.hostname) ? "first-party" : "third-party";
  } catch {
    return "opaque"; // unparseable: treated as third-party-equivalent by the audit (flagged)
  }
}

/**
 * Audit ONE <iframe> tag. Returns null when the posture is deliberate, or a violation string.
 * Pure function of the tag + file path so the canary can drive it with synthesized inputs.
 */
export function auditIframeTag(tag, file) {
  const attr = (name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|[^\\s>]*)`, "i").exec(tag);
    return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
  };
  const hasAttr = (name) => new RegExp(`\\b${name}(\\s*=|[\\s/>])`, "i").test(tag);
  const src = attr("src");
  const cls = hasAttr("srcdoc") ? "first-party" : classifySrc(src);
  const problems = [];

  if (!hasAttr("referrerpolicy")) problems.push("missing referrerpolicy");

  const sandboxed = hasAttr("sandbox");
  if (cls === "third-party" || cls === "opaque") {
    const exempt = EXEMPTIONS.some((e) => e.file === file);
    if (!sandboxed && !exempt) {
      problems.push(`${cls} iframe without sandbox (no named exemption)`);
    } else if (sandboxed && !exempt) {
      // VALUE, not presence: sandbox="" strips scripts and silently blanks the demo; a sandbox
      // without allow-scripts permits nothing an interactive embed needs. Both pass a presence
      // check while doing the wrong thing, so the sanctioned token set is required and any
      // deviation must be a recorded variant with a reason.
      const value = attr("sandbox") ?? "";
      const tokens = value.split(/[\t\n\f\r ]+/).filter(Boolean);
      const variant = SANDBOX_VARIANTS.find((v) => v.file === file);
      if (tokens.length === 0) {
        problems.push('sandbox="" strips scripts and would blank the demo');
      } else if (!tokens.includes("allow-scripts")) {
        problems.push(
          `sandbox lacks allow-scripts (value: "${value}") — useless for an interactive embed`,
        );
      } else if (!variant && tokens.some((t) => !SANCTIONED_SANDBOX_TOKENS.has(t))) {
        problems.push(
          `sandbox tokens beyond the sanctioned set (${
            tokens.filter((t) => !SANCTIONED_SANDBOX_TOKENS.has(t)).join(", ")
          }) without a recorded SANDBOX_VARIANTS reason`,
        );
      } else if (variant && value !== variant.sandbox) {
        problems.push(`sandbox value does not match its recorded variant ("${variant.sandbox}")`);
      }
    }
  } else if (cls === "first-party" && !sandboxed) {
    // Rule 3: first-party unsandboxed is allowed but must be DELIBERATE — relative-src showcase
    // fallbacks and srcdoc snippets are self-evidently this site; anything with an absolute
    // first-party host must be listed.
    const isAbsoluteFirstPartyHost = src !== null && /^[a-z][a-z0-9+.-]*:/i.test(src) &&
      !(src ?? "").match(/^https?:\/\/(localhost|127\.0\.0\.1)/i);
    if (isAbsoluteFirstPartyHost && !FIRST_PARTY_UNSANDBOXED.some((e) => e.file === file)) {
      problems.push("first-party iframe unsandboxed without a recorded reason");
    }
  }
  return problems.length === 0 ? null : `${file}: ${problems.join("; ")}`;
}

// --- scan every published static page ----------------------------------------------
async function* walkHtml(dir, prefix) {
  for await (const e of Deno.readDir(dir)) {
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory) {
      yield* walkHtml(`${dir}/${e.name}`, rel);
    } else if (e.name.endsWith(".html")) {
      yield rel;
    }
  }
}

const pages = [];
for await (const e of Deno.readDir(REPO)) {
  if (e.isDirectory && /^v\d+$/.test(e.name)) {
    for await (const rel of walkHtml(`${REPO}${e.name}`, e.name)) pages.push(rel);
  }
}
for await (const rel of walkHtml(`${REPO}public`, "public")) pages.push(rel);

let iframeCount = 0;
const violations = [];
const pendingSeen = new Set();
const deferredPosture = new Map();
for (const rel of pages) {
  const text = await Deno.readTextFile(`${REPO}${rel}`);
  for (const m of text.matchAll(/<iframe\b[^>]*>/gs)) {
    iframeCount++;
    const pending = PENDING_HARDENING.find((p) => p.file === rel);
    if (pending) {
      // A deferred page SKIPS the posture audit below, so we audit it here purely to record whether
      // the deferral is still doing any work: a deferral that covers only already-sanctioned iframes
      // is stale on the POSTURE axis, the mirror of the contract axis checked underneath.
      const posture = deferredPosture.get(rel) ?? { iframes: 0, unhardened: 0 };
      posture.iframes++;
      if (auditIframeTag(m[0], rel)) posture.unhardened++;
      deferredPosture.set(rel, posture);
      // Exact-file reasoned deferral (rule 4) — and SELF-EXPIRING: the moment the page gains a
      // reference-contract.json, the ratchet no longer blocks hardening, so the deferral is over
      // and this fixture fails until the page is postured and the entry removed (gendn-sgc).
      pendingSeen.add(rel);
      let contractExists = false;
      try {
        Deno.statSync(`${REPO}${rel.replace(/index\.html$/, "")}reference-contract.json`);
        contractExists = true;
      } catch {
        // no contract — deferral still valid
      }
      if (contractExists) {
        violations.push(
          `${rel}: STALE deferral — reference-contract.json now exists, so harden the iframe and remove the PENDING_HARDENING entry (gendn-sgc)`,
        );
      }
      continue;
    }
    const v = auditIframeTag(m[0], rel);
    if (v) violations.push(v);
  }
}

assert(
  "scanner actually scanned the published tree (published routes are append-only, so the count never drops below the 36 known embeds)",
  pages.length > 0 && iframeCount >= 36,
  `${pages.length} page(s), ${iframeCount} iframe(s)`,
);
assert(
  "every published iframe carries a deliberate posture (referrerpolicy, and a SANCTIONED sandbox value or a named exemption)",
  violations.length === 0,
  violations.length > 0
    ? `${violations.length} violation(s): ${violations.slice(0, 8).join(" | ")}`
    : `${iframeCount} iframe(s), all deliberate`,
);
// The deferral list is self-expiring on TWO axes, and only one of them used to be asserted. A
// deferred page skips the posture audit, so the CONTRACT check above was the only thing that could
// retire an entry — which meant a page that had been postured WITHOUT gaining a contract stayed in
// the list indefinitely AND was never posture-audited. That is also the one swap the other
// assertions could not catch (see the comment above DEFERRED_PAGES). This is the mirror: an entry
// whose page carries no unhardened iframe has nothing left to defer, so it must be removed.
{
  const staleOnPosture = PENDING_HARDENING.filter((p) => {
    const posture = deferredPosture.get(p.file);
    return posture !== undefined && posture.iframes > 0 && posture.unhardened === 0;
  }).map((p) => p.file);
  assert(
    "every PENDING_HARDENING deferral still carries an UNHARDENED iframe (an entry leaves the list in the same change that postures its page)",
    staleOnPosture.length === 0,
    staleOnPosture.length > 0
      ? `STALE deferral(s) on posture: ${
        staleOnPosture.join(", ")
      } — posture the page and remove the entry`
      : `${PENDING_HARDENING.length} deferral(s), each still carrying an unpostured iframe`,
  );
}
assert(
  "every PENDING_HARDENING deferral names a real scanned page (the list cannot go stale silently)",
  PENDING_HARDENING.every((p) => pendingSeen.has(p.file)),
  `expected ${PENDING_HARDENING.length}, saw ${pendingSeen.size}: missing ${
    PENDING_HARDENING.filter((p) => !pendingSeen.has(p.file)).map((p) => p.file).join(", ") ||
    "none"
  }`,
);
// The deferral list is asserted by EXACT SET, not by count (gendn-sgc pilot, coord's swap point).
// WHY THE SET IS THE ASSERTION THAT MATTERS, verified against the scanner rather than argued: a
// deferred page SKIPS the posture audit entirely, and the only other check it gets is the contract
// staleness test above. So swapping one deferred entry for another page's entry is caught by the
// violations assertion ONLY when the swapped-AWAY page is still unhardened (it stops being skipped
// and auditIframeTag flags it). Swap onto a page that is ALREADY postured but still contractless and
// every other assertion passes — the count, the bead, pendingSeen, and the contract check (that page
// is skipped, and its deferral is not stale by that test) — so the set assertion was the ONLY thing
// standing between that swap and a widening. The posture-axis assertion added above, which retires an
// entry once its page has no unhardened iframe left, now closes the path on the other side too.
// Proven by mutation, not assumed: dropping an id from DEFERRED_PAGES fails; and with DEFERRED_PAGES
// edited to match a swap onto an already-postured page, the posture-axis assertion is what fails.
// The list only ever SHRINKS: a page leaves it in the same change that postures it and gives it a
// contract. All 5 originally deferred pages have now gained contracts and hardened their embeds;
// the list is currently empty.
const DEFERRED_PAGES = [];
assert(
  "the deferral list is EXACTLY the deferred pages (a swap cannot hide a widening)",
  JSON.stringify(PENDING_HARDENING.map((p) => p.file).sort()) ===
    JSON.stringify([...DEFERRED_PAGES].sort()),
  `got: ${PENDING_HARDENING.map((p) => p.file).join(", ")}`,
);
assert(
  "every deferral names its tracking bead",
  PENDING_HARDENING.every((p) => p.bead === "gendn-sgc"),
  PENDING_HARDENING.map((p) => `${p.file}->${p.bead}`).join(", "),
);

// --- canary: the rules MUST flag the pre-fix shape (the guard can fail) ---------------
{
  const PREFIX_SHAPE =
    `<iframe src="https://chrome-platform-showcase.paulkinlan-ea.deno.net/v147/autofill-event/refill-flow/" title="Live example" loading="lazy" width="100%" height="520">`;
  assert(
    "canary: the EXACT pre-fix tag (third-party, no sandbox, no referrerpolicy) is flagged",
    auditIframeTag(PREFIX_SHAPE, "canary/prefix.html") !== null,
  );
  const noSandbox =
    `<iframe src="https://evil.example/demo/" referrerpolicy="strict-origin-when-cross-origin">`;
  assert(
    "canary: a NEW third-party iframe with referrerpolicy but no sandbox is still flagged",
    auditIframeTag(noSandbox, "canary/nosandbox.html") !== null,
  );
  const noRp = `<iframe src="https://evil.example/demo/" sandbox="allow-scripts">`;
  assert(
    "canary: sandbox alone (no referrerpolicy) is flagged",
    auditIframeTag(noRp, "canary/norp.html") !== null,
  );
  const emptySandbox =
    `<iframe src="https://chrome-platform-showcase.paulkinlan-ea.deno.net/v147/x/y/" sandbox="" referrerpolicy="strict-origin-when-cross-origin">`;
  assert(
    'canary: sandbox="" (presence but scripts stripped — demo blanks) is flagged',
    auditIframeTag(emptySandbox, "canary/empty.html") !== null,
  );
  const uselessSandbox =
    `<iframe src="https://chrome-platform-showcase.paulkinlan-ea.deno.net/v147/x/y/" sandbox="allow-forms" referrerpolicy="strict-origin-when-cross-origin">`;
  assert(
    'canary: sandbox="allow-forms" (a sandbox that permits nothing a demo needs) is flagged',
    auditIframeTag(uselessSandbox, "canary/useless.html") !== null,
  );
  const sneakyVariant =
    `<iframe src="https://evil.example/demo/" sandbox="allow-scripts allow-top-navigation" referrerpolicy="strict-origin-when-cross-origin">`;
  assert(
    "canary: an unrecorded variant adding allow-top-navigation (risk-story change) is flagged",
    auditIframeTag(sneakyVariant, "canary/variant.html") !== null,
  );
  const compliant =
    `<iframe src="https://chrome-platform-showcase.paulkinlan-ea.deno.net/v147/x/y/" sandbox="allow-scripts allow-same-origin" referrerpolicy="strict-origin-when-cross-origin">`;
  assert(
    "canary: the compliant posture passes the same rules (the guard is not a blanket red light)",
    auditIframeTag(compliant, "canary/ok.html") === null,
  );
  const srcdoc = `<iframe srcdoc="&lt;p&gt;hi&lt;/p&gt;" referrerpolicy="no-referrer"></iframe>`;
  assert(
    "canary: a srcdoc snippet needs no sandbox but does need referrerpolicy",
    auditIframeTag(srcdoc, "canary/srcdoc.html") === null,
  );
  const dataUrl = `<iframe src="data:text/html,hi"></iframe>`;
  assert(
    "canary: an opaque data: URL without posture is flagged",
    auditIframeTag(dataUrl, "canary/data.html") !== null,
  );
  // The deferral is EXACT-FILE: the same unhardened tag on any other page is still flagged.
  assert(
    "canary: the pre-fix tag on a NON-deferred page is flagged (the deferral never widens)",
    auditIframeTag(PREFIX_SHAPE, "v153/some-new-page/index.html") !== null,
  );
}

if (failures > 0) {
  console.error(`iframe-posture.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(
  `iframe-posture fixture: all ${passed} assertions passed (${iframeCount} iframe(s) across ${pages.length} page(s))`,
);
