# THREAT MODEL: gendn

_Scope: the `gendn` reference-documentation repository (PaulKinlan/gendn). This file is the
canonical source for the invariant numbers that source comments cite (`THREAT_MODEL.md
invariant #7` in `lib/mdn.ts` and `scripts/mdn-has.test.mjs`; `invariant #8` in
`lib/external-url.ts` and `lib/html.ts`). A guard fixture
(`scripts/threat-model-citations.test.mjs`, task `test-threat-model-citations`) fails if a cited
invariant number stops resolving in this document or if #7/#8 lose the phrases the citing
comments depend on. The guard's scanned surface is `lib/**`, `scripts/**` (recursive) and
`server.ts`; citations placed in other paths (`.claude/`, `.github/`, `CLAUDE.md`, the content
tree) are NOT resolved by it — stated here so the coverage claim is exactly as wide as the
code._

**Provenance.** Reconstructed from the software-factory threat-model station's rescued draft
(run `threat-model-gendn-merger-20261006-141239`, output rejected on a schema field-name
mismatch, content recovered), then audited invariant-by-invariant against the code on
2026-10-06 (gendn-zoq). The audit corrected three draft claims, recorded here so the next
reader does not re-believe them:

1. The draft said the server makes "exactly two outbound fetches" — it makes **three**
   (chromestatus.com, a developer.mozilla.org HEAD existence check, api.github.com).
2. The draft scoped itself to "repository `gendn-merger`" — that is a factory lane name, not
   the repository.
3. The draft listed "the `modern-web-guidance` npm package … fetched at run time" as a
   dependency surface — `deno.json` HAS NO `imports` KEY AT ALL (absent, not empty) and
   `server.ts`/`lib/*.ts` import no third-party modules; the package is referenced only as
   guidance text inside lifecycle views.
4. The draft's finding TM-1 (and this document's first draft, copying it) named THREE unescaped
   id-to-href sinks; audit of the third found `lib/lifecycle.ts` ESCAPES its identity
   interpolation (`esc(s.identity)`, a full escaper) — so it is not an unescaped sink and was
   removed from that list. At the audit it was reclassified escaped-but-un-narrowed; SINCE the
   b2s fix landed it is NARROWED by `chromeStatusUrl()` (§4.1) — a classification went stale
   through a COMBINATION of branches, the shape behind rule 123's stronger case: a rebase can
   invalidate a FACT, not only a gate verdict. A reader who saw the earlier three-sink claim
   (the station output, the gendn-b2s bead) needs to know it was corrected here, not silently
   edited — and that its correction has itself been updated against the merged tree.

## 1. System Overview & Architecture

gendn is a **read-only, server-rendered reference-documentation site** for web-platform APIs
that ship in Chrome but are not yet documented on MDN, plus an **autonomous authoring routine**
that writes the pages.

Components:

- **HTTP server — `server.ts`.** A Deno `Deno.serve` process (default port 3000) with no
  authentication and no write endpoints. Routes: `/`, `/features`, `/v<N>/`, `/v<N>/<slug>/` and
  deep assets, `/public/*`, `/conformance`, `/conformance/run-all`, and
  `/v<N>/<slug>/(conformance|critique)`. It reads page/asset files from disk, renders
  release/catalogue pages from live chromestatus data, reads `migrations.json` at startup to
  build 301 redirects, and wraps every response (including error paths) in
  `addSecurityHeaders`. Outbound fetches from the running server: chromestatus.com (via
  `lib/chromestatus.ts`), a HEAD existence check against developer.mozilla.org (via
  `lib/mdn.ts`), and `api.github.com` for the last-commit line — all three through
  `fetchBounded()`.
- **Upstream wrapper — `lib/chromestatus.ts`.** Wraps `chromestatus.com/api/v0`, strips the
  XSSI `)]}'` prefix, parses JSON, caches in memory with a 5-minute TTL. All outbound calls go
  through `fetchBounded()` (15 s timeout + 8 MiB streaming cap). `CHROMESTATUS_BASE` is an
  import-time test seam; production never sets it.
