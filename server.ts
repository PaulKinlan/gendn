// gendn — generated reference docs for web platform APIs shipping in Chrome
// that don't yet have a page on MDN.
//
// Same layout convention as chrome-platform-showcase: per-release folders
// at v<N>/<api-slug>/index.html. The index lists every API by release and
// flags each as "on MDN → link out" or "generated here → link to local page".

import {
  Channels,
  chromeStatusUrl,
  fetchBounded,
  getChannels,
  getMilestoneFeatures,
  milestonePathSegment,
  slugify,
} from "./lib/chromestatus.ts";
import { renderCommitAnchor } from "./lib/external-url.ts";
import { escapeHTML } from "./lib/html.ts";
import {
  renderConformanceIndex,
  renderCritique,
  renderRunAll,
  renderSuite,
} from "./lib/lifecycle.ts";

const PORT = Number(Deno.env.get("PORT") ?? 3000);

// ----- Durable-demo route aliases (301 redirects) -----
//
// migrations.json is the single source of truth for the compatibility contract (see AGENTS.md /
// CLAUDE.md). Every `move`/`alias` record keeps an OLD published route alive with a permanent
// redirect to the CURRENT route for the same chromestatus feature id, so pre-contract slug/milestone
// corrections don't 404 old inbound links. `remove` records are provenance only (no redirect).
// Don't hand-maintain a second list — this reads migrations.json directly.

interface Migration {
  id: string;
  action: "move" | "alias" | "remove" | "identity-change";
  from: string;
  to: string | null;
  reason?: string;
  evidence?: string;
  date?: string;
}

function loadRedirects(): { from: string; to: string }[] {
  try {
    const raw = Deno.readTextFileSync("./migrations.json");
    const migrations = JSON.parse(raw) as Migration[];
    return migrations
      .filter((m) => (m.action === "move" || m.action === "alias") && m.from && m.to)
      .map((m) => ({ from: m.from, to: m.to as string }));
  } catch {
    return [];
  }
}

const REDIRECTS = loadRedirects();

// Returns the 301 target for a request path if it falls under an aliased old route, else null.
// Matches the old route exactly (with or without trailing slash) and any deep link under it,
// carrying the remaining sub-path over to the new route.
function redirectTarget(path: string): string | null {
  for (const { from, to } of REDIRECTS) {
    const fromNoSlash = from.endsWith("/") ? from.slice(0, -1) : from;
    if (path === fromNoSlash || path === from) return to;
    if (path.startsWith(from)) return to + path.slice(from.length);
  }
  return null;
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff2: "font/woff2",
};

// escapeHTML now lives in lib/html.ts so the commit-line renderer (lib/external-url.ts) escapes
// exactly as the server does — one implementation, not a copy. Encoding only: it is NOT a
// URL-scheme check (gendn-0cu).

// ----- Last-commit info (fetched from GitHub, cached for 5 minutes) -----

interface CommitInfo {
  sha: string;
  shortSha: string;
  date: string;
  htmlUrl: string;
}

const COMMIT_TTL_MS = 5 * 60 * 1000;
let commitCache: { at: number; value: CommitInfo | null } | null = null;

