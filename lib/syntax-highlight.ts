// Subtle, zero-dependency syntax highlighter for gendn reference code blocks.
// Produces semantic <span class="hl-*"> tokens styled by light/dark CSS tokens in
// public/styles.css while preserving exact textContent byte-for-byte.
//
// Guidance consulted (modern-web-guidance@latest):
// - `highlight-text-ranges` & `accessibility`: syntax coloring is purely presentational;
//   keep base semantics as <pre><code> and maintain >= 4.5:1 contrast in light and dark themes.
// - `dark-mode`: pair semantic light/dark CSS custom properties via light-dark() with
//   @media (prefers-color-scheme: dark) fallback.

export type HighlightLang =
  | "js"
  | "idl"
  | "html"
  | "css"
  | "http"
  | "json"
  | "wgsl"
  | "shell"
  | "plain";

export type TokenKind = "cm" | "kw" | "str" | "num" | "ty" | "attr" | "pun";

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["rsquo", "\u2019"],
  ["lsquo", "\u2018"],
  ["rdquo", "\u201D"],
  ["ldquo", "\u201C"],
  ["mdash", "\u2014"],
  ["ndash", "\u2013"],
  ["hellip", "\u2026"],
  ["middot", "\u00B7"],
  ["times", "\u00D7"],
  ["minus", "\u2212"],
  ["rarr", "\u2192"],
  ["larr", "\u2190"],
  ["infin", "\u221E"],
  ["sect", "\u00A7"],
]);

/** Escape raw code text for safe embedding inside HTML element text nodes. */
export function escapeCodeText(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Decode HTML entities inside a <code> element's raw inner HTML. */
export function decodeCodeEntities(raw: string): string {
  return raw
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => {
      if (name === "amp") return match;
      return NAMED_ENTITIES.get(name) ?? match;
    })
    .replace(/&#(\d+);/g, (match, dec: string) => {
      const cp = Number(dec);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) => {
      const cp = parseInt(hex, 16);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    })
    .replace(/&amp;/g, "&");
}

/** Remove previously emitted <span class="hl-*"> wrappers so highlighting is strictly idempotent. */
export function stripHighlightSpans(innerHtml: string): string {
  return innerHtml.replace(
    /<span class="hl-(?:cm|kw|str|num|ty|attr|pun)">([\s\S]*?)<\/span>/g,
    "$1",
  );
}

function span(kind: TokenKind, text: string): string {
  if (!text) return "";
  return `<span class="hl-${kind}">${escapeCodeText(text)}</span>`;
}

