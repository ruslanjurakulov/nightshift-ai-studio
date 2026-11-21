/**
 * /api/region-edit/*: dark by default, signed in, same-origin, and never a guess.
 * What would break without these: the routes answering while the switch is off, a quote for a picture of another
 * organization, a rectangle checked against the browser's idea of the picture's size, a price shown when the
 * database could not price it, a run that holds credits for a picture/model/region it should have refused first, a run
 * without the confirmed price or without its key (a retry could pay twice), and a run that is not exactly the quote.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "11111111-1111-4111-8111-111111111111";
const SRC = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  session: { ok: true as boolean },
  rpc: vi.fn(),
  media: { data: null as unknown, error: null as unknown },
  models: [] as unknown[],
  user: { id: "u" } as { id: string } | null,
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/server/creative", () => ({
  creativeSession: async () =>
    h.session.ok
      ? { ok: true, defaultOrg: ORG, db: { rpc: h.rpc, readJob: async () => ({ data: null, error: null }), listJobs: async () => ({ data: [], error: null }) } }
      : { ok: false, result: { status: 401, body: { error: "unauthorized" } } },
  loadStudioModels: async () => h.models,
}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => h.media, limit: () => ({ then: undefined }) }) }) }),
  }),
}));
vi.mock("@/lib/server/same-origin", () => ({ requireSameOrigin: (fn: unknown) => fn }));
vi.mock("@/lib/server/audit", () => ({ logAudit: h.audit }));

const post = (body: unknown) => new Request("http://x/api/region-edit/quote", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const goodBody = { org_id: ORG, source_asset_id: SRC, model: "gemini-3.1-flash-image", regions: [{ name: "A", prompt: "dusk", x: 10, y: 10, w: 100, h: 80 }] };
const gemini = { id: "gemini-3.1-flash-image", displayName: "Gemini", capabilities: ["edit"], beta: false };

beforeEach(() => {
  delete process.env.NIGHTSHIFT_REGION_EDITOR;
  h.session.ok = true;
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: { credits: 3 }, error: null });
  h.media = { data: { org_id: ORG, kind: "image", width: 800, height: 600 }, error: null };
  h.models = [gemini];
  h.user = { id: "u" };
});

describe("POST /api/region-edit/quote", () => {
  it("is a 404 while the switch is off, and asks nobody anything", async () => {
    const { POST } = await import("@/app/api/region-edit/quote/route");
    const res = await POST(post(goodBody));
    expect(res.status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("answers the database's ONE price for all the regions once the switch is on", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    h.rpc.mockResolvedValue({ data: { credits: 6 }, error: null });
    const { POST } = await import("@/app/api/region-edit/quote/route");
    const res = await POST(post({ ...goodBody, regions: [goodBody.regions[0], { ...goodBody.regions[0], name: "B", x: 200 }] }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { quote: { total: number; count: number } };
    expect(out.quote).toMatchObject({ total: 6, count: 2 });
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("refuses a rectangle outside the size the LIBRARY recorded, and a picture of another organization", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    const { POST } = await import("@/app/api/region-edit/quote/route");
    const wide = { ...goodBody, regions: [{ ...goodBody.regions[0], x: 750 }] };
    expect((await POST(post(wide))).status).toBe(422);
    h.media = { data: { org_id: "99999999-9999-4999-8999-999999999999", kind: "image", width: 800, height: 600 }, error: null };
    const other = await POST(post(goodBody));
    expect(other.status).toBe(422);
    expect(await other.json()).toEqual({ error: "source_unavailable" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("refuses a picture the library has no size for, and a source that is not an image", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    const { POST } = await import("@/app/api/region-edit/quote/route");
    h.media = { data: { org_id: ORG, kind: "image", width: null, height: null }, error: null };
    expect((await POST(post(goodBody))).status).toBe(422);
    h.media = { data: { org_id: ORG, kind: "video", width: 800, height: 600 }, error: null };
    expect((await POST(post(goodBody))).status).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("refuses an unknown model and a missing one without asking the database for a price", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    const { POST } = await import("@/app/api/region-edit/quote/route");
    const unknown = await POST(post({ ...goodBody, model: "mystery-model" }));
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toEqual({ error: "model_not_sellable" });
    const none = await POST(post({ ...goodBody, model: undefined }));
    expect(await none.json()).toEqual({ error: "model_required" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("requires a signed-in member", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    h.session.ok = false;
    const { POST } = await import("@/app/api/region-edit/quote/route");
    expect((await POST(post(goodBody))).status).toBe(401);
  });

  it("passes a database refusal through with its region, never a total", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    h.rpc.mockResolvedValue({ data: null, error: { code: "NS402", message: "insufficient", details: "available=1 needed=3" } });
    const { POST } = await import("@/app/api/region-edit/quote/route");
    const res = await POST(post(goodBody));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "insufficient_credits" });
  });
});

describe("GET /api/region-edit/versions", () => {
  it("is a 404 while the switch is off and 401 without a session", async () => {
    const { GET } = await import("@/app/api/region-edit/versions/route");
    expect((await GET(new Request(`http://x/api/region-edit/versions?asset=${SRC}`))).status).toBe(404);
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    h.user = null;
    expect((await GET(new Request(`http://x/api/region-edit/versions?asset=${SRC}`))).status).toBe(401);
  });

  it("refuses an asset that is not an id", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    const { GET } = await import("@/app/api/region-edit/versions/route");
    expect((await GET(new Request("http://x/api/region-edit/versions?asset=../x"))).status).toBe(400);
  });
});

const run = (body: unknown) => new Request("http://x/api/region-edit/run", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const runBody = { ...goodBody, max_credits: 3, idempotency_key: "re-key-1" };
const JOB_ID = "55555555-5555-4555-8555-555555555555";

describe("POST /api/region-edit/run", () => {
  beforeEach(() => {
    h.audit.mockClear();
    h.rpc.mockResolvedValue({ data: { job: { id: JOB_ID, quoted_credits: 3, status: "queued" }, replay: false }, error: null });
  });

  it("is a 404 while the switch is off, and asks the database for nothing", async () => {
    const { POST } = await import("@/app/api/region-edit/run/route");
    const res = await POST(run(runBody));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("asks create_creative_job once, for exactly the params of the quote, with the confirmed price and the key", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    const { POST } = await import("@/app/api/region-edit/run/route");
    const res = await POST(run(runBody));
    expect(res.status).toBe(201);
    expect((await res.json()) as { job: { id: string } }).toMatchObject({ job: { id: JOB_ID }, replay: false });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = h.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("create_creative_job");
    expect(args).toMatchObject({ p_org: ORG, p_capability: "edit", p_model: "gemini-3.1-flash-image", p_mode: "exact", p_idempotency_key: "re-key-1", p_max_credits: 3 });
    expect(args.p_params).toEqual({
      source_asset_id: SRC,
      regions: [{ id: "r1", name: "A", prompt: "dusk", rect: { x: 10, y: 10, w: 100, h: 80 } }],
      region_feather: 4,
    });
    expect(args.p_params).not.toHaveProperty("prompt");
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect((h.audit.mock.calls[0] as unknown[])[0]).toMatchObject({ action: "creative.generate", target: JOB_ID, detail: { region_edit: true, regions: 1 } });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("dusk");
  });

  it("answers a replayed key with the first job and audits nothing new", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    h.rpc.mockResolvedValue({ data: { job: { id: JOB_ID, quoted_credits: 3 }, replay: true }, error: null });
    const { POST } = await import("@/app/api/region-edit/run/route");
    const res = await POST(run(runBody));
    expect(res.status).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([
    ["no confirmed price", { ...runBody, max_credits: undefined }, 400, "confirm_price"],
    ["a negative price", { ...runBody, max_credits: -1 }, 400, "confirm_price"],
    ["a price that is not a number", { ...runBody, max_credits: "3" }, 400, "confirm_price"],
    ["no key (a retry could pay twice)", { ...runBody, idempotency_key: undefined }, 400, "invalid_idempotency_key"],
    ["a key with odd characters", { ...runBody, idempotency_key: "a b" }, 400, "invalid_idempotency_key"],
    ["no regions", { ...runBody, regions: [] }, 422, "no_regions"],
    ["six regions", { ...runBody, regions: Array.from({ length: 6 }, () => goodBody.regions[0]) }, 422, "too_many_regions"],
    ["no model", { ...runBody, model: "" }, 422, "model_required"],
    ["an unknown model", { ...runBody, model: "mystery-model" }, 422, "model_not_sellable"],
    ["a feather out of range", { ...runBody, feather: 99 }, 422, "feather_invalid"],
    ["no words in any region", { ...runBody, regions: [{ ...goodBody.regions[0], prompt: " " }] }, 422, "no_prompt"],
    ["a field nobody asked for", { ...runBody, prompt: "x" }, 400, "invalid_body"],
  ])("refuses %s before anything is held", async (_name, body, status, error) => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    const { POST } = await import("@/app/api/region-edit/run/route");
    const res = await POST(run(body));
    expect(res.status).toBe(status);
    expect((await res.json()) as { error: string }).toMatchObject({ error });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("refuses a rectangle outside the size the LIBRARY recorded, and another organization's picture, before holding anything", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    const { POST } = await import("@/app/api/region-edit/run/route");
    expect((await POST(run({ ...runBody, regions: [{ ...goodBody.regions[0], x: 750 }] }))).status).toBe(422);
    h.media = { data: { org_id: "99999999-9999-4999-8999-999999999999", kind: "image", width: 800, height: 600 }, error: null };
    const other = await POST(run(runBody));
    expect(other.status).toBe(422);
    expect(await other.json()).toEqual({ error: "source_unavailable" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("passes the database's refusals through and audits nothing", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    const { POST } = await import("@/app/api/region-edit/run/route");
    h.rpc.mockResolvedValue({ data: null, error: { code: "NS402", message: "insufficient", details: "available=1 needed=3" } });
    const poor = await POST(run(runBody));
    expect(poor.status).toBe(402);
    expect(await poor.json()).toMatchObject({ error: "insufficient_credits", available: 1, needed: 3 });
    h.rpc.mockResolvedValue({ data: null, error: { code: "NS409", message: "price_changed", details: "price=4 confirmed=3" } });
    const moved = await POST(run(runBody));
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ error: "price_changed" });
    h.rpc.mockResolvedValue({ data: null, error: { code: "NS400", message: "invalid_params", details: "region 1: words are required" } });
    expect((await POST(run(runBody))).status).toBe(400);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refuses a picture over 16 megapixels and words over the params cap, before holding anything", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    const { POST } = await import("@/app/api/region-edit/run/route");
    h.media = { data: { org_id: ORG, kind: "image", width: 4001, height: 4000 }, error: null };
    const big = await POST(run(runBody));
    expect(big.status).toBe(422);
    expect(await big.json()).toEqual({ error: "source_too_large" });
    h.media = { data: { org_id: ORG, kind: "image", width: 4000, height: 4000 }, error: null };
    expect((await POST(run(runBody))).status).toBe(201);
    h.rpc.mockClear();
    const words = "日".repeat(1000);
    const heavy = Array.from({ length: 5 }, (_v, i) => ({ name: "日".repeat(60), prompt: words, x: 10 + i * 20, y: 10, w: 100, h: 80 }));
    const long = await POST(run({ ...runBody, regions: heavy }));
    expect(long.status).toBe(422);
    expect(await long.json()).toEqual({ error: "params_too_large" });
    expect(h.rpc).not.toHaveBeenCalled();
    const quoteRoute = await import("@/app/api/region-edit/quote/route");
    const q = await quoteRoute.POST(post({ ...goodBody, regions: heavy }));
    expect(q.status).toBe(422);
    expect(await q.json()).toEqual({ error: "params_too_large" });
    h.media = { data: { org_id: ORG, kind: "image", width: 4001, height: 4000 }, error: null };
    expect((await quoteRoute.POST(post(goodBody))).status).toBe(422);
  });

  it("requires a signed-in member", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    h.session.ok = false;
    const { POST } = await import("@/app/api/region-edit/run/route");
    expect((await POST(run(runBody))).status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("the generic creative route still refuses the region keys", () => {
  it("regions and region_feather are not parameters of /api/creative", async () => {
    const { PARAM_KEYS, parseGenerationInput } = await import("@/lib/creative/operations");
    expect(PARAM_KEYS).not.toContain("regions");
    expect(PARAM_KEYS).not.toContain("region_feather");
    const out = parseGenerationInput(
      { org_id: ORG, capability: "edit", model: "gemini-3.1-flash-image", params: { source_asset_id: SRC, regions: [], region_feather: 4 }, max_credits: 3 },
      null,
      { requirePrice: true },
    );
    expect(out.ok).toBe(false);
  });
});
