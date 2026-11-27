import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/brain/history — the customer's own stored Nightshift AI conversations (0199) for the Studio chat's history panel. What would
 * break without these:
 *  - another person's conversation, or the same person's from another workspace or channel, listed or opened in this one (the route
 *    must ask the database for this workspace + this author + this channel, AND drop any row that is not, should RLS ever let one by);
 *  - a guessed or stale session id told apart from "not yours" (one answer, "gone", for both);
 *  - a cursor that reaches the PostgREST filter with anything but a timestamp and a uuid (it is quoted into `or=`);
 *  - the route answering at all where Nightshift AI is off, for nobody signed in, or for a channel the person cannot view.
 * Every database call is mocked; the filters each query was given are recorded and checked.
 */

vi.mock("server-only", () => ({}));

const ORG = "11111111-2222-3333-4444-555555555555";
const OTHER_ORG = "99999999-2222-3333-4444-555555555555";
const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const S2 = "aaaaaaaa-0000-4000-8000-000000000002";
const S3 = "aaaaaaaa-0000-4000-8000-000000000003";

type Call = { table: string; ops: [string, ...unknown[]][] };
const s = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  access: { ok: true } as { ok: boolean; status?: number; error?: string },
  currentOrg: "11111111-2222-3333-4444-555555555555" as string | null,
  sessions: [] as Record<string, unknown>[],
  one: null as Record<string, unknown> | null,
  messages: [] as Record<string, unknown>[],
  calls: [] as Call[],
  roleChecks: [] as unknown[],
}));

function table(name: string) {
  const call: Call = { table: name, ops: [] };
  s.calls.push(call);
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "or", "order", "limit", "neq", "in"]) {
    b[m] = (...args: unknown[]) => {
      call.ops.push([m, ...args]);
      return b;
    };
  }
  b.maybeSingle = async () => {
    if (name === "channels") return { data: { org_id: ORG, name: "Chan" }, error: null };
    if (name === "ai_chat_sessions") return { data: s.one, error: null };
    return { data: null, error: null };
  };
  b.then = (resolve: (v: unknown) => void) => resolve({ data: name === "ai_chat_messages" ? s.messages : s.sessions, error: null });
  return b;
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (t: string) => table(t), rpc: async () => ({ data: null, error: null }) }), getUser: async () => s.user }));
vi.mock("@/lib/auth/org-roles", () => ({
  requireOrgRole: async (scope: unknown) => {
    s.roleChecks.push(scope);
    return s.access;
  },
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: s.currentOrg ? { id: s.currentOrg, role: "owner" } : null }) }));

const { GET } = await import("@/app/api/brain/history/route");
const get = (q: string) => GET(new Request(`https://x/api/brain/history${q}`));
const sessionsQuery = () => s.calls.find((c) => c.table === "ai_chat_sessions")!;
const has = (c: Call, ...op: unknown[]) => c.ops.some((o) => JSON.stringify(o) === JSON.stringify(op));
const row = (o: Record<string, unknown>) => ({
  id: S1, org_id: ORG, channel_id: "c1", created_by: "user-1", step: "asking", updated_at: "2026-11-21T10:00:00.123456+00:00",
  plan_title: null, ai_chat_messages: [{ content: "A desert heist film" }], ...o,
});

beforeEach(() => {
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = `${ORG},${OTHER_ORG}`;
  s.user = { id: "user-1" };
  s.access = { ok: true };
  s.currentOrg = ORG;
  s.sessions = [];
  s.one = null;
  s.messages = [];
  s.calls = [];
  s.roleChecks = [];
});

describe("who may ask", () => {
  it("is a 404 with Nightshift AI off, before anything is read", async () => {
    process.env.NIGHTSHIFT_AI_CHAT = "off";
    expect((await get("?channel=c1")).status).toBe(404);
    expect(s.calls).toEqual([]);
  });

  it("is a 401 for nobody signed in, before anything is read", async () => {
    s.user = null;
    expect((await get("?channel=c1")).status).toBe(401);
    expect(s.calls).toEqual([]);
  });

  it("is a 404 for a channel the person cannot view, and never reads a conversation", async () => {
    s.access = { ok: false, status: 404, error: "not_found" };
    expect((await get(`?channel=c1&session=${S1}`)).status).toBe(404);
    expect(s.calls.some((c) => c.table === "ai_chat_sessions")).toBe(false);
  });

  it("is a 404 for a workspace where Nightshift AI is not open", async () => {
    process.env.NIGHTSHIFT_AI_CHAT_ORGS = OTHER_ORG;
    expect((await get("")).status).toBe(404);
    expect(s.calls.some((c) => c.table === "ai_chat_sessions")).toBe(false);
  });
});

