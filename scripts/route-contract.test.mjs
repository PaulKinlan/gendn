// Fast, aggregate-discovered detectors for gendn's published-route identity and gate decisions.
// These synthetic manifests exercise both failure and harmless-change directions without git or pages
// - with ONE exception at the end (gendn-r1q), which calls git locally against a ref that cannot
// exist, to pin that a non-zero exit NAMES what git said rather than only its exit code.
import { evaluateRouteContract, loadMigrations, validateMigrationRecord } from "./check-routes.mjs";
import { buildManifest, PAGE_RE, pathToIdentityFields } from "./route-manifest.mjs";
import { metadataFromHtml } from "./lib/artifacts.mjs";
import { invalidateJudgedCache } from "./lib/judged-content.mjs";
import { loadRedirects, redirectTarget } from "../server.ts";

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
// t7sr: a longer sibling slug is not the /v148/prompt-api/ feature. With no own link,
// the documented fallback is the FIRST showcase URL, not a later prefix-colliding sibling.
const promptPage = "v148/prompt-api/index.html";
const unrelatedDemo = `${showcase}/v148/other-feature/`;
const siblingDemo = `${showcase}/v148/prompt-api-sampling-parameters/`;
const ownPromptDemo = `${showcase}/v148/prompt-api/`;
const noOwnHtml = `${unrelatedDemo} ${siblingDemo}`;
const noOwnDemo = pathToIdentityFields(promptPage, noOwnHtml).demo;
const noOwnMetadataDemo = metadataFromHtml(promptPage, noOwnHtml).demo;
assert(
  "prefix-colliding sibling cannot override an earlier fallback in manifest OR suite metadata",
  noOwnDemo === unrelatedDemo && noOwnMetadataDemo === unrelatedDemo,
  `manifest: ${noOwnDemo}; metadata: ${noOwnMetadataDemo}; expected: ${unrelatedDemo}`,
);
const ownAfterSiblingHtml = `${siblingDemo} ${ownPromptDemo}`;
const ownAfterSibling = pathToIdentityFields(promptPage, ownAfterSiblingHtml).demo;
const ownMetadataAfterSibling = metadataFromHtml(promptPage, ownAfterSiblingHtml).demo;
assert(
  "real own demo wins after a colliding sibling in manifest AND suite metadata",
  ownAfterSibling === ownPromptDemo && ownMetadataAfterSibling === ownPromptDemo,
  `manifest: ${ownAfterSibling}; metadata: ${ownMetadataAfterSibling}; expected: ${ownPromptDemo}`,
);
assert(
  "a lone sibling remains the first-showcase fallback, not an own-feature match",
  pathToIdentityFields(promptPage, siblingDemo).demo === siblingDemo,
);

// gendn-zswf (a): explicit doc-table declaration row beats earlier incidental ChromeStatus reference
const relatedFirstDeclaredSecond = `
  <p>Related feature: <a href="https://chromestatus.com/feature/6299876096737280">earlier subset</a></p>
  <table class="doc-table">
    <tr><th scope="row">ChromeStatus</th><td><a href="https://chromestatus.com/feature/5068277495758848">5068277495758848 — Media element pseudo-classes</a></td></tr>
  </table>
`;
const zswfManifest = pathToIdentityFields(
  "v152/media-element-pseudo-classes/index.html",
  relatedFirstDeclaredSecond,
);
const zswfMetadata = metadataFromHtml(
  "v152/media-element-pseudo-classes/index.html",
  relatedFirstDeclaredSecond,
);
assert(
  "declared ChromeStatus table row beats earlier incidental ChromeStatus link in manifest and metadata",
  zswfManifest.identity === "5068277495758848" && zswfMetadata.identity === "5068277495758848",
  `manifest: ${zswfManifest.identity}; metadata: ${zswfMetadata.identity}; expected: 5068277495758848`,
);

// gendn-jt5r (b): marked related showcase link + no-own-demo disclaimer yields null demo; unmarked fallback preserved
const cameraMicPage = "v153/capability-elements-camera-and-microphone/index.html";
const markedRelatedHtml = `
  <p>The Chrome Platform Showcase has no demo for this feature yet; the sibling <a href="${showcase}/v151/capability-elements-usermedia-mvp/" target="_blank" rel="noopener" data-demo-rel="related">&lt;usermedia&gt; demo</a> exercises the same mechanism.</p>
`;
const markedManifestDemo = pathToIdentityFields(cameraMicPage, markedRelatedHtml).demo;
const markedMetadataDemo = metadataFromHtml(cameraMicPage, markedRelatedHtml).demo;
assert(
  "marked related showcase link is excluded from own demo yielding null in manifest and metadata",
  markedManifestDemo === null && markedMetadataDemo === null,
  `manifest: ${markedManifestDemo}; metadata: ${markedMetadataDemo}; expected: null`,
);

