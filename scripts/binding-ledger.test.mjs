// A real check-routes subprocess in a tiny /tmp Git repo: both baseline and current manifests
// re-use the same mutated extractor. Only the independent committed ledger can catch the shift.
import { BINDING_LEDGER, evaluateBindingLedger } from "./lib/binding-ledger.mjs";

let passed = 0;
let failed = 0;
function assert(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.error(`FAIL: ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}
const base = [{
  route: "/v900/probe/",
  identity: "222",
  demo: "https://chrome-platform-showcase.paulkinlan-ea.deno.net/v900/probe/first/",
}];
const current = base.map((b) => ({ ...b }));
const params = { current, ledger: base, priorLedger: base, migrations: [] };
assert("clean one-route ledger passes", evaluateBindingLedger(params).length === 0);
assert(
  "a missing ledger entry fails closed",
  evaluateBindingLedger({ ...params, ledger: [] }).some((x) =>
    x.includes("missing published route")
  ),
);
assert(
  "an extra ledger entry fails closed",
  evaluateBindingLedger({ ...params, ledger: [...base, { ...base[0], route: "/v901/extra/" }] })
    .some((x) => x.includes("non-published route")),
);
assert(
  "a duplicate ledger entry fails closed",
  evaluateBindingLedger({ ...params, ledger: [...base, base[0]] }).some((x) =>
    x.includes("duplicate route")
  ),
);
assert(
  "a stale identity entry fails closed",
  evaluateBindingLedger({ ...params, ledger: [{ ...base[0], identity: "111" }] }).some((x) =>
    x.includes("stale /v900/probe/ identity")
  ),
);
assert(
  "a stale demo entry fails closed independently",
  evaluateBindingLedger({ ...params, ledger: [{ ...base[0], demo: null }] }).some((x) =>
    x.includes("stale /v900/probe/ demo")
  ),
);
assert(
  "additive route needs a matching ledger entry but no migration",
  evaluateBindingLedger({
    ...params,
    current: [...current, { route: "/v901/new/", identity: "333", demo: null }],
    ledger: [...base, { route: "/v901/new/", identity: "333", demo: null }],
  }).length === 0,
);
const changed = [{ ...base[0], identity: "111" }];
const migration = {
  id: "v900/probe",
  action: "identity-change",
  from: "222",
  to: "111",
  reason: "Reviewed extractor correction",
  evidence: "Real page and source confirmed",
  date: "2026-10-07",
};
assert(
  "exact new identity-change migration passes",
  evaluateBindingLedger({ ...params, ledger: changed, current: changed, migrations: [migration] })
    .length === 0,
);
assert(
  "wrong from/to identity migration does not authorize binding",
  evaluateBindingLedger({
    ...params,
    ledger: changed,
    current: changed,
    migrations: [{ ...migration, from: "999" }],
  }).some((x) => x.includes("NEW exact identity-change")),
);
assert(
  "pre-existing migration cannot silently authorize a new binding diff",
  evaluateBindingLedger({
    ...params,
    ledger: changed,
    current: changed,
    migrations: [migration],
    priorMigrations: [migration],
  }).some((x) => x.includes("NEW exact identity-change")),
);
assert(
  "reordered/rewritten historical migration cannot masquerade as new authorization",
  evaluateBindingLedger({
    ...params,
    ledger: changed,
    current: changed,
    migrations: [{ ...migration, reason: "Different prose, same historical binding pair" }],
    priorMigrations: [migration],
  }).some((x) => x.includes("NEW exact identity-change")),
);
const demoChanged = [{
  ...base[0],
  demo: "https://chrome-platform-showcase.paulkinlan-ea.deno.net/v900/probe/second/",
}];
assert(
  "identity-change cannot authorize demo-only rebinding",
  evaluateBindingLedger({
    ...params,
    ledger: demoChanged,
    current: demoChanged,
    migrations: [migration],
  }).some((x) => x.includes("NEW exact demo-change")),
);
assert(
  "exact new demo-change migration passes",
  evaluateBindingLedger({
    ...params,
    ledger: demoChanged,
    current: demoChanged,
    migrations: [{
      ...migration,
      action: "demo-change",
      from: base[0].demo,
      to: demoChanged[0].demo,
    }],
  }).length === 0,
);

const temp = await Deno.makeTempDir({ prefix: "s8xd-binding-gate-" });
const enc = new TextDecoder();
const source = new URL(".", import.meta.url);
const page = "v900/probe/index.html";
const pageHtml =
  `<html><p><a href="https://chromestatus.com/feature/111">Related</a></p><table><tr><th>ChromeStatus</th><td><a href="https://chromestatus.com/feature/222">Declared</a></td></tr></table><a href="${
    base[0].demo
  }">first</a><a href="https://chrome-platform-showcase.paulkinlan-ea.deno.net/v900/probe/second/">second</a></html>`;
async function command(bin, args) {
  const out = await new Deno.Command(bin, { args, cwd: temp, stdout: "piped", stderr: "piped" })
    .output();
  return { code: out.code, text: enc.decode(out.stdout) + enc.decode(out.stderr) };
}
async function git(...args) {
  const result = await command("git", args);
  if (result.code) throw new Error(`git ${args.join(" ")} failed: ${result.text}`);
}
async function gate() {
  return await command(Deno.execPath(), [
    "run",
    "--allow-read",
    "--allow-run",
    "scripts/check-routes.mjs",
  ]);
}
async function refresh() {
  const r = await command(Deno.execPath(), [
    "run",
    "--allow-read",
    "--allow-run",
    `--allow-write=${BINDING_LEDGER}`,
    "scripts/refresh-bindings.mjs",
  ]);
  if (r.code) throw new Error(`refresh failed: ${r.text}`);
}
try {
  for (
    const path of [
      "check-routes.mjs",
      "route-manifest.mjs",
      "refresh-bindings.mjs",
      "lib/artifacts.mjs",
      "lib/bounded-git.mjs",
      "lib/judged-content.mjs",
      "lib/binding-ledger.mjs",
    ]
  ) {
    await Deno.mkdir(`${temp}/scripts/${path.split("/").slice(0, -1).join("/")}`, {
      recursive: true,
    });
    const target = `${temp}/scripts/${path}`;
    let contents = await Deno.readTextFile(new URL(path, source));
    if (Deno.args.includes("--sabotage") && path === "lib/binding-ledger.mjs") {
      contents = contents.replace(
        "  const errors = [\n",
        "  return []; // deliberate /tmp-only sabotage of the ratchet\n  const errors = [\n",
      );
    }
    await Deno.writeTextFile(target, contents);
  }
  await Deno.mkdir(`${temp}/v900/probe`, { recursive: true });
  await Deno.writeTextFile(`${temp}/${page}`, pageHtml);
  await Deno.writeTextFile(`${temp}/${BINDING_LEDGER}`, JSON.stringify(base, null, 2) + "\n");
  await Deno.writeTextFile(`${temp}/migrations.json`, "[]\n");
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "binding-fixture");
  await git("config", "user.email", "binding-fixture@example.test");
  await git("add", "scripts", page, "migrations.json");
  await git("commit", "-qm", "baseline before first ledger");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  const bootstrap = await gate();
  assert(
    "REAL gate: first rollout accepts the correct ledger with unchanged extractor",
    bootstrap.code === 0,
    bootstrap.text,
  );

  const artifactPath = `${temp}/scripts/lib/artifacts.mjs`;
  const original = await Deno.readTextFile(artifactPath);
  const identityMutant = original.replace(
    "  const declaredMatch = html.match(DECLARED_FEATURE_ID_RE);\n  if (declaredMatch) return declaredMatch[1];\n  const fallbackMatch = html.match(FEATURE_ID_RE);\n  return fallbackMatch ? fallbackMatch[1] : null;",
    "  const fallbackMatch = html.match(FEATURE_ID_RE);\n  if (fallbackMatch) return fallbackMatch[1];\n  const declaredMatch = html.match(DECLARED_FEATURE_ID_RE);\n  return declaredMatch ? declaredMatch[1] : null;",
  );
  if (identityMutant === original) throw new Error("fixture identity extractor mutation failed");
  await Deno.writeTextFile(artifactPath, identityMutant);
  await refresh();
  const bootstrapEscape = await gate();
  assert(
    "REAL gate: initial rollout rejects a simultaneously changed extractor even after ledger refresh",
    bootstrapEscape.code !== 0 &&
      /bootstrap cannot change extractor sources/.test(bootstrapEscape.text) &&
      !/binding changed .*without a NEW exact/.test(bootstrapEscape.text),
    bootstrapEscape.text,
  );
  await Deno.writeTextFile(artifactPath, original);
  await Deno.writeTextFile(`${temp}/${BINDING_LEDGER}`, JSON.stringify(base, null, 2) + "\n");
  await git("add", BINDING_LEDGER);
  await git("commit", "-qm", "pinned binding ledger");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  const clean = await gate();
  assert("real gate: clean binding passes", clean.code === 0, clean.text);

  await Deno.writeTextFile(artifactPath, identityMutant);
  const idStale = await gate();
  assert(
    "REAL gate: extractor-only identity flip fails naming route + old/new while baseline re-extracts identically",
    idStale.code !== 0 && /stale \/v900\/probe\/ identity/.test(idStale.text) &&
      /222/.test(idStale.text) && /111/.test(idStale.text),
    idStale.text,
  );
  await refresh();
  const idWithoutMigration = await gate();
  assert(
    "REAL gate: updated ledger without identity migration fails",
    idWithoutMigration.code !== 0 && /NEW exact identity-change/.test(idWithoutMigration.text),
    idWithoutMigration.text,
  );
  await Deno.writeTextFile(`${temp}/migrations.json`, JSON.stringify([migration]));
  const idWithMigration = await gate();
  assert(
    "REAL gate: matching NEW exact identity migration passes",
    idWithMigration.code === 0 &&
      /identity binding change via migration/.test(idWithMigration.text),
    idWithMigration.text,
  );

  // Revert only the /tmp probe. This second mutation changes demo but NOT identity: no identity-only shortcut.
  await git("checkout", "--", "scripts/lib/artifacts.mjs", BINDING_LEDGER, "migrations.json");
  const demoMutant = original.replace(
    "      demo = `https://${SHOWCASE_HOST}${routePath}`;\n      break;",
    "      demo = `https://${SHOWCASE_HOST}${routePath}`;\n      continue;",
  );
  if (demoMutant === original) throw new Error("fixture demo extractor mutation failed");
  await Deno.writeTextFile(artifactPath, demoMutant);
  const demoStale = await gate();
  assert(
    "REAL gate: demo-only extractor flip fails naming route + both URLs",
    demoStale.code !== 0 && /stale \/v900\/probe\/ demo/.test(demoStale.text) &&
      /first\//.test(demoStale.text) && /second\//.test(demoStale.text) &&
      !/stale \/v900\/probe\/ identity/.test(demoStale.text),
    demoStale.text,
  );
  await refresh();
  const demoWithoutMigration = await gate();
  assert(
    "REAL gate: updated demo ledger without demo migration fails",
    demoWithoutMigration.code !== 0 && /NEW exact demo-change/.test(demoWithoutMigration.text),
    demoWithoutMigration.text,
  );
  const demoMigration = {
    ...migration,
    action: "demo-change",
    from: base[0].demo,
    to: demoChanged[0].demo,
  };
  await Deno.writeTextFile(`${temp}/migrations.json`, JSON.stringify([demoMigration]));
  const demoWithMigration = await gate();
  assert(
    "REAL gate: matching NEW exact demo migration passes",
    demoWithMigration.code === 0 &&
      /demo binding change via migration/.test(demoWithMigration.text),
    demoWithMigration.text,
  );
} finally {
  await Deno.remove(temp, { recursive: true });
}
console.log(`binding ledger fixture: ${passed} passed, ${failed} failed`);
if (failed) Deno.exit(1);
