// Node entry for local development and tests: `npm run dev` / `npm start` (node serve.ts).
//
// Production runs on Cloudflare Workers (worker.ts). This bridges node:http to the same
// serveRequest() pipeline, reading the working tree through lib/site-fs.ts's node:fs default, so a
// page that renders here renders identically on the Worker. Node 22.18+ runs this .ts file
// directly (type stripping), with no build step.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { serveRequest } from "./server.ts";

function toRequest(req: IncomingMessage, port: number): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${port}`}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // Required by Node's fetch types whenever a stream body is passed.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

// Response compression, as production gets it: Cloudflare compresses at the edge, and the old Deno
// entry used Deno.serve's automaticCompression. Same negotiation rules as that runtime: br, then
// gzip; only compressible types; never over an existing coding, a no-transform response, a
// bodiless status or HEAD; vary gains accept-encoding and a strong ETag becomes weak.
const COMPRESSIBLE =
  /^(text\/|application\/(json|javascript|xml|manifest\+json|ld\+json)|image\/svg\+xml)/i;

function acceptedCodings(header: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (name && !(q && Number(q.slice(2)) === 0)) out.add(name);
  }
  return out;
}

function chooseCoding(req: IncomingMessage, response: Response): "br" | "gzip" | null {
  if (req.method === "HEAD" || response.body === null) return null;
  if ([101, 204, 205, 304].includes(response.status)) return null;
  if (response.headers.has("content-encoding")) return null;
  if (/no-transform/i.test(response.headers.get("cache-control") ?? "")) return null;
  if (!COMPRESSIBLE.test(response.headers.get("content-type") ?? "")) return null;
  const accepted = acceptedCodings(req.headers["accept-encoding"] as string | undefined);
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip")) return "gzip";
  return null;
}

async function writeResponse(req: IncomingMessage, res: ServerResponse, response: Response) {
  const method = req.method ?? "GET";
  const coding = chooseCoding(req, response);
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = name === "set-cookie" ? response.headers.getSetCookie() : value;
  });
  if (method === "HEAD" || response.body === null) {
    res.writeHead(response.status, response.statusText, headers);
    res.end();
    return;
  }
  let body = new Uint8Array(await response.arrayBuffer());
  if (coding) {
    body = new Uint8Array(
      coding === "br"
        ? brotliCompressSync(body, {
          params: { [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length },
        })
        : gzipSync(body),
    );
    headers["content-encoding"] = coding;
    delete headers["content-length"];
    const vary = String(headers["vary"] ?? "");
    if (!/accept-encoding/i.test(vary)) {
      headers["vary"] = vary ? `${vary}, accept-encoding` : "accept-encoding";
    }
    const etag = headers["etag"];
    if (typeof etag === "string" && etag.startsWith('"')) headers["etag"] = `W/${etag}`;
  }
  res.writeHead(response.status, response.statusText, headers);
  res.end(body);
}

const port = Number(process.env.PORT ?? 3000);
const server = createServer(async (req, res) => {
  try {
    await writeResponse(req, res, await serveRequest(toRequest(req, port)));
  } catch (err) {
    console.error(`[gendn] node bridge failed: ${err}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal error");
  }
});
server.listen(port, () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(`Listening on http://localhost:${actual}`);
});
