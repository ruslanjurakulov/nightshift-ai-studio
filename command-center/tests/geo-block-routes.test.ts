/**
 * The quote and create routes, and the Studio's picker, over a model sold by country (docs/GEO_BLOCK.md), with the table that ships in
 * the image (data/geoip/country.bin.gz) and a country list put in place by the test (no registry row carries one yet).
 *
 * What would break without these: a blocked model quoted, held or queued (the database called at all) for a request from a country on its
 * list; the automatic choice handing a blocked pick back as a price, or dead-ending instead of choosing among the models that remain; a
 * routed job left able to fail over onto a blocked model; a workflow whose step names a blocked model priced or started; a spoofed
 * X-Forwarded-For deciding the country; an unknown country refused; and the picker (or the operator's preview list) offering what the
 * routes refuse.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  rpc: vi.fn(async (_fn: string, _args?: unknown) => ({ data: null as unknown, error: null as unknown })),
  headers: new Headers(),
  workflow: null as unknown,
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
        is: () => q,
        order: () => q,
        limit: () => Promise.resolve({ data: ROWS, error: null }),
        maybeSingle: () => Promise.resolve({ data: h.workflow, error: null }),
      };
      return q;
    },
  }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ROWS = [
  { id: "pic-geo", display_name: "Picture Geo", capabilities: ["t2i"], availability: "ga", verified_at: "2026-10-01T00:00:00Z" },
  { id: "pic-other", display_name: "Picture Other", capabilities: ["t2i"], availability: "ga", verified_at: "2026-10-01T00:00:00Z" },
  { id: "pic-third", display_name: "Picture Third", capabilities: ["t2i"], availability: "ga", verified_at: "2026-10-01T00:00:00Z" },
];
// What sellable_models() says of each (the registry's marks) and what the database's exact quote costs.
const MARKS: Record<string, { quality_tier: number; speed_tier: number }> = {
  "pic-geo": { quality_tier: 5, speed_tier: 5 },
  "pic-other": { quality_tier: 4, speed_tier: 2 },
  "pic-third": { quality_tier: 3, speed_tier: 4 },
};
const PRICE: Record<string, number> = { "pic-geo": 1, "pic-other": 9, "pic-third": 4 };
const WF = "33333333-3333-4333-8333-333333333333";
const workflow = (models: string[]) => ({
  id: WF, org_id: ORG, name: "wf", version: 1, inputs: [],
  steps: models.map((model) => ({ capability: "t2i", model, params: { prompt: "a lighthouse" } })),
});
// Addresses the shipped table (DB-IP, 2026-11) places in India, Russia, Uzbekistan and the United States.
const IN = "49.36.0.1";
const RU = "77.88.8.8";
const UZ = "84.54.64.1";
const US = "8.8.8.8";

const quoteRoute = await import("@/app/api/creative/quote/route");
const jobsRoute = await import("@/app/api/creative/jobs/route");
const wfRunRoute = await import("@/app/api/workflows/[id]/run/route");
const wfQuoteRoute = await import("@/app/api/workflows/[id]/quote/route");
const { loadStudioModels, loadOperatorPreviewModels } = await import("@/lib/server/creative");

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
const create = (model: string, headers: Record<string, string>, mode = "exact") =>
  jobsRoute.POST(
    post("/api/creative/jobs", { org_id: ORG, capability: "t2i", model, params: PARAMS, max_credits: 10, idempotency_key: "k-1", ...(mode === "exact" ? {} : { mode }) }, headers),
  );
const wfParams = { params: Promise.resolve({ id: WF }) };
const wfQuote = (headers: Record<string, string>) => wfQuoteRoute.POST(post(`/api/workflows/${WF}/quote`, { inputs: {} }, headers), wfParams);
const wfRun = (headers: Record<string, string>) =>
  wfRunRoute.POST(post(`/api/workflows/${WF}/run`, { run_id: "44444444-4444-4444-8444-444444444444", version: 1, inputs: {}, max_credits: 10 }, headers), wfParams);
const lastArgs = (fn: string) => h.rpc.mock.calls.filter(([f]) => f === fn).at(-1)?.[1] as Record<string, unknown> | undefined;
const calls = (fn: string) => h.rpc.mock.calls.filter(([f]) => f === fn).length;

beforeEach(() => {
  h.headers = new Headers();
  h.workflow = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.rpc.mockReset().mockImplementation(async (fn: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (fn === "quote_creative_job")
      return { data: { credits: PRICE[String(a.p_model)] ?? 4, model: a.p_model, capability: "t2i", credits_per_unit: 1, available: 100 }, error: null };
    // The database's own pick knows nothing of the country: the cheapest, best and fastest here is the blocked model.
    if (fn === "quote_creative_route")
      return { data: { credits: 1, model: "pic-geo", routed_model: "pic-geo", route_reason: "best_value", mode: a.p_mode, capability: "t2i" }, error: null };
    if (fn === "quote_workflow") return { data: { total_credits: 4, steps: [] }, error: null };
    if (fn === "start_workflow_run") return { data: null, error: { code: "NS400", message: "invalid_workflow" } };
    if (fn === "operator_preview_models")
      return { data: [{ id: "pic-geo", display_name: "Picture Geo", capabilities: ["t2i"], spec: {} }, { id: "pic-prev", display_name: "Picture Prev", capabilities: ["t2i"], spec: {} }], error: null };
    if (fn === "create_creative_job")
      return { data: { job: { id: "22222222-2222-4222-8222-222222222222", quoted_credits: 4 }, replay: false }, error: null };
    if (fn === "sellable_models") return { data: ROWS.map((r) => ({ id: r.id, display_name: r.display_name, spec: MARKS[r.id] })), error: null };
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
});

describe("the automatic choice", () => {
  it("is made again among the models offered here when the database picked a blocked one: never a dead end, never the blocked pick", async () => {
    const res = await quote("", { "x-nightshift-client-ip": IN }, "auto");
    expect(res.status).toBe(200);
    const q = ((await res.json()) as { quote: Record<string, unknown> }).quote;
    // auto: a model of quality 4 or more first -> pic-other (quality 4), not the cheaper pic-third (quality 3).
    expect(q).toMatchObject({ routed_model: "pic-other", model: "pic-other", credits: 9, mode: "auto", route_reason: "best_value", display_name: "Picture Other", quality_tier: 4, speed_tier: 2 });
    // The price is the database's exact quote; the platform's rate behind it is not shown (as in the routed quote).
    expect(q).not.toHaveProperty("credits_per_unit");
    // The blocked model was never priced for this visitor.
    expect(h.rpc.mock.calls.filter(([f, a]) => f === "quote_creative_job" && (a as { p_model: string }).p_model === "pic-geo")).toHaveLength(0);
    const cheap = ((await (await quote("", { "x-nightshift-client-ip": RU }, "cheap")).json()) as { quote: Record<string, unknown> }).quote;
    expect(cheap).toMatchObject({ routed_model: "pic-third", credits: 4, route_reason: "cheapest" });
  });

  it("is the database's own where the country forbids nothing or is unknown", async () => {
    const elsewhere: Array<Record<string, string>> = [{ "x-nightshift-client-ip": UZ }, { "x-forwarded-for": IN }];
    for (const headers of elsewhere) {
      const res = await quote("", headers, "auto");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { quote: Record<string, unknown> }).quote.routed_model).toBe("pic-geo");
    }
    expect(calls("quote_creative_job")).toBe(0);
  });

  it("answers country_blocked only when no model that is offered here can make it", async () => {
    h.rpc.mockImplementation(async (fn: string, args?: unknown) => {
      if (fn === "quote_creative_route") return { data: { credits: 1, model: "pic-geo", routed_model: "pic-geo", mode: (args as { p_mode: string }).p_mode }, error: null };
      if (fn === "sellable_models") return { data: [{ id: "pic-geo", display_name: "Picture Geo", spec: MARKS["pic-geo"] }], error: null };
      return { data: [], error: null };
    });
    const res = await quote("", { "x-nightshift-client-ip": IN }, "auto");
    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({ error: "country_blocked" });
  });

  it("starts the confirmed model as an exact job where a model that could make it is blocked, so it can never fail over onto one", async () => {
    // The page sends back the mode and the model the quote named. In India the job is the confirmed model and nothing else.
    expect((await create("pic-other", { "x-nightshift-client-ip": IN }, "auto")).status).toBe(201);
    expect(lastArgs("create_creative_job")).toMatchObject({ p_mode: "exact", p_model: "pic-other" });
    // The blocked pick itself is still refused, in any mode, before the database.
    const n = calls("create_creative_job");
    expect((await create("pic-geo", { "x-nightshift-client-ip": IN }, "auto")).status).toBe(451);
    expect(calls("create_creative_job")).toBe(n);
    // Elsewhere, and when the country is unknown, the routed job is the database's as before.
    expect((await create("pic-geo", { "x-nightshift-client-ip": UZ }, "auto")).status).toBe(201);
    expect(lastArgs("create_creative_job")).toMatchObject({ p_mode: "auto", p_model: "pic-geo" });
    expect((await create("pic-geo", { "x-forwarded-for": IN }, "auto")).status).toBe(201);
    expect(lastArgs("create_creative_job")).toMatchObject({ p_mode: "auto" });
  });
});

describe("a workflow", () => {
  it("whose step names a blocked model is neither priced nor started from that country", async () => {
    h.workflow = workflow(["pic-other", "pic-geo"]);
    for (const res of [await wfQuote({ "x-nightshift-client-ip": IN }), await wfRun({ "x-nightshift-client-ip": RU })]) {
      expect(res.status).toBe(451);
      expect(await res.json()).toEqual({ error: "country_blocked" });
    }
    expect(calls("quote_workflow")).toBe(0);
    expect(calls("start_workflow_run")).toBe(0);
  });

  it("goes to the database elsewhere, when the country is unknown, and when no step is blocked", async () => {
    h.workflow = workflow(["pic-other", "pic-geo"]);
    // (The mock's answers are not real quotes or runs: what is pinned is that the database was asked.)
    expect((await wfQuote({ "x-nightshift-client-ip": UZ })).status).not.toBe(451);
    expect((await wfQuote({ "x-forwarded-for": IN })).status).not.toBe(451);
    expect(calls("quote_workflow")).toBe(2);
    expect((await wfRun({ "x-nightshift-client-ip": US })).status).not.toBe(451);
    expect(calls("start_workflow_run")).toBe(1);
    h.workflow = workflow(["pic-other", "pic-third"]);
    expect((await wfQuote({ "x-nightshift-client-ip": IN })).status).not.toBe(451);
    expect(calls("quote_workflow")).toBe(3);
  });
});

describe("the Studio's picker", () => {
  it("hides the model where it is refused, and shows it elsewhere or when the country is unknown", async () => {
    h.headers = new Headers({ "x-nightshift-client-ip": IN });
    expect((await loadStudioModels()).map((m) => m.id)).toEqual(["pic-other", "pic-third"]);
    h.headers = new Headers({ "x-nightshift-client-ip": UZ });
    expect((await loadStudioModels()).map((m) => m.id)).toEqual(["pic-geo", "pic-other", "pic-third"]);
    h.headers = new Headers({ "x-forwarded-for": IN });
    expect((await loadStudioModels()).map((m) => m.id)).toEqual(["pic-geo", "pic-other", "pic-third"]);
  });

  it("hides an operator preview the same way (migration 0139's list)", async () => {
    h.headers = new Headers({ "x-nightshift-client-ip": IN });
    expect((await loadOperatorPreviewModels(ORG)).map((m) => m.id)).toEqual(["pic-prev"]);
    h.headers = new Headers({ "x-nightshift-client-ip": UZ });
    expect((await loadOperatorPreviewModels(ORG)).map((m) => m.id)).toEqual(["pic-geo", "pic-prev"]);
  });
});
