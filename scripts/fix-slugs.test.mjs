// scripts/fix-slugs.test.mjs — scratch-catalogue coverage for the DESTRUCTIVE maintenance
// script .claude/fix-slugs.py (gendn-9ec).
//
// THE GAP: fix-slugs.py renames and DELETES published-page folders (rmtree on: no chromestatus
// ID, ID not listed under the milestone, canonical-target collision) based on a live
// chromestatus listing fetch. Nothing exercised it: a divergence between its slugify and the
// listing, or a widened delete condition, could erase durable routes — the repo's costliest
// asset — with no test failing.
//
// SHAPE: this fixture NEVER runs the script against the worktree. A python3 harness loads
// .claude/fix-slugs.py via importlib (the __main__ guard keeps import side-effect-free),
// MONKEYPATCHES get_json with canned listing data, and patches urllib.request.urlopen to RAISE
// — so any code path that tries the real network fails the test (the deno task also carries no
// --allow-net). cleanup() then runs over a synthesized TEMP catalogue covering every summary
// bucket; the deno side asserts the summary JSON, the resulting filesystem, and CONSERVATION:
// the real catalogue's v-dir/slug listings are byte-identical before and after.
//
// Cross-language slugify parity (incl. the known U+20D0 divergence) is already pinned by
// test-chromestatus-units (gendn-14o) and is NOT duplicated here; this fixture pins only the
// python-side boundaries that drive renames/deletes and the destructive-path behaviour.
//
// MUTATION PROOFS (logs on the bead, not inline): (1) removing the seed-skip makes the seed
// assertion FAIL; (2) deleting the parent milestone dir instead of the folder on no-id makes
// the sibling/conservation assertions FAIL; (3) removing the TARGET instead of the source on a
// collision makes the intact-target assertion FAIL. Each restored to green with an empty
// script diff. A suite that has never been shown to fail on a plausible wrong implementation
// is a claim, not a detector.
//
// Run: deno task test-fix-slugs

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SCRIPT = `${REPO}/.claude/fix-slugs.py`;

let failures = 0;
let passed = 0;
function assert(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS: ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// ---------- snapshot the REAL catalogue for the conservation check ------------------------
async function catalogueSnapshot(root) {
  const out = [];
  for await (const rel of await Deno.readDir(root)) {
    if (!rel.isDirectory || !/^v\d+$/.test(rel.name)) continue;
    const slugs = [];
    for await (const s of await Deno.readDir(`${root}/${rel.name}`)) {
      if (s.isDirectory) slugs.push(s.name);
    }
    out.push(`${rel.name}:${slugs.sort().join(",")}`);
  }
  return out.sort().join("|");
}
const before = await catalogueSnapshot(REPO);

// ---------- build the temp catalogue -------------------------------------------------------
const tmp = await Deno.makeTempDir({ prefix: "fix-slugs-test-" });
async function mkPage(rel, html) {
  const dir = `${tmp}/${rel}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/index.html`, html);
}
const link = (id) => `<p><a href="https://chromestatus.com/feature/${id}">cs</a></p>`;

// kept: ID 111 listed under milestone 900 as "Alpha Thing" -> slugify == folder name
await mkPage("v900/alpha-thing", `<h1>Alpha Thing</h1>${link(111)}`);
// renamed: ID 222 listed as "Beta: Renamed!" -> canonical "beta-renamed" != folder "old-name"
await mkPage("v900/old-name", `<h1>Beta</h1>${link(222)}`);
// deleted_no_id: no chromestatus link at all
await mkPage("v900/no-id", `<h1>Who Am I</h1>`);
// deleted_orphan: ID 333 is NOT in the canned listing for milestone 900
await mkPage("v900/ghost", `<h1>Ghost</h1>${link(333)}`);
// deleted_overwritten: ID 444 -> canonical "dup-target", which ALREADY EXISTS; source must die,
// target must survive with its ORIGINAL content
await mkPage("v900/dup-target", `<h1>Dup Target</h1>${link(999)}`); // 999 unlisted? NO - keep target via listing
await mkPage("v900/weird-name", `<h1>Weird</h1>${link(444)}`);
// seed: ("v149","webmcp") is in SEEDS["gendn"] — must be SKIPPED even though it has no ID
await mkPage("v149/webmcp", `<h1>Seed, no ID</h1>`);
// a v149 non-seed page with no ID — must be deleted (proves the skip is seed-specific)
await mkPage("v149/not-a-seed", `<h1>Delete me</h1>`);
// no index.html: skipped, folder stays
await Deno.mkdir(`${tmp}/v900/no-index`, { recursive: true });
// deep child: cleanup walks exactly two levels — the child must be untouched
await mkPage("v900/alpha-thing/child", `<h1>Deep</h1>`);
// non-v dir: ignored entirely
await mkPage("public/whatever", `<h1>Asset</h1>`);
// stray FILE directly under a milestone dir: ignored (not a dir)
await Deno.writeTextFile(`${tmp}/v900/stray.txt`, "x");

