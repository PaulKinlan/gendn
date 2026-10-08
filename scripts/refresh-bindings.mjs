#!/usr/bin/env -S deno run --allow-read --allow-run --allow-write
// Explicit, reviewable regeneration of the identity/demo ledger. Never called by check-routes.
// Usage: deno task refresh-bindings [--allow-removals]
import { buildManifest } from "./route-manifest.mjs";
import {
  BINDING_LEDGER,
  bindingsFromManifest,
  evaluateLedgerRefresh,
} from "./lib/binding-ledger.mjs";

export async function refreshBindings(options = {}) {
  const allowRemovals = options.allowRemovals ?? false;
  const ledgerPath = options.ledgerPath ?? BINDING_LEDGER;
  const root = options.root ?? ".";

  const rows = bindingsFromManifest(await buildManifest({ root }));

  let priorLedger = [];
  try {
    const raw = await Deno.readTextFile(ledgerPath);
    priorLedger = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  const check = evaluateLedgerRefresh({
    current: rows,
    ledger: priorLedger,
    allowRemovals,
    ledgerLabel: ledgerPath,
  });

  if (!check.ok) {
    console.error(check.message);
    return { ok: false, message: check.message, exitCode: 1 };
  }

  await Deno.writeTextFile(ledgerPath, JSON.stringify(rows, null, 2) + "\n");
  console.log(`refreshed ${ledgerPath}: ${rows.length} published routes (identity + demo only)`);
  return { ok: true, rows, exitCode: 0 };
}

if (import.meta.main) {
  let allowRemovals = false;
  let ledgerPath = BINDING_LEDGER;
  let root = ".";

  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (arg === "--allow-removals") {
      allowRemovals = true;
    } else if (arg === "--ledger" && i + 1 < Deno.args.length) {
      ledgerPath = Deno.args[++i];
    } else if (arg.startsWith("--ledger=")) {
      ledgerPath = arg.slice("--ledger=".length);
    } else if (arg === "--root" && i + 1 < Deno.args.length) {
      root = Deno.args[++i];
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    }
  }

  const res = await refreshBindings({ allowRemovals, ledgerPath, root });
  if (!res.ok) {
    Deno.exit(res.exitCode ?? 1);
  }
}
