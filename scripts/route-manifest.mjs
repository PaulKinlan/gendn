#!/usr/bin/env -S deno run --allow-read --allow-run
// route-manifest.mjs — emits gendn's durable route manifest.
//
// The catalogue is the filesystem convention `v<N>/<slug>/index.html`. There is no separate
// registry JSON — a page's stable identity is inferred from the route convention plus the
// `chromestatus.com/feature/<id>` link every page is required to carry (CLAUDE.md invariant #3).
//
// Each published page emits a normalized entry:
//   { id, route, identity, status, demo, aliases }
// where
//   id       — stable page id (`v<N>/<slug>`), append-only, never renamed.
//   route    — the live URL path (`/v<N>/<slug>/`) served by server.ts.
//   identity — the stable descriptor: the chromestatus feature id the page documents.
//   status   — "built" (full reference) or "stub" (honest "covered on MDN" redirect). Both are
//              PUBLISHED / live routes and both are under the compatibility contract. Features that
//              have no folder yet are "pending" — not published, not emitted here.
//   demo     — the embedded showcase demo's inbound identity: the
//              chrome-platform-showcase route this page links to for its own feature (or null).
//              The contract covers this inbound-link identity as well as the article route.
//   aliases  — old routes kept alive for this id via migrations.json (see check-routes.mjs).
//
// Usage:
//   deno run --allow-read --allow-run scripts/route-manifest.mjs            # working tree
//   deno run --allow-read --allow-run scripts/route-manifest.mjs --ref origin/main   # a git ref
//   (add `--pretty` for indented output)

const PAGE_RE = /^v\d+\/[^/]+\/index\.html$/;
const FEATURE_ID_RE = /chromestatus\.com\/feature\/(\d+)/;
const STUB_RE = /covered on mdn|documented on MDN|see MDN/i;
const SHOWCASE_HOST = "chrome-platform-showcase.paulkinlan-ea.deno.net";

function pathToIdentityFields(pagePath, html) {
  // pagePath: `v<N>/<slug>/index.html`
  const parts = pagePath.split("/");
  const release = parts[0]; // v<N>
  const slug = parts[1];
  const id = `${release}/${slug}`;
  const route = `/${release}/${slug}/`;

  const idMatch = html.match(FEATURE_ID_RE);
  const identity = idMatch ? idMatch[1] : null;

  const status = STUB_RE.test(html) ? "stub" : "built";

  // The embedded-demo identity: the showcase route this page links to for its OWN feature.
  // Prefer a link whose path matches this page's `/v<N>/<slug>`; fall back to null.
  let demo = null;
  const showcaseRe = new RegExp(
    `${SHOWCASE_HOST.replace(/\./g, "\\.")}(/v\\d+/[a-z0-9-]+/?[a-z0-9-]*/?)`,
    "g",
  );
  const ownPrefix = `/${release}/${slug}`;
  let m;
  while ((m = showcaseRe.exec(html)) !== null) {
    const routePath = m[1];
    if (routePath.startsWith(ownPrefix)) {
      demo = `https://${SHOWCASE_HOST}${routePath}`;
      break;
    }
    if (demo === null) demo = `https://${SHOWCASE_HOST}${routePath}`;
  }

  return { id, route, identity, status, demo };
}

async function runGit(args) {
  const cmd = new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout);
}

async function collectFromRef(ref) {
  const tree = await runGit(["ls-tree", "-r", "--name-only", ref]);
  const pages = tree.split("\n").filter((p) => PAGE_RE.test(p)).sort();
  const entries = [];
  for (const pagePath of pages) {
    const html = await runGit(["show", `${ref}:${pagePath}`]);
    entries.push(pathToIdentityFields(pagePath, html));
  }
  return entries;
}

async function collectFromWorkingTree(root = ".") {
  const pages = [];
  for await (const rel of walkPages(root)) pages.push(rel);
  pages.sort();
  const entries = [];
  for (const pagePath of pages) {
    const html = await Deno.readTextFile(`${root}/${pagePath}`);
    entries.push(pathToIdentityFields(pagePath, html));
  }
  return entries;
}

async function* walkPages(root) {
  for await (const rel of Deno.readDir(root)) {
    if (rel.isDirectory && /^v\d+$/.test(rel.name)) {
      for await (const slug of Deno.readDir(`${root}/${rel.name}`)) {
        if (!slug.isDirectory) continue;
        const pagePath = `${rel.name}/${slug.name}/index.html`;
        try {
          await Deno.stat(`${root}/${pagePath}`);
          yield pagePath;
        } catch {
          // no index.html — not a published page
        }
      }
    }
  }
}

export async function buildManifest({ ref } = {}) {
  const entries = ref ? await collectFromRef(ref) : await collectFromWorkingTree();
  return entries.map((e) => ({ ...e, aliases: [] }));
}

if (import.meta.main) {
  const args = Deno.args;
  const refIdx = args.indexOf("--ref");
  const ref = refIdx >= 0 ? args[refIdx + 1] : undefined;
  const pretty = args.includes("--pretty");
  const manifest = await buildManifest({ ref });
  console.log(JSON.stringify(manifest, null, pretty ? 2 : 0));
}
