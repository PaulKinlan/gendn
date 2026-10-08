// scripts/citation-links.test.mjs — fixture for the unlinked-citation ratchet (gendn-t7h).
//
// WHAT MUST NOT REGRESS:
//   1. detection precision — linked labels pass, unlinked citation spans fail, prose
//      "Source:" labels fail ONLY when source-like and unlinked, and code/pre blocks
//      plus token-less prose uses of the word never fail (false-positive-shy is the
//      design constraint; a detector that flags <pre> samples or plain prose would
//      red the tree on noise);
//   2. the id-shape companion — a 12-digit chromestatus id fails, 16-digit passes
//      (the B1 truncation bug class that every other gate missed);
//   3. THE RATCHET GATE ITSELF, end-to-end in a scratch git repo: an unlinked label
//      on a page the diff does NOT touch is invisible to the check (coord's
//      non-negotiable: pre-existing corpus debt must not red the tree), and the
//      SAME label fails the moment the diff touches that page — including a touch
//      that is unrelated to the label (AGENTS.md:103 is resolve-on-touch, not
//      resolve-when-convenient). A ratchet implemented as "only NEW labels fail"
//      (diff of label sets instead of page gating) is killed by the third case:
//      it would pass a touched page that retains its pre-existing label.

import {
  changedPageIds,
  detectCsIdShapes,
  detectUnlinkedLabels,
  mapPool,
  PAGE_CONCURRENCY,
  runRatchet,
  scanIdShapes,
} from "./check-citation-links.mjs";

let n = 0;
function ok(cond, name) {
  n++;
  if (!cond) {
    console.log(`ASSERTION FAILED: ${name}`);
    Deno.exit(1);
  }
}

// --- 1. detection precision -------------------------------------------------
const linked =
  `<p>x</p><span class="citation">Source: <a href="https://example.org/a">A</a>, 2026.</span>`;
ok(detectUnlinkedLabels(linked).length === 0, "linked citation span is clean");

const unlinked = `<p>x</p><span class="citation">Source: Example Org report, 2026.</span>`;
const u1 = detectUnlinkedLabels(unlinked);
ok(u1.length === 1 && u1[0].kind === "citation-span", "unlinked citation span flagged once");

const proseLinked =
  `<p>Source: <a href="https://example.org/b">the Example Org report</a> says so.</p>`;
ok(detectUnlinkedLabels(proseLinked).length === 0, "prose Source: with immediate link is clean");

const proseUnlinked = `<p>Source: example.org/report-2026 (accessed March).</p>`;
const u2 = detectUnlinkedLabels(proseUnlinked);
ok(u2.length === 1 && u2[0].kind === "prose-source", "unlinked prose Source: with domain flagged");

const proseTokenless = `<p>Source: the above example, extended below.</p>`;
ok(detectUnlinkedLabels(proseTokenless).length === 0, "token-less prose Source: not flagged");

const inPre = `<pre>Source: example.org/not-a-label — command output</pre>`;
ok(detectUnlinkedLabels(inPre).length === 0, "Source: inside pre block not flagged");

const inCode = `<code>Source: example.org/not-a-label</code>`;
ok(detectUnlinkedLabels(inCode).length === 0, "Source: inside code block not flagged");

const spanInsideCountsOnce = `<span class="citation">Source: example.org/x</span>`;
ok(
  detectUnlinkedLabels(spanInsideCountsOnce).length === 1,
  "span label not double-counted by prose pass",
);

const pTag = `<p class="citation">Source: example.org/x (corpus has non-span citation tags)</p>`;
ok(detectUnlinkedLabels(pTag).length === 1, "non-span citation tag (p.citation) flagged too");

// --- 2. id-shape companion --------------------------------------------------
ok(
  detectCsIdShapes(`<a href="https://chromestatus.com/feature/5109852273377280">x</a>`).length ===
    0,
  "16-digit id clean",
);
const trunc = detectCsIdShapes(`<a href="https://chromestatus.com/feature/510985227337">x</a>`);
ok(trunc.length === 1 && trunc[0].len === 12, "12-digit id flagged");

