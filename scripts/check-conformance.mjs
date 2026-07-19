#!/usr/bin/env -S deno run --allow-read --allow-run
// check-conformance.mjs — the conformance + coverage gate (sibling of the route regression gate).
//
// Run before every push, alongside `deno task check-routes`. It enforces the immutable-conformance
// contract and reports lifecycle coverage denominators. FAILS (exit 1) on:
//   1. a published page with NO conformance suite (missing coverage);
//   2. an orphan suite id that maps to no published page;
//   3. a WEAKENED or REMOVED assertion vs the origin/main baseline without a migration record
//      (immutable = fix the page, never weaken/regenerate to go green). Adding assertions is fine;
//   4. a supported device class left untested / needs-review / broken for a page the action TOUCHED
//      (git diff vs baseline) — a touched page must be matrix-validated (ok or unsupported+evidence).
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
  normalizeAssertions,
  readJson,
  supportForRoute,
} from "./lib/artifacts.mjs";

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

  // 3. immutability vs baseline (origin/main)
  const haveBaseline = await gitRefExists("origin/main");
  let baselineChecked = 0;
  if (haveBaseline) {
    for (const s of suites) {
      const baseRaw = await git(["show", `origin/main:${s.id}/conformance.json`]);
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

  // 4. touched pages must be matrix-validated on both classes
  const support = (await readJson("./responsive-support.json")) ?? { routes: {} };
  if (haveBaseline) {
    const diff = (await git(["diff", "--name-only", "origin/main", "--", "v*/*/index.html"])) ?? "";
    const touched = diff.split("\n").filter(Boolean).map((p) => p.replace(/\/index\.html$/, ""));
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
    }
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
  console.log(`  critiques          : ${critiquePages.length}/${pageIds.size} published pages`);
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
        "assertion-migrate record in migrations.json; touched pages must be matrix-validated.",
    );
    Deno.exit(1);
  }
  console.log("\nPASS — full conformance coverage, no weakened assertions.");
}

if (import.meta.main) await main();
