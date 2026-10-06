// Fast, aggregate-discovered detectors for gendn's published-route identity and gate decisions.
// These synthetic manifests exercise both failure and harmless-change directions without git or pages
// - with ONE exception at the end (gendn-r1q), which calls git locally against a ref that cannot
// exist, to pin that a non-zero exit NAMES what git said rather than only its exit code.
import { evaluateRouteContract } from "./check-routes.mjs";
import { buildManifest, PAGE_RE, pathToIdentityFields } from "./route-manifest.mjs";
import { metadataFromHtml } from "./lib/artifacts.mjs";

let passed = 0;
let failures = 0;
function assert(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failures++;
    // Print the supplied detail on failure (gendn-r1q review): a failing pin whose message is
    // discarded makes the reader re-derive what went wrong, which is the opposite of a diagnostic.
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const html = '<a href="https://chromestatus.com/feature/123">feature</a>';
const a = pathToIdentityFields("v153/foo/index.html", html);
const nextMilestone = pathToIdentityFields("v154/foo/index.html", html);
assert("full milestone/slug id catches basenames-only derivation", a.id === "v153/foo");
assert("full milestone/slug route catches basenames-only derivation", a.route === "/v153/foo/");
assert(
  "same slug across milestones cannot collapse even with the same feature identity",
  a.id !== nextMilestone.id && a.route !== nextMilestone.route &&
    a.identity === nextMilestone.identity,
);
const mixedCase = pathToIdentityFields("v153/Foo/index.html", html);
assert(
  "route derivation preserves case instead of folding it",
  mixedCase.id === "v153/Foo" && mixedCase.route === "/v153/Foo/",
);
assert("feature identity is the id in the link, not the route", a.identity === "123");
assert(
  "absent feature link has no fabricated identity",
  pathToIdentityFields("v153/x/index.html", "<h1>x</h1>").identity === null,
);
assert(
  "shared lifecycle derivation agrees on route identity and status",
  ["id", "route", "identity", "status"].every((key) =>
    a[key] === metadataFromHtml("v153/foo/index.html", html)[key]
  ),
);
assert(
  "visible MDN eyebrow classifies a published stub",
  pathToIdentityFields("v153/foo/index.html", '<p class="eyebrow">Covered on MDN</p>').status ===
    "stub",
);
assert(
  "a hidden MDN eyebrow does not downgrade a built page",
  pathToIdentityFields(
    "v153/foo/index.html",
    '<details><p class="eyebrow">Covered on MDN</p></details><h1>Example</h1>',
  ).status === "built",
);
assert(
  "only two-level index pages are manifest identities",
  PAGE_RE.test("v153/foo/index.html") && !PAGE_RE.test("v153/foo/member/index.html") &&
    !PAGE_RE.test("v153/index.html"),
);
const showcase = "https://chrome-platform-showcase.paulkinlan-ea.deno.net";
assert(
  "own embedded demo wins even if another feature link occurs first",
  pathToIdentityFields(
    "v153/foo/index.html",
    `${showcase}/v153/other/demo ${showcase}/v153/foo/demo`,
  ).demo === `${showcase}/v153/foo/demo`,
);

function entry(id, overrides = {}) {
  return {
    id,
    route: `/${id}/`,
    identity: "123",
    status: "built",
    demo: null,
    referenceRoutes: [],
    support: { desktop: "untested", mobile: "untested" },
    ...overrides,
  };
}
async function evaluate(
  baseline,
  current,
  migrations = [],
  pageExists = async () => true,
  opts = {},
) {
  return await evaluateRouteContract({ baseline, current, migrations, pageExists, ...opts });
}
function mentions(result, text) {
  return result.failures.some((failure) => failure.includes(text));
}

const base = entry("v153/foo");
assert(
  "additive route is allowed (false-positive control)",
  (await evaluate([base], [base, entry("v154/new")])).failures.length === 0,
);
assert(
  "in-place edit preserving id and identity is allowed (false-positive control)",
  (await evaluate([base], [{ ...base, demo: `${showcase}/v153/foo/demo` }])).failures.length ===
    0,
);
const lostDemo = await evaluate([{ ...base, demo: `${showcase}/v153/foo/demo` }], [base]);
assert(
  "losing a demo warns but does not fail the gate",
  lostDemo.failures.length === 0 && lostDemo.demoDropped.length === 1,
);
assert(
  "adding a once-missing feature id does not repurpose the page",
  (await evaluate([entry("v153/no-id", { identity: null })], [entry("v153/no-id")])).failures
    .length === 0,
);
const caseChange = await evaluate([entry("v153/Foo")], [entry("v153/foo")]);
assert(
  "case-only rename is rejected (detects a case-insensitive gate)",
  mentions(caseChange, "missing published id v153/Foo"),
);
const milestoneMove = await evaluate([entry("v153/foo")], [entry("v154/foo")]);
assert(
  "same basename in another milestone is a route move, not an in-place fix",
  mentions(milestoneMove, "missing published id v153/foo"),
);
const move = [{ id: "v153/foo", action: "move", from: "/v153/foo/", to: "/v154/foo/" }];
const approvedMove = await evaluate([entry("v153/foo")], [entry("v154/foo")], move);
assert(
  "explicit move migration permits the old id to disappear",
  approvedMove.failures.length === 0 && approvedMove.migrated.length === 1,
);
assert(
  "re-adding an old route after a reviewed move is additive against the next baseline",
  (await evaluate([entry("v154/foo")], [entry("v154/foo"), entry("v153/foo")], move)).failures
    .length === 0,
);
assert(
  "unmigrated deletion of a built page is rejected",
  mentions(await evaluate([base], []), "missing published id v153/foo"),
);
assert(
  "unmigrated deletion of a stub retains the explicit stub failure",
  mentions(
    await evaluate([entry("v153/stub", { status: "stub" })], []),
    "deleted stub route /v153/stub/",
  ),
);
assert(
  "an uncovered count drop is a second failure signal",
  mentions(
    await evaluate([base, entry("v154/keep")], [entry("v154/keep")]),
    "published count dropped 2 -> 1",
  ),
);
assert(
  "a migration-covered count drop is not a failure",
  (await evaluate([base, entry("v154/keep")], [entry("v154/keep")], move)).failures
    .length === 0,
);
const changedIdentity = await evaluate([base], [entry("v153/foo", { identity: "456" })]);
assert(
  "repurposing the same slug to a different feature fails",
  mentions(changedIdentity, "identity changed for v153/foo"),
);
assert(
  "identity-change migration authorizes a deliberate repurpose",
  (await evaluate([base], [entry("v153/foo", { identity: "456" })], [{
    id: "v153/foo",
    action: "identity-change",
  }])).failures.length === 0,
);
assert(
  "built route resolution check is reachable when the page disappears",
  mentions(
    await evaluate([base], [base], [], async () => false),
    "built route /v153/foo/ no longer resolves",
  ),
);
const reference = "/v153/foo/member/";
const withReference = entry("v153/foo", { referenceRoutes: [reference] });
assert(
  "deleted child reference route fails without a server-backed alias",
  mentions(await evaluate([withReference], [base]), "published member/protocol route"),
);
assert(
  "child reference route replacement passes only with a same-feature alias",
  (await evaluate([withReference], [entry("v153/foo", {
    referenceRoutes: ["/v153/foo/replacement/"],
  })], [{
    id: "v153/foo",
    action: "alias",
    from: reference,
    to: "/v153/foo/replacement/",
  }])).failures.length === 0,
);
const supported = entry("v153/foo", { support: { desktop: "ok", mobile: "ok" } });
assert(
  "ok to unsupported is allowed when capability is honestly unavailable",
  (await evaluate([supported], [entry("v153/foo", {
    support: {
      desktop: "unsupported",
      mobile: "ok",
    },
  })])).failures.length === 0,
);
assert(
  "ok to untested support regression fails without a migration",
  mentions(await evaluate([supported], [base]), "desktop support regressed ok -> untested"),
);
assert(
  "broken support fails even for a newly added page",
  mentions(
    await evaluate([], [entry("v154/broken", {
      support: {
        desktop: "broken",
        mobile: "untested",
      },
    })]),
    "recorded broken on desktop",
  ),
);

// gendn-r1q: the shared bounded git runner must surface git's own stderr on a non-zero exit. The 8q2
// refactor replaced "failed: <stderr>" with a bare exit code, losing the single most useful line for
// a human debugging a bad ref. The ref below cannot exist, so this is a local, network-free call.
try {
  await buildManifest({ ref: "origin/gendn-r1q-ref-that-cannot-exist" });
  assert("a bad ref must REJECT rather than return a manifest", false);
} catch (e) {
  const msg = String(e?.message ?? e);
  assert(
    "a bad ref's error names git's stderr (the 'fatal: ...' line), not just the exit code",
    /exit code 128/.test(msg) && /fatal:/.test(msg),
    msg,
  );
}

// gendn-r1q review counterexample, pinned so the fix cannot silently regress: git prints `error:`/
// `fatal:` FIRST and then usage or hints, so a rule that takes the LAST stderr line picks the hint.
// An unknown option is the cheapest reliable multi-line case (exit 129, `error: unknown option ...`
// followed by a usage block), and this asserts we report the CAUSE rather than a usage flag.
try {
  await buildManifest({ ref: "--invalid-option" });
  assert("an invalid option must REJECT rather than return a manifest", false);
} catch (e) {
  const msg = String(e?.message ?? e);
  assert(
    "a MULTI-LINE git failure reports the 'error:'/'fatal:' cause, not the last usage line",
    /exit code 129/.test(msg) && /error: unknown option/.test(msg),
    msg,
  );
}

// gendn-cct: the removal messages must NAME the baseline and its commit, because a branch cut
// before a page changed on main reads that page as "removed or renamed" while the merge is clean -
// three lanes went hunting for a rename they never made. `drift === false` additionally means HEAD
// does not contain the baseline commit, which is the property that makes the reading suspect, so
// that case must carry the cure (rebase) rather than leave the reader to infer it.
{
  const labelled = await evaluate([withReference], [base], [], async () => true, {
    baselineLabel: "origin/main @ 3f6696d",
    drift: true,
  });
  const removal = labelled.failures.find((f) => f.includes("removed or renamed"));
  assert(
    "a removal failure names the compared baseline",
    /\[vs baseline origin\/main @ 3f6696d\]/.test(removal ?? ""),
  );
  assert(
    "a non-drift run does NOT claim base drift (the note must not cry wolf)",
    !/BASE DRIFT|base drift/.test(removal ?? ""),
  );

  const drifted = await evaluate([withReference], [base], [], async () => true, {
    baselineLabel: "origin/main @ 3f6696d",
    drift: false,
  });
  const dRemoval = drifted.failures.find((f) => f.includes("removed or renamed"));
  assert(
    "a drift run says the removal may exist ONLY on the baseline, and names the cure",
    /does not contain this baseline commit/.test(dRemoval ?? "") &&
      /git rebase origin\/main/.test(dRemoval ?? ""),
  );

  const unlabelled = await evaluate([withReference], [base]);
  const uRemoval = unlabelled.failures.find((f) => f.includes("removed or renamed"));
  assert(
    "without a label the message is unchanged (git-free callers keep the old text)",
    !/vs baseline/.test(uRemoval ?? "") && /removed or renamed/.test(uRemoval ?? ""),
  );
}

if (failures) Deno.exit(1);
console.log(`route contract fixture: all ${passed} assertions passed`);
