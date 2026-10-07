// scripts/lib/judged-content.mjs — index-aware file reader for gates judging content.
//
// WHY THIS EXISTS (gendn-ip0z, after gendn-waa3): gendn-waa3 fixed diff keys (union of
// `git diff --cached`), but gates judging FILE CONTENTS (check-routes, route-manifest,
// validate-artifacts) read the WORKING TREE from disk (Deno.readTextFile). Consequence: a change
// staged in git whose working file was then reverted (git status shows MM) escaped detection
// because the gates read the reverted bytes on disk while git commit would carry the staged change.
//
// OPTION CHOSEN: Option (a) — for each judged path, read the INDEX version (`git show :<path>`)
// when the staged content differs from the worktree and the worktree does not differ from base
// (the staged-then-reverted escape), or when the staged index mutates identity/demo-critical
// fields while the worktree reverted those critical fields back to baseline (the decoy-edit escape
// closed in gendn-0n5s), falling back to the working tree file otherwise.
// Lanes legitimately run gates mid-edit with a dirty worktree, so uncommitted edits and
// standard git diff <base> cases keep judging the working tree exactly as before.

import { isAbsolute, relative, resolve } from "node:path";
import { runGit } from "./bounded-git.mjs";

const repoStateCache = new Map();

/** Invalidate cached repo state (used in tests that mutate git state within a process). */
export function invalidateJudgedCache() {
  repoStateCache.clear();
}

/**
 * Returns the set of repo-relative paths whose staged index content differs from the worktree
 * and the worktree does not differ from base (i.e. staged-then-reverted).
 */
export async function stagedRevertedPaths(root = ".", { fresh = false } = {}) {
  const state = await getRepoState(root, { fresh });
  return state?.stagedPaths ?? new Set();
}

function extractCriticalFields(filePath, content) {
  if (typeof content !== "string") return null;

  if (filePath.endsWith(".html")) {
    const featureIds = [...content.matchAll(/chromestatus\.com\/feature\/(\d+)/g)].map((m) => m[1]);
    const demos = [
      ...content.matchAll(/chrome-platform-showcase\.paulkinlan-ea\.deno\.net\/[^\s"'<>]+/g),
    ].map((m) => m[0]);
    // NOTE: Status/eyebrow (e.g. "Covered on MDN") is deliberately excluded here because
    // the gates tolerate status drift between built and stub (report-only in validate-artifacts,
    // allowed in check-routes). Only gate-binding fields are compared so that a decoy status
    // drift in the worktree cannot defeat the comparison and let a staged mutation escape.
    return { featureIds, demos };
  }

  if (filePath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content);
      if (filePath.endsWith("conformance.json")) {
        // Exclude status: validate-artifacts explicitly treats status drift as report-only,
        // so a status change must not mask a staged identity/demo mutation.
        return {
          id: parsed.id ?? null,
          route: parsed.route ?? null,
          milestone: parsed.milestone ?? null,
          identity: parsed.identity ?? null,
          demo: parsed.demo ?? null,
          cpsFeatureRoute: parsed.cpsFeature?.route ?? null,
        };
      }
      if (filePath.endsWith("reference-contract.json")) {
        const routes = (parsed.documentation ?? []).map((d) => String(d.href ?? "")).sort();
        return { routes };
      }
      if (filePath.endsWith("responsive-support.json")) {
        return { routes: parsed.routes ?? {} };
      }
      if (filePath.endsWith("migrations.json")) {
        return { migrations: parsed };
      }
      return parsed;
    } catch {
      return null;
    }
  }

  return null;
}

function parseNameStatus(stdout) {
  const allStaged = new Set();
  const renamedOld = new Set();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    const status = parts[0];
    if (status.startsWith("R") || status.startsWith("C")) {
      if (parts[1]) {
        allStaged.add(parts[1]);
        if (status.startsWith("R")) {
          renamedOld.add(parts[1]);
        }
      }
      if (parts[2]) allStaged.add(parts[2]);
    } else {
      if (parts[1]) allStaged.add(parts[1]);
    }
  }
  return { allStaged, renamedOld };
}

