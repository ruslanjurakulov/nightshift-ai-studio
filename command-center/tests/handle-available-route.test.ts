import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rpc: vi.fn(async (_fn: string, _args?: unknown) => ({ data: true as unknown, error: null as unknown })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://project.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));

const { POST } = await import("@/app/api/handle-available/route");
const { HANDLE_CHECK_LIMIT, resetHandleChecks } = await import("@/lib/server/handle-check");

function ask(body: unknown, headers: Record<string, string> = {}, raw?: string) {
  return POST(
    new Request("https://nightshift.test/api/handle-available", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://nightshift.test", "x-forwarded-for": "203.0.113.7", ...headers },
      body: raw ?? JSON.stringify(body),
    }),
  );
}
const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;

beforeEach(() => {
  h.rpc.mockReset().mockResolvedValue({ data: true, error: null });
  resetHandleChecks();
});

describe("POST /api/handle-available (the sign-up form's check)", () => {
  it("answers one boolean and nothing else", async () => {
    const res = await ask({ handle: "@Ana.K" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ available: true });
    expect(h.rpc).toHaveBeenCalledWith("handle_available_public", { p_handle: "ana.k" });
    h.rpc.mockResolvedValue({ data: false, error: null });
    expect(await json(await ask({ handle: "taken.one" }))).toEqual({ available: false });
  });

  it("is never cached", async () => {
    expect((await ask({ handle: "ana.k" })).headers.get("cache-control")).toBe("no-store");
  });

  it("answers false for a malformed or reserved handle without asking the database", async () => {
    for (const handle of ["", "ab", "a..b", "Ana K", "admin", "nightshift_team", "a.d.m.i.n", "x".repeat(60)]) {
      expect(await json(await ask({ handle }))).toEqual({ available: false });
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("says 'unknown' (null), never 'free' or 'taken', when the database cannot say", async () => {
    h.rpc.mockResolvedValue({ data: null, error: null });
    expect(await json(await ask({ handle: "ana.k" }))).toEqual({ available: null });
    h.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.handle_available_public" } });
    const res = await json(await ask({ handle: "ana.k" }));
    expect(res).toEqual({ available: null });
    expect(JSON.stringify(res)).not.toMatch(/PGRST|function/);
    h.rpc.mockRejectedValue(new Error("network"));
    expect(await json(await ask({ handle: "ana.k" }))).toEqual({ available: null });
    h.rpc.mockResolvedValue({ data: "yes", error: null });
    expect(await json(await ask({ handle: "ana.k" }))).toEqual({ available: null });
  });

  it("our own page only: another site, or no Origin, learns nothing and costs the database nothing", async () => {
    for (const headers of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }, { origin: "" }] as Record<string, string>[]) {
      const res = await ask({ handle: "ana.k" }, headers);
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ error: "forbidden" });
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("limits each address, and the limit does not touch another address", async () => {
    for (let i = 0; i < HANDLE_CHECK_LIMIT.max; i++) expect((await ask({ handle: "ana.k" })).status).toBe(200);
    const over = await ask({ handle: "ana.k" });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(await json(over)).toEqual({ error: "rate_limited" });
    expect((await ask({ handle: "ana.k" }, { "x-forwarded-for": "198.51.100.9" })).status).toBe(200);
  });

  it("refuses a body that is not JSON or is too big", async () => {
    expect((await ask(null, {}, "not json")).status).toBe(400);
    expect((await ask(null, { "content-length": "5000" }, JSON.stringify({ handle: "ana.k" }))).status).toBe(400);
    expect(await json(await ask({ handle: 5 }))).toEqual({ available: false });
  });
});
