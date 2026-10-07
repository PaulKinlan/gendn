// Thin wrapper around the chromestatus.com JSON API.
//
// Notes:
// - The API guards responses against XSSI by prefixing them with `)]}'\n`.
//   We strip those bytes before parsing.
// - Responses are cached in-memory with a TTL so we are not hammering the API
//   on every request. Process restarts (and Deno Deploy isolate restarts) will
//   refetch.

// Injectable base for TESTS ONLY (gendn-14o): when CHROMESTATUS_BASE is set at import time, the
// wrapper targets a local HTTP stub instead of the live API, so parsing/cache/grouping behaviour
// can be tested with no live chromestatus dependency. Production (Deno Deploy, deno task start)
// never sets it, so the default below is the only real behaviour. The try/catch keeps the module
// importable without --allow-env (Deno.env.get would throw a PermissionDenied at import time).
let BASE = "https://chromestatus.com/api/v0";
try {
  BASE = Deno.env.get("CHROMESTATUS_BASE") ?? BASE;
} catch {
  // no env permission: production default
}
const TTL_MS = 5 * 60 * 1000;
const XSSI_PREFIX = ")]}'";

// Allowed origins for outbound fetches and redirect destinations (gendn-lkj). fetchBounded()
// is the single outbound primitive in the repo (THREAT_MODEL.md invariant #7). This set is the
// complete set of origins fetchBounded is called with across the repo (lib/chromestatus.ts,
// server.ts, lib/mdn.ts, scripts/vendor-fonts.mjs). If an upstream redirects, the destination
// origin must remain on this allowlist rather than an arbitrary host.
export const ALLOWED_ORIGINS = new Set([
  "https://chromestatus.com",
  "https://api.github.com",
  "https://developer.mozilla.org",
  "https://fonts.googleapis.com",
]);

// Bounded upstream fetches (gendn-snd). A hung or oversized upstream must not be able to stall
// or balloon the server.
//
// TIMEOUT: 15_000 ms, deliberately generous. chromestatus's API answers well under a second
// when healthy, but this VM has measured 60-85% host CPU steal, and a cache miss happens on the
// request path — so the bound only has to catch a HUNG connection, not police a slow one. Too
// short would turn a slow-but-working upstream into an outage, which is worse than the exposure
// being removed; 15s is ~15x the healthy p100 while still bounding a stalled socket.
//
// SIZE: 8 MiB. A milestone's feature list is the largest upstream payload (a few hundred
// features with prose); 8 MiB is roughly 4x the biggest observed response and still a hard
// ceiling on what one response can allocate.
export const UPSTREAM_TIMEOUT_MS = 15_000;
export const UPSTREAM_MAX_BYTES = 8 * 1024 * 1024;

/** Read a response body with a hard byte cap, refusing oversized responses early. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error(`upstream response too large: ${declared} bytes > ${maxBytes} cap`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`upstream response exceeded the ${maxBytes}-byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

/**
 * fetch with a bounded timeout and a bounded body size (gendn-snd). Callers get a thrown Error
 * either way, so the caller's error handling (generic client message + server-side detail) is
 * the single place that decides what a client sees.
 */
export async function fetchBounded(
  url: string,
  { headers, timeoutMs = UPSTREAM_TIMEOUT_MS, maxBytes = UPSTREAM_MAX_BYTES, method }: {
    headers?: HeadersInit;
    timeoutMs?: number;
    maxBytes?: number;
    // method is additive for gendn-5fk: lib/mdn.ts existence checks use HEAD, and that fetch must
    // carry the same bound as every other outbound call rather than a second implementation.
    // Omitted (undefined) means a normal GET, so existing callers are unchanged.
    method?: string;
  } = {},
): Promise<{ res: Response; text: string }> {
  const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.redirected && !ALLOWED_ORIGINS.has(new URL(res.url).origin)) {
    try {
      await res.body?.cancel();
    } catch {
      // already closed or absent
    }
    throw new Error(`fetchBounded: redirected off-allowlist to ${new URL(res.url).origin}`);
  }
  const text = await readCapped(res, maxBytes);
  return { res, text };
}

const cache = new Map<string, { at: number; value: unknown }>();

async function getJson<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;

  const { res, text: body } = await fetchBounded(BASE + path, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`chromestatus ${path} returned ${res.status}`);
  let text = body;
  if (text.startsWith(XSSI_PREFIX)) text = text.slice(XSSI_PREFIX.length).trimStart();
  const parsed = JSON.parse(text) as T;
  cache.set(path, { at: Date.now(), value: parsed });
  return parsed;
}

// ----- /channels -----

export interface Channel {
  mstone: number;
  version: number;
  branch_point: string;
  stable_date: string;
}

export interface Channels {
  stable: Channel;
  beta: Channel;
  dev: Channel;
}

export function getChannels(): Promise<Channels> {
  return getJson<Channels>("/channels");
}

// ----- /features?milestone=N -----

export type FeatureCategory =
  | "Enabled by default"
  | "In developer trial (Behind a flag)"
  | "Origin trial"
  | "Browser Intervention"
  | "Deprecated"
  | "Removed"
  | "Stepped rollout";

