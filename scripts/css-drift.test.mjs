// @fixture-permissions --allow-read --allow-write --allow-run --allow-net=127.0.0.1,localhost --allow-env
import {
  captureExpression,
  compareSnapshots,
  selectChangedRoutes,
  selectRoutes,
  VIEWPORTS,
} from "./lib/css-drift.mjs";
import { CHECKOUT_ROOT, createPrivateServedRoot } from "./lib/private-root.mjs";

function assert(ok, reason) {
  if (!ok) throw new Error(reason);
}

const routes = ["/v147/a/", "/v148/b/", "/v149/c/"];
assert(
  JSON.stringify(selectRoutes(routes, "v147/*,/v149/c")) === JSON.stringify([routes[0], routes[2]]),
  "glob/list selection",
);
assert(
  JSON.stringify(selectRoutes(routes, "/v148/b/")) === JSON.stringify([routes[1]]),
  "absolute route selection",
);
assert(captureExpression().includes("getComputedStyle"), "browser collects computed CSS");
const nested = ["/v147/a/", "/v147/a/member/", "/v148/b/"];
assert(
  JSON.stringify(selectChangedRoutes(nested, ["v147/a/index.html"])) ===
    JSON.stringify(nested.slice(0, 1)),
  "changed leaf selects only its route",
);
assert(
  JSON.stringify(selectChangedRoutes(nested, ["v147/a/local.css"])) ===
    JSON.stringify(nested.slice(0, 2)),
  "changed parent asset includes nested routes",
);
assert(
  JSON.stringify(selectChangedRoutes(nested, ["v147/a/member/index.html", "v148/b/index.html"])) ===
    JSON.stringify([nested[1], nested[2]]),
  "changed member and another leaf select their exact routes",
);
for (
  const paths of [[], ["public/styles.css"], ["v149/new/index.html"], [
    "v147/a/index.html",
    "server.ts",
  ]]
) {
  let refused = false;
  try {
    selectChangedRoutes(nested, paths);
  } catch {
    refused = true;
  }
  assert(refused, `unsafe changed set must fail closed: ${JSON.stringify(paths)}`);
}
for (const pattern of ["", "v199/*", "../*"]) {
  let refused = false;
  try {
    selectRoutes(routes, pattern);
  } catch {
    refused = true;
  }
  assert(refused, `invalid/empty route selection must fail: ${pattern}`);
}
const baseline = {
  version: 1,
  viewports: VIEWPORTS,
  pages: {
    "/v147/a/": {
      desktop: { "main:0": { color: "red", display: "block" } },
      mobile: { "main:0": { color: "blue", display: "block" } },
    },
  },
};
assert(
  compareSnapshots(baseline, structuredClone(baseline)).length === 0,
  "unchanged snapshot is green",
);
const changed = structuredClone(baseline);
changed.pages["/v147/a/"].desktop["main:0"].color = "green";
changed.pages["/v147/a/"].mobile["a:0"] = { color: "blue" };
const diff = compareSnapshots(baseline, changed);
assert(
  diff.length === 2 &&
    diff.some((d) => d.property === "color" && d.before === "red" && d.after === "green") &&
    diff.some((d) => d.selector === "a:0"),
  "style and selector drift recorded",
);
const lost = structuredClone(baseline);
delete lost.pages["/v147/a/"];
assert(compareSnapshots(baseline, lost).length === 2, "missing route fails at both widths");

// Browser smoke on a REAL served page, exercising baseline persistence, no-drift comparison,
// and snapshot protection.
//
// EVERY path this fixture can create or delete lives in a PRIVATE root (gendn-gvoq): the served
// tree, the synthesized v9998 page and reports/css-drift are all in a disposable --shared clone
// pinned to origin/main. The fixture used to write into the CHECKOUT and recursively remove the
// shared <repo>/v9998 milestone before its own run, so a concurrently running reference-browser
// fixture (or an agent editing v9998) could lose the page it was about to load. Cleanup is now a
// single removal of the root this fixture created; nothing here names a checkout path.
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
