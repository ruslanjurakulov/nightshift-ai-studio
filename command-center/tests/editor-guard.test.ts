import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The editor's mutating routes: a hard cap on the body they read, and a
 * per-person rate limit in front of them.
 *
 * What would break without these: a chunked upload (no Content-Length) of
 * hundreds of megabytes buffered whole by request.json() before anyone looks
 * at its size; one signed-in person looping saves, creates, exports or sends
 * and filling the database with revisions and the worker with renders; and the
 * opposite, a limit so tight that ordinary editing is refused.
 */

vi.mock("server-only", () => ({}));

const PID = "0b000000-0000-4000-8000-00000000000b";
const ORG = "0a000000-0000-4000-8000-00000000000a";
const ASSET = "0c000000-0000-4000-8000-00000000000c";

type RpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as {
    id: string;
    email: string;
  } | null,
  rpc: (() => ({ data: true, error: null })) as (
    name: string,
    args: Record<string, unknown>,
  ) => RpcResult,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  tableReads: 0,
}));

const builder = (): unknown =>
  new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then")
        return (res: (v: unknown) => unknown) => {
          h.tableReads += 1;
          return Promise.resolve({ data: null, error: null }).then(res);
        };
      return () => builder();
    },
  });

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      h.calls.push({ name, args });
      return Promise.resolve(h.rpc(name, args));
    },
    from: () => builder(),
  }),
}));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({
    supported: true,
    orgs: [],
    current: { id: ORG },
  }),
}));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));

const { readJsonBodyCapped, SMALL_BODY_BYTES } =
  await import("../lib/server/json-body");
const rates = await import("../lib/server/web-rate");
const project = await import("../app/api/editor/projects/[id]/route");
const projects = await import("../app/api/editor/projects/route");
const exportsRoute =
  await import("../app/api/editor/projects/[id]/exports/route");
const send = await import("../app/api/editor/send/route");
const { MAX_DOC_BYTES } = await import("../lib/editor");

const enc = new TextEncoder();
const params = { params: Promise.resolve({ id: PID }) };

/** A request whose body is a stream: no Content-Length, like a chunked upload. */
function chunked(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  onCancel?: () => void,
) {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}

const plain = (method: string, body: unknown) =>
  new Request("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const limiterCalls = () => h.calls.filter((c) => c.name === "take_web_rate");
const otherCalls = () => h.calls.filter((c) => c.name !== "take_web_rate");

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.calls = [];
  h.tableReads = 0;
  h.rpc = () => ({ data: true, error: null });
});

describe("readJsonBodyCapped", () => {
  it("reads an ordinary body exactly like request.json()", async () => {
    const value = {
      base_rev: 3,
      title: "Ünï — 日本語",
      doc: { a: [1, 2, { b: null }] },
    };
    const r = await readJsonBodyCapped(plain("PUT", value), 1000);
    expect(r).toEqual({ ok: true, value });
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = enc.encode(JSON.stringify({ t: "日本語" }));
    const r = await readJsonBodyCapped(
      chunked([bytes.slice(0, 9), bytes.slice(9)]),
      1000,
    );
    expect(r).toEqual({ ok: true, value: { t: "日本語" } });
  });

  it("a body of exactly the cap passes, one byte more does not", async () => {
    const body = JSON.stringify({ s: "x".repeat(90) }); // ASCII: bytes == length
    const n = body.length;
    expect((await readJsonBodyCapped(chunked([enc.encode(body)]), n)).ok).toBe(
      true,
    );
    expect(
      await readJsonBodyCapped(chunked([enc.encode(body)]), n - 1),
    ).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("a declared length over the cap is refused before the body is looked at", async () => {
    const req = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-length": "5000" },
      body: "{}",
    });
    expect(await readJsonBodyCapped(req, 1000)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(req.bodyUsed).toBe(false);
  });

  it("a chunked body with no length is cut off at the cap and the upload cancelled", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const req = new Request("http://localhost/x", {
      method: "PUT",
      body: new ReadableStream({
        pull(c) {
          pulled += 1;
          c.enqueue(chunk); // endless: 256 MB would be 4096 of these
        },
        cancel() {
          cancelled = true;
        },
      }),
      duplex: "half",
    } as RequestInit);
    const r = await readJsonBodyCapped(req, MAX_DOC_BYTES * 2);
    expect(r).toEqual({ ok: false, reason: "too_large" });
    expect(cancelled).toBe(true);
    // The cap is 8 chunks; the stream's own read-ahead adds a few, never the whole upload.
    expect(pulled).toBeLessThan(40);
  });

  it("a lying Content-Length does not lift the cap", async () => {
    const big = new Uint8Array(3000).fill(32);
    const r = await readJsonBodyCapped(
      chunked([big], { "content-length": "10" }),
      1000,
    );
    expect(r).toEqual({ ok: false, reason: "too_large" });
  });

  it("not JSON and no body are 'bad', not an exception", async () => {
    expect(await readJsonBodyCapped(plain("POST", "{nope"), 1000)).toEqual({
      ok: false,
      reason: "bad",
    });
    expect(
      await readJsonBodyCapped(
        new Request("http://localhost/x", { method: "POST" }),
        1000,
      ),
    ).toEqual({
      ok: false,
      reason: "bad",
    });
  });
});