// --- 3. changed-page filtering ----------------------------------------------
ok(
  JSON.stringify(
    changedPageIds([
      "v147/foo/index.html",
      "v147/foo/conformance.json",
      "v147/foo/member/index.html",
      "server.ts",
      "deno.json",
      "v148/bar/other.html",
    ]).sort(),
  ) ===
    JSON.stringify(["v147/foo", "v148/bar"]),
  "changedPageIds maps any file in a page tree (members included) to the page id, ignores non-page files",
);

// --- 3b. mapPool concurrency & ordering contract ---------------------------
ok(PAGE_CONCURRENCY === 8, "PAGE_CONCURRENCY is calibrated to 8");

// Empty items returns empty array
const emptyRes = await mapPool([], 8, async () => 1);
ok(Array.isArray(emptyRes) && emptyRes.length === 0, "mapPool handles empty items");

// Ordering preservation even when items resolve out-of-order
const delays = [50, 10, 30, 5, 20, 40, 15, 25];
let active = 0;
let maxActive = 0;
const poolRes = await mapPool(delays, 3, async (ms, idx) => {
  active++;
  maxActive = Math.max(maxActive, active);
  await new Promise((resolve) => setTimeout(resolve, ms));
  active--;
  return { idx, ms };
});
ok(maxActive <= 3, "mapPool strictly obeys concurrency limit");
ok(
  poolRes.every((item, i) => item.idx === i && item.ms === delays[i]),
  "mapPool returns results in exact input order regardless of resolution order",
);

// --- 4. ratchet end-to-end in a scratch repo --------------------------------
const dir = await Deno.makeTempDir({ prefix: "t7h-" });
async function g(...args) {
  const cmd = new Deno.Command("git", { args, cwd: dir, stdout: "null", stderr: "null" });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}
