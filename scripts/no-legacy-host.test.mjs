// scripts/no-legacy-host.test.mjs — gendn stays off its retired Deno Deploy hosts.
//
// WHY THIS EXISTS: on 2026-11-26 the sister showcase's old host answered 404 for every path while
// gendn still framed, linked and CSP-allowed it, so 142 embedded demos were broken in production.
// The move to the Cloudflare Workers origins touched ~380 files; this fixture is what keeps the old
// host from drifting back in through a copied snippet, a regenerated suite or a stale instruction.
//
// WHAT IT ASSERTS (browser-free, no network, deterministic):
//   1. No tracked or untracked-but-not-ignored file mentions the retired host, in plain form, in
//      regex-escaped form (`deno\.net`), or by the account slug alone - EXCEPT the historical
//      records in ALLOWLIST below, each listed with the reason it is history and not a live link.
//   2. The exception is as narrow as the record allows. For JSON records it is FIELD-scoped: a
//      critique may keep the old URL in a dated `rubric[].evidence` sentence, but the same file may
//      not carry it anywhere else; migrations.json may keep it in `from`/`reason`/`evidence`, and
//      in `to` only for records dated before the move.
//   3. The detector itself fires (negative cases over in-memory files), so a green run is not a
//      scanner that stopped matching.
//
// LIMITS, stated rather than implied: this is a textual scan of the working tree. It does not
// prove that the NEW origins are reachable (that is acceptance evidence, not a fixture), and an
// allowlist entry that no longer matches anything is reported as a NOTE, not a failure, because
// critiques are mutable and the routine that rewrites one cannot edit this file.
//
// Run: node scripts/no-legacy-host.test.mjs

import * as sys from "./lib/sys.mjs";
import { runGit } from "./lib/bounded-git.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
/** The day gendn and the showcase finished leaving Deno Deploy. */
const MOVE_DATE = "2026-11-26";

// One match per mention: a retired hostname in plain form, in regex-escaped form (`deno\.net`
// inside a regex literal, `deno\\.net` when that regex sits inside JSON), the account slug on its
// own (it appears nowhere except in the retired hostnames), or a bare `deno.net`.
export const LEGACY_HOST_RE = /paulkinlan-ea(?:\\*\.deno\\*\.net)?|deno\\*\.net/gi;

const EVIDENCE_FIELD = /^\.rubric\[\d+\]\.evidence$/;

// Critiques whose dated evidence sentences quote the old URL they measured ("HEAD check on <url>
// returned 404 on 2026-11-24", "Feature route ... returned 200 on 2026-11-15"). Rewriting the host
// would falsify what was observed, on which host, on that date.
const DATED_CRITIQUES = [
  "v148/container-timing",
  "v148/idna-contextj-rules",
  "v148/manifest-localization",
  "v150/speculative-load-measurement",
  "v150/webrtc-diagnostic-logging-api",
  "v151/algorithm-updates-in-webcrypto",
  "v151/declarative-performance-observer",
  "v152/sub-apps",
  "v152/window-shape-api",
  "v158/css-flow-start-and-flow-end-alignment-keywords",
  "v158/object-fit-and-object-position-apply-to-svg-documents-in-object-and-embed",
  "v158/offlineaudiocontext-incremental-rendering",
  "v158/opening-links-in-a-split-tab",
  "v158/source-specific-multicast-for-direct-sockets-api",
  "v158/support-for-webhid",
  "v158/svg-textpath-side-attribute",
  "v158/web-install-api",
  "v158/webtransport-draining",
  "v159/accentcolor-accentcolortext-follows-accent-color-value",
  "v159/background-layer-count-independence",
  "v159/cssimportrule-stylesheet",
  "v159/mediasession-return-promise-undefined-from-setmicrophoneactive-and-setcameraacti",
  "v159/scroll-snap-for-single-axis-scroll-containers",
  "v159/serviceworker-static-routing-distinct-typeerror-message-for-cancelled-race-netwo",
  "v159/web-authentication-conditional-ui-passive-mode",
  "v159/webtransport-congestion-control",
  "v159/webtransport-datagram-readable-stream-type",
  "v159/webtransport-keying-material-export",
  "v159/webtransport-send-groups-and-send-stream-prioritization",
  "v159/webtransporterror-api-alignment-and-serialization",
  "v160/canvas2d-tone-mapping",
  "v160/capability-elements-icon-only-mode",
  "v160/case-sensitive-anchor-name-matching-in-quirks-mode",
  "v160/csspseudoelement-selectortext",
  "v160/enhanced-canvas-textmetrics",
  "v160/spec-compliant-xml-mime-type-detection",
  "v160/svg-path-data-api",
  "v160/view-transitions-shadowroots-option-in-startviewtransition",
  "v160/web-bluetooth-bluetoothremotegattserver-maxwritewithoutresponsesize",
  "v160/webapplaunch-user-activation-on-focus-existing-launch-delivery",
  "v161/translator-api-on-android",
];

