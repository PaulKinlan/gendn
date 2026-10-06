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

async function fetchCss() {
  const res = await fetch(CSS_URL, { headers: { "user-agent": UA } });
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
  const check = Deno.args.includes("--check");
  const css = await fetchCss();
  const block = renderBlock(extractBlocks(css));
  const sheet = await Deno.readTextFile(SHEET);
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
    const kept = extractBlocks(css).length;
    console.log(`vendor-fonts: wrote ${kept} @font-face rules into public/styles.css`);
  }
}
