// @fixture-permissions --allow-read --allow-write --allow-run --allow-net=127.0.0.1,localhost --allow-env
// scripts/css-drift-browser.test.mjs — the REAL-BROWSER half of the CSS-drift coverage (gendn-xe6f).
//
// Split out of scripts/css-drift.test.mjs (gendn-xe6f) because it costs ~29s of real Chrome and must
// not be paid by every unrelated landing (gendn-ohot). It is a NAMED suite, not an auto-discovered
// fixture: `deno task test-css-drift-browser`. scripts/run-fixtures.mjs lists it in EXCLUDED with a
// reason, and scripts/gate-map.mjs is what makes it MANDATORY for the changes it can catch (the
// CSS-drift sources, the browser-capture helpers, public/styles.css, routing/server code, and this
// file). gate:full runs it unconditionally; the fast tier runs it when a mapped path changed and
// otherwise prints "SKIPPED (unaffected: <matched rule>)" with the rule named; CI runs it always.
//
// Why it cannot simply be dropped from the fast tier: the deterministic fixture proves SELECTION and
// COMPARISON, while only this one proves the whole chain against a live server - record/no-drift
// persistence, refusing to overwrite a baseline, refusing a mismatched corpus, and a REAL served CSS
// change detected with the exact computed-style property at both viewports. A single fixed-route CSS
// sample is not proof about leaf pages, which is why page changes keep the route/conformance gates.
//
// EVERY path this suite can create or delete lives in a PRIVATE root (gendn-gvoq): the served tree,
// the synthesized v9998 page and reports/css-drift are all inside a disposable --shared clone pinned
// to origin/main, so a concurrent suite (or an agent editing the checkout) cannot lose a page to this
// suite's cleanup. Cleanup is one removal of the root it created.
import { CHECKOUT_ROOT, createPrivateServedRoot } from "./lib/private-root.mjs";

function assert(ok, reason) {
  if (!ok) throw new Error(reason);
}

const checkout = CHECKOUT_ROOT;
const fixture = await createPrivateServedRoot({ prefix: "gendn-css-drift" });
const root = fixture.root;
const route = "/v147/auto-sizes-for-lazy-loaded-images-with-srcset/";
const name = `fixture-${crypto.randomUUID()}`;
const file = `${root}reports/css-drift/${name}.json`;
const report = `${root}reports/css-drift/${name}.diff.json`;
// The --changed pass records its OWN baseline, so it cannot collide with the browser pass below.
const changedName = `changed-${crypto.randomUUID()}`;
const changedFile = `${root}reports/css-drift/${changedName}.json`;
const mutationName = `mutation-${crypto.randomUUID()}`;
const mutationDir = `${root}v9998/${mutationName}`;
const mutationRoute = `/v9998/${mutationName}/`;
const mutationFile = `${root}reports/css-drift/${mutationName}.json`;
const mutationReport = `${root}reports/css-drift/${mutationName}.diff.json`;
// A page a SIGKILLed earlier run left behind, as debris this run must leave alone.
const killedName = `killed-${crypto.randomUUID()}`;
let restart;
async function exists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return false;
  }
}
async function runAt(cwd, ...args) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "css-drift", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  return {
    code: result.code,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}
const run = (...args) => runAt(root, ...args);

// --changed must see a controlled git tree, not whatever route edits the caller's branch has. The
// PRIVATE root IS that tree: clean at origin/main, and no other suite can see it or move it. The
// clean case must refuse before Chrome starts; a single tracked page edit must then select exactly
// that published route and produce a real browser snapshot.
{
  const empty = await run("--record", changedName, "--changed");
  assert(
    empty.code === 2 && empty.err.includes("--changed found no changed files"),
    `--changed clean tree refuses an empty diff: ${JSON.stringify(empty)}`,
  );
  let emptySnapshotExists = true;
  try {
    await Deno.stat(changedFile);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    emptySnapshotExists = false;
  }
  assert(!emptySnapshotExists, "empty --changed run writes no misleading baseline");
  const page = `${root}${route.slice(1)}index.html`;
  await Deno.writeTextFile(
    page,
    (await Deno.readTextFile(page)) + "\n<!-- css-drift changed-route fixture -->\n",
  );
  const scoped = await run("--record", changedName, "--changed");
  assert(scoped.code === 0, `--changed records the edited route: ${JSON.stringify(scoped)}`);
  const selected = JSON.parse(
    await Deno.readTextFile(changedFile),
  );
  assert(
    JSON.stringify(Object.keys(selected.pages)) === JSON.stringify([route]) &&
      Object.keys(selected.pages[route].mobile).length > 0 &&
      Object.keys(selected.pages[route].desktop).length > 0,
    "--changed selected ONLY the edited route and captured both widths",
  );
  await Deno.writeTextFile(
    `${root}public/styles.css`,
    (await Deno.readTextFile(`${root}public/styles.css`)) + "\n/* shared fixture */\n",
  );
  const shared = await run("--record", `shared-${changedName}`, "--changed");
  assert(
    shared.code === 2 && shared.err.includes("cannot scope shared change public/styles.css"),
    `--changed refuses a shared edit despite the scoped route: ${JSON.stringify(shared)}`,
  );
}

