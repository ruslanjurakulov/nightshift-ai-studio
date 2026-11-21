import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Payme from the Command Center: PAYMENTS_PROVIDER as a list, the server-side Payme settings, the checkout link and
 * the checkout route. What would break without these: today's single value (`dodo`, `paddle`, empty) changing meaning;
 * Payme appearing without being listed; a browser naming the amount; a link to a cashbox in the wrong mode; a checkout
 * for a pack with no UZS price; a member (not an admin) opening an order.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  user: { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" } as { id: string; email: string } | null,
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null,
  role: { ok: true, role: "owner" } as { ok: true; role: string } | { ok: false; error: string; status: number },
  order: { data: "0123456789abcdef0123456789abcdef" as unknown, error: null as null | { code: string; message: string } },
  rpcCalls: [] as { fn: string; args: unknown }[],
  getUserCalls: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => {
    h.getUserCalls += 1;
    return h.user;
  },
  createClient: async () => ({
    rpc: async (fn: string, args: unknown) => {
      h.rpcCalls.push({ fn, args });
      return h.order;
    },
  }),
}));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({ supported: true, current: h.orgId ? { id: h.orgId, role: "owner" } : null }),
}));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => h.role }));
// The real catalog has no UZS price yet (the owner's decision); the route is exercised with one priced pack.
vi.mock("@/lib/payme", async (orig) => ({
  ...(await orig<typeof import("@/lib/payme")>()),
  PAYME_CATALOG_PACKS: [
    { id: "starter", credits: 1000, uzs: 120000 },
    { id: "creator", credits: 5000, uzs: null },
  ],
}));

const { parsePaymentsProviders, resolvePaymentsProvider } = await import("@/lib/payments");
const real = await vi.importActual<typeof import("@/lib/payme")>("@/lib/payme");
const { paymeCheckoutUrl, paymePacksOnSale, paymePriceText, paymeViewFor, resolvePaymeServer } = real;
const checkout = await import("../app/api/billing/payme/checkout/route");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MERCHANT = "5e730e8e0b852a417aa49ceb";
const SELLING = { PAYME_MERCHANT_ID: MERCHANT, PAYME_ENV: "test", PAYME_TEST_ORG_IDS: ORG };

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const k of ["PAYMENTS_PROVIDER", "APP_ORIGIN", "PAYME_MERCHANT_ID", "PAYME_ENV", "PAYME_TEST_ORG_IDS"]) vi.stubEnv(k, "");
  h.user = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" };
  h.orgId = ORG;
  h.role = { ok: true, role: "owner" };
  h.order = { data: "0123456789abcdef0123456789abcdef", error: null };
  h.rpcCalls = [];
  h.getUserCalls = 0;
});
afterEach(() => vi.unstubAllEnvs());

