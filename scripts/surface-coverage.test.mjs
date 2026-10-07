// gendn-m7e fixture — SURFACE-COVERAGE ASSERTION. The defect class: a contract can pass
// every gate while mapping a dimension to the WRONG surface (id exists, slice 40+ chars,
// but the claimed surface is not in the slice). Origin instance: gendn-5ao's css-scroll-state
// syntax dimension at #syntax orphaned the namesake query call form; validate-artifacts
// returned PASS exit 0 (bc8f73e, tree 2abb4c65).
//
// The assertion EXECUTES the library slicer (fragmentAfterId via lib/surface-coverage.mjs);
// nothing here re-implements the /<h[1-3]\b/i rule. The slicer self-check below is the
// trap gendn-impl recorded: on v149/css-scroll-state-container-queries the true rule yields
// three fragments (~360/#syntax, ~189/#scroll-state-query, ~3005/#features); the misread
// 'to the next h2' yields one ~3562-char slice. A copied rule silently inherits the misread.
import { fragmentAfterId, stripMarkup } from "./lib/reference-contract.mjs";
import {
  CLASSIFIER_STOPWORDS,
  EXEMPT_TIER,
  STRICT_TIER,
  surfaceCoverageFindings,
  surfaceMarkersFor,
} from "./lib/surface-coverage.mjs";
import { changedContractIds, runRatchet } from "./check-surface-coverage.mjs";

let failures = 0;
function assert(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures++;
}

const root = Deno.cwd();

// ---- 1. Slicer self-check on the divergence page (impl's recorded trap) ----
{
  const html = await Deno.readTextFile(
    `${root}/v149/css-scroll-state-container-queries/index.html`,
  );
  const syn = stripMarkup(fragmentAfterId(html, "syntax")).length;
  const q = stripMarkup(fragmentAfterId(html, "scroll-state-query")).length;
  const feat = stripMarkup(fragmentAfterId(html, "features")).length;
  // The misread rule would give ONE ~3562-char slice for #syntax; the true rule stops at
  // the next h1/h2/h3. Bounds, not exact lengths (prose edits shift them slightly).
  assert(
    "slicer self-check: #syntax fragment is the short h1-h3-bounded slice, not the ~3562-char misread",
    syn > 100 && syn < 1500,
    `#syntax=${syn} #scroll-state-query=${q} #features=${feat}`,
  );
  assert(
    "slicer self-check: the three fragments are distinct (the page really has three surfaces)",
    q > 50 && feat > 1000 && syn !== q && q !== feat,
    `${syn}/${q}/${feat}`,
  );
}

// ---- 2. The 5ao defect shape must be caught ----
{
  // Deliberately unambiguous: the item's identifier appears NOWHERE in the wrong slice,
  // and the wrong slice is long, substantive and has a real id — exactly the shape that
  // passed every gate on bc8f73e. Derived markers are substring-level by design (low
  // false positives); the slice avoids every one of them.
  const pageHtml = [
    "<html><body>",
    '<section><h2 id="syntax">Syntax</h2><p>Establish a storage quota policy for the origin. This section carries substantive prose about quota policy configuration, persistence and eviction behaviour, comfortably long enough to clear the validator floor.</p></section>',
    '<section><h2 id="method">The call form</h2><p><code>computeQuota(hints)</code> returns the estimate — the namesake call form lives HERE, not in #syntax.</p></section>',
    "</body></html>",
  ].join("\n");
  const contract = {
    id: "fixture/wrong-surface",
    inventory: [{ id: "computequota-method", name: "computeQuota method", kind: "method" }],
    documentation: [{
      inventoryId: "computequota-method",
      href: "#syntax",
      dimensions: { syntax: { status: "documented", selector: "#syntax" } },
    }],
  };
  const findings = await surfaceCoverageFindings(contract, root, async () => pageHtml);
  assert(
    "5ao replay: syntax dimension mapped at a real, long slice that lacks the namesake surface IS a wrong-surface finding",
    findings.length === 1 && findings[0].cls === "wrong-surface" && findings[0].dim === "syntax",
    JSON.stringify(findings.map((f) => [f.cls, f.dim])),
  );
  // the corrected mapping passes
  contract.documentation[0].dimensions.syntax.selector = "#method";
  const fixed = await surfaceCoverageFindings(contract, root, async () => pageHtml);
  assert(
    "5ao replay: the corrected mapping (selector -> the surface carrying the namesake) passes",
    fixed.length === 0,
    JSON.stringify(fixed),
  );
}

// ---- 3. Declared surfaceMarkers are the alias-class fix path and win over derivation ----
{
  const pageHtml =
    '<html><body><section><h2 id="inputs">Inputs</h2><p>Access <code>window.printing</code> from a Window; no arguments. Substantive prose for the slice length floor.</p></section></body></html>';
  const base = {
    id: "fixture/alias",
    inventory: [{
      id: "webprintingmanager",
      name: "WebPrintingManager interface",
      kind: "interface",
    }],
    documentation: [{
      inventoryId: "webprintingmanager",
      href: "#inputs",
      dimensions: { inputs: { status: "documented", selector: "#inputs" } },
    }],
  };
  const without = await surfaceCoverageFindings(base, root, async () => pageHtml);
  assert(
    "alias class: derived markers alone flag the window.printing alias slice",
    without.length === 1 && without[0].cls === "wrong-surface",
    JSON.stringify(without.map((f) => f.cls)),
  );
  const declared = structuredClone(base);
  declared.inventory[0].surfaceMarkers = ["window.printing"];
  const withMarkers = await surfaceCoverageFindings(declared, root, async () => pageHtml);
  assert(
    "alias class: declared surfaceMarkers resolve the same slice honestly (explicit claim wins)",
    withMarkers.length === 0,
    JSON.stringify(withMarkers),
  );
  assert(
    "surfaceMarkersFor: declared markers win and are lowercased",
    surfaceMarkersFor({ id: "x", name: "Y", surfaceMarkers: ["MixedCase"] }).markers.join() ===
      "mixedcase",
  );
}

