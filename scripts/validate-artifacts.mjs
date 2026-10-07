#!/usr/bin/env -S deno run --allow-read
// validate-artifacts.mjs — well-formedness gate for the lifecycle artifacts.
//
// Checks, for the working tree:
//   - every conformance.json validates against schema/conformance.schema.json, its stored suiteHash
//     equals the recomputed sha256 of its normalized assertions (tamper signal), its id maps to a
//     real published page, and its assertion ids are unique;
//   - every _questions.json validates against schema/questions.schema.json, and any critique that
//     scores frontend/responsive/a11y dimensions has a NON-EMPTY guidanceConsulted (missing guidance
//     = INCOMPLETE critique per the modern-web-guidance mandate);
//   - every present reference-contract.json validates against its schema and its source inventory,
//     stable same-feature targets, required dimensions, fragment content, examples, compatibility,
//     and direct source-link mappings reconcile structurally;
//   - goals.json and responsive-support.json validate against their schemas.
//
// This is the schema+hash half of immutability enforcement. The git-baseline weakening check
// (assertion removed/changed vs origin/main without a migration) lives in check-conformance.mjs.
//
// Exit 1 on any violation. Usage: deno run --allow-read scripts/validate-artifacts.mjs

import {
  collectCritiques,
  collectPublishedPages,
  loadSchema,
  pageMetadata,
  readJson,
  suiteHash,
  validate,
  validateSupportRecord,
} from "./lib/artifacts.mjs";
import {
  collectReferenceContracts,
  declaredSurfaceMembers,
  validateContractOwnership,
  validateReferenceContract,
} from "./lib/reference-contract.mjs";

const FRONTEND_DIMENSIONS = new Set(["responsive-ux", "accessibility", "examples"]);