const setEnv = (vars: Record<string, string>) => Object.entries(vars).forEach(([k, v]) => vi.stubEnv(k, v));
const buy = (body: unknown, origin = "http://test.local") =>
  checkout.POST(
    new Request("http://test.local/api/billing/payme/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    }),
  );
// Strip the host, not "everything up to the last slash": standard base64 itself contains "/".
const decode = (url: string) => Buffer.from(url.replace(/^https:\/\/[^/]+\//, ""), "base64").toString("utf8");

describe("PAYMENTS_PROVIDER as a list", () => {
  it("today's single values read exactly as before", () => {
    expect(parsePaymentsProviders("dodo")).toEqual({ primary: "dodo", payme: false });
    for (const v of ["", undefined, null, "paddle", "Dodo", " dodo", "dodo ", "stripe"]) expect(parsePaymentsProviders(v)).toEqual({ primary: "paddle", payme: false });
    expect(resolvePaymentsProvider("dodo")).toBe("dodo");
    expect(resolvePaymentsProvider("paddle")).toBe("paddle");
  });

  it("adds Payme next to the primary seller only when listed", () => {
    expect(parsePaymentsProviders("dodo,payme")).toEqual({ primary: "dodo", payme: true });
    expect(parsePaymentsProviders("payme,dodo")).toEqual({ primary: "dodo", payme: true });
    expect(parsePaymentsProviders("payme")).toEqual({ primary: "paddle", payme: true });
    expect(parsePaymentsProviders("paddle,payme")).toEqual({ primary: "paddle", payme: true });
    expect(resolvePaymentsProvider("dodo,payme")).toBe("dodo");
  });

  it("a malformed list is today's default (Paddle alone), never half of it", () => {
    for (const v of ["dodo, payme", "dodo,Payme", "dodo,,payme", "dodo,payme,", "payme,payme", "dodo,paddle", "dodo,payme,click"])
      expect(parsePaymentsProviders(v)).toEqual({ primary: "paddle", payme: false });
  });
});

describe("Payme settings and link", () => {
  it("test unless live exactly; a typo or a bad merchant id is not configured", () => {
    expect(resolvePaymeServer({ PAYME_MERCHANT_ID: MERCHANT })?.environment).toBe("test");
    expect(resolvePaymeServer({ PAYME_MERCHANT_ID: MERCHANT, PAYME_ENV: "live" })?.environment).toBe("live");
    expect(resolvePaymeServer({ PAYME_MERCHANT_ID: MERCHANT, PAYME_ENV: "prod" })).toBeNull();
    expect(resolvePaymeServer({ PAYME_MERCHANT_ID: "short" })).toBeNull();
    expect(resolvePaymeServer({})).toBeNull();
  });

  it("the real catalog has no UZS price, so nothing is on sale and no panel shows", () => {
    expect(paymePacksOnSale()).toEqual([]);
    expect(paymeViewFor(resolvePaymeServer(SELLING), ORG)).toBeNull();
  });

  it("shows only priced packs, only to a test-listed workspace in test mode", () => {
    const priced = [
      { id: "starter", credits: 1000, uzs: 120000 },
      { id: "creator", credits: 5000, uzs: null },
    ];
    const cfg = resolvePaymeServer(SELLING);
    expect(paymeViewFor(cfg, ORG, priced)).toEqual({ environment: "test", packs: [{ id: "starter", credits: 1000, uzs: 120000 }] });
    expect(paymeViewFor(cfg, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", priced)).toBeNull();
    expect(paymeViewFor(null, ORG, priced)).toBeNull();
  });

  it("builds the sandbox link with merchant, order, tiyin amount, language and return URL", () => {
    const cfg = resolvePaymeServer(SELLING)!;
    const url = paymeCheckoutUrl(cfg, { orderId: "0123456789abcdef0123456789abcdef", tiyin: 12000000, lang: "uz", returnUrl: "https://n.example/x/credits?payme=return" })!;
    expect(url.startsWith("https://test.paycom.uz/")).toBe(true);
    expect(decode(url)).toBe(`m=${MERCHANT};ac.order_id=0123456789abcdef0123456789abcdef;a=12000000;l=uz;c=https://n.example/x/credits?payme=return`);
    const live = paymeCheckoutUrl({ ...cfg, environment: "live" }, { orderId: "0123456789abcdef0123456789abcdef", tiyin: 1, lang: "ru", returnUrl: "https://n.example/" })!;
    expect(live.startsWith("https://checkout.paycom.uz/")).toBe(true);
  });

  it("refuses a return URL that would break the parameter list, or is not https", () => {
    const cfg = resolvePaymeServer(SELLING)!;
    const o = { orderId: "0123456789abcdef0123456789abcdef", tiyin: 100, lang: "uz" as const };
    expect(paymeCheckoutUrl(cfg, { ...o, returnUrl: "https://n.example/;a=1" })).toBeNull();
    expect(paymeCheckoutUrl(cfg, { ...o, returnUrl: "http://n.example/" })).toBeNull();
    expect(paymeCheckoutUrl(cfg, { ...o, orderId: "x;a=1", returnUrl: "https://n.example/" })).toBeNull();
  });

  it("writes the price in so'm with no fraction", () => {
    expect(paymePriceText(120000, "en")).toMatch(/120,000/);
    expect(paymePriceText(120000, "en")).not.toMatch(/\.\d/);
  });
});

describe("POST /api/billing/payme/checkout", () => {
  it("answers 404 while PAYMENTS_PROVIDER does not list payme, before reading the session", async () => {
    setEnv(SELLING);
    for (const provider of ["", "paddle", "dodo", "dodo, payme"]) {
      vi.stubEnv("PAYMENTS_PROVIDER", provider);
      expect((await buy({ pack: "starter", return_path: "/all-channels/credits" })).status).toBe(404);
    }
    expect(h.getUserCalls).toBe(0);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("refuses a cross-origin request", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo,payme");
    setEnv(SELLING);
    expect((await buy({ pack: "starter", return_path: "/all-channels/credits" }, "https://evil.example")).status).toBe(403);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("opens an order for OUR pack id and links to it at the catalog amount — whatever amount the browser sends", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo,payme");
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    setEnv(SELLING);
    const res = await buy({ pack: "starter", return_path: "/all-channels/credits", amount: 1, uzs: 1, lang: "ru" });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(h.rpcCalls).toEqual([{ fn: "payme_open_order", args: { p_org: ORG, p_pack: "starter" } }]);
    expect(decode(url)).toBe(
      `m=${MERCHANT};ac.order_id=0123456789abcdef0123456789abcdef;a=12000000;l=ru;c=https://nightshift.example/all-channels/credits?payme=return`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a pack with no UZS price, or one not in the catalog, is not on sale (404) and opens no order", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "payme");
    setEnv(SELLING);
    expect((await buy({ pack: "creator", return_path: "/all-channels/credits" })).status).toBe(404);
    expect((await buy({ pack: "mega", return_path: "/all-channels/credits" })).status).toBe(404);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("refuses a foreign return path (no open redirect through Payme)", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "payme");
    setEnv(SELLING);
    expect((await buy({ pack: "starter", return_path: "https://evil.example/credits" })).status).toBe(400);
  });

  it("is 503 checkout_not_configured without a merchant id, 401 signed out, 403 for a member", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "payme");
    expect((await buy({ pack: "starter", return_path: "/all-channels/credits" })).status).toBe(503);
    setEnv(SELLING);
    h.user = null;
    expect((await buy({ pack: "starter", return_path: "/all-channels/credits" })).status).toBe(401);
    h.user = { id: "u", email: "e@x" };
    h.role = { ok: false, error: "forbidden", status: 403 };
    expect((await buy({ pack: "starter", return_path: "/all-channels/credits" })).status).toBe(403);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("in test mode sells only to PAYME_TEST_ORG_IDS", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "payme");
    setEnv({ ...SELLING, PAYME_TEST_ORG_IDS: "" });
    const res = await buy({ pack: "starter", return_path: "/all-channels/credits" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "test_mode_only" });
  });

  it("without the order function (migration not applied) answers 503, never a link to a missing order", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "payme");
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    setEnv(SELLING);
    h.order = { data: null, error: { code: "PGRST202", message: "function not found" } };
    const res = await buy({ pack: "starter", return_path: "/all-channels/credits" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "checkout_unavailable" });
  });

  it("too many orders today is 429", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "payme");
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    setEnv(SELLING);
    h.order = { data: null, error: { code: "54000", message: "too many" } };
    expect((await buy({ pack: "starter", return_path: "/all-channels/credits" })).status).toBe(429);
  });
});
