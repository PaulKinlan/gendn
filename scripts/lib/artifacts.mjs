// artifacts.mjs — shared helpers for gendn's critique + conformance + goals lifecycle.
//
// The catalogue is the filesystem convention `v<N>/<slug>/index.html` (there is no registry JSON).
// This module reads each published page's REAL metadata and colocated lifecycle artifacts:
//   v<N>/<slug>/index.html         — the reference page
//   v<N>/<slug>/conformance.json   — the immutable conformance suite (this repo's contract)
//   v<N>/<slug>/_questions.json    — the mutable critique
// plus repo-level goals.json and responsive-support.json.
//
// Nothing here fabricates data: assertions and support records are DERIVED from the page's own
// chromestatus id, route, status (built/stub), sections, and embedded showcase link.

import {
  judgedFileExists,
  readJudgedFile,
  readJudgedJson,
  stagedRevertedPaths,
} from "./judged-content.mjs";

export const SHOWCASE_HOST = "chrome-platform-showcase.paulkinlan-ea.deno.net";

const PAGE_RE = /^v\d+\/[^/]+\/index\.html$/;
const FEATURE_ID_RE = /chromestatus\.com\/feature\/(\d+)/;
const EXPERIMENTAL_RE =
  /origin[ -]?trial|dev(?:eloper)? trial|behind a flag|experimental|chrome:\/\/flags|--enable-blink-features/i;

// ---------- page discovery ----------

export async function collectPublishedPages(root = ".") {
  const pages = new Set();
  try {
    for await (const rel of Deno.readDir(root)) {
      if (!(rel.isDirectory && /^v\d+$/.test(rel.name))) continue;
      for await (const slug of Deno.readDir(`${root}/${rel.name}`)) {
        if (!slug.isDirectory) continue;
        const pagePath = `${rel.name}/${slug.name}/index.html`;
        if (await judgedFileExists(pagePath, root)) {
          pages.add(pagePath);
        }
      }
    }
  } catch {
    // directory may not exist
  }

  // Include any staged-reverted pages in index (e.g. staged added but deleted on disk)
  const staged = await stagedRevertedPaths(root);
  for (const p of staged) {
    if (PAGE_RE.test(p) && await judgedFileExists(p, root)) {
      pages.add(p);
    }
  }

  return [...pages].sort();
}

export async function pageMetadata(pagePath, root = ".") {
  const html = await readJudgedFile(pagePath, root);
  return metadataFromHtml(pagePath, html);
}