/**
 * Every place the retired host may still appear. `allows(path, value, document)` receives the JSON
 * path of the string leaf that matched; an entry without it allows the whole file.
 */
export const ALLOWLIST = [
  {
    file: ".route-manifest.baseline.json",
    reason:
      "dated offline fallback snapshot of the manifest as it was published; check-routes reads it only when origin/main is unreachable and it is never regenerated, so its demo URLs are history",
  },
  {
    file: "migrations.json",
    reason:
      "append-only provenance: the `from` value of each host-move record IS the retired URL, and older records describe changes that were made while that host was live",
    allows: (path, _value, document) => {
      const match = path.match(/^\[(\d+)\]\.(from|to|reason|evidence)$/);
      if (!match) return false;
      if (match[2] !== "to") return true;
      // A record may only point TO the retired host if it predates the move.
      const date = document[Number(match[1])]?.date;
      return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < MOVE_DATE;
    },
  },
  {
    file: "v149/inline-script-cache/reference-contract.json",
    reason:
      "the contract's `notes` field records a dated verification ('curl-verified HTTP 200 on 2026-10-07') of the URL as it then was; its live `sources[].url` values were repointed",
    allows: (path) => path === ".notes",
  },
  ...DATED_CRITIQUES.map((id) => ({
    file: `${id}/_questions.json`,
    reason:
      "dated critique evidence: a rubric evidence sentence quoting the URL that was measured on the old host on a stated date",
    allows: (path) => EVIDENCE_FIELD.test(path),
  })),
  {
    file: "scripts/no-legacy-host.test.mjs",
    reason:
      "this guard: it has to spell the retired host to build its detector fixtures and negative cases",
  },
];

function* stringLeaves(node, path = "") {
  if (typeof node === "string") yield [path, node];
  else if (Array.isArray(node)) {
    for (const [index, value] of node.entries()) yield* stringLeaves(value, `${path}[${index}]`);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      // A key is text too: a host hidden in a property name is still a mention.
      yield [`${path}.${key}#key`, key];
      yield* stringLeaves(value, `${path}.${key}`);
    }
  }
}

const mentions = (text) => text.match(LEGACY_HOST_RE)?.length ?? 0;

/**
 * Pure scan. `files` is an iterable of [repo-relative path, text]. Returns the violations, the
 * allowlist entries that matched (with counts) and the entries that matched nothing.
 */
export function scan(files, allowlist = ALLOWLIST) {
  const byFile = new Map(allowlist.map((entry) => [entry.file, entry]));
  const violations = [];
  const allowed = new Map();
  for (const [file, text] of files) {
    const count = mentions(text);
    if (count === 0) continue;
    const entry = byFile.get(file);
    if (!entry) {
      violations.push(`${file}: ${count} mention(s) of the retired host and no allowlist entry`);
      continue;
    }
    if (!entry.allows) {
      allowed.set(file, count);
      continue;
    }
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      // Field scoping cannot be checked on a file that does not parse: fail closed.
      violations.push(`${file}: field-scoped allowlist entry, but the file is not valid JSON`);
      continue;
    }
    let ok = 0;
    for (const [path, value] of stringLeaves(document)) {
      const here = mentions(value);
      if (here === 0) continue;
      if (!path.endsWith("#key") && entry.allows(path, value, document)) ok += here;
      else violations.push(`${file}: retired host in ${path}, which this record does not allow`);
    }
    if (ok) allowed.set(file, ok);
  }
  const unused = allowlist.map((entry) => entry.file).filter((file) => !allowed.has(file));
  return { violations, allowed, unused };
}

