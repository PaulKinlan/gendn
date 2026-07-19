// lifecycle.ts — server-side rendering for gendn's critique + conformance lifecycle browsing.
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
  cpsFeature: { host: string; route: string; conformanceRoute: string; note: string } | null;
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

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

async function collectSuiteFiles(): Promise<Suite[]> {
  const out: Suite[] = [];
  for await (const rel of Deno.readDir(".")) {
    if (!(rel.isDirectory && /^v\d+$/.test(rel.name))) continue;
    for await (const slug of Deno.readDir(rel.name)) {
      if (!slug.isDirectory) continue;
      const s = await readJson<Suite>(`${rel.name}/${slug.name}/conformance.json`);
      if (s) out.push(s);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

const HEAD = (title: string, extra = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/public/styles.css">
<style>
  main{max-width:1000px;}
  table{width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:0.82rem;}
  th,td{padding:0.5rem 0.6rem;border-bottom:1px solid var(--border-black);text-align:left;vertical-align:top;}
  th{background:var(--bg-stone);font-size:0.68rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);}
  .tag{font-family:var(--font-mono);font-size:0.7rem;border:1px solid var(--border-black);padding:0.1rem 0.4rem;background:var(--bg-stone);}
  .v{font-weight:700;text-transform:uppercase;font-size:0.7rem;padding:0.1rem 0.45rem;border:1px solid var(--border-black);}
  .v-pass{color:var(--accent-emerald,#087);} .v-fail{color:var(--accent-rose,#b00);} .v-blocked{color:var(--text-muted);}
  .meta{font-family:var(--font-mono);font-size:0.75rem;color:var(--text-muted);margin:0.5rem 0 1rem;}
  @media (max-width:640px){main{padding:1rem;}table,thead,tbody,tr,td{display:block;width:100%;}thead{display:none;}tr{border:2px solid var(--border-black);margin-bottom:0.6rem;padding:0.5rem;box-shadow:var(--thin-shadow);}td{border:none;padding:0.2rem 0;}}
</style>${extra}</head><body><main>`;
const FOOT = `<footer class="byline">gendn conformance lifecycle</footer></main></body></html>`;

export async function renderConformanceIndex(): Promise<string> {
  const suites = await collectSuiteFiles();
  const built = suites.filter((s) => s.status === "built").length;
  const rows = suites.map((s) =>
    `<tr><td><a href="${esc(s.route)}conformance">${esc(s.id)}</a></td><td>${
      esc(s.status)
    }</td><td>${s.assertions.length}</td><td><a href="https://chromestatus.com/feature/${
      esc(s.identity)
    }" target="_blank" rel="noopener">#${esc(s.identity)}</a></td></tr>`
  ).join("");
  return HEAD("conformance — gendn") +
    `<p class="crumbs"><a href="/">&larr; home</a> &middot; <a href="/conformance/run-all">run-all rollup</a></p>
    <header class="lede-block"><p class="eyebrow">conformance</p><h1>conformance suites</h1>
    <p class="lede">Every published reference page carries an immutable conformance suite — doc-quality contracts derived from its real chromestatus identity, route, structure, and embedded showcase demo. Platform behavior of an embedded demo is governed by the chrome-platform-showcase contract each suite references, not forked here.</p></header>
    <p class="meta">${suites.length} suites (${built} built / ${suites.length - built} stub)</p>
    <table><thead><tr><th>page</th><th>status</th><th>assertions</th><th>feature</th></tr></thead><tbody>${rows}</tbody></table>` +
    FOOT;
}

export async function renderRunAll(): Promise<string | null> {
  try {
    return await Deno.readTextFile("reports/conformance/index.html");
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
    const state = v?.status ?? "n/a";
    return `<tr><td><code>${esc(a.id)}</code></td><td>${
      esc(a.describe)
    }</td><td><span class="tag">${esc(a.category)}</span></td><td>${esc(a.kind)}</td><td>${
      esc(a.deviceClass)
    }</td><td><span class="v v-${state}">${esc(state)}</span>${
      v?.reason ? `<div class="meta">${esc(v.reason)}</div>` : ""
    }</td></tr>`;
  }).join("");

  const cps = suite.cpsFeature
    ? `<p class="meta">Embedded demo behavior governed by chrome-platform-showcase: <a href="https://${
      esc(suite.cpsFeature.host)
    }${esc(suite.cpsFeature.conformanceRoute)}" target="_blank" rel="noopener">${
      esc(suite.cpsFeature.conformanceRoute)
    }</a> (referenced, not forked).</p>`
    : "";
  return HEAD(`conformance — ${suite.id}`) +
    `<p class="crumbs"><a href="${esc(suite.route)}">&larr; ${
      esc(suite.id)
    }</a> &middot; <a href="${
      esc(suite.route)
    }critique">critique</a> &middot; <a href="/conformance">all suites</a></p>
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
  return HEAD(`critique — ${c.id}`) +
    `<p class="crumbs"><a href="${esc(c.route)}">&larr; ${esc(c.id)}</a> &middot; <a href="${
      esc(c.route)
    }conformance">conformance</a></p>
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
