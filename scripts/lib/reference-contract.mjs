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
// red for PRE-EXISTING state: 8 of the 43 older contracts quote a surrounding interface as context
// (audiopreferred-capture prints all of DisplayMediaStreamOptions; gamepad-button-type prints all
// of GamepadButton; no-auto-rewind quotes all of AnimationTrigger) and would red for a pattern that
// is not the defect this catches. A collapsed
// contract is authored at the moment a page is touched, so the touched set is where it bites.
// Cleanup of those 8 (adding honest outOfScope entries) is tracked separately as gendn-1j4.
//
// HOW THE SYNTAX SECTION IS FOUND: by id="syntax" when the page has one, otherwise by the heading
// TEXT (`<h2>Syntax</h2>`), because several pages ship the heading without an id and the rule must
// not be silently dead there. The region stops at the next h2, since the syntax block legitimately
// contains h3 member subheadings. A page with neither an id nor a "Syntax" heading yields no
// members and is not checked.
//
// TWO KNOWN PARSER LIMITS (gendn-4kq review 4, both latent - no current page hits either):
//   * an ANONYMOUS special operation with a non-keyword return type reports the TYPE as a member
//     (`getter DOMString (index)` -> "DOMString"). It over-reports, so it fails safe; every getter on
//     the current pages is named.
//   * THE TRIGGER IS A HEURISTIC, and its negative direction is a DECISION rather than an oversight.
//     A block whose members are declared without any declaration-shaped token (no interface/
//     dictionary/enum/namespace/callback/typedef/mixin/partial, no line-leading attribute) is read as
//     NOT-IDL, so a surface spelled in a shape we do not recognise there is invisible - the same
//     failure an operations-only `namespace` had before gendn-zuz broadened the gate and added the
//     loud failure below. The shapes currently in that class are the no-parameter-list special
//     declarations - `stringifier;`, `iterable<T>;`, `maplike<K,V>;`, `setlike<T>;` - which carry
//     neither a call shape nor a line-leading `attribute`, so the member hint does not fire and the
//     block reads as declaring nothing (no page in this repo declares one today). Broadening further
//     was rejected deliberately: failing on anything would flag every JSON/JS/CSS/ABNF block that
//     shares a syntax section - all four shapes DO occur on current pages - and a check that cries
//     wolf stops being read. So this rule is NECESSARY, not sufficient: prose correctness and the
//     real spec surface remain independent-review obligations, and a member that cannot be honestly
//     justified as context is a finding, not an entry.
//
// IT CANNOT PROVE THE INVENTORY IS COMPLETE, and it has a known blind spot: a page that declares NO
// IDL in its syntax block yields no members to compare against, so a collapsed contract on such a
// page passes. The collapsed v151/speculation-rules-form-submission-field contract is exactly that
// case - its syntax block shows a JSON structure, not IDL - and it is NOT caught here. A green from
// this rule means "not SILENTLY smaller than the page's declared IDL", nothing more: prose
// correctness and the real spec surface remain independent-review obligations, as the header says.
// WebIDL keywords and declaration words that must never be reported as members. Hoisted because the
// method match needs them too: in `readonly attribute (Foo or Bar) baz` the word before "(" is
// `attribute`, which is a KEYWORD, not a method name (gendn-4kq review 3).
// The parameterless CONSTRUCTS this parser reports by their own name (gendn-5t3). They are also
// WebIDL keywords, so the keyword filter below would otherwise discard them the moment they were
// added - the filter exists to stop `readonly`/`attribute` being reported as members, not to hide a
// declaration that the page really makes.
const SURFACE_CONSTRUCTS = new Set(["stringifier", "iterable", "maplike", "setlike"]);

const WEBIDL_KEYWORDS = new Set([
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
  "typedef",
  "callback",
  "namespace",
  "implements",
  "includes",
  "const",
  "unsigned",
  "long",
  "short",
  "double",
  "float",
  "boolean",
  "byte",
  "octet",
  "void",
  "undefined",
  "sequence",
  "record",
  "optional",
  "or",
]);

// What makes a block IDL FOR EXTRACTION: a declaration keyword, or a bare `attribute`. `namespace`
// and its neighbours are in this list because leaving them out is what made an operations-only
// namespace invisible - that block WAS parseable all along, the gate hid it (gendn-zuz). `(?<!@)`
// keeps a CSS `@namespace` at-rule from being read as WebIDL, and the list is deliberately narrower
// than "anything IDL-ish" so a JSON syntax block that merely contains the key "attribute"
// (v151/speculation-rules-form-submission-field) stays silent.
const IDL_BLOCK_GATE =
  /(?<!@)\b(?:interface|dictionary|enum|attribute|namespace|callback|typedef|mixin|partial)\b/;