export interface FeatureSummary {
  id: number;
  name: string;
  summary: string;
  category?: string;
  feature_type?: string;
  intent_stage?: string;
  is_released?: boolean;
  browsers?: {
    chrome?: {
      bug?: string | null;
      blink_components?: string[];
      status?: { text?: string; milestone_str?: string };
      desktop?: number | null;
      android?: number | null;
      webview?: number | null;
      ios?: number | null;
      flag?: boolean;
      origintrial?: boolean;
    };
  };
  resources?: { samples?: string[]; docs?: string[] };
}

interface FeaturesByMilestoneResponse {
  features_by_type: Record<string, FeatureSummary[]>;
}

export interface MilestoneFeatures {
  milestone: number;
  groups: { category: string; features: FeatureSummary[] }[];
  total: number;
}

export async function getMilestoneFeatures(milestone: number): Promise<MilestoneFeatures> {
  const data = await getJson<FeaturesByMilestoneResponse>(`/features?milestone=${milestone}`);
  const groups = Object.entries(data.features_by_type)
    .filter(([_, list]) => list.length > 0)
    .map(([category, features]) => ({ category, features }));
  const total = groups.reduce((s, g) => s + g.features.length, 0);
  return { milestone, groups, total };
}

// ----- /features/<id> (full single-feature detail) -----

export interface FeatureDetail extends FeatureSummary {
  motivation?: string;
  initial_public_proposal_url?: string;
  explainer_links?: string[];
  spec_link?: string;
  doc_links?: string[];
  sample_links?: string[];
  tag_review?: string;
  ff_views?: number;
  safari_views?: number;
  web_dev_views?: number;
  standards?: { spec?: string; maturity?: { text?: string; short_text?: string } };
  ot_milestone_desktop_start?: number;
  blink_components?: string[];
  shipping_year?: number;
}

export function getFeature(id: number): Promise<FeatureDetail> {
  return getJson<FeatureDetail>(`/features/${id}`);
}

// ----- helpers -----

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Runtime narrowing for untrusted upstream feature ids (gendn-b2s / finding TM-1,
// THREAT_MODEL.md invariant #4): the compile-time `number` on FeatureSummary.id is a CLAIM
// about JSON that arrives from chromestatus.com at runtime, and lifecycle artifacts carry the
// identity as a STRING — the string path is a PRIMARY path, not an edge. The existing failure
// mode is exactly a value that looked numeric and was not, so the guard checks the VALUE, not
// the type.
//
// THE ENFORCED BOUNDS, stated exactly because a claim of narrowing that the code does not
// enforce is worse than no claim (review finding 1, rule 67): both arrival types normalize to a
// digit string and then face the SAME two checks — (a) canonical shape: no leading zero, at
// most 19 characters (FEATURE_ID_RE, defence-in-depth); (b) safe-integer VALUE:
// Number.isSafeInteger(Number(digits)), i.e. <= 2^53 - 1, which binds at 16 digits and is the
// bound that actually rejects '9007199254740992' and 19-digit strings. An earlier version
// applied (b) only on the number branch, so the same conceptual value passed or failed
// depending on how it arrived — the asymmetry was the defect. Anything failing either check
// yields null and the render seam falls back to plain text instead of a link — the
// renderCommitAnchor shape from lib/external-url.ts. Digits need no escaping: the narrowed
// output is canonical by construction, which is stronger than encoding an unvalidated value
// (encoding was never the missing check here — narrowness is).
const FEATURE_ID_RE = /^[1-9][0-9]{0,18}$/;

export function chromeStatusUrl(id: unknown): string | null {
  const digits = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : null;
  return digits !== null &&
      FEATURE_ID_RE.test(digits) &&
      Number.isSafeInteger(Number(digits))
    ? `https://chromestatus.com/feature/${digits}`
    : null;
}

// Runtime narrowing for untrusted Chrome milestone values (gendn-sxn / THREAT_MODEL.md invariant #4).
// Milestone values arrive from upstream channels.json or chromestatus API JSON typed as `number`
// at compile time, but can arrive as untrusted runtime values or strings.
//
// THE ENFORCED BOUND: A valid Chrome milestone is a canonical positive integer from 1 to 9999
// (1 to 4 digits, no leading zero). Both number and string arrivals normalize to a trimmed digit
// string and face the same check: /^[1-9][0-9]{0,3}$/ and Number.isSafeInteger(Number(digits)).
// Values outside 1..9999, floats, negatives, zero, leading zeros, and non-numeric inputs yield null.
// Callers fall back safely (plain text or aria-disabled) so broken or injectable attributes/hrefs are never emitted.
const MILESTONE_RE = /^[1-9][0-9]{0,3}$/;

export function milestonePathSegment(m: unknown): string | null {
  const digits = typeof m === "number"
    ? (Number.isFinite(m) ? String(m) : null)
    : typeof m === "string"
    ? m.trim()
    : null;
  return digits !== null &&
      MILESTONE_RE.test(digits) &&
      Number.isSafeInteger(Number(digits))
    ? digits
    : null;
}
