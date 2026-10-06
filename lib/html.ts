// Shared HTML escaping.
//
// Moved here verbatim from server.ts (gendn-0cu) so that the commit-line renderer — which lives in
// its own module to be unit-testable — escapes exactly as the server does. One implementation
// rather than a copy of one.
//
// ENCODING ONLY. This is NOT a URL-scheme check: it encodes & < > " ' and nothing else. Scheme
// validation for externally sourced URLs lives in lib/external-url.ts, deliberately separate,
// because encoding and scheme validation are different concerns and merging them is how the next
// reader loses the distinction (THREAT_MODEL.md invariant #8).

export function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
