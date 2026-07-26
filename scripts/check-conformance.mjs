#!/usr/bin/env -S deno run --allow-read --allow-run
// check-conformance.mjs — the conformance + coverage gate (sibling of the route regression gate).
//
// Run before every push, alongside `deno task check-routes`. It enforces the immutable-conformance
// contract and reports lifecycle coverage denominators. FAILS (exit 1) on:
//   1. a published page with NO conformance suite (missing coverage);
//   2. an orphan suite id that maps to no published page;
//   3. a WEAKENED or REMOVED assertion vs the origin/main baseline without a migration record
//      (immutable = fix the page, never weaken/regenerate to go green). Adding assertions is fine;
//   4. a supported device class left untested / needs-review / broken for a feature tree the action
//      TOUCHED (git diff vs baseline);
//   5. a touched non-stub feature tree without an implementation-sufficient reference contract.
//
// REPORTS exact denominators: suites/published, critiques/published, mobile+desktop tested, and (if
// reports/conformance/results.json exists) assertions pass/fail/blocked from the last runner pass.
//
// Immutability weakening is caught two ways: validate-artifacts.mjs recomputes each suiteHash (tamper
// signal); this gate diffs the assertions array against origin/main (semantic weakening).
//
// Usage: deno run --allow-read --allow-run scripts/check-conformance.mjs

import {
  collectPublishedPages,
  collectSuites,
  loadSchema,
  normalizeAssertions,
  pageMetadata,
  readJson,
  supportForRoute,
  validate,
} from "./lib/artifacts.mjs";
import { validateReferenceContractsInBrowser } from "./lib/reference-browser.mjs";
import {
  collectReferenceContracts,
  validateContractOwnership,
  validateReferenceContract,
} from "./lib/reference-contract.mjs";

const MIGRATIONS = "migrations.json";

async function git(args) {
  const cmd = new Deno.Command("git", { args, stdout: "piped", stderr: "null" });
  const { code, stdout } = await cmd.output();
  if (code !== 0) return null;
  return new TextDecoder().decode(stdout);
}

async function gitRefExists(ref) {
  const cmd = new Deno.Command("git", {
    args: ["rev-parse", "--verify", "--quiet", ref],
    stdout: "null",
    stderr: "null",
  });
  return (await cmd.output()).code === 0;
}

async function loadMigrations() {
  const raw = await readJson(MIGRATIONS);
  return Array.isArray(raw) ? raw : [];
}

function migrationCoversAssertion(migrations, suiteId, assertionId) {
  return migrations.some((m) =>
    m.id === suiteId && m.action === "assertion-migrate" && m.assertion === assertionId
  );
}

