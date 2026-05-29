# gendn

Generated reference documentation for web platform APIs that ship in Chrome but don't yet have a
page on MDN. Not a replacement for MDN: when MDN already covers an API, gendn just links out. The
goal is a fast "I know enough to use this" reference for the gap between "shipped in Chrome" and
"documented on developer.mozilla.org".

## How it works (intended end state)

1. Daily routine reads [chromestatus.com](https://chromestatus.com/) for features that have shipped,
   are in origin trial, or are in dev trial.
2. For each, it looks the API up on MDN. If MDN has a page, the entry just links to MDN and stops.
3. If MDN doesn't have a page, the routine generates a reference page from:
   - the chromestatus.com summary, motivation, and links
   - the explainer (when available)
   - the spec (typically WHATWG or W3C)
   - the IDL from Chromium source (`third_party/blink/renderer/`)
4. Pages get committed and pushed; Deno Deploy redeploys.
5. When MDN ships its own page, the routine notices on the next pass and the gendn entry switches to
   a "see MDN" stub.

## Page shape

Each generated page follows a familiar reference layout:

- Title, summary
- Where it shipped (Chrome version, status, flag, origin trial)
- Syntax (IDL block)
- Methods and properties (signatures + 1-line summaries)
- Examples drawn from the spec, explainer, or hand-written
- Browser support (from chromestatus + standards-positions)
- Specifications (links)
- See also (related APIs)
- Citations: every section says where the content came from

## Layout

```
gendn/
  server.ts             Deno HTTP entry. Routes / and /v<N>/<api-slug>/.
  deno.json             Tasks + fmt config.
  lib/
    chromestatus.ts     JSON API wrapper (shared with chrome-platform-showcase).
    mdn.ts              Heuristics for "is this API on MDN yet?".
  public/styles.css     Shared editorial design system.
  v149/
    <api-slug>/index.html
```

## License

Apache 2.0. See [LICENSE](./LICENSE).

Copyright 2026 Paul Kinlan.
