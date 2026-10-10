// @fixture-permissions --allow-read --allow-write --allow-run
// scripts/refresh-bindings.test.mjs
// Focused tests for refresh-bindings guard behaviour.
// Covers without Chrome:
//   (1) rows identical to the committed ledger -> writes, rc0
//   (2) rows empty while the ledger is non-empty -> refuses, non-zero, names removed routes, byte-identical
//   (3) rows missing a published route -> refuses unless --allow-removals is passed, and with flag writes
//   (4) added routes -> writes without a flag
// Asserts byte-identity of tracked ledger on every refusal path. Supports --sabotage to prove failure if guard is bypassed.

import {
  BINDING_LEDGER,
  evaluateLedgerRefresh,
  formatRemovedRoutes,
} from "./lib/binding-ledger.mjs";

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.error(`FAIL: ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const enc = new TextDecoder();

// --- 1. Unit tests for formatRemovedRoutes ---
assert(
  "formatRemovedRoutes with empty array returns 'none'",
  formatRemovedRoutes([]) === "none",
);
assert(
  "formatRemovedRoutes with <= max items formats list exactly",
  formatRemovedRoutes(["/v1/a/", "/v1/b/"]) === "/v1/a/, /v1/b/",
);
assert(
  "formatRemovedRoutes bounds display and counts remainder",
  formatRemovedRoutes(["/v1/a/", "/v1/b/", "/v1/c/", "/v1/d/", "/v1/e/"]) ===
    "/v1/a/, /v1/b/, /v1/c/, ... and 2 more",
);

// --- 2. Unit tests for evaluateLedgerRefresh ---
const rowA = { route: "/v900/probe-a/", identity: "101", demo: null };
const rowB = { route: "/v900/probe-b/", identity: "102", demo: null };

assert(
  "evaluateLedgerRefresh rejects empty derived rows on non-empty ledger with reason 'catalogue empty'",
  (() => {
    const res = evaluateLedgerRefresh({ current: [], ledger: [rowA] });
    return !res.ok && res.reason === "catalogue empty" && res.removed.length === 1 &&
      res.message.includes("catalogue empty") && res.message.includes("/v900/probe-a/");
  })(),
);

assert(
  "evaluateLedgerRefresh rejects empty derived rows even if allowRemovals is true",
  (() => {
    const res = evaluateLedgerRefresh({ current: [], ledger: [rowA], allowRemovals: true });
    return !res.ok && res.reason === "catalogue empty";
  })(),
);

assert(
  "evaluateLedgerRefresh rejects shrunk catalogue without allowRemovals flag",
  (() => {
    const res = evaluateLedgerRefresh({
      current: [rowA],
      ledger: [rowA, rowB],
      allowRemovals: false,
    });
    return !res.ok && res.reason === "catalogue shrunk" && res.removed.length === 1 &&
      res.removed[0] === "/v900/probe-b/" && res.message.includes("--allow-removals");
  })(),
);

assert(
  "evaluateLedgerRefresh accepts shrunk catalogue with allowRemovals: true",
  (() => {
    const res = evaluateLedgerRefresh({
      current: [rowA],
      ledger: [rowA, rowB],
      allowRemovals: true,
    });
    return res.ok && res.removed.length === 1 && res.removed[0] === "/v900/probe-b/";
  })(),
);

assert(
  "evaluateLedgerRefresh accepts identical rows without a flag",
  (() => {
    const res = evaluateLedgerRefresh({
      current: [rowA, rowB],
      ledger: [rowA, rowB],
      allowRemovals: false,
    });
    return res.ok && res.removed.length === 0;
  })(),
);

assert(
  "evaluateLedgerRefresh accepts added routes without a flag",
  (() => {
    const res = evaluateLedgerRefresh({
      current: [rowA, rowB],
      ledger: [rowA],
      allowRemovals: false,
    });
    return res.ok && res.removed.length === 0;
  })(),
);

// --- 3. Subprocess integration tests with temp ledger and files ---
const tempDir = await Deno.makeTempDir({ prefix: "gendn-refresh-test-" });
const isSabotage = Deno.args.includes("--sabotage");

try {
  const trackedLedgerPath = BINDING_LEDGER;
  const originalTrackedBytes = await Deno.readFile(trackedLedgerPath);

  // Set up temp scripts directory
  const tempScriptsDir = `${tempDir}/scripts`;
  const tempLibDir = `${tempScriptsDir}/lib`;
  await Deno.mkdir(tempLibDir, { recursive: true });

  // Copy scripts needed for execution
  const refreshScriptSource = await Deno.readTextFile(
    new URL("./refresh-bindings.mjs", import.meta.url),
  );
  let bindingLedgerSource = await Deno.readTextFile(
    new URL("./lib/binding-ledger.mjs", import.meta.url),
  );
  const routeManifestSource = await Deno.readTextFile(
    new URL("./route-manifest.mjs", import.meta.url),
  );
  const artifactsSource = await Deno.readTextFile(
    new URL("./lib/artifacts.mjs", import.meta.url),
  );
  const plainCorpusPathSource = await Deno.readTextFile(
    new URL("./lib/plain-corpus-path.mjs", import.meta.url),
  );
  const boundedGitSource = await Deno.readTextFile(
    new URL("./lib/bounded-git.mjs", import.meta.url),
  );
  const mapPoolSource = await Deno.readTextFile(
    new URL("./lib/map-pool.mjs", import.meta.url),
  );
  const judgedContentSource = await Deno.readTextFile(
    new URL("./lib/judged-content.mjs", import.meta.url),
  );

  if (isSabotage) {
    // Sabotage: bypass the guard entirely in the temp copy
    bindingLedgerSource = bindingLedgerSource.replace(
      "export function evaluateLedgerRefresh",
      "export function evaluateLedgerRefresh() { return { ok: true, reason: null, removed: [] }; }\nfunction _sabotaged_evaluateLedgerRefresh",
    );
  }

  await Deno.writeTextFile(`${tempScriptsDir}/refresh-bindings.mjs`, refreshScriptSource);
  await Deno.writeTextFile(`${tempLibDir}/binding-ledger.mjs`, bindingLedgerSource);
  await Deno.writeTextFile(`${tempScriptsDir}/route-manifest.mjs`, routeManifestSource);
  await Deno.writeTextFile(`${tempLibDir}/artifacts.mjs`, artifactsSource);
  await Deno.writeTextFile(`${tempLibDir}/plain-corpus-path.mjs`, plainCorpusPathSource);
  await Deno.writeTextFile(`${tempLibDir}/bounded-git.mjs`, boundedGitSource);
  await Deno.writeTextFile(`${tempLibDir}/map-pool.mjs`, mapPoolSource);
  await Deno.writeTextFile(`${tempLibDir}/judged-content.mjs`, judgedContentSource);

  // Set up synthetic test pages
  const fixturePagesRoot = `${tempDir}/fixture-pages`;
  const shrunkPagesRoot = `${tempDir}/shrunk-pages`;
  const emptyPagesRoot = `${tempDir}/empty-pages`;

  await Deno.mkdir(`${fixturePagesRoot}/v900/probe-a`, { recursive: true });
  await Deno.mkdir(`${fixturePagesRoot}/v900/probe-b`, { recursive: true });
  await Deno.writeTextFile(
    `${fixturePagesRoot}/v900/probe-a/index.html`,
    `<html><a href="https://chromestatus.com/feature/101">Feature A</a></html>`,
  );
  await Deno.writeTextFile(
    `${fixturePagesRoot}/v900/probe-b/index.html`,
    `<html><a href="https://chromestatus.com/feature/102">Feature B</a></html>`,
  );

  await Deno.mkdir(`${shrunkPagesRoot}/v900/probe-a`, { recursive: true });
  await Deno.writeTextFile(
    `${shrunkPagesRoot}/v900/probe-a/index.html`,
    `<html><a href="https://chromestatus.com/feature/101">Feature A</a></html>`,
  );

  await Deno.mkdir(emptyPagesRoot, { recursive: true });

  const tempFixtureLedgerPath = `${tempDir}/fixture-ledger.json`;
  const baseFixtureRows = [rowA, rowB];
  const baseFixtureJson = JSON.stringify(baseFixtureRows, null, 2) + "\n";

  async function executeRefresh(args = []) {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-run",
        "--allow-write",
        `${tempScriptsDir}/refresh-bindings.mjs`,
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    return {
      code: out.code,
      stdout: enc.decode(out.stdout),
      stderr: enc.decode(out.stderr),
    };
  }

  // --- Case (1): Rows identical to committed ledger -> writes, rc0 ---
  // Subtest 1A: synthetic fixture
  await Deno.writeTextFile(tempFixtureLedgerPath, baseFixtureJson);
  const res1A = await executeRefresh([
    `--ledger=${tempFixtureLedgerPath}`,
    `--root=${fixturePagesRoot}`,
  ]);
  assert("Case 1A (identical fixture): writes and exits rc0", res1A.code === 0, res1A.stderr);
  assert(
    "Case 1A: stdout reports 2 published routes",
    res1A.stdout.includes("2 published routes"),
    res1A.stdout,
  );
  assert(
    "Case 1A: tracked ledger in repository remains byte-identical",
    bytesEqual(await Deno.readFile(trackedLedgerPath), originalTrackedBytes),
  );

  // Subtest 1B: copy of full repository ledger with repository root
  const tempCommittedCopyPath = `${tempDir}/repo-ledger-copy.json`;
  await Deno.writeFile(tempCommittedCopyPath, originalTrackedBytes);
  const res1B = await executeRefresh([
    `--ledger=${tempCommittedCopyPath}`,
    `--root=.`,
  ]);
  assert("Case 1B (repo identical): writes and exits rc0", res1B.code === 0, res1B.stderr);
  assert(
    "Case 1B: stdout reports 201 published routes",
    res1B.stdout.includes("201 published routes"),
    res1B.stdout,
  );
  assert(
    "Case 1B: tracked ledger in repository remains byte-identical",
    bytesEqual(await Deno.readFile(trackedLedgerPath), originalTrackedBytes),
  );

  // --- Case (2): Rows empty while ledger is non-empty -> refuses, non-zero, names removed routes, byte-identical ---
  // Subtest 2A: fixture ledger vs empty pages
  await Deno.writeTextFile(tempFixtureLedgerPath, baseFixtureJson);
  const before2A = await Deno.readFile(tempFixtureLedgerPath);
  const res2A = await executeRefresh([
    `--ledger=${tempFixtureLedgerPath}`,
    `--root=${emptyPagesRoot}`,
  ]);
  assert(
    "Case 2A (empty catalogue): refuses with non-zero exit code",
    res2A.code !== 0,
    `code=${res2A.code}, stdout=${res2A.stdout}`,
  );
  assert(
    "Case 2A: stderr names reason 'catalogue empty'",
    res2A.stderr.includes("catalogue empty"),
    res2A.stderr,
  );
  assert(
    "Case 2A: stderr names removed count (2 routes)",
    res2A.stderr.includes("2 routes"),
    res2A.stderr,
  );
  assert(
    "Case 2A: stderr names removed routes",
    res2A.stderr.includes("/v900/probe-a/") && res2A.stderr.includes("/v900/probe-b/"),
    res2A.stderr,
  );
  assert(
    "Case 2A: temp ledger byte-identical after refusal (no write occurred)",
    bytesEqual(await Deno.readFile(tempFixtureLedgerPath), before2A),
  );
  assert(
    "Case 2A: tracked repo ledger remains byte-identical",
    bytesEqual(await Deno.readFile(trackedLedgerPath), originalTrackedBytes),
  );

  // Subtest 2B: 201-route repository copy vs empty pages (verifies bounded output "... and N more")
  await Deno.writeFile(tempCommittedCopyPath, originalTrackedBytes);
  const before2B = await Deno.readFile(tempCommittedCopyPath);
  const res2B = await executeRefresh([
    `--ledger=${tempCommittedCopyPath}`,
    `--root=${emptyPagesRoot}`,
  ]);
  assert(
    "Case 2B (201 routes empty): refuses with non-zero exit code",
    res2B.code !== 0,
    `code=${res2B.code}`,
  );
  assert(
    "Case 2B: stderr names reason 'catalogue empty'",
    res2B.stderr.includes("catalogue empty"),
    res2B.stderr,
  );
  assert(
    "Case 2B: stderr names removed count (201 routes)",
    res2B.stderr.includes("201 routes"),
    res2B.stderr,
  );
  assert(
    "Case 2B: stderr bounds list with '... and 198 more'",
    res2B.stderr.includes("... and 198 more"),
    res2B.stderr,
  );
  assert(
    "Case 2B: temp ledger byte-identical after refusal (no write occurred)",
    bytesEqual(await Deno.readFile(tempCommittedCopyPath), before2B),
  );
  assert(
    "Case 2B: tracked repo ledger remains byte-identical",
    bytesEqual(await Deno.readFile(trackedLedgerPath), originalTrackedBytes),
  );

  // --- Case (3): Rows missing a published route -> refuses unless --allow-removals passed, and with flag writes ---
  // Subtest 3A: without flag -> refuses
  await Deno.writeTextFile(tempFixtureLedgerPath, baseFixtureJson);
  const before3A = await Deno.readFile(tempFixtureLedgerPath);
  const res3A = await executeRefresh([
    `--ledger=${tempFixtureLedgerPath}`,
    `--root=${shrunkPagesRoot}`,
  ]);
  assert(
    "Case 3A (missing route without flag): refuses with non-zero exit code",
    res3A.code !== 0,
    `code=${res3A.code}`,
  );
  assert(
    "Case 3A: stderr names reason 'catalogue shrunk'",
    res3A.stderr.includes("catalogue shrunk"),
    res3A.stderr,
  );
  assert(
    "Case 3A: stderr names removed count (1 route)",
    res3A.stderr.includes("1 route"),
    res3A.stderr,
  );
  assert(
    "Case 3A: stderr names missing route /v900/probe-b/",
    res3A.stderr.includes("/v900/probe-b/"),
    res3A.stderr,
  );
  assert(
    "Case 3A: stderr instructs user to pass --allow-removals",
    res3A.stderr.includes("--allow-removals"),
    res3A.stderr,
  );
  assert(
    "Case 3A: temp ledger byte-identical after refusal (no write occurred)",
    bytesEqual(await Deno.readFile(tempFixtureLedgerPath), before3A),
  );
  assert(
    "Case 3A: tracked repo ledger remains byte-identical",
    bytesEqual(await Deno.readFile(trackedLedgerPath), originalTrackedBytes),
  );

  // Subtest 3B: with --allow-removals -> writes
  const res3B = await executeRefresh([
    `--ledger=${tempFixtureLedgerPath}`,
    `--root=${shrunkPagesRoot}`,
    "--allow-removals",
  ]);
  assert(
    "Case 3B (missing route WITH --allow-removals): writes and exits rc0",
    res3B.code === 0,
    res3B.stderr,
  );
  assert(
    "Case 3B: stdout reports 1 published routes",
    res3B.stdout.includes("1 published routes"),
    res3B.stdout,
  );
  const updated3B = JSON.parse(await Deno.readTextFile(tempFixtureLedgerPath));
  assert(
    "Case 3B: temp ledger now has exactly 1 route (/v900/probe-a/)",
    updated3B.length === 1 && updated3B[0].route === "/v900/probe-a/",
  );
  assert(
    "Case 3B: tracked repo ledger remains byte-identical",
    bytesEqual(await Deno.readFile(trackedLedgerPath), originalTrackedBytes),
  );

  // --- Case (4): Added routes -> writes without a flag ---
  // Ledger starts with only probe-a; fixturePagesRoot has both probe-a and probe-b
  await Deno.writeTextFile(tempFixtureLedgerPath, JSON.stringify([rowA], null, 2) + "\n");
  const res4 = await executeRefresh([
    `--ledger=${tempFixtureLedgerPath}`,
    `--root=${fixturePagesRoot}`,
  ]);
  assert("Case 4 (added route): writes without a flag and exits rc0", res4.code === 0, res4.stderr);
  assert(
    "Case 4: stdout reports 2 published routes",
    res4.stdout.includes("2 published routes"),
    res4.stdout,
  );
  const updated4 = JSON.parse(await Deno.readTextFile(tempFixtureLedgerPath));
  assert(
    "Case 4: temp ledger updated to contain both routes",
    updated4.length === 2 && updated4.some((r) => r.route === "/v900/probe-a/") &&
      updated4.some((r) => r.route === "/v900/probe-b/"),
  );
  assert(
    "Case 4: tracked repo ledger remains byte-identical",
    bytesEqual(await Deno.readFile(trackedLedgerPath), originalTrackedBytes),
  );
} finally {
  await Deno.remove(tempDir, { recursive: true });
}

console.log(`refresh bindings: ${passed} passed, ${failed} failed`);
if (failed) Deno.exit(1);
