#!/usr/bin/env -S deno run --allow-read --allow-run
// check-routes.mjs — the route regression gate for gendn's durable demo compatibility contract.
//
// Run this before every push. It compares the PREVIOUSLY PUBLISHED manifest (baseline) against the
// working tree (current) and fails (exit 1) on any destructive change to a published page identity.
//
// Baseline derivation (can't drift, because it comes from git):
//   1. If `origin/main` is reachable, the baseline is the manifest computed from the catalogue at
//      `origin/main` (`git show origin/main:<page>`).
//   2. Otherwise fall back to the committed snapshot `.route-manifest.baseline.json` (refreshed by
//      the routine so an offline run still has a floor to check against).
//
// FAIL conditions (baseline -> current):
//   1. a baseline published id is MISSING from current (deleted or renamed), and not covered by a
//      migration record;
//   2. a baseline "built" route no longer resolves (its `v<N>/<slug>/index.html` page file is gone);
//   3. a baseline id's IDENTITY changed (its chromestatus feature id now differs — the slug was
//      repurposed to a different feature), and not covered by an identity-change migration;
//   4. a baseline "stub" id (gendn's analogue of an honestly-recorded `blocked` entry — an
//      MDN-covered redirect) was DELETED (stubs must stay recorded);
//   5. a stable member/protocol route declared by a baseline reference contract disappeared;
//   6. the published count DROPPED vs baseline and the difference is not covered by migrations.
//
// PASS for: additive new ids, honest new stubs, in-place fixes that keep the same id + identity +
// live route, and any change explicitly listed in migrations.json.
//
// Usage: deno run --allow-read --allow-run scripts/check-routes.mjs

import { buildManifest } from "./route-manifest.mjs";

const BASELINE_SNAPSHOT = ".route-manifest.baseline.json";
const MIGRATIONS = "migrations.json";

async function gitRefExists(ref) {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--verify", "--quiet", ref],
      stdout: "null",
      stderr: "null",
    });
    const { code } = await cmd.output();
    return code === 0;
  } catch {
    return false;
  }
}

async function loadBaseline() {
  if (await gitRefExists("origin/main")) {
    try {
      const manifest = await buildManifest({ ref: "origin/main" });
      return { source: "origin/main", manifest };
    } catch (err) {
      console.error(`! could not build baseline from origin/main (${err.message}); falling back`);
    }
  }
  try {
    const raw = await Deno.readTextFile(BASELINE_SNAPSHOT);
    return { source: BASELINE_SNAPSHOT, manifest: JSON.parse(raw) };
  } catch {
    return { source: "none", manifest: [] };
  }
}

