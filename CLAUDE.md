# gendn — operator manual

> Read this BEFORE editing anything. The project is maintained by a remote Claude Code routine; the
> rules below exist because we already hit each bug at least once.

## What this project is

Generated reference documentation for web platform APIs that ship in Chrome but don't yet have a
page on MDN. When MDN already covers an API, gendn writes a short stub that links to MDN. Otherwise
it generates a full reference from the spec, explainer, and chromestatus data.

- Live site: https://gendn.paulkinlan-ea.deno.net/
- Repo: https://github.com/PaulKinlan/gendn
- Routine: https://claude.ai/code/routines/trig_01MrJLxCb66ZYcfnvEPsooC5

Sister project: [chrome-platform-showcase](https://github.com/PaulKinlan/chrome-platform-showcase)
(interactive demos for the same features).

## Repo layout

```
server.ts             Deno HTTP entry. Routes /, /features, /v<N>/, /v<N>/<api-slug>/.
                      Index + /features + /v<N>/ render server-side from the chromestatus.com API.
deno.json             Tasks (dev/start/check/fmt). HTML/CSS excluded from deno fmt.
lib/
  chromestatus.ts     Wrapper around chromestatus.com/api/v0. Strips the )]}' XSSI prefix. In-memory cache.
  mdn.ts              MDN existence heuristics (HEAD-checks the canonical MDN URL, hour cache).
public/styles.css     Shared editorial design system. Same one as chrome-platform-showcase.
v<N>/                 One folder per Chrome milestone. Each contains <api-slug>/index.html.
.claude/
  routine-prompt.md   Source of truth for the routine prompt. Update this AND the live routine when changing rules.
```

## The routine

Cron `30 */2 * * *` (every 2 hours at :30 UTC, offset from the showcase routine at :00). Anthropic
cloud, fresh checkout of `main` per run. Soft 90-minute budget. Picks up where the last left off.

Cadence was halved from hourly to every-2-hours on 2026-05-30 after the account hit a
routines-per-day cap. If you bump it back to hourly, watch the cap.

Routine prompt lives in `.claude/routine-prompt.md`. When you change it, also push to the live
routine via the `RemoteTrigger` MCP tool (action `update`).

### Triggering a manual run

Manual runs do NOT use the remote routine — they run in Claude's local session against the working
checkout at `/home/paulkinlan/gendn/`, so they don't burn the daily routines quota and Paul sees the
work appear in chat as it happens.

Convention: Paul says "run gendn" (or "build the next 2 references" etc) in chat. Claude then:

1. `cd /home/paulkinlan/gendn && git pull --rebase`
2. Follows `.claude/routine-prompt.md` end-to-end against this local checkout
3. Builds the requested number of features (default 2-3), one commit per feature, pushing after each
4. Reports each commit + URL back in chat as it lands

The remote routine continues to fire on its 2-hour cron in the background. Manual + remote both
write to `main` safely because every run skips any folder that already exists.

## Critical invariants (read these — every one has bitten us)

### 1. Slug source: milestone listing, not feature detail

`/api/v0/features?milestone=N` and `/api/v0/features/<id>` can return different `name` fields. The
listing name is shorter / more specific (e.g. `"Intl.Locale.prototype.variants"`). The detail name
is broader (e.g. `"Intl.Locale"`). **Server's slugify uses the listing name.** Routine must too.

Bug history: 2026-05-30 cleanup commit `4959b02` (gendn) — 12 folders were misslugged from this
mistake.

### 2. Milestone gating: listing position only

Place `v<N>/<slug>/` only if the feature appears in `features_by_type` for `milestone=N`. Do not
infer N from `browsers.chrome.desktop`, `shipping_year`, or any other field.

### 3. Every page must include the chromestatus.com/feature/<id> link

The self-heal. If folder names get garbled again, the cleanup script in `/tmp/fix-slugs.py` recovers
by reading the ID out of each page.

### 4. HTML attribute escaping: `"` and `'` MUST be escaped

`escapeHTML` must escape `&`, `<`, `>`, `"`, AND `'`. Real-world consequence: a feature card floated
to the top of the /features catalogue in Chrome because the routine put a `"quoted phrase"` in a
feature summary, which terminated the `data-search` attribute, which let a `<script>` literal in the
same summary get parsed and executed. Fix: `cf02076`.

### 5. CSS variables, never raw hex, WCAG AA

Per-page inline `<style>` blocks must use the CSS variables defined in `public/styles.css`. WCAG AA
(4.5:1 normal, 3:1 large) on every text-on-background pair.

### 6. MDN matching: prefer generating over linking if unsure

The MDN-check step has to make a judgment call. If MDN coverage is ambiguous (stub page, draft, or a
search hit that doesn't quite match the feature), generate a gendn page rather than redirect to MDN.
We'd rather have two pages on the same API than send the reader to a half-baked MDN stub.

### 7. The warn-block on experimental features is mandatory

Origin-trial and dev-trial features get a `.warn-block` immediately after the lede saying the API
surface may move. This is non-negotiable — without it readers may copy code from a moving API into
production.

### 8. Routine never edits top-level files

The routine prompt is constrained to writing inside `v<N>/`. `server.ts`, `lib/`, `public/`,
`deno.json`, `CLAUDE.md`, and the seed pages (`v149/css-gap-decorations/` and `v149/webmcp/`) are
off-limits.

## Durable demo compatibility contract — stable URLs · additive evolution · non-destructive

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

gendn has no separate registry file — the **catalogue is the filesystem convention**
`v<N>/<slug>/index.html`, rendered at `/features` and `/v<N>/` by `server.ts`. Each published page's
durable identity is:

- **id / route** — id `v<N>/<slug>` (append-only), served at `/v<N>/<slug>/`.
- **identity** — the `chromestatus.com/feature/<id>` link every page carries (invariant #3 above).
  This is the stable feature/spec descriptor; a slug must NEVER be repointed to a different feature
  id.
- **status** — `built` (full reference) or `stub` (honest "covered on MDN" redirect). Both are
  PUBLISHED, live routes under contract; a `stub` is gendn's analogue of a `blocked` record and must
  never be silently deleted. A feature with no folder yet is `pending` — not published, not covered.
- **embedded-demo identity** — the chrome-platform-showcase route a page embeds/links for its OWN
  feature. The contract covers this inbound demo link too: don't repoint it to a different feature.

Tooling: `deno task manifest` emits the normalized manifest
(`{ id, route, identity, status, demo, aliases }`) from the catalogue; `deno task check-routes` is
the regression gate (baseline = the manifest at `origin/main`, fallback
`.route-manifest.baseline.json`). Exceptional removals/moves are recorded in `migrations.json`.
Legitimate slug/milestone corrections that preserve a still-listed feature id under the correct
route are fixes, not contract breaks; record the move as an `alias`/`move` migration so the old
route stays honest.

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
The authoring format and example are in [`docs/reference-contract.md`](docs/reference-contract.md).

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

### modern-web-guidance source and version (update path — no vendored copy)

- **Canonical skill:** `modern-web-guidance` (the user/settings skill). **gendn's canonical skill
  for the routine IS this `CLAUDE.md`** — consult the `modern-web-guidance` skill before any
  frontend edit and record what you used.
- **Scripted fallback (for routines/CI):** `npx -y modern-web-guidance@latest search "<query>"` and
  `npx -y modern-web-guidance@latest retrieve "<id>"`. Pinned to **`@latest`** so it self-refreshes;
  there is **no vendored guide copy** in this repo (a vendored copy would go stale). Re-running
  `@latest` is the update path.
- **Where it's recorded:** each page's critique (`v<N>/<slug>/_questions.json`) carries a
  `guidanceConsulted` array; the validator fails any frontend-scoring critique whose array is empty.

## Critique + conformance + goal lifecycle

Each published reference page carries additive lifecycle artifacts alongside `index.html`, in the
order **coverage → critique → immutable conformance → validation → goal-setting**. This is the
reference-site analogue of chrome-platform-showcase's lifecycle — the assertions are DOC-QUALITY
(identity/source fidelity, structure, links, examples, a11y, responsive, runtime), NOT Chrome
platform-behavior. Where a page embeds a chrome-platform-showcase demo, its suite **references** the
canonical CPS feature/demo identity and CPS's own conformance contract (`cpsFeature`) rather than
forking contradictory platform assertions.

- **`v<N>/<slug>/conformance.json` — immutable conformance suite.** Doc-quality assertions derived
  from the page's REAL metadata (chromestatus feature id, route, built/stub status, sections,
  embedded showcase link). `immutable: true` + a `suiteHash` (sha256 of the normalized assertions).
  **Immutable means: once committed, an assertion is never deleted, weakened, or regenerated to go
  green — you FIX THE PAGE.** Adding assertions (growing coverage) is allowed. Removing/weakening
  needs an `assertion-migrate` record in `migrations.json`. Two validators enforce this:
  `validate-artifacts` recomputes each `suiteHash` (tamper signal); `check-conformance` diffs the
  assertions against `origin/main` (semantic weakening).
- **`v<N>/<slug>/_questions.json` — critique (mutable, versioned).** Reference-site rubric:
  factual/source fidelity, milestone mapping, completeness, explanation quality, examples,
  browser-compat/fallbacks, links validity, accessibility, responsive mobile+desktop UX, and
  relationship to the canonical showcase demo. Carries `guidanceConsulted` (empty on a frontend
  critique = INCOMPLETE) and `followUpGoals`.
- **`v<N>/<slug>/reference-contract.json` — implementation-sufficiency contract.** Exact
  source-derived surface inventory plus one-to-one mappings to overview or stable child docs. Every
  item covers syntax, inputs, outputs, errors, context, lifecycle, examples, compatibility, and
  security/privacy, or gives a sourced not-applicable rationale. Required for new/touched non-stubs.
- **`goals.json` — additive backlog.** `deno task build-goals` rolls every critique's
  `followUpGoals` into it. The routine consumes it to pick the next ADDITIVE page or a targeted
  in-place fix — never to replace a stable page.
- **`responsive-support.json` — per-route mobile+desktop record**, merged into the route manifest as
  each entry's `support`. Default `untested`; a class flips to `ok` only after a real matrix pass
  (screenshots read), `unsupported` needs evidence, and the automated scan marks `needs-review`.

Commands:

```bash
deno task gen-conformance      # write a genuine suite for any published page missing one (never overwrites)
deno task conformance          # headless-Chrome run-all: tested/total/pass/fail/blocked + reports/conformance/ rollup
deno task conformance --page v<N>/<slug>      # one page's suite (the routine's per-page gate — don't push red)
deno task responsive --update-support         # mobile+desktop scan → responsive-support.json (auto = needs-review)
deno task build-goals          # roll critique followUpGoals into goals.json
deno task validate-artifacts   # schemas + suiteHash + implementation-sufficiency mappings
deno task test-reference-contract # fail-closed validator regression tests
deno task check-conformance    # coverage + immutability + touched-page sufficiency gate
```

**Gate before every push (in addition to `deno task check-routes`):** `deno task validate-artifacts`,
`deno task test-reference-contract`, and `deno task check-conformance` must pass. `blocked` in a run is explicit (manual-evidenced or
genuinely unavailable) and is NEVER counted as a pass. Coverage denominators are honest and burned
down wave by wave — never claim complete/all.

## Testing checklist (do this before merging anything)

```bash
deno fmt --check
deno check server.ts
deno task check-routes   # route regression gate — MUST pass before every push
deno task test-reference-contract
deno task start

curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/features
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/v149/
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/v149/webmcp/
```

If you changed escapeHTML or anything HTML-building:

- View-source `/features` and confirm attribute values don't leak content into element context.

If you changed the design system:

- Open at < 640px to confirm the mobile table layout.
- Visit one existing reference to confirm no contrast regressions.

## How to update the routine prompt

1. Edit `.claude/routine-prompt.md` in the repo.
2. Open the routine: https://claude.ai/code/routines/trig_01MrJLxCb66ZYcfnvEPsooC5
3. Paste the new prompt as the routine's event message content.
4. Trigger a one-off run to confirm.

Most-bitten parts are the "Critical Rules" block. Put new tightening there, not in a numbered step.

## Recovery: fixing slug / milestone / MDN-mismatch errors

1. Disable the routine.
2. Run `python3 /tmp/fix-slugs.py /home/paulkinlan/gendn gendn`. It reads each page, finds the
   chromestatus ID, renames or deletes accordingly. Folders without an embedded chromestatus ID are
   deleted.
3. Commit, push, re-enable.

The seed pages (`v149/css-gap-decorations/` and `v149/webmcp/`) are in the SEEDS allowlist in
`/tmp/fix-slugs.py` so they don't get touched.

## Things that are intentional and may look weird

- The /features catalogue only lists APIs where a reference has been written. Pending ones still
  appear on the per-release page.
- Some pages are "stubs" that just link out to MDN. They're shorter on purpose — gendn doesn't
  duplicate MDN.
- v148 shows as "Stable (live)" because chromestatus's stable.mstone is the _next_ cut. Most users
  are on stable-1.

## Quick links

- Live: https://gendn.paulkinlan-ea.deno.net/
- Catalogue: https://gendn.paulkinlan-ea.deno.net/features
- Routine UI: https://claude.ai/code/routines/trig_01MrJLxCb66ZYcfnvEPsooC5
- chromestatus API: https://chromestatus.com/api/v0/channels
- MDN search API: https://developer.mozilla.org/api/v1/search?q=Soft+Navigations&locale=en-US