describe("PUT /api/editor/projects/<id> reads at most twice the document cap", () => {
  it("refuses a chunked body (no Content-Length) over the cap as doc_too_large, before the database", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const req = new Request("http://localhost/api/editor/projects/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        pull(c) {
          c.enqueue(chunk);
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await project.PUT(req, params);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "doc_too_large" });
    expect(otherCalls()).toEqual([]);
    expect(h.tableReads).toBe(0);
  });

  it("still refuses by the declared length, and takes a body just under the cap to the validator", async () => {
    const declared = new Request("http://localhost/x", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_DOC_BYTES * 2 + 1),
      },
      body: "{}",
    });
    expect((await project.PUT(declared, params)).status).toBe(413);
    const pad = "x".repeat(MAX_DOC_BYTES * 2 - 60);
    const near = plain("PUT", { base_rev: 1, doc: { pad } });
    const res = await project.PUT(near, params);
    // Past the cap guard: the document is judged by the editor's own rules instead.
    expect([400, 413]).toContain(res.status);
    expect((await res.json()).error).not.toBe("bad_request");
  });
});

describe("the editor's write limits", () => {
  const routes: [
    string,
    string,
    () => Promise<Response>,
    string,
    number,
    number,
  ][] = [
    [
      "save (PUT project)",
      "editor.save",
      () => project.PUT(plain("PUT", { base_rev: 1, doc: {} }), params),
      "x",
      300,
      600,
    ],
    [
      "create (POST projects)",
      "editor.create",
      () => projects.POST(plain("POST", { title: "t", asset_id: ASSET })),
      "x",
      60,
      3600,
    ],
    [
      "export (POST exports)",
      "editor.export",
      () => exportsRoute.POST(plain("POST", { rev: 1 }), params),
      "x",
      30,
      3600,
    ],
    [
      "send (POST send)",
      "editor.send",
      () => send.POST(plain("POST", { asset_id: ASSET, title: "t" })),
      "x",
      120,
      600,
    ],
  ];

  it.each(routes)(
    "%s is limited per person with its own bucket",
    async (_n, bucket, call, _x, max, window) => {
      h.rpc = (name) =>
        name === "take_web_rate"
          ? { data: false, error: null }
          : { data: null, error: null };
      const res = await call();
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "rate_limited" });
      expect(res.headers.get("retry-after")).toBe(String(window));
      expect(limiterCalls()).toEqual([
        {
          name: "take_web_rate",
          args: { p_bucket: bucket, p_max: max, p_window_seconds: window },
        },
      ]);
      // Nothing else ran: no validation, no read, no write.
      expect(otherCalls()).toEqual([]);
      expect(h.tableReads).toBe(0);
    },
  );

  it.each(routes)(
    "%s refuses (503) when the count cannot be read, never lets it through",
    async (_n, _b, call) => {
      h.rpc = (name) => ({
        data: null,
        error:
          name === "take_web_rate" ? { code: "XX000", message: "boom" } : null,
      });
      const res = await call();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "rate_limit_unavailable" });
      expect(otherCalls()).toEqual([]);
    },
  );

  it.each(routes)(
    "%s needs a session before it counts anything",
    async (_n, _b, call) => {
      h.user = null;
      expect((await call()).status).toBe(401);
      expect(h.calls).toEqual([]);
    },
  );

  it("the numbers leave headroom for ordinary editing", () => {
    // Saving is a press of the save button or an export (autosave is a local draft): a few per
    // minute. Each rule allows at least ten per minute and, per hour, more than anyone presses.
    const perMinute = (r: { max: number; windowSeconds: number }) =>
      (r.max * 60) / r.windowSeconds;
    expect(perMinute(rates.EDITOR_SAVE_RATE)).toBeGreaterThanOrEqual(10);
    expect(perMinute(rates.EDITOR_SEND_RATE)).toBeGreaterThanOrEqual(10);
    expect(rates.EDITOR_CREATE_RATE.max).toBeGreaterThanOrEqual(30);
    expect(rates.EDITOR_EXPORT_RATE.max).toBeGreaterThanOrEqual(20);
    for (const r of [
      rates.EDITOR_SAVE_RATE,
      rates.EDITOR_CREATE_RATE,
      rates.EDITOR_EXPORT_RATE,
      rates.EDITOR_SEND_RATE,
    ])
      expect(r.bucket).toMatch(/^[a-z0-9_.:-]{1,64}$/);
  });

  it("an hour of busy editing is never throttled, a loop is stopped", async () => {
    // The database's own counter, as take_web_rate keeps it: one per bucket, fixed window.
    const used = new Map<string, number>();
    h.rpc = (name, args) => {
      if (name !== "take_web_rate") return { data: null, error: null };
      const n = (used.get(String(args.p_bucket)) ?? 0) + 1;
      used.set(String(args.p_bucket), n);
      return { data: n <= Number(args.p_max), error: null };
    };
    // 10 minutes of editing at 6 saves a minute (a very busy person): 60 of the 300.
    for (let i = 0; i < 60; i += 1) {
      const res = await project.PUT(plain("PUT", "{nope"), params);
      expect(res.status).toBe(400); // past the limiter, into the body check
    }
    // A loop: the 301st save of the window is the first one refused.
    for (let i = 60; i < 300; i += 1)
      await project.PUT(plain("PUT", "{nope"), params);
    expect((await project.PUT(plain("PUT", "{nope"), params)).status).toBe(429);
  });

  it("falls back to a per-process counter before the limiter function exists", async () => {
    h.rpc = (name) => ({
      data: null,
      error:
        name === "take_web_rate" ? { code: "PGRST202", message: "x" } : null,
    });
    const res = await exportsRoute.POST(plain("POST", "{nope"), params);
    expect(res.status).toBe(400); // allowed through the fallback, then judged on its body
  });
});

describe("the small routes cap their body too", () => {
  const huge = () =>
    chunked(Array.from({ length: 64 }, () => new Uint8Array(1024).fill(32)));

  it("projects POST, exports POST and send POST refuse a chunked body over the small cap", async () => {
    expect(SMALL_BODY_BYTES).toBeLessThanOrEqual(65_536);
    for (const call of [
      () => projects.POST(huge()),
      () => exportsRoute.POST(huge(), params),
      () => send.POST(huge()),
    ]) {
      h.calls = [];
      const res = await call();
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "bad_request" });
      expect(otherCalls()).toEqual([]);
    }
  });
});
