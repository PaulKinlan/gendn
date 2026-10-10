import {
  captureExpression,
  compareSnapshots,
  selectChangedRoutes,
  selectRoutes,
  VIEWPORTS,
} from "./lib/css-drift.mjs";

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
// and snapshot protection. Uncommitted reports are removed in finally.
const root = new URL("..", import.meta.url).pathname;
const route = "/v147/auto-sizes-for-lazy-loaded-images-with-srcset/";
const name = `fixture-${crypto.randomUUID()}`;
const file = `${root}reports/css-drift/${name}.json`;
const report = `${root}reports/css-drift/${name}.diff.json`;
const mutationName = `mutation-${crypto.randomUUID()}`;
const mutationDir = `${root}v9998/${mutationName}`;
const mutationRoute = `/v9998/${mutationName}/`;
const mutationFile = `${root}reports/css-drift/${mutationName}.json`;
const mutationReport = `${root}reports/css-drift/${mutationName}.diff.json`;
async function run(...args) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "css-drift", ...args],
    cwd: root,
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
// A previous run may have been SIGKILLed before its finally block. Clear the
// fixture-only milestone before creating a new page, so the next run heals it.
try {
  await Deno.remove(`${root}v9998`, { recursive: true });
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
try {
  const unsafe = await run("--record", name, "--changed");
  assert(
    unsafe.code === 2 &&
      (unsafe.err.includes("cannot scope shared change") ||
        unsafe.err.includes("--changed found no changed files")),
    "--changed refuses shared changes or an empty diff before browser launch",
  );
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
} finally {
  try {
    await Deno.remove(mutationDir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    await Deno.remove(`${root}v9998`);
  } catch (error) {
    if (
      !(error instanceof Deno.errors.NotFound) && error.code !== "ENOTEMPTY" &&
      error.code !== "EEXIST"
    ) throw error;
  }
  for (
    const path of [
      file,
      report,
      mutationFile,
      mutationReport,
      ...[name, mutationName].flatMap((n) =>
        ["record", "compare"].flatMap((mode) =>
          ["desktop", "mobile"].map((viewport) =>
            `${root}reports/css-drift/${n}.${mode}.${viewport}.png`
          )
        )
      ),
    ]
  ) {
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}
