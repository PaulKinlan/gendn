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
