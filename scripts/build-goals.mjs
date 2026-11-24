#!/usr/bin/env node
// build-goals.mjs — roll every critique's `followUpGoals` into the repo-level goals.json backlog.
//
// goals.json is the ADDITIVE backlog the routine consumes to pick the next new page or a targeted
// in-place fix. It NEVER authorizes replacing a stable page (durable-demo contract). Existing goal
// entries keep their `status` (open/done) across rebuilds; new followUpGoals are appended; a goal
// whose source critique no longer lists it is retained (history). Exact and normalized duplicates
// per (sourcePage, normalizedGoal) are deterministically deduplicated so rolling up critiques
// never accumulates duplicate entries.
//
// Usage: node scripts/build-goals.mjs

import * as sys from "./lib/sys.mjs";
import { collectCritiques, readJson } from "./lib/artifacts.mjs";

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const STATUS_RANK = { done: 0, open: 1 };

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeGoalText(goal) {
  return String(goal ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`'"\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function dedupeKey(sourcePage, goal) {
  return `${String(sourcePage ?? "").trim()}::${normalizeGoalText(goal)}`;
}

export function goalId(sourcePage, goal) {
  // Stable id from source page + goal text (so rebuilds don't duplicate).
  let h = 0;
  const s = `${sourcePage}::${goal}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `${sourcePage.replace(/\//g, "-")}-${(h >>> 0).toString(36)}`;
}

export function compareGoals(a, b) {
  return (
    ((PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99)) ||
    cmpStr(a.sourcePage, b.sourcePage) ||
    cmpStr(a.id, b.id)
  );
}

function canonicalEntry(g) {
  const out = {
    id: g.id,
    sourcePage: g.sourcePage,
    goal: g.goal,
    kind: g.kind,
    priority: g.priority,
    status: g.status,
  };
  if (g.suggestedSlug) out.suggestedSlug = g.suggestedSlug;
  if (g.createdAt) out.createdAt = g.createdAt;
  if (g.notes) out.notes = g.notes;
  return out;
}

function compareExistingPriority(a, b) {
  return (
    ((STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99)) ||
    ((PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99)) ||
    cmpStr(a.createdAt || "\uffff", b.createdAt || "\uffff") ||
    cmpStr(a.id, b.id)
  );
}

function mergeDuplicateExisting(a, b) {
  const [winner, loser] = compareExistingPriority(a, b) <= 0 ? [a, b] : [b, a];
  const merged = canonicalEntry(winner);
  const dates = [winner.createdAt, loser.createdAt].filter(Boolean).sort(cmpStr);
  if (dates.length) merged.createdAt = dates[0];
  if (!merged.suggestedSlug && loser.suggestedSlug) merged.suggestedSlug = loser.suggestedSlug;
  if (!merged.notes && loser.notes) merged.notes = loser.notes;
  return merged;
}

export function mergeGoals(
  existingGoals,
  critiques,
  today = new Date().toISOString().slice(0, 10),
) {
  const byKey = new Map();
  const keyById = new Map();
  let deduped = 0;

  for (const raw of existingGoals ?? []) {
    const g = canonicalEntry(raw);
    const key = dedupeKey(g.sourcePage, g.goal);
    const existingByKey = byKey.get(key);
    const existingIdKey = keyById.get(g.id);
    const existingById = existingIdKey !== undefined ? byKey.get(existingIdKey) : undefined;
    if (existingByKey || existingById) {
      let merged = g;
      if (existingByKey) {
        merged = mergeDuplicateExisting(existingByKey, merged);
        byKey.delete(key);
        deduped++;
      }
      if (existingById && existingById !== existingByKey) {
        merged = mergeDuplicateExisting(existingById, merged);
        byKey.delete(existingIdKey);
        deduped++;
      }
      const mergedKey = dedupeKey(merged.sourcePage, merged.goal);
      byKey.set(mergedKey, merged);
      keyById.set(g.id, mergedKey);
      keyById.set(merged.id, mergedKey);
      if (existingByKey) keyById.set(existingByKey.id, mergedKey);
      if (existingById) keyById.set(existingById.id, mergedKey);
    } else {
      byKey.set(key, g);
      keyById.set(g.id, key);
    }
  }

  let added = 0;
  const sortedCritiques = [...(critiques ?? [])].sort((a, b) => cmpStr(a.id, b.id));
  for (const c of sortedCritiques) {
    // Deduplicate followUpGoals within the same critique deterministically before merging.
    const uniqueFollowUps = new Map();
    for (const fg of c.followUpGoals ?? []) {
      const trimmedGoal = String(fg.goal ?? "").trim();
      if (!normalizeGoalText(trimmedGoal)) continue;
      const key = dedupeKey(c.id, trimmedGoal);
      const candidate = { ...fg, goal: trimmedGoal };
      const prev = uniqueFollowUps.get(key);
      if (prev) {
        deduped++;
        const rankDiff = (PRIORITY_RANK[candidate.priority] ?? 99) -
          (PRIORITY_RANK[prev.priority] ?? 99);
        if (rankDiff < 0 || (rankDiff === 0 && cmpStr(candidate.goal, prev.goal) < 0)) {
          uniqueFollowUps.set(key, candidate);
        }
      } else {
        uniqueFollowUps.set(key, candidate);
      }
    }

    for (const [key, fg] of uniqueFollowUps) {
      const id = goalId(c.id, fg.goal);
      const existingKey = byKey.has(key) ? key : keyById.get(id);
      if (existingKey !== undefined) {
        // Keep stable id, status, createdAt, and notes; refresh mutable fields.
        const g = byKey.get(existingKey);
        g.goal = fg.goal;
        g.kind = fg.kind;
        g.priority = fg.priority;
        if (fg.suggestedSlug) g.suggestedSlug = fg.suggestedSlug;
        if (existingKey !== key) {
          byKey.delete(existingKey);
          byKey.set(key, g);
          keyById.set(g.id, key);
        }
        keyById.set(id, key);
        continue;
      }
      const g = canonicalEntry({
        id,
        sourcePage: c.id,
        goal: fg.goal,
        kind: fg.kind,
        priority: fg.priority,
        status: "open",
        createdAt: today,
        suggestedSlug: fg.suggestedSlug,
      });
      byKey.set(key, g);
      keyById.set(id, key);
      added++;
    }
  }

  const goals = [...byKey.values()].sort(compareGoals);
  return { goals, added, deduped };
}

async function main() {
  const existing = (await readJson("./goals.json")) ?? { schemaVersion: 1, goals: [] };
  const critiques = await collectCritiques(".");
  const { goals, added, deduped } = mergeGoals(existing.goals ?? [], critiques);

  const out = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    goals,
  };
  await sys.writeTextFile("./goals.json", JSON.stringify(out, null, 2) + "\n");
  console.log(
    `build-goals: ${out.goals.length} goals (${added} new, ${deduped} deduplicated) from ${critiques.length} critiques`,
  );
}

if (sys.isMain(import.meta.url)) await main();
