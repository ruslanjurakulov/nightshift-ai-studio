import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://x.supabase.co/", SUPABASE_ANON_KEY: "anon" }));
const { googleEnabledOnServer, GOOGLE_SETTINGS_REVALIDATE_SECONDS } = await import("@/lib/server/google-enabled");
const { fetchGoogleEnabled } = await import("@/lib/google-signin");

afterEach(() => vi.unstubAllGlobals());
const answer = (body: unknown, ok = true) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => body })));

describe("googleEnabledOnServer", () => {
  it("asks the project's settings with the anon key, cached for a short time and cut off by a timeout", async () => {
    answer({ external: { google: true } });
    expect(await googleEnabledOnServer()).toBe(true);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://x.supabase.co/auth/v1/settings");
    expect(init.headers).toEqual({ apikey: "anon" });
    expect(init.next).toEqual({ revalidate: GOOGLE_SETTINGS_REVALIDATE_SECONDS });
    expect(GOOGLE_SETTINGS_REVALIDATE_SECONDS).toBeLessThanOrEqual(120);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["google off", { external: { google: false } }, true],
    ["an error status", { external: { google: true } }, false],
    ["no list", {}, true],
  ])("fails closed on %s", async (_n, body, ok) => {
    answer(body, ok);
    expect(await googleEnabledOnServer()).toBe(false);
  });

  it("fails closed when the request throws or times out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new DOMException("timeout", "TimeoutError"))));
    expect(await googleEnabledOnServer()).toBe(false);
  });

  it("asks nobody without a configured project", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(await fetchGoogleEnabled("", "k")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
