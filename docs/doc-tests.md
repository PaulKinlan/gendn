# Doc Unit Tests & Staleness/Drift Guards

gendn treats documentation examples and status claims as testable artifacts, inspired by
Dart's doc-testing model, split into two tiers so fast local checks stay offline and
deterministic while scheduled runs surface upstream ChromeStatus and MDN drift.

## Tier 1 — Executable Snippet & Contract-Symbol Tests (`scripts/doc-tests.mjs`)

Run via `npm run doc-tests`:

```bash
npm run doc-tests -- --all
npm run doc-tests -- --page v158/offlineaudiocontext-incremental-rendering
npm run doc-tests -- --all --strict
npm run doc-tests -- --all --json
npm run doc-tests -- --page v158/my-feature --runtime
```

What Tier 1 verifies:

1. **Offline JS syntax verification (`node:vm`):** Extracts every `<pre><code>` block from a
   published page tree (`v<N>/<slug>/**/*.html`), decodes HTML entities, classifies the block,
   and parses JS snippets with `new vm.Script()` (never executing untrusted code; top-level
   `await` is validated inside an `async () => { ... }` wrapper, and `js-module` blocks strip
   static `import`/`export` declarations for syntax checking).
2. **Offline CSS structural verification:** Checks CSS blocks for balanced `{}`, `()`, and
   `[]` delimiters plus unclosed strings and `/* ... */` comments.
3. **Contract-symbol coverage (`reference-contract.json`):** Confirms every `surfaceMarkers`
   entry declared in `inventory` still appears in the page tree's visible text/code so
   renamed or removed identifiers cannot silently drift from the contract.
4. **Opt-in headless Chrome runtime probes (`--runtime`):** Boots `serve.ts` on an ephemeral
   port and drives headless Chrome over CDP (`scripts/lib/cdp.mjs`) to execute any explicitly
   annotated `<code data-doc-test="runtime">` blocks and validate `<code data-doc-test="css">`
   blocks with `new CSSStyleSheet().replaceSync(code)`.

### Optional `data-doc-test` Authoring Attributes

Unannotated `<pre><code>` blocks are classified conservatively so WebIDL, HTTP headers, HTML
markup, shell flags, WGSL shaders, formal grammar notation, and `...` pseudocode do not
false-fail. Authors can opt into explicit verification on any `<code>` (or `<pre>`) element:

| Attribute | Meaning |
| --- | --- |
| `data-doc-test="js"` | Parse as classic JS (supports top-level `await`). Syntax errors always fail in default mode. |
| `data-doc-test="js-module"` | Parse as an ES module (`import`/`export` + top-level `await`). Syntax errors always fail. |
| `data-doc-test="css"` | Check balanced delimiters offline, and validate via `CSSStyleSheet.replaceSync()` under `--runtime`. |
| `data-doc-test="runtime"` | Parse offline AND execute inside headless Chrome on the served page under `--runtime`. |
| `data-doc-test="idl"` / `"html"` / `"http"` / `"shell"` / `"json"` | Explicit non-JS language classification (skipped by JS syntax checks). |
| `data-doc-test="skip"` | Explicitly exclude pseudocode or intentionally malformed illustrations from syntax checks. |

Example:

```html
<pre><code data-doc-test="js">const supported = "close" in OfflineAudioContext.prototype;</code></pre>
```

## Tier 2 — Fact & Staleness Drift Guard (`scripts/doc-drift.mjs`)

Run via `npm run doc-drift`:

```bash
npm run doc-drift
npm run doc-drift -- --markdown
npm run doc-drift -- --json
npm run doc-drift -- --max-age-days 60
npm run doc-drift -- --live-mdn --markdown
```

What Tier 2 checks:

1. **Shipped-after-trial drift (`shipped-after-trial`, High):** Flags pages that still
   present a feature as Origin Trial, Developer Trial, or behind a flag when `_data/features-*.json`
   records the same ChromeStatus ID as `"Enabled by default"` in a milestone `<= currentStable`
   (from `_data/channels.json`), unless the page acknowledges the ship with a verified
   `data-shipped-in` marker on `.warn-block`.
