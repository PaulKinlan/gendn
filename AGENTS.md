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
  `{ id, route, identity, status, demo, aliases }` from the catalogue. `--ref origin/main` emits it
  for a git ref; `--pretty` indents.
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
