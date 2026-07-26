# gendn

Generated reference documentation for web platform APIs that ship in Chrome but don't yet have a
page on MDN. Not a replacement for MDN: when MDN already covers an API, gendn just links out. The
goal is an implementation-sufficient reference for the gap between "shipped in Chrome" and
"documented on developer.mozilla.org": a developer with only the gendn pages should not have to
infer signatures, protocol fields, errors, lifecycle behavior, or edge cases.

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

## Layout

```
gendn/
  server.ts             Deno HTTP entry. Routes / and /v<N>/<api-slug>/.
  deno.json             Tasks + fmt config.
  lib/
    chromestatus.ts     JSON API wrapper (shared with chrome-platform-showcase).
    mdn.ts              Heuristics for "is this API on MDN yet?".
  public/styles.css     Shared editorial design system.
  docs/reference-contract.md
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