// Errors are logged in full server-side so an operator can still diagnose the failure, but the
// client gets a generic message: raw err text can carry internal paths, file names and upstream
// detail (gendn-snd). The log line carries the context needed to identify the request.
function serverError(req: Request, what: string, err: unknown): Response {
  const path = (() => {
    try {
      return new URL(req.url).pathname;
    } catch {
      return req.url;
    }
  })();
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[gendn] ${what} failed: ${req.method} ${path} -> ${detail}`);
  if (err instanceof Error && err.stack) console.error(`[gendn] ${what} stack: ${err.stack}`);
  return new Response("Internal error", {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function getLatestCommit(): Promise<CommitInfo | null> {
  if (commitCache && Date.now() - commitCache.at < COMMIT_TTL_MS) return commitCache.value;
  try {
    const { res, text } = await fetchBounded(
      "https://api.github.com/repos/PaulKinlan/gendn/commits/main",
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!res.ok) {
      commitCache = { at: Date.now(), value: null };
      return null;
    }
    const data = JSON.parse(text);
    const value: CommitInfo = {
      sha: data.sha,
      shortSha: String(data.sha).slice(0, 7),
      date: data.commit?.author?.date ?? data.commit?.committer?.date ?? "",
      // Stored raw; rendered through the scheme allowlist in lib/external-url.ts (gendn-0cu).
      // This is the value's ONLY sink — it reaches no JSON, feed or other template (checked by
      // grep for htmlUrl/html_url across the repo: interface, this assignment, and the render).
      htmlUrl: data.html_url,
    };
    commitCache = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatCommitLine(c: CommitInfo | null): string {
  if (!c) return "";
  const when = c.date ? new Date(c.date) : null;
  const relative = when ? relativeTime(when) : "";
  const absolute = when
    ? when.toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    })
    : "";
  return `<p class="updated-line">Last updated ${escapeHTML(relative)} <span class="updated-abs">(${
    escapeHTML(absolute)
  })</span> &middot; commit ${renderCommitAnchor(c.htmlUrl, c.shortSha)}</p>`;
}

async function readPublicAsset(path: string): Promise<Response> {
  // DEFENSE IN DEPTH ONLY (gendn-d7a): symmetric with readReleaseAsset's guard below. The
  // nightly vuln-discovery and vuln-verify stations both judged directory traversal SAFE
  // here because the URL is normalised before use — this guard adds no behaviour change
  // beyond the same explicit early-exit its sibling already has.
  if (path.includes("..")) return new Response("Not found", { status: 404 });
  try {
    const file = await Deno.readFile("." + path);
    const ext = path.split(".").pop() ?? "";
    return new Response(file, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function readReleaseAsset(release: string, sub: string): Promise<Response | null> {
  if (sub.includes("..")) return null;
  let key = sub.replace(/^\/+/, "");
  if (!key) return null;
  if (key.endsWith("/")) key += "index.html";
  else if (!/\.[a-z0-9]+$/i.test(key)) key += "/index.html";
  try {
    const file = await Deno.readFile(`./${release}/${key}`);
    const ext = key.split(".").pop() ?? "";
    return new Response(file, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    return null;
  }
}

// ----- Index page -----

export async function renderIndex(channels: Channels): Promise<string> {
  const commit = await getLatestCommit();
  const prevStable = channels.stable.mstone - 1;
  const releases: { mstone: number; status: string; date: string }[] = [
    { mstone: channels.dev.mstone, status: "Dev", date: channels.dev.stable_date },
    { mstone: channels.beta.mstone, status: "Beta", date: channels.beta.stable_date },
    {
      mstone: channels.stable.mstone,
      status: "Stable (rolling out)",
      date: channels.stable.stable_date,
    },
    { mstone: prevStable, status: "Stable (live)", date: "" },
  ];

  const seen = new Set(releases.map((r) => r.mstone));
  try {
    for await (const entry of Deno.readDir(".")) {
      if (entry.isDirectory && /^v\d+$/.test(entry.name)) {
        const m = Number(entry.name.slice(1));
        if (!seen.has(m)) {
          releases.push({ mstone: m, status: "Archive", date: "" });
          seen.add(m);
        }
      }
    }
  } catch {
    // ignore
  }
  releases.sort((a, b) => b.mstone - a.mstone);

  const cards = releases.map((r) => {
    let note: string;
    if (r.date) {
      note = `Stable date: ${
        new Date(r.date).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      }`;
    } else if (r.status === "Archive") {
      note = "Backfilled";
    } else {
      note = "Most users are here";
    }
    // Narrowed at runtime, not escaped (gendn-sxn / THREAT_MODEL.md invariant #4).
    const mstone = milestonePathSegment(r.mstone);
    const releaseHref = mstone ? `/v${mstone}/` : "#";
    const releaseLabel = mstone ? `Chrome ${mstone}` : `Chrome ${escapeHTML(String(r.mstone))}`;
    return `<li class="release-card">
      <a class="release-card-link" href="${releaseHref}">
        <span class="release-card-row">
          <span class="release-label">${releaseLabel}</span>
          <span class="release-status">${escapeHTML(r.status)}</span>
        </span>
        <span class="release-note">${escapeHTML(note)}</span>
      </a>
    </li>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>gendn — generated web platform docs</title>
  <link rel="stylesheet" href="/public/styles.css">
</head>
<body>
  <main>
    <header class="lede-block">
      <p class="eyebrow">work in progress</p>
      <h1>gendn</h1>
      <p class="lede">Generated reference docs for the APIs that ship in Chrome but don't yet have a page on MDN. When MDN already covers an API, gendn just links out. The goal is the gap between "shipped in Chrome" and "documented on developer.mozilla.org".</p>
      ${formatCommitLine(commit)}
    </header>

    <section>
      <h2>releases</h2>
      <ol class="release-list">${cards}</ol>
      <p class="note">Or jump straight to <a href="/features">the full API catalogue</a> to search across every release at once.</p>
    </section>

    <section class="how">
      <h2>how it works</h2>
      <ol>
        <li>A daily routine reads <a href="https://chromestatus.com/" target="_blank" rel="noopener">chromestatus.com</a> for features shipping in Chrome (stable, beta, dev, plus prev-stable).</li>
        <li>For each, it checks MDN. If MDN has a page, gendn just links to MDN.</li>
        <li>If MDN doesn't have a page, the routine writes a reference doc generated from the spec, explainer, and the IDL in Chromium source.</li>
        <li>When MDN later ships its own page, the routine notices on the next pass and the gendn entry switches to a "see MDN" stub.</li>
      </ol>
      <p class="note">Sister project: <a href="https://chrome-platform-showcase.paulkinlan-ea.deno.net/" target="_blank" rel="noopener">chrome-platform-showcase</a> — interactive demos for the same set of features. Repo: <a href="https://github.com/PaulKinlan/gendn" target="_blank" rel="noopener">PaulKinlan/gendn</a>.</p>
    </section>

    <footer class="byline">made by <a href="https://paul.kinlan.me/" target="_blank" rel="noopener">Paul Kinlan</a></footer>
  </main>
</body>
</html>`;
}

// ----- Per-release index -----

async function featureHasDoc(release: string, slug: string): Promise<boolean> {
  try {
    await Deno.stat(`./${release}/${slug}/index.html`);
    return true;
  } catch {
    return false;
  }
}

// ----- Cross-release identity index -----
// Identity is the chromestatus feature id (invariant #1), not the milestone folder. When a
// feature's listing drifts to a later milestone (or appears in two listings), the page already
// built under an earlier release is the canonical reference — the listing must link it rather
// than flag a false "doc pending". Built lazily once per process from each page's identity link.
let identityIndexPromise: Promise<Map<string, string>> | null = null;
// Bounds concurrent independent I/O. Used by the identity-index reads below AND by the /features
// catalogue's per-feature doc checks, so there is one in-flight cap in the file rather than two
// numbers that can drift. 32 mirrors the cap this file already used for the index reads; the work
// items are independent files/metadata, so this is only a ceiling on in-flight I/O and never a
// change to which item wins anything.
const IO_CONCURRENCY = 32;

// Run `fn` over `items` with at most `limit` in flight, returning results in INPUT ORDER so a
// caller can rely on positional correspondence (that is what keeps duplicate-identity resolution
// first-wins in getIdentityIndex below). Rejections propagate: callers that want per-item
// tolerance catch inside `fn`.
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) break;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function getIdentityIndex(): Promise<Map<string, string>> {
  if (!identityIndexPromise) {
    identityIndexPromise = (async () => {
      const map = new Map<string, string>();
      const routes: string[] = [];
      for (const dir of Deno.readDirSync(".")) {
        if (!dir.isDirectory || !/^v\d+$/.test(dir.name)) continue;
        for (const sub of Deno.readDirSync(`./${dir.name}`)) {
          if (!sub.isDirectory) continue;
          routes.push(`/${dir.name}/${sub.name}/`);
        }
      }
      // Read the pages concurrently (bounded), then collate in directory order: `!map.has(id)`
      // still resolves duplicates first-wins exactly as the sequential loop did, independent of
      // read order, because mapPool returns results in input order.
      // A missing index.html means a child-route container, not a page.
      const htmls = await mapPool(
        routes,
        IO_CONCURRENCY,
        (route) => Deno.readTextFile(`.${route}index.html`).catch(() => null),
      );
      htmls.forEach((html, i) => {
        const m = html?.match(/chromestatus\.com\/feature\/(\d+)/);
        if (m && !map.has(m[1])) map.set(m[1], routes[i]);
      });
      return map;
    })();
  }
  return identityIndexPromise;
}

function categoryTag(category: string): string {
  return category
    .replace("In developer trial (Behind a flag)", "Dev Trial")
    .replace("Enabled by default", "Shipped")
    .replace("Origin trial", "Origin Trial")
    .replace("Stepped rollout", "Stepped rollout")
    .replace("Browser Intervention", "Intervention");
}

// Route values come from directory names; escape at the point of interpolation (gendn-7xq).
export function referenceTag(release: string, slug: string): string {
  return `<a class="tag tag-live" href="/${escapeHTML(release)}/${
    escapeHTML(slug)
  }/">reference &rarr;</a>`;
}
export function crossReferenceTag(cross: string): string {
  return `<a class="tag tag-live" href="${escapeHTML(cross)}">reference ${
    escapeHTML(cross.split("/")[1] ?? "")
  } &rarr;</a>`;
}