async function getRepoState(root = ".", { fresh = false } = {}) {
  const resolvedRoot = resolve(root);
  if (!fresh && repoStateCache.has(resolvedRoot)) {
    return repoStateCache.get(resolvedRoot);
  }

  try {
    const toplevelRes = await runGit(["rev-parse", "--show-toplevel"], {
      stdout: "piped",
      stderr: "piped",
      cwd: resolvedRoot,
    });
    if (toplevelRes.code !== 0) {
      const emptyState = { topLevel: null, stagedPaths: new Set() };
      repoStateCache.set(resolvedRoot, emptyState);
      return emptyState;
    }
    const topLevel = toplevelRes.stdout.trim();
    if (!topLevel) {
      const emptyState = { topLevel: null, stagedPaths: new Set() };
      repoStateCache.set(resolvedRoot, emptyState);
      return emptyState;
    }

    // 1. Files where index differs from HEAD (staged changes vs HEAD)
    const stagedVsHeadRes = await runGit(["diff", "--cached", "--name-status"], {
      stdout: "piped",
      cwd: topLevel,
    });
    const { allStaged: stagedVsHead, renamedOld: renamedOldVsHead } = parseNameStatus(
      stagedVsHeadRes.code === 0 ? stagedVsHeadRes.stdout : "",
    );

    // Optional: check against origin/main if it exists as a baseline
    let stagedVsBase = null;
    let worktreeVsBase = null;
    let renamedOldVsBase = new Set();
    const baseCheck = await runGit(["rev-parse", "--verify", "--quiet", "origin/main"], {
      cwd: topLevel,
    });
    if (baseCheck.code === 0) {
      const sRes = await runGit(["diff", "--cached", "--name-status", "origin/main"], {
        stdout: "piped",
        cwd: topLevel,
      });
      const wRes = await runGit(["diff", "--name-only", "origin/main"], {
        stdout: "piped",
        cwd: topLevel,
      });
      if (sRes.code === 0 && wRes.code === 0) {
        const parsedBase = parseNameStatus(sRes.stdout);
        stagedVsBase = parsedBase.allStaged;
        renamedOldVsBase = parsedBase.renamedOld;
        worktreeVsBase = new Set(wRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
      }
    }

    if (stagedVsHead.size === 0 && (!stagedVsBase || stagedVsBase.size === 0)) {
      const state = { topLevel, stagedPaths: new Set() };
      repoStateCache.set(resolvedRoot, state);
      return state;
    }

    // 2. Unstaged tracked modifications: files where worktree differs from index
    const worktreeVsIndexRes = await runGit(["diff", "--name-only"], {
      stdout: "piped",
      cwd: topLevel,
    });
    const worktreeVsIndex = new Set(
      worktreeVsIndexRes.code === 0
        ? worktreeVsIndexRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
        : [],
    );

    // 3. Untracked files: files on disk not in index (e.g. staged deleted, but restored on disk)
    const untrackedRes = await runGit(["ls-files", "--others", "--exclude-standard"], {
      stdout: "piped",
      cwd: topLevel,
    });
    const untracked = new Set(
      untrackedRes.code === 0
        ? untrackedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
        : [],
    );

    // 4. Files where worktree differs from HEAD
    const worktreeVsHeadRes = await runGit(["diff", "--name-only", "HEAD"], {
      stdout: "piped",
      cwd: topLevel,
    });
    const worktreeVsHead = new Set(
      worktreeVsHeadRes.code === 0
        ? worktreeVsHeadRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
        : [],
    );

    const candidates = new Set([...worktreeVsIndex, ...untracked]);
    const stagedPaths = new Set();
    for (const p of candidates) {
      // If the path was renamed away in the index but restored/retained on disk,
      // it is a staged-deleted path: read from index (which reports it deleted).
      if (renamedOldVsHead.has(p) || renamedOldVsBase.has(p)) {
        stagedPaths.add(p);
        continue;
      }

      const revertedVsHead = stagedVsHead.has(p) && !worktreeVsHead.has(p);
      const revertedVsBase = stagedVsBase && stagedVsBase.has(p) && !worktreeVsBase.has(p);
      if (revertedVsHead || revertedVsBase) {
        stagedPaths.add(p);
        continue;
      }

      // Check if staged index mutated critical fields while worktree reverted them (Scenario A decoy)
      if (stagedVsHead.has(p) || (stagedVsBase && stagedVsBase.has(p))) {
        let worktreeContent = null;
        try {
          worktreeContent = await Deno.readTextFile(resolve(topLevel, p));
        } catch {
          // file not on disk
        }
        if (worktreeContent === null) continue;

        const showIndexRes = await runGit(["show", `:${p}`], { stdout: "piped", cwd: topLevel });
        if (showIndexRes.code !== 0) continue;
        const indexContent = showIndexRes.stdout;

        const indexCrit = extractCriticalFields(p, indexContent);
        const worktreeCrit = extractCriticalFields(p, worktreeContent);
        if (!indexCrit || !worktreeCrit) continue;

        const indexWorktreeSame = JSON.stringify(indexCrit) === JSON.stringify(worktreeCrit);
        if (indexWorktreeSame) continue;

        // Compare against HEAD
        if (stagedVsHead.has(p)) {
          const showHeadRes = await runGit(["show", `HEAD:${p}`], {
            stdout: "piped",
            cwd: topLevel,
          });
          if (showHeadRes.code === 0) {
            const headCrit = extractCriticalFields(p, showHeadRes.stdout);
            if (headCrit) {
              const indexDiffHead = JSON.stringify(indexCrit) !== JSON.stringify(headCrit);
              const worktreeMatchHead = JSON.stringify(worktreeCrit) === JSON.stringify(headCrit);
              if (indexDiffHead && worktreeMatchHead) {
                stagedPaths.add(p);
                continue;
              }
            }
          }
        }

        // Compare against origin/main (base)
        if (stagedVsBase && stagedVsBase.has(p)) {
          const showBaseRes = await runGit(["show", `origin/main:${p}`], {
            stdout: "piped",
            cwd: topLevel,
          });
          if (showBaseRes.code === 0) {
            const baseCrit = extractCriticalFields(p, showBaseRes.stdout);
            if (baseCrit) {
              const indexDiffBase = JSON.stringify(indexCrit) !== JSON.stringify(baseCrit);
              const worktreeMatchBase = JSON.stringify(worktreeCrit) === JSON.stringify(baseCrit);
              if (indexDiffBase && worktreeMatchBase) {
                stagedPaths.add(p);
                continue;
              }
            }
          }
        }
      }
    }

    const state = { topLevel, stagedPaths };
    repoStateCache.set(resolvedRoot, state);
    return state;
  } catch {
    const emptyState = { topLevel: null, stagedPaths: new Set() };
    repoStateCache.set(resolvedRoot, emptyState);
    return emptyState;
  }
}

/**
 * Reads a text file, pulling from the git index if the path is staged-then-reverted,
 * or from the working tree otherwise.
 */
export async function readJudgedFile(path, root = ".", options = {}) {
  const state = await getRepoState(root, options);
  if (state?.topLevel) {
    const fullPath = isAbsolute(path) ? path : resolve(root, path);
    const rel = relative(state.topLevel, fullPath);
    if (!rel.startsWith("..") && !isAbsolute(rel) && state.stagedPaths.has(rel)) {
      const showRes = await runGit(["show", `:${rel}`], {
        stdout: "piped",
        stderr: "piped",
        cwd: state.topLevel,
      });
      if (showRes.code === 0) {
        return showRes.stdout;
      }
      throw new Deno.errors.NotFound(`File ${rel} not found in git index: ${showRes.stderr}`);
    }
  }

  const filePath = isAbsolute(path) ? path : resolve(root, path);
  return await Deno.readTextFile(filePath);
}

/**
 * Checks whether a judged file exists, checking the git index if the path is staged-then-reverted,
 * or stat on the working tree otherwise.
 */
export async function judgedFileExists(path, root = ".", options = {}) {
  const state = await getRepoState(root, options);
  if (state?.topLevel) {
    const fullPath = isAbsolute(path) ? path : resolve(root, path);
    const rel = relative(state.topLevel, fullPath);
    if (!rel.startsWith("..") && !isAbsolute(rel) && state.stagedPaths.has(rel)) {
      const catRes = await runGit(["cat-file", "-e", `:${rel}`], {
        cwd: state.topLevel,
      });
      return catRes.code === 0;
    }
  }

  try {
    const filePath = isAbsolute(path) ? path : resolve(root, path);
    await Deno.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads and parses JSON via readJudgedFile. Returns null on NotFound (matching readJson).
 */
export async function readJudgedJson(path, root = ".", options = {}) {
  try {
    const text = await readJudgedFile(path, root, options);
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}
