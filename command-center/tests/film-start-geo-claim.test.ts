/**
 * The film start sends the server-signed country (migration 0244), the way Run now does for a workflow (lib/server/geo-claim.ts).
 *
 * Why: a take's creative job is written later by the film worker, with no visitor, so the database gate cannot read a country then.
 * start_film reads it in the starter's own request instead, refuses a model the country may not use, and records the country the
 * project's takes carry. Without the header every project on a Google model is refused country_unverified at the start.
 *
 * What would break: the header missing for a project with a Google model; sent for a project with no country-listed model; signed
 * for a country the server did not read (a body field, or the visitor's own copy of the header); a project whose models could not
 * be read started unchecked.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  user: vi.fn(), client: vi.fn(), admin: vi.fn(), rate: vi.fn(),
  calls: [] as Array<{ fn: string; args: Record<string, unknown>; headers: Record<string, string> }>,
}));
vi.mock("@/lib/supabase/server", () => ({ getUser: h.user, createClient: h.client }));
vi.mock("@/lib/auth/org-roles", () => ({ isPlatformAdmin: h.admin }));
vi.mock("@/lib/orgs-server", async () => ({ getOrgContext: async () => (await import("./films-fixtures")).ORG_CONTEXT }));
vi.mock("@/lib/server/web-rate", async (orig) => ({ ...(await orig<typeof import("../lib/server/web-rate")>()), takeWebRate: h.rate }));

const { FILM, FILM_MODELS_UNLISTED, withOrgSwitch } = await import("./films-fixtures");
type FilmModelsAnswer = import("./films-fixtures").FilmModelsAnswer;
const startRoute = await import("../app/api/films/[id]/start/route");

const USER = "55555555-5555-4555-8555-555555555555";
const KEY = "a-test-only-key-that-is-long-enough-0123456789";
const UZ = "84.54.64.1"; // the shipped table places it in Uzbekistan (tests/geo-google.test.ts asserts it)
const GOOGLE = "gemini-3.1-flash-image";
const QID = `fq-3-${"c".repeat(32)}`;
const IDEM = "film-0123456789abcdef0123456789abcdef";
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://app.test/api/films/${FILM}/start`, {
    method: "POST",
    headers: { origin: "https://app.test", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

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
      return Promise.resolve({ data: { ok: true, replayed: false, id: "9bd8a435-c433-43a7-8aac-3844c6138d3b", status: "queued" }, error: null })
        .then(res, rej);
    },
  };
  return b;
}

const ON_GOOGLE: FilmModelsAnswer = {
  film: () => ({ data: { keyframe_model: "img-a", clip_model: "vid-a", voice: { model: "tts-a" } }, error: null }),
  // A scene's own key-frame model is Google: the claim is asked for the scene's model too, not only the project's.
  scenes: () => ({ data: [{ keyframe_model: GOOGLE, clip_model: null }], error: null }),
};

function client(models: FilmModelsAnswer = ON_GOOGLE) {
  return { rpc, from: withOrgSwitch(() => { throw new Error("no other table read here"); }, undefined, undefined, models) };
}
const started = () => h.calls.filter((c) => c.fn === "start_film");

beforeEach(() => {
  h.calls = [];
  vi.stubEnv("NIGHTSHIFT_FILM_STUDIO", "on");
  vi.stubEnv("NIGHTSHIFT_GEO_CLAIM_KEY", KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.user.mockReset().mockResolvedValue({ id: USER });
  h.admin.mockReset().mockResolvedValue(false);
  h.rate.mockReset().mockResolvedValue("ok");
  h.client.mockReset().mockResolvedValue(client());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("0244: the film start sends the server-signed country", () => {
  it("signs the country the server read, for this person, with the shared key, for a project with a Google model", async () => {
    const r = await startRoute.POST(post({ quote_id: QID, idem: IDEM }, { "x-nightshift-client-ip": UZ }), params(FILM));
    expect(r.status).toBe(200);
    const [call] = started();
    const claim = call.headers["x-nightshift-geo"];
    expect(claim).toMatch(new RegExp(`^v1\\.UZ\\.${USER}\\.[0-9]+\\.[0-9a-f]{64}$`));
    const parts = claim.split(".");
    expect(parts[4]).toBe(createHmac("sha256", KEY).update(parts.slice(0, 4).join("."), "utf8").digest("hex"));
    expect(call.args).toEqual({ p_film: FILM, p_quote_id: QID, p_idempotency_key: IDEM });
  });

  it("sends nothing for a project with no country-listed model", async () => {
    h.client.mockResolvedValue(client(FILM_MODELS_UNLISTED));
    await startRoute.POST(post({ quote_id: QID, idem: IDEM }, { "x-nightshift-client-ip": UZ }), params(FILM));
    expect(started()[0].headers).toEqual({});
  });

  it("never takes a country from the request: a body field or the visitor's own header vouches for nothing", async () => {
    const forged = `v1.UZ.${USER}.${Math.floor(Date.now() / 1000) + 60}.${"0".repeat(64)}`;
    // No address the server can place: whatever the request says, no country is signed.
    await startRoute.POST(post({ quote_id: QID, idem: IDEM, country: "UZ", geo: forged }, { "x-nightshift-geo": forged }), params(FILM));
    expect(started()[0].headers).toEqual({});
    expect(started()[0].args).not.toHaveProperty("country");
    // With an address placed in Uzbekistan and a body that says US, the claim is the server's reading, freshly signed.
    h.calls = [];
    await startRoute.POST(post({ quote_id: QID, idem: IDEM, country: "US" }, { "x-nightshift-client-ip": UZ, "x-nightshift-geo": forged }),
      params(FILM));
    const claim = started()[0].headers["x-nightshift-geo"];
    expect(claim).not.toBe(forged);
    expect(claim.split(".")[1]).toBe("UZ");
  });

  it("starts nothing when the project's models cannot be read", async () => {
    h.client.mockResolvedValue(client({ ...ON_GOOGLE, scenes: () => ({ data: null, error: { code: "42501", message: "denied" } }) }));
    const r = await startRoute.POST(post({ quote_id: QID, idem: IDEM }, { "x-nightshift-client-ip": UZ }), params(FILM));
    expect(r.status).toBe(502);
    expect(started()).toEqual([]);
  });
});
