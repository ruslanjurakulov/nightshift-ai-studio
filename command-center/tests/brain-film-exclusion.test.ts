import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chat's own reads (GET /api/brain, the panel's latest conversation; GET /api/brain/history, its list) leave out a project's
 * own conversation (the film editor's storyboard writer, lib/server/brain/film-plan) by the SAME predicate the film route finds it
 * by: `brief->film_plan->>film_id IS NULL`. What would break without these: the chat resuming a project's conversation as its latest
 * (and writing its BRIEF over the project's marker), or a chat whose BRIEF happens to carry `film_plan: null` or `film_plan: {}` (no
 * project's) vanishing from the chat. `brief->film_plan IS NULL` was the old key: JSON null is not SQL NULL, so it got both wrong.
 *
 * The fake database evaluates each filter the route sends on the stored rows, as PostgREST would: `a->b` is SQL NULL for a missing
 * key and JSON null for a null value; `a->>b` is SQL NULL for both.
 */

vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");

const ORG = "11111111-2222-3333-4444-555555555555";
const FILM = "bbbbbbbb-0000-4000-8000-000000000002";
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Row = Record<string, unknown> & { brief: unknown };
const db = { rows: [] as Row[] };

/** A column or a JSON path ("brief->film_plan->>film_id") on a row: undefined is SQL NULL, null is JSON null. */
function valueOf(row: Record<string, unknown>, path: string): unknown {
  const text = path.includes("->>");
  const [head, ...keys] = path.split(/->>?/);
  let v: unknown = row[head];
  for (const k of keys) {
    if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v) || !(k in (v as object))) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  if (text) return v === null || v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v);
  return v;
}

function table(name: string) {
  const filters: ((r: Record<string, unknown>) => boolean)[] = [];
  let limit = Infinity;
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = (c: string, v: unknown) => { if (!c.includes(".")) filters.push((r) => valueOf(r, c) === v); return b; };
  b.neq = (c: string, v: unknown) => { filters.push((r) => valueOf(r, c) !== v); return b; };
  // IS NULL: SQL NULL only. A plain column's null is SQL NULL; a `->` path's JSON null is not (the old key's mistake).
  b.is = (c: string, v: null) => {
    if (v === null) filters.push((r) => { const x = valueOf(r, c); return x === undefined || (x === null && !c.includes("->")); });
    return b;
  };
  b.or = () => b;
  b.order = () => b;
  b.limit = (n: number, opts?: { referencedTable?: string }) => { if (!opts?.referencedTable) limit = n; return b; };
  b.maybeSingle = async () => (name === "channels" ? { data: { org_id: ORG, name: "Chan" }, error: null } : { data: null, error: null });
  b.then = (resolve: (v: unknown) => void) => {
    if (name !== "ai_chat_sessions") return resolve({ data: [], error: null });
    // Newest activity first, as both routes order.
    const rows = db.rows.filter((r) => filters.every((f) => f(r)))
      .sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at))).slice(0, limit);
    return resolve({ data: rows, error: null });
  };
  return b;
}

const client = {
  from: (t: string) => table(t),
  rpc: async (fn: string) => {
    if (fn === "sellable_models") return { data: [{ id: "anthropic-claude-sonnet-5-5" }], error: null };
    if (fn === "ai_chat_quota") return { data: { used: 3, limit: 30, max_input_chars: 2000, model_ref: ref("anthropic-claude-sonnet-5-5") }, error: null };
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => ({ ok: true, role: "editor", orgId: ORG, source: "org" }) }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: ORG, role: "owner" } }) }));
vi.mock("@/lib/server/brain/google-gate", () => ({ chatModelGate: async () => null, chatGateVerdict: () => null }));

const latest = (await import("@/app/api/brain/route")).GET;
const history = (await import("@/app/api/brain/history/route")).GET;

const row = (n: number, brief: unknown, minute: number): Row => ({
  id: id(n), org_id: ORG, channel_id: "chan-1", created_by: "user-1", step: "asking", slots: {}, card: null, brief,
  updated_at: `2026-11-27T10:${String(minute).padStart(2, "0")}:00Z`, plan_title: null, ai_chat_messages: [{ content: `chat ${n}` }],
});

beforeEach(() => {
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = ORG;
  process.env.AI_CHAT_ANTHROPIC_API_KEY = "test-anthropic-key";
  db.rows = [];
});

const BRIEFS: [string, unknown][] = [
  ["{}", {}],
  ["{film_plan: null}", { film_plan: null }],
  ["{film_plan: {}}", { film_plan: {} }],
];

describe("only a conversation marked with a project's id is left out of the chat", () => {
  it.each(BRIEFS)("a BRIEF of %s is the chat's own: /api/brain resumes it and the history lists it", async (_n, brief) => {
    db.rows = [row(1, brief, 1)];
    const a = await (await latest(new Request("https://x/api/brain?channel=chan-1"))).json();
    expect(a.session?.id).toBe(id(1));
    const h = await (await history(new Request("https://x/api/brain/history?channel=chan-1"))).json();
    expect(h.sessions.map((s: { id: string }) => s.id)).toEqual([id(1)]);
  });

  it("a newer marked conversation never becomes /api/brain's latest, and is never listed", async () => {
    db.rows = [row(1, {}, 1), row(2, { film_plan: null }, 2), row(3, { film_plan: {} }, 3), row(4, { film_plan: { film_id: FILM } }, 59)];
    const a = await (await latest(new Request("https://x/api/brain?channel=chan-1"))).json();
    expect(a.session?.id).toBe(id(3));
    const h = await (await history(new Request("https://x/api/brain/history?channel=chan-1"))).json();
    expect(h.sessions.map((s: { id: string }) => s.id).sort()).toEqual([id(1), id(2), id(3)]);
  });

  it("with only a marked conversation there is no latest: the chat starts its own", async () => {
    db.rows = [row(4, { film_plan: { film_id: FILM } }, 59)];
    const a = await (await latest(new Request("https://x/api/brain?channel=chan-1"))).json();
    expect(a.session).toBeNull();
    const h = await (await history(new Request("https://x/api/brain/history?channel=chan-1"))).json();
    expect(h.sessions).toEqual([]);
  });
});