- **Escaping/scheme seams — `lib/html.ts`, `lib/external-url.ts`.** `escapeHTML` encodes
  `& < > " '` only (encoding, **not** URL-scheme validation). `safeExternalUrl` is an http/https
  allowlist used by `renderCommitAnchor`; an unsafe GitHub `html_url` renders as plain text
  rather than a live link.
- **Lifecycle SSR — `lib/lifecycle.ts`.** Renders `conformance.json` / `_questions.json` /
  `reports/conformance/results.json` into read-only HTML views. Verdict status is whitelisted
  (`pass|fail|blocked`, else `n/a`) before it reaches a CSS class attribute.
- **Content tree — `v<N>/<slug>/index.html` plus lifecycle artifacts.** Authored by the
  routine. There is no registry; the filesystem layout *is* the catalogue. `conformance.json`
  suites are immutable + `suiteHash`-pinned.
- **Gate/runner tooling — `scripts/`.** Route/manifest gates (`check-routes.mjs`,
  `route-manifest.mjs`), conformance + responsive runner (`conformance.mjs`) which boots the
  server and drives **headless Chrome over the DevTools Protocol** (`scripts/lib/cdp.mjs`),
  browser-backed reference-contract validation (`scripts/lib/reference-browser.mjs`), artifact
  validators, font vendoring (`vendor-fonts.mjs`), and the fixture aggregate
  (`run-fixtures.mjs`) that spawns every `test-*` task and sweeps `/proc` for token-attributed
  descendants on timeout. Git calls are centralised through the bounded
  `scripts/lib/bounded-git.mjs`.
- **CI — `.github/workflows/ci.yml`** (type/format, route gate, conformance gate,
  verdict-emission self-test, full fixture suite) and **`.github/workflows/fetch-data.yml`**
  (fetches chromestatus JSON into `_data/` and commits it to `main` with `contents: write`).
- **Routine — Claude Code, cron `30 */2 * * *`** (CLAUDE.md), fresh checkout of `main`, one
  commit per feature, pushes directly to `main`.
- **Runtime:** Deno (Deno Deploy or a local/CI process); no database, no user accounts, no
  server-side session state, **no third-party runtime dependencies** (`deno.json` has no
  `imports` key).

## 2. Trust Boundaries & Actors

