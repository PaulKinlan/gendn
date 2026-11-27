// Upgraded /features catalogue renderer and URL-synced client filter script.
//
// Preserves every security invariant from server.ts / THREAT_MODEL.md:
// - Runtime narrowing for ChromeStatus feature IDs (chromeStatusUrl) and milestones
//   (milestonePathSegment) — never relies on escaping alone for URLs/path segments.
// - Per-field length caps (NAME_CAP = 220, CATEGORY_CAP = 96, SUMMARY_CAP = 220) with
//   explicit "..." display markers and machine-readable data-truncated attributes.
// - Strict HTML escaping (escapeHTML) on all text and attribute sinks.
// - Exact SHA-256 CSP hash exported alongside FEATURES_FILTER_SCRIPT (no 'unsafe-inline').
// - Pure Web/ECMAScript module (no Node-only imports) so Node, Deno, and Cloudflare Workers
//   share one implementation.
//
// Guidance consulted (modern-web-guidance@latest):
// - `accessibility`: semantic landmarks, skip link, explicit <label for>, table <caption> +
//   <th scope="col">, unique link accessible names via .sr-only, polite aria-live result count.
// - `forms`: GET search <form>, visible labels above controls, enterkeyhint="search", 1rem
//   mobile control font size, >= 44px touch targets on narrow/coarse viewports, accent-color.
// - `dark-mode`: <meta name="color-scheme" content="light dark">, semantic CSS variables only.
// - `css`: :has(:checked) parent styling, :hover:not(:disabled), logical properties, zero raw hex.

import { chromeStatusUrl, milestonePathSegment } from "./chromestatus.ts";
import { safeExternalUrl } from "./external-url.ts";
import { escapeHTML } from "./html.ts";
import { renderSiteFooter, renderSiteHeader } from "./shell.ts";

export const NAME_CAP = 220;
export const CATEGORY_CAP = 96;
export const SUMMARY_CAP = 220;

export interface FeaturesCatalogueRow {
  mstone: number;
  id: number;
  name: string;
  // Slug of the RAW upstream name (same value hasDoc validated), so the href never depends on
  // the display-capped name (gendn-kow4).
  slug: string;
  summary: string;
  category: string;
  hasDoc: boolean;
  nameCut: boolean;
  categoryCut: boolean;
  docStatus?: "built" | "stub";
  hasDemo?: boolean;
}

export interface FeaturesCatalogueOptions {
  rows: FeaturesCatalogueRow[];
  knownMilestones: number[];
  speculationRulesHtml: string;
  canonicalUrl?: string;
}

export function categoryTag(category: string): string {
  return category
    .replace("In developer trial (Behind a flag)", "Dev Trial")
    .replace("Enabled by default", "Shipped")
    .replace("Origin trial", "Origin Trial")
    .replace("Stepped rollout", "Stepped rollout")
    .replace("Browser Intervention", "Intervention");
}

