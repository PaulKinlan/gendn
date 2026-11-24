#!/usr/bin/env node
// scripts/doc-tests.mjs — Tier 1 offline snippet syntax verifier, reference-contract symbol
// coverage check, and opt-in headless-Chrome runtime probe runner for gendn docs.
//
// Modes:
//   node scripts/doc-tests.mjs --all                   # check all published pages (default)
//   node scripts/doc-tests.mjs --page v158/my-feature  # check a single published page tree
//   node scripts/doc-tests.mjs --all --strict          # fail on any JS/CSS syntax error
//   node scripts/doc-tests.mjs --all --json            # machine-readable JSON report
//   node scripts/doc-tests.mjs --all --runtime         # opt-in Chrome CDP probe execution
//
// Pure functions are exported for deterministic browser-free unit tests in
// scripts/doc-tests.test.mjs.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import * as sys from "./lib/sys.mjs";

const NAMED_ENTITIES = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["rsquo", "'"],
  ["lsquo", "'"],
  ["rdquo", '"'],
  ["ldquo", '"'],
  ["mdash", "—"],
  ["ndash", "–"],
  ["hellip", "…"],
  ["middot", "·"],
  ["times", "×"],
  ["minus", "−"],
  ["rarr", "→"],
  ["larr", "←"],
  ["infin", "∞"],
  ["sect", "§"],
]);

const EXPLICIT_KINDS = new Set([
  "js",
  "js-module",
  "css",
  "html",
  "idl",
  "http",
  "shell",
  "json",
  "skip",
  "runtime",
]);

/** Decode common HTML entities and numeric character references (decoding &amp; last). */
export function decodeHtmlEntities(raw) {
  return String(raw)
    .replace(/&([a-zA-Z]+);/g, (match, name) => {
      if (name === "amp") return match;
      return NAMED_ENTITIES.has(name) ? NAMED_ENTITIES.get(name) : match;
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const cp = Number(dec);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    })
    .replace(/&amp;/g, "&");
}

function readAttr(rawAttrs, name) {
  if (!rawAttrs) return null;
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = rawAttrs.match(re);
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/**
 * Extract every `<pre ...><code ...>...</code></pre>` block from HTML with decoded text,
 * attribute metadata (`data-doc-test`, `class`), and 1-based line number.
 */
export function extractCodeBlocks(html) {
  const blocks = [];
  const source = String(html);
  const re = /<pre(\b[^>]*)>\s*<code(\b[^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi;
  let index = 0;
  for (const match of source.matchAll(re)) {
    const preAttrs = match[1] ?? "";
    const codeAttrs = match[2] ?? "";
    const inner = match[3] ?? "";
    const line = source.slice(0, match.index).split("\n").length;
    const docTest = readAttr(codeAttrs, "data-doc-test") ?? readAttr(preAttrs, "data-doc-test");
    const className = readAttr(codeAttrs, "class") ?? readAttr(preAttrs, "class");
    // Strip inline formatting tags (e.g. syntax-highlight <span>) before decoding entities.
    const stripped = inner.replace(/<[^>]+>/g, "");
    const code = decodeHtmlEntities(stripped);
    blocks.push({
      index: index++,
      line,
      docTest,
      className,
      attrs: { docTest, className, preAttrs: preAttrs.trim(), codeAttrs: codeAttrs.trim() },
      code,
    });
  }
  return blocks;
}

function parseExplicitKind(attr) {
  if (!attr) return null;
  if (typeof attr === "string") {
    const trimmed = attr.trim().toLowerCase();
    if (EXPLICIT_KINDS.has(trimmed)) return trimmed;
    const fromAttr = readAttr(attr, "data-doc-test")?.toLowerCase();
    if (fromAttr && EXPLICIT_KINDS.has(fromAttr)) return fromAttr;
    const cls = readAttr(attr, "class")?.toLowerCase();
    return kindFromClass(cls);
  }
  if (typeof attr === "object") {
    const dt = typeof attr.docTest === "string" ? attr.docTest.trim().toLowerCase() : null;
    if (dt && EXPLICIT_KINDS.has(dt)) return dt;
    const dt2 = typeof attr["data-doc-test"] === "string"
      ? attr["data-doc-test"].trim().toLowerCase()
      : null;
    if (dt2 && EXPLICIT_KINDS.has(dt2)) return dt2;
    const cls = typeof attr.className === "string"
      ? attr.className.toLowerCase()
      : typeof attr.class === "string"
      ? attr.class.toLowerCase()
      : null;
    return kindFromClass(cls);
  }
  return null;
}

function kindFromClass(className) {
  if (!className) return null;
  const m = className.match(/\b(?:language|lang)-([a-z0-9_-]+)\b/i);
  if (!m) return null;
  const lang = m[1].toLowerCase();
  if (lang === "js" || lang === "javascript") return "js";
  if (lang === "mjs" || lang === "esm" || lang === "js-module") return "js-module";
  if (lang === "css") return "css";
  if (lang === "html" || lang === "xml" || lang === "svg") return "html";
  if (lang === "idl" || lang === "webidl") return "idl";
  if (lang === "http") return "http";
  if (lang === "sh" || lang === "bash" || lang === "shell" || lang === "zsh") return "shell";
  if (lang === "json") return "json";
  return null;
}

/** True when code contains bare placeholder ellipses (`...` / `…`) outside comments or strings. */
function hasPseudocodePlaceholder(code) {
  // Strip single-line and block comments so `// ...` or `/* ... */` does not trigger skip.
  const noComments = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:\\])\/\/.*$/gm, "$1");
  // Strip quoted strings so `"..."` in strings does not trigger skip.
  const noStrings = noComments
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  if (/…/.test(noStrings)) return true;
  // Bare `...` on a line by itself, or `...` NOT followed by an identifier/expression start
  // (so valid JS spread/rest like `...args` or `...obj` is NOT flagged).
  if (/^\s*\.\.\.\s*[;,]?\s*$/m.test(noStrings)) return true;
  if (/\.\.\.(?=\s*(?:[;,)}\]]|$))/m.test(noStrings)) return true;
  return false;
}

