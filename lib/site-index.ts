// Runtime-neutral site index, build-time metadata store, and discovery renderers.
//
// On Cloudflare Workers (worker.ts), build-worker-assets.mjs generates dist/site-meta.json at
// build time and worker.ts installs it via setPrecomputedMeta() once per isolate. That eliminates
// hundreds of cold-start ASSETS.fetch reads for the cross-release identity index, /conformance,
// commit metadata, and discovery routes.
//
// On Node dev (`npm run dev` / `serve.ts`) and tests without dist/, precomputedMeta is null and
// this module lazily computes and caches the same data from siteFS(), keyed per SiteFS instance
// so swapping siteFS() in tests never returns stale data.

import { chromeStatusUrl, milestonePathSegment } from "./chromestatus.ts";
import { readSiteText, type SiteFS, siteFS } from "./site-fs.ts";

export interface CommitMeta {
  sha: string;
  shortSha: string;
  date: string;
  htmlUrl: string;
}

export interface ConformanceSuiteSummary {
  id: string;
  route: string;
  status: string;
  assertionCount: number;
  identity: string;
}

export interface ContractSummary {
  kind: string | null;
  completeness: string | null;
  inventoryCount: number;
}

export interface PageMeta {
  id: string;
  route: string;
  milestone: number;
  slug: string;
  title: string;
  description: string;
  status: "built" | "stub";
  identity: string | null;
  demo: string | null;
  hasContract: boolean;
  contractSummary?: ContractSummary;
  childRoutes: string[];
}

export interface SiteMeta {
  commit: CommitMeta | null;
  identityIndex: Record<string, string>;
  conformanceSuites: ConformanceSuiteSummary[];
  pages: PageMeta[];
}

const IO_CONCURRENCY = 32;
const DESCRIPTION_CAP = 280;
const SHOWCASE_HOST = "chrome-platform-showcase.paulkinlan-ea.deno.net";

const FEATURE_ID_RE = /chromestatus\.com\/feature\/(\d+)/;
const DECLARED_FEATURE_ID_RE =
  /<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?<th\b[^>]*>\s*ChromeStatus\s*<\/th>(?:(?!<\/tr>)[\s\S])*?chromestatus\.com\/feature\/(\d+)/i;

let precomputedMeta: SiteMeta | null = null;
let precomputedIdentityMap: Map<string, string> | null = null;

const pagesCache = new WeakMap<SiteFS, Promise<PageMeta[]>>();
const identityCache = new WeakMap<SiteFS, Promise<Map<string, string>>>();
const suitesCache = new WeakMap<SiteFS, Promise<ConformanceSuiteSummary[]>>();

export function setPrecomputedMeta(meta: SiteMeta | null): void {
  precomputedMeta = meta;
  precomputedIdentityMap = meta ? new Map(Object.entries(meta.identityIndex)) : null;
}

export function getPrecomputedMeta(): SiteMeta | null {
  return precomputedMeta;
}

// ----- Shared bounded concurrency helper -----

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

// ----- Pure HTML & artifact extraction (shared with build-worker-assets.mjs) -----

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  hellip: "…",
  middot: "·",
  rarr: "→",
  larr: "←",
};

function decodeBasicEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const cp = parseInt(code.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (code.startsWith("#")) {
      const cp = parseInt(code.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function stripTagsToText(htmlFragment: string): string {
  const plain = htmlFragment.replace(/<[^>]+>/g, " ");
  return decodeBasicEntities(plain).replace(/\s+/g, " ").trim();
}

function visibleMarkup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
}

export function extractFeatureIdentityFromHtml(html: string): string | null {
  const declared = html.match(DECLARED_FEATURE_ID_RE);
  if (declared) return declared[1];
  const fallback = html.match(FEATURE_ID_RE);
  return fallback ? fallback[1] : null;
}

export function isStubHtml(html: string): boolean {
  const visible = visibleMarkup(html);
  for (
    const match of visible.matchAll(
      /<p\b[^>]*class=["'][^"']*\beyebrow\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi,
    )
  ) {
    if (/covered on mdn/i.test(stripTagsToText(match[1]))) return true;
  }
  return false;
}

export function extractDemoUrlFromHtml(
  html: string,
  release: string,
  slug: string,
): string | null {
  let demo: string | null = null;
  const showcaseRe = new RegExp(
    `${SHOWCASE_HOST.replace(/\./g, "\\.")}(/v\\d+/[a-z0-9-]+/?[a-z0-9-]*/?)`,
    "g",
  );
  const ownPrefix = `/${release}/${slug}`;
  let m: RegExpExecArray | null;
  while ((m = showcaseRe.exec(html)) !== null) {
    const routePath = m[1];
    const tagStart = html.lastIndexOf("<", m.index);
    if (tagStart !== -1) {
      const tagEnd = html.indexOf(">", tagStart);
      if (tagEnd !== -1 && tagEnd > m.index) {
        const tagText = html.slice(tagStart, tagEnd + 1);
        const isRelated = /\b(?:data-demo-rel|data-demo)\s*=\s*["']?related\b/i.test(tagText) ||
          /\brel\s*=\s*["'][^"']*\brelated\b[^"']*["']/i.test(tagText) ||
          /\bdata-related-demo\b/i.test(tagText);
        if (isRelated) continue;
      }
    }
    if (routePath === ownPrefix || routePath.startsWith(`${ownPrefix}/`)) {
      demo = `https://${SHOWCASE_HOST}${routePath}`;
      break;
    }
    if (demo === null) demo = `https://${SHOWCASE_HOST}${routePath}`;
  }
  return demo;
}

export function extractTitleFromHtml(html: string, fallback: string): string {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const text = stripTagsToText(h1[1]);
    if (text) return text;
  }
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    const cleaned = stripTagsToText(title[1])
      .replace(/\s*[—–-]\s*Chrome\s+\d+\s*[—–-]\s*gendn\s*$/i, "")
      .replace(/\s*[—–-]\s*gendn\s*$/i, "")
      .trim();
    if (cleaned) return cleaned;
  }
  return fallback;
}

export function extractDescriptionFromHtml(html: string): string {
  const lede = html.match(
    /<p\b[^>]*class=["'][^"']*\blede\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  );
  let text = lede ? stripTagsToText(lede[1]) : "";
  if (!text) {
    const meta = html.match(
      /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
    ) ?? html.match(
      /<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i,
    );
    if (meta) text = decodeBasicEntities(meta[1]).replace(/\s+/g, " ").trim();
  }
  if (text.length > DESCRIPTION_CAP) {
    return `${text.slice(0, DESCRIPTION_CAP - 3).trimEnd()}...`;
  }
  return text;
}

export function parseContractSummary(rawJson: string | null): ContractSummary | undefined {
  if (!rawJson) return undefined;
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;
    return {
      kind: typeof parsed.kind === "string" ? parsed.kind : null,
      completeness: typeof parsed.completeness === "string" ? parsed.completeness : null,
      inventoryCount: Array.isArray(parsed.inventory) ? parsed.inventory.length : 0,
    };
  } catch {
    return undefined;
  }
}

export function parsePageMeta(
  release: string,
  slug: string,
  html: string,
  childRoutes: string[],
  contractJson: string | null,
): PageMeta {
  const milestone = Number(release.slice(1));
  const id = `${release}/${slug}`;
  const route = `/${release}/${slug}/`;
  const contractSummary = parseContractSummary(contractJson);
  const page: PageMeta = {
    id,
    route,
    milestone,
    slug,
    title: extractTitleFromHtml(html, slug),
    description: extractDescriptionFromHtml(html),
    status: isStubHtml(html) ? "stub" : "built",
    identity: extractFeatureIdentityFromHtml(html),
    demo: extractDemoUrlFromHtml(html, release, slug),
    hasContract: contractSummary !== undefined,
    childRoutes: [...childRoutes].sort(),
  };
  if (contractSummary !== undefined) page.contractSummary = contractSummary;
  return page;
}

export function parseConformanceSuiteSummary(rawJson: string): ConformanceSuiteSummary | null {
  try {
    const s = JSON.parse(rawJson) as Record<string, unknown>;
    if (!s || typeof s !== "object" || typeof s.id !== "string") return null;
    return {
      id: s.id,
      route: typeof s.route === "string" ? s.route : "",
      status: typeof s.status === "string" ? s.status : "",
      assertionCount: Array.isArray(s.assertions) ? s.assertions.length : 0,
      identity: typeof s.identity === "string"
        ? s.identity
        : typeof s.identity === "number"
        ? String(s.identity)
        : "",
    };
  } catch {
    return null;
  }
}

export function comparePagesDesc(a: PageMeta, b: PageMeta): number {
  if (a.milestone !== b.milestone) return b.milestone - a.milestone;
  return a.slug.localeCompare(b.slug);
}

// ----- Runtime SiteFS scanners (used on Node dev / tests when dist/site-meta.json is absent) -----

async function collectChildRoutes(fs: SiteFS, dirPath: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readDir(dirPath);
  for (const entry of entries) {
    const childPath = `${dirPath}/${entry.name}`;
    if (entry.isDirectory) {
      if (await fs.exists(`${childPath}/index.html`)) {
        out.push(`/${childPath}/`);
      }
      out.push(...await collectChildRoutes(fs, childPath));
    } else if (entry.name.endsWith(".html") && entry.name !== "index.html") {
      out.push(`/${childPath}`);
    }
  }
  return out;
}

async function listReleaseSlugDirs(
  fs: SiteFS,
): Promise<{ release: string; milestone: number; slug: string }[]> {
  const dirs: { release: string; milestone: number; slug: string }[] = [];
  for (const rel of await fs.readDir(".")) {
    if (!rel.isDirectory || !/^v\d+$/.test(rel.name)) continue;
    const milestone = Number(rel.name.slice(1));
    for (const sub of await fs.readDir(rel.name)) {
      if (!sub.isDirectory) continue;
      dirs.push({ release: rel.name, milestone, slug: sub.name });
    }
  }
  dirs.sort((a, b) => a.milestone - b.milestone || a.slug.localeCompare(b.slug));
  return dirs;
}

export function getSitePages(): Promise<PageMeta[]> {
  if (precomputedMeta) return Promise.resolve(precomputedMeta.pages);
  const fs = siteFS();
  let cached = pagesCache.get(fs);
  if (!cached) {
    cached = (async () => {
      const dirs = await listReleaseSlugDirs(fs);
      const scanned = await mapPool(dirs, IO_CONCURRENCY, async ({ release, slug }) => {
        const html = await readSiteText(fs, `${release}/${slug}/index.html`).catch(() => null);
        if (html === null) return null;
        const [childRoutes, contractJson] = await Promise.all([
          collectChildRoutes(fs, `${release}/${slug}`),
          readSiteText(fs, `${release}/${slug}/reference-contract.json`).catch(() => null),
        ]);
        return parsePageMeta(release, slug, html, childRoutes, contractJson);
      });
      return scanned.filter((p): p is PageMeta => p !== null).sort(comparePagesDesc);
    })();
    pagesCache.set(fs, cached);
  }
  return cached;
}

export function getSiteIdentityIndex(): Promise<Map<string, string>> {
  if (precomputedIdentityMap) return Promise.resolve(precomputedIdentityMap);
  const fs = siteFS();
  let cached = identityCache.get(fs);
  if (!cached) {
    cached = (async () => {
      const map = new Map<string, string>();
      const dirs = await listReleaseSlugDirs(fs);
      const htmls = await mapPool(
        dirs,
        IO_CONCURRENCY,
        ({ release, slug }) => readSiteText(fs, `${release}/${slug}/index.html`).catch(() => null),
      );
      htmls.forEach((html, i) => {
        if (!html) return;
        const id = extractFeatureIdentityFromHtml(html);
        if (id && !map.has(id)) {
          map.set(id, `/${dirs[i].release}/${dirs[i].slug}/`);
        }
      });
      return map;
    })();
    identityCache.set(fs, cached);
  }
  return cached;
}

export function getSiteConformanceSuites(): Promise<ConformanceSuiteSummary[]> {
  if (precomputedMeta) return Promise.resolve(precomputedMeta.conformanceSuites);
  const fs = siteFS();
  let cached = suitesCache.get(fs);
  if (!cached) {
    cached = (async () => {
      const dirs = await listReleaseSlugDirs(fs);
      const summaries = await mapPool(dirs, IO_CONCURRENCY, async ({ release, slug }) => {
        const raw = await readSiteText(fs, `${release}/${slug}/conformance.json`).catch(() => null);
        return raw ? parseConformanceSuiteSummary(raw) : null;
      });
      return summaries
        .filter((s): s is ConformanceSuiteSummary => s !== null)
        .sort((a, b) => a.id.localeCompare(b.id));
    })();
    suitesCache.set(fs, cached);
  }
  return cached;
}

// ----- Origin & XML escaping helpers -----

export function safeRequestOrigin(url: URL): string {
  if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "null") {
    return url.origin;
  }
  return "";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeRoutePath(route: string): string | null {
  if (!route.startsWith("/") || /[\r\n\0\s<>"]/.test(route)) return null;
  return route;
}

function uniqueMilestonesDesc(pages: readonly PageMeta[]): number[] {
  const set = new Set<number>();
  for (const p of pages) {
    const seg = milestonePathSegment(p.milestone);
    if (seg !== null) set.add(Number(seg));
  }
  return [...set].sort((a, b) => b - a);
}

// ----- Discovery & AI/Agent surface renderers -----

export function renderRobotsTxt(origin: string): string {
  const sitemapLine = origin ? `Sitemap: ${origin}/sitemap.xml` : "Sitemap: /sitemap.xml";
  return `User-agent: *\nAllow: /\n\n${sitemapLine}\n`;
}

export function renderSitemapXml(origin: string, pages: readonly PageMeta[]): string {
  const loc = (path: string) => `${origin}${path}`;
  const urls: string[] = [
    loc("/"),
    loc("/features"),
    loc("/conformance"),
  ];
  for (const m of uniqueMilestonesDesc(pages)) {
    const seg = milestonePathSegment(m);
    if (seg !== null) urls.push(loc(`/v${milestonePathSegment(m)}/`));
  }
  const seen = new Set<string>(urls);
  for (const page of pages) {
    const route = safeRoutePath(page.route);
    if (route) {
      const full = loc(route);
      if (!seen.has(full)) {
        seen.add(full);
        urls.push(full);
      }
    }
    for (const child of page.childRoutes) {
      const safeChild = safeRoutePath(child);
      if (!safeChild) continue;
      const full = loc(safeChild);
      if (!seen.has(full)) {
        seen.add(full);
        urls.push(full);
      }
    }
  }
  const entries = urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${entries}\n` +
    `</urlset>\n`;
}

export function renderLlmsTxt(origin: string, pages: readonly PageMeta[]): string {
  const link = (path: string) => `${origin}${path}`;
  const built = pages.filter((p) => p.status === "built");
  const stubCount = pages.length - built.length;
  const byMilestone = new Map<number, PageMeta[]>();
  for (const page of built) {
    const list = byMilestone.get(page.milestone) ?? [];
    list.push(page);
    byMilestone.set(page.milestone, list);
  }
  const milestones = [...byMilestone.keys()].sort((a, b) => b - a);

  const lines: string[] = [
    "# gendn",
    "",
    "> Generated reference documentation for Chrome web platform APIs that do not yet have a page on MDN. Covers shipping, beta, and origin-trial APIs from ChromeStatus, specs, explainers, and Chromium IDL.",
    "",
    "## Machine-Readable Indexes",
    "",
    `- [API Catalogue JSON](${
      link("/api/features.json")
    }): Structured catalogue of all ${pages.length} published pages (${built.length} built references, ${stubCount} MDN redirect stubs), ChromeStatus IDs, showcase demos, and child routes.`,
    `- [XML Sitemap](${
      link("/sitemap.xml")
    }): Complete URL inventory including release hubs and child reference pages.`,
    `- [Atom Feed](${link("/feed.xml")}): Latest Chrome release reference docs.`,
    `- [HTML Feature Catalogue](${
      link("/features")
    }): Filterable web index across all Chrome milestones.`,
    `- [Conformance Suites](${
      link("/conformance")
    }): Doc-quality conformance contracts for published references.`,
  ];

  for (const m of milestones) {
    const seg = milestonePathSegment(m);
    const items = byMilestone.get(m) ?? [];
    items.sort((a, b) => a.slug.localeCompare(b.slug));
    lines.push("", `## Chrome ${seg ?? m}`, "");
    for (const page of items) {
      const idTag = page.identity ? ` [ChromeStatus #${page.identity}]` : "";
      const summary = page.description ? `: ${page.description}` : "";
      lines.push(`- [${page.title}](${link(page.route)})${idTag}${summary}`);
    }
  }

  if (stubCount > 0) {
    lines.push(
      "",
      "## MDN Redirect Stubs",
      "",
      `${stubCount} additional published routes are concise redirect stubs pointing to MDN where MDN already documents the API; see ${
        link("/api/features.json")
      } for the full list.`,
    );
  }

  return `${lines.join("\n")}\n`;
}

const FEED_ENTRY_LIMIT = 50;
const FALLBACK_UPDATED_ISO = "2026-01-01T00:00:00Z";

function normalizeIsoDate(raw: string | undefined | null): string {
  if (!raw) return FALLBACK_UPDATED_ISO;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? FALLBACK_UPDATED_ISO : parsed.toISOString();
}

export function renderAtomFeedXml(
  origin: string,
  pages: readonly PageMeta[],
  commit: CommitMeta | null,
): string {
  const link = (path: string) => `${origin}${path}`;
  const updated = normalizeIsoDate(commit?.date);
  const built = pages.filter((p) => p.status === "built").slice(0, FEED_ENTRY_LIMIT);
  const entries = built.map((p) => {
    const url = link(p.route);
    const summaryParts = [p.description];
    if (p.identity) summaryParts.push(`ChromeStatus #${p.identity}`);
    const summary = summaryParts.filter(Boolean).join(" — ") ||
      `Chrome ${p.milestone} reference documentation for ${p.title}.`;
    return [
      "  <entry>",
      `    <title>${escapeXml(`${p.title} (Chrome ${p.milestone})`)}</title>`,
      `    <id>${escapeXml(url)}</id>`,
      `    <link href="${escapeXml(url)}" rel="alternate" type="text/html"/>`,
      `    <updated>${escapeXml(updated)}</updated>`,
      `    <summary>${escapeXml(summary)}</summary>`,
      `    <category term="${escapeXml(`Chrome ${p.milestone}`)}"/>`,
      "  </entry>",
    ].join("\n");
  }).join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "  <title>gendn — Chrome web platform API references</title>",
    "  <subtitle>Generated reference docs for web platform APIs shipping in Chrome before MDN covers them.</subtitle>",
    `  <id>${escapeXml(link("/"))}</id>`,
    `  <link href="${escapeXml(link("/"))}" rel="alternate" type="text/html"/>`,
    `  <link href="${escapeXml(link("/feed.xml"))}" rel="self" type="application/atom+xml"/>`,
    `  <updated>${escapeXml(updated)}</updated>`,
    "  <author><name>Paul Kinlan</name></author>",
    entries,
    "</feed>",
    "",
  ].join("\n");
}

export interface FeaturesApiPayload {
  generatedBy: "gendn";
  commit: { sha: string; shortSha: string; date: string } | null;
  counts: {
    total: number;
    built: number;
    stub: number;
    milestones: number;
  };
  milestones: number[];
  features: {
    id: string;
    route: string;
    milestone: number;
    slug: string;
    title: string;
    description: string;
    status: "built" | "stub";
    identity: string | null;
    chromestatusUrl: string | null;
    demo: string | null;
    hasContract: boolean;
    contractSummary?: ContractSummary;
    childRoutes: string[];
  }[];
}

export function buildFeaturesApiJson(
  pages: readonly PageMeta[],
  commit: CommitMeta | null,
): FeaturesApiPayload {
  const builtCount = pages.filter((p) => p.status === "built").length;
  const milestones = uniqueMilestonesDesc(pages);
  return {
    generatedBy: "gendn",
    commit: commit ? { sha: commit.sha, shortSha: commit.shortSha, date: commit.date } : null,
    counts: {
      total: pages.length,
      built: builtCount,
      stub: pages.length - builtCount,
      milestones: milestones.length,
    },
    milestones,
    features: pages.map((p) => ({
      id: p.id,
      route: p.route,
      milestone: p.milestone,
      slug: p.slug,
      title: p.title,
      description: p.description,
      status: p.status,
      identity: p.identity,
      chromestatusUrl: chromeStatusUrl(p.identity),
      demo: p.demo,
      hasContract: p.hasContract,
      ...(p.contractSummary ? { contractSummary: p.contractSummary } : {}),
      childRoutes: p.childRoutes,
    })),
  };
}
