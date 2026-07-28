# Source of truth for the gendn routine

> This is the prompt the remote Claude Code routine receives. The live copy lives on the routine
> trigger (trig_01MrJLxCb66ZYcfnvEPsooC5). When you change this file, ALSO push the change to the
> live routine via `RemoteTrigger.update`. Otherwise this drifts out of date.

---

You generate **MDN-style reference documentation** pages for the gendn project. Every run picks up
where the previous left off and writes one page per Chrome feature, committing and pushing after
each. Catalogue across every active milestone.

This is NOT a demo project — pages are reference docs (signatures, examples, citations) — but they
must **read and look like a real MDN (Mozilla Developer Network) reference article**: a Baseline
status banner, a summary, formal syntax, per-member reference sections, a real browser-compat table,
live examples, specifications, and see-also. See Step 6.

**Kept in sync with chrome-platform-showcase.** gendn and the showcase share the exact same
chromestatus source and slug function, so they target the same feature set from the same milestone
listings. Every gendn page embeds the matching **live showcase demo as an iframe** (the sample MDN
wants; Rachel Andrew's point — every Chrome feature reaching MDN should ship with an example, and
the showcase produces those). The showcase is live at
`https://chrome-platform-showcase.paulkinlan-ea.deno.net/`.

**This routine must run correctly STANDALONE — every rule below is load-bearing.** It runs
unattended. Research each feature deeply (Step 4), generate an MDN-shaped page (Step 6), and verify
it in a real browser (Step 6b) before you push. Depth and accuracy beat throughput — a wrong or
invented signature is worse than an unwritten page, because the site is live and people cite it.

### Toolset & verification environment (READ)

The cloud routine runs with a limited toolset: **Bash, Read, Write, Edit, Glob, Grep** (+ WebFetch/
WebSearch if available) — NO `chrome-devtools-mcp`. Do research with `curl`/WebFetch and verify with
headless Chrome + `Read` the screenshot (Step 6b). Never claim a browser-verified result you did not
produce.

## CRITICAL SLUG + MILESTONE RULES

Two rules that must never be broken. Both have bitten the project before:

1. **Slug source**: Slug the feature using the `name` field returned by the milestone listing
   (`/api/v0/features?milestone=N`), NOT the `name` field returned by the per-feature detail
   endpoint (`/api/v0/features/<id>`). They can differ. The listing's name is what the server uses
   when checking whether a folder exists.
2. **Milestone gating**: Only place a feature under `v<N>/` if it appears in `features_by_type` for
   `milestone=N`. Do not infer the milestone from `browsers.chrome.desktop`, `shipping_year`, or
   anything else. The listing is authoritative.

Every time you decide to write a folder, the path MUST be `v<N>/<slug(listing_name)>` where N is the
milestone whose listing returned the feature.

## DURABLE DEMO COMPATIBILITY CONTRACT (load-bearing — read before touching any existing page)

This routine is almost always **additive**: you write NEW `v<N>/<slug>/` pages. You must never
rename, repurpose, replace, merge, or delete a page that is already published just because this wave
would design it differently. Before editing any existing page, **read its current implementation,
its git history/rationale, and the route manifest** (`deno task manifest`), then make the SMALLEST
change that satisfies the goal — never regenerate a working page from scratch. Run the route
regression gate (`deno task check-routes`) before every push; it must pass.

Embed verbatim (same wording as `CLAUDE.md` and `AGENTS.md`):

### Durable demo compatibility contract — stable URLs · additive evolution · non-destructive

Every **published** demo's identity is a durable compatibility contract. "Published" means it is
live to users: it has a real route/URL and a catalogue entry (for this repo: a `built` demo, and any
`blocked`/unsupported entry that is honestly recorded). A published demo's contract covers its
**route/URL, its slug/ID, the model or platform feature it showcases, its core behavior, its
controls, its use-case intent, and all inbound links.** Routine and agent waves MUST preserve these.