function stripLeadingComments(code: string): string {
  return code
    .replace(/^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*|\s*#[^\n]*\n))+/, "")
    .trim();
}

function langFromExplicit(
  attrs?: { dataDocTest?: string | null; className?: string | null },
): HighlightLang | null {
  if (!attrs) return null;
  const cls = attrs.className ?? "";
  const classMatch = cls.match(/\b(?:language|lang)-([a-z0-9_-]+)\b/i);
  const raw = (classMatch?.[1] ?? attrs.dataDocTest ?? "").trim().toLowerCase();
  if (!raw || raw === "skip" || raw === "runtime") return null;
  if (
    raw === "js" || raw === "javascript" || raw === "js-module" || raw === "mjs" || raw === "ts"
  ) {
    return "js";
  }
  if (raw === "idl" || raw === "webidl") return "idl";
  if (raw === "html" || raw === "xml" || raw === "svg") return "html";
  if (raw === "css") return "css";
  if (raw === "http") return "http";
  if (raw === "json" || raw === "jsonc") return "json";
  if (raw === "wgsl") return "wgsl";
  if (raw === "shell" || raw === "sh" || raw === "bash" || raw === "zsh") return "shell";
  return null;
}

/** Classify a code block into a syntax-highlighting language. */
export function detectLanguage(
  code: string,
  attrs?: { dataDocTest?: string | null; className?: string | null },
): HighlightLang {
  const explicit = langFromExplicit(attrs);
  if (explicit) return explicit;

  const trimmed = code.trim();
  if (!trimmed) return "plain";

  // WGSL shader source
  if (
    /^\s*(?:requires|enable)\s+[a-z0-9_]+\s*;/m.test(trimmed) ||
    /\bvar<(?:storage|uniform|workgroup|private|function)\b/.test(trimmed) ||
    /^\s*@(?:compute|vertex|fragment|group|binding|workgroup_size)\b/m.test(trimmed) ||
    /^\s*fn\s+\w+\s*\([^)]*@(?:builtin|location)\b/m.test(trimmed)
  ) {
    return "wgsl";
  }

  // WebIDL declarations
  if (
    /^\s*(?:partial\s+)?(?:interface(?:\s+mixin)?|dictionary|enum|callback\s+interface|namespace|typedef)\s+[A-Z(]/m
      .test(trimmed) ||
    /^\s*\[(?:Exposed|SecureContext|SameObject|CEReactions|Reflect|RuntimeEnabled|LegacyWindowAlias|PutForwards|Global|Transferable|Serializable|CrossOriginIsolated)\b/m
      .test(trimmed) ||
    /^\s*(?:readonly\s+)?attribute\s+(?:unrestricted\s+|unsigned\s+)?(?:DOMString|USVString|ByteString|boolean|double|float|long(?:\s+long)?|short|octet|byte|any|object|sequence<|FrozenArray<|[A-Z]\w*[?]?)\s+\w+\s*;/m
      .test(trimmed) ||
    /^\s*constructor\s*\(\s*(?:optional\s+)?(?:DOMString|USVString|ByteString|sequence<|record<|unsigned\s+|long|double|boolean|any|object|[A-Z]\w+\s+\w)/m
      .test(trimmed) ||
    /^\s*[A-Z]\w+\s+includes\s+[A-Z]\w+\s*;/m.test(trimmed)
  ) {
    return "idl";
  }

  const body = stripLeadingComments(trimmed);

  // XML / HTML markup
  if (
    /^<!doctype\b|^<!--|^<\?xml\b/i.test(body) ||
    (!/^<[a-z][a-z0-9-]*>\s*=/i.test(body) && /^<[a-z][a-z0-9-]*(?:\s[^>]*|\/)?>/i.test(body))
  ) {
    return "html";
  }

  // Pure JSON object/array
  if (
    (body.startsWith("{") && body.endsWith("}")) || (body.startsWith("[") && body.endsWith("]"))
  ) {
    try {
      JSON.parse(body);
      return "json";
    } catch {
      // Not strict JSON — continue heuristics below.
    }
  }

  // Shell invocations / CLI flags
  if (
    /^\$\s+\S/.test(trimmed) ||
    (/^(?:google-chrome|chromium|chrome|npm|npx|deno|node|curl|git|openssl|python3?)\s+/m.test(
      body,
    ) && !/\b(?:const|let|var|function|await|return)\s+/.test(body)) ||
    /^--[a-z0-9-]+(?:=\S+)?(?:\s+--[a-z0-9-]+(?:=\S+)?)*$/i.test(trimmed)
  ) {
    return "shell";
  }

  // HTTP requests, responses, and standalone header listings
  if (
    /^HTTP\/\d(?:\.\d)?\s+\d{3}\b/.test(body) ||
    /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\/\d/.test(body)
  ) {
    return "http";
  }
  const httpHeaderRe =
    /^(?:[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|Accept|Host|Origin|Referer|Vary|Link|Cookie|Allow|Date|ETag|Upgrade|Connection|Authorization|Location):\s+/;
  const nonCommentLines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
  if (
    nonCommentLines.length > 0 &&
    httpHeaderRe.test(nonCommentLines[0]) &&
    !/[{}]/.test(nonCommentLines[0]) &&
    !/\b(?:const|let|var|function|await)\s+/.test(body)
  ) {
    return "http";
  }

  // CSS rules and formal CSS value-definition syntax
  const hasJsSignals =
    /\b(?:const|let|var|function|async|await|import|export|return|throw|try|catch)\s+[A-Za-z_${[(]/
      .test(body) ||
    /\bnew\s+[A-Z]/.test(body) ||
    /(?:=>|\bwindow\.|\bdocument\.|\bnavigator\.|\bconsole\.|\bself\.)/.test(body);

  if (!hasJsSignals) {
    if (
      /^@(?:supports|media|layer|container|keyframes|scope|property|page|font-face|import|starting-style|position-try|view-transition|custom-media|function|counter-style|namespace)\b/m
        .test(body) ||
      /^<[a-z0-9-]+>\s*=/i.test(body) ||
      /^[a-z-]+\(\)\s*=/i.test(body) ||
      (!body.includes("{") && /^[a-z-]+\s*:\s*[^;\n]*(?:\||<[a-z-]+>)/im.test(body))
    ) {
      return "css";
    }
    if (body.includes("{") && body.includes("}")) {
      const hasCssSelector =
        /^\s*(?:[.#:\[*][^{\n]*|::?[a-z-][^{\n]*|[a-z][a-z0-9-]*(?:[^{\n]*)?)\s*\{/im.test(body);
      const hasCssDecl =
        /^\s*(?:--[a-z0-9-]+|[a-z]+(?:-[a-z]+)+|color|display|position|width|height|margin|padding|border|background|font|content|opacity|overflow|transform|transition|animation|cursor|gap|grid|flex|inset|top|left|right|bottom|z-index|clip|filter|mask|fill|stroke|outline|visibility)\s*:/im
          .test(body);
      if (hasCssSelector && hasCssDecl) return "css";
    }
  }

  // Standalone HTML lines inside mixed syntax examples (when not JS template strings)
  if (
    !code.includes("`") &&
    !hasJsSignals &&
    /^\s*<(?:html|head|body|meta|link|script|style|div|form|input|button|a|img|video|audio|svg|canvas|iframe|select|dialog|template|details|section|table)\b[^>]*>/im
      .test(body)
  ) {
    return "html";
  }

  // JavaScript / TypeScript / Web API snippets
  if (
    hasJsSignals ||
    /^\s*type\s+[A-Z]\w*\s*=\s*\{/m.test(body) ||
    /\b(?:fetch|addEventListener|querySelector|requestAnimationFrame|setTimeout)\s*\(/.test(body) ||
    /^[a-zA-Z_$][\w$.]*\([^)]*\)\s*;?\s*$/m.test(body)
  ) {
    return "js";
  }

  return "plain";
}

// ----- Shared scanning primitives -----

function isIdentStart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

function isIdentPart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return isIdentStart(ch) || (c >= 48 && c <= 57);
}

function isDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function readQuotedString(code: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === "\n") return i; // terminate unterminated single-line string cleanly
    i++;
  }
  return i;
}

function readNumber(code: string, start: number): number {
  let i = start;
  if (code[i] === "0" && i + 1 < code.length && /[xXbBoO]/.test(code[i + 1])) {
    i += 2;
    while (i < code.length && /[0-9a-fA-F_]/.test(code[i])) i++;
    if (i < code.length && /[nufih]/.test(code[i])) i++;
    return i;
  }
  while (i < code.length && (isDigit(code[i]) || code[i] === "_")) i++;
  if (
    i + 1 < code.length &&
    code[i] === "." &&
    isDigit(code[i + 1])
  ) {
    i++;
    while (i < code.length && (isDigit(code[i]) || code[i] === "_")) i++;
  }
  if (i < code.length && (code[i] === "e" || code[i] === "E")) {
    let j = i + 1;
    if (j < code.length && (code[j] === "+" || code[j] === "-")) j++;
    if (j < code.length && isDigit(code[j])) {
      i = j;
      while (i < code.length && (isDigit(code[i]) || code[i] === "_")) i++;
    }
  }
  if (i < code.length && code[i] === "n") i++;
  return i;
}

const KNOWN_WEB_ACRONYMS = new Set([
  "URL",
  "JSON",
  "CSS",
  "DOM",
  "GPU",
  "SVG",
  "HTML",
  "RTC",
  "XR",
  "USB",
  "HID",
  "MIDI",
  "NFC",
  "ML",
]);

function isPascalType(word: string): boolean {
  if (KNOWN_WEB_ACRONYMS.has(word)) return true;
  if (word.length < 2) return false;
  const first = word.charCodeAt(0);
  if (first < 65 || first > 90) return false;
  if (word.includes("_")) return false;
  // Must contain at least one lowercase letter (so ALL_CAPS constants stay plain).
  return /[a-z]/.test(word);
}

// ----- JavaScript / TypeScript / mixed JS+HTTP -----

const JS_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "of",
  "readonly",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "type",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const JS_LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

const REGEX_PREV_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "in",
  "of",
  "typeof",
  "void",
  "delete",
  "new",
  "await",
  "yield",
  "else",
]);

function canStartRegex(prevKind: string, prevText: string): boolean {
  if (prevKind === "start" || prevKind === "op") return true;
  if (prevKind === "kw" && REGEX_PREV_KEYWORDS.has(prevText)) return true;
  return false;
}

function readRegexLiteral(code: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\n") return -1;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i++;
      while (i < code.length && /[dgimsuvy]/.test(code[i])) i++;
      return i;
    }
    i++;
  }
  return -1;
}

function highlightJsRange(code: string, start: number, stopAtBrace: boolean): {
  out: string;
  end: number;
} {
  let out = "";
  let i = start;
  let braceDepth = 0;
  let prevKind = "start";
  let prevText = "";
  let afterDot = false;

  while (i < code.length) {
    const ch = code[i];

    // Embedded HTTP header lines in mixed JS+HTTP examples (e.g. Access-Control-Allow-Origin: *)
    if (
      !stopAtBrace &&
      braceDepth === 0 &&
      (i === 0 || code[i - 1] === "\n") &&
      ch >= "A" &&
      ch <= "Z"
    ) {
      const rest = code.slice(i);
      const lineEndIdx = rest.indexOf("\n");
      const line = lineEndIdx === -1 ? rest : rest.slice(0, lineEndIdx);
      const hdr = line.match(
        /^([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)(:)(\s*)(.*)$/,
      );
      if (hdr && !hdr[4].includes("{") && !hdr[4].includes("}")) {
        out += span("ty", hdr[1]) + span("pun", hdr[2]) + escapeCodeText(hdr[3]) +
          highlightHttpValue(hdr[4]);
        i += line.length;
        prevKind = "start";
        prevText = "";
        afterDot = false;
        continue;
      }
    }

    // Comments
    if (ch === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i + 2);
      const end = nl === -1 ? code.length : nl;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? code.length : close + 2;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }

    // Regex literal
    if (ch === "/" && canStartRegex(prevKind, prevText)) {
      const end = readRegexLiteral(code, i);
      if (end > i) {
        out += span("str", code.slice(i, end));
        i = end;
        prevKind = "val";
        prevText = "";
        afterDot = false;
        continue;
      }
    }

    // Quoted strings
    if (ch === '"' || ch === "'") {
      const end = readQuotedString(code, i, ch);
      out += span("str", code.slice(i, end));
      i = end;
      prevKind = "val";
      prevText = "";
      afterDot = false;
      continue;
    }

    // Template literal with ${...} interpolation
    if (ch === "`") {
      let segStart = i;
      i++;
      while (i < code.length) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === "`") {
          i++;
          out += span("str", code.slice(segStart, i));
          segStart = i;
          break;
        }
        if (code[i] === "$" && code[i + 1] === "{") {
          out += span("str", code.slice(segStart, i));
          out += span("pun", "${");
          const expr = highlightJsRange(code, i + 2, true);
          out += expr.out;
          i = expr.end;
          if (code[i] === "}") {
            out += span("pun", "}");
            i++;
          }
          segStart = i;
          continue;
        }
        i++;
      }
      if (segStart < i) {
        out += span("str", code.slice(segStart, i));
      }
      prevKind = "val";
      prevText = "";
      afterDot = false;
      continue;
    }

    // Template expression termination
    if (stopAtBrace) {
      if (ch === "{") {
        braceDepth++;
      } else if (ch === "}") {
        if (braceDepth === 0) return { out, end: i };
        braceDepth--;
      }
    } else if (ch === "{") {
      braceDepth++;
    } else if (ch === "}" && braceDepth > 0) {
      braceDepth--;
    }

    // Numbers
    if (isDigit(ch) || (ch === "." && i + 1 < code.length && isDigit(code[i + 1]))) {
      const end = readNumber(code, i);
      out += span("num", code.slice(i, end));
      i = end;
      prevKind = "val";
      prevText = "";
      afterDot = false;
      continue;
    }

    // Identifiers, keywords, literals, and PascalCase types
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < code.length && isIdentPart(code[end])) end++;
      const word = code.slice(i, end);
      if (afterDot) {
        out += escapeCodeText(word);
        prevKind = "val";
        prevText = word;
      } else if (JS_KEYWORDS.has(word)) {
        out += span("kw", word);
        prevKind = "kw";
        prevText = word;
      } else if (JS_LITERALS.has(word)) {
        out += span("num", word);
        prevKind = "val";
        prevText = word;
      } else if (isPascalType(word)) {
        out += span("ty", word);
        prevKind = "val";
        prevText = word;
      } else {
        out += escapeCodeText(word);
        prevKind = "val";
        prevText = word;
      }
      i = end;
      afterDot = false;
      continue;
    }

    // Whitespace preserves afterDot/prevKind
    if (/\s/.test(ch)) {
      out += ch;
      i++;
      continue;
    }

    out += escapeCodeText(ch);
    afterDot = ch === ".";
    prevKind = /[)\]}>]/.test(ch) ? "val" : "op";
    prevText = ch;
    i++;
  }

  return { out, end: i };
}

