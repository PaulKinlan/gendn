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
// coverage claim wider than the code removes a check): the filing named three pages; a
// vocabulary grep of main's content tree ("disagree" and kin) found the fourth
// (capability-elements); the cross-family review sweep found TWO MORE that no vocabulary
// grep surfaces — v152/deprecate-and-remove-xslt ("One source discrepancy is recorded
// honestly") and v152/audiopreferred-capture-in-getdisplaymedia-api (listing status vs
// trunk status). So SIX pages are pinned. The boundary: a disagreement carried WITHOUT
// explicit disagreement vocabulary is invisible to sweeps — this TABLE is the coverage, it
// is not complete by construction, and widening it is a deliberate act. A new page that
// gains a carried disagreement should be ADDED here; a side silently dropped from a pinned
// page fails, which is the failure mode the check exists for.
//
// MUTATION PROOFS (logs on the bead, not inline; cp-based backups per rule 107):
//   M1 delete the carried disagreement sentence (webcrypto marker)  -> FAIL on the marker.
//   M2 drop a date token ("updated 2026-09-11" -> "updated")         -> FAIL on the dates.
//   M3 drop one side's attribution (webrtc trunk token renamed)      -> FAIL on sideB.
//   M4 reword the xslt discrepancy sentence's marker phrase          -> FAIL on the marker (P1 entry).
//   M5 drop audiopreferred's side-A listing token                    -> FAIL on sideA (sweep entry).
//   M6 empty a table entry's marker                                  -> FAIL on non-vacuity (guard).
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
  "table is non-vacuous: at least six carried-disagreement pages, each with a non-empty marker, BOTH sides pinned, and a dates array",
  PAGES.length >= 6 &&
    PAGES.every(
      (e) =>
        typeof e.marker === "string" && e.marker.length > 0 &&
        e.sideA.length > 0 && e.sideB.length > 0 && Array.isArray(e.dates),
    ),
  `${PAGES.length} entries`,
);

for (const entry of PAGES) {
  const short = entry.page.split("/")[1];
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