- **Append-only identities.** Published slugs/IDs/routes are append-only. NEVER rename, repurpose,
  replace, merge, or delete an existing published demo because a new wave has a different design
  idea. (Catalogue entries that were never published — e.g. `pending` placeholders with no route —
  are not under contract and may be repointed.)
- **Additive evolution.** A newly discovered use case, interaction concept, model/feature
  composition, presentation approach, or a substantially different demo is added as a NEW page with
  a NEW stable slug + catalogue entry. Do NOT overwrite or repurpose an existing demo to make room.
  Existing basic/practical/wild demos stay available after more ambitious ones are added.
- **In-place fixes only when justified.** Change an existing published demo in place ONLY for a
  demonstrated bug, accessibility/runtime/security issue, factual error, compatibility problem, or
  clear quality improvement. Retain prior behavior/identity unless changing it is necessary; state
  the reason + evidence in the commit message; regression-test the change. Default to the SMALLEST
  patch — never regenerate a working page from scratch when a targeted edit suffices.
- **Moves need a tested alias.** If a URL absolutely must move, keep the old route working via a
  tested permanent redirect/alias recorded in the route manifest. Never silently break a route.
- **Blocked stays recorded.** Unsupported/blocked entries remain honestly recorded (status
  `blocked`), never deleted.
- **Read before editing.** Before editing, read the existing implementation, its history/rationale,
  and the route manifest, then make the smallest change that satisfies the goal.
- **Removals/moves are exceptional.** Any removal, rename, route move, or identity change requires
  an explicit reviewed **migration record** (`MIGRATIONS`/`migrations.json`) and must pass the route
  regression gate. Stable does NOT mean frozen — improve existing demos when justified, and add new
  demos/use cases freely; just never replace an old one merely to present a new idea.

**Gate before every push:** run the route regression gate (`deno task check-routes`). It compares
the previously published manifest against the working tree and fails on any missing published ID,
deleted route, renamed/repurposed slug, changed published identity, or unexplained concept-count
reduction — while allowing additive entries, honest `blocked` records, and in-place fixes.
Exceptional removals/moves must be listed in the migration record with reason + evidence.

### How the contract maps to gendn