function highlightJs(code: string): string {
  return highlightJsRange(code, 0, false).out;
}

// ----- WebIDL -----

const IDL_KEYWORDS = new Set([
  "async",
  "async_iterable",
  "attribute",
  "callback",
  "const",
  "constructor",
  "deleter",
  "dictionary",
  "enum",
  "getter",
  "includes",
  "inherit",
  "interface",
  "iterable",
  "maplike",
  "mixin",
  "namespace",
  "optional",
  "or",
  "partial",
  "readonly",
  "required",
  "setlike",
  "setter",
  "static",
  "stringifier",
  "typedef",
  "unrestricted",
  "unsigned",
]);

const IDL_TYPES = new Set([
  "ArrayBuffer",
  "ArrayBufferView",
  "BufferSource",
  "ByteString",
  "CSSOMString",
  "DOMString",
  "FrozenArray",
  "ObservableArray",
  "Promise",
  "USVString",
  "any",
  "bigint",
  "boolean",
  "byte",
  "double",
  "float",
  "long",
  "object",
  "octet",
  "record",
  "sequence",
  "short",
  "symbol",
  "undefined",
  "void",
]);

function highlightIdl(code: string): string {
  let out = "";
  let i = 0;
  let extAttrDepth = 0;

  while (i < code.length) {
    const ch = code[i];

    if (ch === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i + 2);
      const end = nl === -1 ? code.length : nl;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? code.length : close + 2;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = readQuotedString(code, i, ch);
      out += span("str", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "[") {
      extAttrDepth++;
      out += span("pun", "[");
      i++;
      continue;
    }
    if (ch === "]" && extAttrDepth > 0) {
      extAttrDepth--;
      out += span("pun", "]");
      i++;
      continue;
    }
    if (isDigit(ch)) {
      const end = readNumber(code, i);
      out += span("num", code.slice(i, end));
      i = end;
      continue;
    }
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < code.length && isIdentPart(code[end])) end++;
      const word = code.slice(i, end);
      if (extAttrDepth > 0) {
        // Extended attribute name before `=` / `,` / `]` / `(` vs its RHS value
        let j = i - 1;
        while (j >= 0 && /\s/.test(code[j])) j--;
        const isAttrName = j >= 0 && (code[j] === "[" || code[j] === ",");
        out += isAttrName ? span("attr", word) : span("ty", word);
      } else if (IDL_KEYWORDS.has(word)) {
        out += span("kw", word);
      } else if (IDL_TYPES.has(word) || isPascalType(word)) {
        out += span("ty", word);
      } else if (JS_LITERALS.has(word)) {
        out += span("num", word);
      } else {
        out += escapeCodeText(word);
      }
      i = end;
      continue;
    }

    out += escapeCodeText(ch);
    i++;
  }

  return out;
}

