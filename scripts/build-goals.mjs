#!/usr/bin/env -S deno run --allow-read --allow-write
// build-goals.mjs — roll every critique's `followUpGoals` into the repo-level goals.json backlog.
//
// goals.json is the ADDITIVE backlog the routine consumes to pick the next new page or a targeted
// in-place fix. It NEVER authorizes replacing a stable page (durable-demo contract). Existing goal
// entries keep their `status` (open/done) across rebuilds; new followUpGoals are appended; a goal
// whose source critique no longer lists it is retained (history) unless already done.
//
// Usage: deno run --allow-read --allow-write scripts/build-goals.mjs

import { collectCritiques, readJson } from "./lib/artifacts.mjs";

function goalId(sourcePage, goal) {
  // Stable id from source page + goal text (so rebuilds don't duplicate).
  let h = 0;
  const s = `${sourcePage}::${goal}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `${sourcePage.replace(/\//g, "-")}-${(h >>> 0).toString(36)}`;
}

async function main() {
  const existing = (await readJson("./goals.json")) ?? { schemaVersion: 1, goals: [] };
  const byId = new Map(existing.goals.map((g) => [g.id, g]));

  const critiques = await collectCritiques(".");
  let added = 0;
  for (const c of critiques) {
    for (const fg of c.followUpGoals ?? []) {
      const id = goalId(c.id, fg.goal);
      if (byId.has(id)) {
        // keep status; refresh mutable fields
        const g = byId.get(id);
        g.goal = fg.goal;
        g.kind = fg.kind;
        g.priority = fg.priority;
        if (fg.suggestedSlug) g.suggestedSlug = fg.suggestedSlug;
        continue;
      }
      const g = {
        id,
        sourcePage: c.id,
        goal: fg.goal,
        kind: fg.kind,
        priority: fg.priority,
        status: "open",
        createdAt: new Date().toISOString().slice(0, 10),
      };
      if (fg.suggestedSlug) g.suggestedSlug = fg.suggestedSlug;
      byId.set(id, g);
      added++;
    }
  }

  const out = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    goals: [...byId.values()].sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      return (rank[a.priority] - rank[b.priority]) || a.id.localeCompare(b.id);
    }),
  };
  await Deno.writeTextFile("./goals.json", JSON.stringify(out, null, 2) + "\n");
  console.log(
    `build-goals: ${out.goals.length} goals (${added} new) from ${critiques.length} critiques`,
  );
}

if (import.meta.main) await main();
