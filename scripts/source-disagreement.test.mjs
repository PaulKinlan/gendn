// gendn-r3m — EXECUTABLE CHECK FOR SOURCE-DISAGREEMENT HANDLING (rule 92's third shape).
//
// The campaign distinguishes three contradiction shapes: a document contradicting ITSELF
// (gendn-b2s), a SUPERSEDED document (gendn-fdh), and — this one — TWO LIVE SOURCES
// DISAGREEING about the same fact, where the page's honest disposition is to carry BOTH
// sides with their attributions and dates rather than pick the tidier one (the gendn-8pq
// webcrypto ruling: "report, don't choose").
//
// DESIGN CONSTRAINT (coord's ruling at filing, and the whole point): this fixture RECORDS
// disagreements; it NEVER ADJUDICATES them. There is no truth claim anywhere in this file —
// every assertion is that a page STILL CARRIES a side's attribution (and its date where the
// note carries one), never that a side is correct. If the sources ever converge, the page and
// this table must be updated deliberately; a silently dropped side fails here, which is the
// failure mode the check exists for.
//
// WHAT EACH ENTRY PINS, per page:
//   marker  — a stable substring of the sentence that carries the disagreement (the sentence
//             must survive; anchors are text, not line numbers — lines rot, rule 47's family).
//   sideA / sideB — attribution tokens for EACH side. Both lists must be present: a page that
//             drops one side of a documented disagreement is the defect, whatever prose remains.
//   dates   — the note's date tokens where the note carries dates (a disagreement without its
//             as-of dates is unauditable: the reader cannot tell which source is stale).
//
// The table is a CURATED set of the clearest carried-disagreement instances, selected by
// judgement — NOT the output of an exhaustive sweep, and it makes no such claim. The
// evidence that no completeness claim is available at any width: two independent sweeps of
// the SAME tip with the SAME intent returned DIFFERENT page sets (one found a single page,
// the other found four), because "carries a source disagreement" is a predicate fuzzy at
// the edges — a property of the predicate, not a defect in the sweepers. So the claim is
// narrow and provable: this guard protects the PINNED pages against regression — a side
// silently dropped from any pinned page fails here — and says nothing about unpinned ones.
// Provenance, so the JUDGEMENTS are reproducible: (1) the filing named three pages;
// (2) a "disagree"-vocabulary grep of main's content tree found the fourth
// (capability-elements); (3) the FIRST cross-family review's sweep found two more
// (v152/deprecate-and-remove-xslt; v152/audiopreferred-capture-in-getdisplaymedia-api);
// (4) the SECOND, independent review (the bounce) re-swept with DIVERGENCE vocabulary and
// found three more (v151/no-auto-rewind-for-animationtrigger-play-methods,
// v147/web-printing-api/entry-point,
// v147/device-bound-session-credentials/challenge-header); (5) the first
// delta-confirmation's re-sweep found four more (the animation-accessor
// animationevent/transitionevent pair, v152/deprecate-and-remove-xslt/xsltprocessor,
// v150/speculative-load-measurement); (6) the second delta-confirmation's re-sweep found
// one more (v147/autofill-event); (7) the r3m residuals bead (gendn-j3d) added the
// web-printing HUB route — a second carriage site of the entry-point divergence, pinned
// under the pair precedent (where a note is duplicated, both copies are regression
// surfaces). A new page that gains a carried disagreement should be
// ADDED here; that is a deliberate act, which is exactly what a curated table forces.
//
// MUTATION PROOFS (logs on the bead, not inline; cp-based backups per rule 107):
//   M1 delete the carried disagreement sentence (webcrypto marker)  -> FAIL on the marker.
//   M2 drop a date token ("fetched 2026-10-06" -> "fetched")         -> FAIL on the dates.
//   M3 drop one side's attribution (webrtc trunk token renamed)      -> FAIL on sideB.
//   M4 reword the xslt discrepancy sentence's marker phrase          -> FAIL on the marker (P1 entry).
//   M5 drop audiopreferred's side-A listing token                    -> FAIL on sideA (sweep entry).
//   M6 empty a table entry's marker                                  -> FAIL on non-vacuity (guard).
//   M7 drop a sweep-2 entry's side-B token (no-auto-rewind)          -> FAIL on sideB.
//   M8 empty a DATED entry's dates array in the table (webcrypto)    -> FAIL on the dated-pages set match.
//   M9 drop autofill-event's side-B token ("autofillValues")         -> FAIL on sideB (N1 entry).
//   M10 empty xsltprocessor's dates array in the table               -> FAIL on the dated-pages set match.
//   M11 M8d fabrication replayed (empty webcrypto's dates AND stuff  -> FAIL on the set match in BOTH
//       css-border-shape's with a page-present token)                   directions (gendn-j3d item 1).
//   M12 drop the hub route's side-B token (WindowOrWorkerGlobalScope)-> FAIL on sideB (gendn-j3d item 2).
// Each restored to green. A check that cannot fail on a silently dropped side is a claim, not
// a detector (rule 64: the signal must be shown to fire on the shape it was added for).
//
// Run: deno task test-source-disagreement

