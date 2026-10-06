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
// gendn-n3e adds the bounded-fetch section: the script's outbound css2 fetch must carry the
// repo's canonical bound (timeout + byte cap, via fetchBounded), its failure paths (hung
// upstream, mid-body stall, oversized body) must refuse loudly and leave the PREVIOUS sheet
// byte-unchanged — never a partial install — and a static sweep backstops the invariant so a
// new bare `fetch(` cannot land in the repo's scripts quietly.
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

// Stalling endpoints (gendn-n3e) park a request on purpose; every one registers its own teardown
// so shutdown() cannot wedge on an in-flight request. An ARRAY, not a scalar slot: a scalar would
// be overwritten by each endpoint and only the last teardown would run (the latent hung-suite
// hazard the sibling fetch-bounded fixture documents).
const hangCleanups = [];
function onRelease(fn) {
  hangCleanups.push(fn);
}

const upstream = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/empty") return new Response("", { status: 200 });
  if (path === "/hang") {
    // Never responds on its own: the client must give up on its OWN bound.
    return new Promise((resolve) => {
      onRelease(() => resolve(new Response("released")));
    });
  }
  if (path === "/midhang") {
    // Headers + a partial body that looks like the start of a real rule, then silence: the
    // mid-body phase. A truncated body must never escape as a successful return.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`/* latin */\n@font-face {\n  font-family: 'Lora';`),
        );
        onRelease(() => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });
    return new Response(stream, { headers: { "content-type": "text/css" } });
  }
  if (path === "/huge") {
    // Streams 4 MiB of junk with no content-length, so only the byte cap can stop it. The junk
    // contains no @font-face rules; the cap must fire BEFORE the zero-rule guard ever sees it.
    const chunk = new Uint8Array(256 * 1024).fill(0x61);
    let sent = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (sent >= 4 * 1024 * 1024) {
            controller.close();
            return;
          }
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
      { headers: { "content-type": "text/css" } },
    );
  }
  if (path === "/slow") {
    // Slow-but-WORKING: the bound exists to catch a hung upstream, not to police latency.
    return new Promise((resolve) => {
      const t = setTimeout(
        () => resolve(new Response(REAL_SHAPE, { headers: { "content-type": "text/css" } })),
        400,
      );
      onRelease(() => clearTimeout(t));
    });
  }
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
// The script imports the repo's canonical bounded-fetch primitive; the tmp layout must carry the
// SAME file, or the fixture would silently test a stale copy of the bound (gendn-n3e).
await Deno.mkdir(`${tmp}/lib`, { recursive: true });
await Deno.copyFile(`${REPO}lib/chromestatus.ts`, `${tmp}/lib/chromestatus.ts`);

const EMPTY_BLOCK_SHEET =
  `body { color: #000; }\n/* --- BEGIN vendored @font-face */\n/* --- END vendored @font-face --- */\n`;
