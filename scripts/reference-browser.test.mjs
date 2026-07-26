import { validateReferenceContractsInBrowser } from "./lib/reference-browser.mjs";
import { REQUIRED_DIMENSIONS } from "./lib/reference-contract.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sourceUrl = "https://example.com/reference-browser-spec";
const milestone = "v2147483647";
const nonce = crypto.randomUUID().slice(0, 8);
const ids = [
  `${milestone}/reference-browser-visible-${nonce}`,
  `${milestone}/reference-browser-hidden-${nonce}`,
];
try {
  const records = [];
  for (const ownerId of ids) {
    const hidden = ownerId.includes("-hidden-");
    try {
      await Deno.stat(ownerId);
      throw new Error(`refusing to overwrite existing browser-test fixture path ${ownerId}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.mkdir(`${ownerId}/member`, { recursive: true });
    await Deno.writeTextFile(
      `${ownerId}/index.html`,
      `<!doctype html><title>Fixture</title><h1>Fixture</h1>`,
    );
    await Deno.writeTextFile(
      `${ownerId}/member/index.html`,
      `<!doctype html><title>Member</title><main><section id="contract" style="${
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

  const errors = await validateReferenceContractsInBrowser(records);
  assert(
    errors.some((error) =>
      error.includes("reference-browser-hidden") && error.includes("not visibly rendered")
    ),
    `opacity-zero documentation passed browser visibility validation:\n${errors.join("\n")}`,
  );
  assert(
    !errors.some((error) => error.includes("reference-browser-visible")),
    `visible documentation failed browser visibility validation:\n${errors.join("\n")}`,
  );
  console.log("PASS — reference-contract browser visibility tests");
} finally {
  for (const ownerId of ids) {
    await Deno.remove(ownerId, { recursive: true }).catch(() => {});
  }
  // Remove only the now-empty milestone directory; never recursively delete shared work.
  await Deno.remove(milestone).catch(() => {});
}