export function renderedMarkup(html) {
  let visible = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const hiddenBlocks = [
    /<details\b(?![^>]*\bopen(?:\s|=|>))[^>]*>[\s\S]*?<\/details\s*>/gi,
    /<([a-z][a-z0-9-]*)\b[^>]*\shidden(?:\s|=|>)[^>]*>[\s\S]*?<\/\1\s*>/gi,
    /<([a-z][a-z0-9-]*)\b[^>]*\saria-hidden=(?:["']true["']|true)(?:\s|>)[^>]*>[\s\S]*?<\/\1\s*>/gi,
    /<([a-z][a-z0-9-]*)\b[^>]*\sstyle=(?:["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)[^"']*["']|[^\s>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)[^\s>]*)[^>]*>[\s\S]*?<\/\1\s*>/gi,
  ];
  let previous;
  do {
    previous = visible;
    for (const hidden of hiddenBlocks) visible = visible.replace(hidden, "");
  } while (visible !== previous);
  return visible;
}

export function isMdnStubHtml(html) {
  const visible = renderedMarkup(html);
  return [
    ...visible.matchAll(/<p\b[^>]*class=["'][^"']*\beyebrow\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi),
  ]
    .some((match) => /covered on mdn/i.test(match[1].replace(/<[^>]+>/g, " ")));
}

export function metadataFromHtml(pagePath, html) {
  const parts = pagePath.split("/");
  const release = parts[0]; // v<N>
  const slug = parts[1];
  const id = `${release}/${slug}`;
  const route = `/${release}/${slug}/`;
  const milestone = Number(release.slice(1));

  const idMatch = html.match(FEATURE_ID_RE);
  const identity = idMatch ? idMatch[1] : null;
  const status = isMdnStubHtml(html) ? "stub" : "built";
  // gendn-aewp: the page's own eyebrow is the authoritative status claim. A shipped /
  // enabled-by-default eyebrow overrides experimental-sounding PROSE: historical flag
  // mentions ("Flag: None (was chrome://flags/#experimental-web-platform-features)")
  // must not mark a shipped page experimental. An eyebrow that itself carries an
  // experimental word (origin trial / developer trial / experimental) wins over the
  // shipped word, so mixed pages stay experimental.
  const eyebrow = renderedMarkup(html).match(
    /<p\b[^>]*class=["'][^"']*\beyebrow\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  )?.[1]?.replace(/<[^>]+>/g, " ") ?? "";
  const shippedClaim = /\b(?:shipped|enabled by default)\b/i.test(eyebrow) &&
    !EXPERIMENTAL_RE.test(eyebrow);
  const experimental = status === "built" && EXPERIMENTAL_RE.test(html) && !shippedClaim;
  // Removal / deprecation references don't ship an interactive example or a cross-browser support
  // table — the example/support assertions don't apply to them.
  //
  // gendn-n2k: the h1/h2 scan reads the RENDERED markup (comments, <script>/<style>/template
  // strings and hidden blocks stripped), NOT the raw html. This field feeds a gate —
  // gen-conformance.mjs:211 skips the support/example assertions for removal pages — so a
  // commented-out or scripted "Removal" heading must never flip a page's suite shape. Measured
  // over all 201 published pages (2026-10-06, evidence on the bead): the raw and rendered
  // derivations agree on every page (0 diffs, 11 removal pages), so this choice changes no
  // current verdict; it is made on robustness grounds and is PINNED by
  // scripts/artifacts-units.test.mjs — switching the scan back to raw html FAILS that suite.
  // The slug-prefix test stays path-derived (the path is not markup).
  //
  // KNOWN LIMITATION (stated per coord's evasion-surface acceptance): the stripping is
  // MARKUP-level. Text a reader cannot see via comments, <script>/<style>/template bodies,
  // <details closed>, [hidden], aria-hidden or INLINE display/visibility/content-visibility
  // can no longer flip this field — but an <h2> hidden only by an external stylesheet CLASS
  // still counts, because no markup-level derivation can read stylesheets. That residue is
  // pinned as current behaviour by the fixture ("n2k residue" assertion), not silently left.
  const visibleMarkup = renderedMarkup(html);
  const isRemoval = /^(deprecate|remove|disable)/.test(slug) ||
    /\bremov(e|ed|al)\b|\bdeprecat/i.test(
      visibleMarkup.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "",
    ) ||
    [...visibleMarkup.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].some((m) =>
      /remov|deprecat/i.test(m[1])
    );

  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
  const sections = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim()
  );

  const hasIframe = /<iframe\b/i.test(html);
  const hasWarnBlock = /class="[^"]*\bwarn-block\b/i.test(html);
  const hasByline = /class="[^"]*\bbyline\b/i.test(html);
  const hasStylesheet = /href="\/public\/styles\.css"/.test(html);

  // The embedded-demo identity: the showcase route this page links for its OWN feature.
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

  return {
    id,
    route,
    release,
    slug,
    milestone,
    identity,
    status,
    experimental,
    isRemoval,
    h1,
    sections,
    hasIframe,
    hasWarnBlock,
    hasByline,
    hasStylesheet,
    demo,
  };
}

// ---------- suite hashing (immutability signal) ----------

// Normalize an assertions array to a canonical string so the hash is stable regardless of key
// order or cosmetic whitespace. Assertions are sorted by id; each assertion's keys are sorted.
export function normalizeAssertions(assertions) {
  const norm = assertions
    .map((a) => {
      const keys = Object.keys(a).sort();
      const obj = {};
      for (const k of keys) obj[k] = a[k];
      return obj;
    })
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return JSON.stringify(norm);
}

export async function suiteHash(assertions) {
  const data = new TextEncoder().encode(normalizeAssertions(assertions));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- artifact loading ----------

export async function readJson(path, root = ".") {
  return await readJudgedJson(path, root);
}

export function conformancePath(pageId, root = ".") {
  return `${root}/${pageId}/conformance.json`;
}
export function critiquePath(pageId, root = ".") {
  return `${root}/${pageId}/_questions.json`;
}

export async function collectSuites(root = ".") {
  const pages = await collectPublishedPages(root);
  const out = [];
  for (const p of pages) {
    const pageId = p.replace(/\/index\.html$/, "");
    const suite = await readJson(conformancePath(pageId, root));
    if (suite) out.push(suite);
  }
  return out;
}

export async function collectCritiques(root = ".") {
  const pages = await collectPublishedPages(root);
  const out = [];
  for (const p of pages) {
    const pageId = p.replace(/\/index\.html$/, "");
    const c = await readJson(critiquePath(pageId, root));
    if (c) out.push(c);
  }
  return out;
}

// ---------- responsive support sidecar ----------

export const SUPPORT_SIDECAR = "responsive-support.json";

export async function loadSupport(root = ".") {
  const raw = await readJson(`${root}/${SUPPORT_SIDECAR}`);
  if (raw && raw.routes) return raw;
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), routes: {} };
}

export function supportForRoute(support, route) {
  return support.routes?.[route] ?? { desktop: "untested", mobile: "untested" };
}

/** Conditional unsupported evidence that our minimal JSON-schema validator cannot express. */
export function validateSupportRecord(route, record) {
  const unsupported = ["desktop", "mobile"].filter((cls) => record?.[cls] === "unsupported");
  if (unsupported.length === 0) return [];
  const errors = [];
  if (unsupported.length === 2) {
    errors.push(
      `${route}: both classes are unsupported, but this schema models evidence for only one class; add per-class evidence to the schema before recording both`,
    );
  } else if (record.unsupportedClass !== unsupported[0]) {
    errors.push(
      `${route}: ${unsupported[0]} unsupported requires unsupportedClass ${
        JSON.stringify(unsupported[0])
      } (got ${JSON.stringify(record.unsupportedClass)})`,
    );
  }
  const evidence = typeof record.evidence === "string" ? record.evidence.trim() : "";
  if (evidence.length < 20) {
    errors.push(
      `${route}: unsupported requires substantive evidence of platform unavailability (at least 20 non-whitespace characters)`,
    );
  }
  // The automated overflow scan can flag needs-review/broken; it cannot prove an API is
  // unavailable on an entire device class. Match the exact method, not prose mentioning it.
  if (record.method === "auto-scan") {
    errors.push(`${route}: auto-scan cannot establish unsupported platform capability`);
  }
  return errors;
}

// ---------- minimal draft-07 validator (dependency-free) ----------
//
// Covers the subset of JSON Schema this repo's four schemas use: type, required, enum, const,
// pattern, minimum/maximum, minLength/minItems, items, properties, additionalProperties,
// patternProperties, and intra-document $ref (#/definitions/...). Returns an array of error strings.

export function validate(schema, data, root = schema, path = "") {
  const errs = [];
  if (schema.$ref) {
    return validate(resolveRef(root, schema.$ref), data, root, path);
  }
  const type = schema.type;
  if (type && !checkType(type, data)) {
    errs.push(`${path || "(root)"}: expected type ${JSON.stringify(type)}, got ${jsType(data)}`);
    return errs; // type mismatch — downstream checks would be noise
  }
  if ("const" in schema && JSON.stringify(data) !== JSON.stringify(schema.const)) {
    errs.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(data))) {
    errs.push(`${path}: ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof data === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) {
      errs.push(`${path}: "${data}" does not match /${schema.pattern}/`);
    }
    if (schema.minLength != null && data.length < schema.minLength) {
      errs.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
  }
  if (typeof data === "number") {
    if (schema.minimum != null && data < schema.minimum) {
      errs.push(`${path}: ${data} < minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && data > schema.maximum) {
      errs.push(`${path}: ${data} > maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(data)) {
    if (schema.minItems != null && data.length < schema.minItems) {
      errs.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      data.forEach((item, i) => errs.push(...validate(schema.items, item, root, `${path}[${i}]`)));
    }
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const req of schema.required ?? []) {
      if (!(req in data)) errs.push(`${path}: missing required property "${req}"`);
    }
    const props = schema.properties ?? {};
    const patternProps = schema.patternProperties ?? {};
    for (const [key, val] of Object.entries(data)) {
      const childPath = path ? `${path}.${key}` : key;
      if (props[key]) {
        errs.push(...validate(props[key], val, root, childPath));
      } else {
        const pp = Object.entries(patternProps).find(([re]) => new RegExp(re).test(key));
        if (pp) {
          errs.push(...validate(pp[1], val, root, childPath));
        } else if (schema.additionalProperties === false) {
          errs.push(`${childPath}: additional property not allowed`);
        }
      }
    }
  }
  return errs;
}

function resolveRef(root, ref) {
  const parts = ref.replace(/^#\//, "").split("/");
  let node = root;
  for (const p of parts) node = node[p];
  if (!node) throw new Error(`cannot resolve $ref ${ref}`);
  return node;
}

function jsType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function checkType(type, v) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    if (t === "integer") return typeof v === "number" && Number.isInteger(v);
    if (t === "array") return Array.isArray(v);
    if (t === "object") return v !== null && typeof v === "object" && !Array.isArray(v);
    if (t === "null") return v === null;
    return typeof v === t;
  });
}

export async function loadSchema(name, root = ".") {
  return JSON.parse(await Deno.readTextFile(`${root}/schema/${name}`));
}
