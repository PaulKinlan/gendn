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
await g("add", ".");
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

// case 4h: with no origin/main ref the baseline falls back to HEAD and the
// ratchet reports itself vacuous instead of passing silently (round-2 P2)
await g("update-ref", "-d", "refs/remotes/origin/main");
r = await runRatchet(dir);
ok(r.vacuous === true, "4h missing origin/main ref yields vacuous=true for the CLI to warn about");

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
console.log(`citation-links fixture: all ${n} assertions passed`);