// Inline client script for /features. Kept as an exact, formatting-stable constant so its
// SHA-256 CSP hash matches the rendered <script> body byte-for-byte.
// Security: uses only textContent, value, checked, disabled, hidden, classList, URLSearchParams,
// and history.replaceState — never innerHTML or dynamic code evaluation.
export const FEATURES_FILTER_SCRIPT = `
(() => {
  const form = document.getElementById("filters-form");
  const q = document.getElementById("q");
  const mstone = document.getElementById("mstone");
  const status = document.getElementById("status");
  const docType = document.getElementById("doc-type");
  const demoOnly = document.getElementById("demo-only");
  const clearBtn = document.getElementById("clear-filters");
  const rows = document.querySelectorAll("#rows tr");
  const visible = document.getElementById("visible");
  const emptyState = document.getElementById("empty-state");
  if (!q || !mstone || !status || !docType || !visible) return;

  function setSelect(el, val) {
    if (!val) {
      el.value = "";
      return;
    }
    for (const opt of el.options) {
      if (opt.value === val) {
        el.value = val;
        return;
      }
    }
    el.value = "";
  }

  function syncUrl() {
    const params = new URLSearchParams(window.location.search);
    const qv = q.value.trim();
    if (qv) params.set("q", qv);
    else params.delete("q");
    if (mstone.value) params.set("m", mstone.value);
    else params.delete("m");
    if (status.value) params.set("status", status.value);
    else params.delete("status");
    if (docType.value) params.set("type", docType.value);
    else params.delete("type");
    if (demoOnly) {
      if (demoOnly.checked) params.set("demo", "1");
      else params.delete("demo");
    }
    const qs = params.toString();
    const next = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
    const current = window.location.pathname + window.location.search + window.location.hash;
    if (next !== current) {
      history.replaceState(null, "", next);
    }
  }

  function applyFilter(shouldSyncUrl) {
    const qv = q.value.toLowerCase().trim();
    const mv = mstone.value;
    const sv = status.value;
    const tv = docType.value;
    const dv = demoOnly ? demoOnly.checked : false;
    let count = 0;
    for (const row of rows) {
      const search = row.dataset.search || "";
      const okq = !qv || search.includes(qv);
      const okm = !mv || row.dataset.mstone === mv;
      const oks = !sv || row.dataset.status === sv;
      const okt = !tv || row.dataset.type === tv;
      const okd = !dv || row.dataset.demo === "true";
      const show = okq && okm && oks && okt && okd;
      row.classList.toggle("hidden", !show);
      if (show) count++;
    }
    visible.textContent = String(count);
    if (emptyState) emptyState.hidden = count > 0 || rows.length === 0;
    if (clearBtn) clearBtn.disabled = !(qv || mv || sv || tv || dv);
    if (shouldSyncUrl) syncUrl();
  }

  function hydrateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    q.value = params.get("q") || "";
    setSelect(mstone, params.get("m") || "");
    setSelect(status, params.get("status") || "");
    setSelect(docType, params.get("type") || "");
    if (demoOnly) demoOnly.checked = params.get("demo") === "1";
    applyFilter(false);
  }

  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      applyFilter(true);
    });
  }
  q.addEventListener("input", () => applyFilter(true));
  mstone.addEventListener("change", () => applyFilter(true));
  status.addEventListener("change", () => applyFilter(true));
  docType.addEventListener("change", () => applyFilter(true));
  if (demoOnly) demoOnly.addEventListener("change", () => applyFilter(true));
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      q.value = "";
      mstone.value = "";
      status.value = "";
      docType.value = "";
      if (demoOnly) demoOnly.checked = false;
      applyFilter(true);
      q.focus();
    });
  }
  window.addEventListener("popstate", hydrateFromUrl);
  hydrateFromUrl();
})();
`;

// Exact CSP SHA-256 token for FEATURES_FILTER_SCRIPT. Verified by scripts/features-ux.test.mjs.
export const FEATURES_FILTER_SCRIPT_SHA256 =
  "'sha256-sjCGHwZ1VQwQX1jqokIzMbPCM25kSXOWWKVX25kuGBE='";

