// scripts/lib/iframe-posture.mjs — shared constants for the gendn-kjq iframe posture work.
// Single source of truth for BOTH the guard fixture (scripts/iframe-posture.test.mjs) and the
// acceptance sweep (scripts/iframe-posture-sweep.mjs), so the two can never disagree about which
// pages are deliberately deferred.

// The sanctioned posture for third-party demo embeds (rationale in .claude/routine-prompt.md
// step 6): sandbox="allow-scripts allow-same-origin" + referrerpolicy="strict-origin-when-cross-origin".
export const SANCTIONED_SANDBOX = "allow-scripts allow-same-origin";
export const SANCTIONED_REFERRERPOLICY = "strict-origin-when-cross-origin";

// Pages whose hardening is DELIBERATELY DEFERRED by coord ruling 2026-10-06 (option c: split and
// file). They are built pages with NO reference-contract.json, so touching their content trips
// check-conformance's touched-page ratchet (a touched built page must be implementation-sufficient).
// EXACT file match only — never a wildcard, never a pattern, and a NEW unsandboxed third-party
// iframe anywhere else still fails the guard.
//
// EXIT CONDITION (temporary by construction): gendn-sgc authors the implementation-sufficient
// contracts from source, applies the posture to those pages, and REMOVES each entry in the same
// change that hardens it. LANDED SO FAR: v152/sub-apps (the pilot) and
// v151/speculation-rules-form-submission-field. The guard fixture additionally SELF-EXPIRES each entry: if a listed page gains a
// reference-contract.json before it is hardened and delisted, the fixture FAILS — the exemption
// cannot outlive its reason.
export const PENDING_HARDENING = [
  {
    file: "v150/speculative-load-measurement/index.html",
    why:
      "built page with no reference-contract.json yet; touching it trips the conformance ratchet",
    bead: "gendn-sgc",
  },
  {
    file: "v150/webrtc-diagnostic-logging-api/index.html",
    why:
      "built page with no reference-contract.json yet; touching it trips the conformance ratchet",
    bead: "gendn-sgc",
  },
  {
    file: "v151/algorithm-updates-in-webcrypto/index.html",
    why:
      "built page with no reference-contract.json yet; touching it trips the conformance ratchet",
    bead: "gendn-sgc",
  },
];
