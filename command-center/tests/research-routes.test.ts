import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/research/* (migration 0202).
 *
 * What would break without these: a route using anything but the person's own session (the service key skips every check); a route
 * that calls YouTube or writes a table itself instead of one writer function (rule 3); a malformed channel, kind, topic or id reaching
 * the database; another organization's channel answering differently from a missing one; the database's refusal words lost (a daily
 * limit shown as a crash), or its message passed through to the browser; 0202 not applied reading as an error instead of "not enabled".
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string };
type Result = { data: unknown; error: Err | null };
const ID = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  rpc: {} as Record<string, Result>,
  calls: [] as { kind: string; name: string; args?: unknown }[],
}));

const client = {
  rpc: async (name: string, args: unknown) => {
    h.calls.push({ kind: "rpc", name, args });
    return h.rpc[name] ?? { data: { ok: true, status: "queued", request_id: 5 }, error: null };
  },
  from: (name: string) => {
    h.calls.push({ kind: "from", name });
    throw new Error("a research route must not touch a table");
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => h.user }));

const refresh = await import("../app/api/research/refresh/route");
const add = await import("../app/api/research/competitors/route");
const remove = await import("../app/api/research/competitors/[id]/route");

const post = (url: string, body: unknown) =>
  new Request(`http://x${url}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://x" }, body: JSON.stringify(body) });
const del = (url: string) => new Request(`http://x${url}`, { method: "DELETE", headers: { origin: "http://x" } });

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.rpc = {};
  h.calls = [];
});

describe("refresh", () => {
  it("calls the one writer with the person's session and answers its closed words only", async () => {
    h.rpc.research_request_refresh = { data: { ok: true, status: "already_queued", request_id: 9, secret_internal: "x" }, error: null };
    const res = await refresh.POST(post("/api/research/refresh", { channel: "chan-a", kind: "competitors" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "already_queued", request_id: 9 });
    expect(h.calls).toEqual([{ kind: "rpc", name: "research_request_refresh", args: { p_channel: "chan-a", p_kind: "competitors", p_topic: null } }]);
  });

  it("passes a topic only for a topic search", async () => {
    await refresh.POST(post("/api/research/refresh", { channel: "chan-a", kind: "topic", topic: "  Deep sea  " }));
    expect(h.calls[0].args).toEqual({ p_channel: "chan-a", p_kind: "topic", p_topic: "Deep sea" });
  });

  it("refuses malformed input before the database", async () => {
    for (const body of [{ channel: "../x", kind: "topic" }, { channel: "chan-a", kind: "everything" }, { channel: "chan-a", kind: "topic", topic: "a" }, {}]) {
      const res = await refresh.POST(post("/api/research/refresh", body));
      expect([400, 404]).toContain(res.status);
    }
    expect(h.calls).toEqual([]);
  });

  it("keeps the database's refusal words and statuses", async () => {
    const cases: [string, number][] = [["daily_limit", 429], ["rate_limited", 429], ["not_connected", 409], ["no_competitors", 409], ["invalid_topic", 400], ["something_new", 500]];
    for (const [word, status] of cases) {
      h.rpc.research_request_refresh = { data: { ok: false, error: word, remedy: "Today's research budget is used" }, error: null };
      const res = await refresh.POST(post("/api/research/refresh", { channel: "chan-a", kind: "own_channel" }));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: word === "something_new" ? "failed" : word });
    }
  });

  it("answers another organization's channel exactly like a missing one, and never passes a message on", async () => {
    h.rpc.research_request_refresh = { data: null, error: { code: "P0002", message: "not_found: chan-b belongs to org X" } };
    const res = await refresh.POST(post("/api/research/refresh", { channel: "chan-b", kind: "own_channel" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    h.rpc.research_request_refresh = { data: null, error: { code: "42501", message: "forbidden" } };
    expect((await refresh.POST(post("/api/research/refresh", { channel: "chan-a", kind: "own_channel" }))).status).toBe(403);
    h.rpc.research_request_refresh = { data: null, error: { code: "XX000", message: "internal detail" } };
    const failed = await refresh.POST(post("/api/research/refresh", { channel: "chan-a", kind: "own_channel" }));
    expect(await failed.json()).toEqual({ error: "failed" });
  });

  it("says not_enabled when 0202 is not applied", async () => {
    h.rpc.research_request_refresh = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    const res = await refresh.POST(post("/api/research/refresh", { channel: "chan-a", kind: "own_channel" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_enabled" });
  });

  it("asks who is calling first", async () => {
    h.user = null;
    const res = await refresh.POST(post("/api/research/refresh", { channel: "chan-a", kind: "own_channel" }));
    expect(res.status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it("refuses a cross-site press", async () => {
    const res = await refresh.POST(new Request("http://x/api/research/refresh", { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" }));
    expect(res.status).toBe(403);
  });
});

describe("competitors", () => {
  it("adds through research_add_competitor and returns the pending id", async () => {
    h.rpc.research_add_competitor = { data: { ok: true, id: ID, already: false, status: "pending", request_id: 3 }, error: null };
    const res = await add.POST(post("/api/research/competitors", { channel: "chan-a", ref: " https://www.youtube.com/@rival " }));
    expect(await res.json()).toEqual({ ok: true, id: ID, already: false, status: "pending", request_id: 3 });
    expect(h.calls[0].args).toEqual({ p_channel: "chan-a", p_ref: "https://www.youtube.com/@rival" });
  });

  it("maps the limit and an unusable reference", async () => {
    h.rpc.research_add_competitor = { data: { ok: false, error: "limit_reached", max: 20 }, error: null };
    expect((await add.POST(post("/api/research/competitors", { channel: "chan-a", ref: "@rival" }))).status).toBe(409);
    expect((await add.POST(post("/api/research/competitors", { channel: "chan-a", ref: "x" }))).status).toBe(400);
  });

  it("removes only with a well-formed id and channel", async () => {
    h.rpc.research_remove_competitor = { data: { ok: true, removed: true }, error: null };
    const res = await remove.DELETE(del(`/api/research/competitors/${ID}?channel=chan-a`), { params: Promise.resolve({ id: ID }) });
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(h.calls[0]).toEqual({ kind: "rpc", name: "research_remove_competitor", args: { p_channel: "chan-a", p_id: ID } });
    h.calls = [];
    const bad = await remove.DELETE(del(`/api/research/competitors/1;drop?channel=chan-a`), { params: Promise.resolve({ id: "1;drop" }) });
    expect(bad.status).toBe(404);
    expect(h.calls).toEqual([]);
  });
});

describe("the routes stay thin", () => {
  it("never use the service key, never call YouTube, never write a table", () => {
    for (const f of ["refresh/route.ts", "competitors/route.ts", "competitors/[id]/route.ts"]) {
      const src = readFileSync(join(__dirname, "..", "app", "api", "research", f), "utf8");
      expect(src).not.toMatch(/SERVICE|service_role|googleapis|youtube\.com|\.from\(/i);
    }
    const helper = readFileSync(join(__dirname, "..", "lib", "server", "research.ts"), "utf8");
    expect(helper).not.toMatch(/SERVICE_KEY|service_role|googleapis/);
  });
});
