import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";

/** A well-formed key built at run time: no literal key-shaped string lives in the repository. */
export const TEST_KEY = "nsk_live_" + "Ab3".repeat(15).slice(0, 43);

/**
 * A fake Nightshift API on 127.0.0.1. `routes` maps "METHOD /path" to a
 * function (req, body, n) -> {status, body, headers} or a plain object (200).
 * Every request is recorded.
 */
export async function fakeApi(routes) {
  const seen = [];
  const counts = {};
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const url = new URL(req.url, "http://x");
      const route = `${req.method} ${url.pathname.replace(/^\/api\/v1/, "")}`;
      seen.push({ route, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      counts[route] = (counts[route] ?? 0) + 1;
      let handler = routes[route];
      if (!handler) handler = { status: 404, body: { error: { type: "not_found_error", code: "unknown_endpoint", message: "No such endpoint.", request_id: "req_test" } } };
      let out = typeof handler === "function" ? handler(req, body, counts[route]) : handler;
      if (out && out.body === undefined && out.raw === undefined) out = { status: 200, body: out };
      const headers = { "x-request-id": "req_test123", ...(out.headers ?? {}) };
      if (out.raw !== undefined) {
        res.writeHead(out.status ?? 200, { "content-type": "video/mp4", ...headers });
        res.end(out.raw);
        return;
      }
      res.writeHead(out.status ?? 200, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)), server };
}

export const apiError = (status, code, message, extra = {}, headers = {}) => ({
  status,
  headers,
  body: { error: { type: "api_error", code, message, request_id: "req_test123", ...extra } },
});

/** Run the real CLI in-process with a temp config dir and a fake clock. */
export async function run(argv, { api, env = {}, stdin, cwd, keyless = false, configDir, fetch } = {}) {
  const dir = configDir ?? (await mkdtemp(join(tmpdir(), "ns-cli-")));
  const out = [];
  const err = [];
  const sleeps = [];
  let clock = 1_000_000;
  const io = {
    stdout: { write: (s) => out.push(s), isTTY: false },
    stderr: { write: (s) => err.push(s), isTTY: false },
    stdin: stdin ?? Object.assign(emptyStdin(), { isTTY: false }),
    env: {
      NIGHTSHIFT_CONFIG_DIR: dir,
      ...(keyless ? {} : { NIGHTSHIFT_API_KEY: TEST_KEY }),
      ...(api ? { NIGHTSHIFT_BASE_URL: api.url } : {}),
      ...env,
    },
    platform: process.platform,
    home: dir,
    cwd: cwd ?? dir,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    fetch: fetch ?? ((...a) => globalThis.fetch(...a)),
  };
  const code = await main(argv, io);
  return { code, stdout: out.join(""), stderr: err.join(""), sleeps, dir, all: out.join("") + err.join("") };
}

export function emptyStdin() {
  return {
    setEncoding() {},
    on(ev, fn) {
      if (ev === "end") queueMicrotask(fn);
      return this;
    },
  };
}

export function stdinWith(text) {
  return {
    isTTY: false,
    setEncoding() {},
    on(ev, fn) {
      if (ev === "data") queueMicrotask(() => fn(text));
      if (ev === "end") setTimeout(fn, 5);
      return this;
    },
  };
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}
