# Implementation-sufficiency reference contract

A gendn page is **published** when its stable feature route exists. It is
**implementation-sufficient** only when a source-derived `reference-contract.json` proves that the
whole developer-facing surface maps to detailed local documentation.

These are separate denominators. Existing pages without a contract are `legacy-unassessed`, not
silently complete.

## Authoring sequence

1. Read current primary sources and list the entire developer-facing surface before writing prose.
2. Put that list in `inventory`. Include members and types that affect implementation, not only the
   three most interesting methods.
3. Keep the feature overview scannable. Give substantial members or protocol elements stable child
   routes such as:
   - `/v147/web-printing-api/navigator-printing/get-printers/`
   - `/v147/web-printing-api/web-printer/fetch-attributes/`
   - `/v147/web-printing-api/web-printer/print-job/`
4. Map every inventory item to one overview fragment or child page in `documentation`.
5. Cover all nine dimensions. `not-applicable` needs a specific sourced rationale. Use `missing`
   when research or writing is unfinished and keep the whole contract `partial`.
6. Link cited primary sources directly from every target page.
7. Run the structural gates, then have an independent reviewer compare the inventory and prose with
   the current primary sources.

## Required dimensions

| Dimension | Required content |
|---|---|
| `syntax` | Exact call, grammar, header syntax, or algorithm entry point. Must be documented. |
| `inputs` | Parameters, fields, accepted types/values, defaults, constraints, and validation. |
| `outputs` | Return values, response fields, observable effects, and settlement behavior. |
| `errors` | Exceptions, rejection/status paths, malformed input, and recovery behavior. |
| `context` | Receiver, exposure, secure/install/policy/permission requirements, and prerequisites. |
| `lifecycle` | Ordering, state transitions, timing, cancellation, cleanup, retries, and idempotency. |
| `examples` | At least one complete semantic `<pre><code>` example. Must be documented. |
| `compatibility` | Browser/runtime/platform table, including explicit unknowns. Must be documented. |
| `securityPrivacy` | Threats, trust boundaries, disclosure, storage, permission, and privacy effects. |

## Minimal shape

```json
{
  "schemaVersion": 1,
  "id": "v147/example-api",
  "route": "/v147/example-api/",
  "kind": "web-api",
  "completeness": "implementation-sufficient",
  "assessedAt": "2026-07-26",
  "assessor": "independently reviewed",
  "sources": [
    {
      "id": "spec",
      "label": "Example API specification",
      "url": "https://example.com/spec#example-method",
      "kind": "normative-spec"
    }
  ],
  "inventory": [
    {
      "id": "example-method",
      "name": "Example.method()",
      "kind": "method",
      "sourceRefs": ["spec"]
    }
  ],
  "documentation": [
    {
      "inventoryId": "example-method",
      "href": "example/method/",
      "dimensions": {
        "syntax": { "status": "documented", "selector": "#syntax", "sourceRefs": ["spec"] },
        "inputs": { "status": "documented", "selector": "#parameters", "sourceRefs": ["spec"] },
        "outputs": { "status": "documented", "selector": "#return-value", "sourceRefs": ["spec"] },
        "errors": { "status": "documented", "selector": "#exceptions", "sourceRefs": ["spec"] },
        "context": { "status": "documented", "selector": "#requirements", "sourceRefs": ["spec"] },
        "lifecycle": { "status": "documented", "selector": "#lifecycle", "sourceRefs": ["spec"] },
        "examples": { "status": "documented", "selector": "#examples", "sourceRefs": ["spec"] },
        "compatibility": { "status": "documented", "selector": "#compatibility", "sourceRefs": ["spec"] },
        "securityPrivacy": { "status": "documented", "selector": "#security-and-privacy", "sourceRefs": ["spec"] }
      }
    }
  ]
}
```

## What the validator proves—and does not prove

The structural validator proves exact inventory-to-documentation reconciliation, stable
same-feature targets, required fragment existence, substantive section content, semantic code
examples, compatibility tables, source-reference integrity, and real `<a href>` source links. The
browser-backed gate then checks computed visibility and layout for every mapped fragment and source
link, so comments, closed disclosures, hidden styles, zero opacity, and zero-size boxes cannot satisfy
the contract. Touched non-stub features fail unless both passes accept an
`implementation-sufficient` contract.

Neither pass proves that the source inventory is complete or the prose is factually correct. Those
remain independent review obligations. A page length, authored claim, nearby source link, or green
route cannot substitute for that review.
