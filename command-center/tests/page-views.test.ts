import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const recorded = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/server/page-views", () => ({ recordPageView: async (b: unknown) => void recorded.push(b) }));

import {
  PAGE_VIEW_ENDPOINT,
  PAGE_VIEW_LANGS,
  PAGE_VIEW_ROUTE_LIMIT,
  countedPath,
  deviceClass,
  isBotUserAgent,
  optedOut,
  optedOutInBrowser,
  parseBeacon,
  referrerHost,
  resetPageViewLimit,
  takePageView,
} from "@/lib/page-views";
import { LOCALES } from "@/lib/i18n";
import { PAGE_VIEW_PATH, SITEMAP_PATHS, gateDecision, isPublicApiPath } from "@/lib/public-paths";
import { POST } from "@/app/api/pv/route";

const ROOT = join(__dirname, "..");
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const GOOD = { path: "/pricing", ref: "news.example", device: "desktop", lang: "en" };

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://nightshift.example/api/pv", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { origin: "https://nightshift.example", "content-type": "application/json", "user-agent": CHROME, ...headers },
    }),
  );
}

beforeEach(() => {
  recorded.length = 0;
  resetPageViewLimit();
  vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
});
afterEach(() => vi.unstubAllEnvs());

describe("what a count may contain", () => {
  it("keeps only the referrer's host: no path, query, port, credentials or own site", () => {
    expect(referrerHost("https://News.Example/a/b?q=secret#x", "nightshift.example")).toBe("news.example");
    expect(referrerHost("https://user:pw@news.example:8443/p", "nightshift.example")).toBe("news.example");
    expect(referrerHost("https://nightshift.example/pricing", "nightshift.example")).toBe("");
    expect(referrerHost("https://www.nightshift.example/", "nightshift.example")).toBe("");
    expect(referrerHost("https://nightshift.example/", "www.nightshift.example")).toBe("");
    expect(referrerHost("", "nightshift.example")).toBe("");
    expect(referrerHost("not a url", "nightshift.example")).toBe("");
    expect(referrerHost("android-app://com.google.android.gm", "nightshift.example")).toBe("");
    expect(referrerHost("javascript:alert(1)", "nightshift.example")).toBe("");
  });

  it("classes a phone-sized window as mobile and anything wider as desktop", () => {
    expect(deviceClass(390)).toBe("mobile");
    expect(deviceClass(767)).toBe("mobile");
    expect(deviceClass(768)).toBe("desktop");
    expect(deviceClass(1280)).toBe("desktop");
  });

  it("accepts exactly four short strings and nothing else", () => {
    expect(parseBeacon(GOOD)).toEqual(GOOD);
    expect(parseBeacon({ ...GOOD, path: "/terms/" })).toEqual({ ...GOOD, path: "/terms" });
    expect(parseBeacon({ ...GOOD, ref: "" })).toEqual({ ...GOOD, ref: "" });
    // extra fields (an id a script might add) are dropped, not stored
    expect(parseBeacon({ ...GOOD, visitor: "abc", ua: "x" })).toEqual(GOOD);
    for (const bad of [
      null, "x", 1, [], {}, { ...GOOD, path: "pricing" }, { ...GOOD, path: "/" + "a".repeat(80) }, { ...GOOD, ref: "a b" },
      { ...GOOD, ref: "evil.example/path" }, { ...GOOD, device: "tablet" }, { ...GOOD, lang: "xx" }, { ...GOOD, lang: 5 }, { ...GOOD, ref: 5 },
    ]) {
      expect(parseBeacon(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("takes its languages from the site's one registry", () => {
    expect([...PAGE_VIEW_LANGS]).toEqual(LOCALES.map((l) => l.code));
  });

  it("normalizes a trailing slash the way the router does", () => {
    expect(countedPath("/pricing/")).toBe("/pricing");
    expect(countedPath("/")).toBe("/");
  });
});

describe("who is not counted", () => {
  it("Do Not Track and Global Privacy Control, in the header and in the browser", () => {
    expect(optedOut(new Headers({ dnt: "1" }))).toBe(true);
    expect(optedOut(new Headers({ "sec-gpc": "1" }))).toBe(true);
    expect(optedOut(new Headers({ dnt: "0" }))).toBe(false);
    expect(optedOut(new Headers())).toBe(false);
    expect(optedOutInBrowser({ doNotTrack: "1" }, {})).toBe(true);
    expect(optedOutInBrowser({}, { doNotTrack: "1" })).toBe(true);
    expect(optedOutInBrowser({ globalPrivacyControl: true }, {})).toBe(true);
    expect(optedOutInBrowser({ doNotTrack: "0", globalPrivacyControl: false }, {})).toBe(false);
    expect(optedOutInBrowser({}, {})).toBe(false);
  });

  it.each([
    "Googlebot/2.1 (+http://www.google.com/bot.html)", "Mozilla/5.0 (compatible; bingbot/2.0)", "Mozilla/5.0 HeadlessChrome/126.0",
    "Mozilla/5.0 Chrome-Lighthouse", "facebookexternalhit/1.1", "curl/8.4.0", "python-requests/2.31", "Slackbot-LinkExpanding 1.0",
    "Mozilla/5.0 (X11; Linux x86_64) Playwright", "Go-http-client/2.0", "UptimeRobot/2.0", "", null,
  ])("treats %j as a program, not a person", (ua) => {
    expect(isBotUserAgent(ua as string | null)).toBe(true);
  });

  it("counts an ordinary browser", () => {
    expect(isBotUserAgent(CHROME)).toBe(false);
    expect(isBotUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")).toBe(false);
  });
});

describe("POST /api/pv", () => {
  it("counts a good beacon from our own page and answers 204 with nothing to read", async () => {
    const res = await post(GOOD);
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("");
    expect(recorded).toEqual([GOOD]);
  });

  it("answers the same 204 whatever it did, so a prober learns nothing", async () => {
    const statuses = [
      (await post(GOOD, { dnt: "1" })).status, (await post(GOOD, { "sec-gpc": "1" })).status, (await post(GOOD, { "user-agent": "Googlebot/2.1" })).status,
      (await post(GOOD, { origin: "https://evil.example" })).status, (await post("not json")).status, (await post({ ...GOOD, path: "/x".repeat(60) })).status,
    ];
    expect(new Set(statuses)).toEqual(new Set([204]));
    expect(recorded).toEqual([]);
  });

  it("counts nothing from another site, a program, an opted-out browser or a request with no origin", async () => {
    await post(GOOD, { origin: "https://evil.example" });
    await post(GOOD, { "user-agent": "curl/8" });
    await post(GOOD, { dnt: "1" });
    await post(GOOD, { "sec-gpc": "1" });
    const noOrigin = new Request("https://nightshift.example/api/pv", { method: "POST", body: JSON.stringify(GOOD), headers: { "user-agent": CHROME } });
    expect((await POST(noOrigin)).status).toBe(204);
    expect(recorded).toEqual([]);
  });

  it("refuses a malformed or oversized body and never stores more than the four fields", async () => {
    await post("{");
    await post(JSON.stringify({ ...GOOD, pad: "x".repeat(2000) }), { "content-length": "2100" });
    await post({ ...GOOD, visitor: "abc123" });
    expect(recorded).toEqual([GOOD]);
  });

  it("stops counting past its per-minute ceiling", async () => {
    for (let i = 0; i < PAGE_VIEW_ROUTE_LIMIT.max + 20; i++) await post(GOOD);
    expect(recorded).toHaveLength(PAGE_VIEW_ROUTE_LIMIT.max);
  });

  it("the ceiling resets with the minute", () => {
    for (let i = 0; i < PAGE_VIEW_ROUTE_LIMIT.max; i++) expect(takePageView(1_000)).toBe(true);
    expect(takePageView(1_000)).toBe(false);
    expect(takePageView(1_000 + 60_000)).toBe(true);
  });

  it("reads no cookie, no address and no header beyond the origin check, the opt-out headers and the bot list", () => {
    const src = readFileSync(join(ROOT, "app/api/pv/route.ts"), "utf8");
    expect(src).not.toMatch(/cookies|x-forwarded-for|cf-connecting-ip|x-real-ip|x-vercel-forwarded-for/i);
    expect(src).not.toMatch(/console\./);
    const lib = readFileSync(join(ROOT, "lib/server/page-views.ts"), "utf8");
    expect(lib).not.toMatch(/console\.|cookies/);
  });
});

describe("the page side sets nothing and stores nothing", () => {
  const src = readFileSync(join(ROOT, "components/site/PageViewBeacon.tsx"), "utf8");
  it("uses no cookie and no localStorage or sessionStorage, sends no credentials, and sends only the four fields", () => {
    expect(src).not.toMatch(/document\.cookie|localStorage|sessionStorage|indexedDB|userAgent|navigator\.(?:language|platform|plugins)|screen\.|canvas|crypto\./);
    expect(src).toContain('credentials: "omit"');
    expect(src).toMatch(/optedOutInBrowser/);
  });

  it("posts to the route the gate leaves public, and that path is the one the page names", () => {
    expect(PAGE_VIEW_ENDPOINT).toBe(PAGE_VIEW_PATH);
    expect(isPublicApiPath(PAGE_VIEW_PATH)).toBe(true);
    expect(gateDecision(PAGE_VIEW_PATH, false)).toBe("pass");
    // exact: nothing under or beside it is opened
    for (const p of ["/api/pv/x", "/api/pvx", "/api/pv.json"]) expect(isPublicApiPath(p)).toBe(false);
  });

  it("is mounted by the public frame only, never by the signed-in app", () => {
    expect(readFileSync(join(ROOT, "components/legal/PublicShell.tsx"), "utf8")).toContain("<PageViewBeacon />");
    for (const f of ["app/(app)/layout.tsx", "app/welcome/layout.tsx"]) expect(readFileSync(join(ROOT, f), "utf8")).not.toContain("PageViewBeacon");
  });
});

describe("the database side agrees with the app", () => {
  const sql = readFileSync(join(ROOT, "..", "supabase", "migrations", "0101_site_page_views.sql"), "utf8");
  it("counts exactly the sitemap's pages (SQL closed list == SITEMAP_PATHS)", () => {
    const list = sql.match(/site_page_path_ok\(p text\)[\s\S]*?array\[([\s\S]*?)\]\)/)![1];
    const sqlPaths = [...list.matchAll(/'(\/[a-z/-]*)'/g)].map((m) => m[1]);
    expect(sqlPaths.sort()).toEqual([...SITEMAP_PATHS].sort());
  });
});
