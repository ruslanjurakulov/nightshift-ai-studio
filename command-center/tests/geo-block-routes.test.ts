/**
 * The quote and create routes, and the Studio's picker, over a model sold by country (docs/GEO_BLOCK.md), with the table that ships in
 * the image (data/geoip/country.bin.gz) and a country list put in place by the test (no registry row carries one yet).
 *
 * What would break without these: a blocked model quoted, held or queued (the database called at all) for a request from a country on its
 * list; the automatic choice handing a blocked pick back as a price; a spoofed X-Forwarded-For deciding the country; an unknown country
 * refused; and the picker offering what the routes refuse.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  rpc: vi.fn(async (_fn: string, _args?: unknown) => ({ data: null as unknown, error: null as unknown })),
  headers: new Headers(),
}));

vi.mock("@/lib/geo/blocked", async (orig) => {
  const real = await orig<typeof import("@/lib/geo/blocked")>();
  const MAP = { "pic-geo": ["IN", "RU"] };
  return {
    ...real,
    BLOCKED_COUNTRIES: MAP,
    blockedCountriesOf: (m: string, map = MAP) => real.blockedCountriesOf(m, map),
    isBlockedIn: (m: string, c: string | null, map = MAP) => real.isBlockedIn(m, c, map),
    withoutBlocked: <T extends { id: string }>(ms: T[], c: string | null, map = MAP) => real.withoutBlocked(ms, c, map),
  };
});
vi.mock("next/headers", () => ({ headers: async () => h.headers }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => {} }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: ORG } }) }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "u1" }),
  createClient: async () => ({
    rpc: h.rpc,
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        in: () => q,
        not: () => q,
        eq: () => q,
        order: () => q,
        limit: () => Promise.resolve({ data: ROWS, error: null }),
      };
      return q;
    },
  }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ROWS = [
  { id: "pic-geo", display_name: "Picture Geo", capabilities: ["t2i"], availability: "ga", verified_at: "2026-10-01T00:00:00Z" },
  { id: "pic-other", display_name: "Picture Other", capabilities: ["t2i"], availability: "ga", verified_at: "2026-10-01T00:00:00Z" },
];
// Addresses the shipped table (DB-IP, 2026-11) places in India, Russia, Uzbekistan and the United States.
const IN = "49.36.0.1";
const RU = "77.88.8.8";
const UZ = "84.54.64.1";
const US = "8.8.8.8";

const quoteRoute = await import("@/app/api/creative/quote/route");
const jobsRoute = await import("@/app/api/creative/jobs/route");
const { loadStudioModels } = await import("@/lib/server/creative");

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://nightshift.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://nightshift.test", ...headers },
    body: JSON.stringify(body),
  });
}
const PARAMS = { prompt: "a lighthouse at dawn", aspect_ratio: "1:1" };
const quote = (model: string, headers: Record<string, string>, mode = "exact") =>
  quoteRoute.POST(post("/api/creative/quote", { org_id: ORG, capability: "t2i", model, params: PARAMS, ...(mode === "exact" ? {} : { mode }) }, headers));
const create = (model: string, headers: Record<string, string>) =>
  jobsRoute.POST(post("/api/creative/jobs", { org_id: ORG, capability: "t2i", model, params: PARAMS, max_credits: 10, idempotency_key: "k-1" }, headers));
const calls = (fn: string) => h.rpc.mock.calls.filter(([f]) => f === fn).length;

beforeEach(() => {
  h.headers = new Headers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.rpc.mockReset().mockImplementation(async (fn: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (fn === "quote_creative_job") return { data: { credits: 4, model: a.p_model, capability: "t2i" }, error: null };
    if (fn === "quote_creative_route") return { data: { credits: 4, model: "pic-geo", capability: "t2i" }, error: null };
    if (fn === "create_creative_job")
      return { data: { job: { id: "22222222-2222-4222-8222-222222222222", quoted_credits: 4 }, replay: false }, error: null };
    if (fn === "sellable_models") return { data: ROWS.map((r) => ({ id: r.id, spec: {} })), error: null };
    return { data: [], error: null };
  });
});

describe("the quote and create routes", () => {
  it("refuse a model in a country on its list before the database is called, in neutral words", async () => {
    for (const ip of [IN, RU]) {
      for (const res of [await quote("pic-geo", { "x-nightshift-client-ip": ip }), await create("pic-geo", { "x-nightshift-client-ip": ip })]) {
        expect(res.status).toBe(451);
        expect(await res.json()).toEqual({ error: "country_blocked" });
      }
    }
    expect(calls("quote_creative_job")).toBe(0);
    expect(calls("create_creative_job")).toBe(0);
  });

  it("let the same model through elsewhere, and every other model everywhere", async () => {
    expect((await quote("pic-geo", { "x-nightshift-client-ip": UZ })).status).toBe(200);
    expect((await create("pic-geo", { "x-nightshift-client-ip": US })).status).toBe(201);
    expect((await quote("pic-other", { "x-nightshift-client-ip": IN })).status).toBe(200);
    expect((await create("pic-other", { "x-nightshift-client-ip": IN })).status).toBe(201);
  });

  it("believe no X-Forwarded-For, X-Real-IP or CF-Connecting-IP a client sent: the country is unknown, so it is allowed and logged", async () => {
    const spoof = { "x-forwarded-for": UZ, "x-real-ip": UZ, "cf-connecting-ip": UZ };
    // The header Caddy writes says India: a visitor cannot talk their way out of it.
    expect((await create("pic-geo", { ...spoof, "x-nightshift-client-ip": IN })).status).toBe(451);
    // Only spoofable headers, no Caddy header (not through the proxy): unknown, allowed.
    expect((await create("pic-geo", { "x-forwarded-for": IN, "x-real-ip": IN, "cf-connecting-ip": IN })).status).toBe(201);
    // A private or local address is unknown too.
    expect((await create("pic-geo", { "x-nightshift-client-ip": "10.0.0.7" })).status).toBe(201);
    expect(console.warn).toHaveBeenCalled();
  });

  it("refuse the automatic choice's pick instead of showing its price", async () => {
    const res = await quote("", { "x-nightshift-client-ip": IN }, "auto");
    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({ error: "country_blocked" });
    expect((await quote("", { "x-nightshift-client-ip": UZ }, "auto")).status).toBe(200);
  });
});

describe("the Studio's picker", () => {
  it("hides the model where it is refused, and shows it elsewhere or when the country is unknown", async () => {
    h.headers = new Headers({ "x-nightshift-client-ip": IN });
    expect((await loadStudioModels()).map((m) => m.id)).toEqual(["pic-other"]);
    h.headers = new Headers({ "x-nightshift-client-ip": UZ });
    expect((await loadStudioModels()).map((m) => m.id)).toEqual(["pic-geo", "pic-other"]);
    h.headers = new Headers({ "x-forwarded-for": IN });
    expect((await loadStudioModels()).map((m) => m.id)).toEqual(["pic-geo", "pic-other"]);
  });
});
