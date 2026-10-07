#!/usr/bin/env -S deno run --allow-read --allow-run
// check-routes.mjs — the route regression gate for gendn's durable demo compatibility contract.
//
// Run this before every push. It compares the PREVIOUSLY PUBLISHED manifest (baseline) against the
// working tree (current) and fails (exit 1) on any destructive change to a published page identity.
//
// Baseline page tree comes from git, but its manifest uses the CURRENT extractor: extractor-only
// edits can rebind BOTH baseline and current. A separate, committed identity/demo ledger below
// catches that class. To authorize a ledger change, compare its old entry from the baseline ref
// against the new entry and require a new exact migration. For the other route checks:
//   1. If `origin/main` is reachable, derive the baseline manifest from its catalogue pages.
//   2. Otherwise use `.route-manifest.baseline.json` for the older checks. The binding ratchet
//      fails closed offline because this fallback snapshot is stale and cannot authorize changes.
//
// FAIL conditions (baseline -> current):
//   1. a baseline published id is MISSING from current (deleted or renamed), and not covered by a
//      migration record;
//   2. a baseline "built" route no longer resolves (its `v<N>/<slug>/index.html` page file is gone);
//   3. a baseline id's IDENTITY changed or became null (its chromestatus feature id now differs or
//      was removed — slug repurposed or identity lost), and not covered by an identity-change migration;
//   4. a baseline id's selected full DEMO URL changed, including a same-feature concept swap, or
//      was removed, and not covered by a reviewed demo-change migration;
//   5. a baseline "stub" id (gendn's analogue of an honestly-recorded `blocked` entry — an
//      MDN-covered redirect) was DELETED (stubs must stay recorded);
//   6. a stable member/protocol route declared by a baseline reference contract disappeared;
//   7. mobile/desktop support regressed from ok or claims broken on a current page;
//   8. the published count DROPPED vs baseline and the difference is not covered by migrations.
//
// PASS for: additive new ids, honest new stubs, in-place fixes that preserve the same id + identity +
// previously selected demo URL + live route, and any change explicitly listed in migrations.json.
//
// Usage: deno run --allow-read --allow-run scripts/check-routes.mjs [--baseline <ref>]
//
// `--baseline <ref>` answers the question a lane actually has when this gate goes red: does MY
// CHANGE remove a route, or does my BASE not have one yet? Without it a red verdict is
// indistinguishable from a stale baseline (gendn-cct), so the failure text names the baseline and
// its commit, and the run warns when HEAD does not contain the baseline commit.

import { buildManifest } from "./route-manifest.mjs";
import { gitRefExists, runGit } from "./lib/bounded-git.mjs";
import { judgedFileExists, readJudgedFile } from "./lib/judged-content.mjs";
import {
  BINDING_LEDGER,
  bindingsFromManifest,
  evaluateBindingLedger,
} from "./lib/binding-ledger.mjs";

const BASELINE_SNAPSHOT = ".route-manifest.baseline.json";
const MIGRATIONS = "migrations.json";

// Read the PREVIOUS committed ledger without running the current extractor on old HTML.
// Absence at a resolvable baseline is allowed only for the initial bootstrap; a missing current
// ledger, or an unreachable ref, is always a hard failure rather than an empty baseline.
async function readPriorBindings(ref) {
  if (!ref) throw new Error(`cannot check ${BINDING_LEDGER} without a resolvable baseline ref`);
  const listed = await runGit(["ls-tree", "--name-only", ref, "--", BINDING_LEDGER], {
    stdout: "piped",
    stderr: "piped",
  });
  if (listed.code !== 0) throw new Error(`git ls-tree ${ref} failed: ${listed.stderr.trim()}`);
  if (listed.stdout.trim() !== BINDING_LEDGER) return null; // first-rollout bootstrap
  const old = await runGit(["show", `${ref}:${BINDING_LEDGER}`], {
    stdout: "piped",
    stderr: "piped",
  });
  if (old.code !== 0) {
    throw new Error(`git show ${ref}:${BINDING_LEDGER} failed: ${old.stderr.trim()}`);
  }
  return JSON.parse(old.stdout);
}

