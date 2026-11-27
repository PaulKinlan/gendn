// Shared print-editorial site shell for gendn hub & navigation routes.
// Mirrors chrome-platform-showcase's masthead, channel status pills, and colophon footer
// while honoring gendn's light/dark theme tokens and strict CSP hash invariants.
//
// Guidance consulted (modern-web-guidance@latest):
// - `accessibility`: skip link to main landmark, aria-current="page", >= 44px touch targets,
//   visible focus indicators, polite aria-live filter status.
// - `dark-mode`: <meta name="color-scheme" content="light dark">, semantic CSS variables only.
// - `forms`: explicit <label for>, search input with enterkeyhint="search", accessible clear button.
// - `css`: scoped under .shell-page so all 294 published reference pages retain their tested
//   layout width, spacing, and computed-style contracts untouched.

import type { Channels } from "./chromestatus.ts";
import { escapeHTML } from "./html.ts";

export type ShellNavKey = "releases" | "features" | "conformance" | "run-all";

const SHELL_NAV_ITEMS: readonly {
  key?: ShellNavKey;
  label: string;
  href: string;
}[] = [
  { key: "releases", label: "Releases", href: "/" },
  { key: "features", label: "All APIs", href: "/features" },
  { key: "conformance", label: "Conformance", href: "/conformance" },
  { key: "run-all", label: "Run-All", href: "/conformance/run-all" },
  { label: "llms.txt", href: "/llms.txt" },
  { label: "JSON API", href: "/api/features.json" },
];

export function renderSiteHeader(active?: ShellNavKey, mainId = "main-content"): string {
  const navLinks = SHELL_NAV_ITEMS.map((item) => {
    const isCurrent = item.key !== undefined && item.key === active;
    return `<a class="site-nav-link${isCurrent ? " is-active" : ""}" href="${
      escapeHTML(item.href)
    }"${isCurrent ? ' aria-current="page"' : ""}>${escapeHTML(item.label)}</a>`;
  }).join("");

  return `<a class="skip-link" href="#${escapeHTML(mainId)}">Skip to main content</a>
  <header class="site-header">
    <div class="site-header-inner">
      <a class="site-brand" href="/">
        <span class="site-mark" aria-hidden="true">gd</span>
        <span class="site-wordmark">gendn</span>
      </a>
      <nav class="site-nav" aria-label="Primary">${navLinks}</nav>
    </div>
  </header>`;
}

export function renderSiteFooter(opts?: { includeShowcaseLink?: boolean }): string {
  const showcaseLink = opts?.includeShowcaseLink === false
    ? ""
    : `\n      <a href="https://chrome-platform-showcase.com/" target="_blank" rel="noopener">Showcase &nearr;</a>`;
  return `<footer class="byline site-footer">
    <div class="site-footer-meta">
      <strong class="site-footer-title">gendn</strong>
      <span>Made by <a href="https://paul.kinlan.me/" target="_blank" rel="noopener">Paul Kinlan</a> &middot; Data from <a href="https://chromestatus.com/" target="_blank" rel="noopener">ChromeStatus</a>, specs, Chromium IDL &amp; <a href="https://developer.mozilla.org/" target="_blank" rel="noopener">MDN</a></span>
    </div>
    <nav class="site-footer-links" aria-label="Footer">
      <a href="/features">All APIs</a>
      <a href="/conformance">Conformance</a>
      <a href="/api/features.json">JSON API</a>
      <a href="/llms.txt">llms.txt</a>
      <a href="/feed.xml">Atom</a>${showcaseLink}
      <a href="https://github.com/PaulKinlan/gendn" target="_blank" rel="noopener">GitHub &nearr;</a>
    </nav>
  </footer>`;
}

export type ChannelTone = "dev" | "beta" | "rolling" | "stable" | "archive";

export function channelTone(status: string): ChannelTone {
  const s = status.toLowerCase();
  if (s === "dev" || s === "upcoming") return "dev";
  if (s === "beta") return "beta";
  if (s.includes("rolling")) return "rolling";
  if (s.startsWith("stable")) return "stable";
  return "archive";
}

export function statusBadgeFor(channels: Channels, milestone: number): string {
  if (milestone === channels.stable.mstone) return "Rolling out";
  if (milestone === channels.stable.mstone - 1) return "Stable (live)";
  if (milestone === channels.beta.mstone) return "Beta";
  if (milestone === channels.dev.mstone) return "Dev";
  if (milestone < channels.stable.mstone) return "Released";
  return "Upcoming";
}

export function formatStableDate(dateStr: string | undefined): string {
  if (!dateStr) return "";
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Inline client filter script for per-release /v<N>/ hub pages.
// Kept as an exact, formatting-stable constant so its SHA-256 CSP hash matches the rendered
// <script> body byte-for-byte. Uses only textContent, value, hidden, disabled, and
// querySelectorAll — never innerHTML or dynamic code evaluation, and adds zero attributes to
// <li class="demo-card"> (preserving scripts/upstream-summary-narrow.test.mjs verbatim).
export const RELEASE_FILTER_SCRIPT = `
(() => {
  const form = document.getElementById("release-filter-form");
  const search = document.getElementById("release-search");
  const coverage = document.getElementById("release-coverage");
  const clearBtn = document.getElementById("release-clear");
  const summary = document.getElementById("release-filter-summary");
  const emptyEl = document.getElementById("release-empty");
  const cards = Array.from(document.querySelectorAll(".demo-card"));
  const groups = Array.from(document.querySelectorAll("[data-release-group]"));
  if (!search || !coverage || !summary || !cards.length) return;

  function cardHasDoc(card) {
    return card.querySelector(".tag-live, .tag-stub") !== null;
  }

  function applyFilters() {
    const q = (search.value || "").trim().toLowerCase();
    const mode = coverage.value;
    let visible = 0;
    for (const card of cards) {
      const okQuery = !q || (card.textContent || "").toLowerCase().includes(q);
      const hasDoc = cardHasDoc(card);
      const okCoverage = !mode || (mode === "documented" ? hasDoc : !hasDoc);
      const show = okQuery && okCoverage;
      card.hidden = !show;
      if (show) visible++;
    }
    for (const group of groups) {
      const count = group.querySelectorAll(".demo-card:not([hidden])").length;
      group.hidden = count === 0;
    }
    if (emptyEl) emptyEl.hidden = visible > 0;
    if (clearBtn) clearBtn.disabled = !(q || mode);
    summary.textContent = (q || mode)
      ? "Showing " + visible + " of " + cards.length + " features"
      : cards.length + " features in this release";
  }

  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      applyFilters();
    });
  }
  search.addEventListener("input", applyFilters);
  coverage.addEventListener("change", applyFilters);
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      search.value = "";
      coverage.value = "";
      applyFilters();
      search.focus();
    });
  }
  applyFilters();
})();
`;

// Exact CSP SHA-256 token for RELEASE_FILTER_SCRIPT. Verified by scripts/shell-layout.test.mjs.
export const RELEASE_FILTER_SCRIPT_SHA256 = "'sha256-/HrafCKVC06U0dsbmdVIewzslVQ/8TIQliVbh8tOrJk='";
