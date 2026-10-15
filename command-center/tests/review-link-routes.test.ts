import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "ab".repeat(32);
const ID = "11111111-2222-4333-8444-555555555555";
const ORIGIN = "https://nightshift.test";
const PATH = "chan-a/vid-a.mp4";

const h = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  rpc: vi.fn(),
  userRpc: vi.fn(),
  rate: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon-key-for-tests",
  isSupabaseConfigured: true,
}));
// The visitor's client: anon key, no session.
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: (...a: unknown[]) => h.rpc(...a) }) }));
// The signed-in person's client.
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({ rpc: (...a: unknown[]) => h.userRpc(...a) }),
}));
vi.mock("@/lib/server/web-rate", async () => {
  const actual = await vi.importActual<typeof import("../lib/server/web-rate")>("../lib/server/web-rate");
  return { ...actual, takeWebRate: (...a: unknown[]) => h.rate(...a) };
});

const { resetAnonRate, viewReviewLink, safeRange } = await import("../lib/server/review-link");
const stream = await import("../app/r/[token]/video/route");
const links = await import("../app/api/review-links/route");
const one = await import("../app/api/review-links/[id]/route");

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const get = (token = TOKEN, headers: Record<string, string> = {}) =>
  stream.GET(new Request(`${ORIGIN}/r/${token}/video`, { headers }), ctx(token));

function upstream(status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 416 ? null : "VIDEOBYTES", {
    status,
    headers: { "content-type": "application/octet-stream", "content-length": "10", ...headers },
  });
}

beforeEach(() => {
  h.user = { id: "u1" };
  resetAnonRate();
  h.rpc.mockReset().mockResolvedValue({ data: PATH, error: null });
  h.userRpc.mockReset();
  h.rate.mockReset().mockResolvedValue("ok");
  h.fetch.mockReset().mockImplementation(async () => upstream());
  vi.stubGlobal("fetch", h.fetch);
});

