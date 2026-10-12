// @fixture-permissions --allow-read
// The real http-status request seam: reject malformed paths before fetch, preserve manual 301s,
// cancel bodies without reading, and abort a hung request within its bound.
import { assertionHttpStatus } from "./conformance.mjs";

let passed = 0;
function assert(name, ok) {
  if (!ok) throw new Error(`FAIL ${name}`);
  passed++;
}

const originalFetch = globalThis.fetch;
const calls = [];
let cancels = 0;
try {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { status: 301, body: { cancel: async () => cancels++ } };
  };
  const base = "http://localhost:43210";
  assert(
    "valid route preserves 301 and manual redirect, consumes no response body",
    await assertionHttpStatus(base, "/v149/webmcp/") === 301 &&
      calls[0].url === `${base}/v149/webmcp/` && calls[0].options.redirect === "manual" &&
      calls[0].options.signal instanceof AbortSignal && cancels === 1,
  );
  for (
    const path of [
      "",
      "v149/webmcp/",
      "//evil.example/x",
      "https://evil.example/x",
      "/https://evil.example/x",
      "/v149/webmcp/?x=1",
      "/v149/webmcp/#fragment",
      "/\\evil.example/x",
      "/x\ny",
      null,
    ]
  ) {
    const before = calls.length;
    let error;
    try {
      await assertionHttpStatus(base, path);
    } catch (err) {
      error = err;
    }
    assert(
      `malformed pathname ${JSON.stringify(path)} fails loudly without requesting`,
      error?.message.includes("invalid http-status assertion pathname") && calls.length === before,
    );
  }
  globalThis.fetch = (_url, { signal }) => {
    calls.push({ signal });
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  let error;
  let deadline;
  try {
    await Promise.race([
      assertionHttpStatus(base, "/v149/webmcp/", { timeoutMs: 50 }),
      new Promise((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("UNBOUNDED: fetch did not abort")), 1000);
      }),
    ]);
  } catch (err) {
    error = err;
  } finally {
    clearTimeout(deadline);
  }
  assert("hung fetch aborts before fixture deadline", error?.name === "TimeoutError");
} finally {
  globalThis.fetch = originalFetch;
}
console.log(`conformance http-status fixture: ${passed} assertions passed`);
