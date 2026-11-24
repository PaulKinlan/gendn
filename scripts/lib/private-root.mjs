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

import * as sys from "./sys.mjs";
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
  overlayTooling = true,
} = {}) {
  const root = await sys.makeTempDir({ prefix: `${prefix}-` });
  const remove = async () => {
    try {
      await sys.remove(root, { recursive: true });
    } catch {
      // Already removed (or never created past makeTempDir).
    }
  };
  try {
    const base = (await git(source, "rev-parse", baseline)).trim();
    await git(source, "clone", "--quiet", "--shared", "--no-checkout", source, root);
    await git(root, "checkout", "--quiet", "--detach", base);
    let pinned = base;
    if (overlayTooling) pinned = await overlayCheckoutTooling(source, root, base);
    await git(root, "update-ref", "refs/remotes/origin/main", pinned);
    return { root: `${root}/`, base: pinned, remove };
  } catch (error) {
    // A half-built root is never handed to a caller: it would serve an incomplete tree.
    await remove();
    throw error;
  }
}

/** The code under test, as opposed to the served pages: this checkout's version always runs. */
export const TOOLING_PATHS = [
  "scripts",
  "lib",
  "server.ts",
  "serve.ts",
  "package.json",
  "migrations.json",
];

/**
 * Replace the clone's tooling with the SOURCE checkout's working-tree copy and commit it, so the
 * suite exercises the scripts being changed rather than the baseline's, while the pages stay pinned
 * to `base`. The commit becomes the clone's origin/main, so the tree is still clean relative to it
 * and `--changed` scoping behaves exactly as it does at the baseline. Returns the pinned commit.
 */
async function overlayCheckoutTooling(source, root, base) {
  const listed = await git(
    source,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...TOOLING_PATHS,
  );
  const files = listed.split("\0").filter(Boolean);
  for (const path of TOOLING_PATHS) {
    await sys.remove(`${root}/${path}`, { recursive: true }).catch(() => {});
  }
  for (const file of files) {
    let bytes;
    try {
      bytes = await sys.readFile(`${source}${file}`);
    } catch (error) {
      if (error instanceof sys.errors.NotFound) continue; // deleted in the working tree
      throw error;
    }
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    if (dir) await sys.mkdir(`${root}/${dir}`, { recursive: true });
    await sys.writeFile(`${root}/${file}`, bytes);
  }
  await git(root, "add", "-A", "--", ...TOOLING_PATHS);
  const status = await git(root, "status", "--porcelain");
  if (!status.trim()) return base;
  await git(
    root,
    "-c",
    "user.name=gendn fixture",
    "-c",
    "user.email=fixture@gendn.invalid",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    "fixture: overlay the checkout's tooling onto the pinned pages",
  );
  return (await git(root, "rev-parse", "HEAD")).trim();
}
