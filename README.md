# gendn

Generated reference documentation for web platform APIs that ship in Chrome but don't yet have a
page on MDN. Not a replacement for MDN: when MDN already covers an API, gendn just links out. The
goal is an implementation-sufficient reference for the gap between "shipped in Chrome" and
"documented on developer.mozilla.org": a developer with only the gendn pages should not have to
infer signatures, protocol fields, errors, lifecycle behavior, or edge cases.

- Live site: https://gendn.kinlan-test.workers.dev/
- Sister interactive showcase: https://chrome-platform-showcase.kinlan-test.workers.dev/
  (both live origins run on Cloudflare Workers; links to retired Deno Deploy hosts are forbidden
  and enforced by `scripts/no-legacy-host.test.mjs`)

## How it works (intended end state)

1. Daily routine reads [chromestatus.com](https://chromestatus.com/) for features that have shipped,
   are in origin trial, or are in dev trial.
2. For each, it looks the API up on MDN. If MDN has a page, the entry just links to MDN and stops.
3. If MDN doesn't have a page, the routine generates a reference page from:
   - the chromestatus.com summary, motivation, and links
   - the explainer (when available)
   - the spec (typically WHATWG or W3C)
   - the IDL from Chromium source (`third_party/blink/renderer/`)
4. Pages get committed and pushed; Cloudflare Workers Builds redeploys the Worker.
5. When MDN ships its own page, the routine notices on the next pass and the gendn entry switches to
   a "see MDN" stub.

## Reference shape and completeness

A feature overview explains the model and indexes the exact developer-facing surface derived from
primary sources. Substantial methods, properties, events, headers, directives, fields, states, and
algorithms get stable child pages rather than one-line table entries.

Each item documents syntax, inputs, outputs, errors, context/exposure, lifecycle, complete examples,
compatibility, and security/privacy behavior. The colocated `reference-contract.json` reconciles the
source-derived inventory with those pages and fragments. The gate distinguishes three states:

- `implementation-sufficient`: every item and dimension resolves and has passed structural checks;
- `partial`: the inventory records explicit missing work;
- `legacy-unassessed`: an older page exists but has not passed this contract.

See [the reference-contract authoring guide](docs/reference-contract.md). Direct source links remain
on each page so reviewers can verify the inventory and prose; structural checks cannot replace that
independent source review.

## Page template conventions

Published pages share the editorial stylesheet (`public/styles.css`) and light/dark SVG favicon
(`<link rel="icon" type="image/svg+xml" href="/public/favicon.svg">`). Modern pages (e.g.,
`v159/accentcolor-accentcolortext-follows-accent-color-value/index.html`,
`v159/webtransporterror-api-alignment-and-serialization/index.html`, and stub
`v160/svg-path-data-api/index.html`) follow this structure:

- Single `<main>` with top `<p class="crumbs">` breadcrumb (`/v<N>/` and `/features`).
- `<header class="lede-block">` containing `.eyebrow`, `<h1>` (milestone listing name), `.lede`,
  and `.baseline-banner.baseline-banner--paper-standard` (`.baseline-status`, `.baseline-browsers`).
- Mandatory `.warn-block` after the header on experimental / origin-trial / behind-a-flag features
  with exact enable steps; once a trial feature ships enabled by default in Chrome milestone `N`,
  record `data-shipped-in="<N>"` on `.warn-block` alongside the updated shipping note.
- `<nav class="local-nav" aria-label="On this page">` (with `<p class="local-nav-label">On this page</p>`)
  linking to section `h2[id]` anchors.
- Focusable `.table-wrap` scroll containers around `.doc-table` / `.compat-table`, `.mdn-card` on
  MDN stubs, sandboxed `.example-embed` iframes pointing to
  `https://chrome-platform-showcase.kinlan-test.workers.dev/`, `.citation` blocks with direct
  primary-source links, and `<footer class="byline">`.

## Doc unit tests & staleness/drift checks

Documentation snippets and status claims are verified in two tiers (see
[docs/doc-tests.md](docs/doc-tests.md)):

- **Tier 1 — `npm run doc-tests` (`scripts/doc-tests.mjs`):** offline JS syntax checks via
  `node:vm`, CSS balanced-delimiter checks, `reference-contract.json` `surfaceMarkers` coverage,
  and opt-in headless Chrome probes (`--runtime`). Supports `data-doc-test` attributes on
  `<pre><code>` blocks (`js`, `js-module`, `css`, `runtime`, `idl`/`html`/`http`/`shell`/`json`,
  and `data-doc-test="skip"` paired with a stated reason for genuine pseudocode or intentionally
  malformed illustrations).
- **Tier 2 — `npm run doc-drift` (`scripts/doc-drift.mjs`):** compares published pages against
  `_data/features-*.json` and `_data/channels.json` for `shipped-after-trial` (respecting
  `data-shipped-in="<N>"` on `.warn-block`), `stale-experimental`, `milestone-moved`, and
  `missing-chromestatus-record`, plus opt-in `--live-mdn` MDN graduation checks.
- **Weekly CI report:** `.github/workflows/doc-drift.yml` runs both tiers every Sunday at
  `06:30 UTC` (and on `workflow_dispatch`), publishing summaries to `$GITHUB_STEP_SUMMARY` in
  report-only mode.

## On-demand CSS drift checks

Before a CSS edit, [record a computed-style baseline](docs/css-drift.md) with
`npm run css-drift -- --record wave-name --routes 'v147/example'`. After editing,
compare with the **same routes** using `--compare wave-name`; the baseline is
uncommitted and must be kept in the same worktree. `--changed` may replace
`--routes` on **both** passes only when the branch already has a stable changed-page
diff before the CSS edit. A clean pre-edit tree has no changed routes, so record
with `--routes` instead. Never record the baseline after editing: it cannot detect
that edit. Shared CSS changes require an explicit `--all` or an honestly partial
`--routes` sample. This is not an automated CI gate.

## Runtime and routes

Production runs on **Cloudflare Workers** (`worker.ts`, deployed via Cloudflare Workers Builds),
reading bundled static files from `dist/site` through the `ASSETS` binding with `run_worker_first`
so every response passes the shared `serveRequest()` header/revalidation pipeline. Local development
and all gates/fixtures run on Node 22.18+ (`npm run dev`).

Key routes:

- `/` — Chrome milestone overview
- `/features` — searchable catalogue of published references and MDN stubs
- `/v<N>/` and `/v<N>/<api-slug>/` — per-milestone listings and individual reference pages
- `/conformance` and `/conformance/run-all` — doc-quality conformance dashboard and run-all report
  (plus per-page `/v<N>/<api-slug>/(conformance|critique)`)
- `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/feed.xml`, and `/api/features.json` —
  machine-readable discovery endpoints for crawlers, tools, and LLMs

## Layout

```
gendn/
  server.ts             Routing + rendering, runtime-neutral (serveRequest). Routes /, /features,
                        /conformance, /v<N>/, and /v<N>/<api-slug>/.
  worker.ts             Cloudflare Workers entry (production). wrangler.jsonc configures it.
  serve.ts              Node entry for local dev: `npm run dev` (Node 22.18+, no build step).
  package.json          Every task (`npm run <task>`) + pinned dev tools.
  scripts/              Gates, generators, doc-tests.mjs, doc-drift.mjs, and fixtures (plain Node).
  lib/
    chromestatus.ts     JSON API wrapper (shared with chrome-platform-showcase).
    mdn.ts              MDN existence helper (tested by scripts/mdn-has.test.mjs; not on hot path).
    site-fs.ts          Read-only file access: node:fs locally, the ASSETS binding on Workers.
  public/
    styles.css          Shared editorial design system.
    favicon.svg         Shared light/dark SVG favicon.
  docs/
    reference-contract.md
    doc-tests.md
  .github/workflows/
    doc-drift.yml       Weekly report-only doc-tests & doc-drift summary.
  schema/reference-contract.schema.json
  v149/
    <api-slug>/
      index.html
      reference-contract.json
      <interface>/<member>/index.html
```

## License

Apache 2.0. See [LICENSE](./LICENSE).

Copyright 2026 Paul Kinlan.
