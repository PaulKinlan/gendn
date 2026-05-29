// MDN existence heuristics.
//
// MDN URL convention for Web Platform APIs is:
//   https://developer.mozilla.org/en-US/docs/Web/API/<InterfaceName>
// and for CSS properties:
//   https://developer.mozilla.org/en-US/docs/Web/CSS/<property-name>
//
// A HEAD request against the canonical URL is the simplest "does it exist"
// check. MDN returns 200 for real pages and 404 for missing ones. We cache
// the result for an hour so we're not pinging MDN on every request.

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; exists: boolean }>();

export async function mdnHas(path: string): Promise<boolean> {
  const url = `https://developer.mozilla.org${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.exists;
  try {
    const res = await fetch(url, { method: "HEAD" });
    const exists = res.ok;
    cache.set(url, { at: Date.now(), exists });
    return exists;
  } catch {
    return false;
  }
}

export function mdnApiUrl(interfaceName: string): string {
  return `https://developer.mozilla.org/en-US/docs/Web/API/${interfaceName}`;
}

export function mdnCssUrl(property: string): string {
  return `https://developer.mozilla.org/en-US/docs/Web/CSS/${property}`;
}
