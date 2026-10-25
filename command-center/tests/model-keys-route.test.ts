import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_KEY_PROVIDERS } from "../lib/model-keys";
import { json, startLoopback, type Loopback } from "./helpers/loopbackVendor";

/**
 * POST /api/owner/model-keys: the owner pastes a vendor key; it is checked with the vendor and stored only if the vendor accepted it.
 *
 * What would break without these: the route answering while the switch is off, a non-owner (an administrator, a customer, a stranger)
 * reaching the vendor or the database, an unknown vendor name reaching either, a vendor with no free check being called, a rejected or
 * unreachable check storing the key, a "verified" stored for a key the vendor did not accept, and the key (or the last four characters) coming
 * back in a response, a header, a log line or an error. The vendor here is a loopback server: no network, no real key, no paid call.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  user: { id: "u1234567-aaaa", email: "owner@a.uz" } as { id: string; email: string } | null,
  role: "owner" as string | null,
  roleAsked: [] as string[],
  guard: null as Response | null,
  recent: null as Response | null,
  rpc: vi.fn(),
  client: true,
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => (h.client ? { rpc: h.rpc } : null),
}));
vi.mock("@/lib/auth/roles", () => ({
  requireRole: async (min: string) => {
    h.roleAsked.push(min);
    return h.role;
  },
}));
vi.mock("@/lib/server/admin-post-guard", () => ({ guardAdminPost: async () => h.guard }));
vi.mock("@/lib/security/admin-mfa-server", () => ({ requireRecentMfa: async () => h.recent }));

const { POST, ...others } = await import("../app/api/owner/model-keys/route");

const ORIGIN = "https://app.test";
const KEY = "sk-test-AbCdEf0123456789-wxyz";
const PAIR = "AKaaaaaaaaaaaaaaaa:SKbbbbbbbbbbbbbbbbbbbb";
const HOSTS = MODEL_KEY_PROVIDERS.flatMap((p) => (p.strategy.kind === "http" ? [new URL(p.strategy.origin).host] : []));

let vendor: Loopback;
const captured: string[] = [];
const spies = ["log", "info", "warn", "error", "debug"].map((m) =>
  vi.spyOn(console, m as "log").mockImplementation((...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }),
);

beforeAll(async () => {
  vendor = await startLoopback(HOSTS);
});
afterAll(async () => {
  await vendor.close();
  spies.forEach((s) => s.mockRestore());
});

let uid = 0;
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NIGHTSHIFT_MODEL_KEYS", "on");
  vi.stubGlobal("fetch", vendor.fetch);
  // a fresh person each test, so the per-person rate limit of one test never reaches the next
  h.user = { id: `u${String(++uid).padStart(7, "0")}-aaaa`, email: "owner@a.uz" };
  h.role = "owner";
  h.roleAsked = [];
  h.guard = null;
  h.recent = null;
  h.client = true;
  h.rpc.mockReset().mockResolvedValue({ data: { ok: true, provider: "openai", status: "verified", replaced: false }, error: null });
  vendor.seen.length = 0;
  vendor.asked.length = 0;
  vendor.answer(json(200, { data: [{ id: "m" }] }));
  captured.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

const post = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`${ORIGIN}/api/owner/model-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const save = (over: Record<string, unknown> = {}) => ({ action: "save", provider: "openai", key: KEY, ...over });

/** Everything the caller could see or a log could hold, as one string. */
async function everything(res: Response): Promise<string> {
  const text = await res.clone().text();
  const heads = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  return [text, heads, ...captured].join("\n");
}
function expectNoKey(blob: string) {
  for (const needle of [KEY, "wxyz", "sk-test", "AbCdEf", "AKaaaa", "SKbbbb"]) expect(blob, needle).not.toContain(needle);
}

