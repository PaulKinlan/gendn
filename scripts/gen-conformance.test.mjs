// Chrome-free CLI contract: malformed/zero-match page selectors cannot produce a green no-op.
import assert from "node:assert/strict";
const assertEquals = assert.equal;
const assertMatch = assert.match;

const source = await Deno.readTextFile("scripts/gen-conformance.mjs");
const guard = `  if (selection.error) {
    console.error(\`gen-conformance: \${selection.error}\`);
    Deno.exit(1);
  }`;
assert(source.includes(guard), "sabotage anchor must match the actual preflight guard");

async function run(script, args) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", script, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}

const script = "scripts/gen-conformance.mjs";
let assertions = 0;
for (
  const args of [
    ["--dry-run", "--page", "v152/window-shape-apix"],
    ["--page", "--dry-run"],
    ["--dry-run", "--page", "v149/webmcp/index.html"],
  ]
) {
  const result = await run(script, args);
  assertEquals(result.code, 1, `${args.join(" ")} must fail before doing work`);
  assertMatch(result.err, /--page .*published root route|--page .*matched zero/);
  assertions += 2;
  if (args[1] !== "--dry-run") {
    assertMatch(result.err, /Nearest published roots: v\d+\//);
    assertions++;
  }
  assertEquals(result.out, "", "no success summary, browser, or report after rejected selector");
  assertions++;
}
const valid = await run(script, ["--dry-run", "--page", "v149/webmcp"]);
assertEquals(valid.code, 0, valid.err);
assertMatch(valid.out, /1 pages considered/);
assertEquals(valid.err, "");
assertions += 3;

// Mutation proof: neutralizing only the refusal branch restores the historical false GREEN.
// The assertion intentionally fails for the sabotage, so the fixture proves the guard matters.
const sabotaged = await Deno.makeTempFile({
  dir: "scripts",
  prefix: ".gen-conformance-sabotage-",
  suffix: ".mjs",
});
let sabotageRed = 0;
try {
  await Deno.writeTextFile(
    sabotaged,
    source.replace(guard, "  // sabotage: do not refuse empty selection"),
  );
  for (const args of [["--dry-run", "--page", "v152/window-shape-apix"], ["--page", "--dry-run"]]) {
    const result = await run(sabotaged, args);
    const expectedRefusal = result.code !== 0;
    assertEquals(expectedRefusal, false, "guard removal must flip refusal assertion RED");
    assertMatch(result.out, /0 pages considered/);
    sabotageRed++;
  }
} finally {
  await Deno.remove(sabotaged);
}
console.log(
  `gen-conformance selector fixture: ${assertions} assertions passed; sabotage: ${sabotageRed} refusal assertions RED`,
);