// ----- HTML / SVG / XML -----

function highlightHtmlTagAttrs(rawAttrs: string): string {
  let out = "";
  let i = 0;
  while (i < rawAttrs.length) {
    const ch = rawAttrs[i];
    if (/\s/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    if (ch === "=" || ch === "/") {
      out += span("pun", ch);
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = readQuotedString(rawAttrs, i, ch);
      out += span("str", rawAttrs.slice(i, end));
      i = end;
      continue;
    }
    if (/[A-Za-z_:@-]/.test(ch)) {
      let end = i + 1;
      while (end < rawAttrs.length && /[A-Za-z0-9_.:@-]/.test(rawAttrs[end])) end++;
      // Check if this is an unquoted attribute value right after `=`
      let j = i - 1;
      while (j >= 0 && /\s/.test(rawAttrs[j])) j--;
      const isVal = j >= 0 && rawAttrs[j] === "=";
      out += span(isVal ? "str" : "attr", rawAttrs.slice(i, end));
      i = end;
      continue;
    }
    out += escapeCodeText(ch);
    i++;
  }
  return out;
}

function highlightHtml(code: string): string {
  let out = "";
  let i = 0;

  while (i < code.length) {
    const lt = code.indexOf("<", i);
    if (lt === -1) {
      out += escapeCodeText(code.slice(i));
      break;
    }
    if (lt > i) {
      out += escapeCodeText(code.slice(i, lt));
    }

    // HTML comment
    if (code.startsWith("<!--", lt)) {
      const end = code.indexOf("-->", lt + 4);
      const stop = end === -1 ? code.length : end + 3;
      out += span("cm", code.slice(lt, stop));
      i = stop;
      continue;
    }

    // Processing instruction <?xml ...?> or doctype <!doctype ...>
    if (code.startsWith("<?", lt)) {
      const end = code.indexOf("?>", lt + 2);
      const stop = end === -1 ? code.length : end + 2;
      out += span("kw", code.slice(lt, stop));
      i = stop;
      continue;
    }
    if (/^<!doctype\b/i.test(code.slice(lt))) {
      const end = code.indexOf(">", lt + 9);
      const stop = end === -1 ? code.length : end + 1;
      out += span("kw", code.slice(lt, stop));
      i = stop;
      continue;
    }

    // Standard opening or closing tag
    const tagMatch = code.slice(lt).match(/^<(\/?)([A-Za-z][A-Za-z0-9:_-]*)([^>]*?)(\/?)>/);
    if (!tagMatch) {
      out += escapeCodeText("<");
      i = lt + 1;
      continue;
    }

    const [full, slash, tagName, rawAttrs, selfClose] = tagMatch;
    out += span("pun", `<${slash}`) +
      span("ty", tagName) +
      highlightHtmlTagAttrs(rawAttrs) +
      span("pun", `${selfClose}>`);
    i = lt + full.length;

    const lowerTag = tagName.toLowerCase();
    if (!slash && !selfClose && (lowerTag === "script" || lowerTag === "style")) {
      const closeRe = new RegExp(`<\\/${lowerTag}\\s*>`, "i");
      const rest = code.slice(i);
      const closeMatch = closeRe.exec(rest);
      if (closeMatch) {
        const inner = rest.slice(0, closeMatch.index);
        if (lowerTag === "style") {
          out += highlightCss(inner);
        } else {
          const isJsonScript =
            /\btype\s*=\s*["'](?:application\/json|speculationrules|importmap)["']/i.test(rawAttrs);
          out += isJsonScript ? highlightJson(inner) : highlightJs(inner);
        }
        const closeTag = closeMatch[0];
        const closeName = closeTag.slice(2, -1).trim();
        out += span("pun", "</") + span("ty", closeName) + span("pun", ">");
        i += closeMatch.index + closeTag.length;
      }
    }
  }

  return out;
}

// ----- CSS & CSS value-definition grammar -----

function highlightCss(code: string): string {
  let out = "";
  let i = 0;
  let depth = 0;

  while (i < code.length) {
    const ch = code[i];

    // Block comments (and occasional // comments in annotated snippets)
    if (ch === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? code.length : close + 2;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/" && (i === 0 || /\s/.test(code[i - 1]))) {
      const nl = code.indexOf("\n", i + 2);
      const end = nl === -1 ? code.length : nl;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }

    // Quoted strings
    if (ch === '"' || ch === "'") {
      const end = readQuotedString(code, i, ch);
      out += span("str", code.slice(i, end));
      i = end;
      continue;
    }

    // At-rules (@media, @supports, @property, @keyframes, ...)
    if (ch === "@" && i + 1 < code.length && /[a-zA-Z_-]/.test(code[i + 1])) {
      let end = i + 2;
      while (end < code.length && /[a-zA-Z0-9_-]/.test(code[end])) end++;
      out += span("kw", code.slice(i, end));
      i = end;
      continue;
    }

    // Formal CSS value grammar non-terminal `<length>`, `<color>`, etc.
    if (ch === "<") {
      const m = code.slice(i).match(/^<[a-z][a-z0-9-]*(?:\s*\[[^\]]+\])?>/i);
      if (m) {
        out += span("ty", m[0]);
        i += m[0].length;
        continue;
      }
    }

    // !important
    if (ch === "!" && /^!important\b/i.test(code.slice(i))) {
      out += span("kw", code.slice(i, i + 10));
      i += 10;
      continue;
    }

    // Hex colors inside declarations (outside blocks, `#id` is a selector)
    if (ch === "#") {
      if (depth > 0) {
        const hex = code.slice(i).match(/^#[0-9a-fA-F]{3,8}\b/);
        if (hex) {
          out += span("num", hex[0]);
          i += hex[0].length;
          continue;
        }
      } else {
        const idSel = code.slice(i).match(/^#[a-zA-Z_-][a-zA-Z0-9_-]*/);
        if (idSel) {
          out += span("ty", idSel[0]);
          i += idSel[0].length;
          continue;
        }
      }
    }

    // Class / pseudo-element / pseudo-class selectors outside declarations
    if (depth === 0 && (ch === "." || ch === ":")) {
      const sel = code.slice(i).match(/^(?:\.[a-zA-Z_-][a-zA-Z0-9_-]*|::?[a-zA-Z-][a-zA-Z0-9_-]*)/);
      if (sel) {
        out += span("ty", sel[0]);
        i += sel[0].length;
        continue;
      }
    }

    // Braces track selector vs declaration context
    if (ch === "{") {
      depth++;
      out += escapeCodeText(ch);
      i++;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth--;
      out += escapeCodeText(ch);
      i++;
      continue;
    }

    // CSS property name before `:` (not pseudo `::` or `:hover`)
    if (/[a-zA-Z-]/.test(ch)) {
      const propMatch = code.slice(i).match(/^((?:--|[a-zA-Z-])[a-zA-Z0-9_-]*)(?=\s*:(?!:))/);
      if (propMatch) {
        // Ensure we are at start of a declaration (after `{`, `;`, newline, or start of input)
        let j = i - 1;
        while (j >= 0 && (code[j] === " " || code[j] === "\t")) j--;
        const atDeclStart = j < 0 || code[j] === "\n" || code[j] === "{" || code[j] === ";";
        if (atDeclStart) {
          out += span("attr", propMatch[1]);
          i += propMatch[1].length;
          continue;
        }
      }
    }

    // Numbers + optional CSS unit
    if (
      isDigit(ch) ||
      ((ch === "." || ch === "-") && i + 1 < code.length && isDigit(code[i + 1]) &&
        (i === 0 || !/[a-zA-Z0-9_-]/.test(code[i - 1])))
    ) {
      const numMatch = code.slice(i).match(
        /^-?(?:\d+\.?\d*|\.\d+)(?:%|px|rem|em|ex|ch|lh|rlh|vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|cqw|cqh|cqi|cqb|fr|deg|rad|grad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?\b/,
      );
      if (numMatch) {
        out += span("num", numMatch[0]);
        i += numMatch[0].length;
        continue;
      }
    }

    // CSS custom property reference `var(--foo)` or `--foo`
    if (ch === "-" && code[i + 1] === "-") {
      const cv = code.slice(i).match(/^--[a-zA-Z0-9_-]+/);
      if (cv) {
        out += span("attr", cv[0]);
        i += cv[0].length;
        continue;
      }
    }

    out += escapeCodeText(ch);
    i++;
  }

  return out;
}

// ----- HTTP & Structured Fields -----

function highlightHttpValue(val: string): string {
  let out = "";
  let i = 0;
  while (i < val.length) {
    const ch = val[i];
    if (ch === '"' || ch === "'") {
      const end = readQuotedString(val, i, ch);
      out += span("str", val.slice(i, end));
      i = end;
      continue;
    }
    if (val.startsWith("https://", i) || val.startsWith("http://", i)) {
      let end = i;
      while (end < val.length && !/[\s,;)"']/.test(val[end])) end++;
      out += span("str", val.slice(i, end));
      i = end;
      continue;
    }
    // Structured Fields parameter `;key=`
    if (ch === ";") {
      const param = val.slice(i).match(/^(;\s*)([a-zA-Z0-9_.-]+)(=)/);
      if (param) {
        out += span("pun", param[1]) + span("attr", param[2]) + span("pun", param[3]);
        i += param[0].length;
        continue;
      }
    }
    // Structured Fields booleans `?0`, `?1`
    if (ch === "?" && (val[i + 1] === "0" || val[i + 1] === "1")) {
      out += span("num", val.slice(i, i + 2));
      i += 2;
      continue;
    }
    // Standalone boolean / number tokens
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < val.length && /[a-zA-Z0-9_-]/.test(val[end])) end++;
      const word = val.slice(i, end);
      out += (word === "true" || word === "false") ? span("num", word) : escapeCodeText(word);
      i = end;
      continue;
    }
    if (isDigit(ch) && (i === 0 || !/[a-zA-Z0-9_-]/.test(val[i - 1]))) {
      const end = readNumber(val, i);
      out += span("num", val.slice(i, end));
      i = end;
      continue;
    }
    out += escapeCodeText(ch);
    i++;
  }
  return out;
}

function highlightHttp(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      if (/^\s*(?:#|\/\/)/.test(line)) return span("cm", line);

      // HTTP response status line
      const status = line.match(/^(HTTP\/\d(?:\.\d)?)(\s+)(\d{3})(?:(\s+)(.*))?$/);
      if (status) {
        return span("kw", status[1]) +
          escapeCodeText(status[2]) +
          span("num", status[3]) +
          (status[4] ? escapeCodeText(status[4]) : "") +
          (status[5] ? span("ty", status[5]) : "");
      }

      // HTTP request line
      const req = line.match(
        /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)(\s+)(\S+)(\s+)(HTTP\/\d(?:\.\d)?)(.*)$/,
      );
      if (req) {
        return span("kw", req[1]) +
          escapeCodeText(req[2]) +
          span("str", req[3]) +
          escapeCodeText(req[4]) +
          span("kw", req[5]) +
          escapeCodeText(req[6]);
      }

      // Header line: `Header-Name: value`
      const hdr = line.match(/^([A-Za-z][A-Za-z0-9-]*)(:)(\s*)(.*)$/);
      if (hdr) {
        return span("ty", hdr[1]) +
          span("pun", hdr[2]) +
          escapeCodeText(hdr[3]) +
          highlightHttpValue(hdr[4]);
      }

      return highlightHttpValue(line);
    })
    .join("\n");
}

// ----- JSON -----

function highlightJson(code: string): string {
  let out = "";
  let i = 0;

  while (i < code.length) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i + 2);
      const end = nl === -1 ? code.length : nl;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? code.length : close + 2;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === '"') {
      const end = readQuotedString(code, i, '"');
      let j = end;
      while (j < code.length && /\s/.test(code[j])) j++;
      const isKey = code[j] === ":";
      out += span(isKey ? "attr" : "str", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "-" && i + 1 < code.length && isDigit(code[i + 1])) {
      const end = readNumber(code, i + 1);
      out += span("num", code.slice(i, end));
      i = end;
      continue;
    }
    if (isDigit(ch)) {
      const end = readNumber(code, i);
      out += span("num", code.slice(i, end));
      i = end;
      continue;
    }
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < code.length && isIdentPart(code[end])) end++;
      const word = code.slice(i, end);
      out += (word === "true" || word === "false" || word === "null")
        ? span("num", word)
        : escapeCodeText(word);
      i = end;
      continue;
    }
    out += escapeCodeText(ch);
    i++;
  }

  return out;
}

