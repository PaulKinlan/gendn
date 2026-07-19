# AGENTS.md — gendn

Instructions for any agent (routine, manual Claude Code session, or CI bot) working in this repo.
The full operator manual is [`CLAUDE.md`](./CLAUDE.md); the scheduled routine prompt is
[`.claude/routine-prompt.md`](./.claude/routine-prompt.md). Read those before editing. The
non-negotiable rules below are duplicated verbatim across all three so the contract reads the same
everywhere — keep them in sync.

## Read before editing

Before you change ANY existing page, read its current implementation, its git history/rationale, and
the route manifest (`deno task manifest`). Make the SMALLEST change that satisfies the goal. Never
regenerate a working page from scratch when a targeted edit suffices, and never rename, move, or
delete a published route/identity to make room for a new design — add a new page instead. Run the
route regression gate (`deno task check-routes`) before every push; it must pass.

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

## How the contract maps to gendn

gendn has no separate registry file — the **catalogue is the filesystem convention**
`v<N>/<slug>/index.html`, rendered at `/features` and `/v<N>/` by `server.ts`. Each published page's
durable identity is:

- **id / route** — id `v<N>/<slug>` (append-only), served at `/v<N>/<slug>/`.
- **identity** — the `chromestatus.com/feature/<id>` link every page carries. This is the stable
  feature/spec descriptor; a slug must NEVER be repointed to a different feature id.
- **status** — `built` (full reference) or `stub` (honest "covered on MDN" redirect). Both are
  PUBLISHED, live routes under contract; a `stub` is gendn's analogue of a `blocked` record and must
  never be silently deleted. A feature with no folder yet is `pending` — not published, not covered.
- **embedded-demo identity** — the chrome-platform-showcase route a page embeds/links for its OWN
  feature. The contract covers this inbound demo link too: don't repoint it to a different feature.

## Route manifest + regression gate

- `deno task manifest` — emit the normalized manifest
  `{ id, route, identity, status, demo, aliases, support }` from the catalogue (the `support` record
  is merged from `responsive-support.json`). `--ref origin/main` emits it for a git ref; `--pretty`
  indents.
- `deno task check-routes` — the regression gate. Baseline = the manifest at `origin/main`
  (fallback: committed `.route-manifest.baseline.json`); current = the working tree. Fails on a
  missing published id, a deleted `built` route, a changed published identity, a deleted `stub`
  record, or an uncovered published-count drop. Passes additive ids, honest stubs, and same-id
  in-place fixes.
- `migrations.json` — array of `{ id, action, from, to, reason, evidence, date }` records that
  authorize exceptional removals/moves/identity-changes and keep moved routes alive via aliases.

Legitimate slug/milestone corrections that preserve a still-listed feature id under the correct
route are fixes, not contract breaks — record the move as an `alias`/`move` migration so the old
route stays honest and the gate stays green.

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
`retrieve "<id>"`, pinned to `@latest` (self-refreshing, no vendored copy). Recorded per page in
`_questions.json` `guidanceConsulted`.

## Critique + conformance + goal lifecycle (additive)

Every published page carries additive lifecycle artifacts alongside `index.html`, in the order
**coverage → critique → immutable conformance → validation → goal-setting**. Reference-site analogue
of chrome-platform-showcase's lifecycle — the assertions are DOC-QUALITY, not Chrome
platform-behavior; a page that embeds a CPS demo REFERENCES CPS's canonical identity + conformance
contract (`cpsFeature`) rather than forking it.

- `v<N>/<slug>/conformance.json` — immutable suite (`suiteHash` = sha256 of normalized assertions).
  Never delete/weaken an assertion to go green — FIX THE PAGE; add assertions freely. Weakening
  needs an `assertion-migrate` record in `migrations.json`.
- `v<N>/<slug>/_questions.json` — mutable critique with reference-site rubric + `guidanceConsulted`
  (empty on a frontend critique = INCOMPLETE) + `followUpGoals`.
- `goals.json` — additive backlog rolled up from critiques (`deno task build-goals`); never replaces
  a stable page.
- `responsive-support.json` — per-route mobile+desktop record merged into the manifest.

**Gates before every push (with `deno task check-routes`):** `deno task validate-artifacts`
(schema + suiteHash) and `deno task check-conformance` (missing suite / orphan / weakened assertion
/ touched-page untested). Run `deno task conformance --page <id>` for any page you touch — don't
push a red page. `blocked` is never a pass. Report honest denominators; burn down wave by wave.
