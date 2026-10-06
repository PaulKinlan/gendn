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
import { gitRefExists, runGit } from "./lib/bounded-git.mjs";
import {
  collectReferenceContracts,
  declaredSurfaceMembers,
  declaredSurfaceSummary,
  validateContractOwnership,
  validateDeclaredSurface,
  validateReferenceContract,
  skippedSurfaceDeclarations, surfaceNotePages,
} from "./lib/reference-contract.mjs";

const MIGRATIONS = "migrations.json";

// GIT CANNOT BE ALLOWED TO HANG THIS GATE. The bounded runner lives in scripts/lib/bounded-git.mjs
// so that check-conformance, check-routes and route-manifest cannot drift apart on the bound
// (gendn-8q2); the reasoning behind it - object-store contention, and the pipe-EOF death where a
// forked auto-gc holds stdout open so the promise never settles and Deno exits with zero output - is
// documented there once.

async function git(args) {
  const { code, stdout } = await runGit(args, { stdout: "piped" });
  if (code !== 0) return null;
  return stdout;
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
  const surfaceNotes = [];
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
      // A recorded migration move (migrations.json move/alias, from -> to) is a
      // filing correction, not a reference edit: when the destination page did
      // not exist at the baseline and keeps the source page's chromestatus
      // identity, it is exempt from the touched-reference ratchet for this
      // diff. After the move lands on main, later edits to the destination
      // page are evaluated normally (it then exists at the baseline).
      const moveMigration = migrations.find((m) =>
        (m.action === "move" || m.action === "alias") && m.to === `/${id}/`
      );
      if (moveMigration) {
        const fromId = typeof moveMigration.from === "string"
          ? moveMigration.from.match(/^\/(v\d+\/[^/]+)\/$/)?.[1]
          : null;
        const destAtBaseline = await git(["show", `${baselineRef}:${id}/conformance.json`]);
        const sourceRaw = fromId
          ? await git(["show", `${baselineRef}:${fromId}/conformance.json`])
          : null;
        const currentSuite = await readJson(`${id}/conformance.json`);
        let exempt = false;
        if (!destAtBaseline && sourceRaw && currentSuite) {
          try {
            const sourceSuite = JSON.parse(sourceRaw);
            exempt = String(sourceSuite.identity) === String(currentSuite.identity) &&
              (!moveMigration.feature ||
                String(moveMigration.feature) === String(currentSuite.identity));
          } catch { /* identity unreadable — not exempt */ }
        }
        if (exempt) continue;
      }
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
          const structuralErrors = [...(referenceErrorsById.get(id) ?? [])];
          // DECLARED-SURFACE RULE, SCOPED TO TOUCHED PAGES (gendn-4kq): a touched contract claiming
          // implementation-sufficient must account for every member the page declares in its own
          // syntax IDL, or list it in outOfScope with a rationale - so a collapsed inventory is an
          // explicit, reviewable statement instead of an invisible one. Deliberately NOT applied to
          // untouched contracts, so this does not go red for pre-existing state.
          // ONE READ, ABOVE THE COMPLETENESS BRANCH (gendn-ijf). The declared-surface check needs the
          // page's HTML and so does the parser-skip report, but they answer DIFFERENT questions: the
          // surface check asks whether the CONTRACT accounts for the page, the skip report says what the
          // PARSER could read. A touched page whose contract is not yet implementation-sufficient can
          // still be parsed, so the read belongs here and the skip report stays outside the branch.
          // BEFORE THIS, the skip call sat outside a block that declared `pageHtml` INSIDE it, so every
          // touched built page with a sufficient contract threw `ReferenceError: pageHtml is not
          // defined` and the gate exited 1 - and it was invisible on every tree where no page is
          // touched, which is exactly the case the touched-page ratchet exists for. It survived
          // fleet-check, an 18/18 fixture suite and a three-way mutation matrix because those mutate the
          // DETECTOR and this is the CALLER: the library and its call sites fail independently, and
          // `check-conformance` is not part of `fleet-check` (rule 121).
          const pageHtml = await Deno.readTextFile(`./${id}/index.html`).catch(() => null);
          if (contract.completeness === "implementation-sufficient") {
            if (pageHtml) {
              structuralErrors.push(...validateDeclaredSurface(contract, pageHtml));
              const surface = declaredSurfaceSummary(contract, pageHtml);
              if (surface.declared > 0) {
                surfaceNotes.push(
                  `  ${id}: declared ${surface.declared} = inventory ${surface.inventory} + outOfScope ${surface.outOfScope}`,
                );
              }
            }
          }
          // PARSER SKIPS ARE REPORTED AND NEVER FAIL (gendn-ijf): an anonymous special operation
          // declares no name, so the parser cannot turn it into a member - a limit of the CHECK, not a
          // defect in the page. Printed so the limit stays visible, and deliberately kept out of
          // `failures`, because a gate that fails correct contracts teaches lanes to stop reading it (rule 87).
          // THE LIMIT OF THIS CHANNEL, stated rather than implied: it runs for TOUCHED pages and prints
          // near the end of a run, so an omitted anonymous accessor on an untouched page is NOT
          // independently assessed by this gate - it is visible only when someone touches the page and
          // the note appears. A warning channel is not an assessment.
          if (pageHtml) {
            const skipped = skippedSurfaceDeclarations(pageHtml);
            if (skipped.length > 0) {
              surfaceNotes.push(
                `  ${id}: parser skipped ${skipped.length} anonymous special operation(s) - nothing to account for: ${skipped.join(" | ")}`,
              );
            }
          }
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
  // The legacy-unassessed remainder folds two populations the reference-contract schema treats
  // differently: pages whose #syntax block declares a WebIDL surface the schema could assess, and
  // pages with no IDL at all (CSS / HTML feature pages) that the schema cannot assess in its
  // present form. The split below runs over that same remainder — built, neither sufficient nor
  // partial — using declaredSurfaceMembers(html), the instrument the touched-page campaign uses,
  // so "no IDL surface" is not read as "nothing to do".
  let noIdlSurface = 0;
  for (const id of builtPages) {
    const contract = referenceById.get(id)?.contract;
    const isSufficient = contract?.id === id &&
      contract.completeness === "implementation-sufficient" &&
      referenceErrorsById.get(id)?.length === 0;
    const isPartial = contract?.id === id && contract.completeness === "partial" &&
      referenceErrorsById.get(id)?.length === 0;
    if (isSufficient || isPartial) continue;
    const html = await Deno.readTextFile(`./${id}/index.html`).catch(() => null);
    if (html && declaredSurfaceMembers(html).length === 0) noIdlSurface++;
  }
  console.log(`  critiques          : ${critiquePages.length}/${pageIds.size} published pages`);
  console.log(
    `  implementation refs: ${sufficientRefs} sufficient / ${partialRefs} partial / ${
      builtPages.length - sufficientRefs - partialRefs
    } legacy-unassessed (of ${builtPages.length} built; ${noIdlSurface} have no IDL surface and are outside the reference-contract schema)`,
  );
  console.log(`  desktop matrix ok  : ${okCls("desktop")}/${pageIds.size}`);
  console.log(`  mobile matrix ok   : ${okCls("mobile")}/${pageIds.size}`);
  console.log(`  baseline suites    : ${baselineChecked} checked for weakening`);
  if (surfaceNotes.length) {
    console.log(
      `  declared surfaces  : ${surfaceNotePages(surfaceNotes)} touched contract(s) - inventory N + outOfScope M of the page's declared members`,
    );
    for (const note of surfaceNotes) console.log(note);
  }
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

if (import.meta.main) {
  // A hang anywhere in the gate now surfaces as this line rather than as a silent zero-output death.
  try {
    await main();
  } catch (err) {
    console.error(
      `\nFAIL — the conformance gate could not complete: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    Deno.exit(1);
  }
}
