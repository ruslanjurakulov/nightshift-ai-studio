/**
 * Google's models are sold only inside the regions Google lists (lib/geo/blocked.ts, from aistudio.google.com/docs/available-regions,
 * read 2026-11-21), with the table that ships in the image (data/geoip/country.bin.gz) and the real BLOCKED_COUNTRIES (not a test map).
 *
 * What would break without these: a Google model quoted, held or queued for a request from Russia or Belarus at any web entry point
 * (the database called at all); Uzbekistan refused; an unknown country let through for an allow-list vendor (Google's terms allow
 * use only inside a listed region); the registry's lists drifting from the web's; the picker offering a Google model to an unknown
 * country; and the server-signed country (0208) missing from a job-creating call for a gated model, sent for a model without a
 * list, signed with the wrong bytes, or made without a key.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown>; headers: Record<string, string> }>,
  headers: new Headers(),
  workflow: null as unknown,
  run: null as unknown,
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "55555555-5555-4555-8555-555555555555";
const WF = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";

function answer(fn: string, a: Record<string, unknown>): { data: unknown; error: unknown } {
  if (fn === "quote_creative_job") return { data: { credits: 4, model: a.p_model, capability: a.p_capability, credits_per_unit: 4 }, error: null };
  if (fn === "create_creative_job") return { data: { job: { id: "22222222-2222-4222-8222-222222222222", quoted_credits: 4 }, replay: false }, error: null };
  if (fn === "quote_workflow") return { data: { total_credits: 4, steps: [] }, error: null };
  if (fn === "start_workflow_run" || fn === "advance_workflow_run") return { data: null, error: { code: "NS400", message: "invalid_inputs" } };
  if (fn === "sellable_models") return { data: [], error: null };
  return { data: [], error: null };
}

/** A PostgREST call as supabase-js builds it: awaitable, with setHeader, recording the headers it was sent with. */
function rpc(fn: string, args?: unknown) {
  const call = { fn, args: (args ?? {}) as Record<string, unknown>, headers: {} as Record<string, string> };
  const b = {
    setHeader(k: string, v: string) {
      call.headers[k] = v;
      return b;
    },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      h.calls.push(call);
      return Promise.resolve(answer(fn, call.args)).then(res, rej);
    },
  };
  return b;
}

vi.mock("next/headers", () => ({ headers: async () => h.headers }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => {} }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: ORG } }) }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: USER }),
  createClient: async () => ({
    rpc,
    from: (table: string) => {
      const q: Record<string, unknown> = {
        select: () => q, in: () => q, not: () => q, eq: () => q, is: () => q, neq: () => q,
        order: () => (table === "workflow_run_steps" ? Promise.resolve({ data: (h.run as { steps?: unknown[] } | null)?.steps ?? [], error: null }) : q),
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: table === "workflow_runs" ? (h.run ? { id: RUN } : null) : h.workflow, error: null }),
      };
      return q;
    },
  }),
}));

const { GOOGLE_MODELS, GOOGLE_BLOCKED, GOOGLE_AVAILABLE_REGIONS, ISO_3166_ALPHA2, BLOCKED_COUNTRIES, withoutBlocked } = await import("@/lib/geo/blocked");
const { geoRefusal, hideBlockedModels, blockedModelsHere } = await import("@/lib/server/geo");
const { geoClaimHeaders, signGeoClaim, GEO_CLAIM_HEADER, GEO_CLAIM_TTL_S } = await import("@/lib/server/geo-claim");
const { lookupCountry, parseGeoTable } = await import("@/lib/geo/table");
const quoteRoute = await import("@/app/api/creative/quote/route");
const jobsRoute = await import("@/app/api/creative/jobs/route");
const wfRunRoute = await import("@/app/api/workflows/[id]/run/route");
const wfQuoteRoute = await import("@/app/api/workflows/[id]/quote/route");
const advanceRoute = await import("@/app/api/workflows/runs/[id]/advance/route");

