// gendn-7xq: route-derived values are escaped at interpolation; malformed request URLs are handled.
import { crossReferenceTag, handleRequest, referenceTag } from "../server.ts";

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
if (failures) Deno.exit(1);
console.log("server-escape fixture: all assertions passed");
