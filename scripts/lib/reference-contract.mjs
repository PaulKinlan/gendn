// Structural validation for gendn implementation-sufficiency contracts.
//
// The contract cannot prove prose is correct. It does make omissions measurable: an authoritative,
// sourced surface inventory must map one-to-one to documentation, and every documented item must
// cover the same nine implementation dimensions at a resolvable fragment or state why a dimension
// does not apply. Independent review remains responsible for checking the inventory against sources.

import { readJson, renderedMarkup } from "./artifacts.mjs";

export const REFERENCE_CONTRACT = "reference-contract.json";
export const REQUIRED_DIMENSIONS = [
  "syntax",
  "inputs",
  "outputs",
  "errors",
  "context",
  "lifecycle",
  "examples",
  "compatibility",
  "securityPrivacy",
];

export async function collectReferenceContracts(root = ".", pageIds = []) {
  const records = [];
  for (const ownerId of pageIds) {
    const path = `${root}/${ownerId}/${REFERENCE_CONTRACT}`;
    const contract = await readJson(path);
    if (contract) records.push({ ownerId, path, contract });
  }
  return records;
}

export function validateContractOwnership(record) {
  const errors = [];
  const { ownerId, path, contract } = record;
  if (contract.id !== ownerId) {
    errors.push(
      `${path}: claims id ${JSON.stringify(contract.id)} but owner directory is ${ownerId}`,
    );
  }
  if (contract.route !== `/${ownerId}/`) {
    errors.push(`${path}: route must be /${ownerId}/`);
  }
  return errors;
}

export async function validateReferenceContract(contract, root = ".") {
  const errors = [];
  const id = contract?.id ?? "(unknown)";
  const sourceById = uniqueMap(contract?.sources ?? [], "id", errors, `${id}: source`);
  const inventoryById = uniqueMap(contract?.inventory ?? [], "id", errors, `${id}: inventory`);
  const docsById = uniqueMap(
    contract?.documentation ?? [],
    "inventoryId",
    errors,
    `${id}: documentation`,
  );

  for (const item of contract?.inventory ?? []) {
    validateSourceRefs(item.sourceRefs, sourceById, errors, `${id}: inventory ${item.id}`);
  }
  for (const doc of contract?.documentation ?? []) {
    if (!inventoryById.has(doc.inventoryId)) {
      errors.push(`${id}: documentation ${doc.inventoryId} maps to no inventory item`);
      continue;
    }
    const resolved = resolveDocumentationHref(id, doc.href, root);
    if (!resolved.ok) {
      errors.push(`${id}: documentation ${doc.inventoryId}: ${resolved.error}`);
      continue;
    }
    let html;
    try {
      html = await Deno.readTextFile(resolved.path);
    } catch {
      errors.push(
        `${id}: documentation ${doc.inventoryId}: href ${
          JSON.stringify(doc.href)
        } resolves to missing ${resolved.path}`,
      );
      continue;
    }

    const inventoryItem = inventoryById.get(doc.inventoryId);
    for (const sourceRef of inventoryItem?.sourceRefs ?? []) {
      const source = sourceById.get(sourceRef);
      if (source && !hasHref(html, source.url)) {
        errors.push(
          `${id}: documentation ${doc.inventoryId}: target page does not link inventory source ${sourceRef} (${source.url})`,
        );
      }
    }

    for (const dimension of REQUIRED_DIMENSIONS) {
      const coverage = doc.dimensions?.[dimension];
      if (!coverage) continue; // schema reports the missing key
      const tag = `${id}: ${doc.inventoryId}.${dimension}`;
      validateSourceRefs(coverage.sourceRefs, sourceById, errors, tag);
      for (const sourceRef of coverage.sourceRefs ?? []) {
        const source = sourceById.get(sourceRef);
        if (source && !hasHref(html, source.url)) {
          errors.push(
            `${tag}: target page does not link its cited source ${sourceRef} (${source.url})`,
          );
        }
      }

      if (coverage.status === "missing") {
        if (contract.completeness === "implementation-sufficient") {
          errors.push(`${tag}: is missing but contract claims implementation-sufficient`);
        }
        if (!meaningful(coverage.rationale, 20)) {
          errors.push(`${tag}: missing coverage requires a specific rationale (20+ characters)`);
        }
        continue;
      }
      if (coverage.status === "not-applicable") {
        if (!meaningful(coverage.rationale, 20)) {
          errors.push(`${tag}: not-applicable requires a sourced rationale (20+ characters)`);
        }
        if (!coverage.selector) {
          errors.push(`${tag}: not-applicable rationale must resolve to a rendered fragment`);
        } else if (!hasId(html, coverage.selector.slice(1))) {
          errors.push(`${tag}: selector ${coverage.selector} does not exist in ${resolved.path}`);
        } else if (
          !meaningful(stripMarkup(fragmentAfterId(html, coverage.selector.slice(1))), 40)
        ) {
          errors.push(`${tag}: not-applicable fragment has less than 40 characters of rationale`);
        }
        continue;
      }
      if (coverage.status !== "documented") continue; // schema reports invalid status
      if (!coverage.selector) {
        errors.push(`${tag}: documented coverage requires a fragment selector`);
        continue;
      }
      if (!hasId(html, coverage.selector.slice(1))) {
        errors.push(`${tag}: selector ${coverage.selector} does not exist in ${resolved.path}`);
        continue;
      }
      const fragment = fragmentAfterId(html, coverage.selector.slice(1));
      if (!meaningful(stripMarkup(fragment), 40)) {
        errors.push(`${tag}: ${coverage.selector} has less than 40 characters of substantive text`);
      }
      if (dimension === "syntax" && !/<code\b/i.test(fragment)) {
        errors.push(`${tag}: syntax coverage must include semantic <code>`);
      }
      if (dimension === "examples" && !/<pre\b[^>]*>[\s\S]*?<code\b/i.test(fragment)) {
        errors.push(`${tag}: examples coverage must include a <pre><code> example`);
      }
      if (dimension === "compatibility" && !/<table\b/i.test(fragment)) {
        errors.push(
          `${tag}: compatibility coverage must include a table (unknown is a valid cell)`,
        );
      }
    }
  }

  if (contract?.completeness === "implementation-sufficient") {
    for (const inventoryId of inventoryById.keys()) {
      if (!docsById.has(inventoryId)) {
        errors.push(`${id}: inventory item ${inventoryId} has no documentation mapping`);
      }
    }
    for (const doc of contract?.documentation ?? []) {
      for (const dimension of REQUIRED_DIMENSIONS) {
        if (doc.dimensions?.[dimension]?.status === "missing") {
          errors.push(`${id}: ${doc.inventoryId}.${dimension} is missing`);
        }
      }
      for (const mandatory of ["syntax", "examples", "compatibility"]) {
        if (doc.dimensions?.[mandatory]?.status !== "documented") {
          errors.push(
            `${id}: ${doc.inventoryId}.${mandatory} must be documented for an implementation-sufficient claim`,
          );
        }
      }
    }
  }

  return errors;
}

