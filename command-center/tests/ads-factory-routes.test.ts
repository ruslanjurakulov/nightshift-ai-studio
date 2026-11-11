import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/ads/* (migration 0131, NIGHTSHIFT_ADS_FACTORY).
 *
 * What would break without these: a route answering while the switch is off (or telling a signed-out visitor it exists), a
 * malformed body reaching the database, a refusal from the database turning into a 500 or a fake success, a cap shown with a number
 * the database never gave, "add drafts" trusting text from the browser or sending different words on a retry, the route reaching
 * for the service key (which would skip every check 0131 has), and any of these routes fetching a site or calling a model.
 *
 * The database is faked at the edges the routes touch: the session, the org context, rpc() and the table builder. Every call is recorded.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string; details?: string };
type Result = { data: unknown; error: Err | null };
const ORG = "0a000000-0000-4000-8000-00000000000a";
const KIT = "0b000000-0000-4000-8000-00000000000b";
const CAMPAIGN = "0c000000-0000-4000-8000-00000000000c";
const CONCEPT = "0d000000-0000-4000-8000-00000000000d";
const P = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  current: { id: "0a000000-0000-4000-8000-00000000000a" } as { id: string } | null,
  rpc: { data: null, error: null } as { data: unknown; error: { code?: string; message?: string; details?: string } | null },
  tables: {} as Record<string, { data: unknown; error: { code?: string; message?: string } | null }>,
  calls: [] as { kind: string; name: string; args?: unknown; chain: { m: string; a: unknown[] }[] }[],
  audits: [] as { action: string; target?: string }[],
  getUser: 0,
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

type Call = (typeof h.calls)[number];
const client = {
  rpc: (name: string, args: unknown) => {
    const rec: Call = { kind: "rpc", name, args, chain: [] };
    h.calls.push(rec);
    return builder(rec, () => h.rpc);
  },
  from: (name: string) => {
    const rec: Call = { kind: "from", name, chain: [] };
    h.calls.push(rec);
    return builder(rec, () => h.tables[name] ?? { data: [], error: null });
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => client,
  getUser: async () => {
    h.getUser++;
    return h.user;
  },
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, orgs: [], current: h.current }) }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: { action: string; target?: string }) => void h.audits.push(e) }));

const root = await import("../app/api/ads/route");
const kits = await import("../app/api/ads/kits/route");
const kit = await import("../app/api/ads/kits/[id]/route");
const kitProducts = await import("../app/api/ads/kits/[id]/products/route");
const product = await import("../app/api/ads/products/[id]/route");
const campaigns = await import("../app/api/ads/campaigns/route");
const campaign = await import("../app/api/ads/campaigns/[id]/route");
const campaignConcepts = await import("../app/api/ads/campaigns/[id]/concepts/route");
const concept = await import("../app/api/ads/concepts/[id]/route");

function req(url: string, method: string, body?: unknown, headers: Record<string, string> = { Origin: "http://x" }) {
  return new Request(`http://x${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined || method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const rpcs = () => h.calls.filter((c) => c.kind === "rpc");
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

const KIT_BODY = { name: "Acme", site_url: "https://example.com", palette: ["#AABBCC"], fonts: ["Inter"], voice: "Calm." };
const PRODUCT_BODY = { title: "Tea", description: "Green.", price: "$12", image_ids: [P(1)] };
const CAMPAIGN_BODY = { kit_id: KIT, name: "Launch", objective: "launch", language: "en", formats: ["1:1", "9:16"], directions: ["bold"], product_ids: [P(1), P(2)] };

/** Every handler, with a request that would otherwise succeed. */
const EVERY: [string, () => Promise<Response>][] = [
  ["GET /api/ads", () => root.GET(req("/api/ads", "GET"))],
  ["POST /api/ads/kits", () => kits.POST(req("/api/ads/kits", "POST", KIT_BODY))],
  ["PATCH /api/ads/kits/:id", () => kit.PATCH(req(`/api/ads/kits/${KIT}`, "PATCH", KIT_BODY), ctx(KIT))],
  ["DELETE /api/ads/kits/:id", () => kit.DELETE(req(`/api/ads/kits/${KIT}`, "DELETE"), ctx(KIT))],
  ["POST /api/ads/kits/:id/products", () => kitProducts.POST(req(`/api/ads/kits/${KIT}/products`, "POST", PRODUCT_BODY), ctx(KIT))],
  ["PATCH /api/ads/products/:id", () => product.PATCH(req(`/api/ads/products/${P(1)}`, "PATCH", PRODUCT_BODY), ctx(P(1)))],
  ["DELETE /api/ads/products/:id", () => product.DELETE(req(`/api/ads/products/${P(1)}`, "DELETE"), ctx(P(1)))],
  ["POST /api/ads/campaigns", () => campaigns.POST(req("/api/ads/campaigns", "POST", CAMPAIGN_BODY))],
  ["PATCH /api/ads/campaigns/:id", () => campaign.PATCH(req(`/api/ads/campaigns/${CAMPAIGN}`, "PATCH", CAMPAIGN_BODY), ctx(CAMPAIGN))],
  ["DELETE /api/ads/campaigns/:id", () => campaign.DELETE(req(`/api/ads/campaigns/${CAMPAIGN}`, "DELETE"), ctx(CAMPAIGN))],
  ["POST /api/ads/campaigns/:id/concepts", () => campaignConcepts.POST(req(`/api/ads/campaigns/${CAMPAIGN}/concepts`, "POST", { kind: "image", count: 2, batch: "ads-00000001" }), ctx(CAMPAIGN))],
  ["PATCH /api/ads/concepts/:id", () => concept.PATCH(req(`/api/ads/concepts/${CONCEPT}`, "PATCH", { status: "approved" }), ctx(CONCEPT))],
  ["DELETE /api/ads/concepts/:id", () => concept.DELETE(req(`/api/ads/concepts/${CONCEPT}`, "DELETE"), ctx(CONCEPT))],
];

