// On-demand computed-style regression sweep. Baselines are uncommitted per-wave artifacts.
// deno task css-drift --record wave-1 --routes 'v147/*'
// deno task css-drift --compare wave-1 --routes 'v147/*'
// --changed scopes to reference files changed against origin/main (including uncommitted files).
// Use --all instead of --routes/--changed for an explicit full-corpus run (several minutes).
// The corpus includes both published roots and nested member references: v*/**/index.html.
// Capture the baseline on the pre-wave tree, then compare in the SAME worktree/Chrome version
// after editing. Uncommitted reports/css-drift/ must be preserved across those two runs.
import { launch } from "./lib/cdp.mjs";
import { runGit } from "./lib/bounded-git.mjs";
import {
  captureExpression,
  compareSnapshots,
  selectChangedRoutes,
  selectRoutes,
  VIEWPORTS,
} from "./lib/css-drift.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const OUTPUT = `${ROOT}reports/css-drift`;

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--all" || flag === "--changed") {
      if (result[flag.slice(2)]) throw new Error(`duplicate ${flag}`);
      result[flag.slice(2)] = true;
    } else if (["--record", "--compare", "--routes"].includes(flag)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
      if (result[flag.slice(2)]) throw new Error(`duplicate ${flag}`);
      result[flag.slice(2)] = args[++i];
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (!!result.record === !!result.compare) {
    throw new Error("choose exactly one of --record or --compare");
  }
  if ([result.all, result.routes, result.changed].filter(Boolean).length !== 1) {
    throw new Error("choose exactly one of --routes <glob/list>, --changed or --all");
  }
  const name = result.record ?? result.compare;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) {
    throw new Error("snapshot name must be 1-80 letters, numbers, underscores or hyphens");
  }
  return result;
}

async function stopServer(server) {
  try {
    server.kill("SIGTERM");
  } catch { /* already stopped */ }
  const outcome = await Promise.race([
    server.status.then(() => "exited").catch(() => "exited"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ]);
  if (outcome === "timeout") {
    try {
      server.kill("SIGKILL");
    } catch { /* already stopped */ }
    await server.status.catch(() => {});
  }
}

async function gitOutput(args) {
  const result = await runGit(args, { cwd: ROOT, stdout: "piped", stderr: "piped" });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function changedPaths() {
  // Compare the full branch plus staged/worktree edits against the PR merge-base.
  const base = (await gitOutput(["merge-base", "origin/main", "HEAD"])).trim();
  if (!base) throw new Error("origin/main merge-base is missing; fetch origin first");
  const tracked = await gitOutput([
    "diff",
    "--name-only",
    "--diff-filter=ACMRTD",
    "-z",
    base,
    "--",
  ]);
  const untracked = await gitOutput(["ls-files", "--others", "--exclude-standard", "-z", "--"]);
  return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))];
}

async function discoverRoutes() {
  const routes = [];
  async function walk(dir, route) {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isDirectory) continue;
      const child = `${dir}/${entry.name}`;
      try {
        if ((await Deno.stat(`${child}/index.html`)).isFile) {
          routes.push(`${route}${entry.name}/`);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await walk(child, `${route}${entry.name}/`);
    }
  }
  for await (const release of Deno.readDir(ROOT)) {
    if (release.isDirectory && /^v\d+$/.test(release.name)) {
      await walk(`${ROOT}${release.name}`, `/${release.name}/`);
    }
  }
  return routes.sort();
}