const PAGE_A = "v147/legacy-page/index.html";
const PAGE_B = "v148/touched-page/index.html";
const unlinkedPage = (title) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>body</p><span class="citation">Source: Example Org report, 2026.</span></body></html>`;
const cleanPage =
  `<!doctype html><html><head><title>b</title></head><body><p>body</p><span class="citation">Source: <a href="https://example.org/b">B</a></span></body></html>`;
await Deno.mkdir(`${dir}/v147/legacy-page`, { recursive: true });
await Deno.mkdir(`${dir}/v148/touched-page`, { recursive: true });
await Deno.writeTextFile(`${dir}/${PAGE_A}`, unlinkedPage("a"));
await Deno.writeTextFile(`${dir}/${PAGE_B}`, cleanPage);
await g("init", "-q", "-b", "main");
await g("config", "user.email", "t@t");
await g("config", "user.name", "t");
await g("add", ".");
await g("commit", "-qm", "base");
// simulate origin/main at the base commit
await g("update-ref", "refs/remotes/origin/main", "HEAD");

// case 4a: diff touches only the CLEAN page -> the legacy unlinked label is invisible
await Deno.writeTextFile(`${dir}/${PAGE_B}`, cleanPage.replace("body", "body v2"));
await g("add", ".");
await g("commit", "-qm", "touch B only");
let r = await runRatchet(dir);
ok(r.changed.length === 1 && r.changed[0] === "v148/touched-page", "4a changed set is B only");
ok(
  r.failures.length === 0,
  "4a untouched page's pre-existing unlinked label does not red the tree",
);

// case 4b: diff touches the legacy page UNRELATED to the label -> it must fail
await Deno.writeTextFile(`${dir}/${PAGE_A}`, unlinkedPage("a").replace("body", "body edited"));
let r4bPre = await runRatchet(dir);
ok(
  r4bPre.failures.length === 1 && r4bPre.failures[0].includes("v147/legacy-page"),
  "4b uncommitted edit to legacy page fails before commit (resolve-on-touch)",
);
await g("add", ".");
let r4bStaged = await runRatchet(dir);
ok(
  r4bStaged.failures.length === 1 && r4bStaged.failures[0].includes("v147/legacy-page"),
  "4b staged edit to legacy page fails before commit",
);

// gendn-waa3: staged-then-worktree-reverted (git status shows MM) must not escape.
// Overwrite working file back to base content: base -> working tree diff is empty,
// but the index holds the change, so union of git diff --cached keeps it in the key.
await Deno.writeTextFile(`${dir}/${PAGE_A}`, unlinkedPage("a"));
const statusShort4b = new TextDecoder().decode(
  (await (new Deno.Command("git", { args: ["status", "--short"], cwd: dir, stdout: "piped" }))
    .output()).stdout,
).trim();
ok(
  statusShort4b.includes("MM") && statusShort4b.includes(PAGE_A),
  "4b git status shows MM for staged-then-reverted file",
);
let r4bReverted = await runRatchet(dir);
ok(
  r4bReverted.changed.includes("v147/legacy-page"),
  "4b staged-then-reverted edit is included in changed pages via cached diff (gendn-waa3)",
);
ok(
  r4bReverted.failures.length === 1 && r4bReverted.failures[0].includes("v147/legacy-page"),
  "4b staged-then-reverted page retaining its legacy label FAILS the ratchet (escape closed)",
);

// Restore the edit in working tree before commit so the committed control runs as before
await Deno.writeTextFile(`${dir}/${PAGE_A}`, unlinkedPage("a").replace("body", "body edited"));
await g("commit", "-qm", "touch A unrelated to label");
r = await runRatchet(dir);
ok(r.changed.includes("v147/legacy-page"), "4b changed set includes A");
ok(
  r.failures.length === 1 && r.failures[0].includes("v147/legacy-page"),
  "4b touched page retaining its pre-existing label FAILS (resolve-on-touch)",
);

// case 4c: resolving the label on the touched page makes it pass again
await Deno.writeTextFile(
  `${dir}/${PAGE_A}`,
  unlinkedPage("a").replace(
    "Example Org report, 2026.",
    '<a href="https://example.org/r">Example Org report</a>, 2026.',
  ),
);
let r4cPre = await runRatchet(dir);
ok(r4cPre.failures.length === 0, "4c uncommitted resolution of label passes before commit");
await g("add", ".");
await g("commit", "-qm", "resolve A label");
r = await runRatchet(dir);
ok(r.failures.length === 0, "4c linked label on touched page passes");

// case 4d: member routes are gated too (the round-1 P1 bypass)
const MEMBER = "v147/legacy-page/member/index.html";
await Deno.mkdir(`${dir}/v147/legacy-page/member`, { recursive: true });
await Deno.writeTextFile(`${dir}/${MEMBER}`, unlinkedPage("m"));
await g("add", ".");
await g("commit", "-qm", "add member with unlinked label");
r = await runRatchet(dir);
ok(
  r.failures.length === 1 && r.failures[0].includes("member"),
  "4d member page with unlinked label fails when its own file is in the diff",
);

// case 4e: touching ONLY a member file also inspects the whole page tree (no bypass
// by splitting a touch across the tree); parent is clean here so still one failure
await Deno.writeTextFile(`${dir}/${MEMBER}`, unlinkedPage("m").replace("body", "body v2"));
await g("add", ".");
await g("commit", "-qm", "touch member only");
r = await runRatchet(dir);
ok(
  r.changed.includes("v147/legacy-page") && r.changed.includes("v148/touched-page"),
  "4e member-only commit maps to the page id (branch diff base..HEAD, both touched pages listed)",
);
ok(
  r.failures.length === 1 && r.failures[0].includes("member"),
  "4e member-only touch still gated (parent clean, member unlinked)",
);

// case 4f: untracked new pages count as changed (ls-files --others)
await Deno.mkdir(`${dir}/v149/fresh-page`, { recursive: true });
await Deno.writeTextFile(`${dir}/v149/fresh-page/index.html`, unlinkedPage("f"));
r = await runRatchet(dir);
ok(
  r.changed.includes("v149/fresh-page") && r.failures.some((f) => f.includes("v149/fresh-page")),
  "4f untracked new page with unlinked label fails",
);
await Deno.remove(`${dir}/v149`, { recursive: true });

// case 4g: id-shape scan is recursive into member trees
await Deno.writeTextFile(
  `${dir}/${MEMBER}`,
  unlinkedPage("m").replace("Example Org report, 2026.", '<a href="https://example.org/r">r</a>') +
    '<a href="https://chromestatus.com/feature/510985227337">t</a>',
);
const shapes = await scanIdShapes(dir);
ok(
  shapes.failures.length === 1 && shapes.failures[0].includes("member"),
  "4g truncated id in a member page detected by the recursive scan",
);

// case 4h: without an independent origin/main ref the ratchet must refuse, not compare HEAD
// to itself. A warning on a successful exit would still hide committed violations.
await g("update-ref", "-d", "refs/remotes/origin/main");
r = await runRatchet(dir);
ok(
  r.error?.includes("cannot verify committed citation-label changes") &&
    r.error.includes("refs/remotes/origin/main"),
  "4h missing origin/main ref explicitly refuses to verify citation changes",
);

await Deno.remove(dir, { recursive: true });

// case 4i: multi-page diff with nested types/*, deleted page, untracked page
// ensures bounded parallel walk preserves exact deterministic input-order failures
const dir4i = await Deno.makeTempDir({ prefix: "t7h-multi-" });
async function g4i(...args) {
  const cmd = new Deno.Command("git", { args, cwd: dir4i, stdout: "null", stderr: "null" });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}
await g4i("init", "-q", "-b", "main");
await g4i("config", "user.email", "t@t");
await g4i("config", "user.name", "t");

const cleanDoc = (title) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>body</p><span class="citation">Source: <a href="https://example.org/${title}">link</a></span></body></html>`;

