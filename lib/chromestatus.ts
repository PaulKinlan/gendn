// Thin wrapper around the chromestatus.com JSON API.
//
// Notes:
// - The API guards responses against XSSI by prefixing them with `)]}'\n`.
//   We strip those bytes before parsing.
// - Responses are cached in-memory with a TTL so we are not hammering the API
//   on every request. Process restarts (and Deno Deploy isolate restarts) will
//   refetch.

const BASE = "https://chromestatus.com/api/v0";
const TTL_MS = 5 * 60 * 1000;
const XSSI_PREFIX = ")]}'";

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
  { headers, timeoutMs = UPSTREAM_TIMEOUT_MS, maxBytes = UPSTREAM_MAX_BYTES }: {
    headers?: HeadersInit;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<{ res: Response; text: string }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
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

export function chromeStatusUrl(id: number): string {
  return `https://chromestatus.com/feature/${id}`;
}
