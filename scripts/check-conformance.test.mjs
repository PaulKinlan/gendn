// scripts/check-conformance.test.mjs — staged-then-reverted declared-surface checks in check-conformance (gendn-rtvp).
//
// When an HTML surface change is staged and the working tree is reverted to baseline (git status MM),
// check-conformance.mjs must read the staged index content via readJudgedFile rather than disk
// with Deno.readTextFile, closing the escape window for declared-surface checks (line 269) and
// the noIdlSurface denominator check (line 355).

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
        suiteHash: "mock",
        generatedAt: "2026-10-08T00:00:00Z",
        author: "rtvp fixture",
        assertions: [],
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
} finally {
  await Deno.remove(scratch, { recursive: true });
}

if (failures) {
  console.error(`check-conformance fixture: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log("check-conformance fixture: all assertions passed");