// Create 10 base pages
for (let i = 0; i < 10; i++) {
  const pad = String(i).padStart(2, "0");
  await Deno.mkdir(`${dir4i}/v150/page-${pad}`, { recursive: true });
  await Deno.writeTextFile(`${dir4i}/v150/page-${pad}/index.html`, cleanDoc(`p-${pad}`));
}
// Nested types page
await Deno.mkdir(`${dir4i}/v150/page-nested/types/sub`, { recursive: true });
await Deno.writeTextFile(`${dir4i}/v150/page-nested/index.html`, cleanDoc("nested-root"));
await Deno.writeTextFile(`${dir4i}/v150/page-nested/types/sub/index.html`, cleanDoc("nested-sub"));

// Page to delete
await Deno.mkdir(`${dir4i}/v150/page-to-delete`, { recursive: true });
await Deno.writeTextFile(`${dir4i}/v150/page-to-delete/index.html`, cleanDoc("to-delete"));

await g4i("add", ".");
await g4i("commit", "-qm", "base commit");
await g4i("update-ref", "refs/remotes/origin/main", "HEAD");

// Introduce diff:
// Touch several pages with unlinked citations
for (let i = 0; i < 10; i++) {
  const pad = String(i).padStart(2, "0");
  if (i % 2 === 0) {
    await Deno.writeTextFile(
      `${dir4i}/v150/page-${pad}/index.html`,
      unlinkedPage(`p-${pad}`).replace("Example Org report, 2026.", `Report for ${pad}`),
    );
  } else {
    await Deno.writeTextFile(
      `${dir4i}/v150/page-${pad}/index.html`,
      cleanDoc(`p-${pad}-v2`),
    );
  }
}
// Touch nested types child with an unlinked citation
await Deno.writeTextFile(
  `${dir4i}/v150/page-nested/types/sub/index.html`,
  unlinkedPage("nested-sub").replace("Example Org report, 2026.", "Nested report 2026"),
);
// Delete page-to-delete
await g4i("rm", "-r", "v150/page-to-delete");
await g4i("add", "v150/page-*");
await g4i("commit", "-qm", "modify pages and delete one");

