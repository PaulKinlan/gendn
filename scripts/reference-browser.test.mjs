// @fixture-permissions --allow-read --allow-write --allow-run --allow-net --allow-env
import { validateReferenceContractsInBrowser } from "./lib/reference-browser.mjs";
import { REQUIRED_DIMENSIONS } from "./lib/reference-contract.mjs";
import { CHECKOUT_ROOT, createPrivateServedRoot } from "./lib/private-root.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sourceUrl = "https://example.com/reference-browser-spec";
// gendn-sxn: milestonePathSegment bounds Chrome milestones to 1..9999 (/^[1-9][0-9]{0,3}$/);
// extreme-value v2147483647 is rejected as invalid by server.ts. Use valid high milestone v9998.
const milestone = "v9998";
const nonce = crypto.randomUUID().slice(0, 8);
const ids = [
  `${milestone}/reference-browser-visible-${nonce}`,
  `${milestone}/reference-browser-hidden-${nonce}`,
  `${milestone}/reference-browser-mobile-only-${nonce}`,
];
// PRIVATE served root (gendn-gvoq): the fixture pages are written into a disposable --shared clone
// pinned to origin/main and the server is started with that clone as its cwd. The fixture used to
// synthesize `<checkout>/v9998/**` and serve the checkout itself, which is shared writable state:
// the CSS-drift fixture (and any agent) could delete or collide with these pages mid-run, and a
// SIGKILL left debris inside the shared milestone. Nothing here names a checkout path.
const root = await createPrivateServedRoot({ prefix: "gendn-reference-browser" });
try {
  const records = [];
  for (const ownerId of ids) {
    const hidden = ownerId.includes("browser-hidden");
    const mobileOnly = ownerId.includes("browser-mobile-only");
    // Refuse to overwrite: a path this fixture owns must not already exist, even inside a fresh root.
    try {
      await Deno.stat(`${root.root}${ownerId}`);
      throw new Error(`refusing to overwrite existing browser-test fixture path ${ownerId}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.mkdir(`${root.root}${ownerId}/member`, { recursive: true });
    await Deno.writeTextFile(
      `${root.root}${ownerId}/index.html`,
      `<!doctype html><title>Fixture</title><h1>Fixture</h1>`,
    );
    await Deno.writeTextFile(
      `${root.root}${ownerId}/member/index.html`,
      `<!doctype html><meta name="viewport" content="width=device-width"><title>Member</title>${
        mobileOnly ? "<style>@media (max-width: 500px) { #contract { display: none } }</style>" : ""
      }<main><section id="contract" style="${
        hidden ? "opacity: 0" : "opacity: 1"
      }"><h1>Member reference</h1><p>This visible implementation section contains enough substantive explanatory text for validation.</p><pre><code>runExample()</code></pre><table><tr><th>Browser</th><td>Test</td></tr></table><a href="${sourceUrl}">Normative source</a></section></main>`,
    );
    const dimensions = Object.fromEntries(REQUIRED_DIMENSIONS.map((dimension) => [
      dimension,
      { status: "documented", selector: "#contract", sourceRefs: ["spec"] },
    ]));
    records.push({
      ownerId,
      path: `${ownerId}/reference-contract.json`,
      contract: {
        id: ownerId,
        sources: [{ id: "spec", url: sourceUrl }],
        inventory: [{ id: "member", sourceRefs: ["spec"] }],
        documentation: [{ inventoryId: "member", href: "member/", dimensions }],
      },
    });
  }

  const errors = await validateReferenceContractsInBrowser(records, { cwd: root.root });
  assert(
    errors.some((error) =>
      error.includes("reference-browser-hidden") && error.includes("not visibly rendered")
    ),
    `opacity-zero documentation passed browser visibility validation:\n${errors.join("\n")}`,
  );
  assert(
    errors.some((error) =>
      error.includes("reference-browser-mobile-only") && error.includes("on mobile")
    ),
    `mobile-only hidden documentation passed the mobile visibility gate:\n${errors.join("\n")}`,
  );
  assert(
    !errors.some((error) => error.includes("reference-browser-visible")),
    `visible documentation failed browser visibility validation:\n${errors.join("\n")}`,
  );
  // The checkout is never written to, by name: none of this run's fixture paths exist there.
  for (const ownerId of ids) {
    let exists = true;
    try {
      await Deno.stat(`${CHECKOUT_ROOT}${ownerId}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      exists = false;
    }
    assert(!exists, `fixture wrote into the checkout: ${ownerId}`);
  }
  console.log("PASS — reference-contract browser visibility tests");
} finally {
  // One removal, of the root this fixture created: no shared milestone is ever touched.
  await root.remove();
}
