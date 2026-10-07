// gendn-izwu MIME-seam probe (intentionally inert).
// This file exists so the security-headers fixture can pin the server's public-asset
// script MIME policy: readPublicAsset must serve .js under /public/ as
// text/plain (with the global nosniff), so same-origin JavaScript can never
// execute on gendn's origin under CSP script-src 'self'. If you are here because a
// public asset legitimately needs executable JS, that is a deliberate, reviewed decision:
// change RELEASE_INERT_SCRIPT_MIME and THREAT_MODEL §4.3 together, with browser
// evidence. Comment-only by design - there is nothing to execute.
