// scripts/lib/bounded-git.mjs — ONE bounded git runner for every gate that shells out to git.
//
// WHY THIS EXISTS (gendn-8q2, after gendn-1tu): the same unbounded `git ... .output()` appeared in
// check-conformance.mjs, check-routes.mjs and route-manifest.mjs. Each copy could drift - one gate
// gaining a bound while another silently kept hanging - so the behaviour lives here, once, and the
// gates import it. Two ways a git call never returns:
//   (a) OBJECT-STORE CONTENTION - the object store is shared with other lanes and the merger, so a
//       read waits on a lock held by a landing that is mid-write;
//   (b) THE SUBTLE ONE - `output()` waits for PIPE EOF, and a git call that triggers automatic
//       maintenance/auto-gc forks a BACKGROUND process which INHERITS stdout, so EOF never arrives,
//       the promise never settles, no timers remain, and Deno exits with exactly "Top-level await
//       promise never resolved" - ZERO output, which reads as environmental and tempts a re-run.
// `-c gc.auto=0 --no-optional-locks` removes the auto-gc path; the timer bounds everything else. A
// timeout is ALWAYS a loud, named failure - never a silent hang: a lane must be able to tell "stuck"
// from "slow" without guessing.

export const GIT_TIMEOUT_MS = 60_000;
// `timeoutMs` below is a TEST-ONLY override (the mutation proofs shorten it). Production calls must
// not pass it: the whole point of this module is that every gate shares ONE bound, so widening or
// disabling it per call site would recreate the drift the module exists to prevent.

// Git global options that keep a read-only call out of the auto-maintenance path.
const GIT_SAFE_ARGS = ["-c", "gc.auto=0", "--no-optional-locks"];

/** Run git with a hard bound. Throws a named error on timeout; never returns on a hang. */
export async function runGit(
  args,
  { stdout = "null", timeoutMs = GIT_TIMEOUT_MS, stderr = "null" } = {},
) {
  const child = new Deno.Command("git", { args: [...GIT_SAFE_ARGS, ...args], stdout, stderr })
    .spawn();
  const output = child.output();
  let timer;
  const timedOut = await Promise.race([
    output.then(() => false, () => false),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    // Deliberately NOT awaiting `output`: if a forked child holds the pipe open it never settles,
    // and waiting would reintroduce exactly the hang this bound exists to prevent.
    throw new Error(
      `git ${args.join(" ")} did not complete within ${timeoutMs}ms - refusing to hang the gate ` +
        `(object-store contention, or a forked git maintenance process holding stdout open)`,
    );
  }
  const result = await output;
  const decode = (v) => new TextDecoder().decode(v);
  return {
    code: result.code,
    stdout: stdout === "piped" ? decode(result.stdout) : "",
    // stderr is returned so a caller's non-zero-exit error can NAME what git said (gendn-r1q: the
    // refactor to this module replaced "failed: <stderr>" with a bare exit code, and a one-line
    // `fatal: ...` is the most useful thing a human debugging a bad ref can be given).
    stderr: stderr === "piped" ? decode(result.stderr) : "",
  };
}

/** Convenience for the common "does this ref exist" check; false only on a non-zero exit. */
export async function gitRefExists(ref, options) {
  return (await runGit(["rev-parse", "--verify", "--quiet", ref], options)).code === 0;
}
