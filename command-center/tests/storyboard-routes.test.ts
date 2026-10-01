import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/storyboards/<id>/approve and /discard (migration 0057), and the
 * price the storyboard screen shows (quoteStoryboard).
 *
 * What would break without these: an approval that spends without the price
 * the person saw, or at a price the browser chose; a second press reaching the
 * database; a person who may not start runs reaching it at all; a refusal
 * turned into a 500 or into "approved"; an Actions dispatch that failed
 * leaving the person's credits held for a render that never left; a price
 * built from anything but the storyboard's own length; a route reaching for
 * the service key.
 */

vi.mock("server-only", () => ({}));

const ID = "0b8f7a52-3f9c-4d1e-9b7a-1c2d3e4f5a6b";
const ORG = "0a000000-0000-4000-8000-00000000000a";

type Err = { code?: string; message?: string; details?: string };
const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  access: { ok: true, role: "admin", orgId: "0a000000-0000-4000-8000-00000000000a", source: "org" } as Record<string, unknown>,
  storyboard: null as Record<string, unknown> | null,
  read: null as Record<string, unknown> | null,
  quote: { kind: "paid", credits: 54 } as Record<string, unknown>,
  rpc: {} as Record<string, { data: unknown; error: Err | null }>,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  quoted: [] as unknown[],
  dispatch: vi.fn(async (_channel: string, _opts: Record<string, unknown>) => undefined),
  backend: "queue",
  github: true,
  audits: [] as unknown[],
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args });
      return h.rpc[name] ?? { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/auth/org-roles", () => ({
  requireOrgRole: async () => h.access,
  isOperator: async () => false,
}));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: unknown) => void h.audits.push(e) }));
vi.mock("@/lib/server/github-secrets", () => ({
  get isGithubConfigured() {
    return h.github;
  },
  dispatchDailyVideo: (c: string, o: Record<string, unknown>) => h.dispatch(c, o),
}));
vi.mock("@/lib/server/storyboards", () => ({
  readStoryboard: async () => h.read ?? { ok: true, storyboard: h.storyboard },
  quoteStoryboard: async (_s: unknown, sb: unknown) => {
    h.quoted.push(sb);
    return h.quote;
  },
}));

const approve = (await import("@/app/api/storyboards/[id]/approve/route")).POST;
const discard = (await import("@/app/api/storyboards/[id]/discard/route")).POST;
const edit = (await import("@/app/api/storyboards/[id]/edit/route")).POST;
const reopen = (await import("@/app/api/storyboards/[id]/reopen/route")).POST;

function req(body: unknown = {}) {
  return new Request(`http://x/api/storyboards/${ID}/approve`, { method: "POST", body: JSON.stringify(body) });
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.access = { ok: true, role: "admin", orgId: ORG, source: "org" };
  h.storyboard = {
    id: ID, channelId: "chan-a", slug: "the-lighthouse", topic: "The Lighthouse", title: null,
    scenes: [{ n: 1, name: "", type: "", narration: "x", visual: "", durationS: 300 }],
    durationS: 300, status: "ready", createdAt: null, decidedAt: null, creditsHeld: null, renderJobId: null,
  };
  h.read = null;
  h.quote = { kind: "paid", credits: 54 };
  h.rpc = { approve_storyboard: { data: { credit_ref: "rj-sb1-x", credits_held: 54, render_job_id: 9 }, error: null } };
  h.rpcCalls = [];
  h.quoted = [];
  h.dispatch.mockReset();
  h.dispatch.mockResolvedValue(undefined);
  h.github = true;
  h.audits = [];
  vi.stubEnv("NIGHTSHIFT_RUN_BACKEND", "queue");
});