async function main() {
  const failures = [];
  const migrations = await loadMigrations();

  const pages = await collectPublishedPages(".");
  const pageIds = new Set(pages.map((p) => p.replace(/\/index\.html$/, "")));
  const suites = await collectSuites(".");
  const suiteById = new Map(suites.map((s) => [s.id, s]));

  // 1. missing coverage
  const missing = [...pageIds].filter((id) => !suiteById.has(id));
  for (const id of missing) failures.push(`published page ${id} has no conformance suite`);

  // 2. orphan suites
  for (const s of suites) {
    if (!pageIds.has(s.id)) failures.push(`orphan suite ${s.id} maps to no published page`);
  }

  // 3. immutability vs the remote baseline, falling back to local HEAD when offline.
  const baselineRef = await gitRefExists("origin/main")
    ? "origin/main"
    : await gitRefExists("HEAD")
    ? "HEAD"
    : null;
  let baselineChecked = 0;
  if (!baselineRef) {
    failures.push(
      "no origin/main or HEAD baseline is available; cannot enforce immutable/touched contracts",
    );
  }
  if (baselineRef) {
    for (const s of suites) {
      const baseRaw = await git(["show", `${baselineRef}:${s.id}/conformance.json`]);
      if (!baseRaw) continue; // new suite — no baseline to weaken
      baselineChecked++;
      let base;
      try {
        base = JSON.parse(baseRaw);
      } catch {
        continue;
      }
      const currById = new Map((s.assertions ?? []).map((a) => [a.id, a]));
      for (const ba of base.assertions ?? []) {
        const ca = currById.get(ba.id);
        if (!ca) {
          if (!migrationCoversAssertion(migrations, s.id, ba.id)) {
            failures.push(`${s.id}: assertion "${ba.id}" was REMOVED (immutable — fix the page)`);
          }
          continue;
        }
        if (normalizeAssertions([ba]) !== normalizeAssertions([ca])) {
          if (!migrationCoversAssertion(migrations, s.id, ba.id)) {
            failures.push(
              `${s.id}: assertion "${ba.id}" was CHANGED/weakened vs baseline (immutable — fix the page, or record an assertion-migrate migration)`,
            );
          }
        }
      }
    }
  }

  // 4. touched feature trees must be matrix-validated and implementation-sufficient.
  // Nested member/protocol pages map back to their feature root, so isolated leaf writers cannot
  // bypass the gate by adding only v<N>/<slug>/<member>/index.html.
  const support = (await readJson("./responsive-support.json")) ?? { routes: {} };
  const referenceContracts = await collectReferenceContracts(".", [...pageIds]);
  const referenceById = new Map(referenceContracts.map((record) => [record.ownerId, record]));
  const referenceSchema = await loadSchema("reference-contract.schema.json");
  const referenceErrorsById = new Map();
  for (const record of referenceContracts) {
    const recordErrors = [
      ...validate(referenceSchema, record.contract).map((error) => `schema: ${error}`),
      ...validateContractOwnership(record),
      ...await validateReferenceContract(record.contract, "."),
    ];
    referenceErrorsById.set(record.ownerId, recordErrors);
  }
  const browserCheckRecords = [];
  if (baselineRef) {
    const diff = (await git(["diff", "--name-only", baselineRef, "--", "v*"])) ?? "";
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "--", "v*"])) ?? "";
    const changedPaths = `${diff}\n${untracked}`.split("\n").filter(Boolean);
    const pathsById = new Map();
    for (const path of changedPaths) {
      const id = path.match(/^(v\d+\/[^/]+)\//)?.[1];
      if (!id) continue;
      if (!pathsById.has(id)) pathsById.set(id, []);
      pathsById.get(id).push(path);
    }
    const touched = [];
    for (const [id, paths] of pathsById) {
      const contentPathChanged = paths.some((path) => path !== `${id}/conformance.json`);
      if (contentPathChanged) {
        touched.push(id);
        continue;
      }
      // A source-link/note correction in suite metadata does not touch the reference itself.
      // Assertion changes still count and must pass the full touched-reference ratchet.
      const currentSuite = await readJson(`${id}/conformance.json`);
      const baselineRaw = await git(["show", `${baselineRef}:${id}/conformance.json`]);
      if (!currentSuite || !baselineRaw) {
        touched.push(id);
        continue;
      }
      try {
        const baselineSuite = JSON.parse(baselineRaw);
        if (
          normalizeAssertions(currentSuite.assertions ?? []) !==
            normalizeAssertions(baselineSuite.assertions ?? [])
        ) {
          touched.push(id);
        }
      } catch {
        touched.push(id);
      }
    }
    for (const id of touched) {
      if (!pageIds.has(id)) continue; // deleted/moved handled by route gate
      const rec = supportForRoute(support, `/${id}/`);
      for (const cls of ["desktop", "mobile"]) {
        if (rec[cls] !== "ok" && rec[cls] !== "unsupported") {
          failures.push(
            `touched page ${id}: ${cls} support is "${
              rec[cls]
            }" — a touched page must be matrix-validated (ok, or unsupported+evidence) before push`,
          );
        }
      }
      const meta = await pageMetadata(`${id}/index.html`);
      if (meta.status === "built") {
        const record = referenceById.get(id);
        if (!record) {
          failures.push(
            `touched built reference ${id}: missing reference-contract.json (implementation sufficiency is unassessed)`,
          );
        } else {
          const { contract } = record;
          if (contract.completeness !== "implementation-sufficient") {
            failures.push(
              `touched built reference ${id}: contract is ${
                JSON.stringify(contract.completeness)
              }, not implementation-sufficient`,
            );
          }
          const structuralErrors = referenceErrorsById.get(id) ?? [];
          for (const error of structuralErrors) {
            failures.push(`touched built reference ${id}: ${error}`);
          }
          if (
            contract.completeness === "implementation-sufficient" && structuralErrors.length === 0
          ) {
            browserCheckRecords.push(record);
          }
        }
      }
    }
  }
  for (const error of await validateReferenceContractsInBrowser(browserCheckRecords)) {
    failures.push(`reference browser visibility: ${error}`);
  }

  // ---- denominators ----
  const critiquePages = [];
  for (const id of pageIds) {
    if (await readJson(`./${id}/_questions.json`)) critiquePages.push(id);
  }
  const okCls = (cls) =>
    [...pageIds].filter((id) => supportForRoute(support, `/${id}/`)[cls] === "ok").length;
  const results = await readJson("./reports/conformance/results.json");

  console.log("conformance gate");
  console.log(`  conformance suites : ${suiteById.size}/${pageIds.size} published pages`);
  const builtPages = [];
  for (const id of pageIds) {
    if ((await pageMetadata(`${id}/index.html`)).status === "built") builtPages.push(id);
  }
  const sufficientRefs = builtPages.filter((id) => {
    const contract = referenceById.get(id)?.contract;
    return contract?.id === id && contract.completeness === "implementation-sufficient" &&
      referenceErrorsById.get(id)?.length === 0;
  }).length;
  const partialRefs = builtPages.filter((id) => {
    const contract = referenceById.get(id)?.contract;
    return contract?.id === id && contract.completeness === "partial" &&
      referenceErrorsById.get(id)?.length === 0;
  }).length;
  console.log(`  critiques          : ${critiquePages.length}/${pageIds.size} published pages`);
  console.log(
    `  implementation refs: ${sufficientRefs} sufficient / ${partialRefs} partial / ${
      builtPages.length - sufficientRefs - partialRefs
    } legacy-unassessed (of ${builtPages.length} built)`,
  );
  console.log(`  desktop matrix ok  : ${okCls("desktop")}/${pageIds.size}`);
  console.log(`  mobile matrix ok   : ${okCls("mobile")}/${pageIds.size}`);
  console.log(`  baseline suites    : ${baselineChecked} checked for weakening`);
  if (results?.agg) {
    const a = results.agg;
    console.log(
      `  last runner        : ${a.pass} pass / ${a.fail} fail / ${a.blocked} blocked (of ${a.total}) — ${results.generatedAt}`,
    );
  } else {
    console.log(`  last runner        : no reports/conformance/results.json yet`);
  }

  if (failures.length) {
    console.error(`\nFAIL — ${failures.length} conformance/coverage violation(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      "\nAdding assertions and new suites is allowed. Removing/weakening an assertion needs an " +
        "assertion-migrate record in migrations.json; touched pages must be matrix-validated and implementation-sufficient.",
    );
    Deno.exit(1);
  }
  console.log("\nPASS — full conformance coverage, no weakened assertions.");
}

if (import.meta.main) await main();
