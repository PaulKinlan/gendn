// gendn-m7e — SURFACE COVERAGE: a contract can pass every gate while mapping a dimension
// to the WRONG surface (the selector's id exists and the slice is long, but the slice does
// not contain the surface the dimension claims). Concrete origin: gendn-5ao mapped the
// css-scroll-state 'syntax' dimension at #syntax, orphaning the feature's namesake query
// call form; validate-artifacts returned PASS exit 0 on that tree (bc8f73e / 2abb4c65).
//
// DESIGN (coord-approved on the bead, prototype measured first):
//   • STRICT TIER (syntax, examples, errors, inputs, outputs): the slice resolved by the
//     library's own fragmentAfterId must contain at least one SURFACE MARKER of the
//     inventory item — its declared `surfaceMarkers` (schema field; an explicit claim that
//     wins when present) or, absent a declaration, candidates derived from the item's
//     name/id via the library's nameTokens minus a published classifier-stopword list.
//   • EXEMPT TIER (context, lifecycle, compatibility, securityPrivacy): report-only — those
//     surfaces are legitimately feature-wide prose and a member token is not their claim.
//   • No derivable candidates and no declared markers => WARNING, never a failure: prose-only
//     surfaces exist (policy/migration pages). Declaring surfaceMarkers upgrades such an
//     item to enforced coverage — the honest fix path for the alias class.
//   • The slicing rule is EXECUTED, never re-implemented: fragmentAfterId/stripMarkup/
//     nameTokens are imported from ./reference-contract.mjs (acceptance criterion: a copied
//     rule silently inherits its author's misreading — the /<h[1-3]\b/i vs 'next h2' trap
//     that produced 5ao's self-confirming probe).
import {
  fragmentAfterId,
  nameTokens,
  resolveDocumentationHref,
  stripMarkup,
} from "./reference-contract.mjs";

export const STRICT_TIER = new Set(["syntax", "examples", "errors", "inputs", "outputs"]);
export const EXEMPT_TIER = new Set(["context", "lifecycle", "compatibility", "securityPrivacy"]);

// Classifier/prose words that appear in inventory ids and names but are not surface
// tokens. Published here (not hidden in a regex) so a review can audit every exemption.
export const CLASSIFIER_STOPWORDS = new Set([
  "interface",
  "method",
  "methods",
  "property",
  "properties",
  "attribute",
  "attributes",
  "dictionary",
  "enum",
  "constructor",
  "value",
  "values",
  "element",
  "elements",
  "header",
  "headers",
  "directive",
  "directives",
  "api",
  "apis",
  "the",
  "for",
  "with",
  "and",
  "of",
  "on",
  "in",
  "to",
  "from",
  "new",
  "via",
  "per",
  "css",
  "html",
  "event",
  "events",
  "function",
  "functions",
  "object",
  "objects",
  "member",
  "members",
  "type",
  "types",
  "shape",
  "behavior",
  "behaviour",
  "timing",
  "entry",
  "entries",
  "feature",
  "features",
  "surface",
  "support",
  "policy",
  "policies",
  "callback",
  "static",
  "global",
  "domstring",
  "unsigned",
  "readonly",
  "optional",
  "promise",
  "string",
  "number",
  "boolean",
  "context",
  "lifecycle",
  "syntax",
  "examples",
  "errors",
  "inputs",
  "outputs",
  "compatibility",
  "security",
  "privacy",
  "description",
  "overview",
  "introduction",
  "initial",
  "default",
  "returns",
  "returned",
  "under",
  "using",
  "used",
  "when",
  "where",
  "that",
  "this",
  "these",
  "those",
  "not",
  "all",
  "any",
  "its",
  "their",
  "also",
  "both",
  "each",
  "such",
  "like",
  "than",
  "then",
  "only",
  "over",
  "into",
  "onto",
  "upon",
  "within",
  "without",
  "before",
  "after",
  "during",
  "between",
  "against",
  "across",
  "through",
  "around",
  "above",
  "below",
  "chrome",
  "browser",
  "web",
  "page",
  "pages",
  "site",
  "sites",
]);

/**
 * Surface markers for one inventory item: its declared `surfaceMarkers` when present
 * (explicit claim wins), else candidates derived from name/id. Pure; exported for the
 * fixture. Returns { markers, declared }.
 */