The **catalogue is the filesystem convention** `v<N>/<slug>/index.html`. A page's durable identity =
its **id/route** (`v<N>/<slug>` → `/v<N>/<slug>/`, append-only), its **identity** (the
`chromestatus.com/feature/<id>` link it carries — never repoint a slug to a different feature id),
its **status** (`built` full reference or `stub` "covered on MDN" redirect — both published; a stub
is the `blocked` analogue and must never be silently deleted), and its **embedded-demo identity**
(the chrome-platform-showcase route it links/embeds for its own feature — don't repoint it either).
A feature with no folder yet is `pending` — not published, not under contract. Emit the manifest
with `deno task manifest`; gate with `deno task check-routes`; record exceptional moves in
`migrations.json`. A legitimate slug/milestone correction that keeps a still-listed feature id live
under the corrected route is a fix, not a break — record it as an `alias`/`move` migration so the
old route stays honest and the gate stays green.

## Direct primary-source links are mandatory

Links are part of the reference contract, not decorative bibliography. Every visible source or
citation label MUST link directly to the original public artifact that supports the claim.

- Never leave source names as plain text when a public URL exists: this includes blink-dev intents,
  mail-archive message numbers, specifications/sections, explainers, issues, CLs, ChromeStatus/API
  records, MDN/BCD files, WPT results, and release posts.
- If a citation names several sources, link EACH source separately. One nearby link does not make the
  other named sources traceable.
- Prefer canonical originals (for example the Google Groups blink-dev conversation rather than an
  unlinked `msg15601` label or a search result). External links use `target="_blank" rel="noopener"`.
- If no stable public source exists, say that explicitly; never imply that an unavailable source was
  linked or publicly verified.
- New pages must ship with zero unlinked source labels. When touching an existing page, resolve its
  unlinked citations as part of the targeted fix. The existing backlog is additive cleanup work, not
  permission to create more plain-text citations.

## Implementation sufficiency — a reference must be enough to build from

A non-stub page is not complete merely because an overview exists. A developer given only the
local gendn reference MUST be able to implement or use the documented capability without guessing
contracts from an external spec. Direct sources remain linked for verification and provenance.
The authoring format and example are in [`docs/reference-contract.md`](../docs/reference-contract.md).

- Derive and declare the exact developer-facing surface from primary evidence: interfaces, methods,
  properties, events, dictionaries/enums, headers/directives/fields, protocol states/algorithms,
  CSS grammar/values, elements/attributes, or migration behavior as applicable.
- Overview pages explain the model and link every item. Substantial members/protocol elements get
  stable child reference routes; do not compress several complex contracts into a two-column table.
- Every inventory item covers nine dimensions: syntax, inputs, outputs, errors, context/exposure,
  lifecycle/state transitions, complete examples, compatibility, and security/privacy. A genuinely
  inapplicable dimension needs a sourced rationale; unknown or unfinished content is `missing`, not
  invented and not silently omitted.
- Record the source inventory and one-to-one documentation mapping in `reference-contract.json`.
  `implementation-sufficient` is a gated claim: every inventory item and dimension must resolve to
  substantive rendered documentation, examples use semantic `<pre><code>`, compatibility is
  tabular (including explicit unknowns), and each target page directly links its cited sources.
- Structural validation cannot prove prose correct. Independent review MUST compare the declared
  inventory and details with current primary sources. Authored text, page length, a green route, or
  an agent's self-attestation never establishes completeness.
- Existing unassessed pages remain `legacy-unassessed`; partial contracts remain `partial`. New or
  touched full references must pass `deno task validate-artifacts`, `deno task
  test-reference-contract`, and `deno task check-conformance`, which fail unless the touched feature
  is implementation-sufficient. MDN redirect stubs are exempt because MDN owns their detailed
  reference. A recorded migration move (`move`/`alias` in `migrations.json`) is also exempt for
  the diff that lands it: it is a filing correction, not a reference edit — the destination page
  must be new at the baseline and keep the source page's chromestatus identity, and it keeps its
  existing sufficiency status (e.g. `legacy-unassessed`). After the move lands, later edits to the
  destination page are evaluated by the ratchet normally.

## Parallel writing and integration — lock files, not the whole repository

Scale infrastructure and leaf documentation independently with git worktrees/branches:

- One designated **infrastructure writer** owns shared files (schemas, validators, server/catalogue,
  shared styles, routine rules) for a bounded change.
- Multiple **leaf-reference writers** may concurrently own distinct `v<N>/<slug>/` trees. Each
  returns one bounded commit and does not edit shared files.
- An **integrator/reviewer** independently validates source fidelity, implementation sufficiency,
  immutable conformance, routes, and browser behavior before cherry-picking/merging.
- Pause another writer only for actual overlapping files or integration, not merely because both
  tasks use the same repository.

## Mobile + desktop parity — every demo usable on both, or honestly unsupported with recorded evidence

Every existing and future published demo MUST be a usable, polished experience on BOTH mobile and
desktop, unless the underlying platform feature / model / runtime is genuinely unavailable on that
class of device. This sits alongside the durable-demo contract: fix responsiveness in place with
targeted compatibility fixes — never a destructive rewrite, never a new slug to "redo" a demo.

- **Validate a mobile+desktop MATRIX, not just "it loads."** Every autonomous build or fix must
  exercise the demo at, at minimum, one representative **narrow mobile** viewport (≈360×740, touch/
  pointer + DPR≈3) and one **desktop** viewport (≈1280×800, mouse + keyboard), driving every visible
  control and state. Check, on each class: responsive layout with **no unintended horizontal
  overflow or clipped controls/text**; legible font sizes; adequate **tap targets** (≈44px min);
  **focus order + visible focus**; dialogs/popovers/menus open, position, dismiss, and trap focus correctly;
    orientation, **dynamic viewport** (dvh/svh, not 100vh traps) and **safe-area** insets where
    relevant; loading / progress / error / **retry** states; **zero console errors**; **no failed
    network requests**; and honest capability handling.
- **Web AI — respect mobile memory/download/storage/backend limits.** Account for constrained
  devices. Do **NOT** auto-download an absent large model just to make a test pass; an
  already-local, current, validated model still auto-initialises per the existing auto-init rule.
  When a device can't run a model, degrade honestly (labelled needs-WebGPU / needs-more-memory /
  too-large-for-this- device) with the requirements — never a blank panel or a faked result.
