// gendn-7xq: route-derived values are escaped at interpolation; malformed request URLs are handled.
import { crossReferenceTag, handleRequest, referenceTag, renderIndex } from "../server.ts";

let failures = 0;
function assert(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failures++;
}
const evil = `x"><script>alert(1)</script>`;
for (
  const [name, html] of [
    ["referenceTag release", referenceTag(evil, "ok")],
    ["referenceTag slug", referenceTag("v1", evil)],
    ["crossReferenceTag", crossReferenceTag(`/v1/${evil}/`)],
  ]
) {
  assert(
    `${name}: no raw <script> or quote breakout`,
    !html.includes("<script>") && !html.includes('x">'),
  );
  assert(`${name}: escaped form present`, html.includes("&lt;script&gt;"));
}
assert(
  "honest slug renders unchanged",
  referenceTag("v150", "foo-bar") ===
    '<a class="tag tag-live" href="/v150/foo-bar/">reference &rarr;</a>',
);
const bad = await handleRequest({ url: "not a url" });
assert("malformed request URL returns handled 400", bad.status === 400);

// gendn-sxn: milestone values from channels are narrowed; hostile milestone values fall back to '#' without attribute breakout
const hostileChannels = {
  dev: { mstone: '1" onmouseover="alert(1)', version: 151, branch_point: "", stable_date: "" },
  beta: { mstone: 150, version: 150, branch_point: "", stable_date: "" },
  stable: { mstone: 149, version: 149, branch_point: "", stable_date: "" },
};
const indexHtml = await renderIndex(hostileChannels);
assert(
  "renderIndex: hostile milestone does NOT inject onmouseover attribute into href",
  !indexHtml.includes('href="/v1" onmouseover') && indexHtml.includes('href="#"'),
);
assert(
  "renderIndex: hostile milestone label is escaped, no unescaped quote breakout",
  indexHtml.includes("&quot; onmouseover=&quot;alert(1)"),
);

if (failures) Deno.exit(1);
console.log("server-escape fixture: all assertions passed");
