/**
 * Blocking a model by the requester's country (docs/GEO_BLOCK.md).
 *
 * What would break without these: an address read as the wrong country (the fixture is shared with tests/test_geoip_build.py, so
 * the Python writer and this reader cannot drift apart); a private or local address given a country; a client's own
 * X-Forwarded-For / X-Real-IP / CF-Connecting-IP believed (any visitor could pick their country); an unknown country refused (or a
 * known one let through); the picker offering a model the routes refuse; the refusal naming the vendor or its terms; the twin of the
 * registry's lists drifting from schemas/model_registry.json; and the Caddyfile no longer writing the one header this trusts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { isPublicIp, lookupCountry, parseGeoTable, parseIp } from "@/lib/geo/table";
import { CLIENT_IP_HEADER, trustedClientIp } from "@/lib/geo/client-ip";
import { BLOCKED_COUNTRIES, blockedCountriesOf, isBlockedIn, withoutBlocked } from "@/lib/geo/blocked";
import { GEO_TABLE_PATH, geoRefusal, hideBlockedModels, loadGeoTable, readCountry } from "@/lib/server/geo";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const FIX = join(__dirname, "fixtures");
const TABLE = parseGeoTable(new Uint8Array(readFileSync(join(FIX, "geoip-fixture.bin"))));
const ROOT = join(__dirname, "..", "..");
const h = (v: Record<string, string>) => new Headers(v);
const MAP = { "pic-geo": ["IN", "RU"] } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the country of an address (the fixture table)", () => {
  it("reads every fixture row the way the CSV says, in both families", () => {
    const want: Array<[string, string | null]> = [
      ["1.0.0.1", "AU"], ["1.0.1.0", "US"], ["5.255.255.255", "US"], ["6.1.2.3", "IN"], ["7.7.7.7", "UZ"],
      ["8.8.8.8", "US"], ["8.8.9.1", "RU"], ["9.255.255.255", "RU"], ["11.0.0.1", null], ["0.1.2.3", null],
      ["2001:e00::1", "IN"], ["2001:e00:ffff::", "IN"], ["2001:e01::", "DE"], ["2a00:1450::200e", "DE"], ["2a01::1", "UZ"],
      ["2a01::ffff", "UZ"], ["2a01::1:0", null], ["2001:470::1", null],
      ["::ffff:6.1.2.3", "IN"],
    ];
    for (const [ip, c] of want) expect([ip, lookupCountry(TABLE, ip)]).toEqual([ip, c]);
  });

  it("gives no country to a private, local or reserved address", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0",
      "192.0.2.1", "198.51.100.1", "203.0.113.9", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12:3456::1",
      "fe80::1", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1"]) {
      const p = parseIp(ip);
      expect([ip, p !== null && isPublicIp(p)]).toEqual([ip, false]);
      expect(lookupCountry(TABLE, ip)).toBeNull();
    }
    expect(isPublicIp(parseIp("172.32.0.1")!)).toBe(true);
  });

  it("refuses what is not one address", () => {
    for (const s of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.4:443", "[2001:e00::1]", "2001:e00::1%eth0",
      "1::2::3", "12345::", "1:2:3:4:5:6:7:8:9", "example.com", "1.2.3.4, 5.6.7.8"]) {
      expect([s, parseIp(s)]).toEqual([s, null]);
    }
    expect(parseIp("1:2:3:4:5:6:7:8")).toEqual({ v: 6, w: [0x10002, 0x30004, 0x50006, 0x70008] });
    expect(parseIp("::1.2.3.4")).toEqual({ v: 6, w: [0, 0, 0, 0x01020304] });
  });

  it("refuses a damaged table instead of reading every country as unknown in silence", () => {
    const good = new Uint8Array(readFileSync(join(FIX, "geoip-fixture.bin")));
    expect(() => parseGeoTable(good.slice(0, good.length - 1))).toThrow();
    const bad = good.slice();
    bad[0] = 0x58;
    expect(() => parseGeoTable(bad)).toThrow();
  });
});

describe("whose address it is", () => {
  it("reads only the header Caddy writes, never one a client can send", () => {
    expect(trustedClientIp(h({ [CLIENT_IP_HEADER]: "6.1.2.3" }))).toBe("6.1.2.3");
    // A visitor who sends the usual headers (directly, or through Caddy, which passes them on) is not believed.
    const spoofed = h({ "x-forwarded-for": "6.1.2.3", "x-real-ip": "6.1.2.3", "cf-connecting-ip": "6.1.2.3", "true-client-ip": "6.1.2.3" });
    expect(trustedClientIp(spoofed)).toBeNull();
    expect(readCountry(spoofed, () => TABLE)).toEqual({ country: null, why: "no_address" });
    // Caddy's header wins over every other one sent beside it.
    expect(readCountry(h({ "x-forwarded-for": "6.1.2.3", [CLIENT_IP_HEADER]: "7.7.7.7" }), () => TABLE)).toEqual({ country: "UZ", why: "found" });
    // A list, or garbage, is not an address Caddy wrote.
    expect(trustedClientIp(h({ [CLIENT_IP_HEADER]: "6.1.2.3, 7.7.7.7" }))).toBeNull();
    expect(trustedClientIp(h({ [CLIENT_IP_HEADER]: "unknown" }))).toBeNull();
  });

  it("a private or local address is unknown, and so is one without a table", () => {
    expect(readCountry(h({ [CLIENT_IP_HEADER]: "172.18.0.3" }), () => TABLE)).toEqual({ country: null, why: "not_public" });
    expect(readCountry(h({ [CLIENT_IP_HEADER]: "11.0.0.1" }), () => TABLE)).toEqual({ country: null, why: "not_in_table" });
    expect(readCountry(h({ [CLIENT_IP_HEADER]: "6.1.2.3" }), () => null)).toEqual({ country: null, why: "no_table" });
  });

  it("the Caddyfile writes that header on every request, from Cloudflare's address only when Cloudflare connected", () => {
    const caddy = readFileSync(join(ROOT, "deploy", "Caddyfile"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(caddy).toContain("request_header @viaCloudflare X-Nightshift-Client-IP {http.request.header.CF-Connecting-IP}");
    expect(caddy).toContain("request_header @notViaCloudflare X-Nightshift-Client-IP {remote_host}");
    const ranges = (name: string) => caddy.match(new RegExp(`@${name} (not )?remote_ip ([^\\n]+)`))!;
    expect(ranges("viaCloudflare")[1]).toBeUndefined();
    expect(ranges("notViaCloudflare")[1]).toBe("not ");
    expect(ranges("notViaCloudflare")[2]).toBe(ranges("viaCloudflare")[2]);
    expect(ranges("viaCloudflare")[2]).toContain("173.245.48.0/20");
    expect(ranges("viaCloudflare")[2]).toContain("2606:4700::/32");
  });
});

describe("the refusal and the picker", () => {
  const warn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("refuses a model in a country on its list, and nothing else", () => {
    warn();
    expect(geoRefusal("pic-geo", h({ [CLIENT_IP_HEADER]: "6.1.2.3" }), MAP, () => TABLE)).toEqual({ status: 451, body: { error: "country_blocked" } });
    expect(geoRefusal("pic-geo", h({ [CLIENT_IP_HEADER]: "2001:e00::1" }), MAP, () => TABLE)?.status).toBe(451);
    expect(geoRefusal("pic-geo", h({ [CLIENT_IP_HEADER]: "8.8.9.1" }), MAP, () => TABLE)?.status).toBe(451);
    expect(geoRefusal("pic-geo", h({ [CLIENT_IP_HEADER]: "7.7.7.7" }), MAP, () => TABLE)).toBeNull();
    expect(geoRefusal("pic-other", h({ [CLIENT_IP_HEADER]: "6.1.2.3" }), MAP, () => TABLE)).toBeNull();
  });

  it("allows, and logs, when the country is unknown; a model with no list reads nothing at all", () => {
    const w = warn();
    expect(geoRefusal("pic-geo", h({ "x-forwarded-for": "6.1.2.3" }), MAP, () => TABLE)).toBeNull();
    expect(geoRefusal("pic-geo", h({ [CLIENT_IP_HEADER]: "10.0.0.5" }), MAP, () => TABLE)).toBeNull();
    expect(geoRefusal("pic-geo", h({ [CLIENT_IP_HEADER]: "6.1.2.3" }), MAP, () => null)).toBeNull();
    expect(w).toHaveBeenCalledTimes(3);
    // The address is personal data: the log names the reason, never the address.
    for (const call of w.mock.calls) expect(call.join(" ")).not.toMatch(/6\.1\.2\.3|10\.0\.0\.5/);
    const load = vi.fn(() => TABLE);
    expect(geoRefusal("pic-other", h({ [CLIENT_IP_HEADER]: "6.1.2.3" }), MAP, load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("the picker hides the model where it is refused, and only there", () => {
    warn();
    const models = [{ id: "pic-geo" }, { id: "pic-other" }];
    expect(hideBlockedModels(models, h({ [CLIENT_IP_HEADER]: "6.1.2.3" }), MAP, () => TABLE).map((m) => m.id)).toEqual(["pic-other"]);
    expect(hideBlockedModels(models, h({ [CLIENT_IP_HEADER]: "7.7.7.7" }), MAP, () => TABLE).map((m) => m.id)).toEqual(["pic-geo", "pic-other"]);
    expect(hideBlockedModels(models, h({}), MAP, () => TABLE).map((m) => m.id)).toEqual(["pic-geo", "pic-other"]);
    const load = vi.fn(() => TABLE);
    expect(hideBlockedModels([{ id: "pic-other" }], h({ [CLIENT_IP_HEADER]: "6.1.2.3" }), MAP, load)).toEqual([{ id: "pic-other" }]);
    expect(load).not.toHaveBeenCalled();
    expect(withoutBlocked(models, null, MAP)).toEqual(models);
    expect(isBlockedIn("pic-geo", null, MAP)).toBe(false);
  });

  it("says so in Uzbek, Russian and English, without the vendor, its terms or a superlative", () => {
    const words = [uz.creative.errors.country_blocked, ru.creative.errors.country_blocked, en.creative.errors.country_blocked];
    for (const w of words) {
      expect(w.length).toBeGreaterThan(10);
      expect(w).not.toMatch(/meta|muse|terms|licen|India|Hindiston|Индия|law|qonun|закон|best|eng yaxshi|лучш/i);
    }
    // Uzbek oʻ / gʻ with U+02BB and the tutuq belgisi with U+02BC: never a typewriter or curly quote.
    expect(uz.creative.errors.country_blocked).toContain("Roʻyxatdan");
    expect(uz.creative.errors.country_blocked).not.toMatch(/['‘’`]/);
    expect(en.creative.errors.country_blocked).not.toMatch(/'/);
  });
});

describe("the DB-IP credit", () => {
  it("is on the Studio page, linked to db-ip.com, in all three languages, once a model has a country list", () => {
    const page = readFileSync(join(__dirname, "..", "app", "(app)", "[channel]", "create", "page.tsx"), "utf8");
    expect(page).toContain("Object.keys(BLOCKED_COUNTRIES).length > 0");
    expect(page).toContain('href="https://db-ip.com"');
    expect(page).toContain("{t.create.geoAttribution}");
    expect(en.create.geoAttribution).toBe("IP Geolocation by DB-IP");
    expect(uz.create.geoAttribution).toContain("DB-IP");
    expect(ru.create.geoAttribution).toContain("DB-IP");
  });
});

describe("the shipped table and the registry's lists", () => {
  it("loads the shipped table once and reads a well-known block", () => {
    const path = join(__dirname, "..", "data", "geoip", "country.bin.gz");
    expect(GEO_TABLE_PATH.endsWith(join("data", "geoip", "country.bin.gz"))).toBe(true);
    const t = loadGeoTable(path);
    expect(t).not.toBeNull();
    expect(lookupCountry(t!, "1.0.0.1")).toBe("AU");
    expect(loadGeoTable(path)).toBe(t);
  });

  it("a missing or damaged table reads as unknown, logged, never a crash", () => {
    const e = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "geo-"));
    writeFileSync(join(dir, "bad.bin.gz"), gzipSync(Buffer.from("not a table")));
    expect(loadGeoTable(join(dir, "bad.bin.gz"))).toBeNull();
    expect(loadGeoTable(join(dir, "bad.bin.gz"))).toBeNull();
    expect(loadGeoTable(join(dir, "missing.bin.gz"))).toBeNull();
    expect(e).toHaveBeenCalledTimes(2);
  });

  it("BLOCKED_COUNTRIES is the twin of the registry's blocked_countries", () => {
    const reg = JSON.parse(readFileSync(join(ROOT, "schemas", "model_registry.json"), "utf8")) as { models: Array<{ id: string; blocked_countries?: string[] }> };
    const fromFile = Object.fromEntries(reg.models.filter((m) => m.blocked_countries?.length).map((m) => [m.id, [...m.blocked_countries!].sort()]));
    const twin = Object.fromEntries(Object.entries(BLOCKED_COUNTRIES).map(([k, v]) => [k, [...v].sort()]));
    expect(twin).toEqual(fromFile);
    for (const [id, list] of Object.entries(BLOCKED_COUNTRIES)) {
      expect(list.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
      expect(blockedCountriesOf(id)).toBe(list);
    }
  });
});
