// MDN existence heuristics.
//
// MDN URL convention for Web Platform APIs is:
//   https://developer.mozilla.org/en-US/docs/Web/API/<InterfaceName>
// and for CSS properties:
//   https://developer.mozilla.org/en-US/docs/Web/CSS/<property-name>
//
// A HEAD request against the canonical URL is the simplest "does it exist" check. MDN returns 200
// for real pages and 404 for missing ones. We cache a result for an hour so we are not pinging MDN
// on every request.
//
// BOUNDED (gendn-5fk): the HEAD now goes through fetchBounded() from lib/chromestatus.ts, so it
// carries the same timeout and byte bound as every other outbound fetch in the repo
// (THREAT_MODEL.md invariant #7) instead of being able to hang indefinitely.
//
// A TRANSPORT FAILURE IS UNKNOWN, NOT A NEGATIVE ANSWER (gendn-5fk, gendn-s4i6): only a
// definitive HTTP response decides the CACHED answer.
//   - res.ok (200 and friends)  -> { kind: "present" }, cached
//   - 404                       -> { kind: "missing" }, cached (a real "no such page")
//   - anything else (5xx, 429, ...) and every transport/timeout/oversize error
//                               -> { kind: "unknown" }, NOT cached, so the next call retries.
// A caller must distinguish "missing" from "unknown"; when coverage is ambiguous, generate
// a page rather than mis-redirecting (THREAT_MODEL.md invariant #6).

import { fetchBounded, UPSTREAM_TIMEOUT_MS } from "./chromestatus.ts";

const TTL_MS = 60 * 60 * 1000;
const MDN_BASE = "https://developer.mozilla.org";

// A discriminant instead of a boolean prevents a transport failure from masquerading as a
// definitive 404. The cache type cannot hold UNKNOWN, and the frozen values are safe to share.
type MdnKnown = Readonly<{ kind: "present" } | { kind: "missing" }>;
export type MdnLookup = MdnKnown | Readonly<{ kind: "unknown" }>;
const PRESENT: MdnKnown = Object.freeze({ kind: "present" });
const MISSING: MdnKnown = Object.freeze({ kind: "missing" });
const UNKNOWN: MdnLookup = Object.freeze({ kind: "unknown" });
const cache = new Map<string, { at: number; result: MdnKnown }>();

export async function mdnHas(
  path: string,
  // base/timeoutMs are an explicit test seam (no non-test importers today):
  // a fixture points base at a local server and shortens the bound instead of reaching MDN.
  opts: { base?: string; timeoutMs?: number } = {},
): Promise<MdnLookup> {
  const url = `${opts.base ?? MDN_BASE}${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  let res: Response;
  try {
    ({ res } = await fetchBounded(url, {
      method: "HEAD",
      timeoutMs: opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
    }));
  } catch {
    // timeout / transport error / oversized response: UNKNOWN, deliberately not cached
    return UNKNOWN;
  }

  if (res.ok) {
    cache.set(url, { at: Date.now(), result: PRESENT });
    return PRESENT;
  }
  if (res.status === 404) {
    cache.set(url, { at: Date.now(), result: MISSING });
    return MISSING;
  }
  // Any other status is a statement about the server, not about the page: do not cache.
  return UNKNOWN;
}

// NO CALLERS TODAY (gendn-76k; verified repo-wide - the only references are these two definitions
// and scripts/mdn-has.test.mjs). .claude/routine-prompt.md writes the same URLs BY HAND in its prose
// Candidate-MDN-URLs list (Step 5), because a prose prompt cannot import a TypeScript builder, so the
// shape currently exists in two places and only this one is pinned. (The one curl in that step hits
// the MDN search API, /api/v1/search, not these docs URLs.)
//
// BOTH PARAMETERS LAND IN THE URL UNENCODED: `?`, `#`, `..`, `//`, `%`, `&` and newlines pass
// straight through. Nothing reachable does that today, so this is a hazard rather than a live bug -
// but ANY new caller must escape page-derived text (a slug, a version, anything read from content)
// before calling. Adding escaping is a deliberate change: it must UPDATE the exact-output pins in
// scripts/mdn-has.test.mjs, because those pins are a TRIPWIRE recording current behaviour, not an
// endorsement of raw interpolation.
export function mdnApiUrl(interfaceName: string): string {
  return `https://developer.mozilla.org/en-US/docs/Web/API/${interfaceName}`;
}

export function mdnCssUrl(property: string): string {
  return `https://developer.mozilla.org/en-US/docs/Web/CSS/${property}`;
}