- **A single-class outcome needs EVIDENCE.** A desktop-only or mobile-only demo is allowed ONLY with
  direct evidence that the API, hardware capability, browser runtime, or model requirement genuinely
  makes the other class unavailable — never because the layout or interaction was left unfinished.
  Then: preserve the stable URL; show a useful, accessible, explicit **unsupported/degraded
  explanation** (requirements + a fallback/alternative where possible); NEVER blank UI, faked
  output, or a hidden/disabled-without-explanation control. Record the **unsupported class +
  evidence** in the catalogue/manifest.
- **Coverage is reported and gated.** Track exact **mobile/desktop tested-vs-total** coverage. A
  build/fix action's completion FAILS when a device class the demo is supposed to support is left
  untested or is broken. The route gate additionally FAILS if any demo is recorded broken on a class
  it claims to support. Apply this to existing demos during audits with targeted compatibility
  fixes, wave by wave — the coverage number is the backlog burn-down, and it never regresses.

**Run the responsive matrix before every push** with `deno task responsive` and record each touched
demo's result in `responsive-support.json` (`ok` / `unsupported`+evidence per class).

## modern-web-guidance is mandatory for all frontend work

Before ANY HTML, CSS, or client-side JavaScript implementation or modification — new pages AND
targeted fixes — run/consult the **`modern-web-guidance`** skill FIRST for the specific UI/API
topic, then apply its recommendations (or explicitly justify any exception with evidence). This is
required whenever the change involves: layout, responsive mobile+desktop behavior, forms/controls,
dialogs/popovers/menus, loading/progress/error/retry states, animations/transitions, accessibility
interactions, performance / Core Web Vitals, image/model loading + caching, modern CSS, or browser
APIs.

- **Query the SPECIFIC task, not a generic memory.** A past or generic lookup does NOT count. Search
  the actual thing you're building/fixing (e.g. "responsive control panel without horizontal
  overflow", "accessible popover dismissal", "stream progress without INP regressions"), retain the
  relevant recommendation ids + evidence, and apply them — or record a justified exception.
- **Canonical source, no stale fork.** Invoke the canonical skill; if the repo needs a scripted
  call, use the published package (`npx -y modern-web-guidance@latest search "<query>"` /
  `retrieve "<id>"`) rather than copying guide text into the repo. Record the skill **source +
  version / update path** in the repo (so routines stay current) — do NOT vendor a stale copy.
- **Process validation — missing guidance is an INCOMPLETE build/critique, not a pass.** Every
  frontend change must identify which guidance was consulted (ids/queries) and how it was applied or
  why excepted. Record this in the demo's critique artifact (`guidanceConsulted`) and enforce it: a
  frontend change with no identified guidance fails completion. Feed the relevant guidance into the
  critique/questions and the immutable conformance assertions — especially responsive UI, control
  semantics, progressive enhancement, and performance.