// A page a SIGKILLed earlier run left behind (its finally block never ran). It lives in a root no
// other run reads, and this run must leave it ALONE: the old fixture "healed" itself by recursively
// removing the whole SHARED v9998 milestone, which is exactly how a concurrent suite lost the page
// it was about to load. The assertions at the end pin that this debris survives.
await Deno.mkdir(`${root}v9998/${killedName}`, { recursive: true });
await Deno.writeTextFile(
  `${root}v9998/${killedName}/index.html`,
  "<!doctype html><title>killed-run debris</title>",
);
try {
  const recorded = await run("--record", name, "--routes", route);
  assert(recorded.code === 0, `real browser record: ${JSON.stringify(recorded)}`);
  const snapshot = JSON.parse(await Deno.readTextFile(file));
  assert(
    Object.keys(snapshot.pages).length === 1 &&
      Object.keys(snapshot.pages[route].mobile).length > 0,
    "real browser captured both widths",
  );
  const duplicate = await run("--record", name, "--routes", route);
  assert(
    duplicate.code === 2 && duplicate.err.includes("already exists"),
    "refuse overwrite before browser launch",
  );
  const compared = await run("--compare", name, "--routes", route);
  assert(compared.code === 0, `real browser no-drift compare: ${JSON.stringify(compared)}`);
  assert(
    JSON.parse(await Deno.readTextFile(report)).differences.length === 0,
    "real browser diff is empty",
  );
  const wrong = await run("--compare", name, "--routes", "/v148/*");
  assert(wrong.code === 2 && wrong.err.includes("route set differs"), "refuse mismatched corpus");
  // Change a REAL served CSS rule, not a mocked snapshot, and prove non-zero exit plus
  // the precise computed-style property in the generated report at both widths.
  await Deno.mkdir(mutationDir, { recursive: true });
  await Deno.writeTextFile(
    `${mutationDir}/index.html`,
    "<!doctype html><html><head><style>main{color:rgb(10, 20, 30)}</style></head><body><main>fixture</main></body></html>",
  );
  const before = await run("--record", mutationName, "--routes", mutationRoute);
  assert(before.code === 0, `fixture baseline: ${JSON.stringify(before)}`);
  await Deno.writeTextFile(
    `${mutationDir}/index.html`,
    "<!doctype html><html><head><style>main{color:rgb(40, 50, 60)}</style></head><body><main>fixture</main></body></html>",
  );
  const after = await run("--compare", mutationName, "--routes", mutationRoute);
  assert(after.code === 1, `real browser changed CSS must fail: ${JSON.stringify(after)}`);
  const changes = JSON.parse(await Deno.readTextFile(mutationReport)).differences;
  for (const viewport of ["mobile", "desktop"]) {
    assert(
      changes.some((item) =>
        item.route === mutationRoute && item.viewport === viewport &&
        item.selector === "main:0" && item.property === "color" &&
        item.before === "rgb(10, 20, 30)" && item.after === "rgb(40, 50, 60)"
      ),
      `real CSS mutation detected on ${viewport}`,
    );
  }
  console.log("css-drift fixtures: real browser zero-drift and CSS-mutation detection passed");

  // The SIGKILLed run's debris is STILL THERE: this fixture never recursively owns a milestone.
  assert(
    await exists(`${root}v9998/${killedName}/index.html`),
    "a previous run's fixture debris is left alone, not recursively swept",
  );

  // Restart after that kill. A fresh root inherits none of the debris, so a killed run cannot poison
  // the next one through shared state. The empty --changed refusal is the discriminating check: it
  // only passes on a tree with no inherited dirt.
  restart = await createPrivateServedRoot({ prefix: "gendn-css-drift-restart" });
  const restarted = await runAt(restart.root, "--record", changedName, "--changed");
  assert(
    restarted.code === 2 && restarted.err.includes("--changed found no changed files"),
    `restart after a killed run starts from a clean tree: ${JSON.stringify(restarted)}`,
  );
  assert(
    !(await exists(`${restart.root}v9998/${killedName}/index.html`)),
    "the restarted root inherits no fixture debris",
  );

  // The checkout itself is never written to, by name: none of this run's fixture paths exist there.
  for (
    const path of [
      `${checkout}v9998/${mutationName}`,
      `${checkout}v9998/${killedName}`,
      `${checkout}reports/css-drift/${name}.json`,
      `${checkout}reports/css-drift/${changedName}.json`,
    ]
  ) {
    assert(!(await exists(path)), `fixture wrote into the checkout: ${path}`);
  }
} finally {
  // The only cleanup this fixture owns: the roots it created itself.
  await fixture.remove();
  await restart?.remove();
}
