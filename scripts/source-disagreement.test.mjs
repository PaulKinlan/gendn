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
// The table was scoped by MEASUREMENT, not from the filing's count: the filing named three
// pages; a grep of main's content tree for explicit disagreement language found FOUR carried
// notes (the fourth, capability-elements, states its disagreement as explicitly as the others),
// so all four are pinned. A new page that gains a carried disagreement should be ADDED here;
// that is a deliberate act, which is exactly what this fixture forces.
//
// MUTATION PROOFS (logs on the bead, not inline; cp-based backups per rule 107):
//   M1 delete the carried disagreement sentence (webcrypto marker)  -> FAIL on the marker.
//   M2 drop a date token ("updated 2026-09-11" -> "updated")         -> FAIL on the dates.
//   M3 drop one side's attribution (webrtc trunk token renamed)      -> FAIL on sideB.
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
    marker: "Implementation/debug note",
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
];

let failures = 0;
function assert(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures++;
}

// Non-vacuity: the table must carry at least the pages the campaign measured, and every entry
// must have BOTH sides — an entry with one side would silently downgrade the check's meaning.
assert(
  "table is non-vacuous: at least four carried-disagreement pages, each with BOTH sides pinned",
  PAGES.length >= 4 && PAGES.every((e) => e.sideA.length > 0 && e.sideB.length > 0),
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
    `missing marker: ${JSON.stringify(entry.marker)}`,
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
