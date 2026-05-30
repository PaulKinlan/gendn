# Source of truth for the gendn routine

> This is the prompt the remote Claude Code routine receives. The live copy lives on the routine trigger (trig_01MrJLxCb66ZYcfnvEPsooC5). When you change this file, ALSO push the change to the live routine via `RemoteTrigger.update`. Otherwise this drifts out of date.

---

You generate reference documentation pages for the gendn project. Every run picks up where the previous left off and writes one page per Chrome feature, committing and pushing after each. Catalogue across every active milestone.

This is NOT a demo project. Pages are reference docs: signatures, examples, citations.

## CRITICAL SLUG + MILESTONE RULES

Two rules that must never be broken. Both have bitten the project before:

1. **Slug source**: Slug the feature using the `name` field returned by the milestone listing (`/api/v0/features?milestone=N`), NOT the `name` field returned by the per-feature detail endpoint (`/api/v0/features/<id>`). They can differ. The listing's name is what the server uses when checking whether a folder exists.
2. **Milestone gating**: Only place a feature under `v<N>/` if it appears in `features_by_type` for `milestone=N`. Do not infer the milestone from `browsers.chrome.desktop`, `shipping_year`, or anything else. The listing is authoritative.

Every time you decide to write a folder, the path MUST be `v<N>/<slug(listing_name)>` where N is the milestone whose listing returned the feature.

## Step 1: Setup

Fresh checkout of PaulKinlan/gendn. Configure git author once:

```bash
git config user.email 'paul.kinlan@gmail.com'
git config user.name 'Paul Kinlan'
```

Note Unix time at start. Soft 45-minute deadline. Cron is hourly; next run continues.

## Step 2: Get current channels

```bash
curl -s https://chromestatus.com/api/v0/channels | tail -c +6 > /tmp/channels.json
```

Strip `)]}'\n`. Milestones in priority order: `prev_stable = stable.mstone - 1` → stable → beta → dev. Within each, prefer features with the richest references.

## Step 3: List candidates per milestone

```bash
curl -s "https://chromestatus.com/api/v0/features?milestone=N" | tail -c +6 > /tmp/features-N.json
```

Iterate every category in `features_by_type`. For each feature note `id`, `name`, `summary`, `category`. **Save the milestone N and the listing `name`.**

Slug rule (matches lib/chromestatus.ts):
- lowercase
- NFD normalize, drop combining marks
- replace any run of non-[a-z0-9] with single `-`
- strip leading/trailing `-`
- truncate to 80 chars

Skip if `v<N>/<slug>/index.html` already exists. Skip features whose only category is `Removed` or `Deprecated`.

## Step 4: Fetch full detail

```bash
curl -s "https://chromestatus.com/api/v0/features/<id>" | tail -c +6 > /tmp/feature-<id>.json
```

Use: name (for prose only; never for slug), summary, motivation, initial_public_proposal_url, explainer_links, spec_link / standards.spec, doc_links, sample_links, browsers.chrome.desktop, browsers.chrome.flag, browsers.chrome.origintrial, browsers.chrome.status.text, ff_views, safari_views, web_dev_views, blink_components.

**Slug + folder path were already decided in Step 3.** The page H1 should be the LISTING name (what users see on /v<N>/), not the detail name if they differ.

## Step 5: Check MDN coverage

Decide whether MDN already covers this API.

Candidate MDN URLs:
- **CSS**: `https://developer.mozilla.org/en-US/docs/Web/CSS/<property>` for each likely property. Parse `<dfn data-dfn-type="property">` from the spec when reachable.
- **Web API**: `https://developer.mozilla.org/en-US/docs/Web/API/<InterfaceName>` and `.../<InterfaceName>/<methodOrAttribute>`. Get the interface from the spec IDL.
- **HTML element**: `https://developer.mozilla.org/en-US/docs/Web/HTML/Element/<tag>`.
- **HTTP**: `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/<HeaderName>`.

HEAD each. 200 = present, anything else = absent. Also:

```bash
curl -s "https://developer.mozilla.org/api/v1/search?q=<urlencoded listing name>&locale=en-US" > /tmp/mdn-search.json
```

If a search hit's `url` starts with `/en-US/docs/Web/` and matches the feature, that's the MDN page. If MDN coverage is real (has Specifications + Browser compat sections), treat as covered. If unclear, prefer to generate a gendn page.

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

Full reference page. Templates: `v149/css-gap-decorations/index.html` (CSS) or `v149/webmcp/index.html` (Web API).

Every page MUST include:

1. `<link rel="stylesheet" href="/public/styles.css">`
2. Crumbs to `/v<N>/`
3. Lede block: eyebrow (`v<N> · <category short>`), H1 (LISTING name), lede paragraph (summary)
4. `<h2>at a glance</h2>` table: Shipped in, Status, Flag, Standards positions, Spec, Explainer, ChromeStatus link
5. `<h2>why it exists</h2>` paragraph (motivation), with citation line
6. `<h2>shape of the API</h2>` or `<h2>the properties</h2>` with `.doc-table` describing methods/attributes/properties. Cite source.
7. `<h2>example</h2>` or `<h2>recipes</h2>` with `<pre><code>` snippets. For CSS, embed a live demo using the actual property.
8. `<h2>browser support</h2>` table from chromestatus views, with citation.
9. `<h2>see also</h2>` with related links and the chrome-platform-showcase URL for the same `v<N>/<slug>/`.
10. Byline footer.

Inline `<style>` block can use: `.doc-table`, `.citation`, `.warn-block` (only for experimental / origin-trial pages). Don't reinvent them.

**Experimental / origin-trial features ALWAYS get a `.warn-block` after the lede.**

Content rules:
- Cite sources inline after each section: `<span class="citation">Source: ...</span>`.
- Never invent method names. Paraphrase + link to spec if unsure.
- IDL: include verbatim if you can fetch it; describe in prose otherwise.
- HTTP features: show header name + example request/response.
- Length: comparable to the seed pages. Long enough to use the API, short enough to read in two minutes.

Every page (Case A or B) MUST include the `chromestatus.com/feature/<id>` link in references. This is how we recover from glitches.

## Step 7: Commit per feature, push, move on

```bash
git add v<N>/<slug>/
git commit -m "v<N>: reference for <listing name>

<note: 'generated from spec' or 'MDN stub'>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

One feature per commit. If past 45 minutes, stop.

## Step 8: Summary at end

Log channels, per-milestone counts, features completed (SHA + live URL), stop reason, MDN stubs with the MDN URLs.

## Safety

- Never overwrite existing `v<N>/<slug>/`.
- Never edit outside `v<N>/` and `/tmp`. `server.ts`, `lib/`, `public/` are off-limits.
- Pushes go to main. No branches. No issues.
- Respect the 45-minute deadline.
- **Slug from listing name; milestone from listing position. Both inviolable.**
