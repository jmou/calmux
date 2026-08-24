// A thin fetch-style adapter over node:http, so handlers stay plain
// (Request) => Response functions and remain trivial to call from tests.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Handler = (req: Request) => Promise<Response>;

export interface ServerHandle {
  readonly port: number;
  shutdown(): Promise<void>;
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const url = new URL(req.url ?? "/", `http://${headers.get("host") ?? "localhost"}`);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null,
    // Node requires this whenever a streaming body is attached.
    duplex: "half",
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response) {
  for (const [key, value] of response.headers) res.setHeader(key, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.writeHead(response.status);
  if (response.body) {
    await pipeline(Readable.fromWeb(response.body), res);
  } else {
    res.end();
  }
}

export function serve(
  handler: Handler,
  options: { port?: number; hostname?: string } = {},
): Promise<ServerHandle> {
  const server = createServer((req, res) => {
    (async () => {
      try {
        await send(res, await handler(toRequest(req)));
      } catch (e) {
        console.error("request failed:", e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8000, options.hostname, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        shutdown: () =>
          new Promise<void>((done, fail) => {
            server.close((e) => (e ? fail(e) : done()));
            // close() only stops new connections; keep-alive sockets that are
            // between requests would otherwise hold the server open.
            server.closeIdleConnections();
          }),
      });
    });
  });
}
