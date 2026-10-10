// Deterministic style snapshot/diff primitives. No browser or file I/O here so fixtures stay fast.
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 },
  mobile: { width: 360, height: 740, mobile: true, deviceScaleFactor: 3 },
};

// Limit repeated content nodes while retaining every distinct component class/structure.
// CSS properties are deliberately explicit: avoid UA/browser-version-only fields and generated content.
export const SELECTORS = [
  "html",
  "body",
  "header",
  "nav",
  "main",
  "article",
  "section",
  "aside",
  "footer",
  "h1",
  "h2",
  "h3",
  "p",
  "a",
  "button",
  "input",
  "table",
  "th",
  "td",
  "pre",
  "code",
  "blockquote",
  ".crumbs",
  ".eyebrow",
  ".lede",
  ".byline",
  ".table-wrap",
  ".doc-table",
  ".baseline-banner",
  ".local-nav",
  ".mdn-card",
  ".release-card",
  ".demo-card",
  ".note",
  ".warn-block",
  ".card",
];
export const PROPERTIES = [
  "display",
  "visibility",
  "position",
  "width",
  "max-width",
  "min-width",
  "height",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "border-top-color",
  "border-top-width",
  "border-radius",
  "opacity",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "grid-template-columns",
  "flex-direction",
  "text-align",
  "overflow-x",
  "box-shadow",
  "border-bottom-color",
  "border-bottom-width",
];

export function captureExpression() {
  return `(async () => {
    // Avoid sampling an animation's arbitrary frame or a late web-font swap.
    const freeze = document.createElement("style");
    freeze.textContent = "*,*::before,*::after{animation:none!important;transition:none!important}";
    document.head.append(freeze);
    await document.fonts.ready;
    const selectors = ${JSON.stringify(SELECTORS)};
    const properties = ${JSON.stringify(PROPERTIES)};
    const result = {};
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)].slice(0, 3);
      nodes.forEach((element, index) => {
        const computed = getComputedStyle(element);
        const styles = {};
        for (const property of properties) styles[property] = computed.getPropertyValue(property).trim();
        result[selector + ":" + index] = styles;
      });
    }
    return result;
  })()`;
}

// A bare glob is intentionally simple and portable: '*' spans any characters, including '/'.
// Multiple patterns are a comma-separated union. Exact route IDs/paths work without a wildcard.
export function selectRoutes(allRoutes, pattern) {
  if (!pattern || !pattern.trim()) throw new Error("--routes requires a non-empty glob/list");
  const patterns = pattern.split(",").map((part) => part.trim()).filter(Boolean);
  if (!patterns.length) throw new Error("--routes requires a non-empty glob/list");
  const regexes = patterns.map((entry) => {
    const glob = entry.startsWith("/") ? entry : `/${entry}`;
    const normalized = glob.endsWith("/") || glob.endsWith("*") ? glob : `${glob}/`;
    return new RegExp(
      `^${normalized.split("*").map((s) => s.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*")}$`,
    );
  });
  const selected = allRoutes.filter((route) => regexes.some((re) => re.test(route)));
  if (selected.length === 0) throw new Error(`--routes matched no published pages: ${pattern}`);
  return selected;
}

// Only leaf reference edits can be scoped safely. Shared CSS, server rendering, or
// tooling changes require an explicit --all sweep rather than a misleading partial pass.
export function selectChangedRoutes(allRoutes, paths) {
  if (!paths.length) throw new Error("--changed found no changed files; pass --routes or --all");
  const selected = new Set();
  for (const path of paths) {
    if (!/^v\d+\//.test(path)) {
      throw new Error(
        `--changed cannot scope shared change ${path}; use --all or --routes explicitly`,
      );
    }
    const directory = path.slice(0, path.lastIndexOf("/") + 1);
    const affected = allRoutes.filter((route) =>
      path.endsWith("/index.html")
        ? path === `${route.slice(1)}index.html`
        : path.startsWith(route.slice(1)) || route.slice(1).startsWith(directory)
    );
    if (!affected.length) {
      throw new Error(`--changed has no published route for ${path}; use --routes explicitly`);
    }
    for (const route of affected) selected.add(route);
  }
  return allRoutes.filter((route) => selected.has(route));
}

export function compareSnapshots(baseline, current) {
  if (baseline?.version !== 1 || current?.version !== 1) {
    throw new Error("unsupported css-drift snapshot version");
  }
  if (baseline.chromeVersion !== current.chromeVersion) {
    throw new Error(
      `css-drift Chrome version mismatch (${baseline.chromeVersion} vs ${current.chromeVersion}); use the same browser for both passes`,
    );
  }
  if (JSON.stringify(baseline.viewports) !== JSON.stringify(current.viewports)) {
    throw new Error("css-drift viewport mismatch; capture a new baseline");
  }
  const differences = [];
  const keys = (obj) => Object.keys(obj ?? {}).sort();
  for (const route of new Set([...keys(baseline.pages), ...keys(current.pages)])) {
    for (const viewport of Object.keys(VIEWPORTS)) {
      const oldNodes = baseline.pages?.[route]?.[viewport];
      const newNodes = current.pages?.[route]?.[viewport];
      if (!oldNodes || !newNodes) {
        differences.push({
          route,
          viewport,
          selector: null,
          property: null,
          before: oldNodes ? "present" : null,
          after: newNodes ? "present" : null,
        });
        continue;
      }
      for (const selector of new Set([...keys(oldNodes), ...keys(newNodes)])) {
        const before = oldNodes[selector];
        const after = newNodes[selector];
        if (!before || !after) {
          differences.push({
            route,
            viewport,
            selector,
            property: null,
            before: before ? "present" : null,
            after: after ? "present" : null,
          });
          continue;
        }
        for (const property of new Set([...keys(before), ...keys(after)])) {
          if (before[property] !== after[property]) {
            differences.push({
              route,
              viewport,
              selector,
              property,
              before: before[property] ?? null,
              after: after[property] ?? null,
            });
          }
        }
      }
    }
  }
  return differences;
}