export function renderFeaturesCatalogueHtml(opts: FeaturesCatalogueOptions): string {
  const { rows, knownMilestones, speculationRulesHtml, canonicalUrl } = opts;
  const hasDemoMetadata = rows.some((r) => typeof r.hasDemo === "boolean");
  const safeCanonical = canonicalUrl ? safeExternalUrl(canonicalUrl) : null;

  const tableRows = rows.map((r) => {
    const rawName = typeof r.name === "string" ? r.name : "";
    const nameCut = Boolean(r.nameCut) || rawName.length > NAME_CAP;
    const name = rawName.slice(0, NAME_CAP);

    const rawSummary = typeof r.summary === "string" ? r.summary : "";
    const summary = rawSummary.slice(0, SUMMARY_CAP);

    const rawCategory = typeof r.category === "string" ? r.category : "";
    const categoryCut = Boolean(r.categoryCut) || rawCategory.length > CATEGORY_CAP;
    const category = rawCategory.slice(0, CATEGORY_CAP);

    const slug = typeof r.slug === "string" ? r.slug : "";
    const hasDoc = Boolean(r.hasDoc);
    const cat = categoryTag(category);

    // Narrowed at runtime, not escaped (gendn-sxn / THREAT_MODEL.md invariant #4).
    const mstone = milestonePathSegment(r.mstone);
    const docAttrs = mstone && slug
      ? `href="/v${milestonePathSegment(r.mstone)}/${escapeHTML(slug)}/"`
      : 'aria-disabled="true"';

    const docType = r.docStatus === "stub"
      ? "stub"
      : r.docStatus === "built"
      ? "built"
      : (hasDoc ? "built" : "pending");
    const hasDemo = r.hasDemo === true;

    const escapedName = escapeHTML(name);
    const displayName = `${escapedName}${nameCut ? "..." : ""}`;

    // Primary link fix: API name links directly to the local gendn reference page when built/stub.
    const primaryNameHtml = hasDoc
      ? `<a class="api-link" ${docAttrs}>${displayName}</a>`
      : `<span class="api-name">${displayName}</span>`;

    // Secondary ChromeStatus link, narrowed at runtime (gendn-b2s / THREAT_MODEL.md invariant #4).
    const csHref = chromeStatusUrl(r.id);
    const csSecondaryHtml = csHref
      ? ` <a class="cs-link" href="${csHref}" target="_blank" rel="noopener">ChromeStatus<span class="sr-only"> entry for ${escapedName}</span> <span aria-hidden="true">&#8599;</span></a>`
      : "";

    let docCell: string;
    if (hasDoc) {
      const primaryPill = docType === "stub"
        ? `<a class="tag tag-stub" ${docAttrs}>MDN stub<span class="sr-only"> for ${escapedName}</span> <span aria-hidden="true">&rarr;</span></a>`
        : `<a class="tag tag-live" ${docAttrs}>full ref<span class="sr-only"> for ${escapedName}</span> <span aria-hidden="true">&rarr;</span></a>`;
      const demoPill = hasDemo ? ` <span class="tag tag-demo">demo</span>` : "";
      docCell = `<span class="doc-pills">${primaryPill}${demoPill}</span>`;
    } else {
      docCell = `<span class="tag tag-pending">pending</span>`;
    }

    const searchMstone = mstone ?? "";
    const search = `${name} ${summary} ${cat} v${searchMstone}`.toLowerCase();
    const mstoneAttr = mstone ? ` data-mstone="${milestonePathSegment(r.mstone)}"` : "";
    const cutFields = [nameCut ? "name" : "", categoryCut ? "category" : ""]
      .filter(Boolean)
      .join(" ");
    const cutAttr = cutFields ? ` data-truncated="${cutFields}"` : "";
    const statusText = mstone
      ? `v${mstone}`
      : (r.mstone !== undefined && r.mstone !== null
        ? `v${escapeHTML(String(r.mstone))}`
        : "unknown");

    return `<tr data-search="${escapeHTML(search)}"${mstoneAttr}${cutAttr} data-status="${
      escapeHTML(cat)
    }" data-doc="${hasDoc}" data-type="${docType}" data-demo="${hasDemo}">
      <td>${primaryNameHtml}${csSecondaryHtml}</td>
      <td><span class="release-status">${statusText}</span></td>
      <td><span class="tag">${escapeHTML(cat)}${categoryCut ? "..." : ""}</span></td>
      <td>${docCell}</td>
    </tr>`;
  }).join("");

  const mstoneOptions = knownMilestones
    .map((m) => {
      const seg = milestonePathSegment(m);
      return seg ? `<option value="${seg}">v${seg}</option>` : "";
    })
    .join("");

  const demoFilterControl = hasDemoMetadata
    ? `<div class="filter-field filter-field--toggle">
      <label class="filter-toggle" for="demo-only">
        <input type="checkbox" id="demo-only" name="demo" value="1">
        <span>With interactive demo</span>
      </label>
    </div>`
    : "";

  const pageTitle = "all features — gendn";
  const pageDescription =
    `Filterable catalogue of ${rows.length} documented Chrome web platform APIs across every tracked milestone on gendn.`;
  const canonicalTag = safeCanonical
    ? `\n  <link rel="canonical" href="${escapeHTML(safeCanonical)}">`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${pageTitle}</title>
  <meta name="description" content="${escapeHTML(pageDescription)}">${canonicalTag}
  <meta property="og:title" content="${escapeHTML(pageTitle)}">
  <meta property="og:description" content="${escapeHTML(pageDescription)}">
  <meta property="og:type" content="website">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/styles.css">
  ${speculationRulesHtml}
  <style>
    .filters {
      display: flex;
      gap: var(--space-2) 0.55rem;
      flex-wrap: wrap;
      align-items: end;
      margin: 0 0 var(--space-5);
      padding: var(--space-3) var(--space-4);
      background: var(--bg-paper);
      border: 2px solid var(--border-black);
      box-shadow: var(--thin-shadow);
    }
    .filter-field {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      min-inline-size: 0;
    }
    .filter-field--search {
      flex: 1 1 140px;
    }
    .filter-field > label:not(.filter-toggle) {
      font-family: var(--font-mono);
      font-size-adjust: var(--adjust-mono);
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    .filters input[type="search"],
    .filters select {
      font-family: var(--font-mono);
      font-size-adjust: var(--adjust-mono);
      font-size: 0.8rem;
      min-block-size: 44px;
      padding: 0.4rem 0.45rem;
      background: var(--bg-ivory);
      color: var(--text-black);
      border: 2px solid var(--border-black);
      min-inline-size: 0;
    }
    .filters button.filter-clear {
      min-block-size: 44px;
      padding: 0.4rem 0.65rem;
      font-size: 0.76rem;
    }
    .filters input:focus-visible,
    .filters select:focus-visible {
      outline: 2px solid var(--accent-blue);
      outline-offset: 2px;
      background: var(--bg-paper);
    }
    .filter-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      min-block-size: 44px;
      font-family: var(--font-mono);
      font-size-adjust: var(--adjust-mono);
      font-size: 0.78rem;
      color: var(--text-black);
      background: var(--bg-ivory);
      border: 2px solid var(--border-black);
      padding: 0.4rem 0.55rem;
      cursor: pointer;
      white-space: nowrap;
    }
    .filter-toggle:has(:checked) {
      background: var(--bg-stone);
    }
    .filter-toggle input[type="checkbox"] {
      inline-size: 1rem;
      block-size: 1rem;
      accent-color: var(--accent-blue);
      cursor: pointer;
    }
    .features-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
      background: var(--bg-paper);
      border: 2px solid var(--border-black);
      box-shadow: var(--thin-shadow);
    }
    .features-table th,
    .features-table td {
      padding: 0.7rem 0.75rem;
      text-align: start;
      border-bottom: 1px solid var(--border-hairline);
      vertical-align: middle;
    }
    .features-table tbody tr:hover {
      background: var(--surface-warm);
    }
    .features-table th {
      font-family: var(--font-mono);
      font-size-adjust: var(--adjust-mono);
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-black);
      background: var(--surface-warm);
      border-bottom: 2px solid var(--border-black);
      white-space: nowrap;
      overflow-wrap: normal;
    }
    .features-table td:nth-child(2),
    .features-table td:nth-child(3),
    .features-table td:nth-child(4) {
      white-space: nowrap;
    }
    .features-table tbody tr:nth-child(n+25) {
      content-visibility: auto;
      contain-intrinsic-size: auto none auto 52px;
    }
    .features-table tr.hidden { display: none; }
    .features-table .api-link {
      color: var(--text-black);
      font-weight: 500;
      text-decoration: underline;
      text-decoration-color: var(--border-rule);
      text-underline-offset: 3px;
    }
    .features-table .api-link:hover {
      color: var(--accent-blue);
      text-decoration-color: var(--accent-blue);
    }
    .features-table .api-name { color: var(--text-black); font-weight: 500; }
    .features-table .cs-link {
      display: inline-block;
      margin-inline-start: 0.45rem;
      font-family: var(--font-mono);
      font-size-adjust: var(--adjust-mono);
      font-size: 0.72rem;
      color: var(--text-muted);
      text-decoration: underline;
      text-underline-offset: 2px;
      white-space: nowrap;
    }
    .features-table .cs-link:hover { color: var(--accent-blue); }
    .features-table .tag,
    .features-table .release-status { font-family: var(--font-mono); font-size-adjust: var(--adjust-mono); }
    .features-table .tag {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-black);
      background: var(--bg-paper);
      border: 1px solid var(--border-black);
      padding: 0.16rem 0.5rem;
      text-decoration: none;
    }
    .features-table .tag-live {
      background: var(--text-black);
      color: var(--bg-ivory);
      border-color: var(--text-black);
    }
    .features-table a.tag-live:hover {
      background: var(--accent-blue);
      border-color: var(--accent-blue);
      color: var(--pill-ink);
    }
    .features-table .tag-stub {
      color: var(--text-charcoal);
      background: var(--bg-stone);
      border: 1px dashed var(--border-black);
    }
    .features-table a.tag-stub:hover {
      color: var(--accent-blue);
      border-color: var(--accent-blue);
    }
    .features-table .tag-demo {
      color: var(--text-black);
      background: var(--bg-paper);
      border: 1px solid var(--border-black);
      border-inline-start: 3px solid var(--accent-emerald);
    }
    .features-table .tag-pending {
      color: var(--text-muted);
      border-color: var(--text-muted);
      border-style: dashed;
    }
    .features-table .doc-pills {
      display: inline-flex;
      flex-wrap: nowrap;
      gap: var(--space-1);
      align-items: center;
    }
    .features-table .doc-pills .tag {
      white-space: nowrap;
    }
    .features-table .release-status {
      background: var(--text-black);
      color: var(--bg-ivory);
      padding: 0.18rem 0.55rem;
      font-size: 0.74rem;
    }
    .stats {
      font-family: var(--font-mono);
      font-size-adjust: var(--adjust-mono);
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-bottom: var(--space-3);
    }
    .empty-state {
      margin-top: var(--space-4);
      padding: var(--space-5);
      background: var(--bg-paper);
      border: 2px solid var(--border-black);
      box-shadow: var(--thin-shadow);
      font-family: var(--font-serif);
      font-size-adjust: var(--adjust-serif);
      color: var(--text-charcoal);
      max-width: none;
    }

    @media (pointer: coarse) {
      .filters input[type="search"],
      .filters select,
      .filter-toggle,
      .crumbs a {
        min-block-size: 44px;
      }
      .crumbs a {
        display: inline-flex;
        align-items: center;
      }
      .features-table .api-link,
      .features-table .cs-link,
      .features-table .doc-pills a {
        display: inline-flex;
        align-items: center;
        min-block-size: 44px;
      }
    }

    @media (max-width: 640px) {
      .crumbs a {
        display: inline-flex;
        align-items: center;
        min-block-size: 44px;
      }
      .filters { padding: var(--space-3); gap: var(--space-2); }
      .filter-field,
      .filter-field--search,
      .filter-field--toggle,
      .filter-field--actions {
        flex: 1 1 100%;
        inline-size: 100%;
      }
      .filters input[type="search"],
      .filters select,
      .filter-toggle,
      button.filter-clear {
        inline-size: 100%;
        min-block-size: 44px;
        font-size: 1rem;
      }
      .features-table { background: transparent; border: none; box-shadow: none; }
      .features-table thead { display: none; }
      .features-table,
      .features-table tbody,
      .features-table tr,
      .features-table td {
        display: block;
        inline-size: 100%;
      }
      .features-table tr {
        border: 2px solid var(--border-black);
        background: var(--bg-paper);
        margin-bottom: var(--space-3);
        padding: var(--space-3);
        box-shadow: var(--thin-shadow);
      }
      .features-table tbody tr:hover { background: var(--bg-paper); }
      .features-table td {
        border: none;
        padding: 0.25rem 0;
      }
      .features-table td:first-child {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-1) var(--space-3);
        font-weight: 600;
        padding-bottom: var(--space-2);
      }
      .features-table .api-link,
      .features-table .cs-link,
      .features-table .doc-pills a {
        display: inline-flex;
        align-items: center;
        min-block-size: 44px;
      }
      .features-table .cs-link { margin-inline-start: 0; }
      .features-table td:not(:first-child) {
        display: inline-flex;
        align-items: center;
        inline-size: auto;
        margin-inline-end: var(--space-2);
        vertical-align: middle;
        white-space: normal;
      }
      .features-table .doc-pills {
        flex-wrap: wrap;
      }
    }
  </style>