2. **Shipped marker mismatch (`shipped-marker-mismatch`, High):** Flags pages whose `.warn-block`
   carries a `data-shipped-in="<N>"` attribute that `_data/` does not confirm (non-numeric value,
   feature never listed as `"Enabled by default"`, wrong first-shipped milestone, or milestone not
   yet stable). States both the marker value and `_data/`'s record, replaces `shipped-after-trial`
   for that page, and does not suppress `stale-experimental`.
3. **Stale experimental docs (`stale-experimental`, Medium):** Flags experimental/trial pages
   whose freshest `assessedAt` (`reference-contract.json`) or `reviewedAt` (`_questions.json`)
   timestamp is older than `--max-age-days` (default `90`). Suppressed once a page carries a
   confirmed `data-shipped-in` marker.
4. **Milestone movement / missing snapshots (`milestone-moved`, `missing-chromestatus-record`, Low):**
   When `_data/features-<N>.json` exists for a page's milestone, reports features that moved
   to a different milestone or disappeared from the snapshot.
5. **Opt-in MDN graduation probe (`--live-mdn`, Info):** Uses `mdnHas()` from `lib/mdn.ts`
   (bounded via `fetchBounded()`) to check whether any `built` page's candidate MDN URL now
   returns `{ kind: "present" }`. Transport errors (`unknown`) and `404` (`missing`) are
   never flagged.

### Acknowledging a Shipped Trial (`data-shipped-in`)

When an older trial page's feature later ships enabled by default, the durable-demo contract keeps
the original `v<N>/<slug>/` route in place. After updating the page's `.warn-block` note to state
that the feature has shipped, add `data-shipped-in="<N>"` directly on the `.warn-block` element:

```html
<div class="warn-block" data-shipped-in="157">
  <strong>Shipped in Chrome 157:</strong> Originally documented during the Chrome 148 Origin Trial;
  this API is now enabled by default.
</div>
```

Rules enforced by `scripts/doc-drift.mjs`:

- **Placement and format:** The attribute is read only from the page's first `.warn-block` `<div>`
  element (attributes on other elements or inside other attribute values are ignored). Its value
  must be a plain positive integer milestone such as `"157"` — not `"M157"`, `"v157"`, `"157.0"`,
  whitespace-padded, or empty.
- **Verified against `_data/`, never trusted:** `evaluateShippedMarker()` confirms that `<N>` equals
  the **first** milestone where `_data/features-*.json` records the page's ChromeStatus ID under
  `"Enabled by default"`, and that `<N> <= currentStable` (when `_data/channels.json` provides a
  stable milestone).
- **Confirmed acknowledgement:** When verified, the page is counted under `shippedAcknowledged` and
  suppresses both `shipped-after-trial` and `stale-experimental` (the feature is no longer
  experimental).
- **Unconfirmed marker (`shipped-marker-mismatch`, High):** Any disagreement emits a High
  `shipped-marker-mismatch` finding with one of four reasons:
  - `malformed` — value is not a plain positive integer milestone.
  - `not-shipped` — `_data/` has no `"Enabled by default"` entry for the page's ChromeStatus ID.
  - `wrong-milestone` — `<N>` does not match the first `"Enabled by default"` milestone in `_data/`.
  - `not-yet-stable` — `<N>` matches `_data/`, but `<N> > currentStable`.

  A mismatched marker replaces `shipped-after-trial` for that page (one finding for the defect) and
  never acts as an acknowledgement, so `stale-experimental` is still reported if the page is stale.

## Weekly CI Report

`.github/workflows/doc-drift.yml` runs every Sunday at `06:30 UTC` (and on manual
`workflow_dispatch`), writing Tier 1 and Tier 2 (`--live-mdn --markdown`) summaries directly
to `$GITHUB_STEP_SUMMARY` in report-only mode.

## Unit Fixture

Run the deterministic, browser-free test suite for both scripts:

```bash
node scripts/doc-tests.test.mjs
```