const PAGES = [
  {
    // The founding case (gendn-8pq): ChromeStatus says "Proposed" (updated 2026-09-11); BCD
    // records Chrome 155 experimental (fetched 2026-10-06). The page states both and says so.
    page: "v151/algorithm-updates-in-webcrypto/index.html",
    marker: "sources disagree and the page reports both",
    sideA: ["ChromeStatus", "updated 2026-09-11"],
    sideB: ["BCD"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-6ih's note (on the fdh page): chromestatus API status text "Proposed" with ship
    // estimate (accurate as of 2026-08-24) versus the trunk runtime feature reading stable on
    // desktop. The note distinguishes the two runtime features and their differing statuses.
    page: "v150/webrtc-diagnostic-logging-api/index.html",
    // Re-anchored per review (P3): the marker must sit inside the sentence carrying the
    // divergence, not on the note's LABEL, which would survive a rewrite dropping the prose.
    marker: "the surface on this page is enabled by the runtime feature",
    sideA: ["chromestatus API", "2026-08-24", "Proposed"],
    sideB: ["runtime_enabled_features.json5", "stable on desktop"],
    dates: [],
  },
  {
    // Chrome 147 shipped the two-shape form (launch article via the ChromeStatus record's
    // sample link) while the current draft grammar shows a space-separated repetition form.
    // The page carries the divergence and tells the reader to test in the browser. No dates
    // are carried by this note, so none are pinned — the check pins what the page states.
    page: "v147/css-border-shape/index.html",
    marker: "Where they disagree, test in the browser",
    sideA: ["shipped the two-shape form"],
    sideB: ["current draft grammar"],
    dates: [],
  },
  {
    // The working-draft specification and Chromium's shipping IDL disagree on the surface
    // shape; the page carries both and states the disposition (shipping contract wins for
    // implementation; the draft may converge) without deleting either side.
    page: "v153/capability-elements-camera-and-microphone/index.html",
    marker: "currently disagree on the surface shape",
    sideA: ["working-draft specification"],
    sideB: ["shipping IDL"],
    dates: [],
  },
  {
    // Found by the cross-family review sweep (P1): the page itself records the discrepancy —
    // the removal guide says pre-stable disabling began in M145 Canary while the ChromeStatus
    // experiment plan says M148 (Mar 10, 2026 Canary). Both sides carried, both attributed.
    page: "v152/deprecate-and-remove-xslt/index.html",
    marker: "One source discrepancy is recorded honestly",
    sideA: ["removal guide", "M145"],
    sideB: ["ChromeStatus", "M148"],
    dates: ["Mar 10, 2026"],
  },
  {
    // Found by the same sweep: the milestone listing files the feature id under "In developer
    // trial (Behind a flag)" while the Blink runtime feature reads stable at trunk — the same
    // status-disagreement shape as the v150 entry, carried with attribution and a verification
    // date (2026-07-28). Added rather than excluded: it meets the family's definition.
    page: "v152/audiopreferred-capture-in-getdisplaymedia-api/index.html",
    marker: "a duplicate-row quirk on the record",
    sideA: ["In developer trial (Behind a flag)"],
    sideB: ["GetDisplayMediaAudioSelection", "at trunk"],
    dates: ["2026-07-28"],
  },
  {
    // Found by the second review's divergence-vocabulary sweep: a DEDICATED
    // "Spec-vs-implementation divergence (read before citing)" block — three layers out of
    // sync, each claim labelled with its layer. Side A = the spec layers (animation-triggers-1
    // ED's pre-resolution table; web-animations-2 ED's OLD trigger model, which Chromium does
    // not implement); side B = Chromium 151 shipping the #12611 action-set model. Per-layer
    // fetch dates carried, so dates pinned.
    page: "v151/no-auto-rewind-for-animationtrigger-play-methods/index.html",
    marker: "Spec-vs-implementation divergence",
    sideA: [
      "animation-triggers-1 ED",
      "web-animations-2",
      "Chromium does not implement that shape",
    ],
    sideB: ["Chromium 151", "#12611 action-set model"],
    dates: ["fetched 2026-07-28"],
  },
  {
    // Same sweep: the normative WICG IDL associates the manager with Window, while
    // Chromium's binding is WindowOrWorkerGlobalScope — the page names the gap an
    // implementation/spec divergence and refuses to treat worker usability as normative.
    // No dates carried by this note, so none are pinned.
    page: "v147/web-printing-api/entry-point/index.html",
    marker: "not a normative worker contract",
    sideA: ["normative IDL"],
    sideB: ["WindowOrWorkerGlobalScope"],
    dates: [],
  },
  {
    // Same sweep, and the fixture's own philosophy verbatim in the page's lede: "records the
    // divergence rather than selecting a settled form". Four sources conflict on the header
    // grammar (ED header section sf-string vs the ED cache algorithm vs Chromium's ParseList
    // vs the Chrome developer guide); side A = the draft's two voices, side B = Chromium's
    // parser. No dates carried by this note, so none are pinned.
    page: "v147/device-bound-session-credentials/challenge-header/index.html",
    marker: "conflicting source descriptions",
    sideA: ["sf-string", "cache algorithm"],
    sideB: ["Chromium parser code", "ParseList", "developer guide"],
    dates: [],
  },
  {
    // Found by the second delta-confirmation's re-sweep (N1): the non-normative explainer
    // describes a non-bubbling event with a booleans-carrying values property; the current
    // spec IDL defines bubbling and autofillValues with DOMString values. The page states
    // its disposition ("This page documents the spec") yet carries BOTH sides with
    // attribution and read dates — the same shape as capability-elements, admitted under
    // the same qualifying reading. The first reviewer would have excluded it as fdh-family
    // (a superseded explainer); both readings are recorded here and the pin adjudicates
    // nothing either way — it only fails if a side stops being carried.
    page: "v147/autofill-event/index.html",
    marker: "Note on divergence",
    sideA: ["non-normative explainer", "can carry booleans"],
    sideB: ["current spec IDL", "autofillValues"],
    dates: ["Read 2026-10-04"],
  },
  {
    // Found by the first delta-confirmation's re-sweep: the spec (CSS Animations L2 partial
    // interface) types the attribute as the CSS subclass; Chromium's bindings type it as the
    // Web Animations base interface. Both quoted and linked; structurally identical to the
    // web-printing entry-point entry. No dates carried, so none pinned.
    page:
      "v151/animation-accessor-on-animation-and-transition-events/animationevent-animation/index.html",
    marker: "Implementation divergence:",
    sideA: ["drafts.csswg.org/css-animations-1"],
    sideB: ["bindings type the attribute", "animation_event.idl"],
    dates: [],
  },
  {
    // Same sweep, sibling page: the same spec-vs-bindings divergence for TransitionEvent.
    // Pinned separately — two subpages of one feature are two carriage sites, and the
    // assertion names disambiguate them (see the .at(-2) note below).
    page:
      "v151/animation-accessor-on-animation-and-transition-events/transitionevent-animation/index.html",
    marker: "Implementation divergence:",
    sideA: ["drafts.csswg.org/css-transitions-1"],
    sideB: ["Web Animations base interface", "transition_event.idl"],
    dates: [],
  },
  {
    // Same sweep: a five-item "Key divergences between the spec text and the shipping
    // implementation" list with WHATWG and Chromium sources both fetched 2026-07-29.
    // Side A = the WHATWG spec text; side B = Chromium's gated shipping implementation.
    page: "v152/deprecate-and-remove-xslt/xsltprocessor/index.html",
    marker: "spec text and the shipping implementation",
    sideA: ["WHATWG text"],
    sideB: ["[RuntimeEnabled=XSLT]", "Chromium gates the whole interface"],
    dates: ["fetched 2026-07-29"],
  },
  {
    // Same sweep: the ChromeStatus origin-trial metadata and the json5 comment both say
    // performance.speculations, while the WICG explainer and Chromium's experimental IDL
    // expose a method, performance.getSpeculations(). The page keeps the divergence
    // visible; the audiopreferred naming/status shape. No dates carried, so none pinned.
    page: "v150/speculative-load-measurement/index.html",
    marker: "Naming divergence to be aware of",
    sideA: ["performance.speculations"],
    sideB: ["performance.getSpeculations()"],
    dates: [],
  },
  {
    // Added from the r3m residuals bead (gendn-j3d item 2): the HUB route carries the same
    // divergence note in its member table as its pinned child (entry-point) — a second
    // carriage site, so a second regression surface; if the hub's copy silently loses one
    // side, nothing failed before this entry. Pinned under the pair precedent set by the
    // animation-accessor subpages: where a note is duplicated, both copies are pinned.
    page: "v147/web-printing-api/index.html",
    marker: "is a Chromium implementation divergence",
    sideA: ["normative Window entry point"],
    sideB: ["WindowOrWorkerGlobalScope", "worker usability is unknown"],
    dates: [],
  },
  {
    // gendn-c26, applied in-unit per coord's 22:30Z ruling (a divergence found in a page already open in a B1 unit is fixed in that unit). The page records the Chrome 147 developer trial while its own cited ChromeStatus record reads Proposed; the record's stages array states the reconciliation itself (DevTrial stage at 147, active ship stage at 149), so both sides are carried and neither is chosen.
    page: "v147/clip-text-overflow-on-user-interaction/index.html",
    marker: "Status disagreement, both sides reported rather than resolved",
    sideA: ["Chrome 147 developer trial"],
    sideB: ["5146265241387008", "Proposed", "ship-target-149"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-idm: the page's rollout milestone disagreed with its own cited ChromeStatus record, and a second feature id the page cited no longer resolves. The dead link was removed and the milestone divergence is now disclosed on the page.
    page: "v147/local-network-access-restrictions/index.html",
    marker: "Rollout disagreement, both sides reported rather than resolved",
    sideA: ["started in Chrome 123"],
    sideB: ["5152728072060928", "In development", "desktop 142"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-1v5: the page recorded the feature as shipped while its cited ChromeStatus record still reads Proposed with accurate_as_of 2026-03-24.
    page: "v147/local-network-access-restrictions-for-webtransport/index.html",
    marker: "Shipped-versus-proposed disagreement, both sides reported rather than resolved",
    sideA: ["records the feature as shipped"],
    sideB: ["5126430912544768", "Proposed", "accurate_as_of"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-aji: the cited draft has since been published as RFC 10024, which declares the X25519Kyber768Draft00 registry entry obsolete while the page still presents both groups as things to support.
    page: "v147/x25519kyber768-key-encapsulation-for-tls/index.html",
    marker: "Group-status disagreement, both sides reported rather than resolved",
    sideA: ["X25519Kyber768Draft00"],
    sideB: ["RFC 10024", "obsolete", "draft-tls-westerbaan-xyber768d00-02"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // Sibling case of gendn-1v5 on the WebSockets page, found by the IMPLEMENTER re-fetching the source after the
    // worker reported "no source disagreements found": same class as the two sibling LNA pages (page says shipped,
    // the cited record still reads Proposed with is_released false). Disclosed in-unit per coord's 22:30Z ruling.
    page: "v147/local-network-access-restrictions-for-websockets/index.html",
    marker: "Shipped-versus-recorded-status disagreement, both sides reported rather than resolved",
    sideA: ["the feature as shipped in Chrome 147"],
    sideB: ["5197681148428288", "is_released false", "accurate_as_of"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-xpz wave-2a: the page documented migration_target/migration_source while the merged WICG PR #136
    // defines migrate_to/migrate_from. Verified by the implementer against the PR's own diff (the page's names
    // appear zero times there) and disclosed in-unit per coord's 22:30Z ruling.
    page: "v147/pwa-origin-migration/index.html",
    marker: "Specification divergence, both sides reported rather than resolved",
    sideA: ["migration_target", "migration_source"],
    sideB: ["migrate_to", "migrate_from", "web-app-origin-association", "allow_migration"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-xpz wave-2a: the page attributed rawgamepadinputchange to the W3C Gamepad spec, which contains the
    // name ZERO times, and described a developer trial the ChromeStatus record does not show. Verified by the
    // implementer by fetching both, disclosed in-unit per coord's 22:30Z ruling.
    page: "v147/gamepad-event-driven-input-api/index.html",
    marker: "Evidence divergence, both sides reported rather than resolved",
    sideA: ["rawgamepadinputchange"],
    sideB: ["gamepad-raw-input-change-event", "Start incubating", "5989275208253440"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-xpz wave-2a: page said the removal shipped in 147 across all platforms while the cited record reads
    // Proposed with no iOS milestone, and every 147-specific claim rests on that record alone. Verified by the
    // implementer; disclosed in-unit per coord's 22:30Z ruling.
    page: "v147/remove-inline-xslt-for-production-of-svg/index.html",
    marker: "Removal-status divergence, both sides reported rather than resolved",
    sideA: ["Chrome 147 removes support"],
    sideB: ["5143784390262784", "no iOS milestone at all", "5777/5778"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-xpz wave-2a: page presented a flag-gated Developer trial; the record says Proposed with no milestone
    // and "remaining gated by Document Policy", and the cited spec really does define js-profiling-mode /
    // NotAllowedError. Verified by the implementer; disclosed in-unit per coord's 22:30Z ruling.
    page: "v147/js-profiling-in-dedicated-workers/index.html",
    marker: "Gating and status divergence, both sides reported rather than resolved",
    sideA: ["Developer trial"],
    sideB: ["5159559872249856", "remaining gated by Document Policy", "js-profiling-mode"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-xpz wave-2b: verified by the implementer by re-fetching, disclosed in-unit per coord's 22:30Z ruling.
    page: "v147/webxr-plane-detection/index.html",
    marker: "Shipped-versus-origin-trial divergence, both sides reported rather than resolved",
    sideA: ["v147 \u00b7 web api \u00b7 shipped"],
    sideB: ["5732397976911872", "Origin trial", "Android milestone of 77"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-xpz wave-2b: verified by the implementer by re-fetching, disclosed in-unit per coord's 22:30Z ruling.
    page: "v147/webnn/index.html",
    marker: "Snapshot divergence, both sides reported rather than resolved",
    sideA: ["matMul"],
    sideB: ["matmul", "dispatch"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-xpz wave-2b: verified by the implementer by re-fetching, disclosed in-unit per coord's 22:30Z ruling.
    page: "v147/web-neural-network-api-webnn/index.html",
    marker: "Standards-status divergence, both sides reported rather than resolved",
    sideA: ["W3C Candidate Recommendation"],
    sideB: ["Candidate Recommendation Draft"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-xpz wave-2b: verified by the implementer by re-fetching, disclosed in-unit per coord's 22:30Z ruling.
    page: "v147/pseudo-target-on-events/index.html",
    marker: "Status and specification divergence, both sides reported rather than resolved",
    sideA: ["Enabled by default"],
    sideB: ["5179328935624704", "is_released false", "UI Events"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-xpz: sibling LNA divergence on the service-worker page, disclosed LATE - the in-unit ruling had been
    // applied to the four BEADS rather than the four PAGES carrying disclosures, so this unit was missed until a
    // batch-wide consistency check caught that it alone had no disclosure paragraph.
    page:
      "v147/local-network-access-restrictions-on-service-worker-windowclient-navigate/index.html",
    marker: "Status and scope divergence, both sides reported rather than resolved",
    sideA: ["Enabled by default", "as shipped in Chrome 147"],
    sideB: ["5172375182245888", "Proposed", "Shipped/Shipping"],
    dates: ["fetched 2026-10-06"],
  },
  {
    // gendn-g8o (B3 unit 1): the page's Safari cell and its summary status disagree with the ChromeStatus
    // record the page itself cites. The record's own stage data AGREES with the page (149 dev trial, 150
    // shipping), so only the Safari view and the summary status are in dispute; neither side is adjudicated.
    page: "v149/comma-separated-container-queries/index.html",
    marker: "Safari and release-status disagreement, both sides reported rather than resolved",
    sideA: ["No signal", "Chrome 150"],
    sideB: ["6196591858941952", "Support", "Proposed"],
    dates: ["fetched 2026-10-07"],
  },
];

let failures = 0;
function assert(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures++;
}

// Non-vacuity: the table must carry at least the pages measured so far, and every entry must
// have a NON-EMPTY marker (html.includes("") is vacuously true), BOTH sides, and a dates
// ARRAY (an absent one would throw an unnamed TypeError instead of failing a named check).
assert(
  "table is non-vacuous: at least fifteen carried-disagreement pages, each with a non-empty marker, BOTH sides pinned, and a dates array",
  PAGES.length >= 15 &&
    PAGES.every(
      (e) =>
        typeof e.marker === "string" && e.marker.length > 0 &&
        e.sideA.length > 0 && e.sideB.length > 0 && Array.isArray(e.dates),
    ),
  `${PAGES.length} entries`,
);

// Dated-pages set, NAMED not counted (gendn-j3d item 1): the previous floor was a COUNT,
// and a count is defeatable by deliberate fabrication — measured M8d: empty one dated
// entry's dates AND stuff another entry's dates with a page-present token, the count holds
// and the fixture exits 0 while a real dated page has been shed. Naming the pages makes
// both halves of that fabrication fail: a named page whose dates are emptied breaks the
// match, and a dated entry that is NOT named breaks it too. The set matches the table
// EXACTLY in both directions; adding or removing a dated page is a deliberate two-site
// edit (table + set), which is what a curated table should force.
// THE HONEST BOUNDARY (review-demonstrated, not theoretical): this guards MEMBERSHIP, not
// token content. Weakening a named page's date token to a shorter page-present substring,
// or swapping co-present tokens between two named pages, stays green — and anyone willing
// to edit pinned tokens can equally rewrite this set. That is the ceiling of a
// self-contained fixture; what the set buys is raising fabrication from an invisible
// array-shuffle (the old count) to a deliberate rewrite of the guard's own pinned data.
// A token-alignment tightening (audiopreferred -> "fetched 2026-07-28") was evaluated and
// REJECTED by measurement: that spelling sits in different notes on that page (:72, :102),
// not in the divergence note whose own date the entry pins — trading a true anchor for
// swap-resistance would violate the dates array's contract (the NOTE's date tokens).
const DATED_PAGES = new Set([
  "v151/algorithm-updates-in-webcrypto/index.html",
  "v152/deprecate-and-remove-xslt/index.html",
  "v152/audiopreferred-capture-in-getdisplaymedia-api/index.html",
  "v151/no-auto-rewind-for-animationtrigger-play-methods/index.html",
  "v147/autofill-event/index.html",
  "v152/deprecate-and-remove-xslt/xsltprocessor/index.html",
  "v147/local-network-access-restrictions-on-service-worker-windowclient-navigate/index.html",
  "v147/webxr-plane-detection/index.html",
  "v147/webnn/index.html",
  "v147/web-neural-network-api-webnn/index.html",
  "v147/pseudo-target-on-events/index.html",
  "v147/js-profiling-in-dedicated-workers/index.html",
  "v147/remove-inline-xslt-for-production-of-svg/index.html",
  "v147/gamepad-event-driven-input-api/index.html",
  "v147/pwa-origin-migration/index.html",
  "v147/local-network-access-restrictions-for-websockets/index.html",
  "v147/clip-text-overflow-on-user-interaction/index.html",
  "v147/local-network-access-restrictions/index.html",
  "v147/local-network-access-restrictions-for-webtransport/index.html",
  "v147/x25519kyber768-key-encapsulation-for-tls/index.html",
  "v149/comma-separated-container-queries/index.html",
]);
const datedInTable = new Set(PAGES.filter((e) => e.dates.length > 0).map((e) => e.page));
assert(
  "dated-pages set matches the table exactly in BOTH directions (a count is defeatable by membership fabrication; a named match is not — token edits within named pages are the recorded ceiling)",
  DATED_PAGES.size === datedInTable.size &&
    [...DATED_PAGES].every((p) => datedInTable.has(p)) &&
    [...datedInTable].every((p) => DATED_PAGES.has(p)),
  `named ${DATED_PAGES.size}, table ${datedInTable.size}`,
);

for (const entry of PAGES) {
  // .at(-2), not [1]: two pinned pages are SUBPAGES of one feature (the animation-accessor
  // pair), whose [1] segments are identical — the distinguishing name is the last directory.
  const short = entry.page.split("/").at(-2);
  let html;
  try {
    html = await Deno.readTextFile(entry.page);
  } catch (err) {
    assert(`${short}: page readable`, false, `${err.name}: ${err.message}`);
    continue;
  }
  assert(
    `${short}: the sentence carrying the disagreement is still present (marker text, not line number)`,
    html.includes(entry.marker),
    html.includes(entry.marker) ? "" : `missing marker: ${JSON.stringify(entry.marker)}`,
  );
  const missA = entry.sideA.filter((t) => !html.includes(t));
  assert(
    `${short}: side A of the disagreement is still attributed (this check never says A is right)`,
    missA.length === 0,
    missA.length ? `missing side-A token(s): ${missA.join(", ")}` : "",
  );
  const missB = entry.sideB.filter((t) => !html.includes(t));
  assert(
    `${short}: side B of the disagreement is still attributed (this check never says B is right)`,
    missB.length === 0,
    missB.length ? `missing side-B token(s): ${missB.join(", ")}` : "",
  );
  if (entry.dates.length > 0) {
    const missD = entry.dates.filter((t) => !html.includes(t));
    assert(
      `${short}: the note's as-of date(s) survive — a disagreement without dates is unauditable`,
      missD.length === 0,
      missD.length ? `missing date token(s): ${missD.join(", ")}` : "",
    );
  }
}

if (failures > 0) {
  console.error(`source-disagreement fixture: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(
  `source-disagreement fixture: all assertions passed (${PAGES.length} carried-disagreement pages, both sides attributed, none adjudicated)`,
);
