import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/inbox/* (migration 0081).
 *
 * What would break without these: a route using anything but the signed-in
 * person's own session (the service key skips the policies and the role checks);
 * a malformed id or key reaching the database; a draft press without the price
 * the person saw or without an idempotency key; an approval that sends anything
 * but the cleaned text on screen; an audit line that carries audience words;
 * another organization's id answering differently from a missing one; a route
 * that writes a table (every write is one of the database functions); and a
 * refusal turning into a 500.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string; details?: string | null };
type Result = { data: unknown; error: Err | null };
const C = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const KEY = "reply-draft:00000000-1111";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  rpc: {} as Record<string, Result>,
  table: {} as Record<string, Result>,
  calls: [] as { kind: string; name: string; args?: unknown; chain: { m: string; a: unknown[] }[] }[],
  audits: [] as { action: string; target?: string; channelId?: string; detail?: Record<string, unknown> }[],
}));

function builder(rec: { chain: { m: string; a: unknown[] }[] }, result: () => Result): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return (...a: unknown[]) => {
        rec.chain.push({ m: String(prop), a });
        return q;
      };
    },
  });
  return q;
}

const client = {
  rpc: (name: string, args: unknown) => {
    const rec = { kind: "rpc", name, args, chain: [] as { m: string; a: unknown[] }[] };
    h.calls.push(rec);
    return builder(rec, () => h.rpc[name] ?? { data: null, error: null });
  },
  from: (name: string) => {
    const rec = { kind: "from", name, chain: [] as { m: string; a: unknown[] }[] };
    h.calls.push(rec);
    return builder(rec, () => h.table[name] ?? { data: { channel_id: "chan-a" }, error: null });
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => h.user }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: (typeof h.audits)[number]) => void h.audits.push(e) }));

const draftRoute = await import("../app/api/inbox/comments/[comment]/draft/route");
const dismissRoute = await import("../app/api/inbox/comments/[comment]/dismiss/route");
const draftOne = await import("../app/api/inbox/drafts/[draft]/route");
const approveRoute = await import("../app/api/inbox/drafts/[draft]/approve/route");
const retryRoute = await import("../app/api/inbox/posts/[post]/retry/route");

const post = (url: string, body: unknown) =>
  new Request(`http://x${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const rpcs = () => h.calls.filter((c) => c.kind === "rpc");
const writes = () => h.calls.filter((c) => c.chain.some((x) => ["insert", "update", "upsert", "delete"].includes(x.m)));

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.rpc = {};
  h.table = {};
  h.calls = [];
  h.audits = [];
});

describe("every route", () => {
  const cases: [string, () => Promise<Response>][] = [
    ["quote", () => draftRoute.GET(new Request("http://x"), { params: Promise.resolve({ comment: C }) })],
    ["draft", () => draftRoute.POST(post("/", { max_credits: 3, idempotency_key: KEY }), { params: Promise.resolve({ comment: C }) })],
    ["dismiss", () => dismissRoute.POST(post("/", { dismissed: true }), { params: Promise.resolve({ comment: C }) })],
    ["edit", () => draftOne.PATCH(post("/", { body: "Hi" }), { params: Promise.resolve({ draft: D }) })],
    ["discard", () => draftOne.DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ draft: D }) })],
    ["approve", () => approveRoute.POST(post("/", { body: "Hi" }), { params: Promise.resolve({ draft: D }) })],
    ["retry", () => retryRoute.POST(post("/", {}), { params: Promise.resolve({ post: P }) })],
  ];
  it("refuses a signed-out caller before touching the database", async () => {
    h.user = null;
    for (const [name, run] of cases) {
      const res = await run();
      expect(res.status, name).toBe(401);
    }
    expect(h.calls).toEqual([]);
  });
  it("turns another organization's id into the same 404 as a missing one", async () => {
    h.rpc = Object.fromEntries(
      ["quote_reply_draft", "request_reply_draft", "dismiss_inbox_comment", "edit_reply_draft", "discard_reply_draft", "approve_reply", "retry_reply_post"].map(
        (n) => [n, { data: null, error: { code: "P0002", message: "not_found" } }],
      ),
    );
    for (const [name, run] of cases) {
      const res = await run();
      expect(res.status, name).toBe(404);
      expect(await res.json(), name).toEqual({ error: "not_found" });
    }
    expect(h.audits).toEqual([]);
  });
  it("never writes a table: every write is a database function", async () => {
    h.rpc = { request_reply_draft: { data: { draft: { id: D, status: "pending" }, credits_held: 3 }, error: null } };
    for (const [, run] of cases) await run();
    expect(writes()).toEqual([]);
  });
});

describe("the files", () => {
  const root = join(__dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  const mine = [...files(join(root, "app/api/inbox")), join(root, "lib/server/comment-inbox.ts"), ...files(join(root, "components/inbox")), join(root, "app/(app)/[channel]/inbox/page.tsx")];
  it("use the session client only: the service key is nowhere in them", () => {
    for (const f of mine) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/SERVICE_KEY|SERVICE_ROLE|service_role|createServiceClient|createAdminClient/i);
    }
  });
  it("ask who is calling through callInbox, which reads the session before anything else", () => {
    const helper = readFileSync(join(root, "lib/server/comment-inbox.ts"), "utf8");
    const call = helper.slice(helper.indexOf("export async function callInbox"), helper.indexOf("export async function channelOf"));
    expect(call.indexOf("getUser()")).toBeGreaterThan(-1);
    expect(call.indexOf("getUser()")).toBeLessThan(call.indexOf("supabase.rpc("));
    for (const f of files(join(root, "app/api/inbox"))) expect(readFileSync(f, "utf8"), f).toContain("callInbox(");
  });
  it("render audience text as text only: no HTML injection, no raw links built from it", () => {
    for (const f of files(join(root, "components/inbox"))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write|eval\(/);
      expect(src, f).not.toMatch(/href=\{[^}]*(body|author|text)/);
    }
  });
});

describe("the draft route", () => {
  it("quotes through the database and never returns the margin", async () => {
    h.rpc = { quote_reply_draft: { data: { status: "priced", credits: 4.5, may_start: true, reply_ready: true, exempt: false, margin: 0.5, credits_per_unit: 3 }, error: null } };
    const res = await draftRoute.GET(new Request("http://x"), { params: Promise.resolve({ comment: C }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote).toMatchObject({ status: "priced", credits: 4.5 });
    expect(JSON.stringify(body)).not.toMatch(/margin|credits_per_unit/);
    expect(rpcs()[0]).toMatchObject({ name: "quote_reply_draft", args: { p_comment: C } });
  });
  it("answers an unset price as unpriced, never as a price", async () => {
    h.rpc = { quote_reply_draft: { data: { status: "unpriced", credits: null }, error: null } };
    const body = await (await draftRoute.GET(new Request("http://x"), { params: Promise.resolve({ comment: C }) })).json();
    expect(body.quote).toMatchObject({ status: "unpriced", credits: null });
  });
  it("sends the price the person saw and one key, and audits the press without any text", async () => {
    h.rpc = { request_reply_draft: { data: { draft: { id: D, status: "pending" }, replay: false, credits_held: "4.5" }, error: null } };
    const res = await draftRoute.POST(post("/", { max_credits: 4.5, idempotency_key: KEY }), { params: Promise.resolve({ comment: C }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: D, status: "pending", credits_reserved: 4.5, replayed: false });
    expect(rpcs()[0]).toMatchObject({ name: "request_reply_draft", args: { p_comment: C, p_max_credits: 4.5, p_idem: KEY } });
    expect(h.audits).toEqual([{ action: "inbox.draft.request", channelId: "chan-a", target: C, detail: { draft_id: D, credits_reserved: 4.5 } }]);
  });
  it("does not audit a replay twice", async () => {
    h.rpc = { request_reply_draft: { data: { draft: { id: D, status: "pending" }, replay: true, credits_held: 0 }, error: null } };
    const res = await draftRoute.POST(post("/", { max_credits: 4.5, idempotency_key: KEY }), { params: Promise.resolve({ comment: C }) });
    expect((await res.json()).replayed).toBe(true);
    expect(h.audits).toEqual([]);
  });
  it("refuses a malformed id, body, price or key before the database", async () => {
    const ctx = { params: Promise.resolve({ comment: C }) };
    expect((await draftRoute.POST(post("/", { max_credits: 4, idempotency_key: KEY }), { params: Promise.resolve({ comment: "../x" }) })).status).toBe(404);
    expect((await draftRoute.POST(post("/", { max_credits: 4 }), ctx)).status).toBe(400);
    expect((await draftRoute.POST(post("/", { max_credits: 4, idempotency_key: "short" }), ctx)).status).toBe(400);
    expect((await draftRoute.POST(post("/", { max_credits: -1, idempotency_key: KEY }), ctx)).status).toBe(400);
    expect((await draftRoute.POST(post("/", { max_credits: "4", idempotency_key: KEY }), ctx)).status).toBe(400);
    expect((await draftRoute.POST(new Request("http://x", { method: "POST", body: "not json" }), ctx)).status).toBe(400);
    expect((await draftRoute.GET(new Request("http://x"), { params: Promise.resolve({ comment: "nope" }) })).status).toBe(404);
    expect(h.calls).toEqual([]);
  });
  it("maps the database's refusals to answers", async () => {
    const run = async (error: Err) => {
      h.rpc = { request_reply_draft: { data: null, error } };
      const res = await draftRoute.POST(post("/", { max_credits: 4.5, idempotency_key: KEY }), { params: Promise.resolve({ comment: C }) });
      return [res.status, await res.json()];
    };
    expect(await run({ code: "NS400", message: "unpriced" })).toEqual([409, { error: "unpriced" }]);
    expect(await run({ code: "NS409", message: "price_changed", details: "credits=6 confirmed=4.5" })).toEqual([409, { error: "price_changed", credits: 6 }]);
    expect(await run({ code: "NS402", message: "insufficient credits", details: "available=1 needed=4.5" })).toEqual([402, { error: "insufficient_credits", needed: 4.5, available: 1 }]);
    expect(await run({ code: "NS400", message: "not_draftable", details: "spam" })).toEqual([409, { error: "not_draftable", reason: "spam" }]);
    expect(await run({ code: "42883", message: "function public.request_reply_draft does not exist" })).toEqual([503, { error: "inbox_unavailable" }]);
    expect(await run({ code: "XX000", message: "boom" })).toEqual([502, { error: "inbox_failed" }]);
    expect(h.audits).toEqual([]);
  });
});

describe("the approval route", () => {
  it("sends the cleaned text on screen and nothing else, and audits who and how long, not what", async () => {
    h.rpc = { approve_reply: { data: { intent_id: I(1), post_id: P, status: "queued", replay: false }, error: null } };
    const res = await approveRoute.POST(post("/", { body: "  It was a Sony\u0007 A7C!  ‮" }), { params: Promise.resolve({ draft: D }) });
    expect(res.status).toBe(200);
    expect(rpcs()[0]).toEqual(expect.objectContaining({ name: "approve_reply", args: { p_draft: D, p_body: "It was a Sony A7C!" } }));
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ action: "inbox.reply.approve", target: D, channelId: "chan-a" });
    expect(JSON.stringify(h.audits)).not.toContain("Sony");
    expect(h.audits[0].detail).toEqual({ intent_id: I(1), post_id: P, chars: 18 });
  });
  it("refuses an empty reply, a non-string body and a bad id before the database", async () => {
    for (const body of [{ body: "" }, { body: "  \u0007 " }, { body: 5 }, {}, null]) {
      const res = await approveRoute.POST(post("/", body), { params: Promise.resolve({ draft: D }) });
      expect([400]).toContain(res.status);
    }
    expect((await approveRoute.POST(post("/", { body: "Hi" }), { params: Promise.resolve({ draft: "x" }) })).status).toBe(404);
    expect(h.calls).toEqual([]);
  });
  it("answers a replay as a replay and audits nothing twice", async () => {
    h.rpc = { approve_reply: { data: { intent_id: I(1), post_id: P, status: "posting", replay: true }, error: null } };
    const res = await approveRoute.POST(post("/", { body: "Hi" }), { params: Promise.resolve({ draft: D }) });
    expect((await res.json()).replayed).toBe(true);
    expect(h.audits).toEqual([]);
  });
  it("passes the database's refusals through: not ready, a channel without permission, not the person's to approve", async () => {
    for (const [error, status, code] of [
      [{ code: "NS409", message: "channel_not_ready" }, 409, "channel_not_ready"],
      [{ code: "NS409", message: "not_approvable" }, 409, "not_approvable"],
      [{ code: "NS409", message: "already_replied" }, 409, "already_replied"],
      [{ code: "NS409", message: "already_approved" }, 409, "already_approved"],
      [{ code: "42501", message: "forbidden" }, 403, "forbidden"],
      [{ code: "NS429", message: "daily_limit" }, 429, "daily_limit"],
    ] as [Err, number, string][]) {
      h.rpc = { approve_reply: { data: null, error } };
      const res = await approveRoute.POST(post("/", { body: "Hi" }), { params: Promise.resolve({ draft: D }) });
      expect([res.status, (await res.json()).error]).toEqual([status, code]);
    }
    expect(h.audits).toEqual([]);
  });
});

describe("edit, discard, dismiss, retry", () => {
  it("edits with the cleaned text and audits only its length", async () => {
    await draftOne.PATCH(post("/", { body: " Better\u0000 words " }), { params: Promise.resolve({ draft: D }) });
    expect(rpcs()[0]).toMatchObject({ name: "edit_reply_draft", args: { p_draft: D, p_body: "Better words" } });
    expect(h.audits[0]).toMatchObject({ action: "inbox.draft.edit", detail: { chars: 12 } });
    expect(JSON.stringify(h.audits)).not.toContain("Better");
  });
  it("refuses an empty edit before the database", async () => {
    expect((await draftOne.PATCH(post("/", { body: "   " }), { params: Promise.resolve({ draft: D }) })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
  it("discards, dismisses and retries through their own database functions", async () => {
    h.rpc = { discard_reply_draft: { data: { already: false }, error: null }, dismiss_inbox_comment: { data: { status: "dismissed", already: false }, error: null }, retry_reply_post: { data: { already: false }, error: null } };
    expect((await draftOne.DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ draft: D }) })).status).toBe(200);
    expect((await dismissRoute.POST(post("/", { dismissed: true }), { params: Promise.resolve({ comment: C }) })).status).toBe(200);
    expect((await dismissRoute.POST(post("/", { dismissed: false }), { params: Promise.resolve({ comment: C }) })).status).toBe(200);
    expect((await retryRoute.POST(post("/", {}), { params: Promise.resolve({ post: P }) })).status).toBe(200);
    expect(rpcs().map((c) => [c.name, c.args])).toEqual([
      ["discard_reply_draft", { p_draft: D }],
      ["dismiss_inbox_comment", { p_comment: C, p_dismissed: true }],
      ["dismiss_inbox_comment", { p_comment: C, p_dismissed: false }],
      ["retry_reply_post", { p_post: P }],
    ]);
    // Setting a comment aside is recorded by the database (inbox_events), not by an audit-log line.
    expect(h.audits.map((a) => a.action)).toEqual(["inbox.draft.discard", "inbox.reply.retry"]);
  });
  it("refuses a dismissed flag that is not a boolean", async () => {
    expect((await dismissRoute.POST(post("/", { dismissed: "yes" }), { params: Promise.resolve({ comment: C }) })).status).toBe(400);
    expect((await retryRoute.POST(post("/", {}), { params: Promise.resolve({ post: "bad" }) })).status).toBe(404);
  });
});

function I(n: number) {
  return `${n}${n}${n}${n}${n}${n}${n}${n}-4444-4444-8444-444444444444`;
}
