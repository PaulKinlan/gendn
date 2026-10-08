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
import {
  changedContractIds,
  changedPageOwners,
  runRatchet,
  scanCorpus,
} from "./check-surface-coverage.mjs";

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

// ---- 7. gendn-j9vz: a PAGE-only edit must gate its owner contracts ----
{
  const owners = changedPageOwners([
    "v147/probe/index.html",
    "v147/probe/child/index.html",
    "v147/probe/child/deeper/index.html",
    "v147/probe/reference-contract.json",
    "v147/probe/child/other.html",
    "scripts/check-surface-coverage.mjs",
  ]);
  assert(
    "page paths: root and nested index.html dedupe to one feature owner; non-pages ignored",
    owners.length === 1 && owners[0] === "v147/probe",
    owners.join(","),
  );

  const scratch = await Deno.makeTempDir({ prefix: "j9vz-surface-" });
  const probe = "v147/probe";
  const child = `${probe}/child`;
  const page = (text) =>
    `<html><body><h2 id="syntax">syntax</h2><p>${text}</p><h2 id="next">next</h2></body></html>`;
  const named =
    "Call computeQuota(hints) to calculate the estimate. This is substantive documentation of the named method.";
  const neutral =
    "This generic placeholder describes an unrelated storage policy, with no named API call or member surface.";
  const inventory = [{ id: "computequota-method", name: "computeQuota method", kind: "method" }];
  const doc = (href) => ({
    inventoryId: "computequota-method",
    href,
    dimensions: { syntax: { status: "documented", selector: "#syntax" } },
  });
  const g = async (...args) => {
    const c = new Deno.Command("git", { args, cwd: scratch, stdout: "piped", stderr: "piped" });
    const o = await c.output();
    if (!o.success) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(o.stderr)}`);
    }
  };
  try {
    await Deno.mkdir(`${scratch}/${child}`, { recursive: true });
    await Deno.writeTextFile(
      `${scratch}/${probe}/reference-contract.json`,
      JSON.stringify({
        id: probe,
        inventory,
        documentation: [doc("#syntax"), doc("child/#syntax")],
      }),
    );
    await Deno.writeTextFile(
      `${scratch}/${child}/reference-contract.json`,
      JSON.stringify({
        id: child,
        inventory,
        documentation: [doc("#syntax")],
      }),
    );
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, page(named));
    await Deno.writeTextFile(`${scratch}/${child}/index.html`, page(named));
    await g("init", "-q", "-b", "main");
    await g("config", "user.email", "fixture@example.test");
    await g("config", "user.name", "fixture");
    await g("add", ".");
    await g("commit", "-qm", "clean baseline");
    await g("update-ref", "refs/remotes/origin/main", "HEAD");
    const runSurfaceGate = async (all = false) => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-run",
          new URL("./check-surface-coverage.mjs", import.meta.url).pathname,
          ...(all ? ["--all"] : []),
        ],
        cwd: scratch,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: out.code,
        text: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
      };
    };
    const unchangedNote =
      "[UNCHANGED: fetched baseline == HEAD - committed changes not in scope; uncommitted edits still checked]";
    let cli = await runSurfaceGate();
    assert(
      "equal fetched baseline qualifies BOTH surface count and PASS line",
      cli.code === 0 &&
        cli.text.split("\n").some((line) =>
          line.startsWith("surface-coverage ratchet:") && line.includes(unchangedNote)
        ) &&
        cli.text.split("\n").some((line) =>
          line.startsWith("PASS —") && line.includes(unchangedNote)
        ),
      cli.text,
    );
    const baseline = await scanCorpus(scratch);
    assert(
      "scratch corpus starts clean with root + nested contracts",
      baseline.contracts === 2 && Object.keys(baseline.byClass).length === 0,
      JSON.stringify({ contracts: baseline.contracts, byClass: baseline.byClass }),
    );

    // Only the overview PAGE changes; both contracts are conservatively checked, but the
    // wrong-surface finding belongs to the overview slice. The old ratchet checked ZERO.
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, page(neutral));
    let r = await runRatchet(scratch);
    assert(
      "page-only mutation: contract JSON unchanged but owner and nested contracts are gated",
      r.changed.length === 2 && r.changed.includes(probe) && r.changed.includes(child) &&
        r.pageOwners.join() === probe &&
        changedContractIds([`${probe}/index.html`]).length === 0,
      JSON.stringify({ changed: r.changed, pageOwners: r.pageOwners }),
    );
    assert(
      "page-only wrong-surface edit FAILS the ratchet before commit",
      r.failures.length === 1 && r.failures[0].includes("computequota-method.syntax"),
      JSON.stringify(r.failures),
    );
    const report = await scanCorpus(scratch);
    assert(
      "--all corpus scan still sees the finding (report mode remains separate)",
      report.byClass["wrong-surface"]?.length === 1,
      JSON.stringify(report.byClass),
    );

    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, page(`${named} Updated prose.`));
    r = await runRatchet(scratch);
    assert(
      "page-only edit retaining the named surface remains green",
      r.changed.includes(probe) && r.failures.length === 0,
      JSON.stringify(r.failures),
    );

    // A nested child PAGE can be documented by its ancestor AND its local contract. Gate both.
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, page(named));
    await Deno.writeTextFile(`${scratch}/${child}/index.html`, page(neutral));
    r = await runRatchet(scratch);
    assert(
      "nested page-only edit gates both ancestor and member contract, finding both wrong slices",
      r.changed.length === 2 && r.failures.length === 2 &&
        r.failures.some((f) => f.startsWith(`${probe}:`)) &&
        r.failures.some((f) => f.startsWith(`${child}:`)),
      JSON.stringify({ changed: r.changed, failures: r.failures }),
    );
    await g("add", ".");
    await g("commit", "-qm", "page-only regression");
    r = await runRatchet(scratch);
    assert(
      "committed page-only regression still fails; baseline warning is not vacuous",
      !r.vacuous && r.failures.length === 2 && r.pageOwners.join() === probe,
      JSON.stringify({ vacuous: r.vacuous, failures: r.failures }),
    );

    // Exercise the actual CLI in both directions on the SAME committed wrong-surface tree.
    // The scratch repo's origin/main is a local ref: no network or browser is involved.
    cli = await runSurfaceGate();
    assert(
      "independent baseline detects committed wrong-surface page (CLI rc1)",
      cli.code === 1 && cli.text.includes("surface-coverage violation(s)") &&
        cli.text.includes("computequota-method.syntax") &&
        !cli.text.includes(unchangedNote),
      cli.text,
    );
    await g("update-ref", "-d", "refs/remotes/origin/main");
    cli = await runSurfaceGate();
    assert(
      "missing independent baseline is PRECONDITION rc6, not violation rc1 or PASS",
      cli.code === 6 && cli.text.includes("cannot verify committed surface mappings") &&
        cli.text.includes("refs/remotes/origin/main") &&
        cli.text.includes("run git fetch origin main") && !cli.text.includes("PASS —"),
      cli.text,
    );

    await g("update-ref", "refs/remotes/origin/main", "HEAD~1");
    await g("rm", `${probe}/reference-contract.json`, `${child}/reference-contract.json`);
    cli = await runSurfaceGate();
    assert(
      "deleted whole contract corpus fails independent published floor (CLI rc1, no PASS)",
      cli.code === 1 && cli.text.includes("published reference-contract corpus empty") &&
        cli.text.includes("2 independent origin/main contracts") && !cli.text.includes("PASS —"),
      cli.text,
    );
    const emptyReport = await runSurfaceGate(true);
    assert(
      "report mode also refuses an empty contract corpus (CLI rc1)",
      emptyReport.code === 1 && emptyReport.text.includes("empty published contract corpus") &&
        !emptyReport.text.includes("PASS —"),
      emptyReport.text,
    );
    await g("reset", "--hard", "refs/remotes/origin/main");
    cli = await runSurfaceGate();
    assert(
      "restored valid non-empty contract corpus passes (CLI rc0)",
      cli.code === 0 && cli.text.includes("PASS —"),
      cli.text,
    );
    const nonemptyReport = await runSurfaceGate(true);
    assert(
      "report mode still measures a valid non-empty contract corpus",
      nonemptyReport.code === 0 && nonemptyReport.text.includes("2 contracts"),
      nonemptyReport.text,
    );

    await Deno.writeTextFile(`${scratch}/${probe}/reference-contract.json`, "{ malformed json");
    cli = await runSurfaceGate();
    assert(
      "malformed touched contract fails with named file and parse reason (CLI rc1, no PASS)",
      cli.code === 1 && cli.text.includes(`${probe}/reference-contract.json`) &&
        cli.text.includes("cannot read or parse touched contract") && !cli.text.includes("PASS —"),
      cli.text,
    );
    for (const malformed of ["null", "{}", "[]"]) {
      await Deno.writeTextFile(`${scratch}/${probe}/reference-contract.json`, malformed);
      cli = await runSurfaceGate();
      assert(
        `parseable but malformed touched contract ${malformed} cannot be skipped`,
        cli.code === 1 && cli.text.includes(`${probe}/reference-contract.json`) &&
          cli.text.includes("malformed contract") && !cli.text.includes("PASS —"),
        cli.text,
      );
    }
    await g("reset", "--hard", "HEAD");
    cli = await runSurfaceGate();
    assert(
      "restored valid contract after malformed probe passes",
      cli.code === 0 && cli.text.includes("PASS —"),
      cli.text,
    );

    // Fetched ref ahead of HEAD: merge-base == HEAD but fetched != HEAD.
    await g("commit", "--allow-empty", "-qm", "fixture fetched-ahead ref");
    await g("update-ref", "refs/remotes/origin/main", "HEAD");
    await g("reset", "--hard", "HEAD~1");
    cli = await runSurfaceGate();
    r = await runRatchet(scratch);
    assert(
      "fetched ref ahead of HEAD is not falsely labelled UNCHANGED",
      cli.code === 0 && r.vacuous === false && !cli.text.includes(unchangedNote) &&
        cli.text.includes("PASS —"),
      cli.text,
    );
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}

// ---- 8. gendn-waa3: staged-then-reverted edit (git status MM) must not escape ----
{
  const scratch = await Deno.makeTempDir({ prefix: "waa3-surface-" });
  const probe = "v147/probe";
  const page = (text) =>
    `<html><body><h2 id="syntax">syntax</h2><p>${text}</p><h2 id="next">next</h2></body></html>`;
  const named = "Call computeQuota(hints) to calculate the estimate. Substantive.";
  const neutral = "Generic placeholder without the named surface.";
  const inventory = [{ id: "computequota-method", name: "computeQuota method", kind: "method" }];
  const doc = {
    inventoryId: "computequota-method",
    href: "#syntax",
    dimensions: { syntax: { status: "documented", selector: "#syntax" } },
  };
  const g = async (...args) => {
    const c = new Deno.Command("git", { args, cwd: scratch, stdout: "piped", stderr: "piped" });
    const o = await c.output();
    if (!o.success) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(o.stderr)}`);
    }
  };
  try {
    await Deno.mkdir(`${scratch}/${probe}`, { recursive: true });
    await Deno.writeTextFile(
      `${scratch}/${probe}/reference-contract.json`,
      JSON.stringify({ id: probe, inventory, documentation: [doc] }),
    );
    // Baseline starts with neutral placeholder: pre-existing debt on origin/main
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, page(neutral));
    await g("init", "-q", "-b", "main");
    await g("config", "user.email", "waa3@example.test");
    await g("config", "user.name", "waa3");
    await g("add", ".");
    await g("commit", "-qm", "baseline with debt");
    await g("update-ref", "refs/remotes/origin/main", "HEAD");

    // Case 1: Clean baseline — untouched pre-existing debt is not gated
    let r = await runRatchet(scratch);
    assert(
      "clean baseline: untouched pre-existing debt is not gated (0 changed, 0 failures)",
      r.changed.length === 0 && r.failures.length === 0,
      JSON.stringify({ changed: r.changed, failures: r.failures }),
    );

    // Case 2: Uncommitted edit to page with debt fails before commit
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, page(neutral) + "<!-- touch -->");
    r = await runRatchet(scratch);
    assert(
      "uncommitted touch to page with debt FAILS before commit (resolve-on-touch)",
      r.changed.includes(probe) && r.failures.length === 1,
      JSON.stringify({ changed: r.changed, failures: r.failures }),
    );

    // Case 3: Staged edit fails before commit
    await g("add", `${probe}/index.html`);
    r = await runRatchet(scratch);
    assert(
      "staged edit to page with debt FAILS before commit",
      r.changed.includes(probe) && r.failures.length === 1,
      JSON.stringify({ changed: r.changed, failures: r.failures }),
    );

    // Case 4: Staged-then-worktree-reverted (git status shows MM)
    // Working file restored to base content: base -> working tree diff is empty,
    // but the index holds the change, so union of git diff --cached keeps owner in the key.
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, page(neutral));
    const statusCmd = new Deno.Command("git", {
      args: ["status", "--short"],
      cwd: scratch,
      stdout: "piped",
    });
    const statusOut = new TextDecoder().decode((await statusCmd.output()).stdout).trim();
    assert(
      "staged-then-reverted file shows MM in git status --short",
      statusOut.includes("MM") && statusOut.includes(probe),
      statusOut,
    );
    r = await runRatchet(scratch);
    assert(
      "staged-then-reverted touch is included in changed pages via cached diff (gendn-waa3)",
      r.changed.includes(probe),
      JSON.stringify(r.changed),
    );
    assert(
      "staged-then-reverted touch FAILS the ratchet on retained pre-existing debt (escape closed)",
      r.failures.length === 1 && r.failures[0].includes("computequota-method.syntax"),
      JSON.stringify(r.failures),
    );

    // Case 5: Committed edit still fails
    await g("commit", "-qm", "committed touch");
    r = await runRatchet(scratch);
    assert(
      "committed touch to page with debt FAILS the ratchet",
      !r.vacuous && r.failures.length === 1,
      JSON.stringify({ vacuous: r.vacuous, failures: r.failures }),
    );

    // Case 6: Resolved — updating to named surface clears the failure
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, page(named));
    await g("add", `${probe}/index.html`);
    await g("commit", "-qm", "resolve surface");
    r = await runRatchet(scratch);
    assert(
      "resolved surface mapping PASSES the ratchet",
      r.failures.length === 0,
      JSON.stringify(r.failures),
    );
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}

if (failures > 0) {
  console.error(`surface-coverage fixture: ${failures} assertion(s) FAILED`);
  Deno.exit(1);
}
console.log(
  "surface-coverage fixture: all assertions passed (5ao replay caught, alias path works, tiers hold, slicer self-check green)",
);
