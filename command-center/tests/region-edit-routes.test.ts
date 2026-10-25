/**
 * /api/region-edit/*: dark by default, signed in, same-origin, and never a guess.
 * What would break without these: the routes answering while the switch is off, a quote for a picture of another
 * organization, a rectangle checked against the browser's idea of the picture's size, a price shown when the
 * database could not price it.
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

  it("answers the sum of the database's per-region prices once the switch is on", async () => {
    process.env.NIGHTSHIFT_REGION_EDITOR = "on";
    const { POST } = await import("@/app/api/region-edit/quote/route");
    const res = await POST(post({ ...goodBody, regions: [goodBody.regions[0], { ...goodBody.regions[0], name: "B", x: 200 }] }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { quote: { total: number; lines: unknown[] } };
    expect(out.quote.total).toBe(6);
    expect(out.quote.lines).toHaveLength(2);
    expect(h.rpc).toHaveBeenCalledTimes(2);
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
    expect(await res.json()).toMatchObject({ error: "insufficient_credits", region: 0 });
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
