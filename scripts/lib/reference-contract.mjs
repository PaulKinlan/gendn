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

function hasHref(html, url) {
  const escaped = escapeRegExp(url).replace(/&/g, "(?:&|&amp;)");
  return new RegExp(`<a\\b[^>]*\\shref=["']${escaped}["']`, "i").test(renderedMarkup(html));
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