export function surfaceMarkersFor(item) {
  const declared = (item?.surfaceMarkers ?? []).map((m) => String(m).toLowerCase()).filter(Boolean);
  if (declared.length > 0) return { markers: declared, declared: true };
  const out = new Set();
  const name = String(item?.name ?? "");
  // camelCase / PascalCase identifiers - stopword-filtered like every other branch:
  // a leaked generic token ("css", "api", "domstring") is a false-NEGATIVE engine (it
  // makes wrong-surface slices pass); review demonstrated one on scroll-axis-lock.
  for (const m of name.matchAll(/\b[a-zA-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g)) {
    const t = m[0].toLowerCase();
    if (!CLASSIFIER_STOPWORDS.has(t)) out.add(t);
  }
  // dotted member access (StorageEstimate.usage -> usage; navigator.cpuPerformance -> cpuperformance)
  for (
    const m of name.matchAll(
      /\b(?:[A-Za-z][A-Za-z0-9]*\.)*([A-Za-z][A-Za-z0-9]*)\.[a-z][A-Za-z0-9]*\b/g,
    )
  ) {
    const t = m[1].toLowerCase();
    if (!CLASSIFIER_STOPWORDS.has(t)) out.add(t);
  }
  for (const m of name.matchAll(/\b[A-Za-z][A-Za-z0-9]*\.([a-z][A-Za-z0-9]*)\b/g)) {
    const t = m[1].toLowerCase();
    if (!CLASSIFIER_STOPWORDS.has(t)) out.add(t);
  }
  // kebab-case names of 2+ segments (ruby-overhang, window-drag, scroll-state)
  for (const m of name.matchAll(/\b[a-z]+(?:-[a-z0-9]+)+\b/g)) {
    if (!CLASSIFIER_STOPWORDS.has(m[0])) out.add(m[0]);
  }
  // function-call forms: name(
  for (const m of name.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*)\s*\(/g)) {
    if (!CLASSIFIER_STOPWORDS.has(m[1].toLowerCase())) out.add(m[1].toLowerCase());
  }
  // long name tokens that survive the stopword filter
  for (const t of nameTokens(name)) if (t.length >= 5 && !CLASSIFIER_STOPWORDS.has(t)) out.add(t);
  // id tokens as a weak fallback (ids are slugs; long segments only)
  for (const t of nameTokens(item?.id)) {
    if (t.length >= 5 && !CLASSIFIER_STOPWORDS.has(t)) out.add(t);
  }
  return { markers: [...out], declared: false };
}

/**
 * Surface-coverage findings for one contract. EXECUTES the library slicer.
 * readHtml(path) -> string|null. Returns findings:
 *   cls "wrong-surface"  — strict-tier documented slice contains NONE of the item's markers
 *                          (the 5ao class; a failure in gate mode)
 *   cls "summary-table"  — wrong-surface whose slice is a table with no <code>: the selector
 *                          maps a summary/glance table rather than the member's own surface
 *   cls "no-candidate"   — item has no declared markers and no derivable candidates
 *                          (WARNING only; declare surfaceMarkers to enforce)
 * Exempt-tier dimensions are never findings (report-only tier by design).
 */
export async function surfaceCoverageFindings(contract, root, readHtml) {
  const findings = [];
  const id = contract?.id ?? "(unknown)";
  const inv = new Map((contract?.inventory ?? []).map((i) => [i.id, i]));
  for (const doc of contract?.documentation ?? []) {
    const item = inv.get(doc.inventoryId);
    if (!item) continue; // ownership validation reports this elsewhere
    const resolved = resolveDocumentationHref(id, doc.href, root);
    if (!resolved.ok) continue; // href validation reports this elsewhere
    const html = await readHtml(resolved.path);
    if (html == null) continue;
    const { markers, declared } = surfaceMarkersFor(item);
    for (const [dim, cov] of Object.entries(doc.dimensions ?? {})) {
      if (!STRICT_TIER.has(dim)) continue; // exempt tier: report-only by design
      if (cov?.status !== "documented" || !cov.selector) continue;
      if (markers.length === 0) {
        findings.push({
          cls: "no-candidate",
          id,
          inventoryId: doc.inventoryId,
          dim,
          selector: cov.selector,
          declared,
          sliceLen: 0,
          head: "",
        });
        continue;
      }
      const slice = fragmentAfterId(html, cov.selector.slice(1));
      const text = stripMarkup(slice).toLowerCase();
      if (markers.some((m) => text.includes(m))) continue;
      findings.push({
        cls: /<table\b/i.test(slice) && !/<code\b/i.test(slice) ? "summary-table" : "wrong-surface",
        id,
        inventoryId: doc.inventoryId,
        dim,
        selector: cov.selector,
        declared,
        markers: markers.slice(0, 8),
        sliceLen: text.length,
        head: text.slice(0, 100),
      });
    }
  }
  return findings;
}
