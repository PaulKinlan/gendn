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

async function fetchCss(url = CSS_URL) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`css2 fetch failed: ${res.status}`);
  return await res.text();
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

  try {
    const css = await fetchCss(cssUrl);
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

    const updated = replaceBlock(sheet, block);
    const changed = updated !== sheet;
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