async function loadMigrations() {
  try {
    const raw = await Deno.readTextFile(MIGRATIONS);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("migrations.json must be an array");
    return parsed;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}

async function fileExists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function indexById(manifest) {
  const map = new Map();
  for (const e of manifest) map.set(e.id, e);
  return map;
}

function migrationCovers(migrations, id, action) {
  return migrations.some((m) => m.id === id && (!action || m.action === action));
}

export function referenceRouteMigration(migrations, id, route, currentReferenceRoutes) {
  return migrations.find((m) =>
    m.id === id && (m.action === "move" || m.action === "alias") && m.from === route &&
    typeof m.to === "string" && m.to.startsWith(`/${id}/`) && currentReferenceRoutes.has(m.to)
  );
}

async function main() {
  const { source, manifest: baseline } = await loadBaseline();
  const current = await buildManifest();
  const migrations = await loadMigrations();

  const baseById = indexById(baseline);
  const currById = indexById(current);

  const failures = [];
  const migrated = [];

  // Conditions 1-4, per baseline entry.
  for (const b of baseline) {
    const c = currById.get(b.id);

    if (!c) {
      if (
        migrationCovers(migrations, b.id, "remove") || migrationCovers(migrations, b.id, "move")
      ) {
        migrated.push(`${b.id} (removed/moved via migration)`);
        continue;
      }
      // Condition 1 + 4: a missing id. Stubs (blocked analogue) get their own explicit message.
      if (b.status === "stub") {
        failures.push(
          `deleted stub route ${b.route} (id ${b.id}) — MDN-covered stubs must stay recorded`,
        );
      } else {
        failures.push(`missing published id ${b.id} (route ${b.route} was deleted or renamed)`);
      }
      continue;
    }

    // Condition 2: a built baseline route whose page file no longer resolves.
    if (b.status === "built") {
      const pagePath = `.${b.route}index.html`;
      if (!(await fileExists(pagePath))) {
        failures.push(`built route ${b.route} no longer resolves (missing ${pagePath})`);
      }
    }

    // Condition 3: identity changed (slug repurposed to a different feature).
    if (b.identity && c.identity && b.identity !== c.identity) {
      if (migrationCovers(migrations, b.id, "identity-change")) {
        migrated.push(`${b.id} (identity change via migration: ${b.identity} -> ${c.identity})`);
      } else {
        failures.push(
          `identity changed for ${b.id}: feature ${b.identity} -> ${c.identity} (slug repurposed)`,
        );
      }
    }

    // Condition 5: stable child reference routes are append-only once published.
    const currentReferenceRoutes = new Set(c.referenceRoutes ?? []);
    for (const route of b.referenceRoutes ?? []) {
      if (!currentReferenceRoutes.has(route)) {
        const migration = referenceRouteMigration(migrations, b.id, route, currentReferenceRoutes);
        if (migration) {
          migrated.push(`${b.id} (reference route alias: ${route} -> ${migration.to})`);
        } else {
          failures.push(
            `${b.id}: published member/protocol route ${route} was removed or renamed without a server-backed move/alias to a current same-feature route`,
          );
        }
      }
    }
  }

  // Condition 7: mobile+desktop support parity — monotonic + no broken-while-claimed-supported.
  // A route recorded `ok` (validated) on a class must never silently drop back to untested/broken
  // without a migration record; and no route may be recorded `broken` on a class it claims to
  // support. Many `untested` pages are fine (that's the audit backlog).
  const supportOf = (e) => e?.support ?? { desktop: "untested", mobile: "untested" };
  for (const b of baseline) {
    const c = currById.get(b.id);
    if (!c) continue;
    const bs = supportOf(b), cs = supportOf(c);
    for (const cls of ["desktop", "mobile"]) {
      if (bs[cls] === "ok" && cs[cls] !== "ok" && cs[cls] !== "unsupported") {
        if (!migrationCovers(migrations, b.id, "support-change")) {
          failures.push(
            `${b.id}: ${cls} support regressed ${bs[cls]} -> ${
              cs[cls]
            } (must stay ok or carry a support-change migration)`,
          );
        }
      }
    }
  }
  for (const c of current) {
    const cs = supportOf(c);
    for (const cls of ["desktop", "mobile"]) {
      if (cs[cls] === "broken") {
        failures.push(`${c.id}: recorded broken on ${cls} — fix the page (durable-demo contract)`);
      }
    }
  }

  // Condition 5: published-count drop not covered by migrations.
  const removedCount = baseline.filter((b) => !currById.has(b.id)).length;
  const migratedRemovals = baseline.filter((b) =>
    !currById.has(b.id) &&
    (migrationCovers(migrations, b.id, "remove") || migrationCovers(migrations, b.id, "move"))
  ).length;
  const uncoveredDrop = removedCount - migratedRemovals;
  if (current.length < baseline.length && uncoveredDrop > 0) {
    failures.push(
      `published count dropped ${baseline.length} -> ${current.length} with ${uncoveredDrop} ` +
        `removal(s) not covered by migrations.json`,
    );
  }

  // Informational: additive ids, in-place fixes, and demo (embedded-showcase) inbound-link changes.
  const added = current.filter((c) => !baseById.has(c.id));
  const fixedInPlace = current.filter((c) => {
    const b = baseById.get(c.id);
    return b && b.identity === c.identity && b.route === c.route;
  });
  const demoDropped = [];
  for (const b of baseline) {
    const c = currById.get(b.id);
    if (c && b.demo && !c.demo) demoDropped.push(`${b.id} lost its showcase demo link (${b.demo})`);
  }

  // Support coverage lines (reported, not failed-on for untested).
  const cov = (cls) => {
    const ok = current.filter((e) => supportOf(e)[cls] === "ok").length;
    const unsupported = current.filter((e) => supportOf(e)[cls] === "unsupported").length;
    const review = current.filter((e) => supportOf(e)[cls] === "needs-review").length;
    const untested = current.filter((e) => supportOf(e)[cls] === "untested").length;
    return `${ok} ok / ${unsupported} unsupported / ${review} needs-review / ${untested} untested (of ${current.length})`;
  };

  console.log("route regression gate");
  console.log(`  baseline source : ${source}`);
  console.log(`  published        : ${baseline.length} baseline -> ${current.length} current`);
  console.log(`    built/stub     : ${countByStatus(current)}`);
  console.log(
    `    child refs     : ${
      current.reduce((sum, entry) => sum + (entry.referenceRoutes?.length ?? 0), 0)
    } stable routes`,
  );
  console.log(`  desktop support  : ${cov("desktop")}`);
  console.log(`  mobile support   : ${cov("mobile")}`);
  console.log(`  + added          : ${added.length}`);
  console.log(`  ~ fixed-in-place : ${fixedInPlace.length}`);
  console.log(`  migrations       : ${migrated.length ? migrated.join("; ") : "none"}`);
  if (demoDropped.length) {
    console.log(`  ! demo warnings  : ${demoDropped.length}`);
    for (const w of demoDropped) console.log(`      - ${w}`);
  }

  if (failures.length) {
    console.error(`\nFAIL — ${failures.length} contract violation(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      "\nAdditive changes, honest stubs, and same-id in-place fixes are allowed. Any removal, " +
        "rename, route move, or identity change needs a reviewed record in migrations.json.",
    );
    Deno.exit(1);
  }

  console.log("\nPASS — no published route or identity regressions.");
}

function countByStatus(manifest) {
  const built = manifest.filter((e) => e.status === "built").length;
  const stub = manifest.filter((e) => e.status === "stub").length;
  return `${built} built / ${stub} stub`;
}

if (import.meta.main) await main();