</head>
<body class="shell-page">
${renderSiteHeader("features", "catalogue-main")}
<main id="catalogue-main" tabindex="-1">
  <header class="lede-block">
    <p class="eyebrow">catalogue</p>
    <h1>All APIs</h1>
    <p class="lede">Every API with a written reference across every tracked Chrome milestone. Filter by name, milestone, rollout status, full reference vs MDN stub, or interactive demo availability.</p>
  </header>

  <form class="filters" id="filters-form" role="search" aria-label="Filter API catalogue" action="/features" method="get">
    <div class="filter-field filter-field--search">
      <label for="q">Search</label>
      <input type="search" id="q" name="q" placeholder="name, summary, category" enterkeyhint="search" autocomplete="off">
    </div>
    <div class="filter-field">
      <label for="mstone">Milestone</label>
      <select id="mstone" name="m">
        <option value="">All milestones</option>
        ${mstoneOptions}
      </select>
    </div>
    <div class="filter-field">
      <label for="status">Status</label>
      <select id="status" name="status">
        <option value="">Any status</option>
        <option value="Shipped">Shipped</option>
        <option value="Origin Trial">Origin Trial</option>
        <option value="Dev Trial">Dev Trial</option>
        <option value="Stepped rollout">Stepped rollout</option>
      </select>
    </div>
    <div class="filter-field">
      <label for="doc-type">Doc type</label>
      <select id="doc-type" name="type">
        <option value="">All docs</option>
        <option value="built">Full references</option>
        <option value="stub">MDN stubs</option>
      </select>
    </div>
    ${demoFilterControl}
    <div class="filter-field filter-field--actions">
      <button type="button" id="clear-filters" class="filter-clear" disabled>Clear filters</button>
    </div>
  </form>

  <p class="stats" id="stats" role="status" aria-live="polite" aria-atomic="true"><span id="visible">${rows.length}</span> / ${rows.length} references</p>

  <table class="features-table">
    <caption class="sr-only">Chrome platform API references indexed on gendn</caption>
    <thead>
      <tr><th scope="col">api</th><th scope="col">milestone</th><th scope="col">status</th><th scope="col">doc</th></tr>
    </thead>
    <tbody id="rows">${tableRows}</tbody>
  </table>
  <p id="empty-state" class="empty-state" hidden>No references match the current filters.</p>

  <script>${FEATURES_FILTER_SCRIPT}</script>

  ${renderSiteFooter()}
</main>
</body>
</html>`;
}