describe("the stream", () => {
  it("serves the file the token names, as the anon role, with the token in the header the storage policy reads", async () => {
    const res = await get(TOKEN, { range: "bytes=0-9" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("VIDEOBYTES");
    expect(h.rpc).toHaveBeenCalledWith("review_link_object", { p_token: TOKEN });
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://project.supabase.test/storage/v1/object/authenticated/previews/chan-a/vid-a.mp4");
    expect(init.headers["x-review-token"]).toBe(TOKEN);
    expect(init.headers.apikey).toBe("anon-key-for-tests");
    expect(init.headers.authorization).toBe("Bearer anon-key-for-tests");
    expect(init.headers.range).toBe("bytes=0-9");
  });

  it("is a video that plays inline, is never cached by a shared cache, is not indexed, leaks no Referer and sends no file name or path", async () => {
    const res = await get();
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect([...res.headers.values()].join("\n")).not.toContain("vid-a");
  });

  it("passes a single range through and a partial answer back", async () => {
    h.fetch.mockImplementation(async () => upstream(206, { "content-range": "bytes 0-9/100", "content-length": "10" }));
    const res = await get(TOKEN, { range: "bytes=0-9" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/100");
  });

  it("drops a range that is not exactly one bytes=a-b", () => {
    expect(safeRange("bytes=0-9")).toBe("bytes=0-9");
    expect(safeRange("bytes=5-")).toBe("bytes=5-");
    expect(safeRange("bytes=-500")).toBe("bytes=-500");
    for (const bad of ["bytes=0-1,5-9", "bytes=-", "items=0-1", "bytes=0-1\r\nx-evil: 1", "", null]) expect(safeRange(bad as string | null)).toBeNull();
  });

  it("answers a malformed token with the same 404 and never reaches the database or storage", async () => {
    for (const bad of ["x", "AB".repeat(32), `${TOKEN}0`, "../../etc/passwd"]) {
      const res = await get(bad);
      expect(res.status).toBe(404);
    }
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("answers an unknown, expired or revoked token (the database says null) with 404 and fetches nothing", async () => {
    h.rpc.mockResolvedValue({ data: null, error: null });
    expect((await get()).status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("says 503 when the database did not answer, not 404 (a good link is not dead)", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    expect((await get()).status).toBe(503);
    h.rpc.mockRejectedValue(new Error("network"));
    expect((await get()).status).toBe(503);
  });

  it("reads storage's refusal (policy said no, file pruned) as the same 404, and its failure as 503", async () => {
    for (const status of [400, 401, 403, 404]) {
      h.fetch.mockImplementation(async () => upstream(status));
      expect((await get()).status, String(status)).toBe(404);
    }
    h.fetch.mockImplementation(async () => upstream(500));
    expect((await get()).status).toBe(503);
    h.fetch.mockRejectedValue(new Error("aborted"));
    expect((await get()).status).toBe(503);
  });

  it("refuses a path with a dot or empty segment instead of building a URL from it", async () => {
    for (const bad of ["chan-a/../vid.mp4", "./vid.mp4", "chan-a//vid.mp4", "/vid.mp4", "chan-a/."]) {
      h.fetch.mockClear();
      h.rpc.mockResolvedValue({ data: bad, error: null });
      expect((await get()).status, bad).toBe(404);
      expect(h.fetch).not.toHaveBeenCalled();
    }
  });

  it("asks Storage with a GET even for a HEAD (the policy serves only the read operations)", async () => {
    await stream.HEAD(new Request(`${ORIGIN}/r/${TOKEN}/video`, { method: "HEAD" }), ctx(TOKEN));
    expect((h.fetch.mock.calls[0] as [string, RequestInit])[1].method).toBe("GET");
  });

  it("encodes the object path and never builds a URL from the visitor's input", async () => {
    h.rpc.mockResolvedValue({ data: "chan a/vid#1?.mp4", error: null });
    await get();
    expect((h.fetch.mock.calls[0] as [string])[0]).toBe(
      "https://project.supabase.test/storage/v1/object/authenticated/previews/chan%20a/vid%231%3F.mp4",
    );
  });

  it("stops a loop from one address, and HEAD works without a body", async () => {
    for (let i = 0; i < 240; i++) expect((await get(TOKEN, { "x-forwarded-for": "9.9.9.9" })).status).toBe(200);
    const limited = await get(TOKEN, { "x-forwarded-for": "9.9.9.9" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await get(TOKEN, { "x-forwarded-for": "8.8.8.8" })).status).toBe(200);
    resetAnonRate();
    const head = await stream.HEAD(new Request(`${ORIGIN}/r/${TOKEN}/video`, { method: "HEAD" }), ctx(TOKEN));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("the page's question", () => {
  it("maps the database's answers and never says 'gone' for a backend that did not answer", async () => {
    h.rpc.mockResolvedValue({ data: { status: "ok", title: "T", expires_at: "2026-10-08T10:00:00Z", locale: "ru" }, error: null });
    expect(await viewReviewLink(TOKEN)).toEqual({ status: "ok", title: "T", expiresAt: "2026-10-08T10:00:00Z", locale: "ru" });
    h.rpc.mockResolvedValue({ data: { status: "gone" }, error: null });
    expect(await viewReviewLink(TOKEN)).toEqual({ status: "gone" });
    h.rpc.mockResolvedValue({ data: { status: "limited" }, error: null });
    expect(await viewReviewLink(TOKEN)).toEqual({ status: "limited" });
    for (const bad of [{ data: null, error: { message: "x" } }, { data: "weird", error: null }, { data: { status: "ok" }, error: null }]) {
      h.rpc.mockResolvedValue(bad);
      expect(await viewReviewLink(TOKEN)).toEqual({ status: "unavailable" });
    }
    h.rpc.mockRejectedValue(new Error("down"));
    expect(await viewReviewLink(TOKEN)).toEqual({ status: "unavailable" });
  });

  it("does not ask the database about a token of the wrong shape", async () => {
    h.rpc.mockClear();
    expect(await viewReviewLink("nope")).toEqual({ status: "gone" });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("making, listing and turning off (the signed-in person)", () => {
  const post = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
    links.POST(new Request(`${ORIGIN}/api/review-links`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  const made = { id: ID, token: TOKEN, expires_at: "2026-10-08T10:00:00Z" };

  it("needs a signed-in person, our own page, and a valid video and number of days; nothing is made before that", async () => {
    h.user = null;
    expect((await post({ video_id: "v1" })).status).toBe(401);
    h.user = { id: "u1" };
    expect((await post({ video_id: "v1" }, {})).status).toBe(403);
    expect((await post({ video_id: "v1" }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await post({ video_id: "v1" }, { origin: ORIGIN, "sec-fetch-site": "cross-site" })).status).toBe(403);
    for (const bad of [{}, { video_id: "a/b" }, { video_id: "v1", days: 8 }, { video_id: "v1", days: "7" }, { video_id: "x".repeat(65) }]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(h.userRpc).not.toHaveBeenCalled();
  });

  it("makes a link for a week by default and returns the address once, with the chosen language and no hash", async () => {
    h.userRpc.mockResolvedValue({ data: made, error: null });
    const res = await post({ video_id: "v1", locale: "RU" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: ID, expires_at: made.expires_at, url: `${ORIGIN}/r/${TOKEN}` });
    expect(h.userRpc).toHaveBeenCalledWith("create_review_link", { p_video_id: "v1", p_days: 7, p_locale: "ru" });
    h.userRpc.mockClear().mockResolvedValue({ data: made, error: null });
    await post({ video_id: "v1", days: 30, locale: "<x>" });
    expect(h.userRpc).toHaveBeenCalledWith("create_review_link", { p_video_id: "v1", p_days: 30, p_locale: null });
  });

  it("is rate limited per person before the database is asked", async () => {
    h.rate.mockResolvedValue("limited");
    const res = await post({ video_id: "v1" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(h.userRpc).not.toHaveBeenCalled();
    h.rate.mockResolvedValue("unavailable");
    expect((await post({ video_id: "v1" })).status).toBe(503);
    expect(h.userRpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "P0002", message: "not_found" }, 404, "not_found"],
    [{ code: "NS400", message: "no_preview" }, 409, "no_preview"],
    [{ code: "NS429", message: "limit_reached" }, 409, "limit_reached"],
    [{ code: "42501", message: "sign in first" }, 401, "unauthorized"],
    [{ code: "PGRST202", message: "Could not find the function" }, 503, "not_available"],
    [{ code: "XX000", message: "secret detail" }, 502, "failed"],
  ])("a database refusal %j is a fixed code, never its message", async (error, status, code) => {
    h.userRpc.mockResolvedValue({ data: null, error });
    const res = await post({ video_id: "v1" });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
  });

  it("refuses an answer that is not a token instead of showing a broken link", async () => {
    h.userRpc.mockResolvedValue({ data: { id: ID, token: "short", expires_at: made.expires_at }, error: null });
    expect((await post({ video_id: "v1" })).status).toBe(502);
  });

  it("lists a video's links through the person's own session, never a token", async () => {
    h.userRpc.mockResolvedValue({
      data: [{ id: ID, created_at: "2026-10-01T10:00:00Z", expires_at: "2026-10-08T10:00:00Z", revoked_at: null, views: 2, last_viewed_at: null, token_hash: "ff".repeat(32) }],
      error: null,
    });
    const res = await links.GET(new Request(`${ORIGIN}/api/review-links?video_id=v1`));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("ff");
    expect(JSON.parse(text).links).toHaveLength(1);
    expect(h.userRpc).toHaveBeenCalledWith("list_review_links", { p_video_id: "v1" });
    h.user = null;
    expect((await links.GET(new Request(`${ORIGIN}/api/review-links?video_id=v1`))).status).toBe(401);
    h.user = { id: "u1" };
    expect((await links.GET(new Request(`${ORIGIN}/api/review-links`))).status).toBe(400);
  });

  const del = (id: string, headers: Record<string, string> = { origin: ORIGIN }) =>
    one.DELETE(new Request(`${ORIGIN}/api/review-links/${id}`, { method: "DELETE", headers }), { params: Promise.resolve({ id }) });

  it("turns a link off: our own page, a uuid, and 'not found' for anything the database did not turn off", async () => {
    h.userRpc.mockResolvedValue({ data: true, error: null });
    expect((await del(ID)).status).toBe(200);
    expect(h.userRpc).toHaveBeenCalledWith("revoke_review_link", { p_id: ID });
    h.userRpc.mockClear().mockResolvedValue({ data: false, error: null });
    expect((await del(ID)).status).toBe(404);
    expect((await del("not-a-uuid")).status).toBe(400);
    expect((await del(ID, {})).status).toBe(403);
    h.user = null;
    expect((await del(ID)).status).toBe(401);
  });
});

describe("the page's headers", () => {
  it("is never cached, leaves no Referer and is not indexed, set by the config for the page and only the page", async () => {
    const nextConfig = (await import("../next.config")).default;
    const rules = (await nextConfig.headers?.()) ?? [];
    const rule = rules.find((r) => r.source === "/r/:token");
    expect(rule?.headers).toEqual(
      expect.arrayContaining([
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ]),
    );
  });

  it("robots.txt keeps crawlers off /r/", async () => {
    const robots = (await import("../app/robots")).default();
    const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    expect(rules.some((r) => [r.disallow].flat().includes("/r/"))).toBe(true);
  });
});

describe("no service key anywhere near a review link", () => {
  const root = join(__dirname, "..");
  for (const f of [
    "lib/server/review-link.ts",
    "lib/review-link.ts",
    "app/r/[token]/video/route.ts",
    "app/r/[token]/page.tsx",
    "app/api/review-links/route.ts",
    "app/api/review-links/[id]/route.ts",
    "components/videos/ShareReviewLink.tsx",
  ]) {
    it(f, () => {
      const src = readFileSync(join(root, f), "utf8");
      expect(src).not.toMatch(/SERVICE_KEY|SERVICE_ROLE|service_role|serviceKey|createAdminClient|createServiceClient/i);
    });
  }

  it("the page never prints the token, the object path or an approve / publish / download control", () => {
    const src = readFileSync(join(root, "app/r/[token]/page.tsx"), "utf8");
    expect(src).not.toMatch(/preview_path|review_link_object/);
    expect(src).not.toMatch(/<a\b|<button|<form|review_intents|createClient|onClick/);
    expect(src).toMatch(/robots: \{ index: false/);
    expect(src).toMatch(/nodownload/);
  });
});
