// @fixture-permissions --allow-read --allow-write --allow-run
// gendn-8krx: a support-only edit must fail the REAL validator when an unsupported claim
// lacks class-specific evidence. The minimal schema engine ignores if/then conditionals.
import { loadSchema, validate } from "./lib/artifacts.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const VALIDATOR = `${REPO}/scripts/validate-artifacts.mjs`;
const SCHEMAS = [
  "conformance.schema.json",
  "questions.schema.json",
  "goals.schema.json",
  "responsive-support.schema.json",
  "reference-contract.schema.json",
];
const ROUTE = "/v900/support/";
const tmp = await Deno.makeTempDir({ prefix: "8krx-support-" });
let failures = 0;
function assert(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${!ok && detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures++;
}
async function gate(record) {
  await Deno.writeTextFile(
    `${tmp}/responsive-support.json`,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-10-07",
      routes: { [ROUTE]: record },
    }),
  );
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", VALIDATOR],
    cwd: tmp,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return { code, text: new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr) };
}

try {
  await Deno.mkdir(`${tmp}/schema`);
  for (const name of SCHEMAS) {
    await Deno.copyFile(`${REPO}/schema/${name}`, `${tmp}/schema/${name}`);
  }
  await Deno.mkdir(`${tmp}/v900/support`, { recursive: true });
  await Deno.writeTextFile(
    `${tmp}/v900/support/index.html`,
    '<html><body><h1>Reference</h1><a href="https://chromestatus.com/feature/5637601087193088">ChromeStatus</a></body></html>',
  );
  const ordinary = { desktop: "ok", mobile: "ok", method: "agent-matrix" };
  const evidence =
    "Mobile Chrome 150 cannot expose this API on this device class; manual capability check recorded.";
  const honest = {
    desktop: "ok",
    mobile: "unsupported",
    unsupportedClass: "mobile",
    evidence,
    method: "agent-matrix",
  };
  let r = await gate(ordinary);
  assert("ordinary supported record passes the real validator", r.code === 0, r.text.slice(-250));

  // The old gap: schema shape accepts the new state, but it has no evidence or class claim.
  const bare = { ...ordinary, mobile: "unsupported" };
  const schema = await loadSchema("responsive-support.schema.json", tmp);
  const schemaAlone = validate(schema, {
    schemaVersion: 1,
    updatedAt: "2026-10-07",
    routes: { [ROUTE]: bare },
  });
  assert("structural schema alone does NOT enforce unsupported evidence", schemaAlone.length === 0);
  r = await gate(bare);
  assert(
    "support-only ok -> unsupported without class/evidence FAILS the real validator",
    r.code === 1 && r.text.includes("unsupportedClass") && r.text.includes("evidence") &&
      r.text.includes(ROUTE),
    r.text.slice(-500),
  );

  r = await gate(honest);
  assert("correct class plus substantive evidence passes", r.code === 0, r.text.slice(-260));

  r = await gate({ ...honest, evidence: "   \n  " });
  assert(
    "whitespace-only evidence fails",
    r.code === 1 && r.text.includes("substantive evidence"),
    r.text.slice(-350),
  );
  r = await gate({ ...honest, evidence: "not supported" });
  assert(
    "non-substantive short evidence fails",
    r.code === 1 && r.text.includes("at least 20"),
    r.text.slice(-350),
  );
  r = await gate({ ...honest, unsupportedClass: "desktop" });
  assert(
    "wrong unsupportedClass fails",
    r.code === 1 && r.text.includes('unsupportedClass "mobile"'),
    r.text.slice(-350),
  );
  r = await gate({ ...honest, unsupportedClass: undefined });
  assert(
    "missing unsupportedClass fails even with evidence",
    r.code === 1 && r.text.includes("unsupportedClass"),
    r.text.slice(-350),
  );
  r = await gate({ ...honest, desktop: "unsupported" });
  assert(
    "two unsupported classes cannot share one class-specific evidence field",
    r.code === 1 && r.text.includes("both classes"),
    r.text.slice(-350),
  );

  r = await gate({ ...honest, method: "auto-scan" });
  assert(
    "automated overflow scan cannot substantiate an unsupported capability",
    r.code === 1 && r.text.includes("auto-scan cannot"),
    r.text.slice(-350),
  );
  r = await gate({ ...honest, method: "manual review: auto-scan showed expected clipping" });
  assert(
    "method prose merely mentioning auto-scan is not mistaken for auto-scan",
    r.code === 0,
    r.text.slice(-260),
  );
  r = await gate({ desktop: "ok", mobile: "needs-review", method: "auto-scan" });
  assert("normal needs-review auto-scan record remains valid", r.code === 0, r.text.slice(-260));
  r = await gate({ desktop: "ok", mobile: "ok", method: "auto-scan" });
  assert(
    "legacy auto-scan + ok record is outside this unsupported-only rule",
    r.code === 0,
    r.text.slice(-260),
  );
} finally {
  await Deno.remove(tmp, { recursive: true });
}
if (failures) {
  console.error(`support-record fixture: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log("support-record fixture: all assertions passed");