// ----- WGSL -----

const WGSL_KEYWORDS = new Set([
  "alias",
  "break",
  "case",
  "const",
  "const_assert",
  "continue",
  "continuing",
  "default",
  "diagnostic",
  "discard",
  "else",
  "enable",
  "fn",
  "for",
  "function",
  "if",
  "let",
  "loop",
  "override",
  "private",
  "read",
  "read_write",
  "requires",
  "return",
  "storage",
  "struct",
  "switch",
  "uniform",
  "var",
  "while",
  "workgroup",
  "write",
]);

const WGSL_TYPES = new Set([
  "array",
  "atomic",
  "bool",
  "f16",
  "f32",
  "i32",
  "mat2x2",
  "mat3x3",
  "mat4x4",
  "ptr",
  "sampler",
  "texture_2d",
  "u32",
  "vec2",
  "vec2f",
  "vec2h",
  "vec2i",
  "vec2u",
  "vec3",
  "vec3f",
  "vec3h",
  "vec3i",
  "vec3u",
  "vec4",
  "vec4f",
  "vec4h",
  "vec4i",
  "vec4u",
]);

function highlightWgsl(code: string): string {
  let out = "";
  let i = 0;

  while (i < code.length) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i + 2);
      const end = nl === -1 ? code.length : nl;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? code.length : close + 2;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "@" && i + 1 < code.length && isIdentStart(code[i + 1])) {
      let end = i + 2;
      while (end < code.length && isIdentPart(code[end])) end++;
      out += span("attr", code.slice(i, end));
      i = end;
      continue;
    }
    if (isDigit(ch)) {
      let end = readNumber(code, i);
      if (end < code.length && /[uifh]/.test(code[end])) end++;
      out += span("num", code.slice(i, end));
      i = end;
      continue;
    }
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < code.length && isIdentPart(code[end])) end++;
      const word = code.slice(i, end);
      if (WGSL_KEYWORDS.has(word)) out += span("kw", word);
      else if (word === "true" || word === "false") out += span("num", word);
      else if (WGSL_TYPES.has(word) || isPascalType(word)) out += span("ty", word);
      else out += escapeCodeText(word);
      i = end;
      continue;
    }
    out += escapeCodeText(ch);
    i++;
  }

  return out;
}