// A guessed server port can collide with another lane or silently sample the wrong server.
// PORT=0 and this child's own listening line establish ownership (gendn-f0o3).
export async function spawnCssServer({ script = "server.ts", startupTimeoutMs = 30_000 } = {}) {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-read", "--allow-env", script],
    env: { ...Deno.env.toObject(), PORT: "0" },
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let stdout = "", stderr = "", resolveReady;
  const ready = new Promise((resolve) => resolveReady = resolve);
  const capture = (stream, onText) => {
    const decoder = new TextDecoder();
    return stream.pipeTo(
      new WritableStream({
        write(bytes) {
          onText(decoder.decode(bytes, { stream: true }));
        },
      }),
    ).catch(() => {});
  };
  const stdoutDone = capture(child.stdout, (text) => {
    stdout = (stdout + text).slice(-4096);
    const match = stdout.match(/Listening on http:\/\/localhost:(\d+)/);
    if (match) resolveReady(Number(match[1]));
  });
  const stderrDone = capture(child.stderr, (text) => stderr = (stderr + text).slice(-4096));
  let exited = null;
  const status = child.status.then((value) => exited = value);
  let timer;
  try {
    const first = await Promise.race([
      ready.then((port) => ({ port })),
      status.then((exit) => ({ exit })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), startupTimeoutMs);
      }),
    ]);
    if (!first.port) {
      throw new Error(
        first.timeout
          ? `startup timed out after ${startupTimeoutMs}ms`
          : "child exited before listening",
      );
    }
    const base = `http://127.0.0.1:${first.port}`;
    const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(15_000) });
    const ok = response.ok;
    await response.body?.cancel();
    if (!ok) throw new Error(`readiness GET / returned HTTP ${response.status}`);
    return { child, base, port: first.port };
  } catch (error) {
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already stopped.
      }
    }
    await status;
    await Promise.all([stdoutDone, stderrDone]);
    throw new Error(
      `gendn server did not start for CSS drift: ${error.message}; ` +
        `child ${exited?.signal ? `signal ${exited.signal}` : `exit ${exited?.code}`}; ` +
        `stderr: ${stderr.trim() || "(empty)"}; stdout: ${stdout.trim() || "(empty)"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function sweep(routes, screenshotPrefix) {
  const { child: server, base, port: serverPort } = await spawnCssServer();
  let browser;
  let viewPages = {};
  let chromeVersion;
  const pages = {};
  try {
    for (const [index, route] of routes.entries()) {
      // Recycle Chrome every 40 routes, as the conformance sweep does, to bound long-run memory.
      if (index % 40 === 0) {
        await browser?.close();
        browser = await launch({ port: 0 });
        await browser.connect();
        const version = (await browser.conn.send("Browser.getVersion")).product;
        if (chromeVersion && version !== chromeVersion) {
          throw new Error(`Chrome changed mid-sweep: ${chromeVersion} vs ${version}`);
        }
        chromeVersion = version;
        viewPages = {};
        for (const [name, viewport] of Object.entries(VIEWPORTS)) {
          viewPages[name] = await browser.newPage(viewport);
        }
      }
      pages[route] = {};
      for (const [name, page] of Object.entries(viewPages)) {
        await page.goto(`${base}${route}`);
        const result = await page.evaluate(captureExpression());
        // Page.evaluate wraps JavaScript exceptions in a string; never mistake one for a snapshot.
        if (!result || typeof result !== "object" || !Object.keys(result).length) {
          throw new Error(`no computed styles for ${route} ${name}: ${JSON.stringify(result)}`);
        }
        const failures = page.diagnostics().failedRequests.filter((item) =>
          item.url.startsWith(base) || item.url.startsWith(`http://localhost:${serverPort}`)
        );
        if (failures.length) {
          throw new Error(`${route} ${name} local resource failure: ${JSON.stringify(failures)}`);
        }
        pages[route][name] = result;
        if (index === 0) await page.screenshot(`${screenshotPrefix}.${name}.png`);
      }
      if ((index + 1) % 25 === 0 || index + 1 === routes.length) {
        console.log(`css-drift: sampled ${index + 1}/${routes.length} routes at both widths`);
      }
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      await stopServer(server);
    }
  }
  return { version: 1, chromeVersion, viewports: VIEWPORTS, pages };
}

async function main() {
  const config = options(Deno.args);
  const published = await discoverRoutes();
  const routes = config.all
    ? published
    : config.changed
    ? selectChangedRoutes(published, await changedPaths())
    : selectRoutes(published, config.routes);
  if (!routes.length) throw new Error("no published pages found; refusing an empty green sweep");
  const name = config.record ?? config.compare;
  const file = `${OUTPUT}/${name}.json`;
  let baseline;
  if (config.compare) {
    baseline = JSON.parse(await Deno.readTextFile(file));
    const baselineRoutes = Object.keys(baseline.pages ?? {}).sort();
    if (JSON.stringify(baselineRoutes) !== JSON.stringify(routes)) {
      throw new Error(
        `baseline route set differs (${baselineRoutes.length} baseline / ${routes.length} requested); use the same route set for both passes`,
      );
    }
  } else {
    try {
      await Deno.stat(file);
      throw new Error(
        `baseline already exists: ${file}; choose a new wave name (will not overwrite)`,
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  await Deno.mkdir(OUTPUT, { recursive: true });
  const current = await sweep(routes, `${OUTPUT}/${name}.${config.record ? "record" : "compare"}`);
  if (config.record) {
    // Exclusive create: a concurrent writer cannot silently overwrite another wave's baseline.
    const handle = await Deno.open(file, { write: true, createNew: true });
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(current, null, 2) + "\n");
      let offset = 0;
      while (offset < bytes.length) offset += await handle.write(bytes.subarray(offset));
    } finally {
      handle.close();
    }
    console.log(`css-drift: baseline recorded ${routes.length} routes × 2 viewports at ${file}`);
  } else {
    const differences = compareSnapshots(baseline, current);
    const report = `${OUTPUT}/${name}.diff.json`;
    await Deno.writeTextFile(
      report,
      JSON.stringify({ baseline: file, routes: routes.length, differences }, null, 2) + "\n",
    );
    console.log(
      `css-drift: ${differences.length} computed-style differences across ${routes.length} routes; report ${report}`,
    );
    for (const item of differences.slice(0, 20)) console.log(JSON.stringify(item));
    if (differences.length > 20) console.log(`... ${differences.length - 20} more in report`);
    if (differences.length) Deno.exitCode = 1;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`css-drift: ${error.message}`);
    Deno.exitCode = 2;
  }
}
