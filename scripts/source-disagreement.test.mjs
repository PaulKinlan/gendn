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
// The table's provenance is cumulative and its BOUNDARY is stated plainly (rule 67 — a
// coverage claim wider than the code removes a check). FOURTEEN pages are pinned, found in
// six named steps so the method is reproducible: (1) the filing named three pages; (2) a
// vocabulary grep of main's content tree ("disagree" and kin) found the fourth
// (capability-elements); (3) the FIRST cross-family review's sweep found two more that no
// "disagree" grep surfaces (v152/deprecate-and-remove-xslt, "One source discrepancy is
// recorded honestly"; v152/audiopreferred-capture-in-getdisplaymedia-api, listing status vs
// trunk status); (4) the SECOND, independent review (the bounce) re-swept with DIVERGENCE
// vocabulary and found three more (v151/no-auto-rewind-for-animationtrigger-play-methods,
// v147/web-printing-api/entry-point,
// v147/device-bound-session-credentials/challenge-header); (5) the first
// delta-confirmation's re-sweep found four more (the animation-accessor
// animationevent/transitionevent pair, v152/deprecate-and-remove-xslt/xsltprocessor,
// v150/speculative-load-measurement); (6) the second delta-confirmation's re-sweep found
// one more (v147/autofill-event, "Note on divergence"). Every re-run of a named sweep so
// far has found more pages, so the honest claim is the narrow one: the sweeps are NOT
// exhausted and the table is NOT complete by construction — it IS the coverage. A
// disagreement carried WITHOUT any recognized vocabulary is invisible to sweeps entirely.
// A new page that gains a carried disagreement should be ADDED here; a side silently
// dropped from a pinned page fails, which is the failure mode the check exists for.
//
// MUTATION PROOFS (logs on the bead, not inline; cp-based backups per rule 107):
//   M1 delete the carried disagreement sentence (webcrypto marker)  -> FAIL on the marker.
//   M2 drop a date token ("fetched 2026-10-06" -> "fetched")         -> FAIL on the dates.
//   M3 drop one side's attribution (webrtc trunk token renamed)      -> FAIL on sideB.
//   M4 reword the xslt discrepancy sentence's marker phrase          -> FAIL on the marker (P1 entry).
//   M5 drop audiopreferred's side-A listing token                    -> FAIL on sideA (sweep entry).
//   M6 empty a table entry's marker                                  -> FAIL on non-vacuity (guard).
//   M7 drop a sweep-2 entry's side-B token (no-auto-rewind)          -> FAIL on sideB.
//   M8 empty a DATED entry's dates array in the table (webcrypto)    -> FAIL on the dated-pages floor.
//   M9 drop autofill-event's side-B token ("autofillValues")         -> FAIL on sideB (N1 entry).
//   M10 empty xsltprocessor's dates array in the table               -> FAIL on the dated-pages floor.
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
  "table is non-vacuous: at least fourteen carried-disagreement pages, each with a non-empty marker, BOTH sides pinned, and a dates array",
  PAGES.length >= 14 &&
    PAGES.every(
      (e) =>
        typeof e.marker === "string" && e.marker.length > 0 &&
        e.sideA.length > 0 && e.sideB.length > 0 && Array.isArray(e.dates),
    ),
  `${PAGES.length} entries`,
);

// Dated-pages floor (review finding F3): emptying a DATED entry's array in the table would
// silently drop its dates assertion (the per-entry check is conditional on dates.length > 0).
// Floor = the count measured at authoring (webcrypto, xslt, audiopreferred, no-auto-rewind,
// autofill-event, xsltprocessor); raise it deliberately when a new dated page is pinned.
assert(
  "dated-pages floor: every page measured as carrying as-of dates still pins them",
  PAGES.filter((e) => e.dates.length > 0).length >= 6,
  `${PAGES.filter((e) => e.dates.length > 0).length} dated entries`,
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