async function renderReleasePage(release: string, milestone: number): Promise<string> {
  const features = await getMilestoneFeatures(milestone);
  const identityIndex = await getIdentityIndex();

  const sections = await Promise.all(features.groups.map(async (group) => {
    const cards = await Promise.all(group.features.map(async (f) => {
      const slug = slugify(f.name);
      const hasDoc = await featureHasDoc(release, slug);
      const summary = (f.summary ?? "").slice(0, 220);
      // Narrowed at runtime, not escaped (gendn-b2s): a non-canonical id renders the name as
      // plain text instead of a link — THREAT_MODEL.md invariant #4, renderCommitAnchor shape.
      const csHref = chromeStatusUrl(f.id);
      let docTag: string;
      if (hasDoc) {
        docTag = referenceTag(release, slug);
      } else {
        const cross = identityIndex.get(String(f.id));
        docTag = cross
          ? crossReferenceTag(cross)
          : `<span class="tag tag-pending">doc pending</span>`;
      }
      return `<li class="demo-card">
        ${
        csHref
          ? `<h3><a href="${csHref}" target="_blank" rel="noopener">${escapeHTML(f.name)}</a></h3>`
          : `<h3>${escapeHTML(f.name)}</h3>`
      }
        <p>${escapeHTML(summary)}${summary.length === 220 ? "..." : ""}</p>
        <div class="demo-tags">
          <span class="tag">${escapeHTML(categoryTag(group.category))}</span>
          ${docTag}
        </div>
      </li>`;
    }));
    return `<section>
      <h3 class="group-title">${
      escapeHTML(categoryTag(group.category))
    } <span class="group-count">(${group.features.length})</span></h3>
      <ol class="demo-list">${cards.join("")}</ol>
    </section>`;
  }));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>chrome ${milestone} reference — gendn</title>
  <link rel="stylesheet" href="/public/styles.css">
</head>
<body>
<main>
  <p class="crumbs"><a href="/">&larr; all releases</a></p>

  <header class="lede-block">
    <p class="eyebrow">chrome ${milestone}</p>
    <h1>chrome ${milestone} api reference</h1>
    <p class="lede">${features.total} features tracked. Each card links to the gendn reference where MDN doesn't yet cover the API, or out to MDN where it does.</p>
  </header>

  <section>
    <h2>features (${features.total})</h2>
    ${sections.join("\n")}
  </section>

  <footer class="byline">made by <a href="https://paul.kinlan.me/" target="_blank" rel="noopener">Paul Kinlan</a></footer>
</main>
</body>
</html>`;
}

// ----- /features (flat, filterable catalogue) -----

async function renderFeaturesCatalogue(channels: Channels): Promise<string> {
  const known = [...await knownReleaseMilestones(channels)].sort((a, b) => b - a);

  // PARALLEL, ORDER-PRESERVING (gendn-4ti): milestones are fetched concurrently and the
  // per-feature doc checks run through a bounded pool. The previous shape awaited every milestone
  // in turn and then every Deno.stat one after another, so the response was the SUM of the
  // milestone fetches followed by hundreds of serial stat() syscalls before the first HTML byte.
  // renderReleasePage next door already parallelised the identical work, so the serial loop was
  // an asymmetry rather than a deliberate bound.
  //
  // Order is preserved by construction: Promise.all keeps `known`'s (descending) milestone order,
  // the flatten below appends in that same order, mapPool returns results in input order, and the
  // filter keeps it — so the rows array is byte-for-byte the same list it was before.
  //
  // Error semantics are unchanged: the try/catch is INSIDE the per-milestone mapper, so a
  // milestone whose fetch fails yields [] and is skipped (an all-or-nothing Promise.all here would
  // turn one upstream failure into a blank page, which would be a regression).
  type Row = {
    mstone: number;
    id: number;
    name: string;
    summary: string;
    category: string;
    hasDoc: boolean;
  };

  const perMilestone = await Promise.all(
    known.map(async (m) => {
      try {
        return { m, feats: await getMilestoneFeatures(m) };
      } catch {
        // skip milestones we can't fetch
        return { m, feats: null };
      }
    }),
  );

  // Flatten in milestone order, then run ONE global pool over every doc check. A pool per
  // milestone would multiply: ~10 concurrent milestones x 32 = up to ~320 stats in flight, which
  // the first version of this fix actually produced (measured max in-flight 67 cold / 270 warm
  // against an intended ceiling of 32). One pool over the whole flat list keeps the bound global
  // while still preserving row order, because mapPool returns results in input order.
  type MilestoneFeatures = Awaited<ReturnType<typeof getMilestoneFeatures>>;
  type Group = MilestoneFeatures["groups"][number];
  type Feature = Group["features"][number];
  const items: { m: number; g: Group; f: Feature }[] = [];
  for (const { m, feats } of perMilestone) {
    if (!feats) continue;
    for (const g of feats.groups) {
      for (const f of g.features) items.push({ m, g, f });
    }
  }

  const checked = await mapPool(items, IO_CONCURRENCY, async ({ m, g, f }) => {
    const slug = slugify(f.name);
    const hasDoc = await featureHasDoc(`v${m}`, slug);
    // The catalogue is the index of what's actually been written.
    // Pending APIs still show up on the per-release pages.
    if (!hasDoc) return null;
    return {
      mstone: m,
      id: f.id,
      name: f.name,
      summary: f.summary ?? "",
      category: g.category,
      hasDoc,
    } as Row;
  });
  const rows: Row[] = checked.filter((r): r is Row => r !== null);

  const tableRows = rows.map((r) => {
    const slug = slugify(r.name);
    const cat = categoryTag(r.category);
    // Narrowed at runtime, not escaped (gendn-sxn / THREAT_MODEL.md invariant #4).
    const mstone = milestonePathSegment(r.mstone);
    const docHref = mstone ? `/v${mstone}/${escapeHTML(slug)}/` : "#";
    const docCell = r.hasDoc
      ? `<a class="tag tag-live" href="${docHref}">reference &rarr;</a>`
      : `<span class="tag tag-pending">pending</span>`;
    const searchMstone = mstone ?? "";
    const search = `${r.name} ${r.summary} ${cat} v${searchMstone}`.toLowerCase();
    // Narrowed at runtime, not escaped (gendn-b2s) — see renderReleasePage.
    const csHref = chromeStatusUrl(r.id);
    const mstoneAttr = mstone ? ` data-mstone="${mstone}"` : "";
    const statusText = mstone
      ? `v${mstone}`
      : (r.mstone !== undefined && r.mstone !== null
        ? `v${escapeHTML(String(r.mstone))}`
        : "unknown");
    return `<tr data-search="${escapeHTML(search)}"${mstoneAttr} data-status="${
      escapeHTML(cat)
    }" data-doc="${r.hasDoc}">
      <td>${
      csHref
        ? `<a href="${csHref}" target="_blank" rel="noopener">${escapeHTML(r.name)}</a>`
        : escapeHTML(r.name)
    }</td>
      <td><span class="release-status">${statusText}</span></td>
      <td><span class="tag">${escapeHTML(cat)}</span></td>
      <td>${docCell}</td>
    </tr>`;
  }).join("");

  const mstoneOptions = known
    .map((m) => {
      const seg = milestonePathSegment(m);
      return seg ? `<option value="${seg}">v${seg}</option>` : "";
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>all features — gendn</title>
  <link rel="stylesheet" href="/public/styles.css">
  <style>
    main { max-width: 1100px; }
    .filters {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
      margin: 1rem 0 1.5rem;
      padding: 1rem;
      background: var(--bg-paper);
      border: 2px solid var(--border-black);
      box-shadow: var(--thin-shadow);
    }
    .filters input, .filters select {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      padding: 0.45rem 0.6rem;
      background: var(--bg-paper);
      color: var(--text-black);
      border: 2px solid var(--border-black);
      outline: none;
    }
    .filters input:focus { box-shadow: var(--thin-shadow); }
    .filters input[type=search] { flex: 1; min-width: 160px; }
    .features-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .features-table th, .features-table td { padding: 0.6rem 0.6rem; text-align: left; border-bottom: 1px solid var(--border-black); vertical-align: top; }
    .features-table th {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
      background: var(--bg-stone);
    }
    .features-table tr.hidden { display: none; }
    .features-table td a { color: var(--text-black); text-decoration: underline; text-underline-offset: 3px; }
    .features-table td a:hover { color: var(--accent-blue); }
    .features-table td .tag, .features-table td .release-status { font-family: var(--font-mono); }
    .features-table td .release-status { background: var(--text-black); color: var(--bg-ivory); padding: 0.15rem 0.5rem; font-size: 0.75rem; }
    .stats { font-family: var(--font-mono); font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.5rem; }

    @media (max-width: 640px) {
      main { padding-left: var(--space-4); padding-right: var(--space-4); }
      .features-table thead { display: none; }
      .features-table, .features-table tbody, .features-table tr, .features-table td {
        display: block;
        width: 100%;
      }
      .features-table tr {
        border: 2px solid var(--border-black);
        background: var(--bg-paper);
        margin-bottom: var(--space-3);
        padding: var(--space-3);
        box-shadow: var(--thin-shadow);
      }
      .features-table td {
        border: none;
        padding: 0.25rem 0;
      }
      .features-table td:first-child { font-weight: 600; padding-bottom: var(--space-2); }
      .features-table td:not(:first-child) {
        display: inline-block;
        margin-right: var(--space-2);
      }
      .filters { padding: var(--space-3); gap: var(--space-2); }
      .filters input, .filters select { flex: 1 1 100%; min-width: 0; }
    }
  </style>
</head>
<body>
<main>
  <p class="crumbs"><a href="/">&larr; home</a></p>

  <header class="lede-block">
    <p class="eyebrow">catalogue</p>
    <h1>all apis</h1>
    <p class="lede">Every API with a written reference, across every milestone. Filter by name, milestone, or status. Pending APIs still show up on the per-release pages.</p>
  </header>

  <div class="filters">
    <input type="search" id="q" placeholder="search by name, summary, category">
    <select id="mstone">
      <option value="">all milestones</option>
      ${mstoneOptions}
    </select>
    <select id="status">
      <option value="">any status</option>
      <option value="Shipped">Shipped</option>
      <option value="Origin Trial">Origin Trial</option>
      <option value="Dev Trial">Dev Trial</option>
      <option value="Stepped rollout">Stepped rollout</option>
    </select>
  </div>

  <p class="stats"><span id="visible">${rows.length}</span> / ${rows.length} references</p>

  <table class="features-table">
    <thead>
      <tr><th>api</th><th>milestone</th><th>status</th><th>doc</th></tr>
    </thead>
    <tbody id="rows">${tableRows}</tbody>
  </table>

  <script>
    const q = document.getElementById('q');
    const mstone = document.getElementById('mstone');
    const status = document.getElementById('status');
    const rows = document.querySelectorAll('#rows tr');
    const visible = document.getElementById('visible');

    function applyFilter() {
      const qv = q.value.toLowerCase().trim();
      const mv = mstone.value;
      const sv = status.value;
      let count = 0;
      for (const row of rows) {
        const search = row.dataset.search;
        const okq = !qv || search.includes(qv);
        const okm = !mv || row.dataset.mstone === mv;
        const oks = !sv || row.dataset.status === sv;
        const show = okq && okm && oks;
        row.classList.toggle('hidden', !show);
        if (show) count++;
      }
      visible.textContent = count;
    }

    q.addEventListener('input', applyFilter);
    mstone.addEventListener('change', applyFilter);
    status.addEventListener('change', applyFilter);
  </script>

  <footer class="byline">made by <a href="https://paul.kinlan.me/" target="_blank" rel="noopener">Paul Kinlan</a></footer>
</main>
</body>
</html>`;
}

