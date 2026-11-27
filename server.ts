// gendn — generated reference docs for web platform APIs shipping in Chrome
// that don't yet have a page on MDN.
//
// Same layout convention as chrome-platform-showcase: per-release folders
// at v<N>/<api-slug>/index.html. The index lists every API by release and
// flags each as "on MDN → link out" or "generated here → link to local page".

import {
  type Channels,
  chromeStatusUrl,
  fetchBounded,
  getChannels,
  getMilestoneFeatures,
  milestonePathSegment,
  slugify,
} from "./lib/chromestatus.ts";
import { renderCommitAnchor } from "./lib/external-url.ts";
import {
  FEATURES_FILTER_SCRIPT_SHA256,
  type FeaturesCatalogueRow,
  renderFeaturesCatalogueHtml,
} from "./lib/features-ux.ts";
import { escapeHTML } from "./lib/html.ts";
import {
  renderConformanceIndex,
  renderCritique,
  renderRunAll,
  renderSuite,
} from "./lib/lifecycle.ts";
import { siteFS } from "./lib/site-fs.ts";
import {
  buildFeaturesApiJson,
  getPrecomputedMeta,
  getSiteIdentityIndex,
  getSitePages,
  renderAtomFeedXml,
  renderLlmsTxt,
  renderRobotsTxt,
  renderSitemapXml,
  safeRequestOrigin,
} from "./lib/site-index.ts";
// Bundled at build time (Workers have no filesystem); Node loads it as a JSON module.
import MIGRATIONS from "./migrations.json" with { type: "json" };

// ----- Durable-demo route aliases (301 redirects) -----
//
// migrations.json is the single source of truth for the compatibility contract (see AGENTS.md /
// CLAUDE.md). Every `move`/`alias` record keeps an OLD published route alive with a permanent
// redirect to the CURRENT route for the same chromestatus feature id, so pre-contract slug/milestone
// corrections don't 404 old inbound links. `remove` records are provenance only (no redirect).
// Don't hand-maintain a second list — this reads migrations.json directly.

export interface Migration {
  id: string;
  action:
    | "move"
    | "alias"
    | "remove"
    | "identity-change"
    | "assertion-migrate"
    | "support-change"
    | string;
  from?: string;
  to?: string | null;
  reason?: string;
  evidence?: string;
  date?: string;
  assertion?: string;
}

export function validateMigrationRecord(m: Migration): void {
  if ((m.action === "move" || m.action === "alias") && m.from) {
    if (!m.from.endsWith("/")) {
      throw new Error(
        `Migration ${
          m.id ?? "(unknown)"
        }: action "${m.action}" from "${m.from}" must end in '/' (path boundary invariant; non-slash prefix matches unrelated routes)`,
      );
    }
  }
}

export function loadRedirects(
  source: unknown = MIGRATIONS,
): { from: string; to: string }[] {
  const migrations = source as Migration[];
  if (!Array.isArray(migrations)) {
    throw new Error("migrations.json must be an array");
  }
  for (const m of migrations) {
    validateMigrationRecord(m);
  }
  return migrations
    .filter((m) => (m.action === "move" || m.action === "alias") && m.from && m.to)
    .map((m) => ({ from: m.from as string, to: m.to as string }));
}

export const REDIRECTS = loadRedirects();