// ----- Shell / CLI flags -----

const SHELL_COMMANDS = new Set([
  "chrome",
  "chromium",
  "curl",
  "deno",
  "git",
  "google-chrome",
  "grep",
  "node",
  "npm",
  "npx",
  "openssl",
  "python",
  "python3",
]);

function highlightShell(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return span("cm", line);
      let out = "";
      let i = 0;
      let atCmdStart = true;

      while (i < line.length) {
        const ch = line[i];
        if (/\s/.test(ch)) {
          out += ch;
          i++;
          continue;
        }
        if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
          out += span("cm", line.slice(i));
          break;
        }
        if (atCmdStart && ch === "$" && (i + 1 === line.length || /\s/.test(line[i + 1]))) {
          out += span("pun", "$");
          i++;
          continue;
        }
        if (ch === '"' || ch === "'") {
          const end = readQuotedString(line, i, ch);
          out += span("str", line.slice(i, end));
          i = end;
          atCmdStart = false;
          continue;
        }
        if (ch === "-" && (i === 0 || /\s/.test(line[i - 1]))) {
          const fl = line.slice(i).match(/^--?[a-zA-Z0-9][a-zA-Z0-9_-]*/);
          if (fl) {
            out += span("attr", fl[0]);
            i += fl[0].length;
            atCmdStart = false;
            continue;
          }
        }
        if (ch === "|") {
          out += span("pun", "|");
          i++;
          atCmdStart = true;
          continue;
        }
        let end = i;
        while (end < line.length && !/[\s"'|=]/.test(line[end])) end++;
        const tok = line.slice(i, end);
        if (atCmdStart && SHELL_COMMANDS.has(tok)) {
          out += span("kw", tok);
        } else {
          out += escapeCodeText(tok);
        }
        i = end;
        atCmdStart = false;
        if (i < line.length && line[i] === "=") {
          out += span("pun", "=");
          i++;
        }
      }
      return out;
    })
    .join("\n");
}

