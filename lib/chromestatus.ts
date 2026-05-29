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

const cache = new Map<string, { at: number; value: unknown }>();

async function getJson<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;

  const res = await fetch(BASE + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`chromestatus ${path} returned ${res.status}`);
  let text = await res.text();
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
