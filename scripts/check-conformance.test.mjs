// @fixture-permissions --allow-read --allow-write --allow-run --allow-net --allow-env
// scripts/check-conformance.test.mjs — staged-then-reverted declared-surface checks in check-conformance (gendn-rtvp).
//
// When an HTML surface change is staged and the working tree is reverted to baseline (git status MM),
// check-conformance.mjs must read the staged index content via readJudgedFile rather than disk
// with Deno.readTextFile, closing the escape window for declared-surface checks (line 269) and
// the noIdlSurface denominator check (line 355).
// Also pin the independent origin/main baseline: committed assertion removal must be detected
// with the ref and explicitly refused without it, never checked against HEAD itself.

import { suiteHash } from "./lib/artifacts.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CHECK_CONFORMANCE = `${REPO}/scripts/check-conformance.mjs`;

let failures = 0;
function assert(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${!ok && detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures++;
}

const scratch = await Deno.makeTempDir({ prefix: "rtvp-check-conformance-" });

try {
  // Set up schema directory
  await Deno.mkdir(`${scratch}/schema`, { recursive: true });
  for await (const entry of Deno.readDir(`${REPO}/schema`)) {
    if (entry.isFile) {
      await Deno.copyFile(`${REPO}/schema/${entry.name}`, `${scratch}/schema/${entry.name}`);
    }
  }

  // Set up a real implementation-sufficient feature page
  const FEATURE = "v150/webrtc-diagnostic-logging-api";
  await Deno.mkdir(`${scratch}/${FEATURE}`, { recursive: true });
  for await (const entry of Deno.readDir(`${REPO}/${FEATURE}`)) {
    if (entry.isFile) {
      await Deno.copyFile(
        `${REPO}/${FEATURE}/${entry.name}`,
        `${scratch}/${FEATURE}/${entry.name}`,
      );
    }
  }

  // Set up a legacy built page with no contract and no IDL surface (for denominator checking)
  const LEGACY = "v999/legacy-feature";
  await Deno.mkdir(`${scratch}/${LEGACY}`, { recursive: true });
  await Deno.writeTextFile(
    `${scratch}/${LEGACY}/index.html`,
    `<!DOCTYPE html>
<html><body>
<h1>Legacy Feature</h1>
<p class="eyebrow">Status: built</p>
<span class="citation"><a href="https://chromestatus.com/feature/999999" target="_blank" rel="noopener">chromestatus.com/feature/999999</a></span>
<p>Legacy CSS property with no WebIDL interface.</p>
</body></html>`,
  );

  const legacyAssertions = [
    JSON.parse(await Deno.readTextFile(`${scratch}/${FEATURE}/conformance.json`)).assertions[0],
  ];
  await Deno.writeTextFile(
    `${scratch}/${LEGACY}/conformance.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        id: LEGACY,
        route: `/${LEGACY}/`,
        identity: "999999",
        milestone: 999,
        status: "built",
        demo: null,
        cpsFeature: null,
        immutable: true,
        suiteHash: await suiteHash(legacyAssertions),
        generatedAt: "2026-10-08T00:00:00Z",
        author: "rtvp fixture",
        assertions: legacyAssertions,
      },
      null,
      2,
    ),
  );

  await Deno.writeTextFile(
    `${scratch}/responsive-support.json`,
    JSON.stringify({
      routes: {
        [`/${FEATURE}/`]: { desktop: "ok", mobile: "ok" },
        [`/${LEGACY}/`]: { desktop: "ok", mobile: "ok" },
      },
    }),
  );
  await Deno.writeTextFile(`${scratch}/migrations.json`, "[]");

  const g = async (...args) => {
    const c = new Deno.Command("git", { args, cwd: scratch, stdout: "piped", stderr: "piped" });
    const o = await c.output();
    if (!o.success) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(o.stderr)}`);
    }
    return new TextDecoder().decode(o.stdout);
  };

  await g("init", "-q", "-b", "main");
  await g("config", "user.email", "rtvp@example.test");
  await g("config", "user.name", "rtvp");
  await g("add", ".");
  await g("commit", "-qm", "baseline");
  await g("update-ref", "refs/remotes/origin/main", "HEAD");

  const runGate = async () => {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-net",
        "--allow-env",
        CHECK_CONFORMANCE,
      ],
      cwd: scratch,
      stdout: "piped",
      stderr: "piped",
    });
    const o = await cmd.output();
    return {
      code: o.code,
      text: new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr),
    };
  };

  // Case 1: Clean baseline passes gate and denominator reflects legacy page without IDL
  let r = await runGate();
  assert(
    "rtvp check-conformance Case 1 (clean): clean baseline passes gate",
    r.code === 0 && r.text.includes("PASS"),
    r.text,
  );
  assert(
    "rtvp check-conformance Case 1 (clean denominator): 1 page without IDL surface recorded",
    r.text.includes("1 have no IDL surface"),
    r.text,
  );
  const unchangedNote =
    "[UNCHANGED: fetched baseline == HEAD - committed changes not in scope; uncommitted edits still checked]";
  assert(
    "rtvp check-conformance Case 1: equal fetched baseline qualifies BOTH the suite count and PASS line",
    r.text.split("\n").some((line) =>
      line.includes("baseline suites") && line.includes(unchangedNote)
    ) &&
      r.text.split("\n").some((line) => line.startsWith("PASS —") && line.includes(unchangedNote)),
    r.text,
  );

  // Case 2: Ordinary uncommitted edit to declared surface in working tree fails gate
  const indexPath = `${scratch}/${FEATURE}/index.html`;
  const baseHtml = await Deno.readTextFile(indexPath);
  const mutatedHtml = baseHtml.replace(
    "static undefined stopDiagnosticLogging();",
    "static undefined stopDiagnosticLogging();\n  static undefined rogueDiagnosticLoggingMember();",
  );
  await Deno.writeTextFile(indexPath, mutatedHtml);
  r = await runGate();
  assert(
    "rtvp check-conformance Case 2 (uncommitted): working tree declared surface change fails gate",
    r.code === 1 && r.text.includes('declared surface member "rogueDiagnosticLoggingMember"'),
    r.text,
  );

  // Case 3: Staged edit to declared surface fails gate
  await g("add", `${FEATURE}/index.html`);
  r = await runGate();
  assert(
    "rtvp check-conformance Case 3 (staged): staged declared surface change fails gate",
    r.code === 1 && r.text.includes('declared surface member "rogueDiagnosticLoggingMember"'),
    r.text,
  );

  // Case 4: Staged-then-reverted (git status shows MM) on declared surface check
  // Worktree restored to baseline, but git index carries the rogue declared member
  await Deno.writeTextFile(indexPath, baseHtml);
  const status = await g("status", "--short");
  assert(
    "rtvp check-conformance Case 4: git status shows MM for staged-then-reverted index.html",
    status.includes(`MM ${FEATURE}/index.html`),
    status,
  );
  r = await runGate();
  assert(
    "rtvp check-conformance Case 4 (staged-then-reverted declared surface): gate reads staged index and fails (escape closed)",
    r.code === 1 && r.text.includes('declared surface member "rogueDiagnosticLoggingMember"'),
    r.text,
  );

  // Restore FEATURE to clean baseline
  await g("checkout", "HEAD", "--", `${FEATURE}/index.html`);

  // Case 5: Staged-then-reverted on legacy page noIdlSurface denominator (line 355)
  // Baseline had 1 noIdlSurface. Stage an IDL interface into LEGACY/index.html, but restore working copy.
  const legacyPath = `${scratch}/${LEGACY}/index.html`;
  const legacyBaseHtml = await Deno.readTextFile(legacyPath);
  const legacyMutatedHtml = legacyBaseHtml.replace(
    "<p>Legacy CSS property with no WebIDL interface.</p>",
    `<h2 id="syntax">Syntax</h2><pre><code>interface LegacyIdl { void dummy(); };</code></pre>`,
  );
  await Deno.writeTextFile(legacyPath, legacyMutatedHtml);
  await g("add", `${LEGACY}/index.html`);
  await Deno.writeTextFile(legacyPath, legacyBaseHtml); // restore worktree copy
  const legacyStatus = await g("status", "--short");
  assert(
    "rtvp check-conformance Case 5: git status shows MM for staged-then-reverted legacy index.html",
    legacyStatus.includes(`MM ${LEGACY}/index.html`),
    legacyStatus,
  );
  r = await runGate();
  assert(
    "rtvp check-conformance Case 5 (staged-then-reverted noIdlSurface denominator): denominator reads staged index and drops count to 0",
    r.text.includes("0 have no IDL surface"),
    r.text,
  );

  // Restore LEGACY to clean baseline
  await g("checkout", "HEAD", "--", `${LEGACY}/index.html`);

  // Case 6: Clean resolved passes gate
  r = await runGate();
  assert(
    "rtvp check-conformance Case 6 (resolved): restored clean tree passes gate",
    r.code === 0 && r.text.includes("PASS"),
    r.text,
  );

  // A real committed weakening with a recomputed suiteHash (so hash validation cannot mask the
  // baseline defect). A ref-less ratchet must REFUSE, not report 201 self-compared suites checked.
  // The legacy page has no implementation-sufficient reference contract. Its assertion-only
  // mutation exercises the immutability gate without scheduling a browser visibility check.
  const suitePath = `${scratch}/${LEGACY}/conformance.json`;
  const weakened = JSON.parse(await Deno.readTextFile(suitePath));
  const removedId = weakened.assertions.shift().id;
  weakened.suiteHash = await suiteHash(weakened.assertions);
  await Deno.writeTextFile(suitePath, JSON.stringify(weakened, null, 2) + "\n");
  await g("add", `${LEGACY}/conformance.json`);
  await g("commit", "-qm", "fixture-only committed assertion removal");
  r = await runGate();
  assert(
    "rtvp check-conformance Case 7: independent baseline detects committed assertion removal",
    r.code === 1 && r.text.includes(`assertion "${removedId}" was REMOVED`) &&
      !r.text.includes(unchangedNote),
    r.text,
  );
  await g("update-ref", "-d", "refs/remotes/origin/main");
  r = await runGate();
  assert(
    "rtvp check-conformance Case 8: missing baseline is PRECONDITION rc6, never weakening rc1 or PASS",
    r.code === 6 && r.text.includes("cannot verify immutable assertion weakening") &&
      r.text.includes("refs/remotes/origin/main") &&
      r.text.includes("run git fetch origin main") && !r.text.includes("PASS —") &&
      !r.text.includes("baseline suites"),
    r.text,
  );

  // The independent baseline has two published pages and suites. Erasing every working
  // page AND suite used to print 0/0 and PASS; it must now fail with the real prior floor.
  await g("update-ref", "refs/remotes/origin/main", "HEAD~1");
  await Deno.remove(`${scratch}/v150`, { recursive: true });
  await Deno.remove(`${scratch}/v999`, { recursive: true });
  r = await runGate();
  assert(
    "rtvp check-conformance Case 9: zero pages and zero suites vs independent catalogue is rc1, never PASS",
    r.code === 1 && r.text.includes("published corpus empty: 0 pages and 0 suites") &&
      r.text.includes("independent baseline 2 pages and 2 suites") && !r.text.includes("PASS —"),
    r.text,
  );
  await g("reset", "--hard", "refs/remotes/origin/main");
  r = await runGate();
  assert(
    "rtvp check-conformance Case 10: restored non-empty catalogue still passes",
    r.code === 0 && r.text.includes("conformance suites : 2/2 published pages") &&
      r.text.includes("PASS —"),
    r.text,
  );

  // gendn-1bin: one lost owner previously made 1/1 PASS, because DirEntry
  // reports a symlink as !isDirectory and the empty-corpus floor still had v999.
  await Deno.remove(`${scratch}/${FEATURE}`, { recursive: true });
  await Deno.symlink("missing-feature", `${scratch}/${FEATURE}`);
  r = await runGate();
  assert(
    "1bin dangling release MEMBER is a named rc1, never a partial 1/1 PASS",
    r.code === 1 && r.text.includes(FEATURE) && r.text.includes("symlink component") &&
      !r.text.includes("PASS —"),
    r.text,
  );
  await Deno.remove(`${scratch}/${FEATURE}`);
  await g("reset", "--hard", "HEAD");

  const emptyOutside = await Deno.makeTempDir({ prefix: "1bin-outside-empty-" });
  try {
    await Deno.remove(`${scratch}/${FEATURE}`, { recursive: true });
    await Deno.symlink(emptyOutside, `${scratch}/${FEATURE}`);
    r = await runGate();
    assert(
      "1bin release MEMBER symlink to a real empty outside directory fails proactively",
      r.code === 1 && r.text.includes(FEATURE) && r.text.includes("symlink component") &&
        !r.text.includes("PASS —"),
      r.text,
    );
  } finally {
    await Deno.remove(`${scratch}/${FEATURE}`);
    await Deno.remove(emptyOutside, { recursive: true });
    await g("reset", "--hard", "HEAD");
  }

  await Deno.remove(`${scratch}/v150`, { recursive: true });
  await Deno.symlink("missing-milestone", `${scratch}/v150`);
  r = await runGate();
  assert(
    "1bin dangling MILESTONE is a named rc1 while legacy corpus remains non-empty",
    r.code === 1 && r.text.includes("symlink component v150") &&
      !r.text.includes("PASS —"),
    r.text,
  );
  await Deno.remove(`${scratch}/v150`);
  await g("reset", "--hard", "HEAD");

  const suiteCopy = await Deno.makeTempFile({ prefix: "1bin-real-suite-" });
  try {
    await Deno.copyFile(`${scratch}/${LEGACY}/conformance.json`, suiteCopy);
    await Deno.remove(`${scratch}/${LEGACY}/conformance.json`);
    await Deno.symlink(suiteCopy, `${scratch}/${LEGACY}/conformance.json`);
    r = await runGate();
    assert(
      "1bin readable external suite symlink is a named rc1, not counted as inspected",
      r.code === 1 && r.text.includes(`${LEGACY}/conformance.json`) &&
        r.text.includes("symlink component") && !r.text.includes("PASS —"),
      r.text,
    );
  } finally {
    await Deno.remove(`${scratch}/${LEGACY}/conformance.json`);
    await Deno.remove(suiteCopy);
    await g("reset", "--hard", "HEAD");
  }

  // A genuinely absent page remains the route regression gate's responsibility.
  await g("rm", `${FEATURE}/index.html`);
  r = await runGate();
  assert(
    "1bin genuinely deleted page still defers to check-routes with remaining 1/1 corpus",
    r.code === 0 && r.text.includes("conformance suites : 1/1 published pages") &&
      r.text.includes("PASS —"),
    r.text,
  );
  await g("reset", "--hard", "HEAD");
  r = await runGate();
  assert(
    "1bin restored ordinary 2/2 corpus still passes",
    r.code === 0 && r.text.includes("conformance suites : 2/2 published pages") &&
      r.text.includes("PASS —"),
    r.text,
  );
} finally {
  await Deno.remove(scratch, { recursive: true });
}

if (failures) {
  console.error(`check-conformance fixture: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log("check-conformance fixture: all assertions passed");
