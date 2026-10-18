import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/marketing: the owner's four moves on the brand channel's posts, behind NIGHTSHIFT_MARKETING_POSTS.
 *
 * What would break without these: the route answering while the switch is not exactly `on`, a request from another site
 * reaching the session, a customer or a signed-out caller reaching the database function, a call made with anything but
 * the signed-in user's own client, a malformed body reaching Postgres, an approval that does not carry the hash the owner
 * saw, a refusal read as success, an action that sends or tests, and the database's own error text leaking to the browser.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "owner@a.uz" } as { id: string; email: string } | null,
  role: "owner" as string | null,
  guard: null as Response | null,
  rpc: vi.fn(),
  client: true,
  order: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => (h.client ? { rpc: h.rpc } : null),
}));
vi.mock("@/lib/auth/roles", () => ({ requireRole: async () => h.role }));
vi.mock("@/lib/server/admin-post-guard", () => ({ guardAdminPost: async () => h.guard }));

const route = (await import("../app/api/marketing/route")).POST;

const ORIGIN = "https://app.test";
const ID = "11111111-2222-3333-4444-555555555555";
const HASH = "ab".repeat(32);
const TEXTS = { uz: "Yangi funksiya.", ru: "Новая функция.", en: "A new feature." };
const REASON = "the channel is checked and the bot is admin";

const post = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`${ORIGIN}/api/marketing`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const BODIES = [
  { action: "edit", id: ID, texts: TEXTS },
  { action: "approve", id: ID, contentHash: HASH },
  { action: "reject", id: ID, reason: REASON },
  { action: "kill", kill: false, reason: REASON },
] as const;

beforeEach(() => {
  vi.unstubAllEnvs();
  h.user = { id: "u1", email: "owner@a.uz" };
  h.role = "owner";
  h.guard = null;
  h.client = true;
  h.rpc.mockReset().mockResolvedValue({ data: { ok: true }, error: null });
});

