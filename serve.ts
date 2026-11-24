// Node entry for local development and tests: `npm run dev` / `npm start` (node serve.ts).
//
// Production runs on Cloudflare Workers (worker.ts). This bridges node:http to the same
// serveRequest() pipeline, reading the working tree through lib/site-fs.ts's node:fs default, so a
// page that renders here renders identically on the Worker. Node 22.18+ runs this .ts file
// directly (type stripping), with no build step.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
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

async function writeResponse(res: ServerResponse, response: Response, method: string) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = name === "set-cookie" ? response.headers.getSetCookie() : value;
  });
  res.writeHead(response.status, response.statusText, headers);
  if (method === "HEAD" || response.body === null) {
    res.end();
    return;
  }
  res.end(new Uint8Array(await response.arrayBuffer()));
}

const port = Number(process.env.PORT ?? 3000);
const server = createServer(async (req, res) => {
  try {
    await writeResponse(res, await serveRequest(toRequest(req, port)), req.method ?? "GET");
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