async function main() {
  const errors = [];
  const [confSchema, qSchema, goalsSchema, supportSchema, referenceSchema] = await Promise.all([
    loadSchema("conformance.schema.json"),
    loadSchema("questions.schema.json"),
    loadSchema("goals.schema.json"),
    loadSchema("responsive-support.schema.json"),
    loadSchema("reference-contract.schema.json"),
  ]);

  const pages = await collectPublishedPages(".");
  const pageIds = new Set(pages.map((p) => p.replace(/\/index\.html$/, "")));

  // ---- conformance suites ----
  // Iterate the PHYSICAL page/suite pairs. Looking up a page by s.id alone lets a suite
  // inside one page tree claim the ID (and matching metadata) of another published page.
  const pageMeta = new Map();
  const metadataNotes = { status: [], demo: [], cpsFeatureRoute: [] };
  let suiteCount = 0;
  for (const pagePath of pages) {
    const ownerId = pagePath.replace(/\/index\.html$/, "");
    const meta = await pageMetadata(pagePath);
    pageMeta.set(ownerId, meta);
    const s = await readJson(`./${ownerId}/conformance.json`);
    if (!s) continue;
    suiteCount++;
    const tag = `conformance ${ownerId}/conformance.json`;
    const schemaErrs = validate(confSchema, s);
    for (const e of schemaErrs) errors.push(`${tag}: schema: ${e}`);
    if (!pageIds.has(s.id)) errors.push(`${tag}: id maps to no published page (orphan suite)`);
    // suiteHash covers assertions, not these top-level identity claims. Bind the zero-drift
    // fields to the colocated page even on a suite-only edit. No broad migration exemption:
    // a legitimate moved page needs a consistent suite at its destination.
    if (!meta.identity) errors.push(`${tag}: ${pagePath} has no ChromeStatus feature identity`);
    for (const field of ["id", "route", "identity", "milestone"]) {
      if (s[field] !== meta[field]) {
        errors.push(
          `${tag}: ${field} ${JSON.stringify(s[field])} differs from colocated page ${pagePath} (${
            JSON.stringify(meta[field])
          })`,
        );
      }
    }
    // Historical suites were frozen before later status/demo changes. Measured on main:
    // 1 status, 20 demo, 21 CPS-route differences on main 15377ff. Reported, not a green claim
    // about those fields; reconciliation is separate from the identity-binding fix.
    if (s.status !== meta.status) metadataNotes.status.push(ownerId);
    if (s.demo !== meta.demo) metadataNotes.demo.push(ownerId);
    const pageDemoRoute = meta.demo ? new URL(meta.demo).pathname : null;
    if ((s.cpsFeature?.route ?? null) !== pageDemoRoute) {
      metadataNotes.cpsFeatureRoute.push(ownerId);
    }
    if (Array.isArray(s.assertions)) {
      const ids = s.assertions.map((a) => a.id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupes.length) errors.push(`${tag}: duplicate assertion id(s): ${[...new Set(dupes)]}`);
      const recomputed = await suiteHash(s.assertions);
      if (s.suiteHash !== recomputed) {
        errors.push(
          `${tag}: suiteHash mismatch (stored ${s.suiteHash?.slice(0, 12)}… vs computed ${
            recomputed.slice(0, 12)
          }…) — file edited without regenerating hash`,
        );
      }
    }
  }

  // ---- critiques ----
  const critiques = await collectCritiques(".");
  let critiqueCount = 0;
  for (const c of critiques) {
    critiqueCount++;
    const tag = `critique ${c.id}`;
    const schemaErrs = validate(qSchema, c);
    for (const e of schemaErrs) errors.push(`${tag}: schema: ${e}`);
    if (c.id && !pageIds.has(c.id)) errors.push(`${tag}: id maps to no published page`);
    const scoresFrontend = c.frontendTouched === true ||
      (Array.isArray(c.rubric) && c.rubric.some((r) => FRONTEND_DIMENSIONS.has(r.dimension)));
    if (
      scoresFrontend && (!Array.isArray(c.guidanceConsulted) || c.guidanceConsulted.length === 0)
    ) {
      errors.push(
        `${tag}: INCOMPLETE — scores frontend/responsive/a11y dimensions but guidanceConsulted is empty ` +
          `(modern-web-guidance mandate: consult + record guidance before frontend judgement)`,
      );
    }
  }

  // ---- implementation-sufficiency reference contracts ----
  const builtIds = [...pageMeta.entries()].filter(([, meta]) => meta.status === "built").map((
    [id],
  ) => id);
  const referenceContracts = await collectReferenceContracts(".", [...pageIds]);
  const sufficientOwners = new Set();
  const partialOwners = new Set();
  for (const { ownerId, path, contract } of referenceContracts) {
    const tag = `reference contract ${path}`;
    const contractErrors = [];
    for (const e of validate(referenceSchema, contract)) {
      contractErrors.push(`${tag}: schema: ${e}`);
    }
    contractErrors.push(...validateContractOwnership({ ownerId, path, contract }));
    if (pageMeta.get(ownerId)?.status === "stub") {
      contractErrors.push(
        `${tag}: MDN redirect stubs do not use local implementation-sufficiency contracts`,
      );
    }
    contractErrors.push(...await validateReferenceContract(contract, "."));
    errors.push(...contractErrors);
    if (contractErrors.length === 0 && contract.completeness === "implementation-sufficient") {
      sufficientOwners.add(ownerId);
    }
    if (contractErrors.length === 0 && contract.completeness === "partial") {
      partialOwners.add(ownerId);
    }
  }

  // ---- goals.json ----
  const goals = await readJson("./goals.json");
  if (goals) {
    for (const e of validate(goalsSchema, goals)) errors.push(`goals.json: ${e}`);
  }

  // ---- responsive-support.json ----
  const support = await readJson("./responsive-support.json");
  if (support) {
    for (const e of validate(supportSchema, support)) errors.push(`responsive-support.json: ${e}`);
    for (const [route, record] of Object.entries(support.routes ?? {})) {
      const id = route.replace(/^\//, "").replace(/\/$/, "");
      if (!pageIds.has(id)) errors.push(`responsive-support.json: route ${route} maps to no page`);
      // Our minimal schema validator ignores if/then; check unsupported evidence in executable JS.
      for (const e of validateSupportRecord(route, record)) {
        errors.push(`responsive-support.json: ${e}`);
      }
    }
  }

  // Same split as check-conformance.mjs's census: the legacy-unassessed remainder is built pages
  // that are neither sufficient nor partial, split by whether the page's #syntax block declares a
  // WebIDL surface the reference-contract schema could assess or no IDL at all. The two gates must
  // print this parenthetical byte-identically for the same tree.
  let noIdlSurface = 0;
  for (const id of builtIds) {
    if (sufficientOwners.has(id) || partialOwners.has(id)) continue;
    const html = await Deno.readTextFile(`./${id}/index.html`).catch(() => null);
    if (html && declaredSurfaceMembers(html).length === 0) noIdlSurface++;
  }
  console.log("validate-artifacts");
  console.log(`  conformance suites : ${suiteCount} validated`);
  console.log(
    `  metadata notes     : ${metadataNotes.status.length} status / ${metadataNotes.demo.length} demo / ${metadataNotes.cpsFeatureRoute.length} CPS demo-route difference(s) (report-only)`,
  );
  console.log(`  critiques          : ${critiqueCount} validated`);
  console.log(
    `  implementation refs: ${sufficientOwners.size} sufficient / ${partialOwners.size} partial / ${
      builtIds.length - sufficientOwners.size - partialOwners.size
    } legacy-unassessed (of ${builtIds.length} built; ${noIdlSurface} have no IDL surface and are outside the reference-contract schema)`,
  );
  console.log(`  goals.json         : ${goals ? "present" : "absent"}`);
  console.log(`  responsive-support : ${support ? "present" : "absent"}`);

  if (errors.length) {
    console.error(`\nFAIL — ${errors.length} artifact problem(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    Deno.exit(1);
  }
  console.log("\nPASS — all lifecycle artifacts are well-formed.");
}

if (import.meta.main) await main();