describe("approve", () => {
  it("spends only at the price the person confirmed, computed on the server", async () => {
    const res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toEqual([
      { name: "approve_storyboard", args: { p_storyboard: ID, p_amount: 54, p_backend: "queue" } },
    ]);
    expect(await res.json()).toMatchObject({ ok: true, credits_reserved: 54, job_id: 9 });
  });

  it("a press without the price it showed spends nothing", async () => {
    const res = await approve(req({}), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "price_required", credits: 54 });
    expect(h.rpcCalls).toEqual([]);
  });

  it("a higher price now is asked again, never held", async () => {
    h.quote = { kind: "paid", credits: 70 };
    const res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "price_changed", credits: 70 });
    expect(h.rpcCalls).toEqual([]);
  });

  it("the browser cannot set the amount: a lower max is just a refusal, a higher one pays the quote", async () => {
    await approve(req({ max_credits: 1_000_000 }), ctx());
    expect(h.rpcCalls[0].args.p_amount).toBe(54);
  });

  it("someone who may not start runs here never reaches the database", async () => {
    h.access = { ok: false, status: 403, error: "forbidden" };
    const res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(403);
    expect(h.rpcCalls).toEqual([]);
  });

  it("a decided storyboard is 409 before anything is asked of the database", async () => {
    h.storyboard = { ...h.storyboard, status: "approved" };
    const res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(409);
    expect(h.rpcCalls).toEqual([]);
  });

  it("no honest price, or credits not enforced for a customer, is a refusal that holds nothing", async () => {
    h.quote = { kind: "unavailable", reason: "no_prices" };
    expect((await approve(req({ max_credits: 54 }), ctx())).status).toBe(409);
    h.quote = { kind: "unavailable", reason: "not_enforced" };
    const res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "credits_not_enforced" });
    expect(h.rpcCalls).toEqual([]);
  });

  it("the operator's own channel is approved with no amount", async () => {
    h.quote = { kind: "included" };
    h.rpc.approve_storyboard = { data: { credit_ref: null, credits_held: null, render_job_id: 3 }, error: null };
    const res = await approve(req({}), ctx());
    expect(res.status).toBe(200);
    expect(h.rpcCalls[0].args.p_amount).toBeNull();
  });

  it("the database's refusals become answers, never a 500 or a success", async () => {
    h.rpc.approve_storyboard = { data: null, error: { code: "NS402", message: "insufficient credits", details: "available=10 needed=54" } };
    let res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "insufficient_credits", needed: 54, available: 10 });
    h.rpc.approve_storyboard = { data: null, error: { code: "NS409", message: "storyboard_not_ready" } };
    res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(409);
    h.rpc.approve_storyboard = { data: null, error: { code: "XX000", message: "internal detail" } };
    res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("internal detail");
  });

  it("on Actions it dispatches a resume of exactly this run at the priced length", async () => {
    vi.stubEnv("NIGHTSHIFT_RUN_BACKEND", "actions");
    h.rpc.approve_storyboard = { data: { credit_ref: "gh-sb1-x", credits_held: 54, render_job_id: null }, error: null };
    const res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(200);
    expect(h.rpcCalls[0].args.p_backend).toBe("actions");
    expect(h.dispatch).toHaveBeenCalledWith("chan-a", {
      topic: "The Lighthouse", duration: 300, resume: true, creditRef: "gh-sb1-x",
    });
  });

  it("a dispatch that fails puts the hold back and the storyboard waits again", async () => {
    vi.stubEnv("NIGHTSHIFT_RUN_BACKEND", "actions");
    h.rpc.approve_storyboard = { data: { credit_ref: "gh-sb1-x", credits_held: 54, render_job_id: null }, error: null };
    h.dispatch.mockRejectedValue(new Error("github_dispatch_failed"));
    const res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "dispatch_failed", released: true });
    expect(h.rpcCalls.map((c) => c.name)).toEqual(["approve_storyboard", "storyboard_dispatch_failed"]);
  });

  it("refuses bad input before reading anything", async () => {
    expect((await approve(req({ max_credits: -1 }), ctx())).status).toBe(400);
    expect((await approve(req([1]), ctx())).status).toBe(400);
    expect((await approve(req({ max_credits: 54 }), ctx("../etc"))).status).toBe(404);
    h.user = null;
    expect((await approve(req({ max_credits: 54 }), ctx())).status).toBe(401);
    expect(h.rpcCalls).toEqual([]);
  });

  it("another organization's storyboard reads as not found", async () => {
    h.read = { ok: false, status: 404, error: "not_found" };
    const res = await approve(req({ max_credits: 54 }), ctx());
    expect(res.status).toBe(404);
    expect(h.rpcCalls).toEqual([]);
  });
});