// Untracked new page with unlinked citation
await Deno.mkdir(`${dir4i}/v150/page-untracked`, { recursive: true });
await Deno.writeTextFile(
  `${dir4i}/v150/page-untracked/index.html`,
  unlinkedPage("untracked").replace("Example Org report, 2026.", "Untracked report 2026"),
);

r = await runRatchet(dir4i);
ok(!r.error, "4i multi-page runRatchet executes cleanly");
ok(r.changed.length >= 12, "4i all changed pages identified");
ok(
  r.failures.length === 7,
  "4i exactly 7 expected failures detected across parallel walks",
);

// Verify failure order matches changed page id order (input order preservation)
const failurePageIds = r.failures.map((f) => f.match(/^(v\d+\/[^/]+)\//)[1]);
let lastChangedIndex = -1;
let inOrder = true;
for (const fId of failurePageIds) {
  const idx = r.changed.indexOf(fId);
  if (idx < lastChangedIndex) {
    inOrder = false;
    break;
  }
  lastChangedIndex = idx;
}
ok(inOrder, "4i failure report order is strictly monotonic with respect to changedPageIds order");

// Verify deleted page is not present in failures and caused no throw
ok(
  r.failures.every((f) => !f.includes("page-to-delete")),
  "4i deleted page handled gracefully with empty failure list",
);

// Verify nested type was detected
ok(
  r.failures.some((f) => f.includes("v150/page-nested/types/sub/index.html")),
  "4i nested types route failure detected and reported under parent page id",
);

await Deno.remove(dir4i, { recursive: true });

// case 4j: gendn-u3i9 — uncommitted tracked page edit is gated before commit
const dir4j = await Deno.makeTempDir({ prefix: "u3i9-uncommitted-" });
async function g4j(...args) {
  const cmd = new Deno.Command("git", { args, cwd: dir4j, stdout: "null", stderr: "null" });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}
await g4j("init", "-q", "-b", "main");
await g4j("config", "user.email", "t@t");
await g4j("config", "user.name", "t");

const TRACKED_PAGE = "v150/focusgroup/index.html";
await Deno.mkdir(`${dir4j}/v150/focusgroup`, { recursive: true });
await Deno.writeTextFile(`${dir4j}/${TRACKED_PAGE}`, cleanDoc("focusgroup"));
await g4j("add", ".");
await g4j("commit", "-qm", "clean baseline");
await g4j("update-ref", "refs/remotes/origin/main", "HEAD");

// Initial state: clean baseline, zero changed pages, zero failures
let r4j = await runRatchet(dir4j);
ok(r4j.changed.length === 0 && r4j.failures.length === 0, "4j initial ratchet is clean");

// Working tree mutation ONLY (tracked file, uncommitted, not staged)
await Deno.writeTextFile(
  `${dir4j}/${TRACKED_PAGE}`,
  cleanDoc("focusgroup") + '\n<span class="citation">Source: Unlinked Test Citation 2026.</span>',
);

r4j = await runRatchet(dir4j);
ok(
  r4j.changed.includes("v150/focusgroup"),
  "4j uncommitted tracked page edit is included in changed pages before commit",
);
ok(
  r4j.failures.length === 1 && r4j.failures[0].includes("v150/focusgroup") &&
    r4j.failures[0].includes("Source: Unlinked Test Citation 2026."),
  "4j uncommitted tracked page edit FAILS the ratchet before commit (gap closed)",
);

// Staged but uncommitted mutation (git add without git commit)
await g4j("add", TRACKED_PAGE);
r4j = await runRatchet(dir4j);
ok(
  r4j.failures.length === 1 && r4j.failures[0].includes("v150/focusgroup"),
  "4j staged uncommitted tracked page edit FAILS the ratchet before commit",
);

// gendn-waa3: staged-then-reverted edit is included in changed pages via cached diff
await Deno.writeTextFile(`${dir4j}/${TRACKED_PAGE}`, cleanDoc("focusgroup"));
let r4jReverted = await runRatchet(dir4j);
ok(
  r4jReverted.changed.includes("v150/focusgroup"),
  "4j staged-then-reverted tracked page edit is included in changed pages via cached diff (gendn-waa3)",
);
// Restore unlinked citation before committed control
await Deno.writeTextFile(
  `${dir4j}/${TRACKED_PAGE}`,
  cleanDoc("focusgroup") + '\n<span class="citation">Source: Unlinked Test Citation 2026.</span>',
);

// Committed control: committing the same edit still fails
await g4j("commit", "-qm", "commit unlinked citation");
r4j = await runRatchet(dir4j);
ok(
  !r4j.vacuous && r4j.failures.length === 1 && r4j.failures[0].includes("v150/focusgroup"),
  "4j committed control still fails (committed behavior preserved)",
);

// Uncommitted clean resolution: resolving the citation in working tree clears failure
await Deno.writeTextFile(
  `${dir4j}/${TRACKED_PAGE}`,
  cleanDoc("focusgroup") +
    '\n<span class="citation">Source: <a href="https://example.org/resolved">Resolved</a></span>',
);
r4j = await runRatchet(dir4j);
ok(
  r4j.failures.length === 0,
  "4j uncommitted resolution of citation in working tree passes before commit",
);

// Committed clean resolution
await g4j("add", TRACKED_PAGE);
await g4j("commit", "-qm", "resolve citation");
r4j = await runRatchet(dir4j);
ok(r4j.failures.length === 0, "4j committed resolution passes");

// CLI controls use a real committed bad page in this isolated repo. They pin the exit and
// diagnostic, not only runRatchet's return shape; neither case needs Chrome or network.
const runCitationGate = async (all = false) => {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-run",
      new URL("./check-citation-links.mjs", import.meta.url).pathname,
      ...(all ? ["--all"] : []),
    ],
    cwd: dir4j,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    text: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
  };
};
await g4j("update-ref", "refs/remotes/origin/main", "HEAD");
const unchangedNote4j =
  "[UNCHANGED: fetched baseline == HEAD - committed changes not in scope; uncommitted edits still checked]";
