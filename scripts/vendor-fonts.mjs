// scripts/vendor-fonts.mjs — refresh the vendored @font-face block in public/styles.css.
//
// WHY THIS EXISTS (gendn-3fa): public/styles.css used to `@import` the Google Fonts css2 sheet.
// An @imported sheet is a DEPENDENCY of the importing one, so the browser could not discover
// fonts.googleapis.com until styles.css had been downloaded AND parsed — a second-origin DNS +
// TLS + round trip in front of paint on every page (~302 consumer sites: 297 static v*/index.html,
// 3 server templates, 2 generated rollups). Modern Web Guidance, performance guide:
//   "DON'T use `@import` in CSS: This creates sequential request chains that delay the CSS Object
//    Model (CSSOM) construction."
//
// THE FIX: the same @font-face rules are vendored INTO the shared sheet instead. One file changes,
// so every consumer (static and server-rendered alike) stops making a second-origin stylesheet
// request. The font FILES are still fetched from fonts.gstatic.com, but with font-display: swap
// they are not render-blocking, and the browser discovers them while parsing the same sheet.
//
// SUBSETTING: the css2 response carries 49 @font-face rules across cyrillic, cyrillic-ext, greek,
// vietnamese, math, symbols, latin and latin-ext (29 KB). Inlining all of them would more than
// triple a render-blocking 11.6 KB sheet. Modern Web Guidance (performance guide, Web Fonts
// Optimization) says "DO subset fonts: Trim font weights and glyph variations to include only the
// characters your application requires" — so this script keeps the DEFAULT_SUBSETS below (latin +
// latin-ext, covering English reference prose and accented names) and drops the rest. Every weight
// and style is kept; nothing about which faces the page uses changes for latin text.
//
// USAGE
//   deno task vendor-fonts            # fetch and rewrite the block in public/styles.css
//   deno task vendor-fonts --check    # report whether the vendored block is up to date
//
// The block is delimited by the BEGIN/END markers below; this script only ever rewrites inside
// them, so hand-written CSS around it is never touched.

// Bounded upstream fetch (gendn-n3e): this script's css2 fetch carries the SAME discipline as
// every other outbound fetch in the repo — the canonical fetchBounded primitive from
// lib/chromestatus.ts (AbortSignal.timeout + a streaming byte cap), instead of a bare fetch().
// A hung upstream, a mid-body stall or an oversized response THROWS out of fetchBounded, which
// the main catch below turns into a loud REFUSING exit(1) with the sheet untouched — a timeout
// can never install a partial or truncated font sheet.
import { fetchBounded, UPSTREAM_TIMEOUT_MS } from "../lib/chromestatus.ts";

const CSS_URL =
  "https://fonts.googleapis.com/css2?family=Joan&family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap";
const SHEET = new URL("../public/styles.css", import.meta.url).pathname;
const BEGIN = "/* --- BEGIN vendored @font-face";
const END = "/* --- END vendored @font-face --- */";
// A current Chrome UA makes the css2 endpoint return woff2 sources (it sniffs the client).
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DEFAULT_SUBSETS = ["latin", "latin-ext"];

export function extractBlocks(css, subsets = DEFAULT_SUBSETS) {
  // Each rule is preceded by a subset comment: /* latin */ then the @font-face block.
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
  const out = [];
  for (const m of css.matchAll(re)) {
    const subset = m[1];
    if (!subsets.includes(subset)) continue;
    const body = m[2]
      .split("\n")
      .map((line) => (line.trim() === "" ? "" : `  ${line.trim()}`))
      .join("\n");
    out.push({ subset, text: body });
  }
  return out;
}

/**
 * The identity of ONE vendored rule, along the axes the sheet keys on:
 * family + style + weight + subset. Two rules with the same identity are the same face; a response
 * that lacks an identity the sheet already has would DELETE it.
 *
 * The four axes are derived from the rule body plus its subset comment. A FIFTH axis was
 * considered and rejected: unicode-range is the property that distinguishes subsets in the first
 * place (that is what the subset comment names), so keying on it as well would double-count the
 * same distinction — and it would make a harmless upstream re-encoding of a range look like a
 * removal.
 */
export function ruleIdentities(blocks) {
  return blocks.map((b) => {
    const family = /font-family:\s*'([^']+)'/.exec(b.text)?.[1] ?? "unknown";
    const style = /font-style:\s*([a-z]+)/.exec(b.text)?.[1] ?? "normal";
    const weight = /font-weight:\s*(\d+)/.exec(b.text)?.[1] ?? "400";
    return `${family}|${style}|${weight}|${b.subset}`;
  });
}

/** The identities currently present in the sheet's vendored block. */
export function vendoredIdentities(sheet) {
  const begin = sheet.indexOf(BEGIN);
  const end = sheet.indexOf(END);
  if (begin === -1 || end === -1) return [];
  return ruleIdentities(extractBlocks(sheet.slice(begin, end)));
}

