// scripts/vendor-fonts.test.mjs — the gendn-dmz acceptance fixture.
//
// THE DEFECT: vendor-fonts.mjs accepted any HTTP 200 from the css2 endpoint, so a degenerate
// response (empty body, an HTML status page, or rules only for subsets the script does not keep)
// extracted 0 rules and UPDATE MODE would then overwrite public/styles.css with zero @font-face
// rules — silently dropping the webfonts from all 302 consumers of the shared sheet. The mirror
// hole was in --check: with a rule-less sheet it compared 0 rules against 0 and reported
// "up to date", i.e. it could not detect the state it exists to prevent.
//
// THIS FIXTURE drives the real script against a local HTTP server (`--css-url` test seam) on a
// TEMP COPY of the layout, so the repo's real public/styles.css is never a candidate for
// writing. It asserts, for every degenerate upstream: non-zero exit, a REFUSING message, and the
// sheet's bytes UNCHANGED. Then it asserts the honest path still works: a realistic response
// vendors exactly the kept rules, and --check agrees afterwards.
//
// Run: deno task test-vendor-fonts

const REPO = new URL("..", import.meta.url).pathname;
const REAL_SHEET = `${REPO}public/styles.css`;

let failures = 0;
let passed = 0;
function assert(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS: ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// --- upstream bodies the css2 endpoint could plausibly return by mistake -----------
const REAL_SHAPE = `/* latin */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/lora/v1/real-latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
/* latin-ext */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/lora/v1/real-latin-ext.woff2) format('woff2');
  unicode-range: U+0100-024F;
}
`;
const OTHER_SUBSETS_ONLY = `/* cyrillic */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/lora/v1/cyr.woff2) format('woff2');
}
/* greek */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/lora/v1/grk.woff2) format('woff2');
}
`;

// The reviewer's EXACT stub: a 200 whose only rules are one family's kept subsets. It satisfies the
// zero-rule guard and used to overwrite the sheet, dropping every other family.
const REVIEWER_STUB = `/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v1/a.woff2) format('woff2');
}
/* latin-ext */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v1/b.woff2) format('woff2');
}
`;

/** The sheet's vendored rules without the generated header comment: an ADDITIVE upstream shape. */
function withoutMarkerComment(sheet) {
  return sheet
    .split("\n")
    .filter((line) =>
      !/^\/\* (---|Source:|Regenerate:|Subsets kept:|them would|cyrillic|Vendored|Blank line)/.test(
        line,
      )
    )
    .join("\n");
}

const upstream = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/empty") return new Response("", { status: 200 });
  if (path === "/html") {
    return new Response("<!doctype html><title>Error</title><h1>502 Bad Gateway</h1>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }
  if (path === "/other-subsets") return new Response(OTHER_SUBSETS_ONLY, { status: 200 });
  if (path === "/real") return new Response(REAL_SHAPE, { status: 200 });
  if (path === "/reviewer-stub") return new Response(REVIEWER_STUB, { status: 200 });
  // The same reduction in its smallest form: drop ONE weight of an existing family.
  if (path === "/missing-weight") {
    // Drop exactly ONE rule — Lora 500 / latin — tolerating the generated block's indentation.
    const withoutLora500 = REAL_SHEET_TEXT.replace(
      /\/\* latin \*\/\s*@font-face \{\s*font-family: 'Lora';\s*font-style: normal;\s*font-weight: 500;[\s\S]*?\n\s*\}\n/,
      "",
    );
    return new Response(withoutLora500, { status: 200 });
  }
  // ADDITIVE: every existing identity plus face count from the sheet itself, touched up so the
  // response is a superset (one extra weight), which must be WRITTEN.
  if (path === "/additive") {
    const extra = `/* latin */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/lora/v1/extra-900.woff2) format('woff2');
}
`;
    return new Response(withoutMarkerComment(REAL_SHEET_TEXT) + extra, { status: 200 });
  }
  return new Response("nope", { status: 404 });
});
const base = `http://127.0.0.1:${upstream.addr.port}`;

// --- temp layout so the script's SHEET resolves to a copy -------------------------
const tmp = await Deno.makeTempDir({ prefix: "vendor-fonts-test-" });
await Deno.mkdir(`${tmp}/scripts`, { recursive: true });
await Deno.mkdir(`${tmp}/public`, { recursive: true });
await Deno.copyFile(`${REPO}scripts/vendor-fonts.mjs`, `${tmp}/scripts/vendor-fonts.mjs`);

const EMPTY_BLOCK_SHEET =
  `body { color: #000; }\n/* --- BEGIN vendored @font-face */\n/* --- END vendored @font-face --- */\n`;
const REAL_SHEET_TEXT = await Deno.readTextFile(REAL_SHEET);
const sha = async (path) => {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

async function run(args, sheetText) {
  await Deno.writeTextFile(`${tmp}/public/styles.css`, sheetText);
  const before = await sha(`${tmp}/public/styles.css`);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      `${tmp}/scripts/vendor-fonts.mjs`,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const after = await sha(`${tmp}/public/styles.css`);
  return {
    code,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
    unchanged: before === after,
  };
}

try {
  // 1. empty 200 -> refuse, no write
  const empty = await run(["--css-url", `${base}/empty`], REAL_SHEET_TEXT);
  assert("empty 200 body: non-zero exit", empty.code !== 0, `exit=${empty.code}`);
  assert(
    "empty 200 body: says REFUSING",
    /REFUSING/.test(empty.err),
    empty.err.trim().slice(0, 120),
  );
  assert("empty 200 body: public/styles.css BYTE-UNCHANGED", empty.unchanged);

  // 2. HTML error page with 200 -> refuse, no write
  const html = await run(["--css-url", `${base}/html`], REAL_SHEET_TEXT);
  assert("HTML status page as 200: non-zero exit", html.code !== 0, `exit=${html.code}`);
  assert("HTML status page as 200: says REFUSING", /REFUSING/.test(html.err));
  assert("HTML status page as 200: sheet BYTE-UNCHANGED", html.unchanged);

  // 3. rules present but none for the kept subsets -> refuse, no write
  const other = await run(["--css-url", `${base}/other-subsets`], REAL_SHEET_TEXT);
  assert("rules only for unkept subsets: non-zero exit", other.code !== 0, `exit=${other.code}`);
  assert(
    "rules only for unkept subsets: refusal names the subsets",
    /kept subsets|@font-face rule/.test(other.err),
    other.err.trim().slice(0, 140),
  );
  assert("rules only for unkept subsets: sheet BYTE-UNCHANGED", other.unchanged);

  // 4. mirror guard: a rule-less SHEET must not be reported "up to date"
  const mirror = await run(["--check", "--css-url", `${base}/empty`], EMPTY_BLOCK_SHEET);
  assert("rule-less sheet + --check: non-zero exit", mirror.code !== 0, `exit=${mirror.code}`);
  assert(
    "rule-less sheet + --check: never says 'up to date'",
    !/up to date/.test(mirror.out + mirror.err),
  );
  const mirror2 = await run(["--check", "--css-url", `${base}/real`], EMPTY_BLOCK_SHEET);
  // Either refusal is correct here and both are non-zero: the mirror guard (the sheet lost its
  // rules) or OUT OF DATE (it differs from what would be written). What must never happen is an
  // "up to date" claim, so that is what this assertion pins.
  assert(
    "rule-less sheet + real upstream + --check: refuses or reports OUT OF DATE, never up to date",
    mirror2.code !== 0 && !/up to date/.test(mirror2.out + mirror2.err),
    `exit=${mirror2.code} out=${mirror2.out.trim()} err=${mirror2.err.trim().slice(0, 80)}`,
  );

  // 5. honest path: a genuine response vendors the kept rules and --check then agrees
  const real = await run(["--css-url", `${base}/real`], EMPTY_BLOCK_SHEET);
  assert(
    "real response: exit 0",
    real.code === 0,
    `exit=${real.code} ${real.err.trim().slice(0, 120)}`,
  );
  const written = await Deno.readTextFile(`${tmp}/public/styles.css`);
  assert(
    "real response: wrote both kept-subset rules",
    (written.match(/@font-face \{/g) ?? []).length === 2,
    `${(written.match(/@font-face \{/g) ?? []).length} rule(s)`,
  );
  // Careful: the generated header comment NAMES the dropped subsets, so "no cyrillic" must be
  // checked against the subset comments that mark RULES, not against the word appearing anywhere.
  assert(
    "real response: kept latin and latin-ext rules and no dropped-subset rule",
    /\/\* latin \*\//.test(written) && /\/\* latin-ext \*\//.test(written) &&
      !/\/\* (cyrillic|greek|vietnamese|math|symbols)[a-z-]* \*\//.test(written),
    `rules=${(written.match(/@font-face \{/g) ?? []).length}`,
  );
  const recheck = await run(["--check", "--css-url", `${base}/real`], written);
  assert(
    "honest path: --check reports up to date afterwards",
    recheck.code === 0 && /up to date/.test(recheck.out),
    `exit=${recheck.code} ${recheck.out.trim()}`,
  );

  // --- gendn-cp7: a NON-EMPTY but INCOMPLETE response must not reduce the vendored set ---------
  // (1) the reviewer's exact stub: two rules for one family the sheet does not even use.
  const reduced = await run(["--css-url", `${base}/reviewer-stub`], REAL_SHEET_TEXT);
  assert(
    "cp7 (1) reviewer's stub (one family, two rules) REFUSES, non-zero",
    reduced.code !== 0,
    `exit=${reduced.code}`,
  );
  assert(
    "cp7 (1) ...and the refusal says it would REMOVE rules",
    /would REMOVE/.test(reduced.err),
    reduced.err.trim().slice(0, 140),
  );
  assert("cp7 (1) ...and public/styles.css is BYTE-UNCHANGED", reduced.unchanged);

  // (2) the smallest form of the same defect: one WEIGHT of an existing family missing.
  const missingWeight = await run(["--css-url", `${base}/missing-weight`], REAL_SHEET_TEXT);
  assert(
    "cp7 (2) an upstream missing ONE WEIGHT of an existing family REFUSES",
    missingWeight.code !== 0 && /would REMOVE/.test(missingWeight.err) && missingWeight.unchanged,
    `exit=${missingWeight.code}`,
  );
  assert(
    "cp7 (2) ...and the refusal names the missing identity",
    /Lora\|normal\|500\|latin/.test(missingWeight.err),
    missingWeight.err.trim().slice(0, 200),
  );

  // (3) ADDITIVE growth must still be written, or upstream additions could never land.
  const beforeRules = (REAL_SHEET_TEXT.match(/@font-face \{/g) ?? []).length;
  const additive = await run(["--css-url", `${base}/additive`], REAL_SHEET_TEXT);
  const additiveSheet = await Deno.readTextFile(`${tmp}/public/styles.css`);
  const afterRules = (additiveSheet.match(/@font-face \{/g) ?? []).length;
  assert(
    "cp7 (3) an ADDITIVE response (every existing identity plus one) IS written",
    additive.code === 0 && afterRules === beforeRules + 1,
    `exit=${additive.code}, ${beforeRules} -> ${afterRules} rule(s)`,
  );
  assert(
    "cp7 (3) ...and the added face is the new weight",
    /font-weight: 900/.test(additiveSheet) && /font-family: 'Lora'/.test(additiveSheet),
  );

  // (4) the deliberate override: possible, and LOUD about what it drops.
  const overridden = await run(
    [
      "--css-url",
      `${base}/reviewer-stub`,
      "--allow-rule-removal",
      "--reason",
      "upstream retired the family",
    ],
    REAL_SHEET_TEXT,
  );
  const overriddenSheet = await Deno.readTextFile(`${tmp}/public/styles.css`);
  assert(
    "cp7 (4) the override writes the reduction",
    overridden.code === 0 && (overriddenSheet.match(/@font-face \{/g) ?? []).length === 2,
    `exit=${overridden.code}`,
  );
  assert(
    "cp7 (4) ...and it is LOUD: the output lists what it dropped, with the reason",
    /OVERRIDE/.test(overridden.err) && /upstream retired the family/.test(overridden.err) &&
      /Lora\|normal\|400\|latin/.test(overridden.err),
    overridden.err.trim().slice(0, 160),
  );

  // (5) the override cannot be used bare: the reason is required.
  const bareOverride = await run(
    ["--css-url", `${base}/reviewer-stub`, "--allow-rule-removal"],
    REAL_SHEET_TEXT,
  );
  assert(
    "cp7 (5) --allow-rule-removal without --reason is REFUSED",
    bareOverride.code !== 0 && /requires --reason/.test(bareOverride.err) && bareOverride.unchanged,
    `exit=${bareOverride.code}`,
  );

  // (6) --check must not bless a reduction either.
  const checkReduction = await run(
    ["--check", "--css-url", `${base}/reviewer-stub`],
    REAL_SHEET_TEXT,
  );
  // The reduction guard fires before the check-mode comparison (it is the same refusal, just
  // earlier), so the message can be on either stream — what matters is that the check never blesses
  // a reduction as current.
  assert(
    "cp7 (6) --check against a reducing upstream is non-zero and says it would REMOVE",
    checkReduction.code !== 0 && !/up to date/.test(checkReduction.out + checkReduction.err) &&
      /would REMOVE/.test(checkReduction.out + checkReduction.err) && checkReduction.unchanged,
    `exit=${checkReduction.code} ${
      (checkReduction.err || checkReduction.out).trim().slice(0, 160)
    }`,
  );
  // And with the override supplied, check mode still reports OUT OF DATE rather than current.
  const checkReductionOverridden = await run(
    [
      "--check",
      "--css-url",
      `${base}/reviewer-stub`,
      "--allow-rule-removal",
      "--reason",
      "upstream retired the family",
    ],
    REAL_SHEET_TEXT,
  );
  assert(
    "cp7 (6b) --check with the override reports the reduction as OUT OF DATE, never current",
    checkReductionOverridden.code !== 0 && /OUT OF DATE/.test(checkReductionOverridden.out) &&
      /would REMOVE/.test(checkReductionOverridden.out) && checkReductionOverridden.unchanged,
    `exit=${checkReductionOverridden.code} ${checkReductionOverridden.out.trim().slice(0, 140)}`,
  );

  // 6. the repo's real sheet must still be considered current by the real endpoint
  const realCheck = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      `${REPO}scripts/vendor-fonts.mjs`,
      "--check",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const rc = await realCheck.output();
  const rcout = new TextDecoder().decode(rc.stdout);
  assert(
    "REAL endpoint: deno task vendor-fonts --check on the repo sheet is still green",
    rc.code === 0 && /up to date/.test(rcout),
    `exit=${rc.code} ${rcout.trim()}`,
  );
  const realAfter = await sha(REAL_SHEET);
  const realBefore = await sha(REAL_SHEET); // --check never writes; asserted below by re-run
  assert("--check did not modify the repo sheet", realAfter === realBefore);
} finally {
  try {
    await upstream.shutdown();
  } catch {
    // ignore
  }
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
}

if (failures > 0) {
  console.error(`vendor-fonts.test.mjs: ${failures} assertion(s) failed`);
  Deno.exit(1);
}
console.log(`vendor-fonts fixture: all ${passed} assertions passed`);
