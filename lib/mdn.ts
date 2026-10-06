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
// A TRANSPORT FAILURE IS UNKNOWN, NOT A NEGATIVE ANSWER (gendn-5fk): only a definitive HTTP
// response decides the CACHED answer.
//   - res.ok (200 and friends)  -> true,  cached
//   - 404                       -> false, cached (a real "no such page")
//   - anything else (5xx, 429, ...) and every transport/timeout/oversize error
//                               -> false, NOT cached, so the next call retries instead of being
//                                  told "MDN has no page" for an hour because of a network blip.
// The returned false therefore means "not known to exist", which is the honest reading for
// callers; the cache is what carries the definitive answer.

import { fetchBounded, UPSTREAM_TIMEOUT_MS } from "./chromestatus.ts";

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; exists: boolean }>();
const MDN_BASE = "https://developer.mozilla.org";

export async function mdnHas(
  path: string,
  // base/timeoutMs are an explicit test seam (the module has no importers, so this is additive):
  // a fixture points base at a local server and shortens the bound instead of reaching MDN.
  opts: { base?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const url = `${opts.base ?? MDN_BASE}${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.exists;

  let res: Response;
  try {
    ({ res } = await fetchBounded(url, {
      method: "HEAD",
      timeoutMs: opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
    }));
  } catch {
    // timeout / transport error / oversized response: UNKNOWN, deliberately not cached
    return false;
  }

  if (res.ok) {
    cache.set(url, { at: Date.now(), exists: true });
    return true;
  }
  if (res.status === 404) {
    cache.set(url, { at: Date.now(), exists: false });
    return false;
  }
  // Any other status is a statement about the server, not about the page: do not cache.
  return false;
}

// NO CALLERS TODAY (gendn-76k; verified repo-wide - the only references are these two definitions
// and scripts/mdn-has.test.mjs). .claude/routine-prompt.md builds the same URLs BY HAND inside its
// curl commands, because a prose prompt cannot import a TypeScript builder, so the shape currently
// exists in two places and only this one is pinned.
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
