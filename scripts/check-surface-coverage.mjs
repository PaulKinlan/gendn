// gendn-m7e — SURFACE-COVERAGE RATCHET (the citation-ratchet pattern, gendn-t7h).
//
// Gate mode (default): contracts CHANGED in the diff vs the merge-base with origin/main,
// OR owning a changed page, must have ZERO wrong-surface/summary-table findings in the
// strict tier. A touched contract/page that retains a wrong mapping FAILS — touch time
// is fix time (AGENTS.md's touch rule, made mechanical). Untracked files count as changed.
//
// --all: corpus-wide REPORT mode for findings; zero contracts fail rather than report success. Prints counts grouped by class
// with representatives, per the acceptance criterion that a large count for non-defect
// reasons is itself the finding (recorded on the bead, not iterated away).
//
// The slicing rule is executed by the library (scripts/lib/surface-coverage.mjs imports
// fragmentAfterId/stripMarkup/nameTokens from reference-contract.mjs); this script never
// re-implements it. The /<h[1-3]\b/i rule ends a slice at the next h1/h2/h3 — the misread
// 'next h2' produced gendn-5ao's self-confirming probe; the fixture replays that trap.
import { surfaceCoverageFindings } from "./lib/surface-coverage.mjs";
import { plainCorpusPath } from "./lib/plain-corpus-path.mjs";

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
  const verdict = await plainCorpusPath(root, id);
  if (verdict.state === "missing") return; // genuine deletion: check-routes owns it
  if (verdict.state !== "ok") throw new Error(`${id}: ${verdict.reason}`);
  try {
    for await (const entry of Deno.readDir(`${root}/${id}`)) {
      const child = `${id}/${entry.name}`;
      if (entry.isSymlink) {
        throw new Error(`${child}: ${(await plainCorpusPath(root, child)).reason}`);
      }
      if (entry.isFile && entry.name === "reference-contract.json") yield id;
      if (entry.isDirectory) yield* contractIdsUnder(root, child);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      const recheck = await plainCorpusPath(root, id);
      if (recheck.state === "missing") return; // genuine deletion, not a dangling component
    }
    throw new Error(`${id}: cannot traverse contract directory: ${err.message}`);
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

async function readHtml(root, path) {
  const relative = path.slice(root.length + 1);
  const verdict = await plainCorpusPath(root, relative, "file");
  if (verdict.state === "missing") return null; // missing href is handled by contract validation
  if (verdict.state !== "ok") throw new Error(`${relative}: ${verdict.reason}`);
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      const recheck = await plainCorpusPath(root, relative, "file");
      if (recheck.state === "missing") return null;
    }
    throw new Error(`${relative}: cannot read documented page: ${err.message}`);
  }
}

async function loadContract(root, id) {
  const path = `${id}/reference-contract.json`;
  const verdict = await plainCorpusPath(root, path, "file");
  if (verdict.state === "missing") return null; // genuine removal: check-routes owns it
  if (verdict.state !== "ok") throw new Error(`${path}: ${verdict.reason}`);
  try {
    const contract = JSON.parse(await Deno.readTextFile(`${root}/${path}`));
    if (
      !contract || typeof contract !== "object" || Array.isArray(contract) ||
      contract.id !== id || !Array.isArray(contract.inventory) ||
      !Array.isArray(contract.documentation)
    ) {
      throw new Error("malformed contract: expected matching id, inventory[] and documentation[]");
    }
    return contract;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      const recheck = await plainCorpusPath(root, path, "file");
      if (recheck.state === "missing") return null;
    }
    throw new Error(`${path}: cannot read or parse touched contract: ${err.message}`);
  }
}

async function countCurrentContracts(root) {
  let count = 0;
  for await (const rel of Deno.readDir(root)) {
    if (!/^v\d+$/.test(rel.name)) continue;
    const milestone = await plainCorpusPath(root, rel.name);
    if (milestone.state !== "ok") throw new Error(`${rel.name}: ${milestone.reason}`);
    for await (const slug of Deno.readDir(`${root}/${rel.name}`)) {
      if (!slug.isDirectory && !slug.isSymlink) continue;
      const owner = `${rel.name}/${slug.name}`;
      const verdict = await plainCorpusPath(root, owner);
      if (verdict.state !== "ok") throw new Error(`${owner}: ${verdict.reason}`);
      for await (const _id of contractIdsUnder(root, owner)) count++;
    }
  }
  return count;
}