describe("the list", () => {
  it("asks only for this person's conversations in this workspace and channel, newest first", async () => {
    s.sessions = [row({})];
    const res = await get("?channel=c1");
    expect(res.status).toBe(200);
    const q = sessionsQuery();
    expect(has(q, "eq", "org_id", ORG)).toBe(true);
    expect(has(q, "eq", "created_by", "user-1")).toBe(true);
    expect(has(q, "eq", "channel_id", "c1")).toBe(true);
    expect(has(q, "order", "updated_at", { ascending: false })).toBe(true);
    // The person's first message is the one embedded: their words, not the assistant's.
    expect(has(q, "eq", "ai_chat_messages.role", "user")).toBe(true);
    const body = await res.json();
    expect(body.sessions).toEqual([{ id: S1, title: "A desert heist film", updated_at: "2026-11-21T10:00:00.123456+00:00", step: "asking" }]);
    expect(body.next_before).toBeNull();
  });

  it("never lists another person's conversation, or one from another workspace or channel, even if the database returned it", async () => {
    s.sessions = [
      row({ id: S1 }),
      row({ id: S2, created_by: "user-2" }),
      row({ id: S3, org_id: OTHER_ORG }),
      row({ id: "aaaaaaaa-0000-4000-8000-000000000004", channel_id: "c2" }),
      row({ id: "aaaaaaaa-0000-4000-8000-000000000005", channel_id: null }),
    ];
    const body = await (await get("?channel=c1")).json();
    expect(body.sessions.map((x: { id: string }) => x.id)).toEqual([S1]);
  });

  it("without a channel, lists the open workspace's conversations that belong to no channel", async () => {
    s.sessions = [row({ channel_id: null }), row({ id: S2, channel_id: "c1" })];
    const body = await (await get("")).json();
    const q = sessionsQuery();
    expect(has(q, "eq", "org_id", ORG)).toBe(true);
    expect(has(q, "is", "channel_id", null)).toBe(true);
    expect(body.sessions.map((x: { id: string }) => x.id)).toEqual([S1]);
  });

  it("leaves out a project's own conversation (the film editor's storyboard writer): it is not a chat to resume here", async () => {
    s.sessions = [row({})];
    await get("?channel=c1");
    expect(has(sessionsQuery(), "is", "brief->film_plan", null)).toBe(true);
  });

  it("titles a conversation by its plan once there is one, then by the person's first message, cut to 60 characters", async () => {
    s.sessions = [row({ plan_title: "  The   Last Caravan " }), row({ id: S2, ai_chat_messages: [{ content: "x".repeat(80) }] }), row({ id: S3, ai_chat_messages: [] })];
    const body = await (await get("?channel=c1")).json();
    expect(body.sessions.map((x: { title: string }) => x.title)).toEqual(["The Last Caravan", "x".repeat(60), ""]);
  });

  it("hands back a cursor of the database's own values after a full page, and pages with it", async () => {
    s.sessions = Array.from({ length: 30 }, (_, i) => row({ id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}` }));
    const body = await (await get("?channel=c1")).json();
    expect(body.next_before).toBe("2026-11-21T10:00:00.123456+00:00|aaaaaaaa-0000-4000-8000-000000000029");
    s.calls = [];
    s.sessions = [];
    expect((await get(`?channel=c1&before=${encodeURIComponent(body.next_before)}`)).status).toBe(200);
    const or = sessionsQuery().ops.find((o) => o[0] === "or");
    expect(or?.[1]).toBe('updated_at.lt."2026-11-21T10:00:00.123456+00:00",and(updated_at.eq."2026-11-21T10:00:00.123456+00:00",id.lt.aaaaaaaa-0000-4000-8000-000000000029)');
  });

  it.each([
    ["a filter smuggled into the timestamp", '2026-11-21T10:00:00Z",created_by.neq.x'],
    ["a filter smuggled into the id", "2026-11-21T10:00:00Z|x),or(created_by.neq.user-1"],
    ["no timestamp at all", "yesterday"],
  ])("refuses %s as a cursor before any query", async (_name, cursor) => {
    expect((await get(`?channel=c1&before=${encodeURIComponent(cursor)}`)).status).toBe(400);
    expect(s.calls.some((c) => c.table === "ai_chat_sessions")).toBe(false);
  });
});

describe("opening one", () => {
  const stored = (o: Record<string, unknown> = {}) => ({
    id: S1, org_id: ORG, channel_id: "c1", created_by: "user-1", step: "proposing", slots: {}, brief: {}, card: null, handoff: null,
    updated_at: "2026-11-21T10:00:00Z", ...o,
  });

  it("asks for that id only within this workspace, this author and this channel, and draws its messages", async () => {
    s.one = stored();
    s.messages = [{ id: 2, role: "assistant", content: "Here are three ideas", payload: null, created_at: "t2" }, { id: 1, role: "user", content: "A heist", payload: null, created_at: "t1" }];
    const res = await get(`?channel=c1&session=${S1}`);
    expect(res.status).toBe(200);
    const q = sessionsQuery();
    expect(has(q, "eq", "id", S1)).toBe(true);
    expect(has(q, "eq", "org_id", ORG)).toBe(true);
    expect(has(q, "eq", "created_by", "user-1")).toBe(true);
    expect(has(q, "eq", "channel_id", "c1")).toBe(true);
    const body = await res.json();
    expect(body.session.step).toBe("proposing");
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(["A heist", "Here are three ideas"]);
  });

  it.each([
    ["another person's", { created_by: "user-2" }],
    ["another workspace's", { org_id: OTHER_ORG }],
    ["another channel's", { channel_id: "c2" }],
  ])("never opens %s conversation: it is 'gone', and its messages are never read", async (_name, o) => {
    s.one = stored(o);
    const res = await get(`?channel=c1&session=${S1}`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("gone");
    expect(s.calls.some((c) => c.table === "ai_chat_messages")).toBe(false);
  });

  it("answers a missing id exactly as it answers someone else's", async () => {
    s.one = null;
    const res = await get(`?channel=c1&session=${S1}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "gone" });
  });

  it("refuses an id that is not a uuid before any query", async () => {
    expect((await get("?channel=c1&session=1%20or%201=1")).status).toBe(400);
    expect(s.calls.some((c) => c.table === "ai_chat_sessions")).toBe(false);
  });
});
