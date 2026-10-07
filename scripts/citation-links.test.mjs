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

await Deno.remove(dir, { recursive: true });
console.log(`citation-links fixture: all ${n} assertions passed`);