// ----- Plain / Pseudocode / Diagrams -----

function highlightPlain(code: string): string {
  // Keep ASCII box/tree diagrams calm and pure base ink.
  if (/[├└│┌┐─]/.test(code)) {
    return escapeCodeText(code);
  }
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i + 2);
      const end = nl === -1 ? code.length : nl;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? code.length : close + 2;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "#" && (i === 0 || code[i - 1] === "\n")) {
      const nl = code.indexOf("\n", i + 1);
      const end = nl === -1 ? code.length : nl;
      out += span("cm", code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === '"') {
      const end = readQuotedString(code, i, '"');
      out += span("str", code.slice(i, end));
      i = end;
      continue;
    }
    out += escapeCodeText(ch);
    i++;
  }
  return out;
}

/** Highlight raw source code for a given language, returning safe HTML with .hl-* spans. */
export function highlightCode(code: string, lang: HighlightLang): string {
  switch (lang) {
    case "js":
      return highlightJs(code);
    case "idl":
      return highlightIdl(code);
    case "html":
      return highlightHtml(code);
    case "css":
      return highlightCss(code);
    case "http":
      return highlightHttp(code);
    case "json":
      return highlightJson(code);
    case "wgsl":
      return highlightWgsl(code);
    case "shell":
      return highlightShell(code);
    case "plain":
      return highlightPlain(code);
  }
}

