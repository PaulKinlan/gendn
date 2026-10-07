// gendn-vt28: exercise the REAL validate-artifacts CLI against colocated page/suite pairs.
// suiteHash covers assertions only; changing suite identity alone must still fail this gate.
import { suiteHash } from "./lib/artifacts.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const VALIDATOR = `${REPO}/scripts/validate-artifacts.mjs`;
const SCHEMAS = [
  "conformance.schema.json",
  "questions.schema.json",
  "goals.schema.json",
  "responsive-support.schema.json",
  "reference-contract.schema.json",
];
const ALPHA = "v900/alpha";
const BETA = "v901/beta";
const ALPHA_ID = "5637601087193088";
const BETA_ID = "5111042975465472";
const tmp = await Deno.makeTempDir({ prefix: "vt28-suite-metadata-" });
let failures = 0;
function assert(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${!ok && detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures++;
}
function html(identity, extra = "") {
  return `<html><body><h1>Reference</h1><a href="https://chromestatus.com/feature/${identity}">ChromeStatus</a>${extra}</body></html>`;
}
async function suite(id, identity) {
  const assertions = [{
    id: "route-resolves",
    category: "route",
    describe: "The stable route responds successfully.",
    kind: "http-status",
    test: `/${id}/`,
    expect: 200,
    deviceClass: "both",
  }];
  return {
    schemaVersion: 1,
    id,
    route: `/${id}/`,
    identity,
    milestone: Number(id.match(/^v(\d+)/)[1]),
    status: "built",
    demo: null,
    cpsFeature: null,
    immutable: true,
    suiteHash: await suiteHash(assertions),
    generatedAt: "2026-10-07T00:00:00Z",
    author: "vt28 fixture",
    assertions,
  };
}
async function putSuite(id, value) {
  await Deno.writeTextFile(`${tmp}/${id}/conformance.json`, JSON.stringify(value, null, 2));
}
async function gate() {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-run", VALIDATOR],
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
  for (const id of [ALPHA, BETA]) await Deno.mkdir(`${tmp}/${id}`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/${ALPHA}/index.html`, html(ALPHA_ID));
  await Deno.writeTextFile(`${tmp}/${BETA}/index.html`, html(BETA_ID));
  const original = await suite(ALPHA, ALPHA_ID);
  const second = await suite(BETA, BETA_ID);
  await putSuite(ALPHA, original);
  await putSuite(BETA, second);
  let r = await gate();
  assert(
    "matching physical page/suite pairs pass the real validator",
    r.code === 0,
    r.text.slice(-220),
  );

  await putSuite(ALPHA, { ...original, identity: BETA_ID });
  r = await gate();
  assert(
    "suite-only identity repoint fails even with unchanged assertions and suiteHash",
    r.code === 1 && r.text.includes(`${ALPHA}/conformance.json: identity`) &&
      r.text.includes(ALPHA_ID) && r.text.includes(BETA_ID),
    r.text.slice(-320),
  );

  await putSuite(ALPHA, { ...original, route: `/${BETA}/` });
  r = await gate();
  assert(
    "suite-only route repoint fails",
    r.code === 1 && r.text.includes("conformance.json: route"),
    r.text.slice(-240),
  );

  // BETA exists, so the old `pageIds.has(s.id)` orphan test alone would accept this lie.
  await putSuite(ALPHA, { ...original, id: BETA });
  r = await gate();
  assert(
    "suite ID claiming another published page fails its PHYSICAL directory binding",
    r.code === 1 && r.text.includes(`${ALPHA}/conformance.json: id`) &&
      !r.text.includes("id maps to no published page"),
    r.text.slice(-300),
  );

  await putSuite(ALPHA, { ...original, milestone: 901 });
  r = await gate();
  assert(
    "suite-only milestone repoint fails",
    r.code === 1 && r.text.includes("conformance.json: milestone"),
    r.text.slice(-240),
  );
  await putSuite(ALPHA, original);

  await Deno.writeTextFile(`${tmp}/${ALPHA}/index.html`, html(BETA_ID));
  r = await gate();
  assert(
    "page-only feature identity edit also fails against its suite",
    r.code === 1 && r.text.includes("conformance.json: identity"),
    r.text.slice(-240),
  );
  await Deno.writeTextFile(
    `${tmp}/${ALPHA}/index.html`,
    "<html><body><h1>Reference</h1></body></html>",
  );
  r = await gate();
  assert(
    "a page missing its feature identity fails even when the suite still claims one",
    r.code === 1 && r.text.includes("has no ChromeStatus feature identity"),
    r.text.slice(-240),
  );

  await Deno.writeTextFile(
    `${tmp}/${ALPHA}/index.html`,
    html(ALPHA_ID, "<p>Unrelated prose edit.</p>"),
  );
  r = await gate();
  assert("page-only nonidentity prose edit stays green", r.code === 0, r.text.slice(-200));

  // A page-only added demo was previously just a report-only note. Its suite now must be
  // updated too, without rehashing or weakening any frozen assertions.
  const demo = "https://chrome-platform-showcase.paulkinlan-ea.deno.net/v900/alpha/";
  await Deno.writeTextFile(
    `${tmp}/${ALPHA}/index.html`,
    html(ALPHA_ID, `<a href="${demo}">Demo</a>`),
  );
  await putSuite(ALPHA, { ...original, status: "stub" });
  r = await gate();
  assert(
    "page-only new showcase demo fails the suite demo binding (status drift remains report-only)",
    r.code === 1 && r.text.includes("conformance.json: demo") &&
      r.text.includes("cpsFeature.route"),
    r.text.slice(-460),
  );
  await putSuite(ALPHA, { ...original, status: "stub", demo });
  r = await gate();
  assert(
    "demo metadata alone is insufficient when the CPS route still claims no reference",
    r.code === 1 && r.text.includes("cpsFeature.route"),
    r.text.slice(-360),
  );
  const reconciled = {
    ...original,
    status: "stub",
    demo,
    cpsFeature: {
      host: "chrome-platform-showcase.paulkinlan-ea.deno.net",
      route: "/v900/alpha/",
      conformanceRoute: "/v900/alpha/conformance",
      note: "The feature-level CPS suite governs only its listed assertions.",
    },
  };
  await putSuite(ALPHA, reconciled);
  r = await gate();
  assert(
    "reconciled demo/CPS metadata passes; historical stub->built status stays report-only",
    r.code === 0 &&
      r.text.includes("1 historical status difference(s) (report-only) / 0 demo mismatch(es)"),
    r.text.slice(-460),
  );
  await putSuite(ALPHA, {
    ...reconciled,
    demo: `https://chrome-platform-showcase.paulkinlan-ea.deno.net/v901/beta/`,
  });
  r = await gate();
  assert(
    "suite-only demo repoint to another feature fails even when assertions/hash remain unchanged",
    r.code === 1 && r.text.includes("conformance.json: demo"),
    r.text.slice(-360),
  );

  // A moved page/suite pair is consistent at the destination. Alias validity is checked by
  // check-routes, not this metadata binding.
  await Deno.writeTextFile(`${tmp}/${ALPHA}/index.html`, html(ALPHA_ID));
  await putSuite(ALPHA, original);
  await Deno.rename(`${tmp}/${ALPHA}`, `${tmp}/v900/gamma`);
  const moved = "v900/gamma";
  await putSuite(moved, { ...original, id: moved, route: `/${moved}/` });
  r = await gate();
  assert(
    "a consistent moved page/suite pair passes without blanket migration exemptions",
    r.code === 0,
    r.text.slice(-220),
  );

  const exceptionId = "v150/disable-svg-filters-on-plugins-and-iframes";
  const exceptionDemo =
    `https://chrome-platform-showcase.paulkinlan-ea.deno.net/${exceptionId}/filter-comparison/`;
  await Deno.mkdir(`${tmp}/${exceptionId}`, { recursive: true });
  await Deno.writeTextFile(
    `${tmp}/${exceptionId}/index.html`,
    html(ALPHA_ID, `<a href="${exceptionDemo}">Concept demo</a>`),
  );
  const exceptionSuite = {
    ...await suite(exceptionId, ALPHA_ID),
    demo: exceptionDemo,
    cpsFeature: {
      host: "chrome-platform-showcase.paulkinlan-ea.deno.net",
      route: `/${exceptionId}/`,
      conformanceRoute: `/${exceptionId}/conformance`,
      note: "Feature-level conformance differs from the concept demo.",
    },
  };
  await putSuite(exceptionId, exceptionSuite);
  r = await gate();
  assert(
    "the exact documented CPS feature-root vs concept-demo exception stays green",
    r.code === 0 && r.text.includes("1 pinned CPS route exception(s)"),
    r.text.slice(-360),
  );
  await putSuite(exceptionId, {
    ...exceptionSuite,
    cpsFeature: {
      ...exceptionSuite.cpsFeature,
      conformanceRoute: `/${exceptionId}/wrong-contract`,
    },
  });
  r = await gate();
  assert(
    "changing the exception's conformance target fails instead of broad-whitelisting its ID",
    r.code === 1 && r.text.includes("without a documented exception"),
    r.text.slice(-360),
  );
} finally {
  await Deno.remove(tmp, { recursive: true });
}