let failures = 0;
let passed = 0;
function assert(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failures++;
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// ---- 1. the allowlist is well-formed: every exception names its reason exactly once ----
assert(
  "every allowlist entry carries a real reason",
  ALLOWLIST.every((entry) => typeof entry.reason === "string" && entry.reason.length >= 40),
);
assert(
  "no file is allowlisted twice",
  new Set(ALLOWLIST.map((entry) => entry.file)).size === ALLOWLIST.length,
);

// ---- 2. the detector fires (in-memory negative cases; nothing here touches the tree) ----
const LEGACY_SUFFIX = "paulkinlan-ea.deno.net";
const LEGACY = `chrome-platform-showcase.${LEGACY_SUFFIX}`;
const LIVE = "chrome-platform-showcase.kinlan-test.workers.dev";
const critique = (fields) => JSON.stringify({ id: "v900/probe", rubric: [], ...fields });
const fixture = [
  {
    file: "v900/probe/_questions.json",
    reason: "x".repeat(40),
    allows: (p) => EVIDENCE_FIELD.test(p),
  },
  ALLOWLIST.find((entry) => entry.file === "migrations.json"),
];
const violationsFor = (files) => scan(files, fixture).violations;

assert(
  "detector: a live-origin URL is not a violation",
  violationsFor([["v900/x/index.html", `<iframe src="https://${LIVE}/v900/x/"></iframe>`]])
    .length === 0,
);
assert(
  "detector: the retired host in an unlisted page is a violation",
  violationsFor([["v900/x/index.html", `<iframe src="https://${LEGACY}/v900/x/"></iframe>`]])
    .length === 1,
);
assert(
  "detector: the regex-escaped form in source code is a violation",
  violationsFor([["scripts/lib/x.mjs", `const re = /${LEGACY.replace(/\./g, "\\.")}\\//;`]])
    .length === 1,
);
assert(
  "detector: the account slug alone, or the gendn legacy host, is a violation",
  violationsFor([["CLAUDE.md", "legacy URL https://gendn.paulkinlan-ea.example/"]]).length === 1 &&
    violationsFor([["schema/x.schema.json", `{"$id":"https://gendn.${LEGACY_SUFFIX}/x"}`]])
      .length === 1,
);
assert(
  "detector: dated evidence in a LISTED critique is allowed",
  violationsFor([[
    "v900/probe/_questions.json",
    critique({ rubric: [{ evidence: `HEAD ${LEGACY}/v900/probe/ returned 404 on 2026-11-24` }] }),
  ]]).length === 0,
);
assert(
  "detector: the same critique may not carry the host outside rubric[].evidence",
  violationsFor([[
    "v900/probe/_questions.json",
    critique({ demo: `https://${LEGACY}/v900/probe/`, rubric: [{ evidence: "clean" }] }),
  ]]).length === 1,
);
assert(
  "detector: an UNLISTED critique gets no evidence exemption (new history cannot be minted)",
  violationsFor([[
    "v901/new/_questions.json",
    critique({ rubric: [{ evidence: `checked https://${LEGACY}/v901/new/` }] }),
  ]]).length === 1,
);
assert(
  "detector: a field-scoped record that is not valid JSON fails closed",
  violationsFor([["v900/probe/_questions.json", `{ "rubric": "${LEGACY}" `]]).length === 1,
);
const migration = (to, date) =>
  JSON.stringify([{
    id: "v900/probe",
    action: "demo-change",
    from: `https://${LEGACY}/a/`,
    to,
    date,
  }]);
assert(
  "detector: a migration may name the retired host in `from`, and in `to` only before the move",
  violationsFor([["migrations.json", migration(`https://${LIVE}/a/`, MOVE_DATE)]]).length === 0 &&
    violationsFor([["migrations.json", migration(`https://${LEGACY}/b/`, "2026-11-22")]])
      .length === 0 &&
    violationsFor([["migrations.json", migration(`https://${LEGACY}/b/`, MOVE_DATE)]])
      .length === 1 &&
    violationsFor([["migrations.json", migration(`https://${LEGACY}/b/`, "2027-01-05")]])
      .length === 1,
);

// ---- 3. the real tree ----
let listed = null;
try {
  const result = await runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    stdout: "piped",
    stderr: "piped",
    cwd: ROOT,
  });
  if (result.code === 0) listed = result.stdout.split("\0").filter(Boolean);
  else console.error(`git ls-files failed: ${result.stderr.trim()}`);
} catch (error) {
  console.error(`git ls-files failed: ${error.message}`);
}
assert(
  "the repository's files can be enumerated (an unreadable tree is not a clean tree)",
  listed !== null && listed.length > 500,
  listed === null ? "git ls-files unavailable" : `${listed.length} files`,
);

const files = [];
for (const file of listed ?? []) {
  try {
    files.push([file, await sys.readTextFile(`${ROOT}/${file}`)]);
  } catch (error) {
    // Tracked but deleted in the working tree: nothing on disk to carry the host.
    if (!(error instanceof sys.errors.NotFound)) throw error;
  }
}
const real = scan(files);
assert(
  `no file outside the allowlist mentions the retired host (${files.length} files scanned)`,
  real.violations.length === 0,
  `\n  ${real.violations.join("\n  ")}`,
);
const total = [...real.allowed.values()].reduce((sum, count) => sum + count, 0);
console.log(
  `census: ${total} historical mention(s) across ${real.allowed.size} allowlisted file(s) of ${ALLOWLIST.length} entries`,
);
for (const file of real.unused) {
  console.log(`NOTE: allowlist entry no longer matches anything (safe to drop): ${file}`);
}

console.log(`\nno-legacy-host fixture: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