// Returns the 301 target for a request path if it falls under an aliased old route, else null.
// Matches the old route exactly (with or without trailing slash) and any deep link under it,
// carrying the remaining sub-path over to the new route. Only applies prefix matching when
// 'from' ends in '/', enforcing the path boundary invariant (gendn-exxi).
export function redirectTarget(
  path: string,
  redirects: { from: string; to: string }[] = REDIRECTS,
): string | null {
  for (const { from, to } of redirects) {
    const fromNoSlash = from.endsWith("/") ? from.slice(0, -1) : from;
    const fromWithSlash = from.endsWith("/") ? from : `${from}/`;
    if (path === fromNoSlash || path === fromWithSlash) return to;
    if (from.endsWith("/") && path.startsWith(from)) return to + path.slice(from.length);
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
  const precomputed = getPrecomputedMeta()?.commit;
  if (precomputed) return precomputed;
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

// gendn-gt7, gendn-izwu: Routine-authored release trees (v<N>/) and developer-curated public
// assets (/public/) must never serve executable first-party script MIME types. Under the global
// CSP (script-src 'self' + inline hashes), any same-origin script served with a script MIME
// would be 'self'-eligible and EXECUTE on this origin (measured in a real browser 2026-10-07 for
// gt7; measured 2026-10-07 for izwu on /public/*.js). Static asset trees ship no first-party
// executable scripts (verified: zero .js files under v*/, only styles.css under public/), so
// script MIME types are served INERT across both readReleaseAsset and readPublicAsset:
// text/plain + the global X-Content-Type-Options: nosniff makes browsers refuse to execute the
// response as a script. If executable first-party JS is ever legitimately needed, that is a
// deliberate, reviewed decision (change this map and THREAT_MODEL §4.3 together).
export const RELEASE_INERT_SCRIPT_MIME: Record<string, string> = {
  js: "text/plain; charset=utf-8",
  mjs: "text/plain; charset=utf-8",
  cjs: "text/plain; charset=utf-8",
};

export async function readPublicAsset(path: string): Promise<Response> {
  // DEFENSE IN DEPTH ONLY (gendn-d7a): symmetric with readReleaseAsset's guard below. The
  // nightly vuln-discovery and vuln-verify stations both judged directory traversal SAFE
  // here because the URL is normalised before use — this guard adds no behaviour change
  // beyond the same explicit early-exit its sibling already has.
  if (path.includes("..")) return new Response("Not found", { status: 404 });
  try {
    const file = await siteFS().readFile(path);
    if (file === null) return new Response("Not found", { status: 404 });
    const ext = path.split(".").pop() ?? "";
    return new Response(file, {
      headers: {
        "content-type": RELEASE_INERT_SCRIPT_MIME[ext] ?? MIME[ext] ??
          "application/octet-stream",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// The file /favicon.ico answers with. The path is a constant, never derived from the request.
const FAVICON_SOURCE = "public/favicon.svg";

// /favicon.ico: the SVG icon, read through siteFS() exactly like a /public/ asset so the Worker
// (static-assets binding) and the Node dev server answer alike. The URL keeps its .ico name but
// the content-type is the authority (every response carries nosniff), and it is an ordinary 200,
// so serveRequest() gives it the security headers and an ETag like any other asset.
// If the file is missing or unreadable the answer is 204, never 404 or 500: the request is one
// the browser makes unprompted, and a failed same-origin request would turn the conformance
// runner's network scan red on every page for a cosmetic asset.
async function readFavicon(): Promise<Response> {
  try {
    const file = await siteFS().readFile(FAVICON_SOURCE);
    if (file !== null) return new Response(file, { headers: { "content-type": MIME.svg } });
  } catch {
    // fall through to the bodiless answer
  }
  return new Response(null, { status: 204 });
}

async function readReleaseAsset(release: string, sub: string): Promise<Response | null> {
  if (sub.includes("..")) return null;
  let key = sub.replace(/^\/+/, "");
  if (!key) return null;
  if (key.endsWith("/")) key += "index.html";
  else if (!/\.[a-z0-9]+$/i.test(key)) key += "/index.html";
  try {
    const file = await siteFS().readFile(`${release}/${key}`);
    if (file === null) return null;
    const ext = key.split(".").pop() ?? "";
    return new Response(file, {
      headers: {
        "content-type": RELEASE_INERT_SCRIPT_MIME[ext] ?? MIME[ext] ??
          "application/octet-stream",
      },
    });
  } catch {
    return null;
  }
}

// ----- Index page -----

// Speculation rules prefetch declaration for reference-doc navigation (gendn-xdw).
// Moderate eagerness gates requests on reader intent (hover/pointerdown); prerender is off
// so cross-origin showcase iframes are not triggered speculatively.
export const SPECULATION_RULES =
  '<script type="speculationrules">{"prefetch":[{"source":"document","where":{"href_matches":"/v*/**"},"eagerness":"moderate"}]}</script>';

function renderSeoHead({
  title,
  description,
  path,
  origin,
}: {
  title: string;
  description: string;
  path: string;
  origin?: string;
}): string {
  const canonical = origin ? `${origin}${path}` : path;
  return [
    `<meta name="description" content="${escapeHTML(description)}">`,
    `<link rel="canonical" href="${escapeHTML(canonical)}">`,
    `<meta property="og:title" content="${escapeHTML(title)}">`,
    `<meta property="og:description" content="${escapeHTML(description)}">`,
    `<meta property="og:type" content="website">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link rel="icon" type="image/svg+xml" href="/public/favicon.svg">`,
  ].join("\n  ");
}

function renderSiteNav(current: "home" | "features" | "release" | "conformance"): string {
  const link = (href: string, label: string, key?: typeof current) =>
    `<a href="${href}"${key && key === current ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<nav class="site-nav" aria-label="Site navigation">
    <a class="site-nav-brand" href="/">gendn</a>
    <div class="site-nav-links">
      ${link("/features", "All APIs", "features")}
      ${link("/conformance", "Conformance", "conformance")}
      ${link("/llms.txt", "llms.txt")}
    </div>
  </nav>`;
}

export async function renderIndex(channels: Channels, origin?: string): Promise<string> {
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
    for (const entry of await siteFS().readDir(".")) {
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
    const releaseAttrs = mstone
      ? `href="/v${milestonePathSegment(r.mstone)}/"`
      : 'aria-disabled="true"';
    const releaseLabel = mstone ? `Chrome ${mstone}` : `Chrome ${escapeHTML(String(r.mstone))}`;
    return `<li class="release-card">
      <a class="release-card-link" ${releaseAttrs}>
        <span class="release-card-row">
          <span class="release-label">${releaseLabel}</span>
          <span class="release-status">${escapeHTML(r.status)}</span>
        </span>
        <span class="release-note">${escapeHTML(note)}</span>
      </a>
    </li>`;
  }).join("");

  const pageTitle = "gendn — generated web platform docs";
  const pageDescription =
    "Generated reference docs for Chrome web platform APIs that do not yet have a page on MDN, derived from ChromeStatus, specs, explainers, and Chromium IDL.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  ${renderSeoHead({ title: pageTitle, description: pageDescription, path: "/", origin })}
  <link rel="stylesheet" href="/public/styles.css">
  ${SPECULATION_RULES}
</head>
<body>
  <main>
    ${renderSiteNav("home")}
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
      <p class="note">Sister project: <a href="https://chrome-platform-showcase.kinlan-test.workers.dev/" target="_blank" rel="noopener">chrome-platform-showcase</a> — interactive demos for the same set of features. Repo: <a href="https://github.com/PaulKinlan/gendn" target="_blank" rel="noopener">PaulKinlan/gendn</a>.</p>
    </section>

    <footer class="byline">made by <a href="https://paul.kinlan.me/" target="_blank" rel="noopener">Paul Kinlan</a></footer>
  </main>
</body>
</html>`;
}

// ----- Per-release index -----

async function featureHasDoc(release: string, slug: string): Promise<boolean> {
  return await siteFS().exists(`${release}/${slug}/index.html`);
}

// ----- Cross-release identity index -----
// Identity is the chromestatus feature id (invariant #1), not the milestone folder. When a
// feature's listing drifts to a later milestone (or appears in two listings), the page already
// built under an earlier release is the canonical reference — the listing must link it rather
// than flag a false "doc pending". Served from precomputed build metadata on Workers, or built
// lazily once per SiteFS in Node dev (lib/site-index.ts).
// Bounds concurrent independent I/O. Used by the /features catalogue's per-feature doc checks
// (and mirrored in lib/site-index.ts).
const IO_CONCURRENCY = 32;

// chromestatus.com JSON is an untrusted upstream (THREAT_MODEL.md §2), bounded only by the 8 MiB
// fetchBounded ceiling per response — NOT per field. Summaries feed SSR output (release-page prose,
// catalogue data-search), so both surfaces cap the field at the same length (gendn-1krm; the exact
// guarantee is stated once, below, with the other field caps).
const SUMMARY_CAP = 220;
// gendn-kow4: the same hazard class holds for the other free-text fields on the same rows.
// f.name feeds release-page headings, catalogue cells and data-search; g.category feeds group
// titles, data-status and the same search string — capping summary alone left either field able
// to reflect a multi-hundred-KB payload into one combined response that withRevalidation buffers
// and hashes whole (measured by the reviewer: one 200 KB name → a 406 KB /features document).
// Names share summary's 220 — a title's whole legitimate display+search need, and every real
// chromestatus name is far below it. The longest legitimate category string is "In developer
// trial (Behind a flag)" (35 chars), so 96 is ~3x margin. Slug derivation is deliberately NOT
// capped: slugify() already bounds its own output (80 chars) and route resolution must not depend
// on a display cap — rows carry the slug computed from the raw name.
//
// EXACT GUARANTEE (gendn-kow4, replacing the earlier blanket claim): these caps bound each
// free-text field's CONTRIBUTION to an SSR response — no single name, summary, or category can
// reflect more than its cap into a document, so the per-field amplification path is closed.
// They do NOT bound the document total: row count is unbounded upstream and the optional
// total-size bound was explicitly declined in gendn-1krm. Ids and milestones are separately
// runtime-narrowed (chromeStatusUrl/milestonePathSegment).
//
// TRUNCATION IS SIGNALLED, never silent (gendn-kow4): every cap here that drops bytes appends
// "..." at its visible render point — the convention the release-page summary cap already
// established — and catalogue rows additionally carry data-truncated="name category" naming
// the fields that were cut. Machine-facing attributes stay clean: data-search/data-status hold
// the capped value WITHOUT the marker, because the status filter is exact-match equality and
// search text must not grow marker noise; the visible cells in the same row carry the "...".
// The pre-existing catalogue summary cap signals nowhere (summary has no visible cell there,
// data-search only) and tests raw === cap rather than > cap on the release page — that
// inconsistency belongs to gendn-d3mt and is deliberately untouched here, as is the summary
// cap's value and visible behaviour.
const NAME_CAP = 220;
const CATEGORY_CAP = 96;

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
  return getSiteIdentityIndex();
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

export async function renderReleasePage(
  release: string,
  milestone: number,
  origin?: string,
): Promise<string> {
  const features = await getMilestoneFeatures(milestone);
  const identityIndex = await getIdentityIndex();

  const sections = await Promise.all(features.groups.map(async (group) => {
    // Categories arrive as features_by_type object keys; the longest legitimate one is 35 chars
    // ("In developer trial (Behind a flag)"), known-phrase mapping included (gendn-kow4). One
    // derivation per group serves both the card tag and the group title below.
    const cat = categoryTag(group.category.slice(0, CATEGORY_CAP));
    const catCut = group.category.length > CATEGORY_CAP;
    const cards = await Promise.all(group.features.map(async (f) => {
      // Runtime narrow, not coerce (gendn-iued, the gendn-25hn disposition one field over): the
      // declared `name: string` on FeatureSummary is a compile-time claim about untrusted JSON
      // (getJson casts unchecked). EVERY consumer below requires a string — slugify() throws on
      // a non-string (s.toLowerCase), and escapeHTML would throw the same way — so a malformed
      // name (null/number/object) used to 502 the whole release page from the first consumer.
      // The narrowing is a TYPE GUARD ONLY (gendn-iz07): rawName keeps the RAW string and the
      // slug derives from THAT (the gendn-kow4 contract — route resolution never depends on a
      // display cap, and a >NAME_CAP name must still resolve its document; slugifying the
      // capped value lost rows whose first 220 chars slugify differently); only what is
      // displayed is capped, below. A non-string degrades to "" (empty heading, slug "",
      // doc-pending card) — THREAT_MODEL.md §4.1 disposition, same shape as the summary line
      // below.
      const rawName = typeof f.name === "string" ? f.name : "";
      const slug = slugify(rawName);
      const hasDoc = await featureHasDoc(release, slug);
      // Runtime narrow, not just ?? (gendn-25hn): the declared string type is a compile-time claim
      // only (getJson casts unchecked), and ?? passes a non-string through to .slice(), which threw
      // and took the whole release page down (502). Non-string degrades to "" — THREAT_MODEL.md §4.1
      // disposition, same shape as chromeStatusUrl()/milestonePathSegment().
      const summary = typeof f.summary === "string" ? f.summary.slice(0, SUMMARY_CAP) : "";
      // Same per-field class as the summary cap (gendn-kow4): the heading is the whole display
      // need for the name, so an oversized upstream name stops at NAME_CAP — while the slug
      // above keeps deriving from the RAW string, so the card still links the true route
      // (gendn-iz07).
      const name = rawName.slice(0, NAME_CAP);
      // Truncation signal (gendn-kow4 + iued): raw length > cap is the honest test, computed
      // from the raw value ONLY when it is actually a string — a value that was never a string
      // is absent, not truncated, and must not grow a "..." marker. The release-page summary's
      // === test is pre-existing behaviour left for gendn-d3mt; new caps use the correct
      // comparison.
      const nameCut = rawName.length > NAME_CAP;
      // Narrowed at runtime, not escaped (gendn-b2s): a non-canonical id renders the name as
      // plain text instead of a link — THREAT_MODEL.md invariant #4, renderCommitAnchor shape.
      const csHref = chromeStatusUrl(f.id);
      const cross = hasDoc ? undefined : identityIndex.get(String(f.id));
      const localDocHref = hasDoc
        ? `/${escapeHTML(release)}/${escapeHTML(slug)}/`
        : cross
        ? escapeHTML(cross)
        : null;
      let docTag: string;
      if (hasDoc) {
        docTag = referenceTag(release, slug);
      } else {
        docTag = cross
          ? crossReferenceTag(cross)
          : `<span class="tag tag-pending">doc pending</span>`;
      }
      const headingText = `${escapeHTML(name)}${nameCut ? "..." : ""}`;
      const headingHtml = localDocHref
        ? `<h3><a href="${localDocHref}">${headingText}</a></h3>`
        : csHref
        ? `<h3><a href="${csHref}" target="_blank" rel="noopener">${headingText}</a></h3>`
        : `<h3>${headingText}</h3>`;
      const csTag = localDocHref && csHref
        ? `<a class="tag" href="${csHref}" target="_blank" rel="noopener">ChromeStatus &#8599;</a>`
        : "";
      return `<li class="demo-card">
        ${headingHtml}
        <p>${escapeHTML(summary)}${summary.length === SUMMARY_CAP ? "..." : ""}</p>
        <div class="demo-tags">
          <span class="tag">${escapeHTML(cat)}${catCut ? "..." : ""}</span>
          ${docTag}
          ${csTag}
        </div>
      </li>`;
    }));
    const groupId = `group-${slugify(group.category) || "other"}`;
    return {
      groupId,
      cat,
      catCut,
      count: group.features.length,
      html: `<section id="${escapeHTML(groupId)}">
      <h3 class="group-title">${escapeHTML(cat)}${
        catCut ? "..." : ""
      } <span class="group-count">(${group.features.length})</span></h3>
      <ol class="demo-list">${cards.join("")}</ol>
    </section>`,
    };
  }));

  const jumpNav = sections.length > 1
    ? `<nav class="local-nav" aria-label="Jump to category">
    <p class="local-nav-label">On this page</p>
    <ul>${
      sections.map((s) =>
        `<li><a href="#${escapeHTML(s.groupId)}">${escapeHTML(s.cat)}${
          s.catCut ? "..." : ""
        } (${s.count})</a></li>`
      ).join("")
    }</ul>
  </nav>`
    : "";

  const pageTitle = `chrome ${milestone} reference — gendn`;
  const pageDescription =
    `Chrome ${milestone} web platform API reference tracking ${features.total} features from ChromeStatus, linking to gendn references and MDN coverage.`;
  const canonicalSeg = milestonePathSegment(milestone);
  const canonicalPath = canonicalSeg ? `/v${milestonePathSegment(milestone)}/` : `/${release}/`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  ${
    renderSeoHead({
      title: pageTitle,
      description: pageDescription,
      path: canonicalPath,
      origin,
    })
  }
  <link rel="stylesheet" href="/public/styles.css">
  ${SPECULATION_RULES}
</head>
<body>
<main>
  ${renderSiteNav("release")}
  <p class="crumbs"><a href="/">&larr; all releases</a> &middot; <a href="/features">all apis</a></p>

  <header class="lede-block">
    <p class="eyebrow">chrome ${milestone}</p>
    <h1>chrome ${milestone} api reference</h1>
    <p class="lede">${features.total} features tracked. Click any documented API to open its gendn reference (or MDN stub), or open ChromeStatus for upstream tracking.</p>
  </header>

  ${jumpNav}

  <section>
    <h2>features (${features.total})</h2>
    ${sections.map((s) => s.html).join("\n")}
  </section>

  <footer class="byline">made by <a href="https://paul.kinlan.me/" target="_blank" rel="noopener">Paul Kinlan</a></footer>
</main>
</body>
</html>`;
}

// ----- /features (flat, filterable catalogue) -----

export async function renderFeaturesCatalogue(
  channels: Channels,
  origin?: string,
): Promise<string> {
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

  const [perMilestone, sitePages] = await Promise.all([
    Promise.all(
      known.map(async (m) => {
        try {
          return { m, feats: await getMilestoneFeatures(m) };
        } catch {
          // skip milestones we can't fetch
          return { m, feats: null };
        }
      }),
    ),
    getSitePages().catch(() => []),
  ]);
  const pageByRoute = new Map(sitePages.map((p) => [p.route, p]));

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
    // Runtime narrow, not coerce (gendn-iued, the gendn-25hn disposition one field over):
    // slugify() here threw on a non-string name and 502'd the whole catalogue; Row.name then
    // feeds escapeHTML(r.name) and the data-search template in tableRows, all of which require
    // strings too — narrowing once at the head covers every consumer. The narrowing is a TYPE
    // GUARD ONLY (gendn-iz07): rawName keeps the RAW string, the slug derives from THAT
    // (gendn-kow4 contract: route resolution never depends on a display cap — slugifying the
    // capped value dropped rows whose first 220 chars slugify differently), and only Row.name
    // — the displayed/searched value — stops at NAME_CAP. A non-string degrades to "": slug ""
    // has no doc directory (there is no v<N>/index.html), so the row is honestly omitted from
    // the catalogue, which indexes what has actually been written.
    const rawName = typeof f.name === "string" ? f.name : "";
    const slug = slugify(rawName);
    const hasDoc = await featureHasDoc(`v${m}`, slug);
    // The catalogue is the index of what's actually been written.
    // Pending APIs still show up on the per-release pages.
    if (!hasDoc) return null;
    const mSeg = milestonePathSegment(m);
    const meta = mSeg ? pageByRoute.get(`/v${milestonePathSegment(m)}/${slug}/`) : undefined;
    return {
      mstone: m,
      id: f.id,
      name: rawName.slice(0, NAME_CAP),
      slug,
      // Same upstream cap as the release page (gendn-1krm): the summary is only used for the
      // row's data-search string, so 220 chars of search text is the whole legitimate need —
      // the full field would only amplify an oversized upstream payload into /features.
      // Runtime narrow, not just ?? (gendn-25hn): a non-string upstream summary passed through ??
      // threw out of renderFeaturesCatalogue and 502'd the whole catalogue — degrade to "".
      summary: typeof f.summary === "string" ? f.summary.slice(0, SUMMARY_CAP) : "",
      // name/category complete the per-field bound for the whole row (gendn-kow4): both feed
      // the same data-search/data-status attributes and cells that summary does.
      category: g.category.slice(0, CATEGORY_CAP),
      hasDoc,
      nameCut: rawName.length > NAME_CAP,
      categoryCut: g.category.length > CATEGORY_CAP,
      docStatus: meta?.status,
      hasDemo: meta ? Boolean(meta.demo) : undefined,
    } as FeaturesCatalogueRow;
  });
  const rows: FeaturesCatalogueRow[] = checked.filter((r): r is FeaturesCatalogueRow => r !== null);

  return renderFeaturesCatalogueHtml({
    rows,
    knownMilestones: known,
    speculationRulesHtml: SPECULATION_RULES,
    canonicalUrl: origin ? `${origin}/features` : undefined,
  });
}

export async function knownReleaseMilestones(channels: Channels): Promise<Set<number>> {
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
    for (const entry of await siteFS().readDir(".")) {
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
//   - script-src 'self' 'sha256-KuiJqU/ZOCGu7VsWUb6EUZO+z/j7PyH/zkKtY2HByvg=' 'sha256-QwyzFy+aVtqlhWpm/o9TrKyuCXBZ7CCOnC55e6JBn+A=':
//       The client-side table filter on /features, plus the speculation rules prefetch
//       declaration on server-rendered routes (gendn-xdw). Rather than disabling protection
//       wholesale with 'unsafe-inline', each inline script is permitted by its exact SHA-256 hash.
//   - style-src 'self' 'unsafe-inline':
//       Allows /public/styles.css plus inline <style> blocks and style="" attributes present
//       across all 201 reference pages in v<N>/ and SSR templates for per-feature layout.
//   - font-src 'self' https://fonts.gstatic.com:
//       Allows local font assets (e.g. /fonts/avar2-demo.woff2) and Google Fonts woff2 sources
//       referenced in public/styles.css.
//   - img-src 'self' data::
//       Allows same-origin image assets and data-URI SVG/raster images.
//   - frame-src 'self' https://chrome-platform-showcase.kinlan-test.workers.dev:
//       Allows embedding live interactive concept demos from the companion site
//       chrome-platform-showcase. This is the ONLY third-party frame origin: the showcase moved
//       off its retired Deno Deploy host on 2026-11-26 (every path tried there answers 404), so the
//       old origin is not allowed alongside it. scripts/security-headers.test.mjs pins the
//       directive to exactly these two sources.
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
  `script-src 'self' ${FEATURES_FILTER_SCRIPT_SHA256} 'sha256-QwyzFy+aVtqlhWpm/o9TrKyuCXBZ7CCOnC55e6JBn+A='`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "frame-src 'self' https://chrome-platform-showcase.kinlan-test.workers.dev",
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

// ----- Transport: automatic compression + revalidation caching (gendn-3ux) -----
//
// Two transport headers were missing. Neither is visible in a status code, which is the whole shape of
// this defect: the bug IS a 200 whose transport is wrong.
//
// 1. COMPRESSION. Every page used to ship raw. Compression is the RUNTIME's job, not application
//    code in this file: Cloudflare compresses at the edge in production, and the Node dev entry
//    (serve.ts) negotiates br/gzip the same way so the transport fixtures see what production
//    sends. serveRequest() itself never encodes a body. Measured over the repo's own bytes:
//    201 index.html files, raw mean 11.8KB / median 7.1KB vs gzip-6 mean 3.4KB / median 2.4KB (~3.5x),
//    with the largest routes far bigger (/features ~194KB, a hub route ~21KB).
//
// 2. REVALIDATION. Nothing set cache-control, so every back-navigation refetched the entire document.
//    A validator is derived from the body bytes and `no-cache` makes clients REVALIDATE instead of
//    refetching, so a repeat navigation costs one conditional request and a 304 with no body. The
//    If-None-Match comparison below is required for that to be worth anything: with a validator but no
//    304 branch the server would answer every revalidation with the full body again, so the header alone
//    would save nothing. Weak (W/) because the same content is legitimately served under different
//    content-codings once compression is on, which is exactly what a weak validator asserts. `no-cache`
//    rather than a max-age because it keeps every response fresh and so needs no decision about how much
//    staleness is acceptable.
//
// ONLY SUCCESSFUL REPRESENTATIONS ARE REVALIDATED. A 404 or a 500 has no current representation, and
// RFC 9110 13.1.2 says the `If-None-Match: *` condition is FALSE only when the server DOES have a
// current representation - so "*" on a missing route must let the 404 through, not answer "Not
// Modified". Hashing the error body and matching "*" against it (the first form of this function) turned
// every conditional request for a nonexistent resource into a 304, which tells a cache the resource is
// there. Measured before the guard: /__definitely_missing__ with If-None-Match: * answered 304.
const REVALIDATION_CACHE_CONTROL = "no-cache";

// Mirrors the codings the runtime actually negotiates (measured: it answers gzip when offered gzip, br
// when offered br, and leaves identity alone). Used only to decide whether a 304 owes a Vary.
const ACCEPTS_COMPRESSION = /\b(?:gzip|br)\b/i;

export async function withRevalidation(req: Request, res: Response): Promise<Response> {
  if (res.body === null) return res; // 204/302: no representation to validate
  // 200 ONLY. A 404/500 has no current representation to validate (see the note above), and a future 206
  // would have only a PARTIAL one - an ETag hashed over part of a body conflicts with range requests,
  // exactly as RFC 9110 8.8.3.3 warns. Reachable statuses here are 200/204/301/400/404/502, so this
  // is equivalent to !res.ok today and closes that hole in advance.
  if (res.status !== 200) return res;
  // Only GET and HEAD revalidate. RFC 9110 13.1.2 defines this condition in terms of "the request method
  // is GET or HEAD", and its 412 branch binds a server that EVALUATES the precondition for another
  // method. This server performs no state-changing method and evaluates no precondition for one, so any
  // other method gets the ordinary response - which is also what it got before this unit. Evaluating it
  // there produced a 304 for POST/PUT, which this line removes.
  if (req.method !== "GET" && req.method !== "HEAD") return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const etag = `W/"${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
  // The validator always describes the bytes actually served (the bytes hashed just above), so a
  // route-supplied ETag would be a validator for content this code did not measure. There is no such
  // route today; if one is added, this deliberately overrides it rather than silently skipping
  // revalidation (which would emit a validator without any way to use it).
  const headers = new Headers(res.headers);
  headers.set("etag", etag);
  headers.set("cache-control", REVALIDATION_CACHE_CONTROL);
  if (ifNoneMatchMatches(req.headers.get("if-none-match"), etag)) {
    // RFC 9110 15.4.5: a 304 MUST carry the Vary that a 200 to the SAME request would have carried. The
    // runtime adds vary: Accept-Encoding only when it compresses, and it cannot add anything to a
    // bodyless 304, so it is merged here whenever this request is one the runtime would compress.
    // If a future route already set Vary, accept-encoding is appended rather than clobbering it.
    if (ACCEPTS_COMPRESSION.test(req.headers.get("accept-encoding") ?? "")) {
      const existing = headers.get("vary");
      if (!existing) {
        headers.set("vary", "accept-encoding");
      } else if (
        !existing.split(",").some((part) => part.trim().toLowerCase() === "accept-encoding")
      ) {
        headers.append("vary", "accept-encoding");
      }
    }
    // DEFENSIVE, AND MEASURED RATHER THAN ASSUMED (review P2-4). No route sets either header today. The
    // runtime already strips content-length from a bodiless 304 - forcing a value on and probing the wire
    // showed it never arrives - so that delete is belt-and-braces. The runtime does NOT strip
    // content-encoding (the same probe showed a forced value DID reach the wire), so this is the one line
    // that keeps a future route's coding header off a bodiless response. The fixture asserts the invariant;
    // it is not a mutation-detector in this tree, and its comment says so.
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(null, { status: 304, headers });
  }
  return new Response(bytes, { status: res.status, statusText: res.statusText, headers });
}

