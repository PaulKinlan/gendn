// gendn-gt7 MIME-seam probe (intentionally inert).
// This file exists so the security-headers fixture can pin the server's release-asset
// script MIME policy: readReleaseAsset must serve authored .js under v<N>/ as
// text/plain (with the global nosniff), so routine-authored JavaScript can never
// execute on gendn's origin under CSP script-src 'self'. If you are here because a
// release page legitimately needs local JS, that is a deliberate, reviewed decision:
// change RELEASE_INERT_SCRIPT_MIME and THREAT_MODEL §4.3 together, with browser
// evidence. Comment-only by design - there is nothing to execute.