// What makes a block look like it DECLARES members: a call shape, or a line-leading attribute. Used
// only to decide whether an unreadable block is a hole in the check rather than a legitimately empty
// declaration: `interface Foo { };` declares nothing and must stay silent, while a block with
// `parse();` in it that yields no member means the detector could not read a surface that is there.
const IDL_MEMBER_HINT =
  /\w\s*\(|^[ \t]*(?:readonly[ \t]+|static[ \t]+|const[ \t]+)?attribute[ \t]+/m;

// The syntax section: by id when the page gives one, otherwise by the heading TEXT. The text
// fallback exists because several pages ship `<h2>Syntax</h2>` with no id - without it the rule
// would be silently dead on exactly those pages (gendn-4kq review P1b). The region stops at the next
// h2, since the syntax block legitimately contains h3 member subheadings.
function syntaxRegionOf(markup) {
  const heading = [...markup.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi)].find((h) =>
    /\bid=["']syntax["']/i.test(h[2]) ||
    h[3].replace(/<[^>]+>/g, "").trim().toLowerCase() === "syntax"
  );
  if (!heading) return null;
  let region = markup.slice(heading.index + heading[0].length);
  const nextH2 = region.search(/<h2\b/i);
  if (nextH2 >= 0) region = region.slice(0, nextH2);
  return region;
}

function preBlocksIn(region) {
  const blocks = [];
  for (const pre of region.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi)) {
    const idl = pre[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    blocks.push(idl);
  }
  return blocks;
}

function memberNamesFromIdl(idl) {
  const names = new Set();
  // Strip WebIDL comments FIRST: `// partial interface Performance (core/timing/performance.idl)`
  // sits on the same `;`-statement as the method below it, and the "(" in that comment otherwise
  // wins the match and hides the real method (gendn-4kq review P1a). The `[^:]` guard keeps the
  // `//` in an https:// URL from truncating a line. Then strip extended attributes ([Exposed=...])
  // so they are never mistaken for members.
  const bare = idl
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // Extended attributes are stripped ONLY at the start of a line, where WebIDL puts them. A
    // blind /\[[^\]]*\]/g would also eat a default value such as `= []`, silently dropping the
    // member (gendn-4kq review 3, P1).
    .replace(/^[ \t]*\[[^\]]*\][ \t]*/gm, " ");
  // Parse per `;`-statement, stripping the enclosing declaration header (everything up to the
  // last "{") so members declared on the same line as the brace are still seen.
  for (const raw of bare.split(";")) {
    // Strip a LEADING declaration header only, and non-greedily: a greedy `[\s\S]*\{` matches the
    // `{` of a default value such as `= {}` and swallows the whole declaration, dropping the
    // method (gendn-4kq review 3, P1).
    const statement = raw
      .replace(
        /^[\s\S]*?\b(?:partial\s+)?(?:interface|dictionary|enum|mixin|namespace|callback\s+interface)\b[^{]*\{/,
        " ",
      )
      .replace(/^\}+/, "")
      .trim();
    if (!statement) continue;
    // `typedef X Y;` / `callback` / `namespace` declare a NAME, not a member; and in
    // `A implements B;` / `A includes B;` the B is a mixin name.
    if (/^(?:typedef|callback|namespace)\b/.test(statement)) continue;
    if (/^(?:[\w$]+\s+)?(?:implements|includes)\s+[\w$]+$/.test(statement)) continue;
    // WebIDL PARAMETERLESS SPECIALS (gendn-5t3): `stringifier;`, `iterable<T>;`, `maplike<K,V>;` and
    // `setlike<T>;` carry neither a parameter list nor a `Type name` shape, so without this they are
    // INVISIBLE to the parser - measured on the real catalogue: the page declaring `stringifier;`
    // yielded only its parse/parseAll members. They are not decoration either: maplike/setlike/
    // iterable IMPLY members the spec defines for them (for maplike<K,V>: size, get, has, set,
    // delete, entries, keys, values, forEach, @@iterator). Reported as the CONSTRUCT's own keyword so
    // a contract must acknowledge it once - the cheapest form that is SATISFIABLE, because
    // outOfScope with a rationale is the natural home when those implied members are specified in
    // the spec rather than written as prose, and an obligation a contract cannot discharge would
    // block pages instead of describing them.
    // THE IMPLIED MEMBERS ARE DELIBERATELY NOT EXPANDED, and this file must not be read as claiming
    // otherwise: enumerating them would impose a long list of new obligations and invite false
    // positives, so this narrows the blind spot (the construct must now be acknowledged) without
    // closing it. WHAT A GREEN THEREFORE MEANS, precisely: the contract ACKNOWLEDGED the construct
    // - it does NOT mean the page documents or inventories the members the construct implies.
    // Matched ONLY when the statement is the special alone, so `stringifier attribute
    // DOMString foo;` still reaches the attribute path below and keeps reporting `foo`.
    // ESCAPING MATTERS FOR THE GENERIC FORMS: `maplike<DOMString, Node>;` inside a `<pre>` is only
    // visible to this parser when the page writes `&lt;`/`&gt;`; a RAW `<...>` reads as an HTML tag
    // and the markup stripper removes it, so an unescaped nested generic degrades to `maplike>;` and
    // is missed. Measured across this catalogue: all 35 IDL-looking syntax blocks escape their
    // generics (the only angle brackets in them are `<code>` tags), so the hazard is unreachable
    // here - it would need a page shipping raw IDL inside `<pre>`.
    const special = statement.match(/^(stringifier|iterable|maplike|setlike)\s*(?:<[\s\S]*>)?$/i);
    if (special) {
      names.add(special[1]);
      continue;
    }
    // METHODS and ATTRIBUTES: the name before "(", whatever the return type. Return-type-agnostic
    // on purpose: whitelisting types missed `SpeculationData getSpeculations();`, `void doIt();`
    // and `Promise<record<K,V>> list();`. Only the FIRST match is taken so parameter lists cannot
    // leak names.
    const method = statement.match(/[\w>\]?)]\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (method && !WEBIDL_KEYWORDS.has(method[1].toLowerCase())) {
      names.add(method[1]);
      continue;
    }
    // DICTIONARY/INTERFACE MEMBERS: `Type name` / `Type name = default`. The type is a sequence
    // of space-separated tokens, each either a plain token or a parenthesised union such as
    // `(Foo or Bar)` - so a union typed member declared after keywords (`readonly attribute
    // (Foo or Bar) baz;`) is seen. The default group must not cross a paren: a method's
    // `optional unsigned long? length = null` is a PARAMETER, not a member.
    const member = statement.match(
      /^(?:(?:\([^)]*\)|[\w<>?\[\],]+)\s+)+?(\w+)\s*(?:=\s*[^;()]+)?$/,
    );
    if (member) names.add(member[1]);
  }
  return names;
}