const targetBefore = await Deno.readTextFile(`${tmp}/v900/dup-target/index.html`);

// ---------- python harness: import, trap the network, canned listings, run cleanup ----------
const PY = String.raw`
import importlib.util, io, json, os, sys, urllib.request

MOD_PATH, ROOT = sys.argv[1], sys.argv[2]

# network trap: ANY real urlopen attempt raises (the listing fetch must be fully stubbed)
def _no_net(*a, **k):
    raise RuntimeError("fix-slugs test: real network access attempted")
urllib.request.urlopen = _no_net

spec = importlib.util.spec_from_file_location("fix_slugs", MOD_PATH)
mod = importlib.util.module_from_spec(spec)
_cwd_before = os.getcwd()
spec.loader.exec_module(mod)  # import-time safety: no argv side effects, no chdir, no fetch
import_time_ok = os.getcwd() == _cwd_before

# canned listing data keyed by milestone, served through the module's own get_json seam
LISTINGS = {
    900: {"features_by_type": {"Feature": [
        {"id": 111, "name": "Alpha Thing"},
        {"id": 222, "name": "Beta: Renamed!"},
        {"id": 444, "name": "Dup Target"},
        {"id": 999, "name": "Dup Target"},
    ]}},
    149: {"features_by_type": {}},
}
def fake_get_json(url):
    m = int(url.rsplit("milestone=", 1)[1])
    return LISTINGS.get(m, {"features_by_type": {}})
mod.get_json = fake_get_json

# python-side slugify boundaries that drive renames (parity itself is pinned by
# test-chromestatus-units; these are the shapes cleanup() depends on)
slug_checks = {
    "collapses non-alnum runs": mod.slugify("Beta: Renamed!") == "beta-renamed",
    "nfd drops combining marks": mod.slugify("Caf\u00e9 API") == "cafe-api",
    "truncate to 80": mod.slugify("a" * 95) == "a" * 80,
    "strip-then-truncate can end on a dash (current behaviour, pinned)":
        mod.slugify("a" * 79 + "-" + "b" * 10) == "a" * 79 + "-",
    "empty-ish input": mod.slugify("!!!") == "",
}

summary = mod.cleanup(ROOT, "gendn")
print(json.dumps({
    "import_time_ok": import_time_ok,
    "slug_checks": slug_checks,
    "summary": summary,
}))
`;

let harness;
try {
  const cmd = new Deno.Command("python3", {
    args: ["-c", PY, SCRIPT, tmp],
    stdout: "piped",
    stderr: "piped",
  });
  harness = await cmd.output();
} catch (e) {
  console.error(`FAIL: python harness could not run :: ${e}`);
  Deno.exit(1);
}
const stderrText = new TextDecoder().decode(harness.stderr);
if (harness.code !== 0) {
  console.error(`FAIL: python harness exited ${harness.code}\n--- stderr ---\n${stderrText}`);
  Deno.exit(1);
}
assert(
  "harness never touched the real network (urlopen trap armed; no fetch-failure stderr)",
  !stderrText.includes("could not fetch") && !stderrText.includes("real network access"),
  stderrText.slice(0, 200),
);
// cleanup() prints progress lines to stdout; the harness JSON is its LAST line
const stdoutText = new TextDecoder().decode(harness.stdout);
const jsonLine = stdoutText.trimEnd().split("\n").pop();
let out;
try {
  out = JSON.parse(jsonLine);
} catch {
  console.error(`FAIL: harness JSON unreadable\n--- stdout ---\n${stdoutText}`);
  Deno.exit(1);
}
const S = out.summary;