async function readPriorMigrations(ref) {
  const old = await runGit(["show", `${ref}:${MIGRATIONS}`], {
    stdout: "piped",
    stderr: "piped",
  });
  if (old.code !== 0) throw new Error(`git show ${ref}:${MIGRATIONS} failed: ${old.stderr.trim()}`);
  const parsed = JSON.parse(old.stdout);
  if (!Array.isArray(parsed)) throw new Error(`${ref}:${MIGRATIONS} is not an array`);
  return parsed;
}

// The first rollout has no prior ledger. The baseline manifest is a trustworthy one-time seed
// ONLY if the extractor pipeline has not changed relative to that ref. Otherwise the original
// blind spot would be reintroduced during bootstrap by regenerating the new ledger and gate.
async function bootstrapExtractorChanges(ref) {
  const files = [
    "scripts/route-manifest.mjs",
    "scripts/lib/artifacts.mjs",
    "scripts/lib/judged-content.mjs",
    "scripts/lib/bounded-git.mjs",
  ];
  const changed = new Set();
  for (
    const args of [["diff", "--name-only", ref, "--", ...files], [
      "diff",
      "--cached",
      "--name-only",
      ref,
      "--",
      ...files,
    ]]
  ) {
    const result = await runGit(args, { stdout: "piped", stderr: "piped" });
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    for (const file of result.stdout.trim().split("\n").filter(Boolean)) changed.add(file);
  }
  return [...changed].sort();
}

// The bounded runner is shared (gendn-8q2): this gate must not be able to hang on the same
// object-store contention / forked-git-pipe-open failure that gendn-1tu fixed in check-conformance.

// The baseline ref, and the resolved commit when we can name one, because a failure that says
// "removed or renamed" without saying WHAT IT COMPARED AGAINST sent three lanes after a rename
// they never made (gendn-cct: a branch cut before a page changed on main reads that page as
// removed, and the merge is clean either way).
async function resolveCommit(ref) {
  try {
    // runGit resolves to { code, stdout, stderr } - NOT to the stdout string (it has to report the
    // exit code, which is what makes the bounded runner useful) - so destructure rather than
    // treating the result as text. Getting this wrong fails SILENTLY here, degrading the label to
    // the ref alone, which is exactly the vagueness gendn-cct is about.
    const { code, stdout } = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], {
      stdout: "piped",
    });
    if (code !== 0) return null;
    return stdout.trim().split("\n")[0] || null;
  } catch {
    return null; // unknown commit: the label falls back to the ref alone
  }
}

async function loadBaseline(refOverride) {
  const ref = refOverride ?? "origin/main";
  if (await gitRefExists(ref)) {
    try {
      const manifest = await buildManifest({ ref });
      return { source: ref, ref, commit: await resolveCommit(ref), manifest };
    } catch (err) {
      if (refOverride) throw err; // an explicitly requested baseline must not silently fall back
      console.error(`! could not build baseline from ${ref} (${err.message}); falling back`);
    }
  } else if (refOverride) {
    throw new Error(`--baseline ${refOverride} does not resolve to a ref`);
  }
  try {
    const raw = await readJudgedFile(BASELINE_SNAPSHOT);
    return { source: BASELINE_SNAPSHOT, ref: null, commit: null, manifest: JSON.parse(raw) };
  } catch {
    return { source: "none", ref: null, commit: null, manifest: [] };
  }
}

// Does HEAD contain the baseline commit? If not, this branch was cut before the baseline moved and
// a baseline-only change can read as a removal here. That is a property of the COMPARISON, not of
// the branch, which is the whole point of gendn-cct.
async function headContainsBaseline(commit) {
  if (!commit) return null;
  try {
    const { code } = await runGit(["merge-base", "--is-ancestor", commit, "HEAD"], {});
    return code === 0;
  } catch {
    return null; // cannot tell: say nothing rather than claim drift
  }
}

export function validateMigrationRecord(m) {
  if ((m.action === "move" || m.action === "alias") && m.from) {
    if (!m.from.endsWith("/")) {
      throw new Error(
        `migration ${
          m.id ?? "(unknown)"
        }: action "${m.action}" from "${m.from}" must end in '/' (path boundary invariant; non-slash prefix matches unrelated routes)`,
      );
    }
  }
}

