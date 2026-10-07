// gendn-m7e — SURFACE-COVERAGE RATCHET (the citation-ratchet pattern, gendn-t7h).
//
// Gate mode (default): contracts CHANGED in the diff vs the merge-base with origin/main
// must have ZERO wrong-surface/summary-table findings in the strict tier. A changed
// contract that retains a pre-existing wrong mapping FAILS — touch time is fix time
// (AGENTS.md's touch rule, made mechanical). Untracked contracts count as changed.
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

async function baselineRef(root) {
  const mb = await git(["merge-base", "origin/main", "HEAD"], root);
  if (mb?.trim()) return mb.trim();
  if (await git(["rev-parse", "--verify", "origin/main"], root)) return "origin/main";
  const head = await git(["rev-parse", "HEAD"], root);
  if (head?.trim()) return head.trim();
  return null;
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

/** The ratchet over changed contracts. Exported so the fixture can drive a scratch repo. */
export async function runRatchet(root) {
  const base = await baselineRef(root);
  if (!base) return { error: "no origin/main or HEAD baseline is available" };
  // base -> WORKING TREE (not base..HEAD): the ratchet must also see uncommitted edits to
  // tracked contracts, so a local run mid-work flags what a later commit would carry. The
  // committed-only view is a subset whenever the worktree mirrors HEAD.
  const diff = await git(["diff", "--name-only", base], root);
  if (diff === null) return { error: `git diff against ${base} failed` };
  const others = await git(["ls-files", "--others", "--exclude-standard"], root);
  const head = await git(["rev-parse", "HEAD"], root);
  const names = [
    ...diff.split("\n").map((s) => s.trim()).filter(Boolean),
    ...(others ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
  ];
  const vacuous = base === (head ?? "").trim();
  const ids = changedContractIds(names);
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
  return { base, changed: ids, failures, warnings, vacuous };
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
      const walk = async (dir) => {
        const contractPath = `${dir}/reference-contract.json`;
        const contract = await loadContract(
          root,
          contractPath.slice(root.length + 1).replace(/\/reference-contract\.json$/, ""),
        );
        if (contract) {
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
        for await (const e of Deno.readDir(dir)) {
          if (e.isDirectory) await walk(`${dir}/${e.name}`);
        }
      };
      await walk(`${root}/${rel.name}/${slug.name}`);
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
    console.log(`WARNING: baseline ${r.base} equals HEAD; the ratchet compared nothing (vacuous).`);
  }
  if (r.failures.length > 0) {
    for (const f of r.failures) console.error(`FAIL ${f}`);
    console.error(
      `FAIL — ${r.failures.length} surface-coverage violation(s) on changed contracts (base ${r.base}; changed contracts ${r.changed.length}).`,
    );
    Deno.exit(1);
  }
  console.log(
    `PASS — no wrong-surface mappings on changed contracts (base ${r.base}; changed contracts ${r.changed.length}; warnings ${r.warnings.length})${
      r.vacuous ? " [VACUOUS: base == HEAD]" : ""
    }.`,
  );
}
