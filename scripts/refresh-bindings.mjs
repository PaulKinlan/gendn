#!/usr/bin/env -S deno run --allow-read --allow-run --allow-write
// Explicit, reviewable regeneration of the identity/demo ledger. Never called by check-routes.
// Usage: deno task refresh-bindings
import { buildManifest } from "./route-manifest.mjs";
import { BINDING_LEDGER, bindingsFromManifest } from "./lib/binding-ledger.mjs";

const rows = bindingsFromManifest(await buildManifest());
await Deno.writeTextFile(BINDING_LEDGER, JSON.stringify(rows, null, 2) + "\n");
console.log(`refreshed ${BINDING_LEDGER}: ${rows.length} published routes (identity + demo only)`);
