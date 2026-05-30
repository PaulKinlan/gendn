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

Cron `30 * * * *` (hourly at :30 to offset from the showcase routine at :00). Anthropic cloud, fresh
checkout of `main` per run. Soft 45-minute budget. Picks up where the last left off.

Routine prompt lives in `.claude/routine-prompt.md`. When you change it, also push to the live
routine via the `RemoteTrigger` MCP tool (action `update`).

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

## Testing checklist (do this before merging anything)

```bash
deno fmt --check
deno check server.ts
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