let cli4j = await runCitationGate();
ok(
  cli4j.code === 0 &&
    cli4j.text.split("\n").some((line) =>
      line.startsWith("citation-links ratchet:") && line.includes(unchangedNote4j)
    ) &&
    cli4j.text.split("\n").some((line) =>
      line.startsWith("PASS —") && line.includes(unchangedNote4j)
    ),
  "4j equal fetched baseline qualifies BOTH citation count and PASS line",
);
await Deno.writeTextFile(
  `${dir4j}/${TRACKED_PAGE}`,
  cleanDoc("focusgroup") + '\n<span class="citation">Source: Unlinked Test Citation 2026.</span>',
);
await g4j("add", TRACKED_PAGE);
await g4j("commit", "-qm", "fixture-only committed unlinked citation");
cli4j = await runCitationGate();
ok(
  cli4j.code === 1 && cli4j.text.includes("unlinked citation label") &&
    cli4j.text.includes("Source: Unlinked Test Citation 2026.") &&
    !cli4j.text.includes(unchangedNote4j),
  "4j independent baseline detects committed unlinked citation (CLI rc1)",
);
await g4j("update-ref", "-d", "refs/remotes/origin/main");
cli4j = await runCitationGate();
ok(
  cli4j.code === 6 && cli4j.text.includes("cannot verify committed citation-label changes") &&
    cli4j.text.includes("refs/remotes/origin/main") &&
    cli4j.text.includes("run git fetch origin main") && !cli4j.text.includes("PASS —"),
  "4j missing independent baseline is PRECONDITION rc6, not violation rc1 or PASS",
);

