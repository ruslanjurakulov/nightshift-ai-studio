import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The brand scan's routes, model and strings (migration 0133, NIGHTSHIFT_ADS_BRAND_SCAN on top of NIGHTSHIFT_ADS_FACTORY).
 *
 * What would break without these: a scan route answering while either switch is off (or telling a signed-out visitor it exists), the
 * browser choosing the price or the hold (only the database does), a scan started with no price ceiling, a refusal turned into a 500 or a
 * fake success, the platform's cap or a price shown with a number the database never gave, a value the scan read reaching the page in a
 * shape the database would not store, a hosting parent accepted as "my domain", a route reaching for the service key or fetching the site,
 * and a Russian or Uzbek screen with a missing sentence.
 */

vi.mock("server-only", () => ({}));

const ORG = "0a000000-0000-4000-8000-00000000000a";
const DOMAIN = "0b000000-0000-4000-8000-00000000000b";
const SCAN = "0c000000-0000-4000-8000-00000000000c";
const KIT = "0d000000-0000-4000-8000-00000000000d";
const LOGO = "0e000000-0000-4000-8000-00000000000e";
const TOKEN = "0123456789abcdef0123456789abcdef";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string } | null,
  current: { id: "0a000000-0000-4000-8000-00000000000a" } as { id: string } | null,
  rpc: {} as Record<string, { data: unknown; error: { code?: string; message?: string; details?: string } | null }>,
  tables: {} as Record<string, { data: unknown; error: { code?: string; message?: string } | null }>,
  calls: [] as { kind: string; name: string; args?: unknown; chain: { m: string; a: unknown[] }[] }[],
  getUser: 0,
}));

function builder(rec: { chain: { m: string; a: unknown[] }[] }, result: () => unknown): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return (...a: unknown[]) => {
        rec.chain.push({ m: String(prop), a });
        return q;
      };
    },
  });
  return q;
}

const client = {
  rpc: (name: string, args: unknown) => {
    const rec = { kind: "rpc", name, args, chain: [] as { m: string; a: unknown[] }[] };
    h.calls.push(rec);
    return builder(rec, () => h.rpc[name] ?? { data: null, error: null });
  },
  from: (name: string) => {
    const rec = { kind: "from", name, chain: [] as { m: string; a: unknown[] }[] };
    h.calls.push(rec);
    return builder(rec, () => h.tables[name] ?? { data: [], error: null });
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => client,
  getUser: async () => {
    h.getUser++;
    return h.user;
  },
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, orgs: [], current: h.current }) }));

const root = await import("../app/api/ads/scan/route");
const domains = await import("../app/api/ads/scan/domains/route");
const check = await import("../app/api/ads/scan/domains/[id]/check/route");
const accept = await import("../app/api/ads/scan/[id]/accept/route");
const model = await import("../lib/adsFactory/scan");
const { en } = await import("../lib/i18n/en");
const { ADS_BRAND_SCAN_STRINGS, brandScanStrings } = await import("../lib/i18n/ads-brand-scan");
const { BANNED_PROVIDER_NAMES, bannedHits } = await import("../lib/marketing-banned");

