import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/media/uploads/<ticket>/dismiss: hide a refused or expired upload
 * card for the person who asks (lib/media-dismiss.ts).
 *
 * What would break without these: a card of another organization (or a
 * made-up id) being dismissable or telling the caller it exists; a ticket
 * that is still in flight, or already a file, being waved away; a signed-out
 * or cross-site call writing to a person's metadata; the service key or any
 * table write sneaking in; a repeat press growing the list; and the list
 * eating the person's other metadata.
 */

vi.mock("server-only", () => ({}));

const ME_ORG = "0a000000-0000-4000-8000-00000000000a";
const OTHER_ORG = "0b000000-0000-4000-8000-00000000000b";
const id = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Row = { id: string; org_id: string; status: string };

const h = vi.hoisted(() => ({
  user: null as { id: string; user_metadata?: Record<string, unknown> } | null,
  memberOf: [] as string[],
  rows: [] as Row[],
  readError: null as { code?: string; message?: string } | null,
  updateError: null as { message: string } | null,
  updateThrows: false,
  updates: [] as { data?: Record<string, unknown> }[],
  tableCalls: [] as { table: string; chain: string[] }[],
}));

// A stand-in for row-level security: a member only ever sees rows of their organizations.
function fromTable(table: string) {
  const chain: string[] = [];
  h.tableCalls.push({ table, chain });
  let wanted: string | null = null;
  const q: Record<string, unknown> = {
    select: () => (chain.push("select"), q),
    eq: (_col: string, v: string) => ((wanted = v), chain.push("eq"), q),
    maybeSingle: async () => {
      chain.push("maybeSingle");
      if (h.readError) return { data: null, error: h.readError };
      const row = h.rows.find((r) => r.id === wanted && h.memberOf.includes(r.org_id));
      return { data: row ? { id: row.id, status: row.status } : null, error: null };
    },
  };
  for (const bad of ["insert", "update", "delete", "upsert", "rpc"]) q[bad] = () => chain.push(bad);
  return q;
}

const client = {
  from: fromTable,
  auth: {
    updateUser: async (attrs: { data?: Record<string, unknown> }) => {
      if (h.updateThrows) throw new Error("boom");
      h.updates.push(attrs);
      return { data: {}, error: h.updateError };
    },
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => client,
  getUser: async () => h.user,
}));
const audit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/server/audit", () => ({ logAudit: audit }));

const { POST } = await import("../app/api/media/uploads/[ticket]/dismiss/route");
const { DISMISS_META_KEY, DISMISS_MAX } = await import("../lib/media-dismiss");

const ORIGIN = "https://app.test";
function call(ticket: string, headers: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin" }) {
  return POST(new Request(`${ORIGIN}/api/media/uploads/${ticket}/dismiss`, { method: "POST", headers }), {
    params: Promise.resolve({ ticket }),
  });
}

beforeEach(() => {
  h.user = { id: "u1", user_metadata: {} };
  h.memberOf = [ME_ORG];
  h.rows = [
    { id: id(1), org_id: ME_ORG, status: "rejected" },
    { id: id(2), org_id: ME_ORG, status: "expired" },
    { id: id(3), org_id: ME_ORG, status: "receiving" },
    { id: id(4), org_id: ME_ORG, status: "uploaded" },
    { id: id(5), org_id: ME_ORG, status: "requested" },
    { id: id(6), org_id: ME_ORG, status: "ingesting" },
    { id: id(7), org_id: ME_ORG, status: "ingested" },
    { id: id(9), org_id: OTHER_ORG, status: "rejected" },
  ];
  h.readError = null;
  h.updateError = null;
  h.updateThrows = false;
  h.updates = [];
  h.tableCalls = [];
  audit.mockClear();
});

