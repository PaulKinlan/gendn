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

## Testing checklist (do this before merging anything)

```bash
deno fmt --check
deno check server.ts
deno task check-routes   # route regression gate — MUST pass before every push
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