function req(url: string, method: string, body?: unknown, headers: Record<string, string> = { Origin: "http://x" }) {
  return new Request(`http://x${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined || method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const rpcs = () => h.calls.filter((c) => c.kind === "rpc");

const SCAN_BODY = { url: "https://shop.example.com/", idem: "ads-0123456789abcdef", max_credits: 1 };
const EVERY: [string, () => Promise<Response>][] = [
  ["GET /api/ads/scan", () => root.GET(req("/api/ads/scan", "GET"))],
  ["POST /api/ads/scan", () => root.POST(req("/api/ads/scan", "POST", SCAN_BODY))],
  ["POST /api/ads/scan/domains", () => domains.POST(req("/api/ads/scan/domains", "POST", { host: "shop.example.com" }))],
  ["POST /api/ads/scan/domains/:id/check", () => check.POST(req(`/api/ads/scan/domains/${DOMAIN}/check`, "POST"), ctx(DOMAIN))],
  ["POST /api/ads/scan/:id/accept", () => accept.POST(req(`/api/ads/scan/${SCAN}/accept`, "POST", { kit_id: null, fields: ["name"] }), ctx(SCAN))],
];

beforeEach(() => {
  process.env.NIGHTSHIFT_ADS_FACTORY = "on";
  process.env.NIGHTSHIFT_ADS_BRAND_SCAN = "on";
  h.user = { id: "u1" };
  h.current = { id: ORG };
  h.rpc = {};
  h.tables = {};
  h.calls.length = 0;
  h.getUser = 0;
});
afterEach(() => {
  delete process.env.NIGHTSHIFT_ADS_FACTORY;
  delete process.env.NIGHTSHIFT_ADS_BRAND_SCAN;
});

describe("the switches", () => {
  it("NIGHTSHIFT_ADS_BRAND_SCAN is off unless explicitly on", () => {
    expect(model.ADS_BRAND_SCAN_FLAG).toBe("NIGHTSHIFT_ADS_BRAND_SCAN");
    delete process.env.NIGHTSHIFT_ADS_BRAND_SCAN;
    expect(model.adsBrandScanEnabled(), "unset").toBe(false);
    for (const v of ["", "off", "0", "false", "no", "enabled"]) expect(model.adsBrandScanEnabled(v), v).toBe(false);
    for (const v of ["on", "1", "true", "yes", " ON "]) expect(model.adsBrandScanEnabled(v), v).toBe(true);
  });

  it.each(EVERY)("%s is a 404 while either switch is off, before the session or the database is asked", async (_n, call) => {
    for (const [scan, ads] of [[undefined, "on"], ["off", "on"], ["on", undefined], ["on", "off"], [undefined, undefined]] as const) {
      if (scan === undefined) delete process.env.NIGHTSHIFT_ADS_BRAND_SCAN;
      else process.env.NIGHTSHIFT_ADS_BRAND_SCAN = scan;
      if (ads === undefined) delete process.env.NIGHTSHIFT_ADS_FACTORY;
      else process.env.NIGHTSHIFT_ADS_FACTORY = ads;
      expect(await json(await call()), `${scan}/${ads}`).toEqual({ status: 404, body: { error: "not_found" } });
    }
    expect(h.getUser).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it.each(EVERY)("%s is a 401 for a signed-out caller, and the database is not asked", async (_n, call) => {
    h.user = null;
    expect(await json(await call())).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(h.calls).toEqual([]);
  });

  it.each(EVERY.slice(1))("%s refuses a request that is not from our own page", async (name) => {
    const handler = { "POST /api/ads/scan": () => root.POST, "POST /api/ads/scan/domains": () => domains.POST,
      "POST /api/ads/scan/domains/:id/check": () => check.POST, "POST /api/ads/scan/:id/accept": () => accept.POST }[name]!() as (r: Request, c: unknown) => Promise<Response>;
    for (const headers of [{}, { Origin: "https://evil.example" }, { Origin: "null" }] as Record<string, string>[]) {
      expect((await handler(req("/api/ads/scan", "POST", {}, headers), ctx(SCAN))).status, JSON.stringify(headers)).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });
});

describe("POST /api/ads/scan", () => {
  it("asks request_brand_scan with the URL, the press id and the price the person saw; the database computes and holds the price", async () => {
    h.rpc.request_brand_scan = { data: { id: SCAN, status: "requested", credits: 1, replayed: false }, error: null };
    const res = await json(await root.POST(req("/api/ads/scan", "POST", SCAN_BODY)));
    expect(res).toEqual({ status: 201, body: { id: SCAN, status: "requested", credits: 1, replayed: false } });
    expect(rpcs().map((c) => [c.name, c.args])).toEqual([
      ["request_brand_scan", { p_org: ORG, p_url: "https://shop.example.com/", p_idem: "ads-0123456789abcdef", p_max_credits: 1 }],
    ]);
  });

  it("refuses a body it cannot read before the database is asked", async () => {
    for (const [body, error] of [
      [{ ...SCAN_BODY, url: "http://shop.example.com/" }, "invalid_url"], [{ ...SCAN_BODY, url: "https://shop.example.com:8443/" }, "invalid_url"],
      [{ ...SCAN_BODY, url: "https://127.0.0.1/" }, "invalid_url"], [{ ...SCAN_BODY, url: "https://shop.example.com/a\\b" }, "invalid_url"],
      [{ ...SCAN_BODY, idem: "short" }, "invalid_idempotency_key"], [{ ...SCAN_BODY, max_credits: undefined }, "bad_request"],
      [{ ...SCAN_BODY, max_credits: -1 }, "bad_request"], [{ ...SCAN_BODY, max_credits: "1" }, "bad_request"], ["not json", "bad_request"],
      [[1], "bad_request"], [{ ...SCAN_BODY, org_id: "nope" }, "bad_request"],
    ] as [unknown, string][]) {
      const res = await json(await root.POST(req("/api/ads/scan", "POST", body)));
      expect(res.body, JSON.stringify(body)).toEqual({ error });
    }
    expect(rpcs()).toEqual([]);
  });

  it("says each refusal of the database in its own word, a number only where the database named one", async () => {
    for (const [err, want] of [
      [{ code: "NS409", message: "not_on_sale" }, { status: 409, body: { error: "not_on_sale" } }],
      [{ code: "NS409", message: "price_changed", details: "price=2" }, { status: 409, body: { error: "price_changed", price: 2 } }],
      [{ code: "NS409", message: "domain_not_verified" }, { status: 409, body: { error: "domain_not_verified" } }],
      [{ code: "NS409", message: "scan_in_progress" }, { status: 409, body: { error: "scan_in_progress" } }],
      [{ code: "NS409", message: "idempotency_conflict" }, { status: 409, body: { error: "idempotency_conflict" } }],
      [{ code: "NS429", message: "platform_busy" }, { status: 429, body: { error: "platform_busy" } }],
      [{ code: "NS429", message: "parallel run limit reached", details: "active=1 limit=1" }, { status: 429, body: { error: "parallel_limit" } }],
      [{ code: "NS402", message: "insufficient credits", details: "available=0 needed=1" }, { status: 402, body: { error: "insufficient_credits" } }],
      [{ code: "NS402", message: "scan_hold_unavailable", details: "hold=30 price=1" }, { status: 402, body: { error: "scan_hold_unavailable", hold: 30, price: 1 } }],
      [{ code: "NS402", message: "scan_hold_unavailable", details: "hold=lots" }, { status: 402, body: { error: "scan_hold_unavailable" } }],
      [{ code: "NS400", message: "hosting_parent" }, { status: 400, body: { error: "hosting_parent" } }],
      [{ code: "42501", message: "forbidden" }, { status: 403, body: { error: "forbidden" } }],
      [{ code: "NS409", message: "something new" }, { status: 502, body: { error: "failed" } }],
      [{ code: "XX000", message: "boom" }, { status: 502, body: { error: "failed" } }],
      [{ code: "PGRST202", message: "Could not find the function" }, { status: 503, body: { error: "not_available" } }],
    ] as const) {
      h.rpc.request_brand_scan = { data: null, error: err };
      expect(await json(await root.POST(req("/api/ads/scan", "POST", SCAN_BODY))), JSON.stringify(err)).toEqual(want);
    }
  });

  it("a replay is a 200 with the first scan, never a made-up success", async () => {
    h.rpc.request_brand_scan = { data: { id: SCAN, status: "running", credits: 1, replayed: true }, error: null };
    expect((await json(await root.POST(req("/api/ads/scan", "POST", SCAN_BODY)))).status).toBe(200);
    h.rpc.request_brand_scan = { data: { id: "nope" }, error: null };
    expect(await json(await root.POST(req("/api/ads/scan", "POST", SCAN_BODY)))).toEqual({ status: 502, body: { error: "failed" } });
  });
});

describe("the domain and check routes", () => {
  it("asks for the host as the database stores it, and answers the TXT record", async () => {
    h.rpc.request_domain_verification = { data: { id: DOMAIN, host: "shop.example.com", record_name: "_nightshift.shop.example.com", record_value: `nightshift-verify=${TOKEN}`, verified_at: null }, error: null };
    const res = await json(await domains.POST(req("/api/ads/scan/domains", "POST", { host: " HTTPS://Shop.Example.com/about " })));
    expect(res).toEqual({ status: 201, body: { id: DOMAIN, host: "shop.example.com", record_name: "_nightshift.shop.example.com", record_value: `nightshift-verify=${TOKEN}`, verified_at: null } });
    expect(rpcs()[0].args).toEqual({ p_org: ORG, p_host: "shop.example.com" });
  });

  it("refuses a hosting parent or a host of the wrong shape before the database is asked", async () => {
    for (const [host, error] of [["co.uk", "hosting_parent"], ["myshopify.com", "hosting_parent"], ["https://github.io/", "hosting_parent"],
      ["shop.example.com:443", "invalid_host"], ["127.0.0.1", "invalid_host"], ["shop_x.test", "invalid_host"], ["bränd.test", "invalid_host"], [7, "invalid_host"]] as const) {
      expect((await json(await domains.POST(req("/api/ads/scan/domains", "POST", { host })))).body, String(host)).toEqual({ error });
    }
    expect(rpcs()).toEqual([]);
  });

  it("Check now queues one check, and a wait is said with the seconds the database gave", async () => {
    h.rpc.check_domain_verification = { data: { check_id: SCAN, domain_id: DOMAIN, pending: true, replayed: false }, error: null };
    expect(await json(await check.POST(req(`/api/ads/scan/domains/${DOMAIN}/check`, "POST"), ctx(DOMAIN)))).toEqual({ status: 202, body: { pending: true, replayed: false } });
    expect(rpcs()[0].args).toEqual({ p_domain: DOMAIN });
    h.rpc.check_domain_verification = { data: null, error: { code: "NS429", message: "too_soon", details: "retry_after=9" } };
    expect(await json(await check.POST(req(`/api/ads/scan/domains/${DOMAIN}/check`, "POST"), ctx(DOMAIN)))).toEqual({ status: 429, body: { error: "too_soon", retry_after: 9 } });
    h.rpc.check_domain_verification = { data: null, error: { code: "NS429", message: "platform_busy" } };
    expect(await json(await check.POST(req(`/api/ads/scan/domains/${DOMAIN}/check`, "POST"), ctx(DOMAIN)))).toEqual({ status: 429, body: { error: "platform_busy" } });
    h.calls.length = 0;
    expect((await check.POST(req("/api/ads/scan/domains/x/check", "POST"), ctx("not-a-uuid"))).status).toBe(404);
    expect(h.calls).toEqual([]);
  });
});

describe("POST /api/ads/scan/:id/accept", () => {
  it("passes the chosen fields and the kit (or none: a new kit) to the database", async () => {
    h.rpc.accept_brand_scan_fields = { data: KIT, error: null };
    expect(await json(await accept.POST(req(`/api/ads/scan/${SCAN}/accept`, "POST", { kit_id: null, fields: ["name", "logo", "product:3"] }), ctx(SCAN))))
      .toEqual({ status: 200, body: { kit_id: KIT } });
    expect(rpcs()[0].args).toEqual({ p_scan: SCAN, p_kit: null, p_fields: ["name", "logo", "product:3"] });
  });

  it("refuses unknown, repeated or too many fields and a bad kit id before the database is asked", async () => {
    for (const body of [{ fields: [] }, { fields: ["admin"] }, { fields: ["name", "name"] }, { fields: ["product:8"] }, { fields: Array(16).fill("name") },
      { kit_id: "nope", fields: ["name"] }, { fields: "name" }, [1]]) {
      expect((await accept.POST(req(`/api/ads/scan/${SCAN}/accept`, "POST", body), ctx(SCAN))).status, JSON.stringify(body)).toBe(400);
    }
    expect(rpcs()).toEqual([]);
  });

  it("a cap is said with the database's number, and a deleted picture in its own word", async () => {
    h.rpc.accept_brand_scan_fields = { data: null, error: { code: "NS429", message: "limit_reached", details: "max=5" } };
    expect(await json(await accept.POST(req(`/api/ads/scan/${SCAN}/accept`, "POST", { fields: ["name"] }), ctx(SCAN)))).toEqual({ status: 409, body: { error: "limit_reached", max: 5 } });
    h.rpc.accept_brand_scan_fields = { data: null, error: { code: "NS400", message: "invalid_reference" } };
    expect((await json(await accept.POST(req(`/api/ads/scan/${SCAN}/accept`, "POST", { fields: ["logo"] }), ctx(SCAN)))).body).toEqual({ error: "invalid_reference" });
  });
});

describe("GET /api/ads/scan", () => {
  const RESULT = {
    v: 1, pages: ["https://shop.example.com/"],
    fields: {
      name: { value: "<b>Brand</b>", source: { url: "https://shop.example.com/", where: "og_site_name" } },
      palette: { value: ["#112233", "red"], source: { url: "https://shop.example.com/logo.png", where: "logo_palette" } },
      fonts: { value: ["Inter"], source: { url: "javascript:alert(1)", where: "css" } },
      logo: { value: LOGO, source: { url: "https://shop.example.com/logo.png", where: "icon" } },
      theme_color: { value: "#ff6600", source: { url: "https://shop.example.com/", where: "made_up" } },
    },
    products: [{ title: { value: "Mug", source: { url: "https://shop.example.com/p", where: "jsonld_product" } } }, { price: { value: "$1" } }],
    notes: [{ code: "logo_svg", url: "https://shop.example.com/l.svg" }, { code: "Bad Code" }],
  };

  it("reads the domains, the waiting checks, the latest scans and the quote of the open organization, under the member's session", async () => {
    h.tables.brand_domains = { data: [{ id: DOMAIN, host: "shop.example.com", token: TOKEN, verified_at: null, last_checked_at: null, last_check_code: "no_record" }], error: null };
    h.tables.brand_domain_checks = { data: [{ domain_id: DOMAIN }], error: null };
    h.tables.brand_scans = { data: [{ id: SCAN, url: "https://shop.example.com/", status: "ready", result: RESULT, price_credits: 1, charged_credits: 1, accepted_fields: ["name"], kit_id: null, created_at: "2026-11-11T00:00:00Z" }], error: null };
    h.rpc.quote_brand_scan = { data: { on_sale: true, credits: 1, hold: 30, exempt: false }, error: null };
    const res = await json(await root.GET(req("/api/ads/scan", "GET")));
    expect(res.status).toBe(200);
    expect(res.body.quote).toEqual({ onSale: true, credits: 1, hold: 30, exempt: false });
    expect(res.body.domains).toEqual([{ id: DOMAIN, host: "shop.example.com", recordName: "_nightshift.shop.example.com", recordValue: `nightshift-verify=${TOKEN}`,
      verifiedAt: null, lastCheckedAt: null, lastCheckCode: "no_record", pending: true }]);
    const scan = (res.body.scans as Record<string, unknown>[])[0] as unknown as import("../lib/adsFactory/scan").BrandScan;
    expect(scan.fields.name?.value).toBe("<b>Brand</b>");
    expect(scan.fields.palette).toBeNull();
    expect(scan.fields.fonts).toBeNull();
    expect(scan.fields.themeColor).toBeNull();
    expect(scan.fields.logo?.value).toBe(LOGO);
    expect(scan.products.map((p) => p.title.value)).toEqual(["Mug"]);
    expect(scan.notes).toEqual([{ code: "logo_svg", url: "https://shop.example.com/l.svg" }]);
    const reads = h.calls.filter((c) => c.kind === "from");
    expect(reads.map((c) => c.name).sort()).toEqual(["brand_domain_checks", "brand_domains", "brand_scans", "media_assets"]);
    for (const c of reads) expect(c.chain.find((s) => s.m === "eq")?.a, c.name).toEqual(["org_id", ORG]);
    expect(rpcs().map((c) => [c.name, c.args])).toEqual([["quote_brand_scan", { p_org: ORG }]]);
  });

  it("says so when 0133 is not applied, when a read fails, and when no organization is open", async () => {
    h.tables.brand_scans = { data: null, error: { code: "42P01", message: 'relation "public.brand_scans" does not exist' } };
    expect(await json(await root.GET(req("/api/ads/scan", "GET")))).toEqual({ status: 503, body: { error: "not_available" } });
    h.tables.brand_scans = { data: null, error: { code: "57014", message: "canceling statement" } };
    expect(await json(await root.GET(req("/api/ads/scan", "GET")))).toEqual({ status: 502, body: { error: "read_failed" } });
    h.tables = {};
    h.current = null;
    expect(await json(await root.GET(req("/api/ads/scan", "GET")))).toEqual({ status: 400, body: { error: "org_required" } });
  });
});

describe("the model", () => {
  it("holds the same hosting parents and host shape as 0133 and the worker", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0133_brand_scan.sql"), "utf8");
    const fn = sql.slice(sql.indexOf("create or replace function public.ads_hosting_parent"), sql.indexOf("create or replace function public.ads_scan_host_ok"));
    const listed = [...fn.slice(0, fn.indexOf("~")).matchAll(/'([a-z0-9.]+\.[a-z]+)'/g)].map((m) => m[1]).sort();
    expect([...model.HOSTING_PARENTS].sort()).toEqual(listed);
    expect([...model.COUNTRY_SECOND_LEVEL].sort()).toEqual(/\^\(([a-z|]+)\)/.exec(fn)![1].split("|").sort());
    expect(sql).toContain(`p_host ~ '${model.HOST_PATTERN}'`);
    const py = readFileSync(join(__dirname, "..", "..", "modules", "brand_fetch.py"), "utf8");
    for (const h of model.HOSTING_PARENTS) expect(py).toContain(`"${h}"`);
  });

  it("reads a typed domain as its host, and refuses what is not one site", () => {
    const ok = (s: string) => model.parseScanHost(s);
    expect(ok("Shop.Example.com")).toEqual({ ok: true, host: "shop.example.com" });
    expect(ok("https://shop.example.com/about?x=1")).toEqual({ ok: true, host: "shop.example.com" });
    expect(ok("http://www.shop.co.uk.")).toEqual({ ok: true, host: "www.shop.co.uk" });
    expect(ok("me.github.io")).toEqual({ ok: true, host: "me.github.io" });
    for (const s of ["co.uk", "com.au", "org.uz", "vercel.app", "s3.amazonaws.com"]) expect(ok(s), s).toEqual({ ok: false, error: "hosting_parent" });
    for (const s of ["", "localhost", "a.b", "shop.test:8443", "user@shop.test", "shop_x.test", "[::1]", "x".repeat(254)]) expect(ok(s).ok, s).toBe(false);
  });

  it("offers only what the scan proposed, and the scanned address", () => {
    const scan = model.coerceScan({ id: SCAN, url: "https://shop.example.com/", status: "ready", result: {
      fields: { name: { value: "B", source: { url: "https://shop.example.com/", where: "title" } } },
      products: [{ title: { value: "Mug", source: { url: "https://shop.example.com/", where: "jsonld_product" } } }] } })!;
    expect(model.offeredFields(scan)).toEqual(["name", "site_url", "product:0"]);
    expect(model.coerceScan({ id: SCAN, url: "javascript:alert(1)", status: "ready" })).toBeNull();
    expect(model.coerceScan({ id: SCAN, url: "https://shop.example.com/", status: "done" })).toBeNull();
  });

  it("a quote that is on sale names a price, one that is not names none", () => {
    expect(model.coerceQuote({ on_sale: false, credits: 5, hold: 30 })).toEqual({ onSale: false, credits: null, hold: null, exempt: false });
    expect(model.coerceQuote({ on_sale: true, credits: null })).toBeNull();
    expect(model.coerceQuote({ on_sale: true, credits: 1, exempt: true })).toEqual({ onSale: true, credits: 1, hold: 1, exempt: true });
    // The charged price and the hold (the price raised to job_minimum) stay apart; a hold below the price is never believed.
    expect(model.coerceQuote({ on_sale: true, credits: 1, hold: 30 })).toEqual({ onSale: true, credits: 1, hold: 30, exempt: false });
    expect(model.coerceQuote({ on_sale: true, credits: 5, hold: 2 })).toEqual({ onSale: true, credits: 5, hold: 5, exempt: false });
    expect(model.coerceQuote(null)).toBeNull();
  });
});

describe("strings", () => {
  const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  function leaves(node: unknown, path = ""): [string, string][] {
    if (typeof node === "string") return [[path, node]];
    if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
    return [];
  }
  const source = leaves(ADS_BRAND_SCAN_STRINGS.en);

  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}, and is not left in English", (loc) => {
    const got = new Map(leaves(ADS_BRAND_SCAN_STRINGS[loc]));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key)?.trim(), `${loc}.${key}`).toBeTruthy();
      expect(fillers(got.get(key)!), `${loc}.${key}`).toEqual(fillers(text));
    }
    expect(source.filter(([k, v]) => got.get(k) === v).map(([k]) => k)).toEqual([]);
  });

  it.each(["ru", "uz"] as const)("%s is marked as a draft that needs a native read", (loc) => {
    const file = readFileSync(join(__dirname, "..", "lib", "i18n", "ads-brand-scan", `${loc}.ts`), "utf8");
    expect(file).toMatch(loc === "ru" ? /ЧЕРНОВИК ПЕРЕВОДА/ : /TARJIMA QORALAMASI/);
    expect(file).toContain("Strings that need a native read");
  });

  it.each(["en", "ru", "uz"] as const)("%s has a sentence for every refusal, failure, check result and place", (loc) => {
    const t = ADS_BRAND_SCAN_STRINGS[loc];
    const errors: string[] = ["unauthorized", "forbidden", "not_found", "bad_request", "org_required", "not_available", "not_configured", "read_failed", "failed",
      "invalid_host", "hosting_parent", "invalid_url", "invalid_idempotency_key", "invalid_fields", "name_required", "invalid_reference", "limit_reached",
      "too_soon", "platform_busy", "not_on_sale", "price_changed", "domain_not_verified", "scan_in_progress", "idempotency_conflict", "scan_not_ready",
      "insufficient_credits", "scan_hold_unavailable", "parallel_limit"];
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0133_brand_scan.sql"), "utf8");
    // invalid_result is the worker's refusal (finish_brand_scan, service_role): no member route can receive it.
    for (const m of sql.matchAll(/raise exception '([a-z_]+)' using errcode = 'NS4\d\d'/g)) if (m[1] !== "invalid_result") expect(errors, m[1]).toContain(m[1]);
    for (const e of errors) expect((t.errors as Record<string, string>)[e], `${loc}.errors.${e}`).toBeTruthy();
    for (const f of model.SCAN_FAILURES) expect((t.failures as Record<string, string>)[f], `${loc}.failures.${f}`).toBeTruthy();
    for (const c of model.CHECK_CODES) expect((t.domain.results as Record<string, string>)[c], `${loc}.domain.results.${c}`).toBeTruthy();
    for (const p of model.SCAN_PLACES) expect((t.review.places as Record<string, string>)[p], `${loc}.review.places.${p}`).toBeTruthy();
    const worker = readFileSync(join(__dirname, "..", "..", "modules", "brand_scan.py"), "utf8");
    for (const m of worker.matchAll(/_Failed\("([a-z_]+)"\)/g)) expect(model.SCAN_FAILURES as readonly string[], m[1]).toContain(m[1]);
  });

  it.each(["en", "ru", "uz"] as const)("%s carries no banned claim, names no other product, vendor or model, and calls nothing generated", (loc) => {
    const text = leaves(ADS_BRAND_SCAN_STRINGS[loc]).map(([, v]) => v).join("\n");
    expect(bannedHits({ [loc]: text })).toEqual([]);
    for (const name of BANNED_PROVIDER_NAMES) expect(text.toLowerCase().includes(` ${name} `), name).toBe(false);
    expect(ADS_BRAND_SCAN_STRINGS.en.intro).toMatch(/Nothing is copied into a brand kit until you accept it/);
    expect(text.toLowerCase()).not.toMatch(/\bgenerat|\bai\b/);
  });

  it("an unknown locale reads as English; the app's own dictionaries are untouched", () => {
    expect(brandScanStrings("xx")).toBe(ADS_BRAND_SCAN_STRINGS.en);
    expect("adsBrandScan" in en).toBe(false);
  });
});

describe("what the code may not do", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
  const sources = [
    ...files(join(__dirname, "..", "app", "api", "ads", "scan")),
    join(__dirname, "..", "lib", "server", "ads-brand-scan.ts"),
    join(__dirname, "..", "lib", "adsFactory", "scan.ts"),
    join(__dirname, "..", "components", "ads", "BrandScanPanel.tsx"),
  ].map((p) => [p, readFileSync(p, "utf8")] as const);

  it("never uses the service key, never fetches the site, never renders HTML, never links to the site", () => {
    for (const [p, src] of sources) {
      expect(src, p).not.toMatch(/SERVICE_KEY|service_role|createServiceClient|createAdminClient/);
      expect(src, p).not.toContain("dangerouslySetInnerHTML");
      expect(src, p).not.toMatch(/<a\s/);
      for (const m of src.matchAll(/fetch\(\s*([^,)]+)/g)) expect(m[1], p).toMatch(/^url$|^`\/api\/ads\/scan|^"\/api\/ads\/scan/);
    }
    const panel = sources.find(([p]) => p.endsWith("BrandScanPanel.tsx"))![1];
    for (const m of panel.matchAll(/call(?:<[^>]+>)?\("(?:GET|POST)",\s*([^,)]+)/g)) expect(m[1]).toMatch(/^[`"]\/api\/ads\/scan/);
  });
});