async function knownReleaseMilestones(channels: Channels): Promise<Set<number>> {
  const set = new Set<number>();
  for (
    const raw of [
      channels.stable.mstone - 1,
      channels.stable.mstone,
      channels.beta.mstone,
      channels.dev.mstone,
    ]
  ) {
    const seg = milestonePathSegment(raw);
    if (seg !== null) set.add(Number(seg));
  }
  try {
    for await (const entry of Deno.readDir(".")) {
      if (entry.isDirectory && /^v\d+$/.test(entry.name)) {
        const seg = milestonePathSegment(entry.name.slice(1));
        if (seg !== null) set.add(Number(seg));
      }
    }
  } catch {
    // ignore
  }
  return set;
}

// ----- Defensive browser security headers (gendn-5tk) -----
//
// Threat-model findings addressed:
//   - No browser security headers (notably CSP) on server responses
//   - No defense-in-depth security headers (CSP, nosniff, Referrer-Policy) on any response
//
// Directives chosen deliberately against what gendn pages actually load:
//   - default-src 'self': Restrict unspecified resource types to same-origin.
//   - script-src 'self' 'sha256-KuiJqU/ZOCGu7VsWUb6EUZO+z/j7PyH/zkKtY2HByvg=':
//       The only JavaScript across the entire site is the client-side table filter on /features.
//       Rather than disabling protection wholesale with 'unsafe-inline', the allowance is
//       scoped strictly to the exact SHA-256 hash of that inline script. No external scripts.
//   - style-src 'self' 'unsafe-inline':
//       Allows /public/styles.css plus inline <style> blocks and style="" attributes present
//       across all 201 reference pages in v<N>/ and SSR templates for per-feature layout.
//   - font-src 'self' https://fonts.gstatic.com:
//       Allows local font assets (e.g. /fonts/avar2-demo.woff2) and Google Fonts woff2 sources
//       referenced in public/styles.css.
//   - img-src 'self' data::
//       Allows same-origin image assets and data-URI SVG/raster images.
//   - frame-src 'self' https://chrome-platform-showcase.paulkinlan-ea.deno.net:
//       Allows embedding live interactive concept demos from the companion site
//       chrome-platform-showcase (embedded by 24 reference pages across v147-v154).
//   - connect-src 'self': Restricts fetch, XHR, and WebSocket connections to same-origin.
//   - object-src 'none': Disallows plugin objects (Flash, Java, Silverlight).
//   - base-uri 'self': Prevents <base href="..."> injection hijacking.
//   - form-action 'self': Restricts form submissions to same-origin.
//   - frame-ancestors 'self': Prevents clickjacking by disallowing framing from third-party sites.
//
// Defense-in-depth headers:
//   - X-Content-Type-Options: nosniff (prevents MIME sniffing)
//   - Referrer-Policy: strict-origin-when-cross-origin (protects outbound referrers)
//   - X-Frame-Options: SAMEORIGIN (clickjacking protection for older UAs without CSP frame-ancestors)

