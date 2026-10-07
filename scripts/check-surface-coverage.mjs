// gendn-m7e — SURFACE-COVERAGE RATCHET (the citation-ratchet pattern, gendn-t7h).
//
// Gate mode (default): contracts CHANGED in the diff vs the merge-base with origin/main,
// OR owning a changed page, must have ZERO wrong-surface/summary-table findings in the
// strict tier. A touched contract/page that retains a wrong mapping FAILS — touch time
// is fix time (AGENTS.md's touch rule, made mechanical). Untracked files count as changed.
//
// --all: corpus-wide REPORT mode. Never exits non-zero. Prints counts grouped by class
// with representatives, per the acceptance criterion that a large count for non-defect
// reasons is itself the finding (recorded on the bead, not iterated away).
//
// The slicing rule is executed by the library (scripts/lib/surface-coverage.mjs imports
// fragmentAfterId/stripMarkup/nameTokens from reference-contract.mjs); this script never
// re-implements it. The /<h[1-3]\b/i rule ends a slice at the next h1/h2/h3 — the misread
// 'next h2' produced gendn-5ao's self-confirming probe; the fixture replays that trap.
import { surfaceCoverageFindings } from "./lib/surface-coverage.mjs";

const CONTRACT_RE = /^(v\d+\/[^/]+(?:\/[^/]+)*)\/reference-contract\.json$/;
const PAGE_RE = /^(v\d+\/[^/]+)(?:\/[^/]+)*\/index\.html$/;