// ---------- import-time safety --------------------------------------------------------------
assert(
  "import executes the module with NO side effects (no chdir, no argv run, no fetch)",
  out.import_time_ok === true,
);

// ---------- python slugify boundaries (rename drivers) --------------------------------------
for (const [name, ok] of Object.entries(out.slug_checks)) {
  assert(`slugify boundary: ${name}`, ok === true);
}

// ---------- destructive-path buckets ----------------------------------------------------------
const exists = async (p) => {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
};

assert(
  "kept_unchanged: a folder whose slug already matches slugify(listing name) survives",
  S.kept_unchanged.includes("v900/alpha-thing") &&
    await exists(`${tmp}/v900/alpha-thing/index.html`),
);
assert(
  "renamed: old-name -> beta-renamed via shutil.move (source gone, target present with content)",
  S.renamed.some((r) => r === "v900: old-name -> beta-renamed") &&
    !(await exists(`${tmp}/v900/old-name`)) &&
    (await exists(`${tmp}/v900/beta-renamed/index.html`)),
);
assert(
  "deleted_no_id: a folder without a chromestatus ID is rmtree'd, and ONLY that folder",
  S.deleted_no_id.includes("v900/no-id") && !(await exists(`${tmp}/v900/no-id`)) &&
    await exists(`${tmp}/v900/alpha-thing/index.html`),
);
assert(
  "deleted_orphan: an ID absent from the milestone listing is rmtree'd",
  S.deleted_orphan.some((d) => d.startsWith("v900/ghost")) && !(await exists(`${tmp}/v900/ghost`)),
);
assert(
  "deleted_overwritten: on a canonical-target collision the SOURCE dies and the TARGET survives INTACT with its original content",
  S.deleted_overwritten.some((d) => d.includes("v900/weird-name -> v900/dup-target")) &&
    !(await exists(`${tmp}/v900/weird-name`)) &&
    (await exists(`${tmp}/v900/dup-target/index.html`)) &&
    (await Deno.readTextFile(`${tmp}/v900/dup-target/index.html`)) === targetBefore,
);
assert(
  "skipped_seed: SEEDS['gendn'] ('v149','webmcp') is untouched even with no ID",
  S.skipped_seed.includes("v149/webmcp") && await exists(`${tmp}/v149/webmcp/index.html`),
);
assert(
  "seed-skip is seed-SPECIFIC: a non-seed v149 page with no ID is still deleted",
  S.deleted_no_id.includes("v149/not-a-seed") && !(await exists(`${tmp}/v149/not-a-seed`)),
);

// ---------- boundaries: what cleanup must NOT touch -------------------------------------------
assert("a folder without index.html is skipped, not deleted", await exists(`${tmp}/v900/no-index`));
assert(
  "deep children are out of scope (cleanup walks exactly two levels)",
  await exists(`${tmp}/v900/alpha-thing/child/index.html`),
);
assert("non-v directories are ignored entirely", await exists(`${tmp}/public/whatever/index.html`));
assert("stray files under a milestone dir are ignored", await exists(`${tmp}/v900/stray.txt`));

// ---------- conservation: the real catalogue is untouched --------------------------------------
const after = await catalogueSnapshot(REPO);
assert(
  "CONSERVATION: the real worktree catalogue is byte-identical before and after the run",
  before === after,
  `${before.length} chars`,
);

await Deno.remove(tmp, { recursive: true }).catch(() => {});

if (failures > 0) {
  console.error(`fix-slugs.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`fix-slugs fixture: all ${passed} assertions passed`);
