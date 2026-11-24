// Cloudflare Workers entry (production). See wrangler.jsonc and scripts/build-worker-assets.mjs.
//
// Same pipeline as the Node dev server and the legacy Deno entry: serveRequest() from server.ts.
// The only difference is where files come from. Workers have no filesystem, so the release pages,
// public/ assets and conformance reports are uploaded as static assets, read through the ASSETS
// binding, and listed from the build-time index dist/site-files.json.

import { indexedSiteFS, setSiteFS } from "./lib/site-fs.ts";
import { serveRequest } from "./server.ts";
import SITE_FILES from "./dist/site-files.json" with { type: "json" };

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

let installed = false;

function install(env: Env): void {
  if (installed) return;
  setSiteFS(indexedSiteFS(SITE_FILES as string[], async (path) => {
    const url = `https://assets.invalid/${path.split("/").map(encodeURIComponent).join("/")}`;
    const res = await env.ASSETS.fetch(new Request(url));
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  }));
  installed = true;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    install(env);
    return serveRequest(request);
  },
};
