/**
 * GET /api/creative/voices: the Studio's speech voices, from the platform ElevenLabs account.
 * What would break without these: a signed-out caller or one outside any workspace reading the account's voices;
 * "no key on this server" shown as "the account has no voices" (an empty list); ElevenLabs' reason for refusing
 * the key (the platform account's balance) handed to any member; the key itself in a response; a voice whose id
 * the worker refuses offered for picking; and every Voice tab opening spending a call on the platform key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "11111111-1111-4111-8111-111111111111";
const KEY = "xi-route-key-do-not-leak-0123";

const h = vi.hoisted(() => ({
  session: "member" as "member" | "signed_out" | "no_org",
  rate: "ok" as "ok" | "limited" | "unavailable",
  takes: 0,
}));

vi.mock("@/lib/server/creative", () => ({
  creativeSession: async () =>
    h.session === "signed_out"
      ? { ok: false, result: { status: 401, body: { error: "unauthorized" } } }
      : { ok: true, defaultOrg: h.session === "no_org" ? null : ORG, db: {} },
}));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/server/web-rate", async (orig) => {
  const real = await orig<typeof import("@/lib/server/web-rate")>();
  return {
    ...real,
    takeWebRate: async () => {
      h.takes += 1;
      return h.rate;
    },
  };
});

const { GET } = await import("../app/api/creative/voices/route");
const { resetStudioVoicesCache } = await import("../lib/server/studio-voices");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const upstream = vi.fn();

beforeEach(() => {
  h.session = "member";
  h.rate = "ok";
  h.takes = 0;
  process.env.ELEVENLABS_API_KEY = KEY;
  resetStudioVoicesCache();
  upstream.mockReset();
  upstream.mockResolvedValue(
    json({
      voices: [
        { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam", category: "premade", preview_url: "https://cdn.test/a.mp3", labels: { gender: "male", age: "middle_aged", accent: "american", use_case: "narration" } },
        { voice_id: "123", name: "Typed number", category: "cloned" },
        { voice_id: "AbCdEfGhIjKlMnOpQrSt", name: "Shared", category: "professional", is_owner: false, preview_url: "http://insecure.test/x.mp3", description: "Warm storyteller" },
      ],
      has_more: false,
      next_page_token: null,
    }),
  );
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ELEVENLABS_API_KEY;
});

describe("GET /api/creative/voices", () => {
  it("refuses a signed-out caller and one outside any workspace, before ElevenLabs is called", async () => {
    h.session = "signed_out";
    expect((await GET()).status).toBe(401);
    h.session = "no_org";
    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org_required" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("says the key is not configured, never an empty list", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "voices_not_configured" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns the account's voices with their character, drops ids the worker refuses, and never the key", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    const body = JSON.parse(text) as { voices: Array<Record<string, unknown>>; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.voices.map((v) => v.voiceId)).toEqual(["pNInz6obpgDQGcFmaJgB", "AbCdEfGhIjKlMnOpQrSt"]);
    expect(body.voices[0]).toMatchObject({
      category: "premade",
      library: false,
      previewUrl: "https://cdn.test/a.mp3",
      traits: { gender: "male", age: "middle_aged", accent: "american", useCase: "narration" },
    });
    // A voice another account owns is marked; an http sample is not passed to the browser.
    expect(body.voices[1]).toMatchObject({ library: true, previewUrl: "", traits: { description: "Warm storyteller" } });
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("https://api.elevenlabs.io/v2/voices")).toBe(true);
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
  });

  it("serves a fresh read from the shared cache without another call or rate token", async () => {
    await GET();
    await GET();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(h.takes).toBe(1);
  });

  it("is rate limited per member before ElevenLabs is called", async () => {
    h.rate = "limited";
    const res = await GET();
    expect(res.status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("names a refused key without ElevenLabs' reason, and an outage as unreachable", async () => {
    upstream.mockResolvedValueOnce(json({ detail: { status: "quota_exceeded" } }, 401));
    let res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "elevenlabs_key_rejected" });

    upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
    res = await GET();
    expect(await res.json()).toEqual({ error: "elevenlabs_unreachable" });
  });
});