function readHtmlAttr(rawAttrs: string, name: string): string | null {
  if (!rawAttrs) return null;
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = rawAttrs.match(re);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
}

/**
 * Idempotently highlight every plain-text <pre ...><code ...>...</code></pre> block in an HTML
 * document. Leaves any block containing non-highlight inner HTML tags untouched, and asserts that
 * stripping emitted highlight spans + decoding entities reproduces the exact original text.
 */
export function highlightHtmlDocument(html: string): {
  html: string;
  blocksHighlighted: number;
  blocksSkippedWithMarkup: number;
  changed: boolean;
} {
  let blocksHighlighted = 0;
  let blocksSkippedWithMarkup = 0;

  const nextHtml = html.replace(
    /(<pre\b[^>]*>\s*<code\b([^>]*)>)([\s\S]*?)(<\/code>\s*<\/pre>)/gi,
    (full, open: string, codeAttrs: string, inner: string, close: string) => {
      const stripped = stripHighlightSpans(inner);
      // Preserve blocks that carry authored inline markup (e.g. <em>, <mark>, <a>).
      if (/<[a-z/!]/i.test(stripped)) {
        blocksSkippedWithMarkup++;
        return full;
      }

      const rawCode = decodeCodeEntities(stripped);
      const lang = detectLanguage(rawCode, {
        dataDocTest: readHtmlAttr(codeAttrs, "data-doc-test"),
        className: readHtmlAttr(codeAttrs, "class"),
      });
      const highlighted = highlightCode(rawCode, lang);

      // Text-fidelity invariant: rendered textContent must equal the original code byte-for-byte.
      const roundTripped = decodeCodeEntities(stripHighlightSpans(highlighted));
      if (roundTripped !== rawCode) {
        throw new Error(
          `syntax-highlight textContent mismatch for lang=${lang} (${rawCode.length} vs ${roundTripped.length})`,
        );
      }

      blocksHighlighted++;
      return `${open}${highlighted}${close}`;
    },
  );

  return {
    html: nextHtml,
    blocksHighlighted,
    blocksSkippedWithMarkup,
    changed: nextHtml !== html,
  };
}
