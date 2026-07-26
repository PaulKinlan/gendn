# Source-fidelity critique — Web Printing API

**Reviewed:** 2026-07-26
**Scope:** `v147/web-printing-api/` local reference family.
**Review status:** author self-critique only; independent source-fidelity review pending. The colocated contract intentionally remains `partial`.

## Corrected legacy claims

The former overview presented `navigator.printing.getPrinters()`, a `printerInfo` property, and `WebPrinter.printJob(document, jobAttributes)` as shipped Chrome 147 API. Current primary sources do not support those claims.

- The [current WICG IDL](https://wicg.github.io/web-printing/#window-interface) and [Chromium global binding](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/printing/window_printing.idl) expose `printing` on `WindowOrWorkerGlobalScope`; they do not declare `navigator.printing`.
- The [WICG WebPrinter IDL](https://wicg.github.io/web-printing/#web-printer-interface) and [Chromium WebPrinter IDL](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/printing/web_printer.idl) declare `cachedAttributes()`, `fetchAttributes()`, and `submitPrintJob(job_name, document_data, template_attributes)`. They do not declare `printerInfo` or `printJob()`.
- The [ChromeStatus feature record](https://chromestatus.com/feature/5100352332627968) is currently **Proposed**. Its ship-stage record says desktop first 147 and links the [Intent to Ship](https://groups.google.com/a/chromium.org/d/msgid/blink-dev/698cf37f.710a0220.13b4f7.050d.GAE%40google.com), but the record has no public enabled-by-default milestone. The reference therefore does not claim it shipped in Chrome 147.

The stable local `navigator-printing/get-printers/` and `web-printer/print-job/` route labels are deliberately retained as reader-facing compatibility paths. Their content explicitly corrects the old spelling instead of treating it as an API alias.

## What the reference treats as exact

The contract inventories the full current public WICG/Chromium surface: the global entry point, manager, printer and print-job interfaces; every source-declared method/event; all output/request dictionaries; the media and resolution dictionaries; and every declared enum. It separates three evidence classes:

1. **Normative proposal:** algorithms, permissions policy (`web-printing`, default `self`), origin-specific consent trigger, PDF validation, and event firing rules from the [WICG specification](https://wicg.github.io/web-printing/).
2. **Current Chromium behavior:** synchronous checks and errors, a single in-flight `fetchAttributes()` per printer, job terminal states, signal wiring, and request validation from the [renderer implementation](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/printing/web_printer.cc), [manager implementation](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/printing/web_printing_manager.cc), and [job implementation](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/printing/web_print_job.cc).
3. **IPP mapping/data constraints:** `application/pdf` as the only declared MIME enum, typed attributes, and printer state reasons from the [IDL](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/printing/web_printing_enums.idl), [Mojo contract](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/public/mojom/printing/web_printing.mojom), and [RFC 8011](https://www.rfc-editor.org/rfc/rfc8011#section-5).

## Deliberately unresolved

- WICG marks the manager Window-and-Worker exposed, while `WebPrinter` is Window-exposed. Public sources do not establish a usable worker flow.
- The WICG IDL makes template attributes optional; Chromium’s current binding makes the third `submitPrintJob()` argument required. Examples always pass an object.
- The public proposal does not settle chooser granularity, persisted/transient permission UX, per-job prompting, enterprise policy configuration, IWA install requirements, or retry semantics.
- [BCD](https://github.com/mdn/browser-compat-data/tree/main/api) has no API member data and [webstatus.dev](https://webstatus.dev/?q=Web%20Printing%20API) returns no feature query result as reviewed. Firefox and Safari remain “No signal” in ChromeStatus; absence from those datasets is not treated as a compatibility claim.

These unknowns are marked in the reference and `_questions.json`; they are not filled with behavior inferred from the old overview or the explainer’s historical sketches.