async function git(args, root) {
  try {
    const c = new Deno.Command("git", {
      args,
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await c.output();
    if (!out.success) return null;
    return new TextDecoder().decode(out.stdout);
  } catch {
    return null;
  }
}

/** Contract ids (vN/slug[/member]) among diff path names. Pure; exported for the fixture. */
export function changedContractIds(names) {
  const ids = new Set();
  for (const n of names) {
    const m = n.match(CONTRACT_RE);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

/** vN/slug owners of changed overview or nested member pages; pure for the fixture. */
export function changedPageOwners(names) {
  const owners = new Set();
  for (const n of names) {
    const m = n.match(PAGE_RE);
    if (m) owners.add(m[1]);
  }
  return [...owners];
}

// One contract walk for both the corpus report and changed-page ownership. A member page can
// be documented by an overview contract or a nested contract, so gate the whole slug subtree.
async function* contractIdsUnder(root, id) {
  try {
    for await (const entry of Deno.readDir(`${root}/${id}`)) {
      if (entry.isFile && entry.name === "reference-contract.json") yield id;
      if (entry.isDirectory) yield* contractIdsUnder(root, `${id}/${entry.name}`);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err; // deleted page/owner
  }
}

async function baselineRef(root) {
  // A locally fetched independent ref is mandatory: HEAD would erase committed changes.
  if (!await git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"], root)) {
    return null;
  }
  const mb = await git(["merge-base", "origin/main", "HEAD"], root);
  return mb?.trim() || "origin/main";
}

async function readHtml(path) {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function loadContract(root, id) {
  try {
    return JSON.parse(await Deno.readTextFile(`${root}/${id}/reference-contract.json`));
  } catch {
    return null;
  }
}

/** Ratchet changed contracts and contracts owning changed pages. Exported for scratch fixtures. */
export async function runRatchet(root) {
  const base = await baselineRef(root);
  if (!base) {
    return {
      error: "cannot verify committed surface mappings: independent baseline " +
        "refs/remotes/origin/main is unavailable or not a commit; fetch origin main " +
        "before running this ratchet (no HEAD self-baseline)",
    };
  }
  // base -> WORKING TREE + INDEX (union --cached): the ratchet must also see uncommitted
  // edits to tracked contracts/pages (unstaged and staged), so a local run mid-work flags what
  // a later commit would carry. A staged-then-worktree-reverted edit (git status MM) escapes a
  // worktree-only diff, so union the cached diff against base (gendn-waa3).
  const diff = await git(["diff", "--name-only", base], root);
  if (diff === null) return { error: `git diff against ${base} failed` };
  const cached = await git(["diff", "--cached", "--name-only", base], root);
  if (cached === null) return { error: `git diff --cached against ${base} failed` };
  const others = await git(["ls-files", "--others", "--exclude-standard"], root);
  const head = await git(["rev-parse", "HEAD"], root);
  const names = [
    ...new Set([
      ...diff.split("\n").map((s) => s.trim()).filter(Boolean),
      ...cached.split("\n").map((s) => s.trim()).filter(Boolean),
      ...(others ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
    ]),
  ];
  const vacuous = base === (head ?? "").trim();
  const pageOwners = changedPageOwners(names);
  const ids = new Set(changedContractIds(names));
  for (const owner of pageOwners) {
    for await (const id of contractIdsUnder(root, owner)) ids.add(id);
  }
  const failures = [];
  const warnings = [];
  for (const id of ids) {
    const contract = await loadContract(root, id);
    if (!contract) continue; // deleted in the diff; nothing to ratchet
    for (const f of await surfaceCoverageFindings(contract, root, readHtml)) {
      const line =
        `${f.id}: ${f.inventoryId}.${f.dim} -> ${f.selector} maps a slice without any surface marker [${
          (f.markers ?? []).join(", ")
        }] — declare surfaceMarkers or remap the dimension (gendn-m7e)`;
      if (f.cls === "no-candidate") {
        warnings.push(
          `${f.id}: ${f.inventoryId}.${f.dim} has no derivable surface marker — declare surfaceMarkers to enforce coverage (warning only)`,
        );
      } else failures.push(line);
    }
  }
  return { base, changed: [...ids], pageOwners, failures, warnings, vacuous };
}

/** Corpus-wide report (--all). Report-only; never non-zero. */
export async function scanCorpus(root) {
  const byClass = {};
  let contracts = 0;
  let strictDims = 0;
  for await (const rel of Deno.readDir(root)) {
    if (!(rel.isDirectory && /^v\d+$/.test(rel.name))) continue;
    for await (const slug of Deno.readDir(`${root}/${rel.name}`)) {
      if (!slug.isDirectory) continue;
      for await (const id of contractIdsUnder(root, `${rel.name}/${slug.name}`)) {
        const contract = await loadContract(root, id);
        if (!contract) continue;
        contracts++;
        const findings = await surfaceCoverageFindings(contract, root, readHtml);
        for (const f of findings) (byClass[f.cls] ??= []).push(f);
        for (const doc of contract.documentation ?? []) {
          for (const [dim, cov] of Object.entries(doc.dimensions ?? {})) {
            if (
              cov?.status === "documented" && cov.selector &&
              ["syntax", "examples", "errors", "inputs", "outputs"].includes(dim)
            ) strictDims++;
          }
        }
      }
    }
  }
  return { contracts, strictDims, byClass };
}

if (import.meta.main) {
  const root = Deno.cwd();
  const all = Deno.args.includes("--all");
  if (all) {
    const r = await scanCorpus(root);
    console.log(
      `surface-coverage report: ${r.contracts} contracts, ${r.strictDims} strict-tier documented mappings`,
    );
    for (const [cls, list] of Object.entries(r.byClass)) {
      const pages = new Set(list.map((f) => f.id));
      console.log(`\n== ${cls}: ${list.length} mappings across ${pages.size} contracts`);
      const perContract = {};
      for (const f of list) perContract[f.id] = (perContract[f.id] ?? 0) + 1;
      const ranked = Object.entries(perContract).sort((a, b) => b[1] - a[1]);
      for (const [id, n] of ranked.slice(0, 12)) {
        const rep = list.find((f) => f.id === id);
        console.log(
          `   ${String(n).padStart(4)}  ${id}  e.g. ${rep.inventoryId}.${rep.dim} ${rep.selector}`,
        );
      }
      if (ranked.length > 12) console.log(`   ... ${ranked.length - 12} more contracts`);
    }
    console.log(
      "\nreport mode: findings are measurement, not gate failures (gendn-m7e design constraint).",
    );
    Deno.exit(0);
  }
  const r = await runRatchet(root);
  if (r.error) {
    console.error(`FAIL — surface-coverage ratchet could not run: ${r.error}`);
    Deno.exit(1);
  }
  for (const w of r.warnings) console.log(`WARNING: ${w}`);
  if (r.vacuous) {
    console.log(
      `NOTE: fetched baseline ${r.base} equals HEAD; no committed contract/page changes are in scope, but uncommitted files were checked.`,
    );
  }
  if (r.failures.length > 0) {
    for (const f of r.failures) console.error(`FAIL ${f}`);
    console.error(
      `FAIL — ${r.failures.length} surface-coverage violation(s) on touched contracts/pages (base ${r.base}; checked contracts ${r.changed.length}; page owners ${r.pageOwners.length}).`,
    );
    Deno.exit(1);
  }
  console.log(
    `PASS — no wrong-surface mappings on touched contracts/pages (base ${r.base}; checked contracts ${r.changed.length}; page owners ${r.pageOwners.length}; warnings ${r.warnings.length})${
      r.vacuous ? " [UNCHANGED: fetched baseline == HEAD]" : ""
    }.`,
  );
}
