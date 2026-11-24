// scripts/features-ux.test.mjs — unit, security, accessibility, CSP-hash, and behavioral tests
// for lib/features-ux.ts, public/favicon.svg, and additive public/styles.css utilities.
//
// Run: node scripts/features-ux.test.mjs

import * as sys from "./lib/sys.mjs";
import {
  CATEGORY_CAP,
  FEATURES_FILTER_SCRIPT,
  FEATURES_FILTER_SCRIPT_SHA256,
  NAME_CAP,
  renderFeaturesCatalogueHtml,
  SUMMARY_CAP,
} from "../lib/features-ux.ts";

let passed = 0;
let failures = 0;
function assert(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS: ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function sha256Token(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return `'sha256-${b64}'`;
}

const SPECULATION_RULES =
  '<script type="speculationrules">{"prefetch":[{"source":"document","where":{"href_matches":"/v*/**"},"eagerness":"moderate"}]}</script>';

const SAMPLE_ROWS = [
  {
    mstone: 152,
    id: 5123456789012345,
    name: "WebGPU Subgroups",
    slug: "webgpu-subgroups",
    summary: "Enables SIMD subgroup operations in WGSL compute shaders.",
    category: "Enabled by default",
    hasDoc: true,
    nameCut: false,
    categoryCut: false,
    docStatus: "built",
    hasDemo: true,
  },
  {
    mstone: 150,
    id: 5987654321098765,
    name: "CSS Anchor Positioning",
    slug: "css-anchor-positioning",
    summary: "Tethers positioned elements to anchor elements.",
    category: "Origin trial",
    hasDoc: true,
    nameCut: false,
    categoryCut: false,
    docStatus: "stub",
    hasDemo: false,
  },
  {
    mstone: 149,
    id: 4567890123456789,
    name: "Scroll Marker Pseudos",
    slug: "scroll-marker-pseudos",
    summary: "Declarative carousel markers.",
    category: "In developer trial (Behind a flag)",
    hasDoc: true,
    nameCut: false,
    categoryCut: false,
    docStatus: "built",
    hasDemo: false,
  },
];

// --- 1. Primary link fix, doc type pills, demo toggle, accessibility landmarks ---
{
  const html = renderFeaturesCatalogueHtml({
    rows: SAMPLE_ROWS,
    knownMilestones: [152, 150, 149],
    speculationRulesHtml: SPECULATION_RULES,
    canonicalUrl: "https://gendn.dev/features",
  });

  assert(
    "primary API link targets local gendn reference route /v<N>/<slug>/",
    html.includes('<a class="api-link" href="/v152/webgpu-subgroups/">WebGPU Subgroups</a>') &&
      html.includes(
        '<a class="api-link" href="/v150/css-anchor-positioning/">CSS Anchor Positioning</a>',
      ),
  );
  assert(
    "secondary ChromeStatus link targets narrowed chromestatus.com URL with unique sr-only text",
    html.includes(
      '<a class="cs-link" href="https://chromestatus.com/feature/5123456789012345" target="_blank" rel="noopener">ChromeStatus<span class="sr-only"> entry for WebGPU Subgroups</span>',
    ),
  );
  assert(
    "built vs stub doc pills and data-type attributes render honestly",
    html.includes('data-type="built"') &&
      html.includes('data-type="stub"') &&
      html.includes('class="tag tag-live"') &&
      html.includes(">full ref<span") &&
      html.includes('class="tag tag-stub"') &&
      html.includes(">MDN stub<span"),
  );
  assert(
    "demo tag and interactive demo filter render when hasDemo metadata is present",
    html.includes('data-demo="true"') &&
      html.includes('data-demo="false"') &&
      html.includes('<span class="tag tag-demo">demo</span>') &&
      html.includes('id="demo-only"') &&
      html.includes("With interactive demo"),
  );
  assert(
    "type filter exposes All docs, Full references, and MDN stubs options",
    html.includes('id="doc-type"') &&
      html.includes('<option value="">All docs</option>') &&
      html.includes('<option value="built">Full references</option>') &&
      html.includes('<option value="stub">MDN stubs</option>'),
  );
  assert(
    "every search/select/toggle control has an explicit associated <label for=...>",
    html.includes('<label for="q">') &&
      html.includes('<label for="mstone">') &&
      html.includes('<label for="status">') &&
      html.includes('<label for="doc-type">') &&
      html.includes('<label class="filter-toggle" for="demo-only">'),
  );
  assert(
    "visible count summary carries role=status and aria-live=polite",
    /<p[^>]*id="stats"[^>]*role="status"[^>]*aria-live="polite"[^>]*>[\s\S]*?<span id="visible">3<\/span> \/ 3 references<\/p>/
      .test(html),
  );
  assert(
    "semantic table has sr-only caption and scope=col headers",
    html.includes('<caption class="sr-only">') &&
      html.includes('<th scope="col">api</th>') &&
      html.includes('<th scope="col">milestone</th>') &&
      html.includes('<th scope="col">status</th>') &&
      html.includes('<th scope="col">doc</th>'),
  );
  assert(
    "skip link, color-scheme meta, favicon link, and canonical link render",
    html.includes('href="#catalogue-main"') &&
      html.includes('<main id="catalogue-main" tabindex="-1">') &&
      html.includes('<meta name="color-scheme" content="light dark">') &&
      html.includes('<link rel="icon" type="image/svg+xml" href="/public/favicon.svg">') &&
      html.includes('<link rel="canonical" href="https://gendn.dev/features">'),
  );
  assert(
    "Clear filters button renders disabled by default",
    html.includes('<button type="button" id="clear-filters" class="filter-clear" disabled>'),
  );

  // Zero raw hex colors in page <style> block (must use public/styles.css CSS variables only)
  const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert("page contains inline <style> block", styleMatch !== null);
  const rawHex = styleMatch ? styleMatch[1].match(/#[0-9a-fA-F]{3,8}\b/g) : null;
  assert(
    "page <style> uses CSS custom properties only (zero raw hex colors)",
    rawHex === null,
    rawHex ? `found raw hex: ${rawHex.join(", ")}` : "0 raw hex literals",
  );
}

// --- 2. Without hasDemo metadata: demo checkbox omitted, CSP hash unchanged ---
{
  const rowsNoDemo = SAMPLE_ROWS.map(({ hasDemo: _omit, ...rest }) => rest);
  const html = renderFeaturesCatalogueHtml({
    rows: rowsNoDemo,
    knownMilestones: [152, 150, 149],
    speculationRulesHtml: SPECULATION_RULES,
  });
  assert(
    "omits #demo-only checkbox when no row carries hasDemo metadata",
    !html.includes('id="demo-only"'),
  );
  assert("omits canonical tag when canonicalUrl not provided", !html.includes('rel="canonical"'));

  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
  const renderedHash = scriptMatch ? await sha256Token(scriptMatch[1]) : "";
  assert(
    "FEATURES_FILTER_SCRIPT_SHA256 matches rendered <script> even when hasDemo is absent",
    renderedHash === FEATURES_FILTER_SCRIPT_SHA256,
    renderedHash,
  );
}

// --- 3. CSP SHA-256 hash verification + detector ---
{
  const html = renderFeaturesCatalogueHtml({
    rows: SAMPLE_ROWS,
    knownMilestones: [152, 150, 149],
    speculationRulesHtml: SPECULATION_RULES,
  });
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert("exactly one executable inline <script> block in /features", scriptMatches.length === 1);
  const scriptBody = scriptMatches[0]?.[1] ?? "";
  assert(
    "rendered <script> body equals exported FEATURES_FILTER_SCRIPT byte-for-byte",
    scriptBody === FEATURES_FILTER_SCRIPT,
  );
  const actualHash = await sha256Token(scriptBody);
  assert(
    "FEATURES_FILTER_SCRIPT_SHA256 matches exact SHA-256 of rendered <script> body",
    actualHash === FEATURES_FILTER_SCRIPT_SHA256,
    `exported=${FEATURES_FILTER_SCRIPT_SHA256}`,
  );
  const mutatedHash = await sha256Token(`${scriptBody} `);
  assert(
    "CSP hash detector: 1-byte script mutation produces a different hash",
    mutatedHash !== FEATURES_FILTER_SCRIPT_SHA256,
  );
  assert(
    "inline filter script contains no innerHTML, outerHTML, eval, or document.write",
    !/\b(innerHTML|outerHTML|eval|document\.write)\b/.test(FEATURES_FILTER_SCRIPT),
  );
}

// --- 4. Hostile inputs, runtime narrowing, escaping, and field caps ---
{
  const evil = 'x"><script>alert(1)</script>';
  const oversizedName = `Animatable zoom${"!".repeat(5000)}`;
  const oversizedSummary = `${"z".repeat(5000)}UNIQUE_TAIL_BEYOND_CAP`;
  const oversizedCategory = `${"c".repeat(5000)}CATEGORY_TAIL_BEYOND_CAP`;

  const hostileRows = [
    {
      mstone: 150,
      id: '123" onmouseover="alert(1)',
      name: `API ${evil}`,
      slug: "api-evil",
      summary: evil,
      category: "Enabled by default",
      hasDoc: true,
      nameCut: false,
      categoryCut: false,
      docStatus: "built",
      hasDemo: false,
    },
    {
      mstone: '1" onmouseover="alert(1)',
      id: 9007199254740992, // exceeds MAX_SAFE_INTEGER -> rejected by chromeStatusUrl
      name: "Bad Milestone Feature",
      slug: "bad-milestone",
      summary: "safe summary",
      category: "Origin trial",
      hasDoc: true,
      nameCut: false,
      categoryCut: false,
      docStatus: "stub",
      hasDemo: false,
    },
    {
      mstone: 150,
      id: 103,
      name: oversizedName,
      slug: "animatable-zoom",
      summary: oversizedSummary,
      category: oversizedCategory,
      hasDoc: true,
      nameCut: true,
      categoryCut: true,
      docStatus: "built",
      hasDemo: false,
    },
    {
      mstone: 150,
      id: 104,
      name: 12345,
      slug: "non-string-fields",
      summary: { hostile: true },
      category: null,
      hasDoc: false,
      nameCut: false,
      categoryCut: false,
    },
  ];

  const html = renderFeaturesCatalogueHtml({
    rows: hostileRows,
    knownMilestones: [150, '1" onmouseover="alert(1)', 0, -5, 10000],
    speculationRulesHtml: SPECULATION_RULES,
    canonicalUrl: "javascript:alert(1)",
  });

  assert(
    "hostile inputs: zero raw <script>alert(1) or onmouseover attribute injection",
    !html.includes("<script>alert(1)</script>") &&
      !html.includes('x">') &&
      !html.includes('onmouseover="alert(1)"'),
  );
  assert(
    "hostile canonicalUrl (javascript:) is rejected and omitted",
    !html.includes("javascript:alert(1)") && !html.includes('rel="canonical"'),
  );
  assert(
    "hostile milestone option is dropped from #mstone select",
    html.includes('<option value="150">v150</option>') &&
      !html.includes('<option value="0">') &&
      !html.includes('<option value="-5">') &&
      !html.includes('<option value="10000">'),
  );
  assert(
    "hostile row milestone drops href and sets aria-disabled=true (never href=#)",
    !html.includes('href="#"') &&
      html.includes('<a class="api-link" aria-disabled="true">Bad Milestone Feature</a>'),
  );
  assert(
    "hostile/unsafe ChromeStatus IDs omit ChromeStatus link cleanly",
    !html.includes("chromestatus.com/feature/123") &&
      !html.includes("chromestatus.com/feature/9007199254740992"),
  );
  assert(
    "oversized name/summary/category respect caps and omit tails",
    !html.includes("UNIQUE_TAIL_BEYOND_CAP") &&
      !html.includes("unique_tail_beyond_cap") &&
      !html.includes("CATEGORY_TAIL_BEYOND_CAP") &&
      !html.includes("category_tail_beyond_cap") &&
      !new RegExp(`z{${SUMMARY_CAP + 1}}`).test(html) &&
      !new RegExp(`c{${CATEGORY_CAP + 1}}`).test(html) &&
      !new RegExp(`!{${NAME_CAP - "Animatable zoom".length + 1}}`).test(html),
  );
  assert(
    "truncated row carries data-truncated='name category' and display '...' markers while clean rows omit it",
    html.includes(' data-truncated="name category" ') &&
      (html.match(/data-truncated=/g)?.length ?? 0) === 1 &&
      html.includes(`${"!".repeat(NAME_CAP - "Animatable zoom".length)}...</a>`) &&
      html.includes(`tag">${"c".repeat(CATEGORY_CAP)}...</span>`),
  );
  assert(
    "non-string runtime fields degrade to empty without throwing or '[object Object]'",
    !html.includes("[object Object]") &&
      html.includes('<span class="tag tag-pending">pending</span>'),
  );
}

// --- 5. Behavioral verification of FEATURES_FILTER_SCRIPT (URL hydration, sync, clear) ---
{
  function makeControl(id, initialValue = "", options = []) {
    const listeners = new Map();
    return {
      id,
      value: initialValue,
      checked: false,
      disabled: false,
      hidden: false,
      focused: false,
      options: options.map((v) => ({ value: v })),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type, event = { preventDefault() {} }) {
        for (const fn of listeners.get(type) ?? []) fn(event);
      },
      focus() {
        this.focused = true;
      },
    };
  }

  function makeRow(dataset) {
    const classes = new Set();
    return {
      dataset,
      classList: {
        toggle(name, force) {
          if (force) classes.add(name);
          else classes.delete(name);
        },
        contains(name) {
          return classes.has(name);
        },
      },
    };
  }

  function runScriptWithUrl(initialSearch, hash = "") {
    const form = makeControl("filters-form");
    const q = makeControl("q");
    const mstone = makeControl("mstone", "", ["", "152", "150", "149"]);
    const status = makeControl("status", "", [
      "",
      "Shipped",
      "Origin Trial",
      "Dev Trial",
      "Stepped rollout",
    ]);
    const docType = makeControl("doc-type", "", ["", "built", "stub"]);
    const demoOnly = makeControl("demo-only");
    const clearBtn = makeControl("clear-filters");
    clearBtn.disabled = true;
    const visible = { textContent: "3" };
    const emptyState = { hidden: true };

    const rows = [
      makeRow({
        search: "webgpu subgroups wgsl shipped v152",
        mstone: "152",
        status: "Shipped",
        type: "built",
        demo: "true",
      }),
      makeRow({
        search: "css anchor positioning origin trial v150",
        mstone: "150",
        status: "Origin Trial",
        type: "stub",
        demo: "false",
      }),
      makeRow({
        search: "scroll marker pseudos dev trial v149",
        mstone: "149",
        status: "Dev Trial",
        type: "built",
        demo: "false",
      }),
    ];

    const byId = new Map([
      ["filters-form", form],
      ["q", q],
      ["mstone", mstone],
      ["status", status],
      ["doc-type", docType],
      ["demo-only", demoOnly],
      ["clear-filters", clearBtn],
      ["visible", visible],
      ["empty-state", emptyState],
    ]);

    const winListeners = new Map();
    const location = { pathname: "/features", search: initialSearch, hash };
    const replacedUrls = [];
    const history = {
      replaceState(_state, _title, nextUrl) {
        replacedUrls.push(nextUrl);
        const parsed = new URL(nextUrl, "https://gendn.example");
        location.pathname = parsed.pathname;
        location.search = parsed.search;
        location.hash = parsed.hash;
      },
    };
    const windowObj = {
      location,
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(fn);
      },
      dispatch(type) {
        for (const fn of winListeners.get(type) ?? []) fn();
      },
    };
    const documentObj = {
      getElementById(id) {
        return byId.get(id) ?? null;
      },
      querySelectorAll(sel) {
        return sel === "#rows tr" ? rows : [];
      },
    };

    const fn = new Function("document", "window", "history", FEATURES_FILTER_SCRIPT);
    fn(documentObj, windowObj, history);

    return {
      form,
      q,
      mstone,
      status,
      docType,
      demoOnly,
      clearBtn,
      visible,
      emptyState,
      rows,
      location,
      replacedUrls,
      windowObj,
    };
  }

  // Hydrate from URL params on load
  const s1 = runScriptWithUrl("?q=webgpu&m=152&status=Shipped&type=built&demo=1&utm=keep", "#top");
  assert(
    "filter script hydrates q, m, status, type, demo from URLSearchParams on load",
    s1.q.value === "webgpu" &&
      s1.mstone.value === "152" &&
      s1.status.value === "Shipped" &&
      s1.docType.value === "built" &&
      s1.demoOnly.checked === true &&
      s1.visible.textContent === "1" &&
      !s1.rows[0].classList.contains("hidden") &&
      s1.rows[1].classList.contains("hidden") &&
      s1.rows[2].classList.contains("hidden") &&
      s1.clearBtn.disabled === false &&
      s1.emptyState.hidden === true,
  );

  // Zero matches shows empty state and syncs URL
  s1.q.value = "nonexistent-api";
  s1.q.dispatch("input");
  assert(
    "filter script updates count to 0, reveals empty-state, and syncs URL via replaceState",
    s1.visible.textContent === "0" &&
      s1.emptyState.hidden === false &&
      s1.location.search.includes("q=nonexistent-api") &&
      s1.location.search.includes("utm=keep") &&
      s1.location.hash === "#top",
  );

  // Clear filters resets all controls, removes filter params, preserves unrelated params, focuses #q
  s1.clearBtn.dispatch("click");
  assert(
    "Clear filters resets controls, disables itself, restores all rows, preserves non-filter params, and focuses #q",
    s1.q.value === "" &&
      s1.mstone.value === "" &&
      s1.status.value === "" &&
      s1.docType.value === "" &&
      s1.demoOnly.checked === false &&
      s1.visible.textContent === "3" &&
      s1.emptyState.hidden === true &&
      s1.clearBtn.disabled === true &&
      s1.q.focused === true &&
      s1.location.search === "?utm=keep" &&
      s1.location.hash === "#top",
  );

  // Stub filter + popstate hydration
  s1.docType.value = "stub";
  s1.docType.dispatch("change");
  assert(
    "filtering by type=stub shows only MDN stubs and syncs type=stub to URL",
    s1.visible.textContent === "1" &&
      s1.rows[0].classList.contains("hidden") &&
      !s1.rows[1].classList.contains("hidden") &&
      s1.location.search.includes("type=stub"),
  );

  s1.location.search = "?m=149";
  s1.windowObj.dispatch("popstate");
  assert(
    "popstate re-hydrates filter state from updated URLSearchParams",
    s1.mstone.value === "149" &&
      s1.docType.value === "" &&
      s1.visible.textContent === "1" &&
      !s1.rows[2].classList.contains("hidden"),
  );

  // Invalid select values in URL safely degrade to ""
  const s2 = runScriptWithUrl("?m=999&status=Bogus&type=invalid");
  assert(
    "invalid URL select values reset safely to empty instead of hiding all rows",
    s2.mstone.value === "" &&
      s2.status.value === "" &&
      s2.docType.value === "" &&
      s2.visible.textContent === "3" &&
      s2.clearBtn.disabled === true,
  );
}