describe("discard", () => {
  it("discards through the database, which checks the right again", async () => {
    const res = await discard(new Request("http://x", { method: "POST" }), ctx());
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toEqual([{ name: "discard_storyboard", args: { p_storyboard: ID } }]);
  });

  it("someone who may not start runs cannot discard", async () => {
    h.access = { ok: false, status: 403, error: "forbidden" };
    expect((await discard(new Request("http://x", { method: "POST" }), ctx())).status).toBe(403);
    expect(h.rpcCalls).toEqual([]);
  });
});

// ── migration 0058: editing, the revision an approval names, re-opening ──

const EDITED = [
  { n: 1, name: "Scene 2", type: "story", narration: "Two.", visual: "dawn", duration_s: 100 },
  { n: 2, name: "Added scene", type: "story", narration: "A new one.", visual: "", duration_s: 2 },
];

function editReq(body: unknown) {
  return new Request(`http://x/api/storyboards/${ID}/edit`, { method: "POST", body: JSON.stringify(body) });
}

describe("approve, once storyboards can be edited", () => {
  beforeEach(() => {
    h.storyboard = { ...h.storyboard, revision: 4 };
    h.rpc.approve_storyboard_at = { data: { credit_ref: "rj-sb1-x", credits_held: 54, render_job_id: 9 }, error: null };
  });

  it("approves exactly the revision the price was shown for", async () => {
    const res = await approve(req({ max_credits: 54, revision: 4 }), ctx());
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toEqual([
      { name: "approve_storyboard_at", args: { p_storyboard: ID, p_revision: 4, p_amount: 54, p_backend: "queue" } },
    ]);
  });

  it("a press for an older revision, or none, holds nothing", async () => {
    for (const body of [{ max_credits: 54, revision: 3 }, { max_credits: 54 }]) {
      const res = await approve(req(body), ctx());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "stale_revision", revision: 4 });
    }
    expect((await approve(req({ max_credits: 54, revision: "4" }), ctx())).status).toBe(400);
    expect(h.rpcCalls).toEqual([]);
  });

  it("an edit that lands between the read and the press is the database's refusal", async () => {
    h.rpc.approve_storyboard_at = { data: null, error: { code: "NS412", message: "stale_revision", details: "revision=5" } };
    const res = await approve(req({ max_credits: 54, revision: 4 }), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_revision", revision: 5 });
  });
});

