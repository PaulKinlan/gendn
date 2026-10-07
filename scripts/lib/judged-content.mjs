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
// (the staged-then-reverted escape), falling back to the working tree file otherwise.
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
    const stagedVsHeadRes = await runGit(["diff", "--cached", "--name-only"], {
      stdout: "piped",
      cwd: topLevel,
    });
    const stagedVsHead = new Set(
      stagedVsHeadRes.code === 0
        ? stagedVsHeadRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
        : [],
    );

    // Optional: check against origin/main if it exists as a baseline
    let stagedVsBase = null;
    let worktreeVsBase = null;
    const baseCheck = await runGit(["rev-parse", "--verify", "--quiet", "origin/main"], {
      cwd: topLevel,
    });
    if (baseCheck.code === 0) {
      const sRes = await runGit(["diff", "--cached", "--name-only", "origin/main"], {
        stdout: "piped",
        cwd: topLevel,
      });
      const wRes = await runGit(["diff", "--name-only", "origin/main"], {
        stdout: "piped",
        cwd: topLevel,
      });
      if (sRes.code === 0 && wRes.code === 0) {
        stagedVsBase = new Set(sRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
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
      const revertedVsHead = stagedVsHead.has(p) && !worktreeVsHead.has(p);
      const revertedVsBase = stagedVsBase && stagedVsBase.has(p) && !worktreeVsBase.has(p);
      if (revertedVsHead || revertedVsBase) {
        stagedPaths.add(p);
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