const unmarkedSiblingHtml = `
  <p>Related context: <a href="${showcase}/v151/capability-elements-usermedia-mvp/">sibling</a></p>
`;
const unmarkedManifestDemo = pathToIdentityFields(cameraMicPage, unmarkedSiblingHtml).demo;
const unmarkedMetadataDemo = metadataFromHtml(cameraMicPage, unmarkedSiblingHtml).demo;
assert(
  "unmarked showcase link with no own link still uses first-showcase fallback",
  unmarkedManifestDemo === `${showcase}/v151/capability-elements-usermedia-mvp/` &&
    unmarkedMetadataDemo === `${showcase}/v151/capability-elements-usermedia-mvp/`,
);

// gendn-jt5r (c): page with marked related link AND an own-feature demo link still selects own demo
const markedRelatedPlusOwnDemoHtml = `
  <p>Sibling: <a href="${showcase}/v151/capability-elements-usermedia-mvp/" data-demo-rel="related">sibling</a></p>
  <figure><iframe src="${showcase}/v153/capability-elements-camera-and-microphone/live-demo/"></iframe></figure>
`;
const ownPlusMarkedManifestDemo = pathToIdentityFields(
  cameraMicPage,
  markedRelatedPlusOwnDemoHtml,
).demo;
const ownPlusMarkedMetadataDemo = metadataFromHtml(
  cameraMicPage,
  markedRelatedPlusOwnDemoHtml,
).demo;
assert(
  "page own showcase demo wins even when a marked related link occurs earlier",
  ownPlusMarkedManifestDemo ===
      `${showcase}/v153/capability-elements-camera-and-microphone/live-demo/` &&
    ownPlusMarkedMetadataDemo ===
      `${showcase}/v153/capability-elements-camera-and-microphone/live-demo/`,
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
// gendn-sai3: losing or repointing a showcase demo link fails the route gate unless migrated.
const withDemo = entry("v153/foo", { demo: `${showcase}/v153/foo/demo` });
const lostDemo = await evaluate([withDemo], [base]);
assert(
  "removing showcase demo link from a published page fails",
  mentions(lostDemo, "missing demo link for published route v153/foo"),
);
assert(
  "demo removal is one hard failure, not a second informational warning",
  lostDemo.failures.length === 1 && !Object.hasOwn(lostDemo, "demoDropped"),
);
assert(
  "demo-change migration authorizes deliberate demo removal",
  (await evaluate([withDemo], [base], [{
    id: "v153/foo",
    action: "demo-change",
  }])).failures.length === 0,
);
const repointedDemo = await evaluate([withDemo], [
  entry("v153/foo", { demo: `${showcase}/v150/out-of-order-streaming/` }),
]);
assert(
  "repointing showcase demo link to another demo fails",
  mentions(repointedDemo, "demo link changed for v153/foo"),
);
// The durable unit is the FULL selected URL, not just the feature prefix. These two real
// autofill concepts belong to the same feature but demonstrate different behavior.
const autofill = entry("v147/autofill-event", {
  identity: "5137581018841088",
  demo: `${showcase}/v147/autofill-event/refill-flow/`,
});
const autofillLog = { ...autofill, demo: `${showcase}/v147/autofill-event/autofill-log/` };
const sameFeatureSwap = await evaluate([autofill], [autofillLog]);
assert(
  "same-feature concept swap FAILS without migration and names the demo-change escape hatch",
  sameFeatureSwap.failures.length === 1 &&
    mentions(sameFeatureSwap, "refill-flow/") &&
    mentions(sameFeatureSwap, "autofill-log/") &&
    mentions(sameFeatureSwap, "demo-change"),
  JSON.stringify(sameFeatureSwap.failures),
);
const authorizedSameFeatureSwap = await evaluate([autofill], [autofillLog], [{
  id: autofill.id,
  action: "demo-change",
  from: autofill.demo,
  to: autofillLog.demo,
  reason: "Deliberately switch the primary concept after review",
  evidence: "Reviewed demo and critique evidence for this behavior change",
  date: "2026-10-07",
}]);
assert(
  "same-feature concept swap PASSES with reviewed demo-change migration",
  authorizedSameFeatureSwap.failures.length === 0 &&
    authorizedSameFeatureSwap.migrated.some((line) =>
      line.includes("demo link change via migration")
    ),
  JSON.stringify(authorizedSameFeatureSwap),
);
assert(
  "demo-change migration authorizes deliberate demo repointing",
  (await evaluate([withDemo], [
    entry("v153/foo", { demo: `${showcase}/v150/out-of-order-streaming/` }),
  ], [{
    id: "v153/foo",
    action: "demo-change",
  }])).failures.length === 0,
);
assert(
  "identity-change migration also authorizes deliberate demo repointing",
  (await evaluate([withDemo], [
    entry("v153/foo", { demo: `${showcase}/v150/out-of-order-streaming/` }),
  ], [{
    id: "v153/foo",
    action: "identity-change",
  }])).failures.length === 0,
);
assert(
  "route that never had a demo staying null passes",
  (await evaluate([base], [base])).failures.length === 0,
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
// gendn-p9ko: removing all feature links leaves identity null, which must fail the route gate
// rather than bypassing the comparison.
const removedIdentityBuilt = await evaluate([base], [entry("v153/foo", { identity: null })]);
assert(
  "removing feature identity from a published built page fails",
  mentions(removedIdentityBuilt, "missing identity for published route v153/foo"),
);

const stubBase = entry("v153/stub", { status: "stub" });
const removedIdentityStub = await evaluate([stubBase], [
  entry("v153/stub", { status: "stub", identity: null }),
]);
assert(
  "removing feature identity from a published stub fails",
  mentions(removedIdentityStub, "missing identity for published route v153/stub"),
);

assert(
  "identity-change migration authorizes deliberate identity removal",
  (await evaluate([base], [entry("v153/foo", { identity: null })], [{
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

// gendn-exxi: redirectTarget prefix match path boundary and migration key load-time validation.
// A non-slash-terminated 'from' (e.g. '/v149/foo') must NOT match a longer unrelated path (e.g. '/v149/foobar').
// Existing slash-terminated deep link behavior must remain unchanged.
// Both loadRedirects (server startup) and loadMigrations/evaluateRouteContract (route gate) must reject
// non-slash-terminated 'from' keys at load time.
{
  const nonSlash = [{ from: "/v149/foo", to: "/v150/foo/" }];
  assert(
    "redirectTarget: non-slash-terminated from does NOT match longer unrelated path",
    redirectTarget("/v149/foobar", nonSlash) === null,
  );
  assert(
    "redirectTarget: non-slash-terminated from does NOT match hyphenated sibling path",
    redirectTarget("/v149/foo-bar", nonSlash) === null,
  );
  assert(
    "redirectTarget: non-slash-terminated from exact match without slash redirects",
    redirectTarget("/v149/foo", nonSlash) === "/v150/foo/",
  );
  assert(
    "redirectTarget: non-slash-terminated from exact match with slash redirects",
    redirectTarget("/v149/foo/", nonSlash) === "/v150/foo/",
  );
  assert(
    "redirectTarget: non-slash-terminated from does NOT match deep link subpath",
    redirectTarget("/v149/foo/sub", nonSlash) === null,
  );

  const slash = [{ from: "/v149/foo/", to: "/v150/foo/" }];
  assert(
    "redirectTarget: slash-terminated from does NOT match longer unrelated path",
    redirectTarget("/v149/foobar", slash) === null,
  );
  assert(
    "redirectTarget: slash-terminated from exact match without slash redirects",
    redirectTarget("/v149/foo", slash) === "/v150/foo/",
  );
  assert(
    "redirectTarget: slash-terminated from exact match with slash redirects",
    redirectTarget("/v149/foo/", slash) === "/v150/foo/",
  );
  assert(
    "redirectTarget: slash-terminated from carries deep link subpath over to target",
    redirectTarget("/v149/foo/sub/page", slash) === "/v150/foo/sub/page",
  );

  // Load-time validation: server loadRedirects rejects non-slash-terminated 'from'
  let serverRejected = false;
  try {
    loadRedirects([{ id: "test/foo", action: "move", from: "/v149/foo", to: "/v150/foo/" }]);
  } catch (e) {
    serverRejected = /must end in '\/'/.test(String(e?.message ?? e));
  }
  assert("loadRedirects rejects non-slash-terminated move record at load time", serverRejected);

  let aliasRejected = false;
  try {
    loadRedirects([{ id: "test/alias", action: "alias", from: "/v149/foo", to: "/v150/foo/" }]);
  } catch (e) {
    aliasRejected = /must end in '\/'/.test(String(e?.message ?? e));
  }
  assert("loadRedirects rejects non-slash-terminated alias record at load time", aliasRejected);

  // Load-time validation: check-routes validateMigrationRecord & loadMigrations reject non-slash-terminated 'from'
  let validatorRejected = false;
  try {
    validateMigrationRecord({
      id: "test/foo",
      action: "move",
      from: "/v149/foo",
      to: "/v150/foo/",
    });
  } catch (e) {
    validatorRejected = /must end in '\/'/.test(String(e?.message ?? e));
  }
  assert("validateMigrationRecord rejects non-slash-terminated move record", validatorRejected);

  let fileLoaderRejected = false;
  try {
    await loadMigrations([{ id: "test", action: "move", from: "/v149/foo", to: "/v150/foo/" }]);
  } catch (e) {
    fileLoaderRejected = /must end in '\/'/.test(String(e?.message ?? e));
  }
  assert(
    "loadMigrations rejects non-slash-terminated record at load time",
    fileLoaderRejected,
  );

  // evaluateRouteContract reports a failure when a non-slash migration is present
  const gateResult = await evaluate([base], [base], [
    { id: "v149/foo", action: "move", from: "/v149/foo", to: "/v150/foo/" },
  ]);
  assert(
    "evaluateRouteContract rejects non-slash-terminated move migration",
    mentions(gateResult, "must end in '/' (path boundary invariant"),
  );
}

// gendn-ip0z: staged-then-reverted edit (git status MM) must not escape check-routes / route-manifest
{
  const scratch = await Deno.makeTempDir({ prefix: "ip0z-route-manifest-" });
  const probe = "v900/probe";
  const probePage = (featureId, extra = "") =>
    `<!doctype html><html><head></head><body><h1>Probe</h1>` +
    `<a href="https://chromestatus.com/feature/${featureId}">ChromeStatus</a>${extra}</body></html>`;
  const baseFeature = "1234567890";
  const mutatedFeature = "9999999999";

  const g = async (...args) => {
    const c = new Deno.Command("git", { args, cwd: scratch, stdout: "piped", stderr: "piped" });
    const o = await c.output();
    if (!o.success) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(o.stderr)}`);
    }
    return new TextDecoder().decode(o.stdout);
  };

  try {
    await Deno.mkdir(`${scratch}/${probe}`, { recursive: true });
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, probePage(baseFeature));
    await g("init", "-q", "-b", "main");
    await g("config", "user.email", "ip0z@example.test");
    await g("config", "user.name", "ip0z");
    await g("add", ".");
    await g("commit", "-qm", "baseline");
    await g("update-ref", "refs/remotes/origin/main", "HEAD");

    const baselineManifest = await buildManifest({ root: scratch });
    assert("ip0z: baseline manifest captures 1 route", baselineManifest.length === 1);
    assert(
      "ip0z: baseline manifest captures feature id",
      baselineManifest[0].identity === baseFeature,
    );

    // Case 1: Clean baseline — passes gate
    invalidateJudgedCache();
    let current = await buildManifest({ root: scratch });
    let evaluated = await evaluate(baselineManifest, current);
    assert("ip0z Case 1 (clean): route gate passes", evaluated.failures.length === 0);

    // Case 2: Uncommitted edit in working tree (mutating identity) — fails gate
    invalidateJudgedCache();
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, probePage(mutatedFeature));
    current = await buildManifest({ root: scratch });
    assert(
      "ip0z Case 2 (uncommitted): manifest reflects worktree identity",
      current[0].identity === mutatedFeature,
    );
    evaluated = await evaluate(baselineManifest, current);
    assert(
      "ip0z Case 2 (uncommitted): identity change fails gate",
      evaluated.failures.length === 1 && mentions(evaluated, "identity changed"),
    );

    // Case 3: Staged edit — fails gate
    invalidateJudgedCache();
    await g("add", `${probe}/index.html`);
    current = await buildManifest({ root: scratch });
    assert(
      "ip0z Case 3 (staged): manifest reflects staged identity",
      current[0].identity === mutatedFeature,
    );
    evaluated = await evaluate(baselineManifest, current);
    assert(
      "ip0z Case 3 (staged): identity change fails gate",
      evaluated.failures.length === 1 && mentions(evaluated, "identity changed"),
    );

    // Case 4: Staged-then-reverted (git status shows MM) — escape closed!
    // Worktree file restored to base content: base -> worktree diff is empty,
    // but the index holds the change, so route-manifest reads from the index.
    invalidateJudgedCache();
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, probePage(baseFeature));
    const statusOut = (await g("status", "--short")).trim();
    assert(
      "ip0z Case 4: git status shows MM for staged-then-reverted page",
      statusOut.includes("MM") && statusOut.includes(probe),
    );
    current = await buildManifest({ root: scratch });
    assert(
      "ip0z Case 4 (staged-then-reverted): manifest reads staged index content (not reverted worktree bytes)",
      current[0].identity === mutatedFeature,
    );
    evaluated = await evaluate(baselineManifest, current);
    assert(
      "ip0z Case 4 (staged-then-reverted): identity change fails gate (escape closed)",
      evaluated.failures.length === 1 && mentions(evaluated, "identity changed"),
    );

    // Case 5: Committed edit — fails gate
    invalidateJudgedCache();
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, probePage(mutatedFeature));
    await g("commit", "-am", "commit mutated identity");
    current = await buildManifest({ root: scratch });
    evaluated = await evaluate(baselineManifest, current);
    assert(
      "ip0z Case 5 (committed): committed mutation fails gate",
      evaluated.failures.length === 1 && mentions(evaluated, "identity changed"),
    );

    // Case 6: Resolved — passes gate
    invalidateJudgedCache();
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, probePage(baseFeature));
    await g("commit", "-am", "resolve identity");
    current = await buildManifest({ root: scratch });
    evaluated = await evaluate(baselineManifest, current);
    assert("ip0z Case 6 (resolved): resolved route passes gate", evaluated.failures.length === 0);

    // Case 7 (gendn-0n5s Scenario A): Staged identity mutation disguised by unrelated unstaged decoy edit
    // Worktree identity reverted to base, but carries an unrelated comment (git status MM with worktree != base).
    // The reader must still read the staged index content and fail the gate.
    invalidateJudgedCache();
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, probePage(mutatedFeature));
    await g("add", `${probe}/index.html`);
    await Deno.writeTextFile(
      `${scratch}/${probe}/index.html`,
      probePage(baseFeature, "<!-- unrelated decoy edit -->"),
    );
    const decoyStatus = (await g("status", "--short")).trim();
    assert(
      "0n5s Case 7 (decoy): git status shows MM for staged mutation with unstaged decoy edit",
      decoyStatus.includes("MM") && decoyStatus.includes(probe),
    );
    current = await buildManifest({ root: scratch });
    assert(
      "0n5s Case 7 (decoy): manifest reads staged index content (not worktree with decoy edit)",
      current[0].identity === mutatedFeature,
    );
    evaluated = await evaluate(baselineManifest, current);
    assert(
      "0n5s Case 7 (decoy): disguised staged mutation fails gate (escape closed)",
      evaluated.failures.length === 1 && mentions(evaluated, "identity changed"),
    );

    // Case 8 (gendn-0n5s non-regression): Unrelated unstaged edit ALONE (no staged mutation) must pass gate
    invalidateJudgedCache();
    await g("reset", "-q", "HEAD", `${probe}/index.html`);
    const cleanStagedStatus = (await g("status", "--short")).trim();
    assert(
      "0n5s Case 8: git status shows plain uncommitted edit (M ) for decoy edit alone",
      cleanStagedStatus.startsWith("M") && !cleanStagedStatus.startsWith("MM"),
    );
    current = await buildManifest({ root: scratch });
    assert(
      "0n5s Case 8: manifest reflects base identity with decoy edit",
      current[0].identity === baseFeature,
    );
    evaluated = await evaluate(baselineManifest, current);
    assert(
      "0n5s Case 8: unrelated unstaged edit ALONE passes gate",
      evaluated.failures.length === 0,
    );

    // Case 9 (gendn-0n5s P1-A ADV2): Staged identity mutation with tolerated status decoy
    // Worktree reverts identity to base, but eyebrow becomes "Covered on MDN" (tolerated status drift).
    // The reader must still read the staged index content and fail the gate.
    invalidateJudgedCache();
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, probePage(mutatedFeature));
    await g("add", `${probe}/index.html`);
    const mdnStubPage =
      `<!doctype html><html><head></head><body><p class="eyebrow">Covered on MDN</p><h1>Probe</h1>` +
      `<a href="https://chromestatus.com/feature/${baseFeature}">ChromeStatus</a></body></html>`;
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, mdnStubPage);
    const adv2Status = (await g("status", "--short")).trim();
    assert(
      "0n5s Case 9 (ADV2): git status shows MM for staged mutation with tolerated status decoy",
      adv2Status.includes("MM") && adv2Status.includes(probe),
    );
    current = await buildManifest({ root: scratch });
    assert(
      "0n5s Case 9 (ADV2): manifest reads staged index content (not worktree with status decoy)",
      current[0].identity === mutatedFeature,
    );
    evaluated = await evaluate(baselineManifest, current);
    assert(
      "0n5s Case 9 (ADV2): identity change with status decoy fails gate (escape closed)",
      evaluated.failures.length === 1 && mentions(evaluated, "identity changed"),
    );

    // Clean up probe for Case 10
    await g("checkout", "-f", "HEAD");

    // Case 10 (gendn-0n5s P1-B): Staged rename with old path restored on disk
    // git mv moves probe -> probe2 in index; old probe/index.html is restored on disk as untracked.
    // The reader must read the index deletion for the old route, failing gate without migration,
    // and passing gate with a reviewed move migration.
    const probe2 = `${probe}2`;
    await g("mv", probe, probe2);
    await Deno.mkdir(`${scratch}/${probe}`, { recursive: true });
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, probePage(baseFeature));
    const renameStatus = (await g("status", "--short")).trim();
    assert(
      "0n5s Case 10: git status shows staged rename (R ) and untracked restored old dir (??)",
      renameStatus.includes("R") && renameStatus.includes(probe2) &&
        renameStatus.includes(`?? ${probe}/`),
    );
    invalidateJudgedCache();
    current = await buildManifest({ root: scratch });
    assert(
      "0n5s Case 10: current manifest does NOT contain old route (index deletion detected)",
      !current.some((e) => e.id === probe),
    );
    evaluated = await evaluate(baselineManifest, current);
    assert(
      "0n5s Case 10: unmigrated staged rename with restored worktree fails gate",
      evaluated.failures.length === 1 && mentions(evaluated, `missing published id ${probe}`),
    );
    const migrated = await evaluate(baselineManifest, current, [{
      id: probe,
      action: "move",
      from: `/${probe}/`,
      to: `/${probe2}/`,
    }]);
    assert(
      "0n5s Case 10: staged rename with reviewed move migration passes gate",
      migrated.failures.length === 0,
    );

    // Clean up probe2 for Case 11
    await g("checkout", "-f", "HEAD");
    await g("clean", "-fd");

    // Case 11 (gendn-0n5s P0-1): Staged plain deletion with file left/restored on disk
    // git rm deletes probe/index.html from index, but file is re-created on disk (status D + ??).
    // The reader must read the index deletion, omit the route from current manifest, and fail gate.
    await g("rm", "-q", `${probe}/index.html`);
    await Deno.mkdir(`${scratch}/${probe}`, { recursive: true });
    await Deno.writeTextFile(`${scratch}/${probe}/index.html`, probePage(baseFeature));
    const deleteStatus = (await g("status", "--short")).trim();
    assert(
      "0n5s Case 11: git status shows staged deletion (D ) and untracked file on disk (??)",
      deleteStatus.includes("D ") && deleteStatus.includes("??"),
    );
    invalidateJudgedCache();
    current = await buildManifest({ root: scratch });
    assert(
      "0n5s Case 11: manifest omits route for file staged-deleted in index but on disk",
      !current.some((e) => e.id === probe),
    );
    evaluated = await evaluate(baselineManifest, current);
    assert(
      "0n5s Case 11: staged deletion with file on disk fails route gate",
      evaluated.failures.length > 0 && mentions(evaluated, `missing published id ${probe}`),
    );
    let errorNamedDeletion = false;
    try {
      const { readJudgedFile } = await import("./lib/judged-content.mjs");
      await readJudgedFile(`${probe}/index.html`, scratch);
    } catch (err) {
      errorNamedDeletion = /deleted from the git index but is still present on disk/.test(
        err.message,
      );
    }
    assert(
      "0n5s Case 11: readJudgedFile throws explicit message naming index deletion with file on disk",
      errorNamedDeletion,
    );
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}

if (failures) Deno.exit(1);
console.log(`route contract fixture: all ${passed} assertions passed`);
