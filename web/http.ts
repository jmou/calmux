// A thin fetch-style adapter over node:http, so handlers stay plain
// (Request) => Response functions and remain trivial to call from tests.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Handler = (req: Request) => Promise<Response>;

export interface ServerHandle {
  // 0 for a socket that has no port, such as an inherited unix socket.
  readonly port: number;
  shutdown(): Promise<void>;
}

const SD_LISTEN_FDS_START = 3;

// systemd hands activated sockets to the service as consecutive file
// descriptors starting at 3, and says how many in LISTEN_FDS. Returns the
// first one, or null when we were not socket-activated.
export function listenFd(): number | null {
  const { LISTEN_PID, LISTEN_FDS } = process.env;
  // The variables are inherited by children, so they are only ours if the pid
  // matches; otherwise fd 3 belongs to whatever our parent opened next.
  if (LISTEN_PID !== String(process.pid)) return null;
  const count = Number(LISTEN_FDS);
  if (!Number.isInteger(count) || count < 1) return null;
  if (count > 1) console.warn(`Ignoring all but the first of ${count} activated sockets`);
  return SD_LISTEN_FDS_START;
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
  options: { port?: number; hostname?: string; fd?: number } = {},
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
    // An inherited socket is already bound and listening; Node only needs to
    // adopt the descriptor, and address/port are whatever systemd chose.
    const target = options.fd !== undefined
      ? { fd: options.fd }
      : { port: options.port ?? 8000, host: options.hostname };
    server.listen(target, () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
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
