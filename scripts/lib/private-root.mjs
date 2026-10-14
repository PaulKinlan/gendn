// scripts/lib/private-root.mjs — a disposable, PRIVATE served root for browser-backed fixtures.
//
// WHY THIS EXISTS (gendn-gvoq): the CSS-drift and reference-browser fixtures used to write their
// fixtures into the CHECKED-OUT repository — `<repo>/v9998/**` and `<repo>/reports/css-drift/**` —
// and serve the checkout itself. That made writable state SHARED between two suites that can run at
// the same time (CI matrix, a lane's parallel fixture run, an agent editing v9998): css-drift
// recursively removed `<repo>/v9998` before its own run, so a reference-browser fixture could lose
// the page it was about to load, and a SIGKILL between a write and its `finally` left debris the
// next run inherited. A fixture must own every path it can delete.
//
// A fixture that needs a real gendn tree now gets its OWN: a local `--shared` clone (git shares the
// object store, so this costs ~0.2 s and ~16 MB, and touches no network) checked out at a named
// baseline ref. Writes and deletions land inside the clone; the only thing the source checkout can
// observe is git reading its own object store. Each fixture removes exactly the root it created,
// never a shared path — and a run that is killed leaves debris in a root nobody else will look at.

import { runGit } from "./bounded-git.mjs";

/** Repo root of the checkout this module is loaded from (scripts/lib/ -> repo root). */
export const CHECKOUT_ROOT = new URL("../../", import.meta.url).pathname;

async function git(cwd, ...args) {
  const result = await runGit(args, { cwd, stdout: "piped", stderr: "piped" });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * Create a private, disposable copy of the repo to serve and mutate.
 *
 * `baseline` is resolved in the SOURCE checkout and pinned into the clone, including
 * `refs/remotes/origin/main`: css-drift's `--changed` scoping runs `git merge-base origin/main HEAD`
 * INSIDE the root, so the clone must be able to answer that ref without network.
 *
 * Returns `{ root, base, remove }`; `root` is absolute with a trailing slash, like the checkout
 * constants the fixtures already use, and `remove` is idempotent and never throws.
 */
export async function createPrivateServedRoot({
  prefix = "gendn-fixture",
  baseline = "origin/main",
  source = CHECKOUT_ROOT,
} = {}) {
  const root = await Deno.makeTempDir({ prefix: `${prefix}-` });
  const remove = async () => {
    try {
      await Deno.remove(root, { recursive: true });
    } catch {
      // Already removed (or never created past makeTempDir).
    }
  };
  try {
    const base = (await git(source, "rev-parse", baseline)).trim();
    await git(source, "clone", "--quiet", "--shared", "--no-checkout", source, root);
    await git(root, "checkout", "--quiet", "--detach", base);
    await git(root, "update-ref", "refs/remotes/origin/main", base);
    return { root: `${root}/`, base, remove };
  } catch (error) {
    // A half-built root is never handed to a caller: it would serve an incomplete tree.
    await remove();
    throw error;
  }
}