describe("the switch", () => {
  it("is off by default: 404, and neither the vendor nor the database is touched", async () => {
    for (const v of [undefined, "", "off", "0", "true", "1", "yes"]) {
      vi.stubEnv("NIGHTSHIFT_MODEL_KEYS", v ?? "");
      const res = await POST(post(save()));
      expect(res.status, JSON.stringify(v)).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(h.rpc).not.toHaveBeenCalled();
    expect(vendor.seen).toHaveLength(0);
  });

  it("has no GET: only POST is exported", () => {
    expect(Object.keys(others).filter((k) => ["GET", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
  });
});

describe("who may call it", () => {
  it("refuses a request that did not come from our own page, before anything else", async () => {
    for (const headers of [{ origin: "https://evil.example" }, {}, { origin: "null" }]) {
      const res = await POST(post(save(), headers as Record<string, string>));
      expect(res.status).toBe(403);
    }
    expect(h.rpc).not.toHaveBeenCalled();
    expect(vendor.seen).toHaveLength(0);
    expect(h.roleAsked).toEqual([]);
  });

  it("answers 401 to a signed-out caller", async () => {
    h.user = null;
    const res = await POST(post(save()));
    expect(res.status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(vendor.seen).toHaveLength(0);
  });

  it("answers 403 to anyone who is not the platform OWNER (an administrator, a customer, a stranger), and asks for the owner role", async () => {
    h.role = null;
    for (const body of [save(), { action: "remove", provider: "openai" }]) {
      const res = await POST(post(body));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    expect(h.roleAsked).toEqual(["owner", "owner"]);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(vendor.seen).toHaveLength(0);
    expectNoKey(captured.join("\n"));
  });

  it("passes the second-factor refusals through, before the body is read", async () => {
    h.guard = new Response(JSON.stringify({ error: "mfa_required" }), { status: 401 });
    expect((await POST(post(save()))).status).toBe(401);
    h.guard = null;
    h.recent = new Response(JSON.stringify({ error: "mfa_recent_required" }), { status: 401 });
    expect((await POST(post(save()))).status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(vendor.seen).toHaveLength(0);
  });

  it("is rate limited per person, and a limited request reaches neither the vendor nor the database", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 25; i += 1) codes.push((await POST(post(save()))).status);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429, 429, 429, 429]);
    expect(vendor.seen).toHaveLength(20);
    expect(h.rpc).toHaveBeenCalledTimes(20);
    // another person is not limited by this one
    h.user = { id: "someone-else-0001", email: "o2@a.uz" };
    expect((await POST(post(save()))).status).toBe(200);
  });
});

describe("what it refuses before it calls anyone", () => {
  it("an unknown vendor name, in any spelling", async () => {
    for (const provider of ["nonesuch", "OpenAI", "openai ", "../openai", "unassigned-video-vendor", "__proto__", "", null, 7, {}]) {
      const res = await POST(post(save({ provider })));
      expect(res.status, String(provider)).toBe(400);
      expect((await res.json()).error).toBe("unknown_provider");
    }
    expect(h.rpc).not.toHaveBeenCalled();
    expect(vendor.seen).toHaveLength(0);
  });

  it("a body that is not what the route takes, and a key that is not one printable token, without echoing it", async () => {
    const cases: [unknown, string][] = [
      ["not json at all {", "bad_request"],
      [[], "bad_request"],
      [{ action: "drop_tables", provider: "openai" }, "bad_request"],
      [save({ key: "short" }), "bad_key"],
      [save({ key: "has spaces inside the key 0123456789" }), "bad_key"],
      [save({ key: "sk-quote'inside-0123456789abcd" }), "bad_key"],
      [save({ key: "x".repeat(600) }), "bad_key"],
      [save({ key: undefined }), "bad_key"],
    ];
    for (const [body, code] of cases) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      const text = await res.clone().text();
      expect(JSON.parse(text).error).toBe(code);
      // nothing but the verdict word and, for a key, our reason word
      expect(Object.keys(JSON.parse(text)).filter((k) => !["ok", "error", "reason"].includes(k))).toEqual([]);
      expect(JSON.parse(text).ok).toBe(false);
      expect(text).not.toContain("quote'inside");
      expect(text).not.toContain("has spaces");
    }
    expect(h.rpc).not.toHaveBeenCalled();
    expect(vendor.seen).toHaveLength(0);
  });

  it("a body over the size cap", async () => {
    const res = await POST(post(save({ key: KEY, pad: "p".repeat(40_000) })));
    expect(res.status).toBe(400);
    expect(vendor.seen).toHaveLength(0);
  });
});

describe("a vendor with a free check", () => {
  it("verified: one GET to the vendor's own host, then the key is stored as `verified`; the answer is a state word", async () => {
    const res = await POST(post(save()));
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual({ ok: true, state: "verified", stored: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(vendor.asked).toEqual(["https://api.openai.com/v1/models"]);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("owner_model_key_store", { p_provider: "openai", p_secret: KEY, p_status: "verified" });
    expectNoKey(await everything(res));
  });

  it("rejected (401/403): the vendor refused it, so nothing is stored and the stored key is not touched", async () => {
    for (const status of [401, 403]) {
      vendor.answer(json(status, { error: `Incorrect API key provided: ${KEY}` }, { "x-echo": KEY }));
      const res = await POST(post(save()));
      expect(res.status).toBe(200);
      expect(await res.clone().json()).toEqual({ ok: true, state: "rejected", stored: false });
      expectNoKey(await everything(res));
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("could not reach (5xx, 429, a dropped connection, a timeout, a page that is not the documented answer): nothing is stored", async () => {
    const cases: [() => void, string][] = [
      [() => vendor.answer(json(500, {})), "vendor_error"],
      [() => vendor.answer(json(503, {})), "vendor_error"],
      [() => vendor.answer(json(429, {})), "rate_limited"],
      [() => vendor.answer((_q, r) => r.socket?.destroy()), "network"],
      [() => vendor.answer(json(200, "<html>captive portal</html>")), "unexpected_response"],
    ];
    for (const [arrange, reason] of cases) {
      arrange();
      const res = await POST(post(save()));
      expect(await res.clone().json()).toEqual({ ok: true, state: "unreachable", reason, stored: false });
      expectNoKey(await everything(res));
    }
    vi.stubGlobal("fetch", (() => Promise.reject(new DOMException("The operation timed out", "TimeoutError"))) as unknown as typeof fetch);
    const res = await POST(post(save()));
    expect(await res.json()).toEqual({ ok: true, state: "unreachable", reason: "timeout", stored: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("checks the right vendor's host for each vendor, and only that one", async () => {
    const seenHosts: string[] = [];
    for (const p of MODEL_KEY_PROVIDERS) {
      if (p.strategy.kind !== "http") continue;
      vendor.asked.length = 0;
      vendor.answer(json(200, p.strategy.expect.kind === "array" ? [] : p.strategy.expect.kind === "field" ? { [p.strategy.expect.name]: p.strategy.expect.type === "array" ? [] : p.strategy.expect.type === "number" ? 1 : {} } : {}));
      const res = await POST(post(save({ provider: p.id })));
      expect((await res.json()).state, p.id).toBe("verified");
      expect(vendor.asked, p.id).toHaveLength(1);
      seenHosts.push(new URL(vendor.asked[0]).host);
      expect(new URL(vendor.asked[0]).host, p.id).toBe(new URL(p.strategy.origin).host);
    }
    expect(new Set(seenHosts).size).toBe(seenHosts.length);
  });
});

describe("a vendor with no free check", () => {
  it("needs the owner's explicit confirmation, and without it nothing is sent or stored", async () => {
    const res = await POST(post({ action: "save", provider: "kling", key: PAIR }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirm_required");
    expect(h.rpc).not.toHaveBeenCalled();
    expect(vendor.asked).toEqual([]);
  });

  it("with the confirmation it stores `format_only` and never calls out", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, provider: "kling", status: "format_only", replaced: false }, error: null });
    const spy = vi.fn(() => {
      throw new Error("a request was made");
    });
    vi.stubGlobal("fetch", spy);
    for (const [provider, key] of [["kling", PAIR], ["bytedance", "ark-0123456789abcdef-ghijkl"]] as const) {
      const res = await POST(post({ action: "save", provider, key, confirm_format_only: true }));
      expect(await res.clone().json()).toEqual({ ok: true, state: "format_only", stored: true });
      expect(h.rpc).toHaveBeenLastCalledWith("owner_model_key_store", { p_provider: provider, p_secret: key, p_status: "format_only" });
      expectNoKey(await everything(res));
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("a confirmation sent for a vendor that HAS a check does not skip the check", async () => {
    vendor.answer(json(401, {}));
    const res = await POST(post(save({ confirm_format_only: true })));
    expect((await res.json()).state).toBe("rejected");
    expect(vendor.seen).toHaveLength(1);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("the database half", () => {
  it("a refusal from the owner function reaches the caller as a code, with the database's own words dropped", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, error: "owner_required", message: `Only the owner. ${KEY}` }, error: null });
    const res = await POST(post(save()));
    expect(res.status).toBe(403);
    expect(await res.clone().json()).toEqual({ ok: false, error: "forbidden" });
    expectNoKey(await everything(res));
  });

  it("an error from the database is a code: its message is never forwarded, even when it quotes the key", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: `could not store ${KEY}` } });
    const res = await POST(post(save()));
    expect(res.status).toBe(502);
    expect(await res.clone().json()).toEqual({ ok: false, error: "rpc_failed" });
    expectNoKey(await everything(res));
  });

  it("an rpc that throws is a code, and the log line has the key taken out", async () => {
    h.rpc.mockRejectedValue(new Error(`socket closed while sending ${KEY}`));
    const res = await POST(post(save()));
    expect(res.status).toBe(502);
    expectNoKey(await everything(res));
  });

  it("migration 0123 not applied reads as 503 migration_missing", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "x" } });
    const res = await POST(post(save()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("migration_missing");
  });

  it("no database configured is 503, and the vendor was still the only thing asked (nothing is stored)", async () => {
    h.client = false;
    const res = await POST(post(save()));
    expect(res.status).toBe(503);
    expect(vendor.seen).toHaveLength(0);
  });

  it("remove calls the owner function with the vendor only", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, provider: "openai", removed: true }, error: null });
    const res = await POST(post({ action: "remove", provider: "openai" }));
    expect(await res.json()).toEqual({ ok: true, state: "not_set" });
    expect(h.rpc).toHaveBeenCalledWith("owner_model_key_remove", { p_provider: "openai" });
    expect(vendor.seen).toHaveLength(0);
  });
});

describe("what is written to the log", () => {
  it("one line per attempt with a user-id prefix, the vendor and the outcome, and nothing about the key", async () => {
    await POST(post(save()));
    vendor.answer(json(401, {}));
    await POST(post(save()));
    const lines = captured.filter((l) => l.startsWith("[model-key]"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[model-key\] user=u\d{7} provider=openai outcome=verified$/);
    expect(lines[1]).toMatch(/outcome=rejected$/);
    expectNoKey(captured.join("\n"));
  });
});