const ROOT = join(__dirname, "..", "..");
const TABLE = parseGeoTable(new Uint8Array(gunzipSync(readFileSync(join(__dirname, "..", "data", "geoip", "country.bin.gz")))));
// The small fixture table (tests/fixtures) has no country for 11.0.0.1: DB-IP's real one covers every public address, so a visitor's
// "not_in_table" is read from the fixture.
const FIXTURE = parseGeoTable(new Uint8Array(readFileSync(join(__dirname, "fixtures", "geoip-fixture.bin"))));
const fixture = () => FIXTURE;
// Addresses the shipped table (DB-IP, 2026-11) places in Russia, Belarus and Uzbekistan (asserted below).
const RU = "77.88.8.8";
const BY = "93.84.0.1";
const UZ = "84.54.64.1";
const NOWHERE = "11.0.0.1";
const KEY = "a-test-only-key-that-is-long-enough-0123456789";
const ip = (a: string) => ({ "x-nightshift-client-ip": a });

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://nightshift.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://nightshift.test", ...headers },
    body: JSON.stringify(body),
  });
}
const CAP: Record<string, string> = {
  "gemini-2.5-flash-image-expand": "expand", "gemini-2.5-flash-image-relight": "relight", "gemini-2.5-flash-image-erase": "erase",
  "gemini-3.6-flash": "describe", "veo-3.1": "t2v", "veo-3.1-fast": "t2v", "veo-3.1-lite": "t2v", "gemini-omni-1.1-flash": "t2v",
};
const SRC = "66666666-6666-4666-8666-666666666666";
function paramsFor(cap: string): Record<string, unknown> {
  if (cap === "t2v") return { prompt: "a slow pan", duration_s: 4, aspect_ratio: "16:9" };
  if (cap === "describe") return { source_asset_id: SRC };
  if (cap === "expand") return { source_asset_id: SRC, aspect_ratio: "16:9" };
  if (cap === "relight") return { source_asset_id: SRC, look: "warm" };
  if (cap === "erase") return { source_asset_id: SRC, prompt: "the cup" };
  return { prompt: "a lighthouse at dawn", aspect_ratio: "1:1" };
}
const body = (model: string, extra: Record<string, unknown> = {}) => {
  const capability = CAP[model] ?? "t2i";
  return { org_id: ORG, capability, model, params: paramsFor(capability), ...extra };
};
const quote = (model: string, headers: Record<string, string>) => quoteRoute.POST(post("/api/creative/quote", body(model), headers));
const create = (model: string, headers: Record<string, string>) =>
  jobsRoute.POST(post("/api/creative/jobs", body(model, { max_credits: 10, idempotency_key: "k-1" }), headers));
const wfParams = { params: Promise.resolve({ id: WF }) };
const wfQuote = (headers: Record<string, string>) => wfQuoteRoute.POST(post(`/api/workflows/${WF}/quote`, { inputs: {} }, headers), wfParams);
const wfRun = (headers: Record<string, string>) =>
  wfRunRoute.POST(post(`/api/workflows/${WF}/run`, { run_id: RUN, version: 1, inputs: {}, max_credits: 10 }, headers), wfParams);
const advance = (headers: Record<string, string>) =>
  advanceRoute.POST(post(`/api/workflows/runs/${RUN}/advance`, {}, headers), { params: Promise.resolve({ id: RUN }) });
const workflowOf = (model: string) => ({
  id: WF, org_id: ORG, name: "wf", version: 1, inputs: [],
  steps: [{ capability: "t2i", model, params: { prompt: "a lighthouse" } }],
});
const dbCalls = (fn: string) => h.calls.filter((c) => c.fn === fn);

