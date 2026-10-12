// @fixture-permissions --allow-read --allow-net=127.0.0.1,localhost --allow-env
// gendn-gne9: malformed features_by_type root and group lists must not 502 a release page.
// For red-path evidence only: EXPECT_RELEASE_502=1 proves the two pre-fix 502s on main.
const XSSI = ")]}'";
const cases = new Map([
  [150, { features_by_type: null }],
  [151, {
    features_by_type: {
      "Enabled by default": null,
      "Origin trial": [{ id: 102, name: "Control feature", summary: "kept" }],
    },
  }],
  [152, {}],
  [153, { features_by_type: { "Enabled by default": "not a list" } }],
]);
const stub = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
  const json = (value) =>
    new Response(`${XSSI}\n${JSON.stringify(value)}`, {
      headers: { "content-type": "application/json" },
    });
  if (url.pathname === "/channels") {
    return json({
      stable: { mstone: 150 },
      beta: { mstone: 151 },
      dev: { mstone: 153 },
    });
  }
  if (url.pathname === "/features") {
    return json(cases.get(Number(url.searchParams.get("milestone"))) ?? { features_by_type: {} });
  }
  return json({ features_by_type: {} });
});
Deno.env.set("CHROMESTATUS_BASE", `http://127.0.0.1:${stub.addr.port}`);
const { handleRequest } = await import("../server.ts");
let failed = 0;
function assert(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
try {
  const red = Deno.env.get("EXPECT_RELEASE_502") === "1";
  for (
    const [milestone, label] of [
      [150, "null root"],
      [151, "null list"],
      [152, "missing root"],
      [153, "non-array list"],
    ]
  ) {
    const res = await handleRequest(new Request(`http://localhost/v${milestone}/`));
    const html = await res.text();
    assert(
      `${label}: /v${milestone}/ status ${res.status} (expected ${red ? 502 : 200})`,
      res.status === (red ? 502 : 200),
    );
    if (!red) {
      assert(
        `${label}: rendered an honest release page`,
        html.includes(`chrome ${milestone} reference`) && html.includes("features ("),
      );
      if (milestone === 151) {
        assert(
          "null list skipped but valid sibling preserved",
          html.includes("Control feature") && html.includes("features (1)"),
        );
      } else {
        assert(`${label}: zero features instead of a 502`, html.includes("features (0)"));
      }
    }
  }
  if (!red) {
    const catalogue = await handleRequest(new Request("http://localhost/features"));
    assert("catalogue remains available with malformed groups", catalogue.status === 200);
    await catalogue.body?.cancel();
  }
} finally {
  await stub.shutdown();
}
if (failed) Deno.exit(1);
console.log("upstream-group-shape fixture: all assertions passed");