describe("while NIGHTSHIFT_MARKETING_POSTS is not exactly `on` the route does not exist", () => {
  it.each(BODIES)("%j answers 404 and never touches the database", async (body) => {
    for (const value of [undefined, "", "off", "0", "true", "1", "ON", "yes", "enabled"]) {
      vi.stubEnv("NIGHTSHIFT_MARKETING_POSTS", value ?? "");
      const res = await route(post(body));
      expect(res.status, `switch ${JSON.stringify(value)}`).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("an unset variable is off too", async () => {
    delete process.env.NIGHTSHIFT_MARKETING_POSTS;
    expect((await route(post(BODIES[1]))).status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("the owner-rpc switch does not open it: they are separate", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    vi.stubEnv("NIGHTSHIFT_MARKETING_POSTS", "");
    expect((await route(post(BODIES[1]))).status).toBe(404);
  });

  it("and the marketing switch does not open the owner routes", async () => {
    vi.stubEnv("NIGHTSHIFT_MARKETING_POSTS", "on");
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "");
    const grant = (await import("../app/api/owner/credits/grant/route")).POST;
    const res = await grant(
      new Request(`${ORIGIN}/api/owner/credits/grant`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ org: ID, credits: 5, reason: "welcome gift for the pilot", key: "g-0123456789abcdef" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("with the switch on", () => {
  beforeEach(() => vi.stubEnv("NIGHTSHIFT_MARKETING_POSTS", "on"));

  it.each(BODIES)("%j: a request from another site is refused before the session is read", async (body) => {
    for (const headers of [{}, { origin: "https://evil.example" }, { origin: "null" }, { origin: ORIGIN, "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      expect((await route(post(body, headers))).status).toBe(403);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(BODIES)("%j: signed out is 401, not an owner/admin is 403, the app second-factor gate is its own answer", async (body) => {
    h.user = null;
    expect((await route(post(body))).status).toBe(401);
    h.user = { id: "u2", email: "customer@a.uz" };
    h.role = null;
    expect((await route(post(body))).status).toBe(403);
    h.role = "owner";
    h.guard = Response.json({ error: "mfa_required" }, { status: 401 });
    const res = await route(post(body));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "mfa_required" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a body that is not JSON or not the right shape is a 400 and never reaches the database", async () => {
    expect((await route(post("{not json"))).status).toBe(400);
    expect((await route(post("[]"))).status).toBe(400);
    expect((await route(post({}))).status).toBe(400);
    expect((await route(post({ action: "approve", id: ID }))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(["send", "send_now", "resend", "test", "test_post", "post", "publish", "dispatch", "claim", "complete"])("an action named %j does not exist: 400, nothing called", async (action) => {
    const res = await route(post({ action, id: ID, contentHash: HASH }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "bad_request" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("approve sends the hash the owner SAW, exactly, as owner_marketing_approve's two named arguments, as the signed-in user", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, already: false, id: ID, status: "approved", content_hash: HASH, expires_at: "2026-10-21T10:00:00Z" }, error: null });
    const res = await route(post({ action: "approve", id: ID, contentHash: HASH }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("owner_marketing_approve", { p_id: ID, p_content_hash: HASH });
  });

  it("an extra field in the body is dropped, never forwarded", async () => {
    await route(post({ action: "approve", id: ID, contentHash: HASH, p_id: "someone-else", is_admin: true, service_key: "x", status: "sent" }));
    expect(Object.keys(h.rpc.mock.calls[0][1]).sort()).toEqual(["p_content_hash", "p_id"]);
    expect(h.rpc.mock.calls[0][1].p_id).toBe(ID);
  });

  it("edit, reject and kill call their own function with their own arguments", async () => {
    await route(post({ action: "edit", id: ID, texts: { uz: " a ", ru: "б", en: "c" } }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_marketing_edit", { p_id: ID, p_texts: { uz: "a", ru: "б", en: "c" } });
    await route(post({ action: "reject", id: ID, reason: REASON }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_marketing_reject", { p_id: ID, p_reason: REASON });
    await route(post({ action: "kill", kill: true }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_marketing_kill", { p_kill: true, p_reason: null });
    await route(post({ action: "kill", kill: false, reason: REASON }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_marketing_kill", { p_kill: false, p_reason: REASON });
    expect(h.rpc).toHaveBeenCalledTimes(4);
  });

  describe("every refusal of the database reaches the browser as a code with its figures", () => {
    it.each([
      ["mfa_required", 401],
      ["rate_limited", 429],
      ["poster_off", 422],
      ["content_changed", 422],
      ["cap_full", 422],
      ["expired", 422],
      ["bad_texts", 422],
      ["facts_stale", 422],
      ["not_draft", 422],
      ["reason_required", 422],
    ])("%s", async (code, status) => {
      h.rpc.mockResolvedValue({
        data: { ok: false, error: code, message: "English sentence from the database", content_hash: "f".repeat(64), used_7d: 1, approved_waiting: 1, max_per_7d: 2 },
        error: null,
      });
      const res = await route(post({ action: "approve", id: ID, contentHash: HASH }));
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, error: code, used_7d: 1, max_per_7d: 2 });
      expect(JSON.stringify(body)).not.toContain("English sentence");
    });
  });

  describe("a database error is an answer, never the database's own text", () => {
    it.each([
      [{ code: "42501", message: "only a platform owner or admin may do this" }, 403, "forbidden"],
      [{ code: "PGRST202", message: "Could not find the function public.owner_marketing_approve" }, 503, "migration_missing"],
      [{ code: "XX000", message: "connection to db.internal.example:5432 refused" }, 502, "rpc_failed"],
    ])("%j", async (error, status, code) => {
      h.rpc.mockResolvedValue({ data: null, error });
      const res = await route(post({ action: "approve", id: ID, contentHash: HASH }));
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: code });
      expect(text).not.toContain("internal");
      expect(text).not.toContain("platform owner");
    });

    it("a thrown error, an answer that is not a document and no client at all", async () => {
      h.rpc.mockRejectedValue(new Error("socket hang up"));
      expect((await route(post(BODIES[1]))).status).toBe(502);
      h.rpc.mockReset().mockResolvedValue({ data: "ok", error: null });
      const res = await route(post(BODIES[1]));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: "bad_reply" });
      h.client = false;
      expect((await route(post(BODIES[1]))).status).toBe(503);
    });
  });
});

describe("the order of the route's checks", () => {
  it("origin, then the switch, then who is asking, then the role, then the app second factor, then the body, then the database", () => {
    // The route is a thin wrapper over the shared owner handler (lib/server/owner-rpc.ts): it must hand it the marketing
    // switch and the marketing parser, so the stack and its order are the owner routes' own.
    const routeSrc = readFileSync(join(__dirname, "..", "app", "api", "marketing", "route.ts"), "utf8");
    expect(routeSrc).toContain("requireSameOrigin(");
    expect(routeSrc).toContain("handleOwnerPost(request, parseMarketing, marketingPostsOn)");
    const src = readFileSync(join(__dirname, "..", "lib", "server", "owner-rpc.ts"), "utf8");
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at("rejectCrossOrigin(request)"),
      at("if (!flagOn())"),
      at("await getUser()"),
      at('await requireRole("admin")'),
      at("await guardAdminPost(request, user)"),
      at("await parseJsonCapped(request)"),
      at("await supabase.rpc("),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("the owner routes still gate on their own switch by default", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "server", "owner-rpc.ts"), "utf8");
    expect(src).toContain("flagOn: () => boolean = ownerRpcOn");
    for (const f of ["credits/grant", "credits/reverse", "prices", "team"]) {
      const r = readFileSync(join(__dirname, "..", "app", "api", "owner", f, "route.ts"), "utf8");
      expect(r, f).toMatch(/handleOwnerPost\(request, parse\w+\)\)/);
    }
  });
});

describe("the route reads the switch literally, per call", () => {
  it("names process.env.NIGHTSHIFT_MARKETING_POSTS (tests/test_deploy_self_host.py scans for exactly that)", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "server", "marketing.ts"), "utf8");
    expect(src).toContain("process.env.NIGHTSHIFT_MARKETING_POSTS");
    expect(src).toContain("process.env.MARKETING_TELEGRAM_CHAT");
    expect(src).toContain("process.env.APP_ORIGIN");
  });
});
