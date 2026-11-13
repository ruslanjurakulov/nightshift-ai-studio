import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Selling through Dodo Payments from the Command Center: the PAYMENTS_PROVIDER
 * switch, the server-side Dodo settings, the checkout route and the portal.
 *
 * What would break without these: a typo in the switch leaving the site half on
 * a provider nobody configured; Paddle's pages changing merely because the Dodo
 * code exists; a browser naming the product or the amount it pays; the checkout
 * returning to someone else's site; a second subscription opened on top of a
 * live one; a test key opening the live checkout; the API key or a product id
 * reaching a page. Nothing here calls Dodo: its API is a fake at the fetch edge.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  user: { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" } as { id: string; email: string } | null,
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null,
  role: { ok: true, role: "owner" } as { ok: true; role: string } | { ok: false; error: string; status: number },
  subs: [] as Record<string, unknown>[],
  subsError: null as { message: string } | null,
  audit: [] as unknown[],
  getUserCalls: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => {
    h.getUserCalls += 1;
    return h.user;
  },
  createClient: async () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: async () => ({ data: h.subsError ? null : h.subs, error: h.subsError }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({ supported: true, current: h.orgId ? { id: h.orgId, role: "owner" } : null }),
}));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => h.role }));
vi.mock("@/lib/server/audit", () => ({
  logAudit: async (e: unknown) => {
    h.audit.push(e);
  },
}));

const { resolvePaymentsProvider, dodoPricing, dodoDisplayPrice, withDodoPlans } = await import("@/lib/payments");
const { DODO_CATALOG_PACKS, DODO_CATALOG_PLAN_PRICES, dodoBuyAccess, dodoHostedUrl, dodoView, parseCheckoutItem, resolveDodoServer } = await import(
  "@/lib/dodo"
);
const { parseDodoReturn } = await import("@/lib/dodo-client");
const { dodoMetadataKey, verifyDodoMetadata } = await import("../../supabase/functions/_shared/dodo");
const dodoReturn = await import("../app/api/billing/dodo/return/route");
const { sitePricing, sitePlanMatrix, siteBuyAccess } = await import("@/lib/server/payments");
const { PRICING_ENV, resolvePricing } = await import("@/lib/pricing");
const { PLAN_ENV, planMatrix } = await import("@/lib/plans");
const { buyAccess, paddleClient, paddleConfig, CREDIT_PACKS } = await import("@/lib/paddle");
const checkout = await import("../app/api/billing/dodo/checkout/route");
const portal = await import("../app/api/billing/portal/route");

const KEY = "dodo_test_" + "k".repeat(32);
const PDT = { starter: "pdt_0NVbdIG3JNg9Yc8ey5JHW", studio: "pdt_STUDIOpack00000000000", pro: "pdt_PROplan00000000000000" };
const DODO_ENV = {
  DODO_PAYMENTS_API_KEY: KEY,
  DODO_PAYMENTS_ENV: "test",
  DODO_PRODUCT_STARTER: PDT.starter,
  DODO_PRODUCT_STUDIO: PDT.studio,
  DODO_PLAN_PRO: PDT.pro,
  DODO_METADATA_SECRET: "cc-metadata-secret-0123456789abcdef-xyz",
};
const TEST_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** DODO_ENV with this test workspace allow-listed: test mode sells only to DODO_TEST_ORG_IDS. */
const SELLING = { ...DODO_ENV, DODO_TEST_ORG_IDS: TEST_ORG };

