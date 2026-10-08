// CPS conformance is a feature-level contract, not necessarily a selected concept demo's
// child route. Discover a candidate from the live concept page's feature breadcrumb (or
// from the selected feature page itself), then verify its live suite's declared identity,
// release and featureSlug. Never infer the feature route by counting path segments.
import { SHOWCASE_HOST } from "./artifacts.mjs";

const ORIGIN = `https://${SHOWCASE_HOST}`;
const MAX_BYTES = 650_000;

async function responseText(url, fetcher) {
  try {
    const res = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(12_000) });
    if (res.status !== 200 || res.headers.get("location")) return null;
    let length = 0;
    const chunks = [];
    const reader = res.body?.getReader();
    if (!reader) return null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return { text: new TextDecoder().decode(data), type: res.headers.get("content-type") ?? "" };
  } catch {
    // Timeouts/transport failures cannot authorize an unverified pointer.
    return null;
  }
}

export async function verifiedCpsConformance(meta, fetcher = fetch) {
  if (!meta.demo) return { route: null, reason: "no selected demo" };
  let demo;
  try {
    demo = new URL(meta.demo);
  } catch {
    return { route: null, reason: "invalid selected demo URL" };
  }
  if (demo.origin !== ORIGIN || demo.search || demo.hash || !demo.pathname.endsWith("/")) {
    return { route: null, reason: "selected demo is not a canonical CPS route" };
  }
  const selected = await responseText(demo.href, fetcher);
  if (!selected?.type.includes("text/html")) {
    return { route: null, reason: "selected demo did not resolve to HTML" };
  }
  // The first candidate is the selected feature itself. For concept demos, only explicit
  // same-origin ancestor breadcrumbs in the live HTML can supply a feature parent.
  const candidates = new Set([demo.pathname]);
  for (const match of selected.text.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1];
    if (
      !href.startsWith("/") || href.startsWith("//") || href.includes("?") || href.includes("#")
    ) {
      continue;
    }
    if (href !== demo.pathname && demo.pathname.startsWith(href) && href.endsWith("/")) {
      candidates.add(href);
    }
  }
  const verified = [];
  for (const candidate of candidates) {
    const body = await responseText(`${ORIGIN}${candidate}conformance.json`, fetcher);
    if (!body?.type.includes("application/json")) continue;
    let suite;
    try {
      suite = JSON.parse(body.text);
    } catch {
      continue;
    }
    // The suite declares its own feature root. This check validates a breadcrumb rather
    // than deriving a route by truncating the demo pathname to a fixed number of segments.
    if (
      String(suite.chromestatusId) !== meta.identity ||
      !/^v\d+$/.test(suite.release) ||
      !/^[a-z0-9-]+$/.test(suite.featureSlug) ||
      candidate !== `/${suite.release}/${suite.featureSlug}/`
    ) continue;
    if (candidate !== demo.pathname) {
      const parent = await responseText(`${ORIGIN}${candidate}`, fetcher);
      if (!parent?.type.includes("text/html")) continue;
    }
    verified.push(`${candidate}conformance`);
  }
  if (verified.length !== 1) {
    return {
      route: null,
      reason: verified.length
        ? "ambiguous same-feature suites"
        : "no verified breadcrumb and same-feature CPS suite",
    };
  }
  const page = await responseText(`${ORIGIN}${verified[0]}`, fetcher);
  if (!page?.type.includes("text/html")) {
    return { route: null, reason: "verified suite has no resolving HTML conformance page" };
  }
  return { route: verified[0], reason: "verified live CPS feature breadcrumb and suite identity" };
}
