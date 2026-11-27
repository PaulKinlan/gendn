// lifecycle.ts — server-side rendering for gendn's critique + conformance lifecycle browsing.
//
import { chromeStatusUrl } from "./chromestatus.ts";
import { safeExternalUrl } from "./external-url.ts";
import { renderSiteFooter, renderSiteHeader } from "./shell.ts";
import { readSiteText, siteFS } from "./site-fs.ts";
import { getSiteConformanceSuites } from "./site-index.ts";
//
// Additive, read-only views over the colocated artifacts (v<N>/<slug>/conformance.json and
// _questions.json) plus the run-all rollup the runner writes to reports/conformance/. No article
// content is changed; these are new routes only.
//
// Routes wired in server.ts:
//   /conformance                     — index of all suites + coverage summary
//   /conformance/run-all             — the generated rollup (reports/conformance/index.html)
//   /v<N>/<slug>/conformance         — one suite's assertions + last recorded verdicts
//   /v<N>/<slug>/critique            — one page's critique (_questions.json)

interface Assertion {
  id: string;
  category: string;
  describe: string;
  kind: string;
  deviceClass: string;
  specSection?: string;
}
interface Suite {
  id: string;
  route: string;
  identity: string;
  milestone: number;
  status: string;
  demo: string | null;
  cpsFeature: { host: string; route: string; conformanceRoute: string | null; note: string } | null;
  suiteHash: string;
  generatedAt: string;
  author: string;
  assertions: Assertion[];
}
interface AssertionResult {
  id: string;
  status: "pass" | "fail" | "blocked";
  reason?: string;
}
interface SuiteResult {
  id: string;
  results: AssertionResult[];
}
interface Results {
  generatedAt: string;
  suites: SuiteResult[];
}
interface RubricRow {
  dimension: string;
  score: number;
  severity: string;
  evidence: string;
  notes?: string;
}
interface Critique {
  id: string;
  route: string;
  identity: string;
  status: string;
  revision: number;
  reviewedAt: string;
  reviewer: string;
  rubric: RubricRow[];
  guidanceConsulted: {
    query?: string;
    id?: string;
    recommendation: string;
    appliedOrException: string;
    evidence?: string;
  }[];
  openQuestions: string[];
  followUpGoals: { goal: string; kind: string; priority: string }[];
  summary?: string;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Artifact routes are untrusted strings. Only the page's own canonical local route may become
// navigation; escaping alone cannot prevent javascript: links or protocol-relative redirects.
function safePageRoute(route: unknown, id: unknown): string | null {
  if (
    typeof route !== "string" || typeof id !== "string" ||
    !/^v\d+\/[a-z0-9-]+$/.test(id) || route !== `/${id}/`
  ) return null;
  return route;
}

function safeCpsConformanceUrl(host: unknown, route: unknown): string | null {
  if (
    host !== "chrome-platform-showcase.kinlan-test.workers.dev" ||
    typeof route !== "string" || !/^\/v\d+\/[a-z0-9-]+\/conformance\/?$/.test(route)
  ) {
    return null;
  }
  return safeExternalUrl(`https://${host}${route}`);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readSiteText(siteFS(), path);
    return text === null ? null : JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const HEAD = (
  title: string,
  extra = "",
  seo?: { description: string; canonicalPath: string; origin?: string },
) => {
  const canonical = seo
    ? (seo.origin ? `${seo.origin}${seo.canonicalPath}` : seo.canonicalPath)
    : "";
  const seoTags = seo
    ? `\n<meta name="description" content="${esc(seo.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(seo.description)}">
<meta property="og:type" content="website">`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>${seoTags}
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
<link rel="stylesheet" href="/public/styles.css">
<style>
  table{width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size-adjust:var(--adjust-mono);font-size:0.82rem;background:var(--bg-paper);border:2px solid var(--border-black);box-shadow:var(--thin-shadow);}
  th,td{padding:0.65rem 0.75rem;border-bottom:1px solid var(--border-hairline);text-align:start;vertical-align:top;}
  tbody tr:hover{background:var(--surface-warm);}
  th{background:var(--surface-warm);font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-black);border-bottom:2px solid var(--border-black);}
  .tag{font-family:var(--font-mono);font-size-adjust:var(--adjust-mono);font-size:0.7rem;border:1px solid var(--border-black);padding:0.12rem 0.45rem;background:var(--bg-stone);color:var(--text-black);}
  .v{font-weight:700;text-transform:uppercase;font-size:0.7rem;padding:0.14rem 0.5rem;border:1px solid var(--border-black);display:inline-block;}
  .v-pass{color:var(--accent-emerald-deep);border-color:var(--accent-emerald-deep);background:color-mix(in srgb, var(--accent-emerald) 14%, var(--bg-paper));}
  .v-fail{color:var(--accent-rose);border-color:var(--accent-rose);background:color-mix(in srgb, var(--accent-rose) 12%, var(--bg-paper));}
  .v-blocked{color:var(--text-muted);background:var(--bg-stone);}
  .meta{font-family:var(--font-mono);font-size-adjust:var(--adjust-mono);font-size:0.76rem;color:var(--text-muted);margin:0.5rem 0 1rem;}
  @media (max-width:640px){table{background:transparent;border:none;box-shadow:none;}table,thead,tbody,tr,td{display:block;width:100%;}thead{display:none;}tr{border:2px solid var(--border-black);background:var(--bg-paper);margin-bottom:0.75rem;padding:0.65rem;box-shadow:var(--thin-shadow);}tbody tr:hover{background:var(--bg-paper);}td{border:none;padding:0.2rem 0;}}
</style>${extra}</head><body class="shell-page">${
  renderSiteHeader("conformance")
}<main id="main-content" tabindex="-1">`;
};
const FOOT = `${renderSiteFooter({ includeShowcaseLink: false })}</main></body></html>`;

export async function renderConformanceIndex(origin?: string): Promise<string> {
  const suites = await getSiteConformanceSuites();
  const built = suites.filter((s) => s.status === "built").length;
  const rows = suites.map((s) => {
    // Narrowed at runtime, not escaped (gendn-b2s): the identity arrives as a STRING from the
    // colocated artifacts; a non-canonical value renders plain text instead of a link.
    // THREAT_MODEL.md invariant #4.
    const csHref = chromeStatusUrl(s.identity);
    const route = safePageRoute(s.route, s.id);
    return `<tr><td>${
      route ? `<a href="${esc(route)}conformance">${esc(s.id)}</a>` : esc(s.id)
    }</td><td>${esc(s.status)}</td><td>${s.assertionCount}</td><td>${
      csHref
        ? `<a href="${csHref}" target="_blank" rel="noopener">#${esc(s.identity)}</a>`
        : `#${esc(s.identity)}`
    }</td></tr>`;
  }).join("");
  return HEAD("conformance — gendn", "", {
    description:
      `Doc-quality conformance suites for ${suites.length} published gendn Chrome web platform reference pages (${built} built, ${
        suites.length - built
      } MDN stubs).`,
    canonicalPath: "/conformance",
    origin,
  }) +
    `<p class="crumbs"><a href="/">&larr; home</a> &middot; <a href="/conformance/run-all">run-all rollup</a></p>
    <header class="lede-block"><p class="eyebrow">conformance</p><h1>Conformance suites</h1>
    <p class="lede">Every published reference page carries an immutable conformance suite &mdash; doc-quality contracts derived from its real chromestatus identity, route, structure, and embedded showcase demo. Platform behavior of an embedded demo is governed by the chrome-platform-showcase contract each suite references, not forked here.</p></header>
    <p class="meta">${suites.length} suites (${built} built / ${suites.length - built} stub)</p>
    <table><thead><tr><th>page</th><th>status</th><th>assertions</th><th>feature</th></tr></thead><tbody>${rows}</tbody></table>` +
    FOOT;
}

export async function renderRunAll(): Promise<string | null> {
  try {
    return await readSiteText(siteFS(), "reports/conformance/index.html");
  } catch {
    return null;
  }
}

export async function renderSuite(release: string, slug: string): Promise<string | null> {
  const suite = await readJson<Suite>(`${release}/${slug}/conformance.json`);
  if (!suite) return null;
  const results = await readJson<Results>("reports/conformance/results.json");
  const verdicts = new Map<string, AssertionResult>();
  const sr = results?.suites.find((x) => x.id === suite.id);
  for (const r of sr?.results ?? []) verdicts.set(r.id, r);

  const rows = suite.assertions.map((a) => {
    const v = verdicts.get(a.id);
    // gendn-lny: the verdict status is WHITELISTED before it reaches markup. results.json is a
    // runner-written artifact, but a corrupt or hostile status must neither inject raw text into
    // the class attribute (the one interpolation in this module that esc() does not cover) nor
    // let an unknown verdict borrow pass/fail/blocked styling. Anything unrecognised renders as
    // "n/a" — never a pass. Pinned by scripts/lifecycle-units.test.mjs.
    const state = v && ["pass", "fail", "blocked"].includes(v.status) ? v.status : "n/a";
    return `<tr><td><code>${esc(a.id)}</code></td><td>${
      esc(a.describe)
    }</td><td><span class="tag">${esc(a.category)}</span></td><td>${esc(a.kind)}</td><td>${
      esc(a.deviceClass)
    }</td><td><span class="v v-${state}">${esc(state)}</span>${
      v?.reason ? `<div class="meta">${esc(v.reason)}</div>` : ""
    }</td></tr>`;
  }).join("");

  const cpsRoute = suite.cpsFeature?.conformanceRoute;
  const cpsHref = safeCpsConformanceUrl(suite.cpsFeature?.host, cpsRoute);
  const cps = cpsRoute
    ? `<p class="meta">Chrome-platform-showcase conformance (listed assertions only): ${
      cpsHref
        ? `<a href="${esc(cpsHref)}" target="_blank" rel="noopener">${esc(cpsRoute)}</a>`
        : esc(cpsRoute)
    } (referenced, not forked).</p>`
    : suite.cpsFeature
    ? `<p class="meta">No independently verified same-feature Chrome-platform-showcase conformance suite is linked for this demo.</p>`
    : "";
  const route = safePageRoute(suite.route, suite.id);
  return HEAD(`conformance — ${suite.id}`) +
    `<p class="crumbs">${
      route ? `<a href="${esc(route)}">&larr; ${esc(suite.id)}</a>` : `&larr; ${esc(suite.id)}`
    } &middot; ${
      route ? `<a href="${esc(route)}critique">critique</a>` : "critique"
    } &middot; <a href="/conformance">all suites</a></p>
    <header class="lede-block"><p class="eyebrow">conformance · ${esc(suite.status)}</p>
    <h1>${esc(suite.id)}</h1>
    <p class="lede">${suite.assertions.length} immutable assertions. Verdicts shown are from the last headless-Chrome runner pass${
      results ? ` (${esc(results.generatedAt)})` : ""
    }. Blocked = manual-evidenced or genuinely unavailable — never a pass.</p></header>
    <p class="meta">feature #${esc(suite.identity)} · hash ${
      esc(suite.suiteHash.slice(0, 16))
    }… · ${esc(suite.author)}</p>${cps}
    <table><thead><tr><th>id</th><th>describe</th><th>category</th><th>kind</th><th>device</th><th>verdict</th></tr></thead><tbody>${rows}</tbody></table>` +
    FOOT;
}

export async function renderCritique(release: string, slug: string): Promise<string | null> {
  const c = await readJson<Critique>(`${release}/${slug}/_questions.json`);
  if (!c) return null;
  const rubric = c.rubric.map((r) =>
    `<tr><td>${esc(r.dimension)}</td><td>${esc(r.score)}/5</td><td>${esc(r.severity)}</td><td>${
      esc(r.evidence)
    }${r.notes ? `<div class="meta">${esc(r.notes)}</div>` : ""}</td></tr>`
  ).join("");
  const guidance = c.guidanceConsulted.map((g) =>
    `<li><strong>${esc(g.query ?? g.id ?? "")}</strong> — ${esc(g.recommendation)} <em>(${
      esc(g.appliedOrException)
    })</em>${g.evidence ? ` <span class="meta">${esc(g.evidence)}</span>` : ""}</li>`
  ).join("");
  const goals = c.followUpGoals.map((g) =>
    `<li>[${esc(g.priority)} · ${esc(g.kind)}] ${esc(g.goal)}</li>`
  ).join("");
  const questions = c.openQuestions.map((q) => `<li>${esc(q)}</li>`).join("");
  const route = safePageRoute(c.route, c.id);
  return HEAD(`critique — ${c.id}`) +
    `<p class="crumbs">${
      route ? `<a href="${esc(route)}">&larr; ${esc(c.id)}</a>` : `&larr; ${esc(c.id)}`
    } &middot; ${route ? `<a href="${esc(route)}conformance">conformance</a>` : "conformance"}</p>
    <header class="lede-block"><p class="eyebrow">critique · rev ${esc(c.revision)}</p>
    <h1>${esc(c.id)}</h1>${c.summary ? `<p class="lede">${esc(c.summary)}</p>` : ""}
    <p class="meta">reviewed ${esc(c.reviewedAt)} by ${esc(c.reviewer)}</p></header>
    <h2>rubric</h2><table><thead><tr><th>dimension</th><th>score</th><th>severity</th><th>evidence</th></tr></thead><tbody>${rubric}</tbody></table>
    <h2>modern-web-guidance consulted</h2><ul>${
      guidance || '<li class="meta">none recorded</li>'
    }</ul>
    <h2>open questions</h2><ul>${questions || '<li class="meta">none</li>'}</ul>
    <h2>follow-up goals</h2><ul>${goals || '<li class="meta">none</li>'}</ul>` +
    FOOT;
}