| Actor | Trust | Notes |
| --- | --- | --- |
| **System Owner / Developer** (Paul Kinlan) | Trusted | Owns `server.ts`, `lib/`, `public/`, `deno.json`, CI, the routine prompt. |
| **Autonomous routine agent** | Semi-trusted / content-authoring | Writes `v<N>/` page HTML, `conformance.json`, `_questions.json`, `reference-contract.json`. Its output is treated as potentially adversarial markup (invariant #4) — the *trust boundary is the authored HTML*, not the agent's intent. |
| **End user / browser** | Untrusted for input, trusted reader | Supplies arbitrary request paths and query strings; reads responses. No privileged action is possible from the request. |
| **chromestatus.com API** | Untrusted data source | External JSON (`id`, `name`, `summary`, `category`, channels, dates) fed directly into SSR templates. |
| **api.github.com** | Untrusted data source | `html_url` / `sha` / `date` feed the "last updated" line. |
| **developer.mozilla.org** | Untrusted availability signal | HEAD existence checks; a transport failure must read as UNKNOWN, not "no page". |
| **chrome-platform-showcase.paulkinlan-ea.deno.net** | Untrusted framed content | Third-party interactive demos embedded via `<iframe>`; also referenced by lifecycle contracts. |
| **fonts.googleapis.com / fonts.gstatic.com** | Untrusted asset origin | Only reached by the offline `vendor-fonts.mjs` vendoring script, not at request time. |
| **Local repo / worktree** | Trusted | `migrations.json`, `deno.json`, schemas, and CI scripts are operator-controlled. |
| **Loopback server in gates** | Trusted | The gate server binds an ephemeral OS port on localhost and is only driven by the local runner. |
| **Local tooling (git, Chrome, `ps`, `setsid`, `/proc`)** | Trusted mechanism, hazardous lifecycle | Bounded and guarded, but capable of orphan processes / hangs if unbounded. |

Boundaries crossed:

1. **HTTP request → server** (path/query/URL parsing).
2. **Server → external JSON APIs** (chromestatus, GitHub) and **server → MDN** (HEAD checks)
   and **server → repo filesystem** (static pages/assets).
3. **Gate runner → local server + headless Chrome** (CDP; untrusted page content on a loopback
   origin).
4. **Gate runner → OS process table** (`git`, Chrome profile dirs, `/proc` token sweep).
5. **CI → `main`** (routine/agent commits; `fetch-data.yml` commits upstream data).

## 3. Explicitly Trusted (Non-Threats)

Audits **must not** flag the following as vulnerabilities:

- **`migrations.json`** and the 301 redirect logic (`redirectTarget`). It is operator-controlled
  config. A `from`/`to` value can't be attacker-supplied; the query string is appended to a
  same-origin `Location`.
- **`CHROMESTATUS_BASE` / test seams** (`mdnHas` `base`/`timeoutMs`, `reference-browser` server
  port, `--limit`). Test-only; production code paths never set them.
- **The loopback server spawned by gates** on an OS-assigned ephemeral port. Localhost ports are
  inside the machine trust boundary.
- **`--allow-all` on the fixture aggregate (`run-fixtures.mjs`).** Deliberate and justified:
  reading `/proc/<pid>/environ` for token attribution requires `--allow-all`; the aggregate
  already holds `--allow-run`; each fixture keeps only its declared flags.
- **`--no-sandbox` for the gate Chrome.** Deliberate (unguarded user namespaces are unavailable
  in common CI containers); the compensating control is the navigation whitelist + final-origin
  re-checks + lazy below-the-fold iframes (see §7).
- **In-memory TTL caches** (chromestatus 5 min, MDN 1 h, GitHub commit 5 min).
- **Static same-origin content** under `v<N>/`, `public/`, and the generated
  `reports/conformance/index.html`, as authored/controlled by the pipeline.
- **Developer test suites** and the local git repository.

## 4. Untrusted Attack Surfaces

1. **chromestatus.com JSON → SSR.** `name`, `summary`, `category`, `id` and channel/date fields
   are rendered. Most are escaped; `id` WAS interpolated raw into two href sinks in `server.ts`
   (`renderReleasePage`, `renderFeaturesCatalogue`) — finding TM-1, bead `gendn-b2s`, FIXED AND
   LANDED: `lib/chromestatus.ts` `chromeStatusUrl()` narrows the id at runtime to a canonical
   safe-integer digit string (both arrival types face the same two bounds), and a non-canonical
   id renders the feature name as plain text instead of a link. `milestonePathSegment()` applies
   the same shape to milestone values (`gendn-sxn`, landed). The seam-behaviour fixtures drive
   hostile ids through every rendered seam and assert on the output HTML
   (`scripts/chromestatus-units.test.mjs`). A third href site — `lib/lifecycle.ts`
   `renderConformanceIndex` — was ESCAPED (`esc(s.identity)`) but un-narrowed AT THE TIME OF
   THE FINDING: an encoding-only site cannot emit a hostile attribute, but it can emit a
   well-formed link to a malformed identity (identity-validity, not injection). Since the same
   b2s work landed, that site is NARROWED: `chromeStatusUrl(s.identity)` from
   `lib/chromestatus.ts`, the same runtime bound and the same plain-text fallback for a
   non-canonical identity. The current tree carries no un-narrowed sink of this class.
2. **`api.github.com` commit JSON → "last updated" line.** `html_url` is the historic
   scheme-injection sink (fixed by `lib/external-url.ts`); `sha`/`date` are escaped.
3. **Repo-authored page HTML served same-origin.** A `<script>` or injected attribute in a
   `v<N>/<slug>/index.html` executes on gendn's origin. CSP `script-src 'self' 'sha256-…'`
   blocks inline scripts and off-origin scripts; `'self'` still permits same-origin script URLs.
4. **Lifecycle JSON artifacts → SSR.** `conformance.json`, `_questions.json`, `results.json` are
   runner/agent-written but are parsed and rendered; a corrupt/hostile verdict previously
   reached a CSS class attribute (fixed by whitelisting, invariant #9).
   `reports/conformance/index.html` is served byte-exact.
5. **Third-party showcase iframes.** Cross-origin frames on the page; hardened with
   `sandbox`/`referrerpolicy` (applied across the catalogue by the iframe-posture guard;
   a small number of pages deliberately deferred, recorded on the bead history).
6. **HTTP request path.** Malformed URLs must 400 (not throw); route-derived values must be
   escaped; `..` must not traverse.
7. **Browser-driven navigation in gates.** The page under test can redirect (`goto` re-checks
   the final URL) or navigate itself (`evaluate` re-checks before each read); subframe/popup
   navigation and leave-and-return are out of sight (accepted, §7).
8. **Process environment / `/proc`.** The fixture runner reads descendants'
   `/proc/<pid>/environ`; a deliberately cleared environment can bypass the recursion guard
   (bounded accidental recursion, not a hostile fixture).
9. **Declared external runtime dependencies.** None: `deno.json` has no `imports` key and the
   server/lib code imports no third-party modules. Upstream *data* (chromestatus, GitHub, MDN)
   is the dependency surface, covered above.

## 5. Bug-Shape Hints from History

| Shape | Concrete past instance | Verification question |
| --- | --- | --- |
| **Attribute injection via incompletely escaped text** | A `"quoted phrase"` in a feature summary closed the `data-search` attribute and let a `<script>` in the same summary execute (fix `cf02076`; invariant #4). | Are *all* dynamic fields in *every* attribute escaped — not just the ones that bit last time? |
| **Attribute injection via an un-whitelisted enum in a class name** | Unwhitelisted verdict `status` reached `class="v v-${state}"`; a permissive `esc`-bypassing interpolation (`gendn-lny`, `dcd2758d4d`). | Is every value interpolated into an attribute that `esc()` does not cover drawn from a closed allowlist? |
| **URL-scheme injection into `href`/`src`** | GitHub `html_url` stored verbatim and rendered as `javascript:`/`data:` link (fixed by the http/https **allowlist** `external-url.ts`, `gendn-0cu`). | Are all externally sourced URLs scheme-validated (allowlist, not blocklist) at the render seam? |
| **Unescaped route-derived values** | Route names embedded in links (`gendn-7xq`, `f543822038`). | Is the fix applied to *all* interpolations, including numeric-looking upstream ids? |
| **Unbounded outbound fetch / hang** | Bare `fetch()` in `lib/mdn.ts` was the last unbounded call (`gendn-5fk`); `fetchBounded` (timeout + byte cap) is now mandatory (invariant #7). | Does every new outbound fetch carry a timeout **and** a streaming byte cap? |
| **Path traversal in static serving** | `readPublicAsset` / `readReleaseAsset` `..` guards (`gendn-d7a`) — defence-in-depth on top of URL normalisation. | Does any new file-serving route normalise *and* explicitly reject `..`? |
| **SSRF / over-broad gate navigation** | Gate Chrome runs `--no-sandbox`; navigation was bounded to localhost only and the final origin asserted (`gendn-8na`, `gendn-8ph`). | Is every `goto`/`evaluate` preceded or followed by a local-origin assertion? |
| **Process orphan / unbounded recursion in fixtures** | The aggregate must bound nested runs and sweep detached (`setsid`) descendants by token; a partial scan must report UNKNOWN, never zero (`gendn-ebf/r3b`, `c99c78a44a`). | Does every spawn have a hard bound, a kill path, and an honest survivor count? |
| **Unbounded git call** | `git … .output()` could hang on object-store contention or a forked auto-gc holding stdout (`gendn-8q2`, `gendn-1tu`). | Does every gate shell-out go through `bounded-git.mjs`? |
| **Missing browser security headers** | No CSP/nosniff/Referrer-Policy until `gendn-5tk` (`4af56e43b4`). | Do new response paths still pass through `addSecurityHeaders`? |
| **Tooling that is green but never invoked** | Fixture tasks existed but no gate ran them until `gendn-cp7`. | Is every new guard reachable from a gate? |
| **Citation to a document that does not exist** | Source comments cited `THREAT_MODEL.md` invariants #7/#8 while the file was absent (`gendn-zoq`); the guard fixture now fails if a cited number stops resolving. | Does every numbered contract a comment defers to exist and still say what the comment claims? |

## 6. Security Invariants for Auditors

Each invariant carries its enforcement anchor (file + symbol, not line numbers — lines rot).
#7 and #8 are the numbers source comments already cite; #1–#6 renumber the CLAUDE.md critical
invariants; #9–#13 were observed in code and are numbered here for the first time. Phrase note,
deliberately HERE rather than inside entry #7: the pair lib/mdn.ts defers to is “timeout and
byte bound”; scripts/mdn-has.test.mjs cites the same invariant in its own words (“no timeout
and no size bound”). A quoted copy of the phrase inside the entry would let the guard’s
phrase-detector pass with the operative sentence deleted (measured: the M3 mutation stopped
firing when this note lived inside #7), so the entry must carry the phrase exactly once.

**Content identity & integrity (from CLAUDE.md critical invariants):**

1. **Identity.** Every page carries its `chromestatus.com/feature/<id>` link; published
   slugs/IDs/routes are append-only and an id must never be repointed to another feature.
   _Anchors: CLAUDE.md "Append-only identities" / "Slug source"; per-suite
   `chromestatus-identity-link` conformance assertions._
2. **Milestone gating.** Placement derives from the milestone listing position only, never from
   `shipping_year`/browser fields. _Anchor: CLAUDE.md §1 "Slug source: milestone listing, not
   feature detail"._
3. **Self-heal link.** Every page must include the chromestatus feature link so slug damage is
   recoverable by the fix-slugs routine. _Anchors: CLAUDE.md "The self-heal";
   `.claude/fix-slugs.py` + its conservation fixture (`scripts/fix-slugs.test.mjs`)._
4. **Attribute escaping.** `escapeHTML` escapes `& < > " '`, and every dynamic value in an
   attribute or element context must pass through it (or an equivalent). Never rely on a value
   being "numeric". _Anchors: `lib/html.ts` `escapeHTML`; history `cf02076`; violation TM-1
   (`gendn-b2s`) FIXED AND LANDED — runtime narrow per the §4.1 disposition, not escaping._
5. **CSS/WCAG.** Pages use the design-token CSS variables with WCAG AA contrast; inspect without
   weakening. _Anchor: CLAUDE.md §5 "CSS variables, never raw hex, WCAG AA"._
6. **MDN matching.** If MDN coverage is ambiguous, generate a page rather than mis-redirect.
   _Anchor: CLAUDE.md MDN-check step._
7. **Bounded outbound fetches.** Every non-test outbound `fetch()` (from `lib/` and
   `server.ts`) must carry the same timeout and byte bound as every other outbound fetch in the
   repo — via `fetchBounded()` (15 s `AbortSignal.timeout` + 8 MiB streaming cap) — or be
   loopback-only (gate tooling against the local server), or be on an explicit allowlist. A new
   bare non-loopback `fetch(` is a finding. _Anchors: `lib/chromestatus.ts` `fetchBounded` and
   its call sites (`lib/mdn.ts` `mdnHas`, `server.ts` last-commit fetch); loopback exception:
   `scripts/conformance.mjs`, `scripts/iframe-posture-sweep.mjs`, `scripts/lib/cdp.mjs`,
   `scripts/lib/reference-browser.mjs`._
8. **External URL scheme validation.** Externally sourced URLs must be scheme-validated before
   use in `href`/`src` (e.g. reject `javascript:`/`data:`) by the http/https **allowlist**,
   separately from encoding: `escapeHTML` encodes characters and performs NO scheme check.
   _Anchors: `lib/external-url.ts` `safeExternalUrl` (allowlist, not blocklist) and
   `renderCommitAnchor` (DEFINED there; `server.ts`'s last-updated line is the seam that
   consumes it); `lib/html.ts` header comment._

**Additional invariants observed in code, numbered here for the first time:**

9. **Every response is wrapped by `addSecurityHeaders`** — including error paths — and any
   state/status value used in an attribute is drawn from a closed allowlist. _Anchors:
   `server.ts` `addSecurityHeaders` (CSP `script-src 'self' 'sha256-…'`, nosniff,
   Referrer-Policy) applied in the `Deno.serve` handler's try AND catch; `lib/lifecycle.ts`
   verdict whitelist `["pass","fail","blocked"]`._
10. **Every gate shell-out is bounded and every browser navigation is whitelisted.** _Anchors:
    `scripts/lib/bounded-git.mjs`; `scripts/lib/cdp.mjs` hostname allowlist
    (`localhost`/`127.0.0.1`/`[::1]`, port-insensitive by design) with final-URL re-checks
    after `goto` and before every `evaluate`._
11. **Process spawning is bounded, attributable, and honestly reported** — the fixture
    aggregate sweeps `/proc/<pid>/environ` by token for detached descendants, and a partial
    scan reports UNKNOWN, never zero. _Anchor: `scripts/run-fixtures.mjs`._
12. **Static file serving rejects `..`** in addition to URL normalisation. _Anchors:
    `server.ts` `readPublicAsset` / `readReleaseAsset` guards._
13. **Error responses are generic to the client, detailed only in server logs** — never reflect
    upstream error text. _Anchor: `server.ts` `serverError` ("Internal error")._

## 7. Explicit Exclusions (Wontfix / Accepted Risks)

- **Gate Chrome runs `--no-sandbox`.** Accepted: CI containers lack unprivileged user
  namespaces, and a hard gate failure is worse than the marginal protection. Compensating
  controls: hostname-only navigation whitelist, final-URL re-checks after `goto` and before
  every `evaluate`, and lazy below-the-fold third-party iframes. Known blind spots
  (subframe/popup navigation, leave-and-return) are documented and accepted.
- **Port-insensitive navigation whitelist.** Same-machine ports are inside the trust boundary;
  a page may redirect to another localhost port.
- **`/conformance/run-all` serves `reports/conformance/index.html` byte-exact.** Accepted trust
  boundary: a runner-generated artifact is served as-is; the route does not re-render or
  re-escape it.
- **`mdnApiUrl`/`mdnCssUrl` interpolate caller input unencoded.** Latent hazard, zero callers
  today; pinned as an exact-output tripwire (`scripts/mdn-has.test.mjs`, `gendn-5ua`/`gendn-76k`)
  so any future wiring of raw caller input into a URL becomes a deliberate, reviewed decision
  rather than a silent change. Recorded as a tripwire, not silently "fixed".
- **`fetch-data.yml` commits upstream-fetched JSON to `main`.** `_data/` is not consumed by the
  running server, so a compromised upstream data fetch has no runtime impact; accepted as an
  offline cache.
- **In-memory caches are process-local and reset on restart** by design.
- **The `v<N>/` trees are authored by the routine.** The routine is a trusted actor; the
  boundary is the HTML it produces, which the escaping/allowlist invariants above constrain.
- **`.claude/routine-prompt.md` and the live routine UI are outside the runtime**;
  prompt-injection there is a developer-workflow concern, not an end-user attack surface.
