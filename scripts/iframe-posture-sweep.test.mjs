// Chrome-free preflight: zero embeds must not be reported as browser acceptance.
import assert from "node:assert/strict";

const repo = new URL("..", import.meta.url).pathname;
const source = await Deno.readTextFile(`${repo}scripts/iframe-posture-sweep.mjs`);
const root = await Deno.makeTempDir({ prefix: "gendn-iframe-sweep-preflight-" });
const script = `${root}/scripts/iframe-posture-sweep.mjs`;
let assertions = 0;
async function run(args, permissions = ["--allow-read"]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...permissions, script, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}
const guardStart = "if (hardened.length === 0) {";
const guardEnd = "\nif (checkCorpus) {";
const start = source.indexOf(guardStart);
const end = source.indexOf(guardEnd, start);
assert(start >= 0 && end > start, "sabotage must locate the real refusal block");
try {
  await Deno.mkdir(`${root}/scripts/lib`, { recursive: true });
  await Deno.symlink(`${repo}scripts/lib/cdp.mjs`, `${root}/scripts/lib/cdp.mjs`);
  await Deno.symlink(`${repo}scripts/lib/map-pool.mjs`, `${root}/scripts/lib/map-pool.mjs`);
  await Deno.symlink(
    `${repo}scripts/lib/iframe-posture.mjs`,
    `${root}/scripts/lib/iframe-posture.mjs`,
  );
  // The real-run path lazily imports this startup helper and its read-only module graph.
  for (
    const name of [
      "reference-browser.mjs",
      "reference-contract.mjs",
      "artifacts.mjs",
      "judged-content.mjs",
      "plain-corpus-path.mjs",
      "bounded-git.mjs",
    ]
  ) {
    await Deno.symlink(`${repo}scripts/lib/${name}`, `${root}/scripts/lib/${name}`);
  }
  // Never touch the shared manual evidence directory, even if a future regression boots.
  await Deno.writeTextFile(
    script,
    source.replace('const OUT = "/tmp/kjq-sweep";', `const OUT = "${root}/evidence";`),
  );

  for (const args of [[], ["--check-corpus"]]) {
    const result = await run(args);
    assert.equal(result.code, 2, `empty corpus ${args.join(" ")} must refuse before boot`);
    assert.match(result.out, /sweep: 0 embed page\(s\) discovered/);
    assert.match(result.err, /EMPTY — 0 hardened embeds available for verification/);
    assert.doesNotMatch(result.out, /all 0 assertions passed|PASS:|preflight:/);
    assertions += 4;
  }
  // Positive control: a real checked-in embed page qualifies for discovery, but only the
  // read-only preflight is green; it explicitly does NOT claim browser acceptance.
  const realPage = "v152/sub-apps/index.html";
  const html = await Deno.readTextFile(`${repo}${realPage}`);
  assert.match(html, /<iframe\b[^>]*src="[^"]+"/s);
  assertions++;
  await Deno.mkdir(`${root}/v152/sub-apps`, { recursive: true });
  await Deno.writeTextFile(`${root}/${realPage}`, html);
  const valid = await run(["--check-corpus"]);
  assert.equal(valid.code, 0, valid.err);
  assert.match(valid.out, /sweep: 1 embed page\(s\) discovered/);
  assert.match(valid.out, /preflight: 1 hardened embed\(s\) eligible; NOT browser-verified/);
  assert.doesNotMatch(valid.out, /iframe-posture sweep: all .* assertions passed/);
  assertions += 4;

  // Force the shared child-owned server path to exit before binding, rather than probing
  // an unrelated healthy port. The copied script's REPO is this isolated root.
  const missingScript = "scripts/__missing_iframe_sweep_fixture__.ts";
  const patched = source.replace(
    "spawnServer({ cwd: REPO })",
    `spawnServer({ cwd: REPO, script: "${missingScript}" })`,
  );
  assert.notEqual(patched, source, "forced startup fixture must patch the real launch site");
  await Deno.writeTextFile(
    script,
    patched.replace('const OUT = "/tmp/kjq-sweep";', `const OUT = "${root}/evidence";`),
  );
  const failedStartup = await run([], [
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-env",
    "--allow-net=127.0.0.1,localhost",
  ]);
  assert.notEqual(failedStartup.code, 0);
  assert.match(failedStartup.err, /gendn server did not start for reference visibility validation/);
  assert.match(failedStartup.err, /__missing_iframe_sweep_fixture__\.ts/);
  assert.match(failedStartup.err, /Module not found/);
  assert.match(failedStartup.err, /child exit 1/);
  assert.doesNotMatch(failedStartup.out, /PASS:|all .* assertions passed/);
  assert.equal(
    (await Array.fromAsync(Deno.readDir(`${root}/evidence`))).length,
    0,
    "failed startup must not emit browser evidence",
  );
  assertions += 7;
  await Deno.remove(`${root}/evidence`, { recursive: true });
  await Deno.writeTextFile(
    script,
    source.replace('const OUT = "/tmp/kjq-sweep";', `const OUT = "${root}/evidence";`),
  );

  // A corpus containing only deferred embeds also performed no acceptance work.
  await Deno.remove(`${root}/scripts/lib/iframe-posture.mjs`);
  await Deno.writeTextFile(
    `${root}/scripts/lib/iframe-posture.mjs`,
    `export const PENDING_HARDENING = [{ file: "${realPage}" }];\n`,
  );
  const deferred = await run(["--check-corpus"]);
  assert.equal(deferred.code, 2);
  assert.match(deferred.out, /1 deliberately deferred/);
  assert.match(
    deferred.err,
    /EMPTY — 0 hardened embeds available for verification \(1 discovered, 1 deferred\)/,
  );
  assert.doesNotMatch(deferred.out, /preflight:|all 0 assertions passed/);
  assertions += 4;

  // Sabotage only the refusal branch, remove the copied embed, and prove the empty
  // corpus flips to a false-green discovery rather than an error.
  await Deno.remove(`${root}/${realPage}`);
  const sabotaged = source.slice(0, start) + source.slice(end);
  await Deno.writeTextFile(
    script,
    sabotaged.replace('const OUT = "/tmp/kjq-sweep";', `const OUT = "${root}/evidence";`),
  );
  const mutated = await run(["--check-corpus"]);
  assert.equal(mutated.code, 0, "guard removal must flip empty refusal RED");
  assert.match(mutated.out, /preflight: 0 hardened embed\(s\) eligible/);
  assertions += 2;
  const noEvidence = await Deno.stat(`${root}/evidence`).then(() => false, () => true);
  assert(noEvidence, "read-only preflight wrote no evidence directory");
  assertions++;
  console.log(
    `iframe-posture sweep preflight: ${assertions} assertions passed; sabotage: 1 empty-refusal RED`,
  );
} finally {
  await Deno.remove(root, { recursive: true });
}
