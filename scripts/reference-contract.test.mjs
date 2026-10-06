import { referenceRouteMigration } from "./check-routes.mjs";
import { isMdnStubHtml } from "./lib/artifacts.mjs";
import {
  declaredSurfaceMembers,
  declaredSurfaceSummary,
  resolveDocumentationHref,
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
  assert(
    validateDeclaredSurface(
      surfaceContract(["alpha"]),
      '<!doctype html><main><section><h2 id="syntax">Syntax</h2><pre><code>await thing.doWork("x");</code></pre></section></main>',
    ).length === 0,
    "a page with no declared IDL surface produced a phantom coverage failure",
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

  console.log("PASS — reference-contract structural tests");
} finally {
  await Deno.remove(root, { recursive: true });
}