const fetchCalls: { url: string; init: RequestInit }[] = [];
let dodoAnswer: () => Response = () => new Response(JSON.stringify({ session_id: "cks_1", checkout_url: "https://test.checkout.dodopayments.com/session/cks_1" }), { status: 200 });

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const k of ["PAYMENTS_PROVIDER", "APP_ORIGIN", ...Object.keys(DODO_ENV), "DODO_TEST_ORG_IDS", "DODO_PRODUCT_CREATOR", "DODO_PLAN_CREATOR", "DODO_PLAN_STUDIO"])
    vi.stubEnv(k, "");
  h.user = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" };
  h.orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  h.role = { ok: true, role: "owner" };
  h.subs = [];
  h.subsError = null;
  h.audit = [];
  h.getUserCalls = 0;
  fetchCalls.length = 0;
  dodoAnswer = () =>
    new Response(JSON.stringify({ session_id: "cks_1", checkout_url: "https://test.checkout.dodopayments.com/session/cks_1" }), { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return dodoAnswer();
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const post = (route: { POST: (r: Request) => Promise<Response> }, path: string, body?: unknown) =>
  route.POST(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://test.local" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const buy = (body: unknown) => post(checkout, "/api/billing/dodo/checkout", body);
const sentBody = () => JSON.parse(String(fetchCalls[0].init.body)) as Record<string, unknown>;

describe("PAYMENTS_PROVIDER", () => {
  it("is Dodo only for the exact word dodo; empty, paddle, a typo or another provider is Paddle", () => {
    for (const v of [undefined, null, "", " ", "paddle", "PADDLE", "dod", "dodo-payments", "stripe", "dodo,paddle", " dodo", "dodo ", "Dodo", "DODO"])
      expect(resolvePaymentsProvider(v)).toBe("paddle");
    expect(resolvePaymentsProvider("dodo")).toBe("dodo");
  });

  it("unset or paddle: every page reads exactly what it read before the switch existed, Dodo settings or not", () => {
    const before = {
      pricing: resolvePricing(PRICING_ENV, paddleConfig),
      matrix: planMatrix(null, PLAN_ENV, paddleClient),
      access: buyAccess(h.orgId, "owner", paddleConfig),
    };
    for (const provider of ["", "paddle", "Paddle", "dodo-typo", "Dodo"]) {
      vi.stubEnv("PAYMENTS_PROVIDER", provider);
      setEnv(DODO_ENV); // configured but not switched on: ignored
      expect(sitePricing()).toStrictEqual(before.pricing);
      expect(sitePricing()).not.toHaveProperty("dodo");
      expect(sitePlanMatrix(null, "en")).toStrictEqual(before.matrix);
      expect(siteBuyAccess(h.orgId, "owner")).toBe(before.access);
    }
  });

  it("dodo: the catalog price, Dodo as the seller, the test badge, and no Paddle checkout", () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    setEnv(SELLING);
    const p = sitePricing();
    expect(p).toStrictEqual({
      source: "dodo",
      packs: [
        { id: "starter", credits: 1000, displayPrice: "$10", priceId: null },
        { id: "studio", credits: 20000, displayPrice: "$160", priceId: null },
      ],
      paddle: null,
      dodo: { environment: "test" },
    });
    expect(siteBuyAccess(h.orgId, "owner")).toBe("allowed");
    expect(siteBuyAccess(h.orgId, "viewer")).toBe("admin_only");
    expect(siteBuyAccess("00000000-0000-0000-0000-000000000001", "owner")).toBe("hidden");
  });

  it("dodo in test mode: only an allow-listed workspace may buy; the public page still shows the catalog with the badge", () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    setEnv(DODO_ENV); // no DODO_TEST_ORG_IDS
    expect(siteBuyAccess(h.orgId, "owner")).toBe("hidden");
    expect(sitePricing().source).toBe("dodo");
    vi.stubEnv("DODO_TEST_ORG_IDS", `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb, ${TEST_ORG.toUpperCase()}`);
    expect(siteBuyAccess(h.orgId, "owner")).toBe("allowed");
    expect(siteBuyAccess("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "owner")).toBe("hidden");
    // Live sells to every workspace, the list or not.
    setEnv({ DODO_PAYMENTS_ENV: "live", DODO_PAYMENTS_API_KEY: "dodo_live_" + "k".repeat(32), DODO_TEST_ORG_IDS: "" });
    expect(siteBuyAccess("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "owner")).toBe("allowed");
  });

  it("dodo but not configured: nothing on sale, never an invented price, and still not Paddle", () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    expect(sitePricing()).toStrictEqual({ source: "none", packs: [], paddle: null, dodo: { environment: "test" } });
    expect(siteBuyAccess(h.orgId, "owner")).toBe("hidden");
    vi.stubEnv("DODO_PAYMENTS_ENV", "live");
    expect(sitePricing().dodo).toStrictEqual({ environment: "live" });
  });

  it("dodo: a plan carries the catalog price only when its product is configured; other columns are not for sale", () => {
    const matrix = {
      columns: [
        { id: "free", name: "Free", monthlyCredits: 0, isDefault: true, priceId: null, displayPrice: null },
        { id: "creator", name: "Plus", monthlyCredits: 2000, isDefault: false, priceId: "pri_x", displayPrice: "19 USD" },
        { id: "pro", name: "Pro", monthlyCredits: 6000, isDefault: false, priceId: "pri_y", displayPrice: "49 USD" },
      ],
      rows: [],
      purchasable: true,
      paddle: { environment: "sandbox" as const, clientToken: "test_x" },
    } as unknown as Parameters<typeof withDodoPlans>[0];
    const view = dodoView(resolveDodoServer(DODO_ENV));
    const out = withDodoPlans(matrix, view, DODO_CATALOG_PLAN_PRICES, "en")!;
    expect(out.paddle).toBeNull();
    expect(out.columns.map((c) => [c.id, c.priceId, c.displayPrice])).toEqual([
      ["free", null, null],
      ["creator", null, null],
      ["pro", null, "$49"],
    ]);
    expect(out.purchasable).toBe(true);
    expect(withDodoPlans(matrix, null, DODO_CATALOG_PLAN_PRICES, "en")!.purchasable).toBe(false);
  });

  it("writes a catalog price the way an owner writes a display price", () => {
    expect([1000, 4500, 16000, 1250].map(dodoDisplayPrice)).toEqual(["$10", "$45", "$160", "$12.50"]);
    expect(dodoPricing(null).packs).toEqual([]);
  });
});

describe("the Dodo settings (server only)", () => {
  it("needs a key and at least one product; test mode unless live is asked for", () => {
    expect(resolveDodoServer({})).toBeNull();
    expect(resolveDodoServer({ DODO_PAYMENTS_API_KEY: KEY })).toBeNull();
    const cfg = resolveDodoServer({ DODO_PAYMENTS_API_KEY: KEY, DODO_PRODUCT_STARTER: PDT.starter, DODO_METADATA_SECRET: DODO_ENV.DODO_METADATA_SECRET })!;
    expect(cfg.environment).toBe("test");
    expect(cfg.baseUrl).toBe("https://test.dodopayments.com");
    expect(resolveDodoServer({ ...DODO_ENV, DODO_PAYMENTS_ENV: "production" })).toBeNull();
    // Without the metadata signing key the webhook would refuse every payment: nothing is sold.
    expect(resolveDodoServer({ ...DODO_ENV, DODO_METADATA_SECRET: "" })).toBeNull();
    expect(resolveDodoServer({ ...DODO_ENV, DODO_METADATA_SECRET: "x".repeat(31) })).toBeNull();
  });

  it("refuses a key of the other mode, so a half-done switch to live never opens the wrong checkout", () => {
    expect(resolveDodoServer({ ...DODO_ENV, DODO_PAYMENTS_ENV: "live" })).toBeNull();
    expect(resolveDodoServer({ ...DODO_ENV, DODO_PAYMENTS_API_KEY: "dodo_live_" + "k".repeat(32) })).toBeNull();
    const live = resolveDodoServer({ ...DODO_ENV, DODO_PAYMENTS_ENV: "live", DODO_PAYMENTS_API_KEY: "dodo_live_" + "k".repeat(32) })!;
    expect(live.baseUrl).toBe("https://live.dodopayments.com");
  });

  it("leaves a malformed or repeated product id unsold, and a plan without a catalog price unsold", () => {
    const cfg = resolveDodoServer({ ...DODO_ENV, DODO_PRODUCT_CREATOR: "pri_paddle123456", DODO_PLAN_STUDIO: PDT.starter })!;
    expect(cfg.packs).toEqual({ starter: PDT.starter, studio: PDT.studio });
    expect(cfg.plans).toEqual({ pro: PDT.pro });
  });

  it("shows a page which items are on sale and the mode, never a product id or the key", () => {
    const view = dodoView(resolveDodoServer(DODO_ENV));
    const text = JSON.stringify(view);
    expect(text).not.toContain("pdt_");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(DODO_ENV.DODO_METADATA_SECRET);
    expect(view).toEqual({ environment: "test", packs: [DODO_CATALOG_PACKS[0], DODO_CATALOG_PACKS[2]].map((p) => ({ ...p })), plans: ["pro"] });
  });

  it("sells the same packs and credits as Paddle", () => {
    expect(DODO_CATALOG_PACKS.map((p) => [p.id, p.credits])).toEqual(CREDIT_PACKS.map((p) => [p.id, p.credits]));
  });

  it("takes from the browser only one of OUR ids: never a product id, an amount, or an inherited key", () => {
    expect(parseCheckoutItem({ kind: "pack", id: "starter" })).toEqual({ kind: "pack", id: "starter" });
    expect(parseCheckoutItem({ kind: "plan", id: "pro" })).toEqual({ kind: "plan", id: "pro" });
    for (const bad of [
      { kind: "pack", id: PDT.starter },
      { kind: "pack", id: "mega" },
      { kind: "plan", id: "free" },
      { kind: "plan", id: "constructor" },
      { kind: "plan", id: "__proto__" },
      { kind: "plan", id: "toString" },
      { kind: "product", id: "starter" },
      null,
      "starter",
    ])
      expect(parseCheckoutItem(bad)).toBeNull();
  });

  it("follows only an https URL on Dodo's own domain", () => {
    expect(dodoHostedUrl("https://test.checkout.dodopayments.com/x")).toBe("https://test.checkout.dodopayments.com/x");
    expect(dodoHostedUrl("https://dodopayments.com/x")).toBe("https://dodopayments.com/x");
    for (const bad of ["http://checkout.dodopayments.com/x", "https://dodopayments.com.evil.example/x", "https://evildodopayments.com/x", "javascript:alert(1)", 42, null])
      expect(dodoHostedUrl(bad)).toBeNull();
  });

  it("buying is an owner/admin act, never for the exempt operator organization", () => {
    const view = dodoView(resolveDodoServer(DODO_ENV));
    expect(dodoBuyAccess(h.orgId, "admin", view)).toBe("allowed");
    expect(dodoBuyAccess(h.orgId, "editor", view)).toBe("admin_only");
    expect(dodoBuyAccess(h.orgId, "owner", null)).toBe("hidden");
    expect(dodoBuyAccess(null, "owner", view)).toBe("hidden");
  });
});

describe("POST /api/billing/dodo/checkout", () => {
  it("answers 404 while PAYMENTS_PROVIDER is not dodo, before reading the session or calling anyone", async () => {
    setEnv(DODO_ENV);
    for (const provider of ["", "paddle"]) {
      vi.stubEnv("PAYMENTS_PROVIDER", provider);
      const res = await buy({ kind: "pack", id: "starter", return_path: "/all-channels/credits" });
      expect(res.status).toBe(404);
    }
    expect(h.getUserCalls).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses a cross-origin request", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    setEnv(SELLING);
    const res = await checkout.POST(
      new Request("http://test.local/api/billing/dodo/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ kind: "pack", id: "starter", return_path: "/all-channels/credits" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it("creates a session for the configured product, with WHO in metadata and nothing the browser could price", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    setEnv(SELLING);
    const res = await buy({ kind: "pack", id: "starter", return_path: "/all-channels/credits", amount: 1, product_id: "pdt_cheap000", quantity: 50 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://test.checkout.dodopayments.com/session/cks_1" });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://test.dodopayments.com/checkouts");
    expect((fetchCalls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = sentBody();
    const meta = body.metadata as Record<string, string>;
    expect(body).toEqual({
      product_cart: [{ product_id: PDT.starter, quantity: 1 }],
      customer: { email: "owner@example.com" },
      metadata: { org_id: h.orgId, user_id: h.user!.id, nightshift_item: "pack:starter", ns_nonce: meta.ns_nonce, ns_sig: meta.ns_sig },
      return_url: "https://nightshift.example/api/billing/dodo/return?to=%2Fall-channels%2Fcredits&dodo=return&item=pack",
      cancel_url: "https://nightshift.example/api/billing/dodo/return?to=%2Fall-channels%2Fcredits&dodo=cancelled&item=pack",
      feature_flags: { allow_discount_code: false, allow_currency_selection: false, allow_customer_editing_email: false, always_create_new_customer: true },
    });
    // The metadata the webhook will verify: signed with the shared secret, a fresh nonce each time.
    expect(meta.ns_nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifyDodoMetadata(meta, dodoMetadataKey(DODO_ENV.DODO_METADATA_SECRET)!)).toEqual({
      status: "valid",
      orgId: h.orgId,
      userId: h.user!.id,
      item: "pack:starter",
    });
    expect((await verifyDodoMetadata(meta, dodoMetadataKey("another-secret-that-is-long-enough-000")!)).status).toBe("invalid");
    await buy({ kind: "pack", id: "starter", return_path: "/all-channels/credits" });
    expect((JSON.parse(String(fetchCalls[1].init.body)).metadata as Record<string, string>).ns_nonce).not.toBe(meta.ns_nonce);
    // No audit row: the database would refuse an action it does not list (tests/test_audit_actions.py).
    expect(h.audit).toEqual([]);
  });

  it("a plan gets no trial, whatever the product says", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    setEnv(SELLING);
    const res = await buy({ kind: "plan", id: "pro", return_path: "/my-channel/credits" });
    expect(res.status).toBe(200);
    expect(sentBody()).toMatchObject({ product_cart: [{ product_id: PDT.pro, quantity: 1 }], subscription_data: { trial_period_days: 0 } });
    expect(String(sentBody().return_url)).toMatch(/\/api\/billing\/dodo\/return\?to=%2Fmy-channel%2Fcredits&dodo=return&item=plan$/);
  });

  it("returns only to our own Credits page (no open redirect through Dodo)", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    setEnv(SELLING);
    for (const return_path of ["https://evil.example/credits", "//evil.example/x/credits", "/x/credits?next=//evil", "/x/settings", "/x/credits/../../y", ""]) {
      const res = await buy({ kind: "pack", id: "starter", return_path });
      expect(res.status, return_path).toBe(400);
    }
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses an item that is not ours or not on sale here", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    setEnv(SELLING);
    expect((await buy({ kind: "pack", id: PDT.starter, return_path: "/a/credits" })).status).toBe(400);
    expect((await buy({ kind: "pack", id: "creator", return_path: "/a/credits" })).status).toBe(404);
    expect((await buy({ kind: "plan", id: "creator", return_path: "/a/credits" })).status).toBe(404);
    expect(fetchCalls).toHaveLength(0);
  });

  it("is refused to a signed-out visitor, a member who is not owner/admin, and the exempt operator organization", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    setEnv(SELLING);
    const ok = { kind: "pack", id: "starter", return_path: "/a/credits" };
    h.user = null;
    expect((await buy(ok)).status).toBe(401);
    h.user = { id: "11111111-1111-4111-8111-111111111111", email: "e@example.com" };
    h.role = { ok: false, error: "forbidden", status: 403 };
    expect((await buy(ok)).status).toBe(403);
    h.role = { ok: true, role: "owner" };
    h.user = { id: "11111111-1111-4111-8111-111111111111", email: "" };
    expect((await buy(ok)).status).toBe(409); // no e-mail: the checkout's address is the account's own
    h.user = { id: "11111111-1111-4111-8111-111111111111", email: "e@example.com" };
    h.orgId = "00000000-0000-0000-0000-000000000001";
    expect((await buy(ok)).status).toBe(409);
    // Test mode: a workspace that is not allow-listed cannot open a checkout at all.
    h.orgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const refused = await buy(ok);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "test_mode_only" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("never opens a second subscription: a live one, or one that cannot be read, stops the checkout", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    setEnv(SELLING);
    h.subs = [{ id: 1 }];
    expect((await buy({ kind: "plan", id: "pro", return_path: "/a/credits" })).status).toBe(409);
    h.subs = [];
    h.subsError = { message: "down" };
    expect((await buy({ kind: "plan", id: "pro", return_path: "/a/credits" })).status).toBe(503);
    expect(fetchCalls).toHaveLength(0);
  });

  it("is not configured without a key, and a Dodo answer that is not Dodo's hosted URL is not followed", async () => {
    vi.stubEnv("PAYMENTS_PROVIDER", "dodo");
    expect((await buy({ kind: "pack", id: "starter", return_path: "/a/credits" })).status).toBe(503);
    setEnv(SELLING);
    dodoAnswer = () => new Response(JSON.stringify({ checkout_url: "https://phish.example/pay" }), { status: 200 });
    expect((await buy({ kind: "pack", id: "starter", return_path: "/a/credits" })).status).toBe(502);
    dodoAnswer = () => new Response(JSON.stringify({ message: "nope" }), { status: 401 });
    const res = await buy({ kind: "pack", id: "starter", return_path: "/a/credits" });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
  });
});

describe("POST /api/billing/portal", () => {
  it("unset provider, no Paddle key and no Dodo settings: not configured, as before", async () => {
    const res = await post(portal, "/api/billing/portal");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "portal_not_configured" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("a Dodo subscription opens Dodo's portal for its own customer, returning to the Credits page", async () => {
    setEnv(DODO_ENV);
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    h.subs = [{ provider: "dodo", provider_subscription_id: "sub_Iuaq622bbmmfOGrVTqdXv", provider_customer_id: "cus_TV52uJWWXt2yIoBBxpjaa", status: "active" }];
    dodoAnswer = () => new Response(JSON.stringify({ link: "https://customer.dodopayments.com/login/xyz" }), { status: 200 });
    const res = await post(portal, "/api/billing/portal");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://customer.dodopayments.com/login/xyz" });
    expect(fetchCalls[0].url).toBe(
      "https://test.dodopayments.com/customers/cus_TV52uJWWXt2yIoBBxpjaa/customer-portal/session?return_url=" +
        encodeURIComponent("https://nightshift.example/all-channels/credits"),
    );
    expect(fetchCalls[0].init.method).toBe("POST");
  });

  it("a portal link that is not on Dodo's domain is not followed", async () => {
    setEnv(DODO_ENV);
    h.subs = [{ provider: "dodo", provider_subscription_id: "sub_Iuaq622bbmmfOGrVTqdXv", provider_customer_id: "cus_TV52uJWWXt2yIoBBxpjaa", status: "active" }];
    dodoAnswer = () => new Response(JSON.stringify({ link: "https://phish.example/portal" }), { status: 200 });
    expect((await post(portal, "/api/billing/portal")).status).toBe(502);
  });
});

describe("GET /api/billing/dodo/return", () => {
  const back = (query: string) => dodoReturn.GET(new Request(`http://test.local/api/billing/dodo/return?${query}`));

  it("drops everything Dodo appends but its status word, and goes on to our Credits page", async () => {
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    const res = await back("to=%2Fmy-channel%2Fcredits&dodo=return&item=pack&payment_id=pay_x&status=succeeded&email=buyer%40example.com");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://nightshift.example/my-channel/credits?dodo=return&item=pack&status=succeeded");
    expect(res.headers.get("location")).not.toContain("buyer");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reads Dodo's parameters glued after a stray '?', and a cancel", async () => {
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    const glued = await back("to=%2Fmy-channel%2Fcredits&dodo=return&item=plan?subscription_id=sub_x&status=active&email=a%40b.c");
    expect(glued.headers.get("location")).toBe("https://nightshift.example/my-channel/credits?dodo=return&item=plan&status=active");
    const cancelled = await back("to=%2Fmy-channel%2Fcredits&dodo=cancelled&item=pack");
    expect(cancelled.headers.get("location")).toBe("https://nightshift.example/my-channel/credits?dodo=cancelled&item=pack");
  });

  it("goes nowhere but our own Credits page", async () => {
    for (const to of ["https%3A%2F%2Fevil.example%2Fcredits", "%2F%2Fevil.example%2Fx%2Fcredits", "%2Fx%2Fsettings", ""]) {
      expect((await back(`to=${to}&dodo=return&item=pack`)).status, to).toBe(400);
    }
    expect((await back("to=%2Fx%2Fcredits&dodo=paid&item=pack")).status).toBe(400);
    expect((await back("to=%2Fx%2Fcredits&dodo=return&item=gift")).status).toBe(400);
  });
});

describe("the return from Dodo's checkout", () => {
  it("reads our item and Dodo's status, however Dodo appended it", () => {
    expect(parseDodoReturn("?dodo=return&item=pack&payment_id=pay_x&status=succeeded&email=a%40b.c")).toEqual({ state: "return", item: "pack" });
    expect(parseDodoReturn("?dodo=return&item=plan&subscription_id=sub_x&status=active")).toEqual({ state: "return", item: "plan" });
    expect(parseDodoReturn("?dodo=return&item=pack?payment_id=pay_x&status=succeeded")).toEqual({ state: "return", item: "pack" });
    expect(parseDodoReturn("?dodo=return&item=pack")).toEqual({ state: "return", item: "pack" });
    expect(parseDodoReturn("?dodo=cancelled&item=plan")).toEqual({ state: "cancelled", item: "plan" });
  });

  it("never says 'payment received' for a payment that failed", () => {
    for (const s of ["failed", "cancelled", "requires_payment_method", "expired"]) {
      expect(parseDodoReturn(`?dodo=return&item=pack&payment_id=pay_x&status=${s}`)).toEqual({ state: "cancelled", item: "pack" });
      expect(parseDodoReturn(`?dodo=return&item=pack?payment_id=pay_x&status=${s}`)).toEqual({ state: "cancelled", item: "pack" });
    }
  });

  it("is not a return without our flag", () => {
    expect(parseDodoReturn("")).toBeNull();
    expect(parseDodoReturn("?payment_id=pay_x&status=succeeded")).toBeNull();
    expect(parseDodoReturn("?dodo=paid&item=pack")).toBeNull();
  });
});