// ---- 4. Tier semantics ----
{
  assert(
    "strict tier is exactly the approved five dimensions",
    [...STRICT_TIER].sort().join() === "errors,examples,inputs,outputs,syntax",
  );
  assert(
    "exempt tier is exactly the approved four dimensions",
    [...EXEMPT_TIER].sort().join() === "compatibility,context,lifecycle,securityPrivacy",
  );
  const pageHtml =
    '<html><body><section><h2 id="browser-compatibility">Compatibility</h2><p>A feature-wide support table lives here without repeating any member name; substantive prose for length.</p></section></body></html>';
  const contract = {
    id: "fixture/exempt",
    inventory: [{ id: "some-member-thing", name: "SomeMemberThing", kind: "method" }],
    documentation: [{
      inventoryId: "some-member-thing",
      href: "#browser-compatibility",
      dimensions: { compatibility: { status: "documented", selector: "#browser-compatibility" } },
    }],
  };
  const findings = await surfaceCoverageFindings(contract, root, async () => pageHtml);
  assert(
    "exempt tier: a feature-wide compatibility slice is never a finding (report-only by design)",
    findings.length === 0,
    JSON.stringify(findings),
  );
  // non-documented statuses are not coverage claims
  const nd = structuredClone(contract);
  nd.documentation[0].dimensions = {
    syntax: {
      status: "not-applicable",
      selector: "#browser-compatibility",
      rationale: "no code surface",
    },
  };
  assert(
    "not-applicable dimensions are not coverage claims",
    (await surfaceCoverageFindings(nd, root, async () => pageHtml)).length === 0,
  );
}

// ---- 5. Derivation hygiene ----
{
  const { markers } = surfaceMarkersFor({
    id: "renderquantumsize-attribute",
    name: "BaseAudioContext.renderQuantumSize readonly attribute",
  });
  assert(
    "derivation: dotted member + long tokens produce the code identifier",
    markers.includes("renderquantumsize"),
    markers.join(","),
  );
  const prose = surfaceMarkersFor({ id: "migration-target", name: "Migration target behaviour" });
  assert(
    "derivation: classifier stopwords do not become markers",
    prose.markers.every((m) => !CLASSIFIER_STOPWORDS.has(m)) &&
      !prose.markers.includes("behaviour"),
    prose.markers.join(","),
  );
  const kebab = surfaceMarkersFor({
    id: "ruby-overhang-property",
    name: "ruby-overhang CSS property",
  });
  assert(
    "derivation: kebab-case surface names survive",
    kebab.markers.includes("ruby-overhang"),
    kebab.markers.join(","),
  );
}

// ---- 6. changedContractIds + ratchet plumbing ----
{
  const ids = changedContractIds([
    "v147/autofill-event/reference-contract.json",
    "v148/prompt-api/index.html",
    "scripts/lib/surface-coverage.mjs",
    "v149/webmcp/entry-point/reference-contract.json",
  ]);
  assert(
    "changedContractIds: only reference-contract.json paths count, member routes included",
    ids.length === 2 && ids.includes("v147/autofill-event") &&
      ids.includes("v149/webmcp/entry-point"),
    ids.join(","),
  );
  // The ratchet must run clean on the current tree, and its vacuous flag must MATCH the
  // git state rather than assert one state (this fixture runs pre-commit AND post-commit:
  // base==HEAD only before the branch has commits of its own).
  const r = await runRatchet(root);
  assert(
    "ratchet: runs without error on the current tree, zero failures",
    !r.error && r.failures.length === 0,
    r.error ?? JSON.stringify(r.failures.slice(0, 2)),
  );
  const gitOut = async (args) => {
    const c = new Deno.Command("git", { args, cwd: root, stdout: "piped", stderr: "null" });
    const o = await c.output();
    return o.success ? new TextDecoder().decode(o.stdout).trim() : null;
  };
  const mb = await gitOut(["merge-base", "origin/main", "HEAD"]);
  const head = await gitOut(["rev-parse", "HEAD"]);
  const expectedVacuous = mb !== null && head !== null && mb === head;
  assert(
    "ratchet: the vacuous flag matches the git state (base==HEAD iff vacuous) - honest in both the pre-commit and post-commit tree",
    r.vacuous === expectedVacuous,
    JSON.stringify({ vacuous: r.vacuous, expected: expectedVacuous, mb, head }),
  );
}

if (failures > 0) {
  console.error(`surface-coverage fixture: ${failures} assertion(s) FAILED`);
  Deno.exit(1);
}
console.log(
  "surface-coverage fixture: all assertions passed (5ao replay caught, alias path works, tiers hold, slicer self-check green)",
);