export async function loadMigrations(source = MIGRATIONS) {
  let parsed;
  if (Array.isArray(source)) {
    parsed = source;
  } else {
    try {
      const raw = await readJudgedFile(source);
      parsed = JSON.parse(raw);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
  }
  if (!Array.isArray(parsed)) throw new Error("migrations.json must be an array");
  for (const m of parsed) {
    validateMigrationRecord(m);
  }
  return parsed;
}

async function fileExists(path) {
  return await judgedFileExists(path);
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

function supportOf(entry) {
  return entry?.support ?? { desktop: "untested", mobile: "untested" };
}

// Keep the gate's accept/reject decision testable without git, the catalogue, or live routes.
export async function evaluateRouteContract(
  { baseline, current, migrations, pageExists = fileExists, baselineLabel = null, drift = null },
) {
  // Name what was compared, and say when the comparison itself is suspect (gendn-cct). Kept
  // optional so the gate stays testable without git.
  const where = baselineLabel ? ` [vs baseline ${baselineLabel}]` : "";
  const driftNote = drift === false
    ? "\n      NOTE: HEAD does not contain this baseline commit, so a change that exists ONLY on " +
      "the baseline reads as a removal here. That is base drift, not your change: rebase onto the " +
      "baseline (git rebase origin/main) and re-run before hunting for a rename."
    : "";
  const baseById = indexById(baseline);
  const currById = indexById(current);

  const failures = [];
  const migrated = [];

  for (const m of migrations) {
    if ((m.action === "move" || m.action === "alias") && m.from && !m.from.endsWith("/")) {
      failures.push(
        `migration ${
          m.id ?? "(unknown)"
        }: action "${m.action}" from "${m.from}" must end in '/' (path boundary invariant; non-slash prefix matches unrelated routes)`,
      );
    }
  }

  // Conditions 1-6, per baseline entry.
  for (const b of baseline) {
    const c = currById.get(b.id);

    if (!c) {
      if (
        migrationCovers(migrations, b.id, "remove") || migrationCovers(migrations, b.id, "move")
      ) {
        migrated.push(`${b.id} (removed/moved via migration)`);
        continue;
      }
      // Conditions 1 + 5: a missing id. Stubs (blocked analogue) get their own explicit message.
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
      if (!(await pageExists(pagePath))) {
        failures.push(
          `built route ${b.route} no longer resolves (missing ${pagePath})${where}${driftNote}`,
        );
      }
    }

    // Condition 3: identity changed (slug repurposed to a different feature) or removed.
    if (b.identity && !c.identity) {
      if (migrationCovers(migrations, b.id, "identity-change")) {
        migrated.push(`${b.id} (identity change via migration: ${b.identity} -> null)`);
      } else {
        failures.push(
          `missing identity for published route ${b.id}: feature ${b.identity} was removed` +
            `${where}${driftNote}`,
        );
      }
    } else if (b.identity && c.identity && b.identity !== c.identity) {
      if (migrationCovers(migrations, b.id, "identity-change")) {
        migrated.push(`${b.id} (identity change via migration: ${b.identity} -> ${c.identity})`);
      } else {
        failures.push(
          `identity changed for ${b.id}: feature ${b.identity} -> ${c.identity} (slug repurposed)` +
            `${where}${driftNote}`,
        );
      }
    }

    // Condition 4: selected full demo URL changed (even within one feature) or was removed.
    if (b.demo && !c.demo) {
      if (
        migrationCovers(migrations, b.id, "demo-change") ||
        migrationCovers(migrations, b.id, "identity-change")
      ) {
        migrated.push(`${b.id} (demo link change via migration: ${b.demo} -> null)`);
      } else {
        failures.push(
          `missing demo link for published route ${b.id}: showcase demo ${b.demo} was removed ` +
            `(requires a reviewed demo-change migration)${where}${driftNote}`,
        );
      }
    } else if (b.demo && c.demo && b.demo !== c.demo) {
      if (
        migrationCovers(migrations, b.id, "demo-change") ||
        migrationCovers(migrations, b.id, "identity-change")
      ) {
        migrated.push(`${b.id} (demo link change via migration: ${b.demo} -> ${c.demo})`);
      } else {
        failures.push(
          `demo link changed for ${b.id}: showcase demo ${b.demo} -> ${c.demo} ` +
            `(repointed; requires a reviewed demo-change migration)${where}${driftNote}`,
        );
      }
    }

    // Condition 6: stable child reference routes are append-only once published.
    const currentReferenceRoutes = new Set(c.referenceRoutes ?? []);
    for (const route of b.referenceRoutes ?? []) {
      if (!currentReferenceRoutes.has(route)) {
        const migration = referenceRouteMigration(migrations, b.id, route, currentReferenceRoutes);
        if (migration) {
          migrated.push(`${b.id} (reference route alias: ${route} -> ${migration.to})`);
        } else {
          failures.push(
            `${b.id}: published member/protocol route ${route} was removed or renamed without a ` +
              `server-backed move/alias to a current same-feature route${where}${driftNote}`,
          );
        }
      }
    }
  }

  // Condition 7: mobile+desktop support parity — monotonic + no broken-while-claimed-supported.
  // A route recorded `ok` (validated) on a class must never silently drop back to untested/broken
  // without a migration record; and no route may be recorded `broken` on a class it claims to
  // support. Many `untested` pages are fine (that's the audit backlog).
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

  // Condition 8: published-count drop not covered by migrations.
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

  // Informational: additive ids and in-place fixes. Demo removals are already either hard
  // failures or migration entries above, so never report the same change a second time.
  const added = current.filter((c) => !baseById.has(c.id));
  const fixedInPlace = current.filter((c) => {
    const b = baseById.get(c.id);
    return b && b.identity === c.identity && b.route === c.route;
  });

  return { failures, migrated, added, fixedInPlace };
}

function parseBaselineArg(argv) {
  const i = argv.indexOf("--baseline");
  if (i === -1) return null;
  const ref = argv[i + 1];
  if (!ref || ref.startsWith("--")) {
    throw new Error("--baseline needs a ref, e.g. --baseline origin/main");
  }
  return ref;
}

async function main() {
  const { source, ref, commit, manifest: baseline } = await loadBaseline(
    parseBaselineArg(Deno.args),
  );
  const current = await buildManifest();
  const migrations = await loadMigrations();
  // null = cannot determine; only `false` (definitely not contained) justifies the note.
  const drift = await headContainsBaseline(commit);
  const baselineLabel = commit ? `${source} @ ${commit.slice(0, 7)}` : source;
  const { failures, migrated, added, fixedInPlace } = await evaluateRouteContract({
    baseline,
    current,
    migrations,
    baselineLabel,
    drift,
  });
  let ledgerCount = 0;
  let priorCount = "bootstrap";
  try {
    const ledger = JSON.parse(await readJudgedFile(BINDING_LEDGER));
    const oldLedger = await readPriorBindings(ref);
    ledgerCount = Array.isArray(ledger) ? ledger.length : 0;
    priorCount = oldLedger === null ? "bootstrap" : oldLedger.length;
    if (oldLedger === null) {
      const changed = await bootstrapExtractorChanges(ref);
      if (changed.length) {
        failures.push(
          `${BINDING_LEDGER} first-rollout bootstrap cannot change extractor sources: ` +
            `${changed.join(", ")}; land the ledger first, then change extraction with a migration`,
        );
      }
    }
    // During the one-time bootstrap only, the unchanged extractor can derive the old bindings
    // from baseline pages; thereafter the committed PRIOR ledger is authoritative instead.
    failures.push(...evaluateBindingLedger({
      current,
      ledger,
      priorLedger: oldLedger ?? bindingsFromManifest(baseline),
      migrations,
      priorMigrations: await readPriorMigrations(ref),
    }));
  } catch (err) {
    failures.push(
      `${BINDING_LEDGER} unavailable or unreadable: ${err.message}; ` +
        `run deno task refresh-bindings and review the diff`,
    );
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
  console.log(`  baseline source : ${source}${commit ? ` @ ${commit.slice(0, 7)}` : ""}`);
  if (drift === false) {
    console.log(
      "  ! BASE DRIFT    : HEAD does not contain the baseline commit - removals below may be " +
        "baseline-only changes (rebase onto the baseline before treating one as your regression)",
    );
  }
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
  console.log(
    `  binding ledger   : ${ledgerCount} entries / ${current.length} routes (prior: ${priorCount})`,
  );
  if (failures.length) {
    console.error(`\nFAIL — ${failures.length} contract violation(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      "\nAdditive changes, honest stubs, and same-id in-place fixes are allowed. Any removal, " +
        "rename, route move, identity change, or demo link change needs a reviewed record in migrations.json.",
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
