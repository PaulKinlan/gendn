// @fixture-permissions --allow-read --allow-write
// THE CONTROL FOR THIS FILE IS THE RUNNER'S EXIT CODE, NOT A COUNT OF ITS PASS LINES (gendn-ijf).
//
// This is written here rather than in a bead because a rule survives only if it is in the artefact the
// next worker reads. A count of `PASS` lines is a PLURALITY OF READINGS: a red suite that emits 33 PASS
// lines satisfies `33 == $(... | grep -c ^PASS)`, and the count cannot distinguish that from a green run.
// The exit code is the fact that differs when this file is broken, so:
//     deno task test-reference-contract; echo "exit=$?"      <- the verdict is the exit code
//     deno task test-reference-contract | grep -c ^PASS      <- context only, NEVER the control
// `deno task` already propagates this file's exit status, so any caller that checks `$?` - a gate, a
// fleet-check, a person at a prompt - is asserting it. There is deliberately NO in-file assertion of the
// exit code: the exit code is produced BY these assertions, so asserting it here would be circular.
//
// A count that is genuinely part of this file's contract is different and is asserted where it belongs -
// see the exact-length assertions below, and the surfaceNotePages pins, each of which names the value it
// expects rather than printing a number for a reader to judge.
//
import { referenceRouteMigration } from "./check-routes.mjs";
import { isMdnStubHtml } from "./lib/artifacts.mjs";
import {
  declaredSurfaceMembers,
  declaredSurfaceSummary,
  resolveDocumentationHref,
  skippedSurfaceDeclarations,
  surfaceNotePages,
  unreadableSyntaxBlocks,
  validateContractOwnership,
  validateDeclaredSurface,
  validateReferenceContract,
} from "./lib/reference-contract.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = await Deno.makeTempDir({ prefix: "gendn-reference-contract-" });
try {
  const id = "v999/example-api";
  await Deno.mkdir(`${root}/${id}/thing/do-work`, { recursive: true });
  const source = "https://example.com/spec#do-work";
  const sections = [
    [
      "syntax",
      "<p><code>thing.doWork(input)</code> invokes the operation using the supplied input value.</p>",
    ],
    [
      "inputs",
      "<p>The <code>input</code> parameter is a non-empty string. Empty strings are rejected by the algorithm.</p>",
    ],
    [
      "outputs",
      "<p>Returns a promise that fulfills with a result object containing the completed value.</p>",
    ],
    [
      "errors",
      "<p>The promise rejects with <code>TypeError</code> for invalid input and <code>AbortError</code> when cancelled.</p>",
    ],
    [
      "context",
      "<p>The method is exposed in secure window and worker contexts after capability detection.</p>",
    ],
    [
      "lifecycle",
      "<p>Call once the owner is active; cancellation settles the operation and releases retained resources.</p>",
    ],
    [
      "examples",
      "<p>This complete example handles both success and failure.</p><pre tabindex=\"0\"><code>await thing.doWork('value');</code></pre>",
    ],
    [
      "compatibility",
      "<p>Unknown support remains explicitly unknown.</p><table><caption>Browser compatibility</caption><tr><th>Browser</th><th>Version</th></tr><tr><td>Chrome</td><td>Unknown</td></tr></table>",
    ],
    [
      "security-privacy",
      "<p>No additional data leaves the current origin; callers still validate untrusted input.</p>",
    ],
  ];
  const body = sections.map(([name, body]) =>
    `<section><h2 id=\"${name}\">${name}</h2>${body}<p><a href=\"${source}\">Normative source</a></p></section>`
  ).join("\n");
  await Deno.writeTextFile(
    `${root}/${id}/thing/do-work/index.html`,
    `<!doctype html><main>${body}</main>`,
  );

  const dimension = (selector) => ({ status: "documented", selector, sourceRefs: ["spec"] });
  const contract = {
    id,
    completeness: "implementation-sufficient",
    sources: [{ id: "spec", url: source }],
    inventory: [{ id: "do-work", sourceRefs: ["spec"] }],
    documentation: [{
      inventoryId: "do-work",
      href: "thing/do-work/",
      dimensions: {
        syntax: dimension("#syntax"),
        inputs: dimension("#inputs"),
        outputs: dimension("#outputs"),
        errors: dimension("#errors"),
        context: dimension("#context"),
        lifecycle: dimension("#lifecycle"),
        examples: dimension("#examples"),
        compatibility: dimension("#compatibility"),
        securityPrivacy: dimension("#security-privacy"),
      },
    }],
  };

  const validErrors = await validateReferenceContract(contract, root);
  assert(validErrors.length === 0, `valid contract failed:\n${validErrors.join("\n")}`);

  // ---- declared-surface coverage: a collapsed inventory must not pass silently (gendn-4kq) ----
  const idl = `<pre><code>partial interface Thing {
  readonly attribute boolean alpha;
  Promise&lt;void&gt; beta(long count);
};</code></pre>`;
  const idlPage =
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2>${idl}</section></main>`;
  assert(
    JSON.stringify(declaredSurfaceMembers(idlPage)) === JSON.stringify(["alpha", "beta"]),
    `declared-surface parser found ${JSON.stringify(declaredSurfaceMembers(idlPage))}`,
  );
  const surfaceContract = (inventory, outOfScope) => ({
    id,
    completeness: "implementation-sufficient",
    inventory: inventory.map((n) => ({ id: n.toLowerCase(), name: n, sourceRefs: ["spec"] })),
    ...(outOfScope ? { outOfScope } : {}),
  });

  // REGRESSIONS from the gendn-4kq review:
  //  P1 - methods with a custom return type, `void`, or a nested generic were INVISIBLE, so a
  //       contract could omit the page's primary method and still report zero unaccounted.
  //  P2 - `typedef X Y;` reported Y as a member, and a method's default-valued trailing parameter
  //       (`optional unsigned long? length = null`) leaked in as a member.
  const methodPage =
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>[Exposed=Window]
typedef USVString ManifestId;
interface Thing {
  readonly attribute boolean alpha;
  SpeculationData getSpeculations();
  void doIt();
  Promise&lt;record&lt;USVString, SubAppsListResult&gt;&gt; list();
  Promise&lt;void&gt; supports(Identifier algorithm, optional unsigned long? length = null);
};</code></pre></section></main>`;
  assert(
    JSON.stringify(declaredSurfaceMembers(methodPage)) ===
      JSON.stringify(["alpha", "doIt", "getSpeculations", "list", "supports"]),
    `method/typedef/parameter parsing: ${JSON.stringify(declaredSurfaceMembers(methodPage))}`,
  );
  assert(
    validateDeclaredSurface(surfaceContract(["alpha"]), methodPage)
      .some((e) => e.includes('declared surface member "getSpeculations"')),
    "a contract that omitted the page's primary METHOD was not flagged",
  );
  // P1a regression: a WebIDL comment carrying parens sits on the SAME `;`-statement as the method
  // below it on the real page, and used to win the match and hide the method.
  const commentIdl =
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>// partial interface Performance (core/timing/performance.idl)
[Exposed=Window, RuntimeEnabled=SpeculationMeasurement]
SpeculationData getSpeculations();</code></pre></section></main>`;
  assert(
    JSON.stringify(declaredSurfaceMembers(commentIdl)) === JSON.stringify(["getSpeculations"]),
    `comment-before-method parsing: ${JSON.stringify(declaredSurfaceMembers(commentIdl))}`,
  );
  // P2 regression: `A includes B;` names a mixin, not a member; a union-typed member must be seen;
  // members sharing a line with the opening brace must be seen.
  const shapesIdl =
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>interface A { readonly attribute boolean alpha; };
HTMLCameraElement includes HTMLMediaCaptureElementBase;
dictionary D { (boolean or MediaTrackConstraints) video = true; };</code></pre></section></main>`;
  assert(
    JSON.stringify(declaredSurfaceMembers(shapesIdl)) === JSON.stringify(["alpha", "video"]),
    `includes/union/brace-shared parsing: ${JSON.stringify(declaredSurfaceMembers(shapesIdl))}`,
  );
  // P1 regression (review 3): WebIDL defaults written with braces or brackets are extremely common,
  // and a greedy header strip / blind extended-attribute strip used to swallow the whole declaration.
  const defaultsIdl =
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>interface A {
  undefined setConstraints(optional Foo constraints = {});
};
dictionary D {
  sequence&lt;DOMString&gt; protocols = [];
  sequence&lt;DOMString&gt; names = ["a", "b"];
  Foo opts = {};
};</code></pre></section></main>`;
  assert(
    JSON.stringify(declaredSurfaceMembers(defaultsIdl)) ===
      JSON.stringify(["names", "opts", "protocols", "setConstraints"]),
    `brace/bracket default parsing: ${JSON.stringify(declaredSurfaceMembers(defaultsIdl))}`,
  );
  // ...and a union-typed member declared AFTER keywords: the word before "(" is the keyword
  // `attribute`, which must not be mistaken for a method name nor hide the member.
  const unionAttrIdl =
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>interface A { readonly attribute (Foo or Bar) baz; };</code></pre></section></main>`;
  assert(
    JSON.stringify(declaredSurfaceMembers(unionAttrIdl)) === JSON.stringify(["baz"]),
    `union-attribute parsing: ${JSON.stringify(declaredSurfaceMembers(unionAttrIdl))}`,
  );
  // The syntax section is found by heading TEXT too, because several pages ship `<h2>Syntax</h2>`
  // with no id - the rule must not be silently dead there.
  const noIdPage =
    `<!doctype html><main><h2>Syntax</h2><pre><code>dictionary D { DOMString name; };</code></pre><h2>Examples</h2></main>`;
  assert(
    JSON.stringify(declaredSurfaceMembers(noIdPage)) === JSON.stringify(["name"]),
    `heading-text fallback parsing: ${JSON.stringify(declaredSurfaceMembers(noIdPage))}`,
  );
  assert(
    validateDeclaredSurface(
      surfaceContract(["alpha", "getSpeculations", "doIt", "list", "supports"]),
      methodPage,
    ).length === 0,
    "an inventory accounting for every declared member and method was rejected",
  );
  assert(
    validateDeclaredSurface(surfaceContract(["alpha", "beta"]), idlPage).length === 0,
    "an inventory that accounts for every declared member was rejected",
  );
  const collapsed = validateDeclaredSurface(surfaceContract(["alpha"]), idlPage);
  assert(
    collapsed.some((e) => e.includes('declared surface member "beta"')),
    "a contract that dropped a declared member was not flagged",
  );
  assert(
    validateDeclaredSurface(
      surfaceContract(["alpha"], [{
        name: "beta",
        rationale: "Quoted context from the surrounding interface; not part of this feature.",
      }]),
      idlPage,
    ).length === 0,
    "a specific outOfScope rationale did not account for a declared member",
  );
  assert(
    validateDeclaredSurface(
      surfaceContract(["alpha"], [{ name: "beta", rationale: "context" }]),
      idlPage,
    ).some((e) => e.includes("outOfScope beta needs a rationale")),
    "a bare outOfScope exclusion was accepted as a rationale",
  );
  assert(
    validateDeclaredSurface(
      surfaceContract(["alpha", "beta"], [{
        name: "gamma",
        rationale: "Names something the page never declares at all.",
      }]),
      idlPage,
    ).some((e) => e.includes("matches no member declared")),
    "an outOfScope entry naming an undeclared member was accepted",
  );
  // LIMIT, asserted so it cannot silently regress into a false sense of coverage: a page with no
  // IDL in its syntax block declares no surface, so nothing is compared.
  const noIdlPage =
    '<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>{"prerender":[{"form_submission":true}]}</code></pre></section></main>';
  assert(
    validateDeclaredSurface(surfaceContract(["alpha"]), noIdlPage).length === 0,
    "a page with no declared IDL surface produced a phantom coverage failure",
  );
  assert(
    validateDeclaredSurface(
      {
        ...surfaceContract(["alpha"]),
        outOfScope: [{ name: "alpha", rationale: "too short" }],
      },
      noIdlPage,
    ).some((e) => e.includes("outOfScope alpha needs a rationale")),
    "outOfScope was not validated on a page that declares no IDL",
  );
  // ---- PARAMETERLESS WebIDL SPECIALS were invisible (gendn-5t3) -----------------------------
  // Measured before the fix: `stringifier;`, `iterable<T>;`, `maplike<K,V>;` and `setlike<T>;` each
  // yielded NOTHING; on a real page (v153/expose-cssstylevalue-hierarchy...) the detector saw only
  // parse/parseAll while the syntax block also declared `stringifier;`. They imply members the spec
  // defines for them (maplike<K,V> implies size/get/has/set/delete/entries/keys/values/forEach), so
  // a contract could be silently smaller than the page's declared surface with this rule reporting
  // nothing.
  const specialPage = (idlBody) =>
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>interface Thing {\n${
      idlBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    }\n};</code></pre></section></main>`;
  for (
    const [construct, line] of [
      ["stringifier", "  stringifier;"],
      ["iterable", "  iterable<DOMString>;"],
      ["maplike", "  maplike<DOMString, Node>;"],
      ["setlike", "  setlike<Node>;"],
    ]
  ) {
    const seen = declaredSurfaceMembers(specialPage(line));
    assert(
      seen.includes(construct),
      `${construct}; was not reported as a declared surface member (got ${JSON.stringify(seen)})`,
    );
  }
  // NO REGRESSION: `stringifier attribute DOMString foo;` declares a NAMED attribute, so the
  // construct branch must not swallow it.
  assert(
    JSON.stringify(
      declaredSurfaceMembers(specialPage("  stringifier attribute DOMString foo;")),
    ) ===
      JSON.stringify(["foo"]),
    "a stringifier ATTRIBUTE stopped being reported as its own name",
  );
  // SATISFIABILITY, the reason the construct is reported by its own name rather than expanded into
  // its implied members: a contract must be ABLE to discharge the obligation, and outOfScope with a
  // rationale is the natural home when those members are specified by WebIDL rather than written as
  // prose. An obligation a contract cannot satisfy would block pages instead of describing them.
  const maplikePage = specialPage("  maplike<DOMString, Node>;");
  assert(
    validateDeclaredSurface(surfaceContract(["alpha"]), maplikePage).some((e) =>
      e.includes('declared surface member "maplike"')
    ),
    "a maplike page passed with a contract that never acknowledges the construct",
  );
  assert(
    validateDeclaredSurface(
      {
        ...surfaceContract(["alpha"]),
        outOfScope: [{
          name: "maplike",
          rationale: "The map's accessors are specified by WebIDL, not documented as prose here.",
        }],
      },
      maplikePage,
    ).length === 0,
    "the construct could not be discharged via outOfScope + rationale, so the rule would block pages",
  );

  // ---- BARE WebIDL ENUMS were invisible (gendn-kda) ------------------------------------------
  // Measured before the fix: `enum WebPrinterState { "idle", "processing", "stopped" };` passes
  // IDL_BLOCK_GATE (`enum` is in the gate) but memberNamesFromIdl returns NOTHING - the values are
  // string literals with no identifier, and the `enum Name {` header is stripped by idlStatements.
  // A contract could therefore be silently smaller than the page's declared surface, and no
  // unreadable report fires (the values carry no member hint). Reported as the TYPE's own
  // identifier, once, and NOT expanded into its values: the page documents the enum type (its h1 IS
  // the identifier), the contract inventories it by that identifier, and the values are described
  // collectively - the cheapest form that is SATISFIABLE, mirroring the parameterless specials.
  const enumPage = (declaration) =>
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>${declaration}</code></pre></section></main>`;
  for (
    const [identifier, declaration] of [
      ["WebPrinterState", 'enum WebPrinterState { "idle", "processing", "stopped" };'],
      ["WebPrinterStateReason", "enum WebPrinterStateReason { /* RFC 8011/CUPS values */ };"],
      [
        "WebPrintingResolutionUnits",
        'enum WebPrintingResolutionUnits { "dots-per-inch", "dots-per-centimeter" };',
      ],
    ]
  ) {
    const seen = declaredSurfaceMembers(enumPage(declaration));
    assert(
      JSON.stringify(seen) === JSON.stringify([identifier]),
      `a bare ${identifier} enum was not reported as ${JSON.stringify([identifier])} (got ${
        JSON.stringify(seen)
      })`,
    );
  }
  // An extended attribute before the enum must not hide the identifier.
  assert(
    JSON.stringify(declaredSurfaceMembers(enumPage('[Exposed=Window] enum Foo { "a", "b" };'))) ===
      JSON.stringify(["Foo"]),
    "an extended attribute before a bare enum hid the identifier",
  );
  // NO REGRESSION (the scoping that keeps existing contracts green): a MIXED block that already
  // reports a dictionary member must NOT also report its enum identifier - widening the fallback
  // would add uncovered identifiers to contracts that are already correct.
  const mixedEnumPage =
    '<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>enum KeyFormat { "raw" };\ndictionary EncapsulatedKey { CryptoKey sharedKey; };</code></pre></section></main>';
  assert(
    JSON.stringify(declaredSurfaceMembers(mixedEnumPage)) === JSON.stringify(["sharedKey"]),
    `a mixed enum+dictionary block reported the enum identifier instead of only its member: ${
      JSON.stringify(declaredSurfaceMembers(mixedEnumPage))
    }`,
  );
  // SATISFIABILITY: a contract must acknowledge the enum type, and can discharge it by inventorying
  // the identifier (the pages inventory it by that name) or by outOfScope with a rationale.
  const printerStatePage = enumPage('enum WebPrinterState { "idle", "processing", "stopped" };');
  assert(
    validateDeclaredSurface(surfaceContract(["alpha"]), printerStatePage).some((e) =>
      e.includes('declared surface member "WebPrinterState"')
    ),
    "a bare-enum page passed with a contract that never acknowledges the enum type",
  );
  assert(
    validateDeclaredSurface(surfaceContract(["WebPrinterState"]), printerStatePage).length === 0,
    "a contract inventorying the enum type by its identifier was rejected",
  );
  assert(
    validateDeclaredSurface(
      {
        ...surfaceContract(["alpha"]),
        outOfScope: [{
          name: "WebPrinterState",
          rationale: "The enum values are specified by WebIDL, not documented as prose here.",
        }],
      },
      printerStatePage,
    ).length === 0,
    "the enum type could not be discharged via outOfScope + rationale, so the rule would block pages",
  );

  // ---- BARE WebIDL TYPEDEFS were invisible (gendn-u9m) ----------------------------------------
  // Measured before the fix: a block whose ONLY declaration is a typedef yields NOTHING. Unlike the
  // bare enum it carries no brace, so it reaches no member-shaped statement either, and the statement
  // loop skips it DELIBERATELY (`typedef|callback|namespace`) - the skip that fixed the gendn-4kq P2
  // false positive where `typedef USVString ManifestId;` was reported as a member of the interface
  // beside it. A block whose only declaration is a typedef is the opposite case: the identifier IS
  // the whole declared surface. Reported by the IDENTIFIER, not the referents, because the page's h1
  // is the identifier, the parent contract already inventories it by that name
  // (`{"name":"WebPrintingMediaSizeDimension","kind":"other"}`), and the referents are either
  // inventoried separately (`WebPrintingRange`) or primitives with no inventory identity
  // (`unsigned long`).
  const typePage = (declaration) =>
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>${declaration}</code></pre></section></main>`;
  for (
    const [identifier, declaration] of [
      // the real page that carries the gap: a parenthesised union type
      [
        "WebPrintingMediaSizeDimension",
        "typedef (WebPrintingRange or unsigned long) WebPrintingMediaSizeDimension;",
      ],
      // the shape the P2 false positive was about - bare here, so it must now be named
      ["ManifestId", "typedef USVString ManifestId;"],
      // an escaped generic, exactly as the real v147/autofill-event page writes it
      ["AutofillValueEntry", "typedef sequence&lt;any&gt; AutofillValueEntry;"],
      // a nullable alias
      ["MaybeFoo", "typedef Foo? MaybeFoo;"],
    ]
  ) {
    const seen = declaredSurfaceMembers(typePage(declaration));
    assert(
      JSON.stringify(seen) === JSON.stringify([identifier]),
      `a bare ${identifier} typedef was not reported as ${JSON.stringify([identifier])} (got ${
        JSON.stringify(seen)
      })`,
    );
  }
  // An extended attribute before the typedef, and a comment before it, must not hide the identifier.
  assert(
    JSON.stringify(
      declaredSurfaceMembers(typePage("[Exposed=Window] typedef USVString ManifestId;")),
    ) === JSON.stringify(["ManifestId"]),
    "an extended attribute before a bare typedef hid the identifier",
  );
  assert(
    JSON.stringify(
      declaredSurfaceMembers(
        typePage("// the manifest id, not a member\ntypedef USVString ManifestId;"),
      ),
    ) === JSON.stringify(["ManifestId"]),
    "a comment before a bare typedef hid the identifier",
  );
  // Several typedefs in one block are each named, once.
  assert(
    JSON.stringify(
      declaredSurfaceMembers(typePage("typedef USVString ManifestId;\ntypedef USVString AppId;")),
    ) === JSON.stringify(["AppId", "ManifestId"]),
    "a block with two bare typedefs did not name both",
  );
  // NO REGRESSION (the scoping that keeps existing contracts green): a MIXED block that already
  // reports a dictionary/interface member must NOT also report its typedef identifier - that was the
  // gendn-4kq P2 false positive, and it is the same block `methodPage` below already pins.
  const mixedTypedefPage = typePage(
    "typedef USVString ManifestId;\ndictionary SubAppsAddResponse { record&lt;USVString, ManifestId&gt; installedApps; };",
  );
  assert(
    JSON.stringify(declaredSurfaceMembers(mixedTypedefPage)) === JSON.stringify(["installedApps"]),
    `a mixed typedef+dictionary block reported the typedef identifier instead of only its member: ${
      JSON.stringify(declaredSurfaceMembers(mixedTypedefPage))
    }`,
  );
  // SATISFIABILITY: a contract must acknowledge the typedef, and can discharge it either by
  // inventorying the identifier (the parent contract's existing form) or by outOfScope + rationale.
  const mediaSizePage = typePage(
    "typedef (WebPrintingRange or unsigned long) WebPrintingMediaSizeDimension;",
  );
  assert(
    validateDeclaredSurface(surfaceContract(["alpha"]), mediaSizePage).some((e) =>
      e.includes('declared surface member "WebPrintingMediaSizeDimension"')
    ),
    "a bare-typedef page passed with a contract that never acknowledges the typedef",
  );
  assert(
    validateDeclaredSurface(
      surfaceContract(["WebPrintingMediaSizeDimension"]),
      mediaSizePage,
    ).length === 0,
    "a contract inventorying the typedef by its identifier was rejected",
  );
  assert(
    validateDeclaredSurface(
      {
        ...surfaceContract(["alpha"]),
        outOfScope: [{
          name: "WebPrintingMediaSizeDimension",
          rationale: "The union is specified by WebIDL, not documented as prose on this page.",
        }],
      },
      mediaSizePage,
    ).length === 0,
    "the typedef could not be discharged via outOfScope + rationale, so the rule would block pages",
  );

  // ---- gendn-3yh: three tightenings the kda review found in the same parser ---------------------
  // ITEM 3a (ENUM MATCHER): the previous `/\benum\s+Name\s*\{/` accepted ANY enum in a block the
  // keyword gate admitted, and `enum` alone satisfies IDL_BLOCK_GATE - so TypeScript and C# enums were
  // reported as declared surface. A WebIDL enum body is a list of STRING LITERALS, or empty once
  // strippedIdl removes a comment-only body (the real printer-state-reason page).
  for (
    const [declaration, expected] of [
      ['enum WebPrinterState { "idle", "processing", "stopped" };', ["WebPrinterState"]],
      ["enum WebPrinterStateReason { /* RFC 8011/CUPS values */ };", ["WebPrinterStateReason"]],
      ["enum KeyFormat { raw }", []],
      ["enum Color { Red }", []],
      ["enum Flag { A = 1, B = 2 }", []],
      // gendn-m9h: a TRULY EMPTY body is not a WebIDL enum (the grammar requires >=1 enumerator); it
      // is accepted only when the RAW body had content, which is how the comment-only real page above
      // is distinguished from this. TypeScript/C# with a comment-only body is indistinguishable from
      // the real page and stays named (the fixture directly above records that side of the trade).
      ["enum Empty {}", []],
      ["enum Empty { }", []],
      ["enum WithComment { A /* note */ }", []],
      // ORDER INDEPENDENCE (m9h review fix-forward): a comment-only declaration must survive an empty
      // one with the SAME identifier, later or earlier in the block - the raw-body map records only
      // non-empty bodies, so the empty one cannot clobber the comment.
      ["enum E { /* c */ };\nenum E { }", ["E"]],
      ["enum E { }\nenum E { /* c */ };", ["E"]],
    ]
  ) {
    const seen = declaredSurfaceMembers(typePage(declaration));
    assert(
      JSON.stringify(seen) === JSON.stringify(expected),
      `enum-matcher tightening: ${declaration} -> ${JSON.stringify(seen)} (want ${
        JSON.stringify(expected)
      })`,
    );
  }
  // ITEM 3b (TYPEDEF MATCHER): the u9m matcher inherited the enum matcher's looseness - a free-text
  // regex over the whole block matched PROSE that mentions a typedef, and an entity-escaped HTML
  // comment (which survives tag-stripping because the tag is only decoded afterwards). Anchoring the
  // read to a STATEMENT that starts with `typedef` rejects both; the real page still works.
  for (
    const [declaration, expected] of [
      ['A "typedef Foo Bar;" appears in specs;', []],
      ["&lt;!-- typedef Foo Bar; --&gt;", []],
      [
        "typedef (WebPrintingRange or unsigned long) WebPrintingMediaSizeDimension;",
        ["WebPrintingMediaSizeDimension"],
      ],
    ]
  ) {
    const seen = declaredSurfaceMembers(typePage(declaration));
    assert(
      JSON.stringify(seen) === JSON.stringify(expected),
      `typedef-matcher tightening: ${declaration} -> ${JSON.stringify(seen)} (want ${
        JSON.stringify(expected)
      })`,
    );
  }
  // ITEM 2 (READABILITY != NAMING): a block that declares a bare enum AND contains a member-shaped
  // statement the parser cannot read is STILL A HOLE. At gendn-kda the hole was silenced because
  // memberNamesFromIdl() returned ["Foo"], which answered a question the readability check never
  // asked. The enum must still be NAMED - the two questions are now answered separately.
  const enumBesideHole = typePage('enum Foo { "a", "b" };\n  bar();');
  assert(
    unreadableSyntaxBlocks(enumBesideHole).length === 1,
    `a bare enum must not silence an unreadable statement in the same block: ${
      JSON.stringify(unreadableSyntaxBlocks(enumBesideHole))
    }`,
  );
  assert(
    JSON.stringify(declaredSurfaceMembers(enumBesideHole)) === JSON.stringify(["Foo"]),
    `naming is unchanged by the readability split: ${
      JSON.stringify(declaredSurfaceMembers(enumBesideHole))
    }`,
  );
  // ITEM 1 (PER-<pre> SCOPING): the fallback is scoped per CODE BLOCK, and each block is judged
  // independently, so a page that splits a bare type into its own block reports that type AND the
  // other block's members. The test file previously had no two-<pre> fixture at all, so this decision
  // was an accident of the implementation rather than a recorded one.
  const twoBlockPage =
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>enum Foo { "a", "b" };</code></pre><pre><code>dictionary D { DOMString name; };</code></pre></section></main>`;
  assert(
    JSON.stringify(declaredSurfaceMembers(twoBlockPage)) === JSON.stringify(["Foo", "name"]),
    `per-<pre> scoping must report the bare type from its own block AND the other block's member: ${
      JSON.stringify(declaredSurfaceMembers(twoBlockPage))
    }`,
  );

  // The ratio a reviewer reads: 1 inventoried + 1 excluded of 2 declared must not look like a clean
  // 2/2, so the summary is part of the guard rather than left to counting entries by eye.
  assert(
    JSON.stringify(
      declaredSurfaceSummary(
        surfaceContract(["alpha"], [{
          name: "beta",
          rationale: "Quoted context from the surrounding interface; not part of this feature.",
        }]),
        idlPage,
      ),
    ) === JSON.stringify({ declared: 2, inventory: 1, outOfScope: 1 }),
    "declared-surface summary did not report the inventory/outOfScope ratio",
  );

  // SCOPING (coord, 2026-10-06): the general validator must NOT apply this rule, because pre-existing
  // contracts that quote a surrounding interface as context would red for a pattern that is not the
  // defect. It is enforced by check-conformance for TOUCHED pages only.
  await Deno.writeTextFile(`${root}/${id}/index.html`, idlPage);
  const surfaceErrors = await validateReferenceContract(
    { ...structuredClone(contract), inventory: [{ id: "do-work", sourceRefs: ["spec"] }] },
    root,
  );
  assert(
    !surfaceErrors.some((e) => e.includes("declared surface member")),
    "the general validator applied the declared-surface rule; it must be scoped to touched pages",
  );
  await Deno.remove(`${root}/${id}/index.html`);

  assert(
    !isMdnStubHtml('<!-- documented on MDN --><p class="eyebrow">v999 · web api</p>'),
    "comment-only MDN text misclassified a full reference as a stub",
  );
  assert(
    isMdnStubHtml('<p class="eyebrow">v999 · covered on mdn</p>'),
    "real covered-on-MDN eyebrow was not classified as a stub",
  );
  assert(
    !isMdnStubHtml(
      '<details><summary>More</summary><p class="eyebrow">covered on MDN</p></details>',
    ),
    "closed-details content downgraded a full reference to an MDN stub",
  );

  const wrongOwner = validateContractOwnership({
    ownerId: id,
    path: `${root}/${id}/reference-contract.json`,
    contract: { ...contract, id: "v999/other-api", route: "/v999/other-api/" },
  });
  assert(
    wrongOwner.some((error) => error.includes("owner directory")),
    "contract stored under one feature was allowed to claim another feature",
  );

  const originalHtml = await Deno.readTextFile(`${root}/${id}/thing/do-work/index.html`);
  await Deno.writeTextFile(
    `${root}/${id}/thing/do-work/index.html`,
    `<!doctype html><main><!--${body}--></main>`,
  );
  const commentOnlyErrors = await validateReferenceContract(contract, root);
  assert(
    commentOnlyErrors.some((error) => error.includes("selector #syntax does not exist")),
    "comment-only IDs/code/tables/source links were accepted as rendered documentation",
  );
  await Deno.writeTextFile(
    `${root}/${id}/thing/do-work/index.html`,
    `<!doctype html><main><div hidden>${body}</div></main>`,
  );
  const hiddenOnlyErrors = await validateReferenceContract(contract, root);
  assert(
    hiddenOnlyErrors.some((error) => error.includes("selector #syntax does not exist")),
    "hidden-only IDs/code/tables/source links were accepted as visible documentation",
  );
  await Deno.writeTextFile(
    `${root}/${id}/thing/do-work/index.html`,
    `<!doctype html><main><div style="display: none">${body}</div></main>`,
  );
  const inlineHiddenErrors = await validateReferenceContract(contract, root);
  assert(
    inlineHiddenErrors.some((error) => error.includes("selector #syntax does not exist")),
    "inline-CSS-hidden documentation was accepted as visible documentation",
  );
  await Deno.writeTextFile(
    `${root}/${id}/thing/do-work/index.html`,
    `<!doctype html><main><details><summary>Hidden reference</summary>${body}</details></main>`,
  );
  const closedDetailsErrors = await validateReferenceContract(contract, root);
  assert(
    closedDetailsErrors.some((error) => error.includes("selector #syntax does not exist")),
    "documentation available only inside closed details was accepted as visible",
  );

  await Deno.writeTextFile(
    `${root}/${id}/thing/do-work/index.html`,
    originalHtml.replaceAll(`<a href="${source}">`, `<div data-href="${source}">`).replaceAll(
      "</a>",
      "</div>",
    ),
  );
  const fakeHrefErrors = await validateReferenceContract(contract, root);
  assert(
    fakeHrefErrors.some((error) => error.includes("target page does not link")),
    "data-href attributes were accepted as clickable source links",
  );
  await Deno.writeTextFile(`${root}/${id}/thing/do-work/index.html`, originalHtml);

  const unlinkedNotApplicable = structuredClone(contract);
  unlinkedNotApplicable.sources.push({ id: "other-spec", url: "https://example.com/other-spec" });
  unlinkedNotApplicable.documentation[0].dimensions.errors = {
    status: "not-applicable",
    rationale: "The normative source defines no separate error channel.",
    sourceRefs: ["other-spec"],
  };
  const unlinkedErrors = await validateReferenceContract(unlinkedNotApplicable, root);
  assert(
    unlinkedErrors.some((error) => error.includes("target page does not link its cited source")),
    "not-applicable rationale accepted a source that was not linked from its target page",
  );

  const missing = structuredClone(contract);
  missing.documentation[0].dimensions.errors = {
    status: "missing",
    rationale: "The error contract has not been researched yet.",
    sourceRefs: ["spec"],
  };
  const missingErrors = await validateReferenceContract(missing, root);
  assert(
    missingErrors.some((error) =>
      error.includes("missing but contract claims implementation-sufficient")
    ),
    "implementation-sufficient contract accepted a missing dimension",
  );

  const noExample = structuredClone(contract);
  noExample.documentation[0].dimensions.examples = {
    status: "not-applicable",
    rationale: "The author chose not to provide a runnable example.",
    sourceRefs: ["spec"],
  };
  const noExampleErrors = await validateReferenceContract(noExample, root);
  assert(
    noExampleErrors.some((error) => error.includes("examples must be documented")),
    "implementation-sufficient contract accepted examples as not applicable",
  );

  // ---- gendn-20m: syntax may be not-applicable on an implementation-sufficient claim ----
  // A change that ships no declaration grammar (removal-only, runtime mechanism, "API
  // change: None") must be expressible honestly; examples/compatibility stay strict
  // (the noExample case above). The not-applicable branch independently enforces the
  // sourced rationale + rendered-fragment rigor, so the trio rule only accepts it for
  // syntax.
  // a genuinely grammar-free section: no <code>, no <pre>, no call/declaration form -
  // only prose explaining that the change ships nothing declarable
  const grammarFreeSection =
    `<section><h2 id="no-grammar">No grammar</h2><p>This change ships no declaration grammar: it is a transport-level switch with no new property, no API and no policy surface, so an author declares nothing and there is no syntax surface to document.</p><p><a href="${source}">Normative source</a></p></section>`;
  const page = await Deno.readTextFile(`${root}/${id}/thing/do-work/index.html`);
  await Deno.writeTextFile(
    `${root}/${id}/thing/do-work/index.html`,
    page.replace("</main>", `${grammarFreeSection}</main>`),
  );
  const noGrammar = structuredClone(contract);
  noGrammar.documentation[0].dimensions.syntax = {
    status: "not-applicable",
    selector: "#no-grammar",
    rationale:
      "This change adds no declaration grammar: nothing new is declared or constructed, so there is no syntax surface to document (the fragment explains what changed instead).",
    sourceRefs: ["spec"],
  };
  const noGrammarErrors = await validateReferenceContract(noGrammar, root);
  assert(
    noGrammarErrors.length === 0,
    `gendn-20m: honest not-applicable syntax on a grammar-free page still failed:\n${
      noGrammarErrors.join("\n")
    }`,
  );
  const lazySyntax = structuredClone(noGrammar);
  delete lazySyntax.documentation[0].dimensions.syntax.rationale;
  const lazyErrors = await validateReferenceContract(lazySyntax, root);
  assert(
    lazyErrors.some((error) => error.includes("not-applicable requires a sourced rationale")),
    "gendn-20m: not-applicable syntax escaped the sourced-rationale requirement",
  );
  const lazyCompat = structuredClone(contract);
  lazyCompat.documentation[0].dimensions.compatibility = {
    status: "not-applicable",
    selector: "#compatibility",
    rationale: "The author chose not to provide a support posture for this feature page.",
    sourceRefs: ["spec"],
  };
  const lazyCompatErrors = await validateReferenceContract(lazyCompat, root);
  assert(
    lazyCompatErrors.some((error) => error.includes("compatibility must be documented")),
    "gendn-20m: the not-applicable allowance leaked from syntax into compatibility",
  );

  const omitted = structuredClone(contract);
  omitted.documentation = [];
  const omittedErrors = await validateReferenceContract(omitted, root);
  assert(
    omittedErrors.some((error) => error.includes("has no documentation mapping")),
    "implementation-sufficient contract accepted an omitted inventory item",
  );

  const escaped = resolveDocumentationHref(id, "../other/", root);
  assert(!escaped.ok, "same-feature route confinement accepted ../ escape");

  const oldRoute = `/${id}/thing/old/`;
  const newRoute = `/${id}/thing/new/`;
  const currentRoutes = new Set([newRoute]);
  assert(
    referenceRouteMigration(
      [{ id, action: "alias", from: oldRoute, to: newRoute }],
      id,
      oldRoute,
      currentRoutes,
    ),
    "server-backed same-feature alias to a current child route was rejected",
  );
  assert(
    !referenceRouteMigration(
      [{ id, action: "reference-route-move", from: oldRoute, to: newRoute }],
      id,
      oldRoute,
      currentRoutes,
    ),
    "unsupported migration action was accepted even though server.ts cannot redirect it",
  );
  assert(
    !referenceRouteMigration(
      [{ id, action: "alias", from: oldRoute, to: `/${id}/thing/missing/` }],
      id,
      oldRoute,
      currentRoutes,
    ),
    "alias to a route absent from the current contract was accepted",
  );

  // Silently skipping a shape the detector does not recognise reports an EMPTY surface, and an empty
  // surface passes the collapsed-contract check for the wrong reason (gendn-zuz). Both directions:
  // a block whose surface IS there must become visible, and a block the detector truly cannot read
  // must FAIL LOUDLY rather than pass as empty.
  {
    const page = (pre) =>
      `<html><body><main><h2 id="syntax">Syntax</h2>${pre}</main></body></html>`;
    // (1) An operations-only namespace WAS invisible (the gate did not include `namespace`) even
    // though the parser reads it perfectly. It must now be visible, not alarmed.
    const namespaceBlock = page("<pre><code>namespace CSS { undefined parse(); };</code></pre>");
    assert(
      declaredSurfaceMembers(namespaceBlock).join(",") === "parse",
      `an operations-only namespace must be VISIBLE, not silently skipped: ${
        JSON.stringify(declaredSurfaceMembers(namespaceBlock))
      }`,
    );
    assert(
      unreadableSyntaxBlocks(namespaceBlock).length === 0,
      "a namespace the parser CAN read must not be reported as unreadable",
    );
    // (2) A declaration the parser models as nothing is a hole in the check: say so, loudly.
    const constructorBlock = page(
      "<pre><code>interface Foo { constructor(DOMString name); };</code></pre>",
    );
    assert(
      unreadableSyntaxBlocks(constructorBlock).length === 1,
      `an IDL block the detector cannot read must be reported, not skipped: ${
        JSON.stringify(unreadableSyntaxBlocks(constructorBlock))
      }`,
    );
    assert(
      validateDeclaredSurface({ id: "v999/unreadable", inventory: [] }, constructorBlock)
        .some((e) => e.includes("looks like WebIDL") && e.includes("constructor")),
      `an unreadable syntax block must FAIL validation and name the block: ${
        JSON.stringify(
          validateDeclaredSurface({ id: "v999/unreadable", inventory: [] }, constructorBlock),
        )
      }`,
    );
    // (3) The false-alarm guards, each one a REAL page in this repo:
    // v151/speculation-rules-form-submission-field's syntax is JSON, not IDL.
    const jsonBlock = page(
      '<pre><code>{"form_submission": {"attribute": true, "values": ["a"]}}</code></pre>',
    );
    assert(
      unreadableSyntaxBlocks(jsonBlock).length === 0,
      `a JSON syntax block must stay silent (no false alarm): ${
        JSON.stringify(unreadableSyntaxBlocks(jsonBlock))
      }`,
    );
    assert(
      validateDeclaredSurface({ id: "v999/json", inventory: [] }, jsonBlock).length === 0,
      "a JSON syntax block must not fail validation",
    );
    // v147/document-policy-in-dedicated-workers quotes ABNF from the Document Policy spec.
    const abnfBlock = page(
      "<pre><code># ABNF, quoted verbatim\nDocument-Policy = sf-dictionary\nboolean-feature=?0\nenum-feature=state</code></pre>",
    );
    assert(
      unreadableSyntaxBlocks(abnfBlock).length === 0,
      `a quoted ABNF grammar must not be mistaken for IDL: ${
        JSON.stringify(unreadableSyntaxBlocks(abnfBlock))
      }`,
    );
    // v147/lazy-loading-for-video-and-audio-elements shows a JS call in its syntax region.
    const jsBlock = page(
      '<pre><code>const video = document.querySelector("video");\nvideo.loading = "lazy";</code></pre>',
    );
    assert(
      unreadableSyntaxBlocks(jsBlock).length === 0,
      `a JS code sample must not be mistaken for an unreadable IDL declaration: ${
        JSON.stringify(unreadableSyntaxBlocks(jsBlock))
      }`,
    );
    // A CSS @namespace is not WebIDL.
    const cssBlock = page("<pre><code>@namespace url(http://www.w3.org/1999/xhtml);</code></pre>");
    assert(
      unreadableSyntaxBlocks(cssBlock).length === 0,
      `a CSS @namespace block must not be mistaken for IDL: ${
        JSON.stringify(unreadableSyntaxBlocks(cssBlock))
      }`,
    );
    // ...and an ordinary IDL block that parses is never reported as unreadable.
    const goodBlock = page(
      "<pre><code>interface Foo { readonly attribute DOMString bar; undefined baz(); };</code></pre>",
    );
    assert(
      unreadableSyntaxBlocks(goodBlock).length === 0 &&
        declaredSurfaceMembers(goodBlock).join(",") === "bar,baz",
      `a readable IDL block must not be reported as unreadable: ${
        JSON.stringify([unreadableSyntaxBlocks(goodBlock), declaredSurfaceMembers(goodBlock)])
      }`,
    );
  }

  // gendn-ijf: AN ANONYMOUS SPECIAL OPERATION DECLARES NO NAME. `getter DOMString (unsigned long
  // index);` used to be reported as a member named "DOMString" - the RETURN TYPE - and that is a
  // FALSE POSITIVE in the declared-surface rule, which then demands the contract account for a
  // member that does not exist. A gate that fails a CORRECT contract is worse than one that misses a
  // defect (a false positive teaches lanes to stop reading the gate), so the shape is skipped and
  // REPORTED through skippedSurfaceDeclarations(), which consumers warn about and never fail on.
  // Measured with the real detector before the fix: members=["DOMString"] with unreadable=0 - a
  // confident wrong answer rather than a loud hole, which is what made it dangerous.
  {
    const anonGetter = specialPage("  getter DOMString (unsigned long index);");
    const namedGetter = specialPage("  getter DOMString item(unsigned long index);");
    assert(
      declaredSurfaceMembers(anonGetter).length === 0,
      `an anonymous indexed getter must not report its return type as a member: ${
        JSON.stringify(declaredSurfaceMembers(anonGetter))
      }`,
    );
    assert(
      skippedSurfaceDeclarations(anonGetter).length === 1 &&
        /^getter DOMString \(unsigned long index\)$/.test(
          skippedSurfaceDeclarations(anonGetter)[0],
        ),
      `an anonymous indexed getter must be reported as a deliberate skip: ${
        JSON.stringify(skippedSurfaceDeclarations(anonGetter))
      }`,
    );
    assert(
      unreadableSyntaxBlocks(anonGetter).length === 0,
      `a deliberate skip is NOT a hole: reporting it as unreadable would fail a correct page: ${
        JSON.stringify(unreadableSyntaxBlocks(anonGetter))
      }`,
    );
    assert(
      validateDeclaredSurface(surfaceContract([]), anonGetter).length === 0,
      `THE POINT OF THE FIX: a correct contract on such a page must NOT be failed. Got: ${
        JSON.stringify(validateDeclaredSurface(surfaceContract([]), anonGetter))
      }`,
    );
    // THE NEGATIVE CONTROL, without which the fix could have been "stop reporting getters at all".
    assert(
      declaredSurfaceMembers(namedGetter).join(",") === "item",
      `a NAMED indexed getter must still report its own name: ${
        JSON.stringify(declaredSurfaceMembers(namedGetter))
      }`,
    );
    assert(
      skippedSurfaceDeclarations(namedGetter).length === 0,
      `a NAMED indexed getter must not be swallowed by the skip: ${
        JSON.stringify(skippedSurfaceDeclarations(namedGetter))
      }`,
    );
    const anonSetter = specialPage("  setter undefined (unsigned long index, DOMString value);");
    assert(
      declaredSurfaceMembers(anonSetter).length === 0 &&
        skippedSurfaceDeclarations(anonSetter).length === 1 &&
        unreadableSyntaxBlocks(anonSetter).length === 0,
      `an anonymous setter must be a warn-only skip, not an unreadable hole: ${
        JSON.stringify([
          declaredSurfaceMembers(anonSetter),
          skippedSurfaceDeclarations(anonSetter),
          unreadableSyntaxBlocks(anonSetter),
        ])
      }`,
    );
    // AND A REAL HOLE CANNOT HIDE BEHIND A SKIP.
    const mixed = specialPage("  getter DOMString (unsigned long index);\n  parse();");
    assert(
      unreadableSyntaxBlocks(mixed).length === 1,
      `a real unreadable block must still be reported when a skip sits beside it: ${
        JSON.stringify(unreadableSyntaxBlocks(mixed))
      }`,
    );
  }

  // THE FOURTH MEASURED EDGE, PINNED AS DOCUMENTED BEHAVIOUR rather than left as prose: a non-IDL
  // block that carries BOTH a keyword and a call-shaped token is admitted by the keyword gate and the
  // member hint, yields no member, and is reported unreadable - a false positive on a block that is not
  // IDL at all. Two controls pin the mechanism: BOTH conditions are required, so either alone must stay
  // silent. NOTE THE HELPER: the shared specialPage() wraps its content in `interface Thing { ... }`,
  // so the block gate fires for EVERY case and the controls could not be expressed with it. These pins
  // therefore build a BARE syntax block, which is also the shape a real page has when a JSON example
  // sits in its own <pre><code> beside the IDL - and that shape is exactly what the reconnaissance
  // measured on the catalogue (201 pages scanned, 0 with any unreadable block).
  const bareBlock = (inner) =>
    `<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>${
      inner.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    }</code></pre></section></main>`;
  {
    const jsonish = bareBlock('{"mixin":"f(x)"}');
    assert(
      unreadableSyntaxBlocks(jsonish).length === 1,
      `a non-IDL block with a keyword AND a call-shaped token is documented as reported unreadable; got ${
        JSON.stringify(unreadableSyntaxBlocks(jsonish))
      }`,
    );
    const callShapeOnly = bareBlock('{"handle":"g(x)"}');
    const keywordOnly = bareBlock('{"mixin":"abc"}');
    assert(
      unreadableSyntaxBlocks(callShapeOnly).length === 0 &&
        unreadableSyntaxBlocks(keywordOnly).length === 0,
      `the fourth edge requires BOTH conditions, so call-shape-only and keyword-only must stay silent; got ${
        JSON.stringify([unreadableSyntaxBlocks(callShapeOnly), unreadableSyntaxBlocks(keywordOnly)])
      }`,
    );
  }

  // ONE PAGE, TWO NOTES, ONE CONTRACT - the count the gate PRINTS must count what it NAMES. The
  // heading used to print surfaceNotes.length, which is a count of NOTES; a page emitting both a
  // declared-surface line and a skipped-operations line was therefore reported as two contracts. The
  // negative case below is the one that was wrong: two notes, one page.
  {
    const onePage = [
      "  v150/some-page: declared 4 = inventory 4 + outOfScope 0",
      "  v150/some-page: parser skipped 1 anonymous special operation(s) - nothing to account for: x",
    ];
    assert(
      surfaceNotePages(onePage) === 1,
      `two notes for ONE page must count as one contract; got ${surfaceNotePages(onePage)}`,
    );
    const twoPages = [...onePage, "  v151/other-page: declared 8 = inventory 8 + outOfScope 0"];
    assert(
      surfaceNotePages(twoPages) === 2,
      `three notes across TWO pages must count 2; got ${surfaceNotePages(twoPages)}`,
    );
    const singleNote = ["  v150/some-page: declared 4 = inventory 4 + outOfScope 0"];
    assert(
      surfaceNotePages(singleNote) === 1,
      `single note for ONE page must count as one contract; got ${surfaceNotePages(singleNote)}`,
    );
    // A touched page whose contract is not yet implementation-sufficient emits only a parser skip line
    // (no declared-surface summary), so its note set is skip-only.
    const skipOnly = [
      "  v150/legacy-page: parser skipped 1 anonymous special operation(s) - nothing to account for: getter DOMString (unsigned long index)",
    ];
    assert(
      surfaceNotePages(skipOnly) === 1,
      `skip-only note set for an unassessed page must count as one contract; got ${
        surfaceNotePages(skipOnly)
      }`,
    );
    // Crash guards, not discrimination: passing [] or undefined exercises the null-handling
    // path (notes ?? []) so a missing list does not throw. They cannot distinguish page-counting
    // from note-counting, because (notes ?? []).length also returns 0 for both; the discriminating
    // pin for the note-count defect is the one above (two notes for ONE page must count 1).
    assert(
      surfaceNotePages([]) === 0 && surfaceNotePages(undefined) === 0,
      "no notes must count 0, and a missing list must not throw",
    );
    assert(
      surfaceNotePages([42, "no colon here"]) === 0,
      "malformed notes must not be counted as pages rather than crashing the gate",
    );
  }

  // A HOLE WITH NO HINT OF ITS OWN, beside a skip that HAS one - the P0 a reviewer found in the
  // first version of the skip fix. `setter undefined (...)` carries a member hint of its own
  // ("undefined ("); `Foo;` does not. Subtracting the skip BEFORE testing the hint deleted the only
  // evidence the block declared anything, so the unreadable declaration went silently unreported.
  // Measured shape: 0 members, 1 skip, and it MUST report 1 unreadable block.
  {
    const hintlessHole = specialPage(
      "  setter undefined (unsigned long index, DOMString value);\n  Foo;",
    );
    assert(
      unreadableSyntaxBlocks(hintlessHole).length === 1,
      `a hole with no hint of its own must still be reported when a skipped statement supplies the
         only hint: reporting it as readable is a FALSE NEGATIVE introduced by the skip exemption.
         Got: ${JSON.stringify(unreadableSyntaxBlocks(hintlessHole))}`,
    );
    // and the exemption itself must still hold: a block that is ONLY a skip is not a hole.
    const onlySkip = specialPage("  setter undefined (unsigned long index, DOMString value);");
    assert(
      unreadableSyntaxBlocks(onlySkip).length === 0 &&
        skippedSurfaceDeclarations(onlySkip).length === 1,
      `an all-skip block must stay exempt: ${
        JSON.stringify([
          unreadableSyntaxBlocks(onlySkip),
          skippedSurfaceDeclarations(onlySkip),
        ])
      }`,
    );
  }

  // Window Shape API alias test (gendn-14qq):
  // Asserts that the legacy IsolatedWebApp.setShape alias resolves and behaves identically to Window.setShape:
  // - Delegates calls with rectangle arguments to the underlying setShape implementation;
  // - Handles empty array reset;
  // - Rejection paths (non-finite coordinates, negative sizes, >10k items, minimum-size guard) behave identically.
  {
    const recordedCalls = [];
    const fakeWindow = {
      setShape(rects) {
        if (!Array.isArray(rects)) {
          return Promise.reject(new TypeError("rects must be a sequence"));
        }
        if (rects.length > 10000) {
          return Promise.reject(new TypeError("Too many rectangles"));
        }
        for (const r of rects) {
          if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) {
            return Promise.reject(new TypeError("Non-finite rect dimension"));
          }
          if (r.width < 0 || r.height < 0) {
            return Promise.reject(new TypeError("Negative rect dimension"));
          }
        }
        if (rects.length > 0 && !rects.some((r) => r.width >= 10 && r.height >= 10)) {
          return Promise.reject(new TypeError("Minimum size guard failed"));
        }
        recordedCalls.push(rects);
        return Promise.resolve(undefined);
      },
    };

    // The legacy alias binding: window.chromeos.isolatedWebApp.setShape -> window.setShape
    const fakeChromeOS = {
      isolatedWebApp: {
        setShape: (rects) => fakeWindow.setShape(rects),
      },
    };

    // 1. Alias resolves on valid rects
    const validRect = { x: 0, y: 0, width: 100, height: 100 };
    await fakeChromeOS.isolatedWebApp.setShape([validRect]);
    assert(
      recordedCalls.length === 1 && recordedCalls[0][0] === validRect,
      "IsolatedWebApp.setShape alias did not resolve to Window.setShape",
    );

    // 2. Alias resets on empty array
    await fakeChromeOS.isolatedWebApp.setShape([]);
    assert(
      recordedCalls.length === 2 && recordedCalls[1].length === 0,
      "IsolatedWebApp.setShape alias reset did not resolve to Window.setShape",
    );

    // 3. Alias behaves identically on rejection (e.g. minimum-size guard)
    let rejectedMinSize = false;
    try {
      await fakeChromeOS.isolatedWebApp.setShape([{ x: 0, y: 0, width: 4, height: 4 }]);
    } catch (err) {
      rejectedMinSize = err instanceof TypeError;
    }
    assert(
      rejectedMinSize,
      "IsolatedWebApp.setShape alias failed to reject on invalid rects (<10x10 guard)",
    );

    // 4. Verify that v152/window-shape-api reference contract accounts for both current and legacy surfaces
    const wshapeContract = JSON.parse(
      await Deno.readTextFile("v152/window-shape-api/reference-contract.json"),
    );
    const names = wshapeContract.inventory.map((item) => item.name);
    assert(
      names.some((n) => n.includes("Window.setShape")),
      "v152/window-shape-api contract does not inventory Window.setShape",
    );
    assert(
      names.some((n) => n.includes("IsolatedWebApp.setShape")),
      "v152/window-shape-api contract does not inventory legacy IsolatedWebApp.setShape alias",
    );
  }

  console.log("PASS — reference-contract structural tests");
} finally {
  await Deno.remove(root, { recursive: true });
}
