import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake model vendor on 127.0.0.1 (no network, no key that means anything). It records every request it gets, and answers with whatever
 * the test scripted. `vendorFetch` is a `fetch` that sends a request meant for a vendor's fixed https host to this server instead, keeping
 * the path, the query, the method and the headers, and remembers which URL the code under test ASKED for, so a test can prove the host was
 * the vendor's own and that nothing else was contacted.
 */
export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type Script = (req: SeenRequest, res: ServerResponse) => void;

export interface Loopback {
  port: number;
  seen: SeenRequest[];
  /** The URLs the code asked for, before they were pointed at the loopback server. */
  asked: string[];
  /** Replace what the vendor answers. */
  answer: (script: Script) => void;
  fetch: typeof fetch;
  close: () => Promise<void>;
}

export const json = (status: number, body: unknown, extra: Record<string, string> = {}): Script => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

export async function startLoopback(allowedHosts: readonly string[]): Promise<Loopback> {
  let script: Script = json(200, {});
  const seen: SeenRequest[] = [];
  const asked: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rec: SeenRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(rec);
      script(rec, res);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const realFetch = globalThis.fetch;
  const vendorFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const asked_ = input instanceof Request ? input.url : String(input);
    asked.push(asked_);
    const u = new URL(asked_);
    if (u.protocol !== "https:" || !allowedHosts.includes(u.host)) {
      throw new TypeError(`loopback: a request to ${u.protocol}//${u.host} is not one of the allowed vendor hosts`);
    }
    return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
  return {
    port,
    seen,
    asked,
    answer: (s) => {
      script = s;
    },
    fetch: vendorFetch,
    close: () => new Promise<void>((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
