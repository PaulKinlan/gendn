// A narrow, extractor-independent published binding baseline. The gate never refreshes it:
// `deno task refresh-bindings` is the only intentional update path.
export const BINDING_LEDGER = "route-bindings.json";

export function formatRemovedRoutes(removed, max = 3) {
  if (!removed || removed.length === 0) return "none";
  if (removed.length <= max) {
    return removed.join(", ");
  }
  const shown = removed.slice(0, max);
  const remaining = removed.length - max;
  return `${shown.join(", ")}, ... and ${remaining} more`;
}

export function evaluateLedgerRefresh({
  current,
  ledger = [],
  allowRemovals = false,
  ledgerLabel = BINDING_LEDGER,
}) {
  if (!Array.isArray(current)) {
    return {
      ok: false,
      reason: "invalid rows",
      removed: [],
      message: `refusing to refresh ${ledgerLabel}: derived rows must be an array`,
    };
  }

  const currentRoutes = new Set(current.map((r) => r.route));
  const priorRoutes = Array.isArray(ledger) ? ledger.map((r) => r.route) : [];
  const removed = priorRoutes.filter((route) => !currentRoutes.has(route));

  // Condition 1: newly derived rows are EMPTY
  if (current.length === 0) {
    const formatted = formatRemovedRoutes(removed);
    const detail = removed.length > 0
      ? `; would remove ${removed.length} route${removed.length === 1 ? "" : "s"}: ${formatted}`
      : "";
    return {
      ok: false,
      reason: "catalogue empty",
      removed,
      message: `refusing to refresh ${ledgerLabel}: catalogue empty (0 derived rows)${detail}`,
    };
  }

  // Condition 2: newly derived rows would REMOVE routes from existing ledger
  if (removed.length > 0 && !allowRemovals) {
    const formatted = formatRemovedRoutes(removed);
    return {
      ok: false,
      reason: "catalogue shrunk",
      removed,
      message:
        `refusing to refresh ${ledgerLabel}: catalogue shrunk; would remove ${removed.length} route${
          removed.length === 1 ? "" : "s"
        }: ${formatted} (pass --allow-removals to authorize)`,
    };
  }

  return {
    ok: true,
    reason: null,
    removed: allowRemovals ? removed : [],
  };
}

export function bindingsFromManifest(manifest) {
  return manifest.map(({ route, identity, demo }) => ({ route, identity, demo }))
    .sort((a, b) => a.route < b.route ? -1 : a.route > b.route ? 1 : 0);
}

function validateRows(rows, label) {
  const errors = [];
  if (!Array.isArray(rows)) return [`${label} must be an array`];
  const seen = new Set();
  let previous = "";
  for (const [index, row] of rows.entries()) {
    if (
      !row || typeof row !== "object" || Array.isArray(row) ||
      Object.keys(row).sort().join(",") !== "demo,identity,route"
    ) {
      errors.push(`${label}[${index}] must have exactly route, identity, demo`);
      continue;
    }
    if (typeof row.route !== "string" || !/^\/v\d+\/[^/]+\/$/.test(row.route)) {
      errors.push(`${label}[${index}] has an invalid published route`);
      continue;
    }
    if (
      row.identity !== null &&
      (typeof row.identity !== "string" || !/^\d+$/.test(row.identity))
    ) {
      errors.push(`${label} ${row.route} has an invalid identity`);
    }
    if (row.demo !== null && (typeof row.demo !== "string" || !/^https:\/\//.test(row.demo))) {
      errors.push(`${label} ${row.route} has an invalid demo URL`);
    }
    if (seen.has(row.route)) errors.push(`${label} has duplicate route ${row.route}`);
    if (previous && previous >= row.route) {
      errors.push(`${label} is not sorted by route at ${row.route}`);
    }
    seen.add(row.route);
    previous = row.route;
  }
  return errors;
}

function newlyReviewedMigration(migrations, oldMigrations, id, action, from, to) {
  return migrations.some((m) =>
    m.id === id && m.action === action && m.from === from && m.to === to &&
    typeof m.reason === "string" && m.reason.trim() &&
    typeof m.evidence === "string" && m.evidence.trim() &&
    typeof m.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.date) &&
    !oldMigrations.some((old) =>
      old.id === id && old.action === action && old.from === from && old.to === to
    )
  );
}

// `priorLedger: null` is permitted ONLY on the first rollout (the baseline ref has no ledger).
// Subsequent runs compare the old ledger from the baseline commit, never a manifest re-extracted
// by the current code. This makes an extractor-only change observable after it is committed too.
export function evaluateBindingLedger(
  { current, ledger, priorLedger, migrations, priorMigrations = [] },
) {
  const errors = [
    ...validateRows(ledger, BINDING_LEDGER),
    ...(priorLedger === null ? [] : validateRows(priorLedger, `baseline ${BINDING_LEDGER}`)),
  ];
  if (errors.length) return errors;
  const currentByRoute = new Map(current.map((entry) => [entry.route, entry]));
  const ledgerByRoute = new Map(ledger.map((entry) => [entry.route, entry]));
  if (currentByRoute.size !== current.length) errors.push("current manifest has duplicate routes");
  for (const entry of current) {
    const recorded = ledgerByRoute.get(entry.route);
    if (!recorded) {
      errors.push(
        `${BINDING_LEDGER} missing published route ${entry.route}; run deno task refresh-bindings`,
      );
      continue;
    }
    for (const field of ["identity", "demo"]) {
      if (recorded[field] !== entry[field]) {
        errors.push(
          `${BINDING_LEDGER} stale ${entry.route} ${field}: ledger ${
            JSON.stringify(recorded[field])
          } -> ` +
            `derived ${JSON.stringify(entry[field])}; run deno task refresh-bindings`,
        );
      }
    }
  }
  for (const recorded of ledger) {
    if (!currentByRoute.has(recorded.route)) {
      errors.push(
        `${BINDING_LEDGER} has non-published route ${recorded.route}; run deno task refresh-bindings`,
      );
    }
  }
  if (priorLedger !== null) {
    const priorByRoute = new Map(priorLedger.map((entry) => [entry.route, entry]));
    for (const recorded of ledger) {
      const old = priorByRoute.get(recorded.route);
      if (!old) continue; // Additive route: its new ledger entry needs no migration.
      const id = recorded.route.slice(1, -1);
      for (const [field, action] of [["identity", "identity-change"], ["demo", "demo-change"]]) {
        if (old[field] === recorded[field]) continue;
        if (
          !newlyReviewedMigration(
            migrations,
            priorMigrations,
            id,
            action,
            old[field],
            recorded[field],
          )
        ) {
          errors.push(
            `${recorded.route} ${field} binding changed ${JSON.stringify(old[field])} -> ` +
              `${JSON.stringify(recorded[field])} without a NEW exact ${action} migration ` +
              `(from/to/reason/evidence/date)`,
          );
        }
      }
    }
  }
  return errors;
}