/** How many @font-face rules a body declares at all, regardless of subset. */
export function countFontFaces(css) {
  return (css.match(/@font-face\s*\{/g) ?? []).length;
}

/** Does this text contain at least one @font-face rule? */
export function hasFontFace(text) {
  return /@font-face\s*\{/.test(text);
}

// Bounds nothing; the vendored block's own rule count, used by the mirror guard below.
export function blockHasRules(sheet) {
  const begin = sheet.indexOf(BEGIN);
  const end = sheet.indexOf(END);
  if (begin === -1 || end === -1) return false;
  return hasFontFace(sheet.slice(begin, end));
}

export function renderBlock(blocks) {
  const grouped = new Map();
  for (const b of blocks) {
    const family = /font-family:\s*'([^']+)'/.exec(b.text)?.[1] ?? "unknown";
    if (!grouped.has(family)) grouped.set(family, []);
    grouped.get(family).push(b);
  }
  const lines = [
    `${BEGIN} — generated, do not edit by hand --- */`,
    `/* Source: ${CSS_URL}`,
    ` * Regenerate: deno task vendor-fonts`,
    ` * Subsets kept: ${
      DEFAULT_SUBSETS.join(", ")
    } (the full css2 response carries 49 rules across`,
    ` * cyrillic/cyrillic-ext/greek/vietnamese/math/symbols/latin/latin-ext = 29 KB; inlining all of`,
    ` * them would more than triple this render-blocking sheet). Every weight and style is kept.`,
    ` * Vendored so the sheet no longer fetches a second origin on the critical path (gendn-3fa).`,
    ` * Blank line + subset comment + @font-face per rule. */`,
  ];
  for (const [family, list] of grouped) {
    lines.push(``);
    lines.push(`/* ${family} */`);
    for (const b of list) {
      lines.push(`/* ${b.subset} */`);
      lines.push(b.text);
    }
  }
  lines.push(``);
  lines.push(END);
  return lines.join("\n");
}

// SIZE bound: the full css2 response is ~29 KB before subsetting; 1 MiB is >30x headroom and a
// hard ceiling on what one response can make this script allocate (readCapped refuses early on a
// lying or missing content-length, mid-stream).
const CSS_MAX_BYTES = 1024 * 1024;

async function fetchCss(url = CSS_URL, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const { res, text } = await fetchBounded(url, {
    headers: { "user-agent": UA },
    timeoutMs,
    maxBytes: CSS_MAX_BYTES,
  });
  if (!res.ok) throw new Error(`css2 fetch failed: ${res.status}`);
  return text;
}

function replaceBlock(sheet, block) {
  const begin = sheet.indexOf(BEGIN);
  const end = sheet.indexOf(END);
  if (begin === -1 || end === -1) {
    throw new Error(
      `markers not found in public/styles.css — expected "${BEGIN}" and "${END}"`,
    );
  }
  return sheet.slice(0, begin) + block + sheet.slice(end + END.length);
}

