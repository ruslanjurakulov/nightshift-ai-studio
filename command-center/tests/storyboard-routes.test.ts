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
  quoteStoryboard: async () => h.quote,
}));

const approve = (await import("@/app/api/storyboards/[id]/approve/route")).POST;
const discard = (await import("@/app/api/storyboards/[id]/discard/route")).POST;

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

describe("the routes hold no service key", () => {
  it("never names it", () => {
    for (const f of [
      "app/api/storyboards/[id]/approve/route.ts",
      "app/api/storyboards/[id]/discard/route.ts",
      "lib/server/storyboards.ts",
      "lib/storyboardReview.ts",
      "components/storyboard/StoryboardReview.tsx",
    ]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/SERVICE_KEY|service_role|SERVICE_ROLE/);
    }
  });
});
