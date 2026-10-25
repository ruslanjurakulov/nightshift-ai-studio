import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_KEY_PROVIDERS } from "../lib/model-keys";
import { json, startLoopback, type Loopback } from "./helpers/loopbackVendor";

/**
 * POST /api/owner/model-keys: the owner pastes a vendor key; the server checks it with the vendor and FORGETS it.
 *
 * What would break without these: the route answering while the switch is off, a non-owner (an administrator, a customer, a stranger)
 * reaching the vendor, an unknown vendor name reaching it, a vendor with no free check being called, "verified" for a key the vendor did not
 * accept, anything being PERSISTED (a database client created, an rpc, a cookie, a second request), and the key (or any fragment of it)
 * coming back in a response, a header, a log line or an error. The vendor here is a loopback server: no network, no real key, no paid call.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  user: { id: "u1234567-aaaa", email: "owner@a.uz" } as { id: string; email: string } | null,
  role: "owner" as string | null,
  roleAsked: [] as string[],
  guard: null as Response | null,
  recent: null as Response | null,
  /** Any database client the route could have asked for. It must never be. */
  createClient: vi.fn(async () => {
    throw new Error("the route must not create a database client");
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: h.createClient,
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
  h.createClient.mockClear();
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
const verify = (over: Record<string, unknown> = {}) => ({ action: "verify", provider: "openai", key: KEY, ...over });

/** Everything the caller could see or a log could hold, as one string. */
async function everything(res: Response): Promise<string> {
  const text = await res.clone().text();
  const heads = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  return [text, heads, ...captured].join("\n");
}
function expectNoKey(blob: string) {
  for (const needle of [KEY, "wxyz", "sk-test", "AbCdEf", "AKaaaa", "SKbbbb", "0123456789"]) expect(blob, needle).not.toContain(needle);
}

describe("the switch", () => {
  it("is off by default: 404, and the vendor is not touched", async () => {
    for (const v of [undefined, "", "off", "0", "true", "1", "yes"]) {
      vi.stubEnv("NIGHTSHIFT_MODEL_KEYS", v ?? "");
      const res = await POST(post(verify()));
      expect(res.status, JSON.stringify(v)).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(vendor.seen).toHaveLength(0);
  });

  it("has no GET: only POST is exported", () => {
    expect(Object.keys(others).filter((k) => ["GET", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
  });
});

describe("who may call it", () => {
  it("refuses a request that did not come from our own page, before anything else", async () => {
    for (const headers of [{ origin: "https://evil.example" }, {}, { origin: "null" }]) {
      expect((await POST(post(verify(), headers as Record<string, string>))).status).toBe(403);
    }
    expect(vendor.seen).toHaveLength(0);
    expect(h.roleAsked).toEqual([]);
  });

  it("answers 401 to a signed-out caller", async () => {
    h.user = null;
    expect((await POST(post(verify()))).status).toBe(401);
    expect(vendor.seen).toHaveLength(0);
  });

  it("answers 403 to anyone who is not the platform OWNER (an administrator, a customer, a stranger), and asks for the owner role", async () => {
    h.role = null;
    const res = await POST(post(verify()));
    expect(res.status).toBe(403);
    expect(await res.clone().json()).toEqual({ error: "forbidden" });
    expect(h.roleAsked).toEqual(["owner"]);
    expect(vendor.seen).toHaveLength(0);
    expectNoKey(await everything(res));
  });

  it("passes the second-factor refusals through, before the body is read", async () => {
    h.guard = new Response(JSON.stringify({ error: "mfa_required" }), { status: 401 });
    expect((await POST(post(verify()))).status).toBe(401);
    h.guard = null;
    h.recent = new Response(JSON.stringify({ error: "mfa_recent_required" }), { status: 401 });
    expect((await POST(post(verify()))).status).toBe(401);
    expect(vendor.seen).toHaveLength(0);
  });

  it("is rate limited per person, and a limited request never reaches the vendor", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 25; i += 1) codes.push((await POST(post(verify()))).status);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429, 429, 429, 429]);
    expect(vendor.seen).toHaveLength(20);
    // another person is not limited by this one
    h.user = { id: "someone-else-0001", email: "o2@a.uz" };
    expect((await POST(post(verify()))).status).toBe(200);
  });
});

describe("what it refuses before it calls anyone", () => {
  it("an unknown vendor name, in any spelling", async () => {
    for (const provider of ["nonesuch", "OpenAI", "openai ", "../openai", "unassigned-video-vendor", "__proto__", "", null, 7, {}]) {
      const res = await POST(post(verify({ provider })));
      expect(res.status, String(provider)).toBe(400);
      expect((await res.json()).error).toBe("unknown_provider");
    }
    expect(vendor.seen).toHaveLength(0);
  });

  it("an action other than verify (there is no save, no store and no remove)", async () => {
    for (const action of ["save", "remove", "store", "delete", "", undefined]) {
      const res = await POST(post({ ...verify(), action }));
      expect(res.status, String(action)).toBe(400);
      expect((await res.json()).error).toBe("bad_request");
    }
    expect(vendor.seen).toHaveLength(0);
  });

  it("a body that is not what the route takes, and a key that is not one printable token, without echoing it", async () => {
    const cases: [unknown, string][] = [
      ["not json at all {", "bad_request"],
      [[], "bad_request"],
      [verify({ key: "short" }), "bad_key"],
      [verify({ key: "has spaces inside the key 0123456789" }), "bad_key"],
      [verify({ key: "sk-quote'inside-0123456789abcd" }), "bad_key"],
      [verify({ key: "x".repeat(600) }), "bad_key"],
      [verify({ key: undefined }), "bad_key"],
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
    expect(vendor.seen).toHaveLength(0);
  });

  it("a body over the size cap", async () => {
    const res = await POST(post(verify({ pad: "p".repeat(40_000) })));
    expect(res.status).toBe(400);
    expect(vendor.seen).toHaveLength(0);
  });
});

describe("a vendor with a free check", () => {
  it("verified: one GET to the vendor's own host, and an answer that is a state word and a time", async () => {
    const res = await POST(post(verify()));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(Object.keys(body).sort()).toEqual(["at", "ok", "state"]);
    expect(body).toMatchObject({ ok: true, state: "verified" });
    expect(new Date(body.at).toISOString()).toBe(body.at);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(vendor.asked).toEqual(["https://api.openai.com/v1/models"]);
    expectNoKey(await everything(res));
  });

  it("rejected (401/403): the vendor refused it", async () => {
    for (const status of [401, 403]) {
      vendor.answer(json(status, { error: `Incorrect API key provided: ${KEY}` }, { "x-echo": KEY }));
      const res = await POST(post(verify()));
      expect(res.status).toBe(200);
      expect(await res.clone().json()).toMatchObject({ ok: true, state: "rejected" });
      expectNoKey(await everything(res));
    }
  });

  it("could not reach (5xx, 429, a dropped connection, a timeout, a page that is not the documented answer)", async () => {
    const cases: [() => void, string][] = [
      [() => vendor.answer(json(500, {})), "vendor_error"],
      [() => vendor.answer(json(503, {})), "vendor_error"],
      [() => vendor.answer(json(429, {})), "rate_limited"],
      [() => vendor.answer((_q, r) => r.socket?.destroy()), "network"],
      [() => vendor.answer(json(200, "<html>captive portal</html>")), "unexpected_response"],
    ];
    for (const [arrange, reason] of cases) {
      arrange();
      const res = await POST(post(verify()));
      expect(await res.clone().json()).toMatchObject({ ok: true, state: "could_not_reach", reason });
      expectNoKey(await everything(res));
    }
    vi.stubGlobal("fetch", (() => Promise.reject(new DOMException("The operation timed out", "TimeoutError"))) as unknown as typeof fetch);
    const res = await POST(post(verify()));
    expect(await res.json()).toMatchObject({ ok: true, state: "could_not_reach", reason: "timeout" });
  });

  it("an error thrown by the transport that quotes the key is turned into a code: the key is in no answer and no log line", async () => {
    vi.stubGlobal("fetch", (() => {
      throw new Error(`connect failed while sending Authorization: Bearer ${KEY}`);
    }) as unknown as typeof fetch);
    const res = await POST(post(verify()));
    expect(await res.clone().json()).toMatchObject({ ok: true, state: "could_not_reach", reason: "network" });
    expectNoKey(await everything(res));
  });

  it("checks the right vendor's host for each vendor, and only that one", async () => {
    const seenHosts: string[] = [];
    for (const p of MODEL_KEY_PROVIDERS) {
      if (p.strategy.kind !== "http") continue;
      vendor.asked.length = 0;
      const e = p.strategy.expect;
      vendor.answer(json(200, e.kind === "array" ? [] : e.kind === "field" ? { [e.name]: e.type === "array" ? [] : e.type === "number" ? 1 : {} } : {}));
      const res = await POST(post(verify({ provider: p.id })));
      expect((await res.json()).state, p.id).toBe("verified");
      expect(vendor.asked, p.id).toHaveLength(1);
      seenHosts.push(new URL(vendor.asked[0]).host);
      expect(new URL(vendor.asked[0]).host, p.id).toBe(new URL(p.strategy.origin).host);
    }
    expect(new Set(seenHosts).size).toBe(seenHosts.length);
  });
});

describe("a vendor with no free check", () => {
  it("is not called at all: only the shape is checked, and the answer says format_only", async () => {
    const spy = vi.fn(() => {
      throw new Error("a request was made");
    });
    vi.stubGlobal("fetch", spy);
    for (const [provider, key] of [["kling", PAIR], ["bytedance", "ark-0123456789abcdef-ghijkl"]] as const) {
      const res = await POST(post({ action: "verify", provider, key }));
      expect(res.status).toBe(200);
      expect(await res.clone().json()).toMatchObject({ ok: true, state: "format_only" });
      const blob = await everything(res);
      expect(blob).not.toContain(key);
      expect(blob).not.toContain(key.split(":").pop() as string);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("a key of the wrong shape is refused for these too", async () => {
    const res = await POST(post({ action: "verify", provider: "kling", key: "AKaaaaaaaaaaaaaaaa:" }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("bad_pair");
  });
});

describe("nothing is persisted", () => {
  it("no database client is created, no cookie is set, and the vendor's GET is the only request made", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", ((url: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      return vendor.fetch(url, init);
    }) as typeof fetch);
    const res = await POST(post(verify()));
    expect(res.status).toBe(200);
    expect(requests).toEqual(["GET https://api.openai.com/v1/models"]);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(vendor.seen).toHaveLength(1);
    expect(vendor.seen[0].body).toBe("");
  });

  it("the only thing logged is one line: who (an id prefix), the vendor and the verdict", async () => {
    await POST(post(verify()));
    vendor.answer(json(401, {}));
    await POST(post(verify()));
    vendor.answer(json(500, {}));
    await POST(post(verify()));
    const lines = captured.filter((l) => l.startsWith("[model-key]"));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[model-key\] user=u\d{7} provider=openai outcome=verified$/);
    expect(lines[1]).toMatch(/outcome=rejected$/);
    expect(lines[2]).toMatch(/outcome=could_not_reach:vendor_error$/);
    expect(captured).toHaveLength(3);
    expectNoKey(captured.join("\n"));
  });
});