describe("who may dismiss", () => {
  it("a signed-out caller is refused before anything is read or written", async () => {
    h.user = null;
    const res = await call(id(1));
    expect(res.status).toBe(401);
    expect(h.tableCalls).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("a request from another site is refused", async () => {
    for (const headers of [{} as Record<string, string>, { origin: "https://evil.test" }, { origin: ORIGIN, "sec-fetch-site": "cross-site" }]) {
      const res = await call(id(1), headers);
      expect(res.status).toBe(403);
    }
    expect(h.updates).toEqual([]);
  });

  it("another organization's row reads exactly like an id that does not exist, and nothing is written", async () => {
    const other = await call(id(9));
    const madeUp = await call(id(99));
    expect(other.status).toBe(404);
    expect(madeUp.status).toBe(404);
    expect(await other.json()).toEqual(await madeUp.json());
    expect(h.updates).toEqual([]);
  });

  it("a person who is in both organizations may dismiss either one's card", async () => {
    h.memberOf = [ME_ORG, OTHER_ORG];
    expect((await call(id(9))).status).toBe(200);
  });

  it("a malformed id is a 400 and reads nothing", async () => {
    for (const bad of ["x", "../etc", "1; drop table", "0c000000-0000-4000-8000-0000000000zz"]) {
      expect((await call(bad)).status).toBe(400);
    }
    expect(h.tableCalls).toEqual([]);
  });
});

describe("which tickets may go", () => {
  it("rejected and expired tickets are dismissed", async () => {
    for (const n of [1, 2]) {
      const res = await call(id(n));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(h.updates).toHaveLength(2);
  });

  it("an upload still on its way is never dismissable", async () => {
    for (const n of [3, 4, 5, 6]) {
      const res = await call(id(n));
      expect(res.status, `ticket ${n}`).toBe(409);
      expect((await res.json()).error).toBe("not_dismissable");
    }
    expect(h.updates).toEqual([]);
  });

  it("a ticket that became a file is not dismissable either", async () => {
    expect((await call(id(7))).status).toBe(409);
    expect(h.updates).toEqual([]);
  });
});

describe("what is written", () => {
  it("only the caller's own metadata, through their session, and the ledger is never touched", async () => {
    await call(id(1));
    expect(h.updates).toEqual([{ data: { [DISMISS_META_KEY]: [id(1)] } }]);
    expect(h.tableCalls).toHaveLength(1);
    expect(h.tableCalls[0]).toEqual({ table: "media_uploads", chain: ["select", "eq", "maybeSingle"] });
  });

  it("writes no audit row: an audit action needs a database migration, and a personal hide changes nothing shared", async () => {
    expect((await call(id(1))).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("newest first, no repeats: pressing twice is the same as once", async () => {
    h.user = { id: "u1", user_metadata: { [DISMISS_META_KEY]: [id(2), id(1)], keep: "me" } };
    await call(id(1));
    expect(h.updates[0].data?.[DISMISS_META_KEY]).toEqual([id(1), id(2)]);
    // Only the one key is sent, so the rest of the person's metadata is not touched.
    expect(Object.keys(h.updates[0].data ?? {})).toEqual([DISMISS_META_KEY]);
  });

  it("the list stays short", async () => {
    const many = Array.from({ length: DISMISS_MAX + 10 }, (_, i) => id(1000 + i));
    h.user = { id: "u1", user_metadata: { [DISMISS_META_KEY]: many } };
    await call(id(1));
    const written = h.updates[0].data?.[DISMISS_META_KEY] as string[];
    expect(written).toHaveLength(DISMISS_MAX);
    expect(written[0]).toBe(id(1));
  });

  it("junk already in the metadata is dropped, not echoed back", async () => {
    h.user = { id: "u1", user_metadata: { [DISMISS_META_KEY]: ["nope", 5, null, id(2), { a: 1 }] } };
    await call(id(1));
    expect(h.updates[0].data?.[DISMISS_META_KEY]).toEqual([id(1), id(2)]);
  });
});

describe("failures say a fixed word", () => {
  it("a failed read is the mapped word, not database text", async () => {
    h.readError = { code: "42P01", message: 'relation "media_uploads" does not exist' };
    const res = await call(id(1));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("relation");
  });

  it("a failed or thrown write is a plain failure and the card stays", async () => {
    h.updateError = { message: "jwt secret something" };
    let res = await call(id(1));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toBe('{"error":"failed"}');
    h.updateError = null;
    h.updateThrows = true;
    res = await call(id(1));
    expect(res.status).toBe(502);
  });
});
