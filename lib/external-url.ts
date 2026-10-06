// Scheme validation for externally sourced URLs, and the rendering seam that uses it.
//
// WHY (gendn-0cu): THREAT_MODEL.md invariant #8 — "Externally sourced URLs must be scheme-validated
// before use in href/src (e.g. reject javascript:/data:)". GitHub commit JSON is an untrusted
// attack surface; `html_url` was stored verbatim and interpolated into `<a href="...">`, so a
// javascript: or data: URL from the API would have rendered as a clickable same-origin script
// execution. escapeHTML does not help: it encodes characters and performs NO scheme check.
//
// This is an ALLOWLIST, not a blocklist: only http and https are permitted, so javascript:, data:,
// vbscript:, blob:, file:, and unknown schemes are rejected by construction instead of by
// enumerating known-bad ones.

import { escapeHTML } from "./html.ts";

/**
 * Returns the parsed absolute href when `u` is a safe external link (http/https), otherwise null.
 *
 * null covers: non-strings, empty/whitespace-only values, unparseable strings, relative and
 * protocol-relative references ("/path", "//evil.example"), and every non-http(s) scheme.
 */
export function safeExternalUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const raw = u.trim();
  if (raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null; // relative, protocol-relative, or malformed
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

/**
 * Renders the commit link for the "Last updated" line.
 *
 * A safe URL renders as an anchor exactly as before; anything unsafe renders the same text
 * WITHOUT a link — not an empty href, and not a dropped line — so the page degrades to plain
 * text rather than offering a live script-bearing link.
 *
 * Exported as the unit-testable seam for the rendering path (the acceptance test drives this,
 * not just the helper), so it takes the raw API value and does its own escaping.
 */
export function renderCommitAnchor(htmlUrl: unknown, shortSha: unknown, label?: string): string {
  const text = escapeHTML(String(label ?? shortSha ?? ""));
  const code = `<code>${text}</code>`;
  const safe = safeExternalUrl(htmlUrl);
  if (!safe) return code;
  return `<a href="${escapeHTML(safe)}" target="_blank" rel="noopener">${code}</a>`;
}