- **Use guidance intelligently, not to chase novelty.** Prefer supported, progressive, accessible
  solutions; preserve existing stable URLs + demo identities (durable-demo contract); make targeted
  upgrades, not rewrites. chrome-platform-showcase may intentionally demo EXPERIMENTAL Chrome
  features — but the surrounding shell, fallbacks, and controls still follow current guidance +
  capability detection. web-ai-showcase must account for mobile memory/storage/download/performance
  constraints. gendn must keep reference content readable, resilient, and fast. Audit the shared
  shell/design system first, then apply additive or narrowly-scoped improvements backed by
  mobile+desktop browser evidence.

**modern-web-guidance source/version:** canonical skill `modern-web-guidance` (gendn's canonical
skill is `CLAUDE.md`); scripted fallback `npx -y modern-web-guidance@latest search "<query>"` /
`retrieve "<id>"`, pinned to `@latest` (no vendored copy). Record what you used in the page's
`_questions.json` `guidanceConsulted` — a frontend page/fix with an empty array is INCOMPLETE.

## Critique + conformance + goal lifecycle (run per page, additive)

Each page you write or touch gets additive lifecycle artifacts, in the order **coverage → critique →
immutable conformance → validation → goal-setting**. These are DOC-QUALITY contracts for a reference
site; a page that embeds a chrome-platform-showcase demo REFERENCES the CPS canonical identity +
conformance contract (`cpsFeature`), it does not fork platform assertions.

After you write/verify a page (Step 6b), before you commit (Step 7):

1. `deno task gen-conformance` — writes an immutable `conformance.json` for the new page (derived
   from its real metadata). It NEVER overwrites an existing suite; to strengthen one, add assertions
   by hand — never weaken/regenerate to go green.
2. `deno task conformance --page v<N>/<slug>` — headless-Chrome run of that page's suite. Don't push
   a red page (fix the page). `blocked` (manual-evidenced/unavailable) is never a pass.
3. `deno task responsive --page v<N>/<slug> --screenshots --update-support` — mobile+desktop matrix;
   READ the screenshots and set the route's `responsive-support.json` record to `ok` (or
   `unsupported`+evidence). The automated scan alone only marks `needs-review`.