function stripLeadingComments(code) {
  return code
    .replace(/^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*|\s*#[^\n]*\n))+/, "")
    .trim();
}

function looksLikeWebIdl(code) {
  if (
    /^\s*(?:partial\s+)?(?:interface(?:\s+mixin)?|dictionary|enum|callback\s+interface|namespace|typedef)\s+[A-Z]\w*/m
      .test(code)
  ) {
    return true;
  }
  if (
    /^\s*\[(?:Exposed|SecureContext|SameObject|CEReactions|Reflect|RuntimeEnabled|LegacyWindowAlias|PutForwards|Global|Transferable|Serializable|CrossOriginIsolated)\b/m
      .test(code)
  ) {
    return true;
  }
  if (
    /^\s*(?:readonly\s+)?attribute\s+(?:unrestricted\s+|unsigned\s+)?(?:DOMString|USVString|ByteString|boolean|double|float|long(?:\s+long)?|short|octet|byte|any|object|sequence<|FrozenArray<|[A-Z]\w*[?]?)\s+\w+\s*;/m
      .test(code)
  ) {
    return true;
  }
  if (
    /^\s*constructor\s*\(\s*(?:optional\s+)?(?:DOMString|USVString|ByteString|sequence<|record<|unsigned\s+|long|double|boolean|any|object|[A-Z]\w+\s+\w)/m
      .test(code)
  ) {
    return true;
  }
  if (
    /^\s*(?:Promise<[^>]+>|undefined|void|boolean|DOMString|USVString|unsigned\s+long|ReadableStream|WritableStream|[A-Z]\w+(?:<[^>]+>)?)\s+[a-z]\w*\s*\([^;]*\)\s*;/m
      .test(code)
  ) {
    return true;
  }
  if (/^\s*[A-Z]\w+\s+includes\s+[A-Z]\w+\s*;/m.test(code)) return true;
  // Single-line type signature notation: `navigator.storage.estimate(): Promise<StorageEstimate>`
  if (/^\s*[a-zA-Z0-9_.]+\([^)]*\)\s*:\s*(?:Promise<|[A-Z]\w+)/m.test(code)) return true;
  return false;
}

function looksLikeWgslOrWasmOrBinaryGrammar(code) {
  // WGSL shader language (`requires ...;`, `var<storage>`, `@group(0)`, `@compute`, `struct Foo { ... }`, `fn foo()`)
  if (/^\s*(?:requires|enable)\s+[a-z0-9_]+\s*;/m.test(code)) return true;
  if (/\bvar<(?:storage|uniform|workgroup|private|function)\b/.test(code)) return true;
  if (/^\s*@(?:compute|vertex|fragment|group|binding|workgroup_size)\b/m.test(code)) return true;
  if (
    /^\s*struct\s+[A-Z]\w*\s*\{[\s\S]*:\s*(?:u32|i32|f32|f16|bool|vec[234]|mat[234]x[234]|array<)/m
      .test(code)
  ) {
    return true;
  }
  // WebAssembly Text Format (WAT)
  if (/^\s*\((?:module|import|export|func|type|memory|table)\b/m.test(code)) return true;
  // ISO BMFF / C-like binary box grammar (`unsigned int (8) ...`)
  if (/\bunsigned\s+int\s*\(\d+\)/.test(code)) return true;
  return false;
}

function looksLikeHtml(code) {
  const body = stripLeadingComments(code);
  if (/^<!doctype\b|^<!--/i.test(body)) return true;
  // Distinguish real HTML tags from CSS value-definition grammar like `<line-width> = ...`
  if (/^<[a-z][a-z0-9-]*>\s*=/i.test(body)) return false;
  if (/^<[a-z][a-z0-9-]*(?:\s[^>]*|\/)?>/i.test(body)) return true;
  // Mixed syntax overview containing standalone HTML element lines (not inside template literals)
  if (
    !code.includes("`") &&
    /^\s*<(?:html|head|body|meta|link|script|style|div|form|input|button|a|img|video|audio|svg|canvas|iframe|install|select|dialog|template|details|section|table|object|embed|textPath)\b[^>]*>/im
      .test(code)
  ) {
    return true;
  }
  return false;
}

function looksLikeHttp(code) {
  const body = stripLeadingComments(code);
  if (/^HTTP\/\d(?:\.\d)?\s+\d{3}\b/.test(body)) return true;
  if (/^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\/\d/.test(body)) return true;
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return false;
  // Every non-empty line looks like an HTTP header (Pascal-Kebab: value), without JS/CSS braces
  const headerLineRe =
    /^(?:[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|Accept|Host|Origin|Referer|Vary|Link|Cookie|Allow|Date|ETag|Upgrade|Connection|Authorization|Location):\s+/;
  if (headerLineRe.test(lines[0]) && !/[{}]/.test(lines[0])) {
    const headerLines = lines.filter((l) => headerLineRe.test(l) || /^\s/.test(l));
    if (headerLines.length >= 1 && !/\b(?:const|let|var|function|await)\s+/.test(body)) {
      return true;
    }
  }
  return false;
}

function looksLikeShell(code) {
  const trimmed = code.trim();
  if (/^\$\s+\S/.test(trimmed)) return true;
  if (
    /^(?:google-chrome|chromium|chrome|npm|npx|deno|node|curl|git|python3?)\s+/m.test(trimmed) &&
    !/\b(?:const|let|var|function|await|return)\s+/.test(trimmed)
  ) {
    return true;
  }
  if (/^--[a-z0-9-]+(?:=\S+)?(?:\s+--[a-z0-9-]+(?:=\S+)?)*$/i.test(trimmed)) return true;
  if (/^chrome:\/\/[a-z0-9#/_-]+$/i.test(trimmed)) return true;
  return false;
}

function looksLikeJson(code) {
  const trimmed = stripLeadingComments(code);
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function looksLikeCssGrammar(code) {
  const body = stripLeadingComments(code);
  // Formal CSS value definition syntax (no rule blocks, uses `|` / `<type>` / `=`)
  if (/^<[a-z0-9-]+>\s*=/i.test(body)) return true;
  if (/^[a-z-]+\(\)\s*=/i.test(body)) return true;
  if (!body.includes("{") && /^[a-z-]+\s*:\s*[^;\n]*(?:\||<[a-z-]+>)/im.test(body)) return true;
  // Single standalone CSS color/math/function value expression without `;` or `{}`
  if (
    !body.includes("{") && !body.includes(";") &&
    /^(?:oklch|oklab|lch|lab|color|color-mix|contrast-color|rgb|rgba|hsl|hsla|calc|clamp|min|max|anchor|env)\s*\([\s\S]*\)$/i
      .test(body)
  ) {
    return true;
  }
  return false;
}

function looksLikeCss(code) {
  const body = stripLeadingComments(code);
  if (!body) return false;
  // Note: require whitespace after JS declaration keywords so CSS `var(--x)` is NOT mistaken for JS `var`.
  const hasJsDecls =
    /\b(?:const|let|var|function|async|await|import|export)\s+[A-Za-z_${[(]/.test(body) ||
    /\bnew\s+[A-Z]/.test(body) ||
    /(?:=>|window\.|document\.|navigator\.|console\.)/.test(body);
  if (hasJsDecls) return false;
  // CSS at-rules
  if (
    /^@(?:supports|media|layer|container|keyframes|scope|property|page|font-face|import|starting-style|position-try|view-transition|custom-media|function|counter-style|namespace)\b/m
      .test(body)
  ) {
    return true;
  }
  // CSS selector + rule block with property declarations
  if (body.includes("{") && body.includes("}")) {
    const hasCssSelector =
      /^\s*(?:[.#:\[*][^{\n]*|::?[a-z-][^{\n]*|[a-z][a-z0-9-]*(?:[^{\n]*)?)\s*\{/im.test(body);
    const hasCssDecl =
      /^\s*(?:--[a-z0-9-]+|[a-z]+(?:-[a-z]+)+|color|display|position|width|height|margin|padding|border|background|font|content|opacity|overflow|transform|transition|animation|cursor|gap|grid|flex|inset|top|left|right|bottom|z-index|clip|filter|mask|fill|stroke|outline|visibility)\s*:/im
        .test(body);
    if (hasCssSelector && hasCssDecl) return true;
  }
  return false;
}

function looksLikeMixedOrPseudocode(code) {
  const body = stripLeadingComments(code);
  // Mixed CSS + JS overview block (starts with a CSS rule like `::highlight(*) { ... }`)
  if (/^(?:[.#:]|::[a-z-]+)[^{\n]*\{[^}]*\}/m.test(body)) return true;
  // Mixed JSON + JS overview block (starts with a standalone JSON object followed by other code)
  if (/^\{\s*\n\s*"[^"]+"\s*:/.test(body)) return true;
  // Python-like indented pseudocode (`name(arg):`)
  if (/^[a-zA-Z_][a-zA-Z0-9_]*\([^)]*\):\s*$/m.test(body)) return true;
  // Slash-separated call-summary syntax (`foo(); / bar();`)
  if (/;\s+\/\s+[a-zA-Z_$]/.test(body)) return true;
  return false;
}

function looksLikeEsModule(code) {
  const body = stripLeadingComments(code);
  if (
    /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?["'][^"']+["']/m.test(body) ||
    /^\s*export\s+(?:default\s+|const\s+|let\s+|var\s+|function\s+|async\s+function\s+|class\s+|\{|\*)/m
      .test(body)
  ) {
    return true;
  }
  return false;
}

function looksLikeJs(code) {
  const body = stripLeadingComments(code);
  if (!body) return false;
  // Box-drawing diagrams / prose arrows / flowcharts
  if (/[┌┐└┘├┤┬┴┼─│═║╔╗╚╝▼▲▶◀]/.test(body)) return false;
  // CDDL / ABNF / grammar notation (e.g. `foo.Bar = ( ... )` or `name = 1*DIGIT`)
  if (/^\s*[a-zA-Z0-9_.-]+\s*=\s*\(\s*$/m.test(body)) return false;
  // Clear JavaScript indicators
  if (
    /\b(?:const|let|var|function|async|await|class|return|throw|try|catch|finally|typeof|instanceof)\b/
      .test(body) ||
    /=>/.test(body) ||
    /\b(?:window|document|navigator|console|self|globalThis|performance|CSS|JSON|Promise|Array|Object|Reflect|Intl|Temporal|URL|Response|Request|Headers|AbortController|Worker|ServiceWorker|WebTransport|OfflineAudioContext|AudioContext)\./
      .test(body) ||
    /\bnew\s+[A-Z][A-Za-z0-9_]*\s*\(/.test(body) ||
    /\baddEventListener\s*\(/.test(body)
  ) {
    return true;
  }
  return false;
}

/**
 * Classify a code snippet by explicit `data-doc-test` / `class` attribute, or conservative
 * offline heuristics so prose/IDL/HTML/HTTP/pseudocode are not misclassified as runnable JS.
 */
export function classifySnippet(code, attr = null) {
  const explicit = parseExplicitKind(attr);
  if (explicit) return explicit;

  const text = String(code ?? "").trim();
  if (!text) return "skip";

  if (looksLikeWebIdl(text)) return "idl";
  if (looksLikeWgslOrWasmOrBinaryGrammar(text)) return "skip";
  if (looksLikeHtml(text)) return "html";
  if (looksLikeHttp(text)) return "http";
  if (looksLikeShell(text)) return "shell";
  if (looksLikeJson(text)) return "json";
  if (looksLikeCssGrammar(text)) return "skip";
  if (looksLikeCss(text)) return "css";
  if (looksLikeMixedOrPseudocode(text)) return "skip";

  // Skip partial pseudocode with bare `...` / `…` placeholders unless explicitly annotated.
  if (hasPseudocodePlaceholder(text)) return "skip";

  if (looksLikeEsModule(text)) return "js-module";
  if (looksLikeJs(text)) return "js";
  return "skip";
}

/**
 * Rewrite static ES module import/export declarations into syntax-preserving classic JS statements
 * so `new vm.Script()` can check syntax without executing code or requiring `--experimental-vm-modules`.
 */
function stripModuleSyntaxForCheck(code) {
  return code
    // Side-effect import: `import "mod";`
    .replace(/^\s*import\s+["'][^"']+["']\s*;?/gm, ";")
    // Named/default/namespace imports (single or multi-line)
    .replace(
      /^\s*import\s+(?:type\s+)?[\s\S]*?\s+from\s+["'][^"']+["']\s*(?:with\s*\{[^}]*\}\s*)?;?/gm,
      ";",
    )
    // Re-exports: `export * from "mod";` / `export { a } from "mod";`
    .replace(/^\s*export\s+\*(?:\s+as\s+\w+)?\s+from\s+["'][^"']+["']\s*;?/gm, ";")
    .replace(/^\s*export\s+\{[^}]*\}\s*(?:from\s+["'][^"']+["'])?\s*;?/gm, ";")
    // `export default function/class` -> keep declaration
    .replace(/^\s*export\s+default\s+(?=(?:async\s+)?function\b|class\b)/gm, "")
    // `export default <expr>` -> `void (<expr>)`
    .replace(/^\s*export\s+default\s+/gm, "void ")
    // `export const/let/var/function/async function/class`
    .replace(/^\s*export\s+(?=(?:const|let|var|async\s+function|function|class)\b)/gm, "");
}

/**
 * Syntax-validate a JavaScript snippet with `new vm.Script()` (parse-only, never executes).
 * Supports top-level `await` (via an `async () => { ... }` wrapper) and ES modules (`isModule: true`).
 */
export function validateJsSnippet(code, { isModule = false } = {}) {
  const source = String(code ?? "");
  if (!source.trim()) return { ok: true };

  if (isModule) {
    const transformed = stripModuleSyntaxForCheck(source);
    try {
      new vm.Script(`async () => {\n${transformed}\n}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  try {
    new vm.Script(source);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Retry top-level `await` inside an async arrow wrapper (parse-only, never invoked).
    if (/\bawait\b/.test(source)) {
      try {
        new vm.Script(`async () => {\n${source}\n}`);
        return { ok: true };
      } catch (asyncErr) {
        return {
          ok: false,
          error: asyncErr instanceof Error ? asyncErr.message : String(asyncErr),
        };
      }
    }
    return { ok: false, error: message };
  }
}

/**
 * Offline structural CSS validator checking balanced `{}`, `()`, `[]`, plus unclosed strings
 * and unclosed `/* ... *\/` block comments.
 */
export function validateCssSnippet(code) {
  const source = String(code ?? "");
  const stack = [];
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const closers = new Set(["}", ")", "]"]);
  let i = 0;
  let line = 1;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "\n") {
      line++;
      i++;
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      const startLine = line;
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\n") line++;
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        return { ok: false, error: `Unclosed CSS comment starting at line ${startLine}` };
      }
      continue;
    }

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") {
          if (source[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          closed = true;
          break;
        }
        if (source[i] === "\n") {
          return {
            ok: false,
            error: `Unclosed CSS string (${quote}) on line ${startLine}`,
          };
        }
        i++;
      }
      if (!closed) {
        return { ok: false, error: `Unclosed CSS string (${quote}) starting at line ${startLine}` };
      }
      continue;
    }

    // Escaped character
    if (ch === "\\") {
      if (next === "\n") line++;
      i += 2;
      continue;
    }

    if (pairs[ch]) {
      stack.push({ open: ch, expected: pairs[ch], line });
    } else if (closers.has(ch)) {
      const top = stack.pop();
      if (!top) {
        return { ok: false, error: `Unexpected closing '${ch}' at line ${line}` };
      }
      if (top.expected !== ch) {
        return {
          ok: false,
          error:
            `Mismatched '${ch}' at line ${line} (expected '${top.expected}' for '${top.open}' opened at line ${top.line})`,
        };
      }
    }
    i++;
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    return {
      ok: false,
      error: `Unclosed '${unclosed.open}' opened at line ${unclosed.line}`,
    };
  }
  return { ok: true };
}

function visibleTextFromHtml(html) {
  const stripped = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(stripped).toLowerCase();
}

/**
 * Verify that every declared `surfaceMarkers` token in `contractJson.inventory` appears in the
 * page's visible text/code (case-insensitive). Accepts a single HTML string or an array of HTML
 * strings (e.g. overview + child routes of a published page tree).
 */
export function checkContractCoverage(html, contractJson) {
  if (!contractJson || !Array.isArray(contractJson.inventory)) {
    return { ok: true, checked: 0, missing: [] };
  }
  const htmlList = Array.isArray(html) ? html : [html];
  const haystack = htmlList.map((h) => visibleTextFromHtml(h)).join("\n");
  let checked = 0;
  const missing = [];
  for (const item of contractJson.inventory) {
    if (!Array.isArray(item.surfaceMarkers) || item.surfaceMarkers.length === 0) continue;
    for (const marker of item.surfaceMarkers) {
      checked++;
      const needle = String(marker).toLowerCase();
      if (!haystack.includes(needle)) {
        missing.push({
          inventoryId: item.id,
          name: item.name,
          marker,
        });
      }
    }
  }
  return { ok: missing.length === 0, checked, missing };
}

// ---------- corpus traversal ----------

function discoverPublishedPageIds(root) {
  const ids = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^v\d+$/.test(entry.name)) continue;
    const relDir = path.join(root, entry.name);
    for (const slug of fs.readdirSync(relDir, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const idx = path.join(relDir, slug.name, "index.html");
      if (fs.existsSync(idx)) ids.push(`${entry.name}/${slug.name}`);
    }
  }
  return ids.sort();
}

function collectHtmlFiles(pageDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".html")) files.push(full);
    }
  };
  walk(pageDir);
  return files.sort();
}

/** Run offline Tier 1 checks (snippets + contract surfaceMarkers) for one page tree. */
export function runDocTestsForPage(pageId, root = ".") {
  const pageDir = path.join(root, pageId);
  if (!fs.existsSync(path.join(pageDir, "index.html"))) {
    throw new Error(`Published page not found: ${pageId}`);
  }
  const htmlFiles = collectHtmlFiles(pageDir);
  const htmlContents = [];
  const snippetResults = [];
  const runtimeProbes = [];

  for (const file of htmlFiles) {
    const relFile = path.relative(root, file).replace(/\\/g, "/");
    const html = fs.readFileSync(file, "utf8");
    htmlContents.push(html);
    const blocks = extractCodeBlocks(html);
    for (const block of blocks) {
      const explicit = Boolean(parseExplicitKind(block.attrs));
      const kind = classifySnippet(block.code, block.attrs);
      let status = "skipped";
      let error = null;

      if (kind === "js" || kind === "js-module" || kind === "runtime") {
        const res = validateJsSnippet(block.code, { isModule: kind === "js-module" });
        status = res.ok ? "pass" : "fail";
        error = res.error ?? null;
      } else if (kind === "css") {
        const res = validateCssSnippet(block.code);
        status = res.ok ? "pass" : "fail";
        error = res.error ?? null;
      }

      if (explicit && (kind === "runtime" || kind === "css")) {
        const route = "/" + relFile.replace(/index\.html$/, "");
        runtimeProbes.push({
          file: relFile,
          route,
          line: block.line,
          kind,
          code: block.code,
        });
      }

      snippetResults.push({
        file: relFile,
        line: block.line,
        index: block.index,
        kind,
        explicit,
        status,
        ...(error ? { error } : {}),
      });
    }
  }

  let contract = { ok: true, checked: 0, missing: [], present: false };
  const contractPath = path.join(pageDir, "reference-contract.json");
  if (fs.existsSync(contractPath)) {
    const contractJson = JSON.parse(fs.readFileSync(contractPath, "utf8"));
    const cov = checkContractCoverage(htmlContents, contractJson);
    contract = { ...cov, present: true };
  }

  return {
    id: pageId,
    filesScanned: htmlFiles.length,
    snippets: snippetResults,
    contract,
    runtimeProbes,
  };
}

/** Opt-in headless Chrome CDP execution for `<code data-doc-test="runtime|css">` blocks. */
async function runRuntimeProbes(probes, root) {
  if (probes.length === 0) return [];
  const { launch } = await import("./lib/cdp.mjs");
  const { spawnServer } = await import("./lib/reference-browser.mjs");
  const server = await spawnServer({ cwd: root });
  let browser = null;
  const results = [];
  try {
    browser = await launch({ port: 0 });
    const page = await browser.newPage({ width: 1280, height: 800, mobile: false });
    const byRoute = new Map();
    for (const probe of probes) {
      if (!byRoute.has(probe.route)) byRoute.set(probe.route, []);
      byRoute.get(probe.route).push(probe);
    }
    for (const [route, routeProbes] of byRoute) {
      await page.goto(`${server.base}${route}`);
      for (const probe of routeProbes) {
        if (probe.kind === "css") {
          const expr = `(() => { const s = new CSSStyleSheet(); s.replaceSync(${
            JSON.stringify(probe.code)
          }); return s.cssRules.length; })()`;
          const val = await page.evaluate(expr);
          const failed = typeof val === "string" && val.startsWith("__THREW__:");
          results.push({
            file: probe.file,
            line: probe.line,
            kind: "css",
            status: failed ? "fail" : "pass",
            ...(failed ? { error: val.slice("__THREW__:".length) } : { rules: val }),
          });
        } else {
          const expr = `(async () => {\n${probe.code}\nreturn "ok";\n})()`;
          const val = await page.evaluate(expr);
          const failed = typeof val === "string" && val.startsWith("__THREW__:");
          const { consoleErrors } = page.diagnostics();
          const hasErr = failed || consoleErrors.length > 0;
          results.push({
            file: probe.file,
            line: probe.line,
            kind: "runtime",
            status: hasErr ? "fail" : "pass",
            ...(failed
              ? { error: val.slice("__THREW__:".length) }
              : consoleErrors.length > 0
              ? { error: `console error: ${consoleErrors.join("; ")}` }
              : {}),
          });
        }
      }
    }
    await page.close();
  } finally {
    if (browser) await browser.close();
    try {
      server.child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
  return results;
}

export async function runDocTests({ root = ".", pageIds = null, strict = false, runtime = false }) {
  const targets = pageIds && pageIds.length > 0 ? pageIds : discoverPublishedPageIds(root);
  const pages = targets.map((id) => runDocTestsForPage(id, root));

  const byKind = {};
  let totalSnippets = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let explicitFailed = 0;
  let contractPages = 0;
  let contractMarkersChecked = 0;
  let contractMissingCount = 0;
  const failures = [];
  const warnings = [];
  const allProbes = [];

  for (const page of pages) {
    if (page.contract.present) contractPages++;
    contractMarkersChecked += page.contract.checked;
    contractMissingCount += page.contract.missing.length;
    for (const m of page.contract.missing) {
      failures.push({
        type: "contract-marker",
        page: page.id,
        inventoryId: m.inventoryId,
        marker: m.marker,
        error: `Missing declared surfaceMarker "${m.marker}" for inventory item "${m.inventoryId}"`,
      });
    }
    for (const s of page.snippets) {
      totalSnippets++;
      byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
      if (s.status === "pass") passed++;
      else if (s.status === "fail") {
        failed++;
        const entry = {
          type: "snippet-syntax",
          page: page.id,
          file: s.file,
          line: s.line,
          kind: s.kind,
          explicit: s.explicit,
          error: s.error,
        };
        if (s.explicit || strict) {
          if (s.explicit) explicitFailed++;
          failures.push(entry);
        } else {
          warnings.push(entry);
        }
      } else {
        skipped++;
      }
    }
    allProbes.push(...page.runtimeProbes);
  }

  let runtimeResults = [];
  if (runtime) {
    runtimeResults = await runRuntimeProbes(allProbes, root);
    for (const r of runtimeResults) {
      if (r.status === "fail") {
        failures.push({
          type: "runtime-probe",
          file: r.file,
          line: r.line,
          kind: r.kind,
          error: r.error,
        });
      }
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    summary: {
      pagesScanned: pages.length,
      htmlFilesScanned: pages.reduce((n, p) => n + p.filesScanned, 0),
      totalSnippets,
      byKind,
      passed,
      failed,
      explicitFailed,
      skipped,
      contractPages,
      contractMarkersChecked,
      contractMissingCount,
      runtimeEnabled: runtime,
      runtimeProbesRun: runtimeResults.length,
    },
    failures,
    warnings,
    runtimeResults,
  };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = { pageIds: [], all: false, json: false, strict: false, runtime: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--runtime") opts.runtime = true;
    else if (arg === "--page" && argv[i + 1]) opts.pageIds.push(argv[++i]);
    else if (arg.startsWith("--page=")) opts.pageIds.push(arg.slice("--page=".length));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/doc-tests.mjs [--all | --page v<N>/<slug>] [--strict] [--json] [--runtime]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

if (sys.isMain(import.meta.url)) {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const opts = parseArgs(sys.args);
  const report = await runDocTests({
    root,
    pageIds: opts.pageIds.length > 0 ? opts.pageIds : null,
    strict: opts.strict,
    runtime: opts.runtime,
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const s = report.summary;
    const kinds = Object.entries(s.byKind)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(
      `doc-tests: ${s.pagesScanned} pages (${s.htmlFilesScanned} HTML files), ` +
        `${s.totalSnippets} code blocks [${kinds}]`,
    );
    console.log(
      `  snippets: ${s.passed} passed, ${s.failed} failed (${s.explicitFailed} explicit), ` +
        `${s.skipped} skipped`,
    );
    console.log(
      `  contracts: ${s.contractMarkersChecked} surfaceMarker(s) across ${s.contractPages} contract(s), ` +
        `${s.contractMissingCount} missing`,
    );
    if (s.runtimeEnabled) {
      console.log(`  runtime probes: ${s.runtimeProbesRun} executed in headless Chrome`);
    }
    for (const w of report.warnings) {
      console.log(`  WARN [${w.kind}] ${w.file}:${w.line} — ${w.error}`);
    }
    for (const f of report.failures) {
      const loc = f.file ? `${f.file}:${f.line}` : f.page;
      console.error(`  FAIL [${f.type}] ${loc} — ${f.error}`);
    }
  }

  process.exit(report.ok ? 0 : 1);
}