// If-None-Match is a comma-separated list of validators, or "*". A weak validator matches its strong
// twin, so W/"x" and "x" are the same validator for this purpose.
function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => bare(tag) === bare(etag));
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
  const origin = safeRequestOrigin(url);

  // Durable-demo contract: 301 old (pre-contract) routes to their current page. Checked before
  // everything else so a moved route never 404s.
  const target = redirectTarget(path);
  if (target) {
    return new Response(null, {
      status: 301,
      headers: { location: target + url.search },
    });
  }

  // A browser requests /favicon.ico on its own for every page that carries no <link rel="icon">,
  // which is most of the older reference pages. Answer with the bytes of public/favicon.svg (the
  // icon the SSR routes already link) so those pages get the same icon without being edited.
  if (path === "/favicon.ico") return readFavicon();

  // ----- Discoverability, SEO & AI/agent surface (additive, read-only) -----
  if (path === "/robots.txt") {
    return new Response(renderRobotsTxt(origin), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (path === "/sitemap.xml") {
    try {
      const pages = await getSitePages();
      return new Response(renderSitemapXml(origin, pages), {
        headers: { "content-type": "application/xml; charset=utf-8" },
      });
    } catch (err) {
      return serverError(req, "render sitemap", err);
    }
  }
  if (path === "/llms.txt") {
    try {
      const pages = await getSitePages();
      return new Response(renderLlmsTxt(origin, pages), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } catch (err) {
      return serverError(req, "render llms.txt", err);
    }
  }
  if (path === "/feed.xml") {
    try {
      const pages = await getSitePages();
      const commit = getPrecomputedMeta()?.commit ?? null;
      return new Response(renderAtomFeedXml(origin, pages, commit), {
        headers: { "content-type": "application/atom+xml; charset=utf-8" },
      });
    } catch (err) {
      return serverError(req, "render feed", err);
    }
  }
  if (path === "/api/features.json") {
    try {
      const pages = await getSitePages();
      const commit = getPrecomputedMeta()?.commit ?? null;
      return new Response(JSON.stringify(buildFeaturesApiJson(pages, commit)) + "\n", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (err) {
      return serverError(req, "render features api", err);
    }
  }

  // ----- critique + conformance lifecycle views (additive, read-only) -----
  if (path === "/conformance" || path === "/conformance/") {
    try {
      return new Response(await renderConformanceIndex(origin), {
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
      : new Response("No run-all rollup generated yet (run: npm run conformance)", {
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
      return new Response(await renderIndex(channels, origin), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (err) {
      return serverError(req, "render index", err);
    }
  }

  if (path === "/features" || path === "/features/") {
    try {
      const channels = await getChannels();
      return new Response(await renderFeaturesCatalogue(channels, origin), {
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
        return new Response(await renderReleasePage(release, milestone, origin), {
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

// The full response pipeline every runtime entry shares: route, revalidate, add security headers,
// and turn an unhandled throw into the generic 502. Used by the Node dev server (serve.ts) and
// the Cloudflare Worker (worker.ts), so both answer identically. This module has no entry point of
// its own: the legacy Deno Deploy entry was removed when that deployment was retired (2026-11-26).
export async function serveRequest(req: Request): Promise<Response> {
  try {
    return addSecurityHeaders(await withRevalidation(req, await handleRequest(req)));
  } catch (err) {
    return addSecurityHeaders(serverError(req, "unhandled request", err));
  }
}