/** Ratchet changed contracts and contracts owning changed pages. Exported for scratch fixtures. */
export async function runRatchet(root) {
  const base = await baselineRef(root);
  if (!base) {
    return {
      error: "cannot verify committed surface mappings: independent baseline " +
        "refs/remotes/origin/main is unavailable or not a commit; run git fetch origin main " +
        "before this ratchet (no HEAD self-baseline)",
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
  const head = await git(["rev-parse", "HEAD^{commit}"], root);
  const fetched = await git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], root);
  if (!head || !fetched) return { error: "cannot resolve HEAD or fetched baseline commit" };
  const names = [
    ...new Set([
      ...diff.split("\n").map((s) => s.trim()).filter(Boolean),
      ...cached.split("\n").map((s) => s.trim()).filter(Boolean),
      ...(others ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
    ]),
  ];
  const vacuous = fetched.trim() === head.trim();
  const pageOwners = changedPageOwners(names);
  const ids = new Set(changedContractIds(names));
  const failures = [];
  for (const owner of pageOwners) {
    try {
      for await (const id of contractIdsUnder(root, owner)) ids.add(id);
    } catch (err) {
      failures.push(`touched page ${owner}: ${err.message}`);
    }
  }
  const warnings = [];
  let inspected = 0;
  for (const id of ids) {
    let contract;
    try {
      contract = await loadContract(root, id);
    } catch (err) {
      failures.push(`touched contract ${err.message}`);
      continue;
    }
    if (!contract) continue; // deleted in the diff; route gate owns removal
    inspected++;
    let findings;
    try {
      findings = await surfaceCoverageFindings(contract, root, (path) => readHtml(root, path));
    } catch (err) {
      failures.push(`touched contract ${id}: cannot read documented page: ${err.message}`);
      continue;
    }
    for (const f of findings) {
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
  // Independently published contracts anchor the floor. Zero current contracts is a
  // finding, not a clean result from a ratchet that happened to inspect nothing.
  const priorPaths = await git(["ls-tree", "-r", "--name-only", "origin/main"], root);
  if (priorPaths === null) return { error: "cannot read independent published contract catalogue" };
  const priorContracts =
    priorPaths.split("\n").filter((path) =>
      /^v\d+\/[^/]+(?:\/[^/]+)*\/reference-contract\.json$/.test(path)
    ).length;
  if (priorContracts === 0) {
    return {
      error: "independent published contract catalogue has zero contracts; cannot anchor the floor",
    };
  }
  let currentContracts;
  try {
    currentContracts = await countCurrentContracts(root);
  } catch (err) {
    failures.push(`published contract census: cannot inspect ${err.message}`);
  }
  if (currentContracts === 0) {
    failures.push(
      `published reference-contract corpus empty: zero contracts against ${priorContracts} independent origin/main contracts`,
    );
  }
  return { base, changed: [...ids], inspected, pageOwners, failures, warnings, vacuous };
}

/** Corpus-wide report (--all). Findings are measurements; the CLI rejects an empty corpus. */
export async function scanCorpus(root) {
  const byClass = {};
  let contracts = 0;
  let strictDims = 0;
  for await (const rel of Deno.readDir(root)) {
    if (!/^v\d+$/.test(rel.name)) continue;
    const milestone = await plainCorpusPath(root, rel.name);
    if (milestone.state !== "ok") throw new Error(`${rel.name}: ${milestone.reason}`);
    for await (const slug of Deno.readDir(`${root}/${rel.name}`)) {
      if (!slug.isDirectory && !slug.isSymlink) continue;
      const owner = `${rel.name}/${slug.name}`;
      const verdict = await plainCorpusPath(root, owner);
      if (verdict.state !== "ok") throw new Error(`${owner}: ${verdict.reason}`);
      for await (const id of contractIdsUnder(root, owner)) {
        const contract = await loadContract(root, id);
        if (!contract) continue;
        contracts++;
        const findings = await surfaceCoverageFindings(
          contract,
          root,
          (path) => readHtml(root, path),
        );
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
    let r;
    try {
      r = await scanCorpus(root);
    } catch (err) {
      console.error(`FAIL — cannot scan published contract: ${err.message}`);
      Deno.exit(1);
    }
    if (r.contracts === 0) {
      console.error(
        "FAIL — surface-coverage report cannot assess an empty published contract corpus (zero reference-contract.json files scanned)",
      );
      Deno.exit(1);
    }
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
  let r;
  try {
    r = await runRatchet(root);
  } catch (err) {
    console.error(`FAIL — cannot inspect published contract: ${err.message}`);
    Deno.exit(1);
  }
  if (r.error) {
    // No independent baseline is a precondition failure (landing-preflight's rc6), not a
    // wrong-surface finding (rc1). Both stay nonzero, with no successful ratchet verdict.
    console.error(
      `FAIL — PRECONDITION (exit 6): surface-coverage ratchet could not verify: ${r.error}`,
    );
    Deno.exit(6);
  }
  for (const w of r.warnings) console.log(`WARNING: ${w}`);
  const unchangedNote = r.vacuous
    ? " [UNCHANGED: fetched baseline == HEAD - committed changes not in scope; uncommitted edits still checked]"
    : "";
  if (r.vacuous) {
    console.log(
      `surface-coverage ratchet: base ${r.base}; checked contracts ${r.inspected}; page owners ${r.pageOwners.length}${unchangedNote}`,
    );
  }
  if (r.failures.length > 0) {
    for (const f of r.failures) console.error(`FAIL ${f}`);
    console.error(
      `FAIL — ${r.failures.length} surface-coverage violation(s) on touched contracts/pages (base ${r.base}; checked contracts ${r.inspected}; page owners ${r.pageOwners.length}).`,
    );
    Deno.exit(1);
  }
  console.log(
    `PASS — no wrong-surface mappings on touched contracts/pages (base ${r.base}; checked contracts ${r.inspected}; page owners ${r.pageOwners.length}; warnings ${r.warnings.length})${unchangedNote}.`,
  );
}
