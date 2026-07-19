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
//   - goals.json and responsive-support.json validate against their schemas.
//
// This is the schema+hash half of immutability enforcement. The git-baseline weakening check
// (assertion removed/changed vs origin/main without a migration) lives in check-conformance.mjs.
//
// Exit 1 on any violation. Usage: deno run --allow-read scripts/validate-artifacts.mjs

import {
  collectCritiques,
  collectPublishedPages,
  collectSuites,
  loadSchema,
  readJson,
  suiteHash,
  validate,
} from "./lib/artifacts.mjs";

const FRONTEND_DIMENSIONS = new Set(["responsive-ux", "accessibility", "examples"]);

async function main() {
  const errors = [];
  const [confSchema, qSchema, goalsSchema, supportSchema] = await Promise.all([
    loadSchema("conformance.schema.json"),
    loadSchema("questions.schema.json"),
    loadSchema("goals.schema.json"),
    loadSchema("responsive-support.schema.json"),
  ]);

  const pages = await collectPublishedPages(".");
  const pageIds = new Set(pages.map((p) => p.replace(/\/index\.html$/, "")));

  // ---- conformance suites ----
  const suites = await collectSuites(".");
  let suiteCount = 0;
  for (const s of suites) {
    suiteCount++;
    const tag = `conformance ${s.id}`;
    const schemaErrs = validate(confSchema, s);
    for (const e of schemaErrs) errors.push(`${tag}: schema: ${e}`);
    if (!pageIds.has(s.id)) errors.push(`${tag}: id maps to no published page (orphan suite)`);
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

  // ---- goals.json ----
  const goals = await readJson("./goals.json");
  if (goals) {
    for (const e of validate(goalsSchema, goals)) errors.push(`goals.json: ${e}`);
  }

  // ---- responsive-support.json ----
  const support = await readJson("./responsive-support.json");
  if (support) {
    for (const e of validate(supportSchema, support)) errors.push(`responsive-support.json: ${e}`);
    for (const route of Object.keys(support.routes ?? {})) {
      const id = route.replace(/^\//, "").replace(/\/$/, "");
      if (!pageIds.has(id)) errors.push(`responsive-support.json: route ${route} maps to no page`);
    }
  }

  console.log("validate-artifacts");
  console.log(`  conformance suites : ${suiteCount} validated`);
  console.log(`  critiques          : ${critiqueCount} validated`);
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
