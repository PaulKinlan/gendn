// gendn — generated reference docs for web platform APIs shipping in Chrome
// that don't yet have a page on MDN.
//
// Same layout convention as chrome-platform-showcase: per-release folders
// at v<N>/<api-slug>/index.html. The index lists every API by release and
// flags each as "on MDN → link out" or "generated here → link to local page".

import { Channels, getChannels, getMilestoneFeatures, slugify } from "./lib/chromestatus.ts";

const PORT = Number(Deno.env.get("PORT") ?? 3000);

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff2: "font/woff2",
};

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function readPublicAsset(path: string): Promise<Response> {
  try {
    const file = await Deno.readFile("." + path);
    const ext = path.split(".").pop() ?? "";
    return new Response(file, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function readReleaseAsset(release: string, sub: string): Promise<Response | null> {
  if (sub.includes("..")) return null;
  let key = sub.replace(/^\/+/, "");
  if (!key) return null;
  if (key.endsWith("/")) key += "index.html";
  else if (!/\.[a-z0-9]+$/i.test(key)) key += "/index.html";
  try {
    const file = await Deno.readFile(`./${release}/${key}`);
    const ext = key.split(".").pop() ?? "";
    return new Response(file, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    return null;
  }
}

// ----- Index page -----

async function renderIndex(channels: Channels): Promise<string> {
  const prevStable = channels.stable.mstone - 1;
  const releases: { mstone: number; status: string; date: string }[] = [
    { mstone: channels.dev.mstone, status: "Dev", date: channels.dev.stable_date },
    { mstone: channels.beta.mstone, status: "Beta", date: channels.beta.stable_date },
    {
      mstone: channels.stable.mstone,
      status: "Stable (rolling out)",
      date: channels.stable.stable_date,
    },
    { mstone: prevStable, status: "Stable (live)", date: "" },
  ];

  const seen = new Set(releases.map((r) => r.mstone));
  try {
    for await (const entry of Deno.readDir(".")) {
      if (entry.isDirectory && /^v\d+$/.test(entry.name)) {
        const m = Number(entry.name.slice(1));
        if (!seen.has(m)) {
          releases.push({ mstone: m, status: "Archive", date: "" });
          seen.add(m);
        }
      }
    }
  } catch {
    // ignore
  }
  releases.sort((a, b) => b.mstone - a.mstone);

  const cards = releases.map((r) => {
    let note: string;
    if (r.date) {
      note = `Stable date: ${
        new Date(r.date).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      }`;
    } else if (r.status === "Archive") {
      note = "Backfilled";
    } else {
      note = "Most users are here";
    }
    return `<li class="release-card">
      <a href="/v${r.mstone}/">
        <span class="release-label">Chrome ${r.mstone}</span>
        <span class="release-status">${escapeHTML(r.status)}</span>
      </a>
      <p class="release-note">${escapeHTML(note)}</p>
    </li>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>gendn — generated web platform docs</title>
  <link rel="stylesheet" href="/public/styles.css">
</head>
<body>
  <main>
    <header class="lede-block">
      <p class="eyebrow">work in progress</p>
      <h1>gendn</h1>
      <p class="lede">Generated reference docs for the APIs that ship in Chrome but don't yet have a page on MDN. When MDN already covers an API, gendn just links out. The goal is the gap between "shipped in Chrome" and "documented on developer.mozilla.org".</p>
    </header>

    <section>
      <h2>releases</h2>
      <ol class="release-list">${cards}</ol>
    </section>

    <section class="how">
      <h2>how it works</h2>
      <ol>
        <li>A daily routine reads <a href="https://chromestatus.com/" target="_blank" rel="noopener">chromestatus.com</a> for features shipping in Chrome (stable, beta, dev, plus prev-stable).</li>
        <li>For each, it checks MDN. If MDN has a page, gendn just links to MDN.</li>
        <li>If MDN doesn't have a page, the routine writes a reference doc generated from the spec, explainer, and the IDL in Chromium source.</li>
        <li>When MDN later ships its own page, the routine notices on the next pass and the gendn entry switches to a "see MDN" stub.</li>
      </ol>
      <p class="note">Sister project: <a href="https://chrome-platform-showcase.paulkinlan-ea.deno.net/" target="_blank" rel="noopener">chrome-platform-showcase</a> — interactive demos for the same set of features. Repo: <a href="https://github.com/PaulKinlan/gendn" target="_blank" rel="noopener">PaulKinlan/gendn</a>.</p>
    </section>

    <footer class="byline">made by <a href="https://paul.kinlan.me/" target="_blank" rel="noopener">Paul Kinlan</a></footer>
  </main>
</body>
</html>`;
}

// ----- Per-release index -----

async function featureHasDoc(release: string, slug: string): Promise<boolean> {
  try {
    await Deno.stat(`./${release}/${slug}/index.html`);
    return true;
  } catch {
    return false;
  }
}

function categoryTag(category: string): string {
  return category
    .replace("In developer trial (Behind a flag)", "Dev Trial")
    .replace("Enabled by default", "Shipped")
    .replace("Origin trial", "Origin Trial")
    .replace("Stepped rollout", "Stepped rollout")
    .replace("Browser Intervention", "Intervention");
}

async function renderReleasePage(release: string, milestone: number): Promise<string> {
  const features = await getMilestoneFeatures(milestone);

  const sections = await Promise.all(features.groups.map(async (group) => {
    const cards = await Promise.all(group.features.map(async (f) => {
      const slug = slugify(f.name);
      const hasDoc = await featureHasDoc(release, slug);
      const summary = (f.summary ?? "").slice(0, 220);
      const docTag = hasDoc
        ? `<a class="tag tag-live" href="/${release}/${slug}/">reference &rarr;</a>`
        : `<span class="tag tag-pending">doc pending</span>`;
      return `<li class="demo-card">
        <h3><a href="https://chromestatus.com/feature/${f.id}" target="_blank" rel="noopener">${
        escapeHTML(f.name)
      }</a></h3>
        <p>${escapeHTML(summary)}${summary.length === 220 ? "..." : ""}</p>
        <div class="demo-tags">
          <span class="tag">${escapeHTML(categoryTag(group.category))}</span>
          ${docTag}
        </div>
      </li>`;
    }));
    return `<section>
      <h3 class="group-title">${
      escapeHTML(categoryTag(group.category))
    } <span class="group-count">(${group.features.length})</span></h3>
      <ol class="demo-list">${cards.join("")}</ol>
    </section>`;
  }));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>chrome ${milestone} reference — gendn</title>
  <link rel="stylesheet" href="/public/styles.css">
</head>
<body>
<main>
  <p class="crumbs"><a href="/">&larr; all releases</a></p>

  <header class="lede-block">
    <p class="eyebrow">chrome ${milestone}</p>
    <h1>chrome ${milestone} api reference</h1>
    <p class="lede">${features.total} features tracked. Each card links to the gendn reference where MDN doesn't yet cover the API, or out to MDN where it does.</p>
  </header>

  <section>
    <h2>features (${features.total})</h2>
    ${sections.join("\n")}
  </section>

  <footer class="byline">made by <a href="https://paul.kinlan.me/" target="_blank" rel="noopener">Paul Kinlan</a></footer>
</main>
</body>
</html>`;
}

async function knownReleaseMilestones(channels: Channels): Promise<Set<number>> {
  const set = new Set<number>([
    channels.stable.mstone - 1,
    channels.stable.mstone,
    channels.beta.mstone,
    channels.dev.mstone,
  ]);
  try {
    for await (const entry of Deno.readDir(".")) {
      if (entry.isDirectory && /^v\d+$/.test(entry.name)) {
        set.add(Number(entry.name.slice(1)));
      }
    }
  } catch {
    // ignore
  }
  return set;
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/" || path === "/index.html") {
    try {
      const channels = await getChannels();
      return new Response(await renderIndex(channels), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (err) {
      return new Response(`Failed to render index: ${err}`, { status: 502 });
    }
  }

  if (path.startsWith("/public/")) return readPublicAsset(path);

  const releaseMatch = path.match(/^\/(v\d+)(\/.*)?$/);
  if (releaseMatch) {
    const release = releaseMatch[1];
    const milestone = Number(release.slice(1));
    const sub = releaseMatch[2] ?? "/";

    let channels: Channels;
    try {
      channels = await getChannels();
    } catch (err) {
      return new Response(`Failed to load channels: ${err}`, { status: 502 });
    }

    const known = await knownReleaseMilestones(channels);
    if (!known.has(milestone)) {
      return new Response(`Release ${release} not configured yet`, { status: 404 });
    }

    if (sub === "/" || sub === "/index.html") {
      try {
        return new Response(await renderReleasePage(release, milestone), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Failed to render release: ${err}`, { status: 502 });
      }
    }

    return (await readReleaseAsset(release, sub)) ??
      new Response("Not found", { status: 404 });
  }

  return new Response("Not found", { status: 404 });
});

console.log(`Listening on http://localhost:${PORT}`);