// DECLARED-SURFACE COVERAGE (gendn-4kq).
//
// WHY: the structural rules above are BIDIRECTIONAL (every inventory item must map to
// documentation, and vice versa), so the cheapest way to satisfy them is to SHRINK the inventory
// until everything maps. A contract can therefore claim `implementation-sufficient` while
// enumerating one member of a twenty-five-member surface, and the validator says nothing, because
// it never compares the inventory against anything outside the contract.
//
// WHAT IT CHECKS: the members the PAGE ITSELF declares in its `#syntax` IDL block. Every declared
// member must be either matched by an inventory item (a name/id token) or listed in the contract's
// `outOfScope` array with a rationale. A collapsed inventory therefore FAILS unless the author
// writes down, member by member, what they are dropping and why. The failure names the dropped
// member; the summary (declaredSurfaceSummary) reports the RATIO - inventory N, outOfScope M - so a
// contract with 1 inventoried and 24 excluded reads as that shape at a glance.
//
// SCOPED TO TOUCHED PAGES (coord, 2026-10-06): this rule is enforced by check-conformance for
// feature ids in the touched set, NOT by the general artifact validator. A new check must not go
// red for PRE-EXISTING state: 7 of the 43 older contracts quote a surrounding interface as context
// (audiopreferred-capture prints all of DisplayMediaStreamOptions; gamepad-button-type prints all
// of GamepadButton) and would red for a pattern that is not the defect this catches. A collapsed
// contract is authored at the moment a page is touched, so the touched set is where it bites.
// Cleanup of those 7 (adding honest outOfScope entries) is tracked separately as gendn-1j4.
//
// IT CANNOT PROVE THE INVENTORY IS COMPLETE, and it has a known blind spot: a page that declares NO
// IDL in its syntax block yields no members to compare against, so a collapsed contract on such a
// page passes. The collapsed v151/speculation-rules-form-submission-field contract is exactly that
// case - its syntax block shows a JSON structure, not IDL - and it is NOT caught here. A green from
// this rule means "not SILENTLY smaller than the page's declared IDL", nothing more: prose
// correctness and the real spec surface remain independent-review obligations, as the header says.
export function declaredSurfaceMembers(html) {
  const markup = renderedMarkup(html);
  const start = markup.search(/\bid=["']syntax["']/i);
  if (start < 0) return [];
  const rest = markup.slice(start);
  const nextHeading = rest.slice(10).search(/<h2\b/i);
  const fragment = nextHeading < 0 ? rest : rest.slice(0, nextHeading + 10);
  const names = new Set();
  for (const pre of fragment.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi)) {
    const idl = pre[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    if (!/\b(?:interface|dictionary|enum|attribute)\b/.test(idl)) continue;
    // Strip WebIDL extended attributes ([Exposed=Window], [RuntimeEnabled=X], ...) so they are
    // never mistaken for members.
    const bare = idl.replace(/\[[^\]]*\]/g, " ");
    for (
      const m of bare.matchAll(
        /(?:attribute\s+[\w<>?\[\], ]+?\s+|Promise<[^>]+>\s+|\bundefined\s+|\bboolean\s+|\bDOMString\s+|\bunsigned long\s+|\bdouble\s+)(\w+)\s*(?:\(|;)/g,
      )
    ) names.add(m[1]);
    for (
      const m of bare.matchAll(/^\s*(?:required\s+)?[\w<>?\[\], ]+\s+(\w+)\s*(?:=\s*[^;]+)?;/gm)
    ) {
      names.add(m[1]);
    }
  }
  const KEYWORDS = new Set([
    "interface",
    "dictionary",
    "enum",
    "partial",
    "mixin",
    "stringifier",
    "readonly",
    "required",
    "attribute",
    "static",
    "getter",
    "setter",
    "deleter",
    "constructor",
  ]);
  return [...names].filter((n) => !KEYWORDS.has(n.toLowerCase())).sort();
}

function nameTokens(value) {
  return String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function validateDeclaredSurface(contract, html) {
  const errors = [];
  const id = contract?.id ?? "(unknown)";
  const members = declaredSurfaceMembers(html);
  if (members.length === 0) return errors;
  const covered = new Set();
  for (const item of contract?.inventory ?? []) {
    for (const token of nameTokens(item?.name)) covered.add(token);
    for (const token of nameTokens(item?.id)) covered.add(token);
  }
  const excluded = new Map();
  for (const entry of contract?.outOfScope ?? []) {
    const name = String(entry?.name ?? "");
    if (!name) {
      errors.push(`${id}: outOfScope entry is missing a name`);
      continue;
    }
    if (!meaningful(entry?.rationale, 20)) {
      errors.push(`${id}: outOfScope ${name} needs a rationale (20+ characters)`);
    }
    if (excluded.has(name.toLowerCase())) {
      errors.push(`${id}: outOfScope lists ${name} twice`);
    }
    excluded.set(name.toLowerCase(), entry);
  }
  for (const [name] of excluded) {
    if (!members.some((m) => m.toLowerCase() === name)) {
      errors.push(
        `${id}: outOfScope ${name} matches no member declared in the page's syntax block`,
      );
    }
  }
  for (const member of members) {
    if (covered.has(member.toLowerCase())) continue;
    if (excluded.has(member.toLowerCase())) continue;
    errors.push(
      `${id}: declared surface member "${member}" is neither inventoried nor listed in outOfScope - ` +
        `a contract claiming implementation-sufficient must account for every member the page declares`,
    );
  }
  return errors;
}

export function declaredSurfaceSummary(contract, html) {
  const members = declaredSurfaceMembers(html);
  const covered = new Set();
  for (const item of contract?.inventory ?? []) {
    for (const token of nameTokens(item?.name)) covered.add(token);
    for (const token of nameTokens(item?.id)) covered.add(token);
  }
  const excluded = new Set(
    (contract?.outOfScope ?? []).map((e) => String(e?.name ?? "").toLowerCase()),
  );
  return {
    declared: members.length,
    inventory: members.filter((m) => covered.has(m.toLowerCase())).length,
    outOfScope: members.filter((m) => excluded.has(m.toLowerCase())).length,
  };
}

export function resolveDocumentationHref(id, href, root = ".") {
  if (typeof href !== "string" || !href) return { ok: false, error: "href is empty" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
    return { ok: false, error: "href must be a same-feature route or fragment" };
  }
  const [rawPath] = href.split("#", 1);
  const normalized = rawPath.startsWith("/")
    ? rawPath.replace(/^\/+/, "")
    : rawPath
    ? `${id}/${rawPath}`
    : id;
  const clean = normalized.replace(/\/+$/, "");
  if (clean.split("/").includes("..") || (clean !== id && !clean.startsWith(`${id}/`))) {
    return { ok: false, error: "href escapes the feature route" };
  }
  const path = `${root}/${clean}${/\.[a-z0-9]+$/i.test(clean) ? "" : "/index.html"}`;
  return { ok: true, path };
}

function uniqueMap(items, key, errors, tag) {
  const out = new Map();
  for (const item of items) {
    const value = item?.[key];
    if (out.has(value)) errors.push(`${tag}: duplicate ${key} ${JSON.stringify(value)}`);
    else out.set(value, item);
  }
  return out;
}

function validateSourceRefs(refs, sourceById, errors, tag) {
  for (const ref of refs ?? []) {
    if (!sourceById.has(ref)) errors.push(`${tag}: unknown sourceRef ${JSON.stringify(ref)}`);
  }
}

function hasId(html, id) {
  const escaped = escapeRegExp(id);
  return new RegExp(`\\bid=["']${escaped}["']`, "i").test(renderedMarkup(html));
}

/**
 * The CANONICAL form of a citation URL, used for BOTH sides of a citation comparison
 * (gendn-t77: a contract citing the bare host `https://example.org` could never match a page whose
 * link the browser resolves to `https://example.org/`, so the assertion silently asked for the wrong
 * spelling and pages drifted to matching it).
 *
 * THE RULE, PER COMPONENT — exactly what `new URL(s).href` does, and nothing more:
 *   scheme   : lower-cased, and http != https (a downgrade is a DIFFERENT citation; this repo
 *              requires direct canonical sources);
 *   host     : lower-cased; subdomains stay distinct (x.org != www.x.org);
 *   port     : a DEFAULT port is dropped (https://x:443/ == https://x/); a non-default one is kept
 *              and must match;
 *   path     : EMPTY path becomes "/" (this is the gendn-t77 incident); dot-segments are resolved;
 *              case and a trailing slash beyond that stay SIGNIFICANT;
 *   query    : SIGNIFICANT and preserved (a query is not decoration);
 *   fragment : SIGNIFICANT and preserved (a citation to #section is not the bare page — collapsing it
 *              would let a citation to the WRONG SECTION look present, which weakens the very
 *              property this gate protects);
 *   anything else: preserved verbatim.
 * A relative reference has no canonical absolute form, so it returns null and FAILS CLOSED: a
 * relative href on the page cannot satisfy an absolute citation, and an unparseable citation cannot
 * be satisfied by anything.
 */
export function canonicalCitationUrl(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
}

const HREF_ATTR = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** Decode the entities that can legitimately appear inside an href attribute. */
function decodeHrefEntities(value) {
  return value
    .replace(/&(?:amp|#38|#x26);/gi, "&")
    .replace(/&(?:quot|#34|#x22);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&(?:lt|#60|#x3c);/gi, "<")
    .replace(/&(?:gt|#62|#x3e);/gi, ">");
}

/** Exported for the gendn-t77 fixture, which pins the incident at the GATE level, not just the rule. */
export function hasHref(html, url) {
  const wanted = canonicalCitationUrl(url);
  if (wanted === null) return false; // fail closed (see the rule above)
  for (const match of renderedMarkup(html).matchAll(HREF_ATTR)) {
    const got = canonicalCitationUrl(decodeHrefEntities(match[1] ?? match[2] ?? ""));
    if (got !== null && got === wanted) return true;
  }
  return false;
}

function fragmentAfterId(html, id) {
  html = renderedMarkup(html);
  const escaped = escapeRegExp(id);
  const match = new RegExp(`\\bid=["']${escaped}["']`, "i").exec(html);
  if (!match) return "";
  const tail = html.slice(match.index);
  const nextHeading = /<h[1-3]\b/i.exec(tail.slice(match[0].length));
  return nextHeading ? tail.slice(0, match[0].length + nextHeading.index) : tail.slice(0, 8000);
}

function stripMarkup(value) {
  return renderedMarkup(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningful(value, minimum) {
  return typeof value === "string" && value.trim().length >= minimum;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
