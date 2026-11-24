#!/usr/bin/env -S deno run --allow-read --allow-run --allow-write
// Explicit, reviewable regeneration of the identity/demo ledger. Never called by check-routes.
// Usage: deno task refresh-bindings [--allow-removals]
import * as sys from "./lib/sys.mjs";
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
    const raw = await sys.readTextFile(ledgerPath);
    priorLedger = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof sys.errors.NotFound)) {
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

  await sys.writeTextFile(ledgerPath, JSON.stringify(rows, null, 2) + "\n");
  console.log(`refreshed ${ledgerPath}: ${rows.length} published routes (identity + demo only)`);
  return { ok: true, rows, exitCode: 0 };
}

if (sys.isMain(import.meta.url)) {
  let allowRemovals = false;
  let ledgerPath = BINDING_LEDGER;
  let root = ".";

  for (let i = 0; i < sys.args.length; i++) {
    const arg = sys.args[i];
    if (arg === "--allow-removals") {
      allowRemovals = true;
    } else if (arg === "--ledger" && i + 1 < sys.args.length) {
      ledgerPath = sys.args[++i];
    } else if (arg.startsWith("--ledger=")) {
      ledgerPath = arg.slice("--ledger=".length);
    } else if (arg === "--root" && i + 1 < sys.args.length) {
      root = sys.args[++i];
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    }
  }

  const res = await refreshBindings({ allowRemovals, ledgerPath, root });
  if (!res.ok) {
    process.exit(res.exitCode ?? 1);
  }
}