beforeEach(() => {
  h.calls = [];
  h.headers = new Headers();
  h.workflow = null;
  h.run = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("NIGHTSHIFT_GEO_CLAIM_KEY", KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the list", () => {
  it("reads the test addresses as the countries they stand for", () => {
    expect([lookupCountry(TABLE, RU), lookupCountry(TABLE, BY), lookupCountry(TABLE, UZ), lookupCountry(FIXTURE, NOWHERE)]).toEqual(["RU", "BY", "UZ", null]);
  });

  it("blocks every ISO code Google does not list, and only those", () => {
    expect(ISO_3166_ALPHA2.length).toBe(249);
    expect(new Set(ISO_3166_ALPHA2).size).toBe(249);
    for (const c of ["RU", "BY", "CN", "HK", "MO", "IR", "KP", "CU", "AF", "MM"]) expect([c, GOOGLE_BLOCKED.includes(c)]).toEqual([c, true]);
    for (const c of ["UZ", "KZ", "US", "DE", "UA", "TR", "GB"]) expect([c, GOOGLE_BLOCKED.includes(c)]).toEqual([c, false]);
    // Every listed name became a code that exists (Kosovo's XK is DB-IP's, not ISO's).
    for (const c of GOOGLE_AVAILABLE_REGIONS) if (c !== "XK") expect([c, ISO_3166_ALPHA2.includes(c)]).toEqual([c, true]);
    expect(GOOGLE_BLOCKED.length + GOOGLE_AVAILABLE_REGIONS.length - 1).toBe(249);
  });

  it("covers every provider='google' row of the registry, with the same list in the same order", () => {
    const reg = JSON.parse(readFileSync(join(ROOT, "schemas", "model_registry.json"), "utf8")) as {
      models: Array<{ id: string; provider: string; blocked_countries?: string[]; terms_gate?: string | null; api_exposure?: string }>;
    };
    const google = reg.models.filter((m) => m.provider === "google");
    expect(google.map((m) => m.id).sort()).toEqual([...GOOGLE_MODELS].sort());
    for (const m of google) {
      expect([m.id, m.blocked_countries]).toEqual([m.id, GOOGLE_BLOCKED]);
      expect([m.id, BLOCKED_COUNTRIES[m.id]]).toEqual([m.id, GOOGLE_BLOCKED]);
      // 0142 and the registry validator: a country list keeps a model off sale until it is opened on purpose.
      expect([m.id, Boolean(m.terms_gate), m.api_exposure]).toEqual([m.id, true, "web_only"]);
    }
  });
});

describe("geoRefusal for every Google model", () => {
  it("refuses Russia and Belarus, lets Uzbekistan through, and refuses an unknown country with its own remedy", () => {
    for (const m of GOOGLE_MODELS) {
      expect([m, geoRefusal(m, new Headers(ip(RU)))?.body]).toEqual([m, { error: "country_blocked" }]);
      expect([m, geoRefusal(m, new Headers(ip(BY)))?.body]).toEqual([m, { error: "country_blocked" }]);
      expect([m, geoRefusal(m, new Headers(ip(UZ)))]).toEqual([m, null]);
      // Not only a broken setup: an address DB-IP has no country for, and no address at all, outside production too.
      for (const hd of [ip(NOWHERE), {}]) {
        const r = geoRefusal(m, new Headers(hd), BLOCKED_COUNTRIES, fixture, false);
        expect([m, r?.status, r?.body]).toEqual([m, 451, { error: "country_unverified" }]);
      }
    }
  });

  it("hides Google from the picker and the automatic choice for an unknown country, and only Google", () => {
    const models = [...GOOGLE_MODELS, "grounded-image-1.0", "minimax-h3"].map((id) => ({ id }));
    const shown = hideBlockedModels(models, new Headers(ip(NOWHERE)), BLOCKED_COUNTRIES, fixture, false).map((m) => m.id);
    expect(shown).toEqual(["grounded-image-1.0", "minimax-h3"]);
    expect(withoutBlocked(models, null).map((m) => m.id)).toEqual(["grounded-image-1.0", "minimax-h3"]);
    const forbidden = blockedModelsHere(new Headers(ip(NOWHERE)), BLOCKED_COUNTRIES, fixture, false);
    expect(GOOGLE_MODELS.every((m) => forbidden?.(m))).toBe(true);
    expect(forbidden?.("grounded-image-1.0")).toBe(false);
    expect(hideBlockedModels(models, new Headers(ip(UZ))).map((m) => m.id)).toEqual(models.map((m) => m.id));
  });
});

describe("every web entry point that can start a Google job", () => {
  it("Studio quote and create: RU and BY refused before the database; unknown refused; UZ reaches it, the create with a signed country", async () => {
    for (const m of GOOGLE_MODELS) {
      for (const a of [RU, BY]) {
        for (const res of [await quote(m, ip(a)), await create(m, ip(a))]) {
          expect([m, a, res.status, await res.json()]).toEqual([m, a, 451, { error: "country_blocked" }]);
        }
      }
      for (const res of [await quote(m, {}), await create(m, {})]) {
        expect([m, res.status, await res.json()]).toEqual([m, 451, { error: "country_unverified" }]);
      }
      expect(dbCalls("quote_creative_job").length + dbCalls("create_creative_job").length).toBe(0);
      expect([m, (await quote(m, ip(UZ))).status]).toEqual([m, 200]);
      expect([m, (await create(m, ip(UZ))).status]).toEqual([m, 201]);
      const sent = dbCalls("create_creative_job").at(-1)!;
      expect(sent.headers[GEO_CLAIM_HEADER]).toMatch(new RegExp(`^v1\\.UZ\\.${USER}\\.\\d+\\.[0-9a-f]{64}$`));
      h.calls = [];
    }
  });

  it("workflow quote, Run now and the advance: a Google step from RU or BY is refused before the database; UZ is signed", async () => {
    for (const m of GOOGLE_MODELS) {
      h.workflow = workflowOf(m);
      for (const hd of [ip(RU), ip(BY), {}]) {
        for (const res of [await wfQuote(hd), await wfRun(hd)]) expect([m, hd, res.status]).toEqual([m, hd, 451]);
      }
      expect(dbCalls("quote_workflow").length + dbCalls("start_workflow_run").length).toBe(0);
      await wfRun(ip(UZ));
      expect(dbCalls("start_workflow_run").at(-1)?.headers[GEO_CLAIM_HEADER]).toMatch(/^v1\.UZ\./);
      // The advance creates the next step's job: it carries the claim for a run with a gated step, and none from a blocked country.
      h.run = { steps: [{ step_index: 0, capability: "t2i", model: m, status: "queued" }] };
      await advance(ip(UZ));
      expect(dbCalls("advance_workflow_run").at(-1)?.headers[GEO_CLAIM_HEADER]).toMatch(/^v1\.UZ\./);
      await advance(ip(RU));
      expect(dbCalls("advance_workflow_run").at(-1)?.headers[GEO_CLAIM_HEADER]).toMatch(/^v1\.RU\./);
      h.calls = [];
      h.run = null;
    }
  });
});

describe("the server-signed country (0208)", () => {
  it("is the exact HMAC the database recomputes, made for this person, alive for two minutes", () => {
    const c = signGeoClaim("UZ", USER, 1_800_000_000, KEY);
    const body = `v1.UZ.${USER}.${1_800_000_000 + GEO_CLAIM_TTL_S}`;
    expect(c).toBe(`${body}.${createHmac("sha256", KEY).update(body).digest("hex")}`);
    expect(GEO_CLAIM_TTL_S).toBeLessThanOrEqual(300);   // 0208 refuses an expiry more than 300 s ahead
  });

  it("is sent only for a model with a country list, only with a known country, and never without a key", () => {
    const uz = new Headers(ip(UZ));
    expect(geoClaimHeaders(["minimax-h3"], uz, USER)).toBeUndefined();
    expect(geoClaimHeaders(["gemini-3.1-flash-image"], new Headers(ip(NOWHERE)), USER, { load: fixture })).toBeUndefined();
    expect(geoClaimHeaders(["gemini-3.1-flash-image"], new Headers(), USER)).toBeUndefined();
    expect(geoClaimHeaders(["gemini-3.1-flash-image"], uz, USER, { env: {} })).toBeUndefined();
    expect(geoClaimHeaders(["gemini-3.1-flash-image"], uz, USER, { env: { NIGHTSHIFT_GEO_CLAIM_KEY: "too-short" } })).toBeUndefined();
    expect(Object.keys(geoClaimHeaders(["gemini-3.1-flash-image"], uz, USER) ?? {})).toEqual([GEO_CLAIM_HEADER]);
  });

  it("never logs the key or any part of it", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    geoClaimHeaders(["gemini-3.1-flash-image"], new Headers(ip(UZ)), USER, { env: { NIGHTSHIFT_GEO_CLAIM_KEY: "short-secret-value" } });
    expect(JSON.stringify(err.mock.calls)).not.toContain("short-secret");
  });
});
