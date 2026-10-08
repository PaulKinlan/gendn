// Transport-only retries for the live security-header fixture. A received HTTP response (even
// a 404 or one with bad headers) is final: only the caller judges its status and headers.
export const SECURITY_PROBE_BUDGET = {
  attemptTimeoutMs: 10_000, // Headers AND complete body on a CPU-starved host.
  totalTimeoutMs: 25_000, // Wall-clock ceiling for all attempts and backoff on one route.
  maxAttempts: 3,
  backoffBaseMs: 150,
  jitterMs: 100,
};

export class FixtureTransportError extends Error {
  constructor(url, kind, attempts, elapsedMs, cause) {
    super(
      `transport ${kind} (not a header failure): ${new URL(url).pathname} after ${attempts} ` +
        `attempt(s) in ${Math.ceil(elapsedMs)}ms; last error: ${cause?.name ?? "unknown"}: ` +
        `${cause?.message ?? "no response"}`,
      { cause },
    );
    this.name = "FixtureTransportError";
    this.kind = kind;
    this.attempts = attempts;
    this.elapsedMs = elapsedMs;
  }
}

export async function fetchSecurityProbe(url, options = {}) {
  const {
    attemptTimeoutMs = SECURITY_PROBE_BUDGET.attemptTimeoutMs,
    totalTimeoutMs = SECURITY_PROBE_BUDGET.totalTimeoutMs,
    maxAttempts = SECURITY_PROBE_BUDGET.maxAttempts,
    backoffBaseMs = SECURITY_PROBE_BUDGET.backoffBaseMs,
    jitterMs = SECURITY_PROBE_BUDGET.jitterMs,
    fetchFn = fetch,
  } = options;
  if (
    !Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs < 1 ||
    !Number.isFinite(totalTimeoutMs) || totalTimeoutMs < 1 ||
    !Number.isInteger(maxAttempts) || maxAttempts < 1 ||
    !Number.isFinite(backoffBaseMs) || backoffBaseMs < 0 ||
    !Number.isFinite(jitterMs) || jitterMs < 0
  ) throw new TypeError("security probe needs finite positive timeout and attempt bounds");

  const started = performance.now();
  const deadline = started + totalTimeoutMs;
  let lastError;
  let kind = "timeout";
  let attempts = 0;

  while (attempts < maxAttempts && performance.now() < deadline) {
    attempts++;
    const remainingMs = deadline - performance.now();
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const error = new DOMException("Security probe request deadline exceeded", "TimeoutError");
        controller.abort(error); // Also cancels a native fetch body read in progress.
        reject(error); // Bounds even a fetch implementation that ignores the abort signal.
      }, Math.min(attemptTimeoutMs, remainingMs));
    });

    try {
      const response = await Promise.race([fetchFn(url, { signal: controller.signal }), timeout]);
      // Consume the body within the SAME attempt deadline. Never return truncated content.
      const text = await Promise.race([response.text(), timeout]);
      return { response, text, attempts, elapsedMs: performance.now() - started };
    } catch (error) {
      controller.abort();
      if (
        !timedOut && error?.name !== "TimeoutError" && error?.name !== "AbortError" &&
        !(error instanceof TypeError)
      ) throw error; // An assertion/programming error is not a transient transport failure.
      lastError = error;
      kind = timedOut || error?.name === "TimeoutError" ? "timeout" : "transport";
    } finally {
      clearTimeout(timer);
    }

    const remaining = deadline - performance.now();
    if (attempts >= maxAttempts || remaining <= 0) break;
    const jitter = jitterMs ? Math.floor(Math.random() * jitterMs) : 0;
    const backoff = Math.min(backoffBaseMs * 2 ** (attempts - 1) + jitter, remaining);
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }

  throw new FixtureTransportError(url, kind, attempts, performance.now() - started, lastError);
}