beforeEach(() => {
  process.env.NIGHTSHIFT_ADS_FACTORY = "on";
  h.user = { id: "u1", email: "me@example.com" };
  h.current = { id: ORG };
  h.rpc = { data: null, error: null };
  h.tables = {};
  h.calls.length = 0;
  h.audits.length = 0;
  h.getUser = 0;
});
afterEach(() => {
  delete process.env.NIGHTSHIFT_ADS_FACTORY;
});

describe("the switch", () => {
  it.each(EVERY)("%s is a 404 while the switch is off, before the session or the database is asked", async (_name, call) => {
    for (const value of [undefined, "", "off", "0", "false", "enabled", " ON-ish "]) {
      if (value === undefined) delete process.env.NIGHTSHIFT_ADS_FACTORY;
      else process.env.NIGHTSHIFT_ADS_FACTORY = value;
      const res = await json(await call());
      expect(res, String(value)).toEqual({ status: 404, body: { error: "not_found" } });
    }
    expect(h.getUser).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it.each(EVERY)("%s is a 401 for a signed-out caller, and the database is not asked", async (_name, call) => {
    h.user = null;
    expect(await json(await call())).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(h.calls).toEqual([]);
  });

  it.each(EVERY.filter(([name]) => !name.startsWith("GET")))("%s refuses a request that is not from our own page", async (name) => {
    const [method, path] = name.split(" ");
    const url = path.replace(":id", KIT);
    const mod = { "/api/ads/kits": kits, [`/api/ads/kits/${KIT}`]: kit, [`/api/ads/kits/${KIT}/products`]: kitProducts, [`/api/ads/products/${KIT}`]: product,
      "/api/ads/campaigns": campaigns, [`/api/ads/campaigns/${KIT}`]: campaign, [`/api/ads/campaigns/${KIT}/concepts`]: campaignConcepts,
      [`/api/ads/concepts/${KIT}`]: concept }[url] as unknown as Record<string, (r: Request, c: unknown) => Promise<Response>>;
    for (const headers of [{}, { Origin: "https://evil.example" }, { Origin: "null" }] as Record<string, string>[]) {
      const res = await mod[method](req(url, method, method === "DELETE" ? undefined : {}, headers), ctx(KIT));
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect(h.getUser).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("writes no audit row of its own: the rows record who (created_by, approved_by), and the audit list (0087) does not take these actions yet", async () => {
    h.rpc = { data: KIT, error: null };
    await kits.POST(req("/api/ads/kits", "POST", KIT_BODY));
    expect(h.audits).toEqual([]);
  });

  it("every answer is no-store", async () => {
    h.rpc = { data: KIT, error: null };
    for (const [, call] of EVERY.slice(0, 3)) expect((await call()).headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/ads", () => {
  it("reads the six tables of the organization the app has open, under the member's session", async () => {
    h.tables.brand_kits = { data: [{ id: KIT, name: "Acme", palette: [], fonts: [], voice_notes: "", source: "manual" }], error: null };
    const res = await json(await root.GET(req("/api/ads", "GET")));
    expect(res.status).toBe(200);
    expect(res.body.org).toBe(ORG);
    expect((res.body.kits as unknown[]).length).toBe(1);
    expect(res.body.campaigns).toEqual([]);
    expect(h.calls.filter((c) => c.kind === "from").map((c) => c.name).sort()).toEqual(
      ["ad_campaign_products", "ad_campaigns", "ad_concepts", "brand_kits", "brand_product_images", "brand_products"],
    );
    for (const c of h.calls) expect(c.chain.find((s) => s.m === "eq")?.a, c.name).toEqual(["org_id", ORG]);
    expect(rpcs()).toEqual([]);
  });

  it("says so when 0131 is not applied, when a read fails, when no organization is open and when the id is not one", async () => {
    h.tables.brand_kits = { data: null, error: { code: "42P01", message: 'relation "public.brand_kits" does not exist' } };
    expect(await json(await root.GET(req("/api/ads", "GET")))).toEqual({ status: 503, body: { error: "not_available" } });
    h.tables.brand_kits = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    expect(await json(await root.GET(req("/api/ads", "GET")))).toEqual({ status: 502, body: { error: "read_failed" } });
    h.tables = {};
    h.current = null;
    expect(await json(await root.GET(req("/api/ads", "GET")))).toEqual({ status: 400, body: { error: "org_required" } });
    expect(await json(await root.GET(req("/api/ads?org=not-a-uuid", "GET")))).toEqual({ status: 400, body: { error: "bad_request" } });
  });
});

describe("brand kits", () => {
  it("POST calls save_brand_kit once with cleaned values and the open organization, and records it", async () => {
    h.rpc = { data: KIT, error: null };
    expect(await json(await kits.POST(req("/api/ads/kits", "POST", KIT_BODY)))).toEqual({ status: 201, body: { id: KIT } });
    expect(rpcs()).toHaveLength(1);
    expect(rpcs()[0]).toMatchObject({
      name: "save_brand_kit",
      args: { p_org: ORG, p_kit: null, p_name: "Acme", p_site_url: "https://example.com/", p_logo: null, p_palette: ["#aabbcc"], p_fonts: ["Inter"], p_voice: "Calm." },
    });
    expect(h.audits).toEqual([]);
    expect(h.calls.filter((c) => c.kind === "from")).toEqual([]);
  });

  it("PATCH names the kit and no organization (the database takes it from the row)", async () => {
    h.rpc = { data: KIT, error: null };
    expect(await json(await kit.PATCH(req(`/api/ads/kits/${KIT}`, "PATCH", { ...KIT_BODY, org_id: P(9) }), ctx(KIT)))).toEqual({ status: 200, body: { id: KIT } });
    expect(rpcs()[0].args).toMatchObject({ p_org: null, p_kit: KIT });
  });

  it.each<[string, unknown, string]>([
    ["not JSON", "{", "bad_request"],
    ["an array", [], "bad_request"],
    ["no name", { name: "" }, "invalid_name"],
    ["an http site", { name: "A", site_url: "http://example.com" }, "invalid_site_url"],
    ["an internal host", { name: "A", site_url: "https://169.254.169.254/" }, "invalid_site_url"],
    ["a CSS colour", { name: "A", palette: ["url(x)"] }, "invalid_palette"],
    ["a font with a brace", { name: "A", fonts: ["a{}"] }, "invalid_fonts"],
    ["a logo that is not an id", { name: "A", logo_asset_id: "x" }, "invalid_reference"],
  ])("POST with %s is a 400 and the database is not asked", async (_label, body, error) => {
    expect(await json(await kits.POST(req("/api/ads/kits", "POST", body)))).toEqual({ status: 400, body: { error } });
    expect(await json(await kit.PATCH(req(`/api/ads/kits/${KIT}`, "PATCH", body), ctx(KIT)))).toEqual({ status: 400, body: { error } });
    expect(h.calls).toEqual([]);
  });

  it("an id in the URL that is not a uuid is a 400", async () => {
    for (const id of ["1", "../x", `${KIT}'`, KIT.toUpperCase()]) {
      expect((await kit.PATCH(req("/api/ads/kits/x", "PATCH", KIT_BODY), ctx(id))).status).toBe(400);
      expect((await kit.DELETE(req("/api/ads/kits/x", "DELETE"), ctx(id))).status).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it("a cap is answered with the number the database gave, and with none when it gave none", async () => {
    h.rpc = { data: null, error: { code: "NS429", message: "limit_reached", details: "max=5" } };
    expect(await json(await kits.POST(req("/api/ads/kits", "POST", KIT_BODY)))).toEqual({ status: 409, body: { error: "limit_reached", max: 5 } });
    h.rpc = { data: null, error: { code: "NS429", message: "limit_reached" } };
    expect(await json(await kits.POST(req("/api/ads/kits", "POST", KIT_BODY)))).toEqual({ status: 409, body: { error: "limit_reached" } });
    expect(h.audits).toEqual([]);
  });

  it.each<[Err, number, string]>([
    [{ code: "42501", message: "forbidden" }, 403, "forbidden"],
    [{ code: "P0002", message: "not_found" }, 404, "not_found"],
    [{ code: "NS400", message: "invalid_reference", details: "a picture must be a live image" }, 400, "invalid_reference"],
    [{ code: "PGRST202", message: "Could not find the function public.save_brand_kit" }, 503, "not_available"],
    [{ code: "XX000", message: "internal: stack trace with a secret" }, 502, "failed"],
  ])("a refusal %j is %i %s, with none of the database's text", async (error, status, word) => {
    h.rpc = { data: null, error };
    const res = await json(await kit.PATCH(req(`/api/ads/kits/${KIT}`, "PATCH", KIT_BODY), ctx(KIT)));
    expect(res).toEqual({ status, body: { error: word } });
    expect(h.audits).toEqual([]);
  });

  it("an answer that is not the kit's id is a failure, never a success", async () => {
    h.rpc = { data: "nonsense", error: null };
    expect((await kits.POST(req("/api/ads/kits", "POST", KIT_BODY))).status).toBe(502);
    h.rpc = { data: P(9), error: null };
    expect((await kit.PATCH(req(`/api/ads/kits/${KIT}`, "PATCH", KIT_BODY), ctx(KIT))).status).toBe(502);
    expect(h.audits).toEqual([]);
  });

  it("DELETE calls delete_brand_kit, and a kit still in use is a 409 said by name", async () => {
    h.rpc = { data: true, error: null };
    expect(await json(await kit.DELETE(req(`/api/ads/kits/${KIT}`, "DELETE"), ctx(KIT)))).toEqual({ status: 200, body: { ok: true } });
    expect(rpcs()[0]).toMatchObject({ name: "delete_brand_kit", args: { p_kit: KIT } });
    h.rpc = { data: null, error: { code: "NS409", message: "kit_in_use" } };
    expect(await json(await kit.DELETE(req(`/api/ads/kits/${KIT}`, "DELETE"), ctx(KIT)))).toEqual({ status: 409, body: { error: "kit_in_use" } });
    expect(h.audits).toEqual([]);
  });
});

describe("products and campaigns", () => {
  it("a product is saved under the kit of the URL, with its price as the text that was typed", async () => {
    h.rpc = { data: P(1), error: null };
    expect((await kitProducts.POST(req(`/api/ads/kits/${KIT}/products`, "POST", PRODUCT_BODY), ctx(KIT))).status).toBe(201);
    expect(rpcs()[0]).toMatchObject({ name: "save_brand_product", args: { p_kit: KIT, p_product: null, p_title: "Tea", p_description: "Green.", p_price: "$12", p_images: [P(1)] } });
    expect((await product.PATCH(req(`/api/ads/products/${P(1)}`, "PATCH", PRODUCT_BODY), ctx(P(1)))).status).toBe(200);
    expect(rpcs()[1].args).toMatchObject({ p_kit: null, p_product: P(1) });
    h.rpc = { data: true, error: null };
    expect((await product.DELETE(req(`/api/ads/products/${P(1)}`, "DELETE"), ctx(P(1)))).status).toBe(200);
    expect(rpcs()[2]).toMatchObject({ name: "delete_brand_product", args: { p_product: P(1) } });
  });

  it("a campaign is saved with exactly the closed-list words that were sent", async () => {
    h.rpc = { data: CAMPAIGN, error: null };
    expect(await json(await campaigns.POST(req("/api/ads/campaigns", "POST", CAMPAIGN_BODY)))).toEqual({ status: 201, body: { id: CAMPAIGN } });
    expect(rpcs()[0]).toMatchObject({
      name: "save_ad_campaign",
      args: { p_kit: KIT, p_campaign: null, p_name: "Launch", p_objective: "launch", p_language: "en", p_formats: ["1:1", "9:16"], p_directions: ["bold"], p_products: [P(1), P(2)] },
    });
    expect((await campaign.PATCH(req(`/api/ads/campaigns/${CAMPAIGN}`, "PATCH", CAMPAIGN_BODY), ctx(CAMPAIGN))).status).toBe(200);
    expect(rpcs()[1].args).toMatchObject({ p_kit: null, p_campaign: CAMPAIGN });
  });

  it.each<[string, unknown, string]>([
    ["no kit", { ...CAMPAIGN_BODY, kit_id: undefined }, "bad_request"],
    ["an unknown objective", { ...CAMPAIGN_BODY, objective: "leads" }, "invalid_objective"],
    ["an unknown format", { ...CAMPAIGN_BODY, formats: ["2:3"] }, "invalid_formats"],
    ["no product", { ...CAMPAIGN_BODY, product_ids: [] }, "invalid_products"],
  ])("a campaign with %s is a 400 and the database is not asked", async (_label, body, error) => {
    expect(await json(await campaigns.POST(req("/api/ads/campaigns", "POST", body)))).toEqual({ status: 400, body: { error } });
    expect(h.calls).toEqual([]);
  });
});

describe("POST /api/ads/campaigns/:id/concepts (template drafts)", () => {
  const post = (body: unknown) => campaignConcepts.POST(req(`/api/ads/campaigns/${CAMPAIGN}/concepts`, "POST", body), ctx(CAMPAIGN));
  const seed = () => {
    h.tables.ad_campaigns = { data: [{ id: CAMPAIGN, kit_id: KIT, name: "Launch", objective: "launch", language: "en", formats: ["1:1", "9:16"], directions: ["bold"] }], error: null };
    h.tables.ad_campaign_products = { data: [{ campaign_id: CAMPAIGN, product_id: P(2), position: 1 }, { campaign_id: CAMPAIGN, product_id: P(1), position: 0 }], error: null };
    h.tables.brand_kits = { data: [{ id: KIT, name: "Acme", palette: ["#112233"] }], error: null };
    h.tables.brand_products = { data: [{ id: P(2), kit_id: KIT, title: "Coffee", description: "", price_text: "" }, { id: P(1), kit_id: KIT, title: "Tea", description: "Green. Fresh.", price_text: "$12" }], error: null };
    h.rpc = { data: { ids: [P(11), P(12), P(13)], replayed: false }, error: null };
  };

  it("builds the drafts on the server from the member's own rows and sends them in one call", async () => {
    seed();
    expect(await json(await post({ kind: "video", count: 3, batch: "ads-press-0001" }))).toEqual({ status: 201, body: { ids: [P(11), P(12), P(13)], replayed: false } });
    expect(rpcs()).toHaveLength(1);
    const args = rpcs()[0].args as { p_campaign: string; p_batch: string; p_concepts: Record<string, unknown>[] };
    expect(rpcs()[0].name).toBe("add_ad_concepts");
    expect(args.p_campaign).toBe(CAMPAIGN);
    expect(args.p_batch).toBe("ads-press-0001");
    expect(args.p_concepts.map((c) => [c.product_id, c.format, c.direction, c.kind, c.headline])).toEqual([
      [P(1), "1:1", "bold", "video", "New from Acme: Tea"],
      [P(2), "1:1", "bold", "video", "New from Acme: Coffee"],
      [P(1), "9:16", "bold", "video", "New from Acme: Tea"],
    ]);
    expect(args.p_concepts[0].body).toBe("Green.");
    expect(args.p_concepts[0].storyboard).toHaveLength(4);
    expect(h.audits).toEqual([]);
  });

  it("a retry of the same press sends the same words, so the database can answer it as a replay", async () => {
    seed();
    await post({ kind: "image", count: 4, batch: "ads-press-0002" });
    h.rpc = { data: { ids: [P(11)], replayed: true }, error: null };
    const again = await json(await post({ kind: "image", count: 4, batch: "ads-press-0002" }));
    expect(again).toEqual({ status: 200, body: { ids: [P(11)], replayed: true } });
    expect(JSON.stringify(rpcs()[1].args)).toBe(JSON.stringify(rpcs()[0].args));
    expect(h.audits).toEqual([]);
  });

  it("takes no text from the browser: extra keys in the body change nothing that is sent", async () => {
    seed();
    await post({ kind: "image", count: 1, batch: "ads-press-0003", headline: "INJECTED", concepts: [{ headline: "INJECTED" }], product_id: P(9), status: "approved" });
    expect(JSON.stringify(rpcs()[0].args)).not.toContain("INJECTED");
    expect(JSON.stringify(rpcs()[0].args)).not.toContain(P(9));
    expect(JSON.stringify(rpcs()[0].args)).not.toContain("approved");
  });

  it("a campaign that is not readable under this session is a 404, whoever's it is, and nothing is sent", async () => {
    h.tables.ad_campaigns = { data: [], error: null };
    expect(await json(await post({ kind: "image", count: 1, batch: "ads-press-0004" }))).toEqual({ status: 404, body: { error: "not_found" } });
    expect(rpcs()).toEqual([]);
  });

  it("a campaign whose products are all gone, a failed read and a missing migration are said, never turned into empty drafts", async () => {
    seed();
    h.tables.ad_campaign_products = { data: [], error: null };
    expect(await json(await post({ kind: "image", count: 1, batch: "ads-press-0005" }))).toEqual({ status: 400, body: { error: "invalid_products" } });
    seed();
    h.tables.brand_products = { data: null, error: { code: "57014", message: "timeout" } };
    expect(await json(await post({ kind: "image", count: 1, batch: "ads-press-0005" }))).toEqual({ status: 502, body: { error: "read_failed" } });
    h.tables.ad_campaigns = { data: null, error: { code: "42P01", message: "does not exist" } };
    expect(await json(await post({ kind: "image", count: 1, batch: "ads-press-0005" }))).toEqual({ status: 503, body: { error: "not_available" } });
    expect(rpcs()).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ["an unknown kind", { kind: "carousel", count: 1, batch: "ads-press-0006" }, "invalid_kind"],
    ["thirteen", { kind: "image", count: 13, batch: "ads-press-0006" }, "invalid_count"],
    ["no press id", { kind: "image", count: 1 }, "invalid_idempotency_key"],
    ["not JSON", "{", "bad_request"],
  ])("%s is a 400 before anything is read", async (_label, body, error) => {
    seed();
    expect(await json(await post(body))).toEqual({ status: 400, body: { error } });
    expect(h.calls).toEqual([]);
  });

  it("the campaign's cap and a conflict are passed on as words", async () => {
    seed();
    h.rpc = { data: null, error: { code: "NS429", message: "limit_reached", details: "max=24 have=20" } };
    expect(await json(await post({ kind: "image", count: 6, batch: "ads-press-0007" }))).toEqual({ status: 409, body: { error: "limit_reached", max: 24 } });
    h.rpc = { data: null, error: { code: "NS409", message: "idempotency_conflict" } };
    expect(await json(await post({ kind: "image", count: 6, batch: "ads-press-0007" }))).toEqual({ status: 409, body: { error: "idempotency_conflict" } });
    h.rpc = { data: { ids: "nope" }, error: null };
    expect((await post({ kind: "image", count: 6, batch: "ads-press-0007" })).status).toBe(502);
    expect(h.audits).toEqual([]);
  });
});

describe("PATCH /api/ads/concepts/:id", () => {
  const patch = (body: unknown) => concept.PATCH(req(`/api/ads/concepts/${CONCEPT}`, "PATCH", body), ctx(CONCEPT));

  it("a status alone moves the concept and calls nothing else", async () => {
    h.rpc = { data: "approved", error: null };
    expect(await json(await patch({ status: "approved" }))).toEqual({ status: 200, body: { id: CONCEPT, status: "approved" } });
    expect(rpcs()).toHaveLength(1);
    expect(rpcs()[0]).toMatchObject({ name: "set_ad_concept_status", args: { p_concept: CONCEPT, p_status: "approved" } });
    expect(h.audits).toEqual([]);
  });

  it("words and a status in one request are refused: an approval is of words already saved", async () => {
    expect(await json(await patch({ status: "approved", headline: "New words" }))).toEqual({ status: 400, body: { error: "bad_request" } });
    expect(await json(await patch({ status: "published" }))).toEqual({ status: 400, body: { error: "invalid_status" } });
    expect(h.calls).toEqual([]);
  });

  it("words are cleaned and sent to update_ad_concept; an image sends no beats", async () => {
    h.rpc = { data: true, error: null };
    expect((await patch({ headline: " New ", body: "a\r\nb", cta: "Go", visual_brief: "x", storyboard: [{ visual: " v ", line: "" }] })).status).toBe(200);
    expect(rpcs()[0]).toMatchObject({
      name: "update_ad_concept",
      args: { p_concept: CONCEPT, p_headline: "New", p_body: "a\nb", p_cta: "Go", p_visual_brief: "x", p_storyboard: [{ visual: "v", line: "" }] },
    });
    await patch({ headline: "H" });
    expect((rpcs()[1].args as { p_storyboard: unknown }).p_storyboard).toBeNull();
  });

  it("the database's refusals are said by name", async () => {
    h.rpc = { data: null, error: { code: "NS409", message: "concept_not_draft" } };
    expect(await json(await patch({ headline: "H" }))).toEqual({ status: 409, body: { error: "concept_not_draft" } });
    h.rpc = { data: null, error: { code: "NS409", message: "invalid_transition" } };
    expect(await json(await patch({ status: "approved" }))).toEqual({ status: 409, body: { error: "invalid_transition" } });
    h.rpc = { data: "draft", error: null };
    expect((await patch({ status: "approved" })).status).toBe(502);
  });

  it("DELETE calls delete_ad_concept", async () => {
    h.rpc = { data: true, error: null };
    expect((await concept.DELETE(req(`/api/ads/concepts/${CONCEPT}`, "DELETE"), ctx(CONCEPT))).status).toBe(200);
    expect(rpcs()[0]).toMatchObject({ name: "delete_ad_concept", args: { p_concept: CONCEPT } });
  });
});

describe("what the Ads code never does (read from the source)", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }
  const ROOT = join(__dirname, "..");
  const files = [...walk(join(ROOT, "app", "api", "ads")), ...walk(join(ROOT, "lib", "adsFactory")), join(ROOT, "lib", "server", "ads-factory.ts"),
    ...walk(join(ROOT, "components", "ads")), ...walk(join(ROOT, "app", "(app)", "[channel]", "ads"))].filter((f) => /\.tsx?$/.test(f));
  const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");

  it("finds the files (the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThanOrEqual(17);
  });

  it("never reaches for the service key, never calls a model or a provider, never touches credits or the publish path", () => {
    for (const f of files) {
      const src = code(f);
      for (const word of ["SERVICE_ROLE", "service_role", "createAdminClient", "createServiceClient", "reserve_credits", "capture_credits", "creative_jobs", "render_jobs", "publish_requests",
        "generativelanguage", "openai", "anthropic", "replicate", "fal.run"]) {
        expect(src.includes(word), `${f}: ${word}`).toBe(false);
      }
    }
  });

  it("fetches nothing but its own routes: no server-side fetch at all, and the browser only calls /api/ads and the library read", () => {
    for (const f of files) {
      const src = code(f);
      const server = f.includes(`${join("app", "api")}`) || f.includes(join("lib", "server")) || f.includes(join("lib", "adsFactory"));
      if (server) expect(/\bfetch\(|\bhttps?\.request|\bnet\.connect|dns\./.test(src), f).toBe(false);
    }
    const client = files.filter((f) => f.includes(join("components", "ads"))).map(code).join("\n");
    // Two fetches: adsRequest's, and the brand scan panel's own call() (0133; it also reads retry_after and price), and every adsRequest
    // and every call() names an /api/ads path (the scan's, /api/ads/scan).
    expect([...client.matchAll(/\bfetch\(\s*([\w.]+)/g)].map((m) => m[1])).toEqual(["url", "url"]);
    expect([...client.matchAll(/adsRequest(?:<[^>]*>)?\(\s*"[A-Z]+",\s*[`"]([^`"$?]*)/g)].every((m) => m[1].startsWith("/api/ads"))).toBe(true);
    const calls = [...client.matchAll(/\bcall(?:<[^>]*>)?\(\s*"[A-Z]+",\s*[`"]([^`"$?]*)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((u) => u.startsWith("/api/ads/scan"))).toBe(true);
  });

  it("never renders typed text as HTML", () => {
    for (const f of files) expect(code(f).includes("dangerouslySetInnerHTML"), f).toBe(false);
  });
});