export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'sha256-KuiJqU/ZOCGu7VsWUb6EUZO+z/j7PyH/zkKtY2HByvg='",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "frame-src 'self' https://chrome-platform-showcase.paulkinlan-ea.deno.net",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
];

export const CSP_HEADER_VALUE = CSP_DIRECTIVES.join("; ");

export function addSecurityHeaders(res: Response): Response {
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  res.headers.set("content-security-policy", CSP_HEADER_VALUE);
  res.headers.set("x-frame-options", "SAMEORIGIN");
  return res;
}

export async function handleRequest(req: Request): Promise<Response> {
  // A malformed request URL is a handled 400, not an unhandled throw (gendn-7xq); the message is
  // generic so nothing from the request is reflected.
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const path = url.pathname;

  // Durable-demo contract: 301 old (pre-contract) routes to their current page. Checked before
  // everything else so a moved route never 404s.
  const target = redirectTarget(path);
  if (target) {
    return new Response(null, {
      status: 301,
      headers: { location: target + url.search },
    });
  }

  // gendn serves no favicon; answer the browser's automatic request with 204 so it isn't a 404
  // (keeps the conformance runner's same-origin network scan clean).
  if (path === "/favicon.ico") return new Response(null, { status: 204 });

  // ----- critique + conformance lifecycle views (additive, read-only) -----
  if (path === "/conformance" || path === "/conformance/") {
    try {
      return new Response(await renderConformanceIndex(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (err) {
      // Deliberate, and do not "fix" this to 500 (gendn-lde): a LOCAL server-side render error
      // keeps the same 502 that serverError returns everywhere else. 500 is more idiomatic for
      // a local SSR failure, but 502 is the established behaviour of this route on main and any
      // health check keyed on it must not flip as a side effect of an error-handling hygiene
      // change. Changing this status is a health-check surface decision, not a cleanup.
      return serverError(req, "render conformance index", err);
    }
  }
  if (path === "/conformance/run-all" || path === "/conformance/run-all/") {
    const html = await renderRunAll();
    return html
      ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response("No run-all rollup generated yet (run: deno task conformance)", {
        status: 404,
      });
  }
  const lifecycleMatch = path.match(/^\/(v\d+)\/([a-z0-9-]+)\/(conformance|critique)\/?$/);
  if (lifecycleMatch) {
    const [, release, slug, kind] = lifecycleMatch;
    const html = kind === "conformance"
      ? await renderSuite(release, slug)
      : await renderCritique(release, slug);
    return html
      ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response(`No ${kind} for ${release}/${slug} yet`, { status: 404 });
  }

  if (path === "/" || path === "/index.html") {
    try {
      const channels = await getChannels();
      return new Response(await renderIndex(channels), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (err) {
      return serverError(req, "render index", err);
    }
  }

  if (path === "/features" || path === "/features/") {
    try {
      const channels = await getChannels();
      return new Response(await renderFeaturesCatalogue(channels), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (err) {
      return serverError(req, "render features", err);
    }
  }

  if (path.startsWith("/public/")) return readPublicAsset(path);

  const releaseMatch = path.match(/^\/(v\d+)(\/.*)?$/);
  if (releaseMatch) {
    const release = releaseMatch[1];
    const milestone = Number(release.slice(1));
    const sub = releaseMatch[2] ?? "/";

    let channels: Channels;
    try {
      channels = await getChannels();
    } catch (err) {
      return serverError(req, "load channels", err);
    }

    const known = await knownReleaseMilestones(channels);
    if (!known.has(milestone)) {
      return new Response(`Release ${release} not configured yet`, { status: 404 });
    }

    if (sub === "/" || sub === "/index.html") {
      try {
        return new Response(await renderReleasePage(release, milestone), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch (err) {
        return serverError(req, `render release ${release}`, err);
      }
    }

    return (await readReleaseAsset(release, sub)) ??
      new Response("Not found", { status: 404 });
  }

  return new Response("Not found", { status: 404 });
}

if (import.meta.main) {
  const server = Deno.serve({ port: PORT }, async (req) => {
    try {
      const res = await handleRequest(req);
      return addSecurityHeaders(res);
    } catch (err) {
      return addSecurityHeaders(serverError(req, "unhandled request", err));
    }
  });

  console.log(`Listening on http://localhost:${server.addr.port}`);
}