// gendn-ip0z: staged-then-reverted edit (git status MM) must not escape validate-artifacts
{
  const scratch = await Deno.makeTempDir({ prefix: "ip0z-suite-metadata-" });
  const g = async (...args) => {
    const c = new Deno.Command("git", { args, cwd: scratch, stdout: "piped", stderr: "piped" });
    const o = await c.output();
    if (!o.success) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(o.stderr)}`);
    }
    return new TextDecoder().decode(o.stdout);
  };
  const runValidator = async () => {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", "--allow-run", VALIDATOR],
      cwd: scratch,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    return { code, text: new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr) };
  };

  try {
    await Deno.mkdir(`${scratch}/schema`);
    for (const name of SCHEMAS) {
      await Deno.copyFile(`${REPO}/schema/${name}`, `${scratch}/schema/${name}`);
    }
    await Deno.mkdir(`${scratch}/${ALPHA}`, { recursive: true });
    await Deno.writeTextFile(`${scratch}/${ALPHA}/index.html`, html(ALPHA_ID));
    const baseSuite = await suite(ALPHA, ALPHA_ID);
    await Deno.writeTextFile(
      `${scratch}/${ALPHA}/conformance.json`,
      JSON.stringify(baseSuite, null, 2),
    );

    await g("init", "-q", "-b", "main");
    await g("config", "user.email", "ip0z@example.test");
    await g("config", "user.name", "ip0z");
    await g("add", ".");
    await g("commit", "-qm", "baseline");
    await g("update-ref", "refs/remotes/origin/main", "HEAD");

    // Case 1: Clean baseline
    let r = await runValidator();
    assert("ip0z validate-artifacts Case 1 (clean): validator passes", r.code === 0, r.text);

    // Case 2: Uncommitted edit to conformance.json
    const mutatedSuite = { ...baseSuite, identity: BETA_ID };
    await Deno.writeTextFile(
      `${scratch}/${ALPHA}/conformance.json`,
      JSON.stringify(mutatedSuite, null, 2),
    );
    r = await runValidator();
    assert(
      "ip0z validate-artifacts Case 2 (uncommitted): identity difference fails",
      r.code === 1 && r.text.includes("identity"),
      r.text,
    );

    // Case 3: Staged edit
    await g("add", `${ALPHA}/conformance.json`);
    r = await runValidator();
    assert(
      "ip0z validate-artifacts Case 3 (staged): staged identity difference fails",
      r.code === 1 && r.text.includes("identity"),
      r.text,
    );

    // Case 4: Staged-then-reverted (git status shows MM)
    // Worktree conformance.json restored to base: disk matches index.html, but index has BETA_ID.
    await Deno.writeTextFile(
      `${scratch}/${ALPHA}/conformance.json`,
      JSON.stringify(baseSuite, null, 2),
    );
    const statusOut = (await g("status", "--short")).trim();
    assert(
      "ip0z validate-artifacts Case 4: git status shows MM for staged-then-reverted conformance.json",
      statusOut.includes("MM") && statusOut.includes(ALPHA),
    );
    r = await runValidator();
    assert(
      "ip0z validate-artifacts Case 4 (staged-then-reverted): validator reads staged index content and fails (escape closed)",
      r.code === 1 && r.text.includes("identity"),
      r.text,
    );

    // Case 5: Committed edit
    await Deno.writeTextFile(
      `${scratch}/${ALPHA}/conformance.json`,
      JSON.stringify(mutatedSuite, null, 2),
    );
    await g("commit", "-am", "commit mutated suite");
    r = await runValidator();
    assert(
      "ip0z validate-artifacts Case 5 (committed): committed mutation fails",
      r.code === 1 && r.text.includes("identity"),
      r.text,
    );

    // Case 6: Resolved
    await Deno.writeTextFile(
      `${scratch}/${ALPHA}/conformance.json`,
      JSON.stringify(baseSuite, null, 2),
    );
    await g("commit", "-am", "resolve suite");
    r = await runValidator();
    assert(
      "ip0z validate-artifacts Case 6 (resolved): resolved suite passes",
      r.code === 0,
      r.text,
    );
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}
if (failures) {
  console.error(`suite-metadata fixture: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log("suite-metadata fixture: all assertions passed");
