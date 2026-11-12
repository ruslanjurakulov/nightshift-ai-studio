/**
 * The country table (docs/GEO_BLOCK.md): DB-IP's "IP to Country Lite" ranges in the compact "NSG1" form tools/geoip_build.py writes,
 * and the lookup of one address. Pure: no file, no network, no Node API, so the tests run it on a fixture and the server half
 * (lib/server/geo.ts) only reads the file once.
 *
 * Every answer that is not a country is null, never a guess: an address that does not parse, a private, local or reserved one (no
 * country can be known for it), DB-IP's own "ZZ", and a table that is not one. The caller treats null as "unknown" and allows.
 */

export interface GeoTable {
  /** IPv4 range starts, ascending. */
  v4: Uint32Array;
  /** The code index of each IPv4 range. */
  v4c: Uint8Array;
  /** IPv6 range starts, ascending, four 32-bit words per range (most significant first). */
  v6: Uint32Array;
  v6c: Uint8Array;
  codes: string[];
}

const MAGIC = "NSG1";

/** Parses an uncompressed "NSG1" table. Throws on anything else: a damaged file is a deploy error, never "every country is unknown" in silence. */
export function parseGeoTable(buf: Uint8Array): GeoTable {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 14 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== MAGIC) throw new Error("not a country table");
  const n4 = view.getUint32(4);
  const n6 = view.getUint32(8);
  const nc = view.getUint16(12);
  let at = 14;
  const need = at + nc * 2 + n4 * 5 + n6 * 17;
  if (buf.byteLength !== need || n4 === 0 || n6 === 0) throw new Error("country table has the wrong length");
  const codes: string[] = [];
  for (let i = 0; i < nc; i++, at += 2) codes.push(String.fromCharCode(buf[at], buf[at + 1]));
  const v4 = new Uint32Array(n4);
  for (let i = 0; i < n4; i++, at += 4) v4[i] = view.getUint32(at);
  const v4c = buf.slice(at, at + n4);
  at += n4;
  const v6 = new Uint32Array(n6 * 4);
  for (let i = 0; i < n6 * 4; i++, at += 4) v6[i] = view.getUint32(at);
  const v6c = buf.slice(at, at + n6);
  for (const c of [...v4c, ...v6c]) if (c >= nc) throw new Error("country table names a code it does not list");
  if (v4[0] !== 0 || v6[0] !== 0 || v6[1] !== 0 || v6[2] !== 0 || v6[3] !== 0) throw new Error("country table does not start at zero");
  return { v4, v4c, v6, v6c, codes };
}

export type ParsedIp = { v: 4; n: number } | { v: 6; w: [number, number, number, number] };

const V4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function v4(s: string): number | null {
  if (!V4_RE.test(s)) return null;
  return s.split(".").reduce((acc, p) => acc * 256 + Number(p), 0) >>> 0;
}

/** An IPv4 or IPv6 address as written (no port, no brackets, no zone). Anything else is null. */
export function parseIp(raw: string): ParsedIp | null {
  const s = raw.trim();
  if (!s || s.length > 45) return null;
  const four = v4(s);
  if (four !== null) return { v: 4, n: four };
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(":")) return null;
  let head = s;
  let tail: number[] = [];
  // An IPv4 tail (::ffff:203.0.113.9) is the last two groups.
  const lastColon = s.lastIndexOf(":");
  const after = s.slice(lastColon + 1);
  if (after.includes(".")) {
    const t = v4(after);
    if (t === null) return null;
    tail = [t >>> 16, t & 0xffff];
    head = s.slice(0, lastColon + 1);
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const group = (g: string) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN);
  const left = halves[0] ? halves[0].split(":").map(group) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map(group) : [];
  if ([...left, ...right].some((g) => Number.isNaN(g))) return null;
  const given = left.length + right.length + tail.length;
  let groups: number[];
  if (halves.length === 2) {
    if (given > 7) return null;
    groups = [...left, ...new Array(8 - given).fill(0), ...right, ...tail];
  } else {
    if (given !== 8) return null;
    groups = [...left, ...tail];
  }
  const w: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) w[i] = ((groups[2 * i] << 16) | groups[2 * i + 1]) >>> 0;
  // An IPv4-mapped address is that IPv4 address (Node reports a v4 peer on a dual-stack socket this way).
  if (w[0] === 0 && w[1] === 0 && w[2] === 0xffff) return { v: 4, n: w[3] };
  return { v: 6, w };
}

const inV4 = (n: number, base: string, bits: number) => {
  const b = v4(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
};

/** Addresses no country can be known for: private, loopback, link-local, shared (CGNAT), documentation, benchmarking, multicast, reserved. */
const V4_NOT_PUBLIC: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

export function isPublicIp(ip: ParsedIp): boolean {
  if (ip.v === 4) return !V4_NOT_PUBLIC.some(([b, bits]) => inV4(ip.n, b, bits));
  const [a, b] = ip.w;
  const top16 = a >>> 16;
  if (ip.w.every((x) => x === 0)) return false;                                        // ::
  if (a === 0 && b === 0 && ip.w[2] === 0 && ip.w[3] === 1) return false;               // ::1
  if ((top16 & 0xfe00) === 0xfc00) return false;                                        // fc00::/7 unique local
  if ((top16 & 0xffc0) === 0xfe80) return false;                                        // fe80::/10 link-local
  if ((top16 & 0xff00) === 0xff00) return false;                                        // ff00::/8 multicast
  if (a === 0x20010db8) return false;                                                   // 2001:db8::/32 documentation
  if (a === 0x0064ff9b && b === 0) return false;                                        // 64:ff9b::/96 NAT64 (the v4 is inside)
  if ((a >>> 16) === 0x2002) return false;                                              // 2002::/16 6to4 relay
  return (top16 & 0xe000) === 0x2000;                                                   // only 2000::/3 is global unicast
}

function cmp6(t: Uint32Array, row: number, w: readonly number[]): number {
  for (let k = 0; k < 4; k++) {
    const x = t[row * 4 + k];
    if (x !== w[k]) return x < w[k] ? -1 : 1;
  }
  return 0;
}

/** The ISO 3166-1 alpha-2 code for a public address, or null (see the file's header). */
export function lookupCountry(table: GeoTable, raw: string): string | null {
  const ip = parseIp(raw);
  if (!ip || !isPublicIp(ip)) return null;
  let lo = 0;
  let idx: number;
  if (ip.v === 4) {
    let hi = table.v4.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (table.v4[mid] <= ip.n) lo = mid;
      else hi = mid - 1;
    }
    idx = table.v4c[lo];
  } else {
    let hi = table.v6c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (cmp6(table.v6, mid, ip.w) <= 0) lo = mid;
      else hi = mid - 1;
    }
    idx = table.v6c[lo];
  }
  const code = table.codes[idx];
  return code && code !== "ZZ" && /^[A-Z]{2}$/.test(code) ? code : null;
}