export function declaredSurfaceMembers(html) {
  const region = syntaxRegionOf(renderedMarkup(html));
  if (!region) return [];
  const names = new Set();
  for (const idl of preBlocksIn(region)) {
    if (!IDL_BLOCK_GATE.test(idl)) continue;
    for (const name of memberNamesFromIdl(idl)) names.add(name);
  }
  // `stringifier` is a keyword AND a construct this parser now reports, so the filter must not
  // discard it: SURFACE_CONSTRUCTS is the explicit exception (gendn-5t3).
  return [...names]
    .filter((n) => !WEBIDL_KEYWORDS.has(n.toLowerCase()) || SURFACE_CONSTRUCTS.has(n.toLowerCase()))
    .sort();
}

// Blocks the detector CANNOT READ: IDL-shaped, declaring something member-shaped, yet yielding no
// member. Skipping those silently would report an EMPTY surface, and an empty surface passes the
// collapsed-contract check for the wrong reason - so they are reported instead. The brace
// requirement keeps JS/HTML scaffolding out: a code sample that merely CALLS something
// (`document.querySelector("video")`) is not a declaration, and WebIDL members always live inside a
// `{ }` body. Returns a short excerpt for the message.
export function unreadableSyntaxBlocks(html) {
  const region = syntaxRegionOf(renderedMarkup(html));
  if (!region) return [];
  const out = [];
  for (const idl of preBlocksIn(region)) {
    if (!IDL_BLOCK_GATE.test(idl)) continue;
    if (!idl.includes("{")) continue;
    if (!IDL_MEMBER_HINT.test(idl)) continue;
    if (memberNamesFromIdl(idl).size > 0) continue;
    out.push(idl.replace(/\s+/g, " ").trim().slice(0, 120));
  }
  return out;
}

function nameTokens(value) {
  return String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function validateDeclaredSurface(contract, html) {
  const errors = [];
  const id = contract?.id ?? "(unknown)";
  // LOUD, not silent: an IDL-looking block the detector cannot read is a hole in the check itself.
  for (const excerpt of unreadableSyntaxBlocks(html)) {
    errors.push(
      `${id}: the syntax block looks like WebIDL but NO member could be extracted from it - the ` +
        `detector cannot verify this page's surface, so an empty surface must not be read as a pass. ` +
        `Block starts: ${excerpt}`,
    );
  }
  const members = declaredSurfaceMembers(html);
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
  if (members.length === 0) return errors;
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