// A published page in the fetched catalogue cannot be replaced by zero scanned pages.
await g4j("update-ref", "refs/remotes/origin/main", "HEAD~1");
await Deno.remove(`${dir4j}/v150`, { recursive: true });
cli4j = await runCitationGate();
ok(
  cli4j.code === 1 && cli4j.text.includes("published page corpus empty") &&
    cli4j.text.includes(
      "0 scanned index.html pages vs 1 independently published origin/main pages (difference 1)",
    ) &&
    !cli4j.text.includes("PASS —"),
  "4k erased published page fails against independent floor (CLI rc1, no PASS)",
);
const emptyReport4k = await runCitationGate(true);
ok(
  emptyReport4k.code === 1 && emptyReport4k.text.includes("empty published page corpus") &&
    !emptyReport4k.text.includes("PASS —"),
  "4k report mode also refuses an empty page corpus (CLI rc1)",
);
await g4j("reset", "--hard", "refs/remotes/origin/main");
cli4j = await runCitationGate();
ok(
  cli4j.code === 0 && cli4j.text.includes("pages scanned for id shape 1") &&
    cli4j.text.includes("PASS —"),
  "4k restored valid non-empty catalogue passes (CLI rc0)",
);
const nonemptyReport4k = await runCitationGate(true);
ok(
  nonemptyReport4k.code === 0 && nonemptyReport4k.text.includes("1 pages scanned") &&
    nonemptyReport4k.text.includes("PASS —"),
  "4k report mode still passes a valid non-empty corpus",
);

// A broken link to a touched index.html is unreadable even though the directory remains.
await Deno.remove(`${dir4j}/${TRACKED_PAGE}`);
await Deno.symlink("missing-page.html", `${dir4j}/${TRACKED_PAGE}`);
cli4j = await runCitationGate();
ok(
  cli4j.code === 1 && cli4j.text.includes(TRACKED_PAGE) &&
    cli4j.text.includes("cannot read touched page") && !cli4j.text.includes("PASS —"),
  "4l unreadable touched page names path and read failure (CLI rc1, no PASS)",
);
await g4j("reset", "--hard", "HEAD");
cli4j = await runCitationGate();
ok(cli4j.code === 0 && cli4j.text.includes("PASS —"), "4l readable page restoration passes");

// A dangling symlink for the whole touched directory yields NotFound from readDir,
// but lstat proves the owner path exists and must not be treated as a deleted route.
await Deno.remove(`${dir4j}/v150/focusgroup`, { recursive: true });
await Deno.symlink("missing-dir", `${dir4j}/v150/focusgroup`);
cli4j = await runCitationGate();
ok(
  cli4j.code === 1 && cli4j.text.includes("v150/focusgroup") &&
    cli4j.text.includes("cannot inspect touched page") && !cli4j.text.includes("PASS —"),
  "4l dangling touched DIRECTORY is a named hard failure (CLI rc1, no PASS)",
);
await Deno.remove(`${dir4j}/v150/focusgroup`);
await g4j("reset", "--hard", "HEAD");
cli4j = await runCitationGate();
ok(cli4j.code === 0 && cli4j.text.includes("PASS —"), "4l readable directory restoration passes");

// When the fetched ref is ahead of HEAD, merge-base == HEAD does NOT mean fetched == HEAD.
await g4j("commit", "--allow-empty", "-qm", "fixture fetched-ahead ref");
await g4j("update-ref", "refs/remotes/origin/main", "HEAD");
await g4j("reset", "--hard", "HEAD~1");
cli4j = await runCitationGate();
r4j = await runRatchet(dir4j);
ok(
  cli4j.code === 0 && r4j.vacuous === false &&
    !cli4j.text.includes(unchangedNote4j) && cli4j.text.includes("PASS —"),
  "4m fetched ref ahead of HEAD is not falsely labelled UNCHANGED",
);

await Deno.remove(dir4j, { recursive: true });

console.log(`citation-links fixture: all ${n} assertions passed`);