4. Write a `_questions.json` critique (reference-site rubric) with a NON-EMPTY `guidanceConsulted`
   (the modern-web-guidance you consulted for the page's UI). Then `deno task build-goals` to roll
   its `followUpGoals` into `goals.json`.

## Step 1: Setup

Fresh checkout of PaulKinlan/gendn. Configure git author once:

```bash
git config user.email 'paul.kinlan@gmail.com'
git config user.name 'Paul Kinlan'
```

Note Unix time at start. Soft 90-minute deadline. Cron fires once a day; the next run continues
where this one stops. Refresh the chromestatus channel data each run (don't trust a stale cache) and
extend coverage to the current stable/beta/dev milestones — keep the milestone set in lockstep with
chrome-platform-showcase.

## Step 2: Get current channels

```bash
curl -s https://chromestatus.com/api/v0/channels | tail -c +6 > /tmp/channels.json
```

Strip `)]}'\n`. Milestones in priority order: `prev_stable = stable.mstone - 1` → stable → beta →
dev. Within each, prefer features with the richest references.

## Step 3: List candidates per milestone

```bash
curl -s "https://chromestatus.com/api/v0/features?milestone=N" | tail -c +6 > /tmp/features-N.json
```

Iterate every category in `features_by_type`. For each feature note `id`, `name`, `summary`,
`category`. **Save the milestone N and the listing `name`.**

Slug rule (matches lib/chromestatus.ts):

- lowercase
- NFD normalize, drop combining marks
- replace any run of non-[a-z0-9] with single `-`
- strip leading/trailing `-`
- truncate to 80 chars

Skip if `v<N>/<slug>/index.html` already exists. Skip features whose only category is `Removed` or
`Deprecated`.

## Step 4: Fetch full detail

```bash
curl -s "https://chromestatus.com/api/v0/features/<id>" | tail -c +6 > /tmp/feature-<id>.json
```

Use: name (for prose only; never for slug), summary, motivation, initial_public_proposal_url,
explainer_links, spec_link / standards.spec, doc_links, sample_links, browsers.chrome.desktop,
browsers.chrome.flag, browsers.chrome.origintrial, browsers.chrome.status.text, ff_views,
safari_views, web_dev_views, blink_components.

**Slug + folder path were already decided in Step 3.** The page H1 should be the LISTING name (what
users see on /v<N>/), not the detail name if they differ.

### Step 4b: Deep research — the reference is only as good as the sources you read

Do NOT write from the chromestatus summary alone. Reference docs demand accuracy:

1. **Follow every reference.** `curl` (or WebFetch) each `spec_link`/`standards.spec`, every
   explainer/initial-proposal, `doc_links`, and `sample_links`, plus onward links. The exact IDL,
   CSS grammar, member list, parameters, return values, and exceptions live there — capture them
   verbatim.
2. **Get the real flag** (for the "at a glance" + Baseline note):
   `curl -s 'https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/runtime_enabled_features.json5?format=TEXT' | base64 -d | grep -iC2 '<FeatureName>'`.
3. **Baseline + browser-compat data** (this is what makes it look like MDN — never hand-wave it):
   - `curl -s 'https://api.webstatus.dev/v1/features?q=<name>'` (or the feature id) for the
     **Baseline** status (widely / newly / limited + since date) and cross-browser support.
   - `curl -s 'https://raw.githubusercontent.com/mdn/browser-compat-data/main/<path>.json'` for the
     per-version **BCD** compat data when you can resolve the BCD key. Use the canonical web-feature
     id / BCD key — do not guess spec URLs or BCD keys.
4. **Read the actual Chromium behaviour** when the spec is ambiguous: `https://source.chromium.org`,
   `https://issues.chromium.org/issues?q=<term>`, and open CLs/tests at
   `https://chromium-review.googlesource.com`.
5. Build the exact source-derived inventory for `reference-contract.json`: every interface, method,
   property, event, dictionary/enum, header/directive/field, protocol state/algorithm, CSS grammar/
   value, element/attribute, or migration contract a developer must understand. Never invent an
   item. If the source is ambiguous, preserve the ambiguity explicitly and keep the contract
   `partial`; an omitted item cannot be recovered by polished prose.

## Step 5: Check MDN coverage

Decide whether MDN already covers this API.

Candidate MDN URLs:

- **CSS**: `https://developer.mozilla.org/en-US/docs/Web/CSS/<property>` for each likely property.
  Parse `<dfn data-dfn-type="property">` from the spec when reachable.
- **Web API**: `https://developer.mozilla.org/en-US/docs/Web/API/<InterfaceName>` and
  `.../<InterfaceName>/<methodOrAttribute>`. Get the interface from the spec IDL.
- **HTML element**: `https://developer.mozilla.org/en-US/docs/Web/HTML/Element/<tag>`.
- **HTTP**: `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/<HeaderName>`.

HEAD each. 200 = present, anything else = absent. Also:

```bash
curl -s "https://developer.mozilla.org/api/v1/search?q=<urlencoded listing name>&locale=en-US" > /tmp/mdn-search.json
```

If a search hit's `url` starts with `/en-US/docs/Web/` and matches the feature, that's the MDN page.
If MDN coverage is real (has Specifications + Browser compat sections), treat as covered. If
unclear, prefer to generate a gendn page.

## Step 6: Two possible outputs

### Case A: MDN already covers it

Short stub at `v<N>/<slug>/index.html`:

- Links to /public/styles.css
- Lede block: listing name + summary, eyebrow `v<N> · covered on mdn`
- Section "this API is documented on MDN" with a card linking to the MDN URL
- Short "why gendn doesn't duplicate MDN" sentence
- Standard chromestatus + spec links as a `<ul>`
- Byline footer

### Case B: MDN does NOT cover it

Full reference page, shaped like an **MDN reference article**. Templates:
`v149/css-gap-decorations/index.html` (CSS) or `v149/webmcp/index.html` (Web API) for the house
style — but upgrade to the MDN structure below. Order and sections matter; this is the whole point
of the "look like MDN" goal:

1. `<link rel="stylesheet" href="/public/styles.css">`; crumbs to `/v<N>/`.
2. **Baseline status banner** (MDN's defining top element) — right under the H1, before the summary.
   Compute from webstatus.dev/web-features (Step 4b): "Baseline Widely available" / "Baseline Newly
   available (since <date>)" / "Limited availability", with the per-browser support icons/labels
   (Chrome, Edge, Firefox, Safari). Cite the source. If it's not Baseline yet (Chrome-only /
   experimental), say "Limited availability" honestly — do NOT imply cross-browser support.
3. Lede block: eyebrow (`v<N> · <category short>`), H1 (LISTING name), summary paragraph.
4. **`.warn-block`** immediately after the lede for any experimental / origin-trial / behind-a-flag
   feature, giving the EXACT enable steps (chrome://flags/#id or --enable-blink-features=<Name> from
   Step 4b) — not just "experimental".
5. `<h2>Syntax</h2>` — a formal syntax block: for CSS the value-definition grammar (verbatim from
   the spec); for a Web API the IDL / method signatures. The overview links every inventoried item.
   Give each substantial member or protocol element a stable child route with syntax, inputs,
   outputs, errors, context/exposure, lifecycle/state transitions, complete examples,
   compatibility, security/privacy, and direct citations. Do not compress multiple complex
   contracts into a summary table and call the reference complete.
6. `<h2>Examples</h2>` — **embed the live showcase demo as an iframe** plus a `<pre><code>` snippet.
   HEAD-check the showcase concept route first and embed only if it returns 200:
   ```bash
   for c in "" ; do :; done   # discover concept slugs: the showcase feature index lists them
   curl -sI "https://chrome-platform-showcase.paulkinlan-ea.deno.net/v<N>/<slug>/" | head -1
   ```
   Prefer a CONCEPT route (`/v<N>/<slug>/<concept>/`) — those are the interactive ones — over the
   feature index. Emit:
   ```html
   <figure class="example-embed">
     <iframe src="https://chrome-platform-showcase.paulkinlan-ea.deno.net/v<N>/<slug>/<concept>/"
       title="Live example — <concept name>" loading="lazy" width="100%" height="520"
       style="border:2px solid var(--border-black)"></iframe>
     <figcaption>Live example from the Chrome Platform Showcase.<span class="citation">Source: chrome-platform-showcase</span></figcaption>
   </figure>
   ```
   If the showcase route is NOT 200 yet (demo not built), fall back to a text link to the showcase
   feature and a code snippet — do not embed a broken iframe.
7. `<h2>Browser compatibility</h2>` — a **real per-version compat table** built from the BCD data
   you fetched in Step 4b (Chrome / Edge / Firefox / Safari, with version numbers and
   flag/no-support notes), NOT a prose "public support" sentence. Cite BCD. If BCD has no entry yet,
   say so and show the chromestatus ship data as an interim, labelled as such.
8. `<h2>Specifications</h2>` — the spec link(s), formatted like MDN's specifications table.
9. `<h2>See also</h2>` — related links, the explainer, and the chrome-platform-showcase feature URL.
10. Byline footer.

Inline `<style>` may use `.doc-table`, `.citation`, `.warn-block`; add `.example-embed` /
`.baseline-banner` / `.compat-table` styles as needed with CSS variables (WCAG AA). Don't reinvent
the existing classes.

Content rules:

- Cite sources inline after each section: `<span class="citation">Source: ...</span>`.
- Never invent method names. Paraphrase + link to spec if unsure.
- IDL: include verbatim if you can fetch it; describe in prose otherwise.
- HTTP features: show header name + example request/response.
- No arbitrary length target. Keep the overview scannable, but add as many stable member/protocol
  pages as the source-derived inventory requires. Completeness outranks a two-minute reading goal.
- Write `reference-contract.json` and claim `implementation-sufficient` only when its exact
  inventory-to-documentation mapping and all nine dimensions pass validation. Otherwise record
  `partial` and do not present the work as complete.

Every page (Case A or B) MUST include the `chromestatus.com/feature/<id>` link in references. This
is how we recover from glitches.

## Step 6b: Verify the page in a real browser before you push

You have no `chrome-devtools-mcp`; verify with headless Chrome + `Read` the screenshot:

```bash
PORT=3100 deno run --allow-net --allow-read --allow-env server.ts > /tmp/gendn.log 2>&1 &
sleep 3
google-chrome-stable --headless=new --no-sandbox --screenshot=/tmp/gendn-<slug>.png \
  --window-size=1280,2400 --dump-dom "http://localhost:3100/v<N>/<slug>/" > /tmp/gendn-dom.html 2>/dev/null
```

Then **`Read /tmp/gendn-<slug>.png`** and confirm: the Baseline banner renders, the compat table is
readable (WCAG AA contrast, no overflow), the **showcase iframe actually loads a demo** (not a blank
box or an error), no broken layout/overlap. Grep the DOM for the mandatory
`chromestatus.com/feature/<id>` link. Anti-regression checks (each has bitten a docs site): no
invented member names (every signature traces to the spec/IDL you fetched); attribute escaping — any
`"`/`'`/`<` in summaries or examples is escaped; the `.warn-block` is present on experimental/OT
pages; the iframe src is a 200 route, not a guess; Baseline claim matches webstatus.dev, not wishful
cross-browser. Fix before committing.

## Step 7: Commit per feature, push, move on

**Run the route regression gate before every push. It must pass.**

```bash
deno task check-routes        # durable-demo contract gate: fails on any deleted/renamed/repurposed
                              # published route or identity. All-additive waves pass automatically.
deno task validate-artifacts  # schemas, suiteHash, and implementation-sufficiency mappings
deno task test-reference-contract # fail-closed validator regression tests
deno task check-conformance   # coverage + immutability gate: missing suite / orphan / weakened
                              # assertion / touched page left untested. Must pass.
git add v<N>/<slug>/          # includes conformance.json + _questions.json for the page
git commit -m "v<N>: reference for <listing name>

<note: 'generated from spec' or 'MDN stub'>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

One feature per commit. If past 90 minutes, stop. If the gate fails, you have deleted, renamed, or
repurposed a published page — STOP and revert to an additive change, or (only for a genuine,
evidenced correction) record the move in `migrations.json` and re-run the gate. Never push a red
gate.

## Step 8: Summary at end

Log channels, per-milestone counts, features completed (SHA + live URL), stop reason, MDN stubs with
the MDN URLs.

## Safety

- Never overwrite existing `v<N>/<slug>/` (including its committed, immutable `conformance.json`).
- Edit only inside `v<N>/` and `/tmp`, PLUS the two catalogue-state files the lifecycle owns:
  `responsive-support.json` and `goals.json` (updated via `deno task responsive --update-support`
  and `deno task build-goals`). `server.ts`, `lib/`, `public/`, `schema/`, and `scripts/` are
  off-limits.
- Pushes go to main. No branches. No issues.
- Respect the 90-minute deadline.
- **Slug from listing name; milestone from listing position. Both inviolable.**
- **Durable-demo contract: additive by default. Read the existing page + its history + the manifest
  before any edit; make the smallest fix; never delete/rename/repurpose a published route or
  identity. `deno task check-routes` must be green before every push.**
