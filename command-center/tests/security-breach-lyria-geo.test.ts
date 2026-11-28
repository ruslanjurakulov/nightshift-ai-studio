/**
 * Breach on S6 (Google Lyria 3.5 joins GOOGLE_MODELS): the web country gate for an ALLOW-list vendor, attacked in the lab (a country
 * table built in the test, no network, no database).
 *
 * Open (FAILING until fixed):
 *   BR-S6-03  geoRefusal (lib/server/geo.ts) decides an allow-list model with `list.includes(country)` on GOOGLE_BLOCKED, and
 *     GOOGLE_BLOCKED is "every ISO 3166-1 code Google does not list". A two-letter reading that is neither an ISO code nor Google's XK
 *     (DB-IP's own placeholders such as "EU" or "AP" in other editions; tools/geoip_build.py accepts any two capital letters) is in
 *     neither set, so the Create gate ALLOWS it: unknown becomes allowed for Lyria and every other Google model. The chat gate
 *     (lib/server/brain/google-gate.ts chatGateDecision, last line) already refuses exactly this case as country_unverified, so the
 *     two gates disagree about the same reading. withoutBlocked (lib/geo/blocked.ts) shows the model in the picker for it too.
 *     0208's database trigger is also a deny-list (`lst ? c`), so it does not catch it either.
 *   Severity guess: LOW (latent). The table shipped today (data/geoip/country.bin.gz) holds 251 codes, and the only two outside ISO
 *     are XK (Google-listed) and ZZ (read as unknown), so no address maps to such a code now; a table refresh could add one silently.
 *
 * Held: a missing or spoofed address header (only Caddy's X-Nightshift-Client-IP is read; X-Forwarded-For, X-Real-IP, CF-Connecting-IP
 *   and True-Client-IP are ignored), a list of addresses, a private address, ZZ, and RU are all refused for Lyria.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { parseGeoTable, type GeoTable } from "@/lib/geo/table";
import { CLIENT_IP_HEADER } from "@/lib/geo/client-ip";
import { withoutBlocked } from "@/lib/geo/blocked";
import { geoRefusal } from "@/lib/server/geo";

const LYRIA = "google-lyria-3.5";

/** A two-range IPv4 table: 0.0.0.0/1 reads `low`, 128.0.0.0/1 reads `high` (tools/geoip_build.py's NSG1 format). */
function table(low: string, high: string): GeoTable {
  const codes = [low, high];
  const buf = new Uint8Array(14 + codes.length * 2 + 2 * 5 + 1 * 17);
  const view = new DataView(buf.buffer);
  buf.set([0x4e, 0x53, 0x47, 0x31]);
  view.setUint32(4, 2);
  view.setUint32(8, 1);
  view.setUint16(12, codes.length);
  let at = 14;
  for (const c of codes) { buf[at++] = c.charCodeAt(0); buf[at++] = c.charCodeAt(1); }
  view.setUint32(at, 0); at += 4;
  view.setUint32(at, 0x80000000); at += 4;
  buf[at++] = 0; buf[at++] = 1;
  at += 16;          // one IPv6 range from ::
  buf[at++] = 0;
  return parseGeoTable(buf);
}

const from = (ip: string, extra: Record<string, string> = {}) => new Headers({ [CLIENT_IP_HEADER]: ip, ...extra });

describe("BR-S6-03: a country code that is neither blocked nor one of Google's regions", () => {
  it.each(["EU", "AP", "QQ"])("%s is refused for Lyria as unverified, as the chat gate refuses it", (code) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = table(code, "UZ");
    expect(geoRefusal(LYRIA, from("8.8.8.8"), undefined, () => t, true)).toEqual({ status: 451, body: { error: "country_unverified" } });
  });

  it("is hidden from the picker for that reading", () => {
    expect(withoutBlocked([{ id: LYRIA }], "EU")).toEqual([]);
  });
});

describe("held: what the Lyria gate trusts", () => {
  const t = table("RU", "UZ");
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("a visitor's own forwarding headers are not read; only the proxy's header is", () => {
    quiet();
    const spoof = { "x-forwarded-for": "200.0.0.1", "x-real-ip": "200.0.0.1", "cf-connecting-ip": "200.0.0.1", "true-client-ip": "200.0.0.1" };
    expect(geoRefusal(LYRIA, new Headers(spoof), undefined, () => t, true)).toEqual({ status: 451, body: { error: "country_unverified" } });
    expect(geoRefusal(LYRIA, from("8.8.8.8", spoof), undefined, () => t, true)).toEqual({ status: 451, body: { error: "country_blocked" } });
  });

  it.each(["8.8.8.8, 200.0.0.1", "200.0.0.1 8.8.8.8", "10.0.0.1", "127.0.0.1", ""])("%j is never read as Uzbekistan", (ip) => {
    quiet();
    expect(geoRefusal(LYRIA, from(ip), undefined, () => t, true)).not.toBeNull();
  });

  it("an address DB-IP marks unknown (ZZ) and a missing table are refused, even outside strict production", () => {
    quiet();
    expect(geoRefusal(LYRIA, from("8.8.8.8"), undefined, () => table("ZZ", "UZ"), false)).toEqual({ status: 451, body: { error: "country_unverified" } });
    expect(geoRefusal(LYRIA, from("200.0.0.1"), undefined, () => null, false)).toEqual({ status: 451, body: { error: "country_unverified" } });
    expect(geoRefusal(LYRIA, from("200.0.0.1"), undefined, () => t, false)).toBeNull();
  });
});