const REAL_SHEET_TEXT = await Deno.readTextFile(REAL_SHEET);
const sha = async (path) => {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// The repo sheet must be byte-identical after the WHOLE fixture run. The hash is captured HERE,
// before any test executes, so the comparison can actually fail (gendn-60l): the previous assertion
// read both sides after the run, which is tautological - a guard that cannot fail still reads as
// coverage on a coverage report.
const REAL_SHEET_SHA_BEFORE = await sha(REAL_SHEET);

// Freshness of the lib copy is asserted here (sha is defined just above this helper block).
assert(
  "tmp layout: lib/chromestatus.ts copied BYTE-IDENTICAL (no stale copy under test)",
  (await sha(`${REPO}lib/chromestatus.ts`)) === (await sha(`${tmp}/lib/chromestatus.ts`)),
);

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

// Like run(), but the FIXTURE itself is bounded: if the script has not exited by deadlineMs it is
// SIGKILLed and reported as timedOut. Without this, an unbounded script would hang the whole
// suite instead of failing the assertion — and "the test hung" is not evidence a reviewer can
// read. The deadline is deliberately much larger than the script's own --timeout-ms bound: the
// assertion is that the SCRIPT gives up near its bound, and the deadline only catches the
// unbounded case.
async function runBounded(args, sheetText, deadlineMs) {
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
  const child = cmd.spawn();
  const decoder = new TextDecoder();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  const raced = await Promise.race([child.output(), deadline]);
  clearTimeout(timer);
  if (raced === "deadline") {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
    const after = await sha(`${tmp}/public/styles.css`);
    return { timedOut: true, code: -1, out: "", err: "", unchanged: before === after };
  }
  const after = await sha(`${tmp}/public/styles.css`);
  return {
    timedOut: false,
    code: raced.code,
    out: decoder.decode(raced.stdout),
    err: decoder.decode(raced.stderr),
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

  // --- gendn-n3e: the outbound fetch is BOUNDED, and no failure path can install anything ---
  // The real proof is behavioural: a hung upstream, a mid-body stall and an oversized body must
  // each make the script REFUSE loudly, near its own bound, leaving the previous sheet
  // BYTE-UNCHANGED (a partial or truncated install is the outcome this bead exists to prevent).
  // Against a deliberately unbounded version of the script these assertions FAIL: the hang and
  // mid-hang cases trip runBounded's deadline (timedOut), and the oversize case refuses with the
  // zero-rule message instead of the byte-cap message.
  {
    const t0 = performance.now();
    const hang = await runBounded(
      ["--css-url", `${base}/hang`, "--timeout-ms", "400"],
      REAL_SHEET_TEXT,
      10_000,
    );
    const hangMs = Math.round(performance.now() - t0);
    assert(
      "n3e HUNG upstream: the script EXITS on its own bound instead of hanging forever",
      !hang.timedOut,
      hang.timedOut
        ? "still running after the 10000ms fixture deadline — the fetch is UNBOUNDED"
        : `exited in ${hangMs}ms`,
    );
    assert(
      "n3e HUNG upstream: non-zero exit, loud REFUSING, near its 400ms bound",
      !hang.timedOut && hang.code !== 0 && /REFUSING/.test(hang.err) && hangMs < 8_000,
      `exit=${hang.code} in ${hangMs}ms; ${hang.err.trim().slice(0, 160)}`,
    );
    assert(
      "n3e HUNG upstream: previous sheet BYTE-UNCHANGED (no partial install)",
      hang.unchanged,
    );

    const t1 = performance.now();
    const mid = await runBounded(
      ["--css-url", `${base}/midhang`, "--timeout-ms", "400"],
      REAL_SHEET_TEXT,
      10_000,
    );
    const midMs = Math.round(performance.now() - t1);
    assert(
      "n3e MID-BODY stall: headers + partial body do not settle it; the script EXITS bounded",
      !mid.timedOut,
      mid.timedOut
        ? "still running after the 10000ms fixture deadline — the body read is UNBOUNDED"
        : `exited in ${midMs}ms`,
    );
    assert(
      "n3e MID-BODY stall: REFUSES loudly; a truncated sheet is never written",
      !mid.timedOut && mid.code !== 0 && /REFUSING/.test(mid.err) && mid.unchanged,
      `exit=${mid.code}; unchanged=${mid.unchanged}; ${mid.err.trim().slice(0, 160)}`,
    );

    const huge = await runBounded(["--css-url", `${base}/huge`], REAL_SHEET_TEXT, 20_000);
    assert(
      "n3e OVERSIZED body (4 MiB streamed, no content-length): refused by the BYTE CAP, not by a later guard",
      !huge.timedOut && huge.code !== 0 && /cap|too large/i.test(huge.err),
      huge.timedOut ? "timed out" : `exit=${huge.code}; ${huge.err.trim().slice(0, 200)}`,
    );
    assert("n3e OVERSIZED body: previous sheet BYTE-UNCHANGED", huge.unchanged);

    // The bound must not be a latency police: a slow-but-working upstream still vendors.
    const slow = await runBounded(
      ["--css-url", `${base}/slow`, "--timeout-ms", "5000"],
      EMPTY_BLOCK_SHEET,
      15_000,
    );
    assert(
      "n3e SLOW-but-working upstream (400ms) still vendors inside a 5000ms bound",
      !slow.timedOut && slow.code === 0,
      `exit=${slow.code}; ${slow.err.trim().slice(0, 120)}`,
    );
  }

  // --- gendn-n3e: the --timeout-ms seam can TIGHTEN the bound but never disable or loosen it ---
  // A test seam that could turn the property under test OFF is how "bounded" becomes optional.
  {
    for (const bad of ["0", "-1", "abc", "", "999999999", "Infinity"]) {
      const refused = await run(
        ["--css-url", `${base}/real`, "--timeout-ms", bad],
        EMPTY_BLOCK_SHEET,
      );
      assert(
        `n3e seam guard: --timeout-ms ${
          JSON.stringify(bad)
        } is REFUSED (cannot disable or loosen the bound)`,
        refused.code !== 0 && /--timeout-ms/.test(refused.err) && refused.unchanged,
        `exit=${refused.code}; ${refused.err.trim().slice(0, 140)}`,
      );
    }
  }

  // --- gendn-n3e: the bounded-fetch invariant is CHECKED across the repo's scripts, not just ---
  // --- documented. Static sweep: a cheap backstop, NOT the proof.                        ---
  //
  // KNOWN LIMITS — this sweep is a SPELLING CHECK for the literal token `fetch(`. It cannot see:
  //   - globalThis.fetch(...) or any aliased/destructured binding (const f = fetch; f(url));
  //   - an indirect call through a wrapper — a wrapper that bounds internally and one that does
  //     not look identical from the call site;
  //   - files it does not scan (this fixture's own *.test.mjs siblings are excluded: they spin
  //     up loopback servers on purpose).
  // Comments are crudely stripped before matching (block then line comments), so prose that
  // MENTIONS `fetch(` is not flagged — the stripper is regex-grade, not a parser, and could in
  // principle be fooled by comment markers inside strings. Another reason this is a backstop.
  // That is precisely why the BEHAVIOURAL tests above carry the real proof for this script, and
  // this sweep exists only so a new bare `fetch(` cannot land in the repo's scripts QUIETLY.
  // Its greenness must never be read as "no unbounded fetch exists anywhere in this repo".
  {
    // Explicit, reasoned exceptions. Everything else must be either the fetchBounded definition
    // site itself, carry AbortSignal.timeout in the call, or name a loopback host literally.
    const ALLOWLIST = [
      {
        file: "scripts/lib/reference-browser.mjs",
        needle: "fetch(`${base}/`)",
        why: "loopback readiness poll of the server this same script spawned (http://localhost)",
      },
      {
        file: "scripts/conformance.mjs",
        needle: "fetch(`${base}/`)",
        why: "loopback readiness poll of the server this same script spawned (http://localhost)",
      },
      {
        file: "scripts/conformance.mjs",
        needle: "fetch(`${base}${a.test}`",
        why: "http-status assertion against that same loopback server, not an outbound call",
      },
    ];
    const DEFINITION_SITE = "lib/chromestatus.ts"; // fetchBounded: the ONE sanctioned bare fetch.

    const targets = [];
    const walk = async (dir, prefix) => {
      for await (const e of Deno.readDir(dir)) {
        const rel = `${prefix}/${e.name}`;
        if (e.isDirectory) {
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          await walk(`${dir}/${e.name}`, rel);
        } else if (
          (e.name.endsWith(".mjs") || e.name.endsWith(".ts")) &&
          !e.name.endsWith(".test.mjs") &&
          !e.name.endsWith(".test.ts")
        ) {
          targets.push(rel);
        }
      }
    };
    await walk(`${REPO}scripts`, "scripts");
    await walk(`${REPO}lib`, "lib");
    targets.push("server.ts");

    // The sweep's DECISION lives in one place, so a canary cannot pass on a private copy of the
    // rules (gendn-jm7). A canary that re-derives its expectation from a copy of the pattern it
    // polices can only fail when the two copies drift apart by hand: mutate the PRODUCTION rule and
    // it happily passes, reporting coverage while really detecting copy/paste errors. Both the sweep
    // and the canaries below call this.
    const sweepFinding = (rel, callText) => {
      if (rel === DEFINITION_SITE) return false; // fetchBounded itself bounds this call
      if (/AbortSignal\.timeout/.test(callText)) return false; // bounded at the call site
      if (/fetch\(\s*[`"'][^`"']*(127\.0\.0\.1|localhost)/.test(callText)) return false; // loopback literal
      if (ALLOWLIST.some((a) => a.file === rel && callText.includes(a.needle))) return false;
      return true;
    };
    const violations = [];
    let scanned = 0;
    let fetchSites = 0;
    for (const rel of targets) {
      const raw = await Deno.readTextFile(`${REPO}${rel}`);
      // Crude comment strip (see limits above): /* ... */ blocks blanked out WHILE PRESERVING
      // NEWLINES (so reported line numbers still match the real file), then full-line // comments.
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(
        /^\s*\/\/.*$/gm,
        "",
      );
      scanned++;
      for (const m of text.matchAll(/\bfetch\(/g)) {
        fetchSites++;
        const callText = text.slice(m.index, m.index + 300);
        const line = text.slice(0, m.index).split("\n").length;
        if (!sweepFinding(rel, callText)) continue;
        violations.push(`${rel}:${line}`);
      }
    }
    assert(
      "n3e static sweep: every non-test fetch() site in scripts/, lib/ and server.ts is bounded, loopback or allowlisted",
      violations.length === 0,
      violations.length > 0
        ? `UNBOUNDED bare fetch at: ${violations.join(", ")}`
        : `${fetchSites} fetch site(s) across ${scanned} file(s), all accounted for`,
    );
    // The sweep must be able to FAIL: a detector that cannot fire is decoration. Every canary below
    // runs through sweepFinding - the SAME decision the sweep uses - so mutating the production rule
    // breaks these, which is the whole point (gendn-jm7).
    const canary = "const res = await fetch(url, { headers: { 'user-agent': UA } });";
    assert(
      "n3e static sweep: the rules DO flag the pre-fix vendor-fonts fetch shape (the sweep can fail)",
      sweepFinding("scripts/vendor-fonts.mjs", canary),
    );
    assert(
      "n3e static sweep: a call carrying AbortSignal.timeout IS excused",
      !sweepFinding(
        "scripts/vendor-fonts.mjs",
        "await fetch(url, { signal: AbortSignal.timeout(4000) });",
      ),
    );
    // BOTH alternatives of the production loopback rule are exercised (gendn-ecc): the first canary
    // only used 127.0.0.1, so narrowing the rule to drop `localhost` - a real narrowing of a check
    // that exists to keep loopback polls from being reported as outbound fetches - left the fixture
    // GREEN. One canary per alternative means neither can be silently dropped.
    assert(
      "n3e static sweep: a 127.0.0.1 loopback literal IS excused",
      !sweepFinding("scripts/vendor-fonts.mjs", "await fetch(`http://127.0.0.1:8000/x`);"),
    );
    assert(
      "n3e static sweep: a localhost loopback literal IS excused",
      !sweepFinding("scripts/vendor-fonts.mjs", "await fetch(`http://localhost:8000/x`);"),
    );
    assert(
      "n3e static sweep: the fetchBounded definition site IS excused",
      !sweepFinding(DEFINITION_SITE, "const res = await fetch(url);"),
    );
    assert(
      "n3e static sweep: an allowlist entry IS honoured for its exact needle",
      !sweepFinding(ALLOWLIST[0].file, `x ${ALLOWLIST[0].needle} y`),
    );
    // ...and the allowlist is not a blanket: an outbound URL is still a finding.
    const outbound = "await fetch(`https://fonts.googleapis.com/css2`);";
    assert(
      "n3e static sweep: an outbound fetch with no timeout is NOT excused by the loopback rule",
      sweepFinding("scripts/vendor-fonts.mjs", outbound),
    );
  }

  // 6a. OFFLINE (repository state, no network): the vendored block in the repo's real sheet is
  // structurally intact. A red here means OUR vendoring is wrong. Mutated copies must FAIL it.
  const BEGIN_M = "/* --- BEGIN vendored @font-face";
  const END_M = "/* --- END vendored @font-face --- */";
  const vendoredBlockProblems = (text) => {
    const problems = [];
    const i = text.indexOf(BEGIN_M);
    const j = text.indexOf(END_M);
    if (i < 0 || j < 0 || j < i) return ["BEGIN/END markers missing or out of order"];
    const block = text.slice(i, j);
    const faces = block.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    if (faces.length === 0) problems.push("no @font-face rules in vendored block");
    for (const f of faces) {
      if (!/src:\s*url\(https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2\)/.test(f)) {
        problems.push("a rule lacks a fonts.gstatic.com woff2 src");
      }
    }
    return problems;
  };
  assert(
    "OFFLINE (repo state): vendored block in public/styles.css is intact",
    vendoredBlockProblems(REAL_SHEET_TEXT).length === 0,
    vendoredBlockProblems(REAL_SHEET_TEXT).join("; "),
  );
  assert(
    "OFFLINE mutation: END marker removed -> detected",
    vendoredBlockProblems(REAL_SHEET_TEXT.replace(END_M, "")).length > 0,
  );
  assert(
    "OFFLINE mutation: a woff2 src corrupted -> detected",
    vendoredBlockProblems(REAL_SHEET_TEXT.replace(".woff2)", ".woff)")).length > 0,
  );
  assert(
    "OFFLINE mutation: block emptied -> detected",
    vendoredBlockProblems(
      REAL_SHEET_TEXT.slice(0, REAL_SHEET_TEXT.indexOf(BEGIN_M) + BEGIN_M.length) + " */\n" +
        REAL_SHEET_TEXT.slice(REAL_SHEET_TEXT.indexOf(END_M)),
    ).length > 0,
  );

  // 6b. LIVE (the INTERNET's state, opt-in): compares the repo sheet to Google Fonts right now.
  // Run `deno task test-vendor-fonts --live` deliberately. A red here means UPSTREAM CHANGED (run
  // `deno task vendor-fonts` to re-vendor), not that the repo is broken; it is not in the aggregate
  // because a transient upstream mismatch must not red every lane (gendn-c6w).
  if (!Deno.args.includes("--live")) {
    console.log(
      "SKIPPED (opt-in, NOT a pass): LIVE upstream --check against Google Fonts was not run; " +
        "pass --live to compare with the real endpoint. Offline repo-state assertions above did run.",
    );
  } else {
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
      "LIVE (upstream state): vendor-fonts --check on the repo sheet is still current",
      rc.code === 0 && /up to date/.test(rcout),
      `exit=${rc.code} ${rcout.trim()}`,
    );
  }
  assert(
    "the fixture did not modify the repo sheet (public/styles.css)",
    (await sha(REAL_SHEET)) === REAL_SHEET_SHA_BEFORE,
  );
} finally {
  // Drain every stalling endpoint's teardown, each wrapped so one failure cannot skip the rest.
  for (const cleanup of hangCleanups) {
    try {
      cleanup();
    } catch {
      // ignore
    }
  }
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
