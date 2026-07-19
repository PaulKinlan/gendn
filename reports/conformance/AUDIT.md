# gendn conformance + critique lifecycle — seed audit (2026-07-19)

Exact denominators from the first full pass. Nothing here is rounded or aspirational; the numbers are
produced by `deno task conformance` (headless Chrome), `deno task responsive`, and the gates. The
routine burns the backlog down wave by wave — this is a seed, not a claim of completeness.

## Coverage denominators

| Metric | Count |
| --- | --- |
| Published pages | **155** (123 built · 32 stub) |
| Conformance suites | **155 / 155** (100%) |
| Critiques (`_questions.json`) | **8 / 155** (seed sample) |
| Desktop matrix `ok` (agent-reviewed) | **3 / 155** |
| Mobile matrix `ok` (agent-reviewed) | **3 / 155** |
| Responsive auto-scan `needs-review` | 152 / 155 desktop · 152 / 155 mobile |
| Responsive `broken` | **0** |
| Responsive `untested` | **0** (auto-scan covered all 155) |
| Goals in backlog | **8** (from 8 critiques) |

## Conformance run (2026-07-19, headless Chrome, deterministic)

Total assertions **3563** across 155 suites:

- **pass: 2767**
- **fail: 21** (real doc-quality gaps — the backlog)
- **blocked: 775** (manual-evidenced: source/screenshot review; explicit, never counted as a pass —
  5 per page × 155)

### The 21 real failures (18 pages) — targeted-fix backlog

- `browser-support-section` ×6 — no cross-browser support/Baseline section:
  v147/csspseudoelement-support-for-backdrop-scroll-marker-and-view-transitions,
  v147/document-policy-in-dedicated-workers, v147/js-profiling-in-dedicated-workers,
  v147/local-network-access-restrictions, v147/x25519kyber768-key-encapsulation-for-tls,
  v148/html-in-canvas.
- `example-surface-present` ×9 — built (non-removal) page with no code example or embed:
  v147/device-bound-session-credentials, v147/document-policy-in-dedicated-workers,
  v147/local-network-access-restrictions-for-websockets,
  v147/local-network-access-restrictions-for-webtransport,
  v147/local-network-access-restrictions-on-service-worker-windowclient-navigate,
  v147/local-network-access-restrictions, v147/x25519kyber768-key-encapsulation-for-tls,
  v148/agentic-federated-login, v150/pwa-origin-migration.
- `warn-block-experimental` ×6 — origin-trial / flag feature missing the mandatory `.warn-block`
  (invariant #7): v148/extended-lifetime-shared-workers, v148/web-authentication-immediate-ui-mode,
  v150/capability-elements-usermedia-mvp, v150/focusgroup, v150/out-of-order-streaming,
  v150/softnavigation-performance-entry.

These are fixed **in the page** (add the missing section / example / warn-block), never by weakening
the immutable assertion. Three of them (html-in-canvas, device-bound-session-credentials,
extended-lifetime-shared-workers) have seed critiques + goals; the rest are in
`reports/conformance/results.json` for the routine to pick up.

## Immutability enforcement (verified)

- `deno task validate-artifacts` recomputes each suite's `suiteHash` (sha256 of normalized
  assertions). Tampering an assertion's text without regenerating the hash is caught (tested:
  editing one `describe` produced a suiteHash mismatch failure).
- `deno task check-conformance` diffs each suite's assertions against `origin/main`; a removed or
  changed assertion without an `assertion-migrate` record in `migrations.json` fails the gate.
  Adding assertions (growing coverage) is always allowed.

## chrome-platform-showcase (CPS) linkage

Where a page embeds a CPS demo (49 pages have a showcase demo link), its suite carries a `cpsFeature`
object pointing at the canonical CPS conformance contract (e.g. `/v149/webmcp/conformance` on the
showcase host). gendn **references** that contract for platform BEHAVIOR and keeps only DOC-QUALITY
assertions locally — it never forks or contradicts CPS's assertions.

## Commands

```bash
deno task gen-conformance      # write missing suites (immutable; never overwrites)
deno task conformance          # headless-Chrome run-all → reports/conformance/{results.json,index.html}
deno task conformance --page v<N>/<slug>          # per-page gate (don't push red)
deno task responsive --update-support             # mobile+desktop scan → responsive-support.json
deno task build-goals          # roll critique followUpGoals → goals.json
deno task validate-artifacts   # schema + suiteHash
deno task check-conformance    # coverage + immutability gate
deno task check-routes         # durable-demo route gate (now reports support coverage too)
```