if (import.meta.main) {
  const argv = Deno.args;
  const check = argv.includes("--check");
  // --css-url is a test seam: it lets the fixture point the extractor at a local server that
  // serves a degenerate 200 (empty body, an HTML error page, or rules for subsets we do not
  // keep) instead of reaching Google. It changes no production behaviour.
  const urlFlag = argv.indexOf("--css-url");
  const cssUrl = urlFlag === -1 ? CSS_URL : argv[urlFlag + 1];
  // The override for a genuine upstream removal is deliberate and must be justified: a bare flag is
  // easy to paste into a script and forget, so the reason is required and is echoed into the output.
  const allowReduction = argv.includes("--allow-rule-removal");
  const reasonFlag = argv.indexOf("--reason");
  const reason = reasonFlag === -1 ? "" : (argv[reasonFlag + 1] ?? "");
  if (allowReduction && reason.trim().length < 10) {
    throw new Error(
      '--allow-rule-removal requires --reason "<why>" (at least 10 characters), so an ' +
        "intentional reduction is recorded rather than looking like an accident",
    );
  }
  if (!allowReduction && reasonFlag !== -1) {
    throw new Error("--reason is only meaningful with --allow-rule-removal");
  }

  // --timeout-ms is a TEST SEAM for the bounded-fetch fixture (gendn-n3e), and it can only ever
  // TIGHTEN the bound: a seam that could disable or loosen the property under test is how
  // "bounded" becomes optional. Valid range is [1, UPSTREAM_TIMEOUT_MS]; the default (no flag)
  // is the repo-wide UPSTREAM_TIMEOUT_MS itself.
  const timeoutFlag = argv.indexOf("--timeout-ms");
  let timeoutMs = UPSTREAM_TIMEOUT_MS;
  if (timeoutFlag !== -1) {
    const raw = Number(argv[timeoutFlag + 1]);
    if (!Number.isInteger(raw) || raw < 1 || raw > UPSTREAM_TIMEOUT_MS) {
      throw new Error(
        `--timeout-ms must be an integer in [1, ${UPSTREAM_TIMEOUT_MS}] — the seam may tighten ` +
          "the bound for testing but can never disable or loosen it",
      );
    }
    timeoutMs = raw;
  }

  try {
    const css = await fetchCss(cssUrl, timeoutMs);
    const blocks = extractBlocks(css);

    // FAIL CLOSED ON AN EMPTY EXTRACTION (gendn-dmz), before anything is rendered, compared or
    // written. An HTTP 200 with an empty body, a status/error HTML page or a changed upstream
    // markup shape yields 0 kept rules; writing that would silently strip the webfonts from all
    // 302 consumers of the shared sheet, and comparing it would report a meaningless result.
    if (blocks.length === 0) {
      throw new Error(
        `no @font-face rules extracted for the kept subsets (${DEFAULT_SUBSETS.join(", ")}) — ` +
          `the response from ${cssUrl} was ${css.length} bytes with ${countFontFaces(css)} ` +
          `@font-face rule(s) in total. Refusing to write.`,
      );
    }

    const block = renderBlock(blocks);
    const sheet = await Deno.readTextFile(SHEET);

    // MIRROR GUARD (gendn-dmz): --check must never report "up to date" for a sheet whose own
    // vendored block has no rules. Without this, a rule-less sheet and a rule-less extraction
    // agree with each other and the check passes on exactly the state it exists to catch.
    if (check && !blockHasRules(sheet)) {
      throw new Error(
        "public/styles.css's vendored block contains no @font-face rules, so --check has nothing " +
          "to compare against and must not report it current. Restore the rules (deno task " +
          "vendor-fonts) and re-check.",
      );
    }

    // A WRITE MUST NOT REDUCE THE VENDORED RULE SET (gendn-cp7). The zero-rule guard above covers
    // total failure; a NON-EMPTY but INCOMPLETE 200 (one family, or a family missing a weight) still
    // passes it and would overwrite the sheet with that smaller set — silently dropping every other
    // face across all 302 consumers, after which --check against the same upstream reports "up to
    // date" and the corruption is self-consistent. Identity keys make "reduced" precise, and
    // ADDITIVE growth (every existing identity plus more) is still written, because otherwise
    // upstream additions could never land.
    const before = new Set(vendoredIdentities(sheet));
    const after = new Set(ruleIdentities(blocks));
    const removed = [...before].filter((identity) => !after.has(identity));
    const added = [...after].filter((identity) => !before.has(identity));

    if (removed.length > 0 && !allowReduction) {
      throw new Error(
        `the response would REMOVE ${removed.length} of the ${before.size} vendored rule(s) ` +
          `(adding ${added.length}): ${removed.slice(0, 6).join(", ")}` +
          `${removed.length > 6 ? `, +${removed.length - 6} more` : ""}. ` +
          "Refusing to write, because a partial upstream response looks exactly like this and would " +
          "silently drop faces site-wide. If the removal is genuine, say so deliberately with " +
          '`--allow-rule-removal --reason "<why>"`.',
      );
    }
    if (removed.length > 0) {
      // LOUD, not silent: the override states exactly what it is dropping.
      console.error(
        `vendor-fonts: OVERRIDE — dropping ${removed.length} vendored rule(s) on request ` +
          `(reason: ${reason}): ${removed.join(", ")}`,
      );
    }

    const updated = replaceBlock(sheet, block);
    const changed = updated !== sheet;
    if (check && removed.length > 0) {
      console.log(
        `vendor-fonts: OUT OF DATE — the response would REMOVE ${removed.length} rule(s) ` +
          `(${removed.slice(0, 4).join(", ")}${removed.length > 4 ? ", …" : ""}); writing needs ` +
          "--allow-rule-removal with a reason",
      );
      Deno.exit(1);
    }
    if (check) {
      console.log(
        changed
          ? "vendor-fonts: OUT OF DATE — run `deno task vendor-fonts`"
          : "vendor-fonts: up to date",
      );
      Deno.exit(changed ? 1 : 0);
    }
    if (!changed) {
      console.log("vendor-fonts: already up to date (no write)");
    } else {
      await Deno.writeTextFile(SHEET, updated);
      console.log(`vendor-fonts: wrote ${blocks.length} @font-face rules into public/styles.css`);
    }
  } catch (err) {
    // Every failure path above is a refusal, not a partial success: nothing is written.
    console.error(
      `vendor-fonts: REFUSING — ${err instanceof Error ? err.message : String(err)}`,
    );
    Deno.exit(1);
  }
}