describe("edit", () => {
  beforeEach(() => {
    h.storyboard = { ...h.storyboard, revision: 0 };
    h.quote = { kind: "paid", credits: 21 };
    h.rpc.save_storyboard_edits = {
      data: { id: ID, status: "ready", revision: 1, duration_s: 102, scenes: EDITED, changed: true },
      error: null,
    };
  });

  const body = {
    revision: 0,
    scenes: [
      { src: 2, narration: "Two.", visual: "dawn" },
      { src: null, narration: "A new one.", visual: "" },
    ],
  };

  it("saves through the database and re-quotes from the length it stored", async () => {
    const res = await edit(editReq(body), ctx());
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toEqual([
      { name: "save_storyboard_edits", args: { p_storyboard: ID, p_revision: 0, p_scenes: body.scenes } },
    ]);
    // The price is for the database's length, never one the browser sent.
    expect(h.quoted).toEqual([{ channelId: "chan-a", durationS: 102 }]);
    const out = await res.json();
    expect(out).toMatchObject({ ok: true, revision: 1, durationS: 102, quote: { kind: "paid", credits: 21 } });
    expect(out.scenes.map((s: { narration: string }) => s.narration)).toEqual(["Two.", "A new one."]);
    expect(h.audits).toHaveLength(1);
    expect(JSON.stringify(h.audits[0])).not.toContain("A new one.");
  });

  it("a length, an id or any other field never reaches the database", async () => {
    for (const scenes of [
      [{ src: 1, narration: "x", visual: "", duration_s: 1 }],
      [{ src: 1, narration: "x", asset_id: "00000000-0000-4000-8000-000000000001" }],
      [{ src: "1", narration: "x" }],
      [{ src: 1.5, narration: "x" }],
      [{ src: 1, narration: 5 }],
      [],
      "not a list",
    ]) {
      const res = await edit(editReq({ revision: 0, scenes }), ctx());
      expect(res.status, JSON.stringify(scenes)).toBe(400);
    }
    expect((await edit(editReq({ revision: -1, scenes: body.scenes }), ctx())).status).toBe(400);
    expect((await edit(new Request("http://x", { method: "POST", body: "x".repeat(300_001) }), ctx())).status).toBe(413);
    expect(h.rpcCalls).toEqual([]);
  });

  it("someone who may not start runs, or a decided storyboard, never reaches the database", async () => {
    h.access = { ok: false, status: 403, error: "forbidden" };
    expect((await edit(editReq(body), ctx())).status).toBe(403);
    h.access = { ok: true, role: "admin", orgId: ORG, source: "org" };
    h.storyboard = { ...h.storyboard, status: "approved" };
    expect((await edit(editReq(body), ctx())).status).toBe(409);
    h.user = null;
    expect((await edit(editReq(body), ctx())).status).toBe(401);
    expect(h.rpcCalls).toEqual([]);
  });

  it("a stale revision is refused, never overwritten", async () => {
    h.storyboard = { ...h.storyboard, revision: 2 };
    const res = await edit(editReq(body), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_revision", revision: 2 });
    expect(h.rpcCalls).toEqual([]);
    h.storyboard = { ...h.storyboard, revision: 0 };
    h.rpc.save_storyboard_edits = { data: null, error: { code: "NS412", message: "stale_revision", details: "revision=1" } };
    const raced = await edit(editReq(body), ctx());
    expect(raced.status).toBe(409);
    expect(await raced.json()).toEqual({ error: "stale_revision", revision: 1 });
    expect(h.audits).toEqual([]);
  });

  it("without migration 0058 nothing is editable", async () => {
    h.storyboard = { ...h.storyboard, revision: null };
    const res = await edit(editReq(body), ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "editing_unavailable" });
    expect(h.rpcCalls).toEqual([]);
  });

  it("the database's bounds become answers", async () => {
    h.rpc.save_storyboard_edits = { data: null, error: { code: "22023", message: "storyboard_too_long", details: "seconds=4000" } };
    let res = await edit(editReq(body), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "storyboard_too_long" });
    h.rpc.save_storyboard_edits = { data: null, error: { code: "22023", message: "scenes_invalid", details: "scene=1 cue_markup" } };
    res = await edit(editReq(body), ctx());
    expect(await res.json()).toEqual({ error: "scenes_invalid" });
  });
});

describe("reopen", () => {
  const post = () => reopen(new Request("http://x", { method: "POST" }), ctx());

  it("re-opens a failed render's storyboard through the database", async () => {
    h.storyboard = { ...h.storyboard, status: "approved", revision: 1 };
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toEqual([{ name: "reopen_storyboard", args: { p_storyboard: ID } }]);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("a render that may still be running is a refusal", async () => {
    h.storyboard = { ...h.storyboard, status: "approved", revision: 1 };
    h.rpc.reopen_storyboard = { data: null, error: { code: "NS423", message: "hold_not_released" } };
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "hold_not_released" });
    expect(h.audits).toEqual([]);
  });

  it("only an approved storyboard, and only for someone who may start runs", async () => {
    expect((await post()).status).toBe(409);
    h.storyboard = { ...h.storyboard, status: "approved" };
    h.access = { ok: false, status: 403, error: "forbidden" };
    expect((await post()).status).toBe(403);
    expect(h.rpcCalls).toEqual([]);
  });
});

describe("the routes hold no service key", () => {
  it("never names it", () => {
    for (const f of [
      "app/api/storyboards/[id]/approve/route.ts",
      "app/api/storyboards/[id]/discard/route.ts",
      "app/api/storyboards/[id]/edit/route.ts",
      "app/api/storyboards/[id]/reopen/route.ts",
      "lib/server/storyboards.ts",
      "lib/storyboardReview.ts",
      "components/storyboard/StoryboardReview.tsx",
    ]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/SERVICE_KEY|service_role|SERVICE_ROLE/);
    }
  });
});