// --- 6. Editorial SVG favicon & additive styles.css checks ---
{
  const repoRoot = new URL("..", import.meta.url).pathname;
  const svgBytes = await sys.readFile(`${repoRoot}public/favicon.svg`);
  const svgText = new TextDecoder().decode(svgBytes);
  assert(
    "public/favicon.svg exists and is tiny (< 1024 bytes)",
    svgBytes.byteLength > 0 && svgBytes.byteLength < 1024,
    `${svgBytes.byteLength} bytes`,
  );
  assert(
    "public/favicon.svg has viewBox='0 0 32 32' and dark-mode prefers-color-scheme support",
    svgText.includes('viewBox="0 0 32 32"') &&
      svgText.includes("prefers-color-scheme: dark") &&
      svgText.includes("#fdfcf8") &&
      svgText.includes("#131210"),
  );

  const cssText = await sys.readTextFile(`${repoRoot}public/styles.css`);
  assert(
    "public/styles.css defines additive .sr-only, .doc-table--compact, .warn-block--common > strong, .tag-stub, .tag-demo, and .filter-clear utilities",
    cssText.includes(".sr-only:where(") &&
      cssText.includes(".doc-table--compact") &&
      cssText.includes(":where(.warn-block--common > strong)") &&
      cssText.includes(".tag-stub") &&
      cssText.includes(".tag-demo") &&
      cssText.includes("button.filter-clear"),
  );
}

if (failures > 0) {
  console.error(`\nfeatures-ux.test.mjs: ${failures} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\nfeatures-ux.test.mjs: all ${passed} assertions passed`);
