/**
 * The brand scan (docs/ADS_FACTORY.md, Phase 2; migration 0133), shared by its routes and its panel. Pure: no request, no React.
 *
 * Switch: NIGHTSHIFT_ADS_BRAND_SCAN (server-side, read per request, default OFF), on top of NIGHTSHIFT_ADS_FACTORY. Off = the panel is
 * not drawn and every /api/ads/scan route answers 404 before it reads the session.
 *
 * What the browser does here: it asks for a TXT token, asks for a DNS check, asks for a priced scan, and accepts fields. It never
 * opens the site, never resolves a name, never renders anything the scan read as HTML (every value is text, a colour reaches a style
 * only as a checked #rrggbb, a picture is a library asset of the organization), and never links to the scanned site.
 */

export const ADS_BRAND_SCAN_FLAG = "NIGHTSHIFT_ADS_BRAND_SCAN";

export function adsBrandScanEnabled(raw: string | undefined = process.env.NIGHTSHIFT_ADS_BRAND_SCAN): boolean {
  return ["on", "1", "true", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseScanId(raw: unknown): string | null {
  return typeof raw === "string" && UUID.test(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : null;
}

/** 0133's ads_hosting_parent (and modules/brand_fetch.HOSTING_PARENTS): not one site, and nobody owns it. Pinned equal by a test. */
export const HOSTING_PARENTS = [
  "myshopify.com", "github.io", "vercel.app", "netlify.app", "herokuapp.com", "s3.amazonaws.com", "blogspot.com", "pages.dev", "web.app",
  "firebaseapp.com", "azurewebsites.net",
] as const;
export const COUNTRY_SECOND_LEVEL = ["ac", "co", "com", "edu", "gov", "ltd", "me", "mil", "net", "nic", "or", "org", "plc", "sch"] as const;
/** 0133's ads_scan_host_ok shape (a lower-case DNS name, letters or punycode last, no underscore, no port). */
export const HOST_PATTERN = String.raw`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$`;
const HOST_RE = new RegExp(HOST_PATTERN);

export function isHostingParent(host: string): boolean {
  if ((HOSTING_PARENTS as readonly string[]).includes(host)) return true;
  const parts = host.split(".");
  return parts.length === 2 && /^[a-z]{2}$/.test(parts[1]) && (COUNTRY_SECOND_LEVEL as readonly string[]).includes(parts[0]);
}

export type HostParse = { ok: true; host: string } | { ok: false; error: "invalid_host" | "hosting_parent" };

/**
 * What a person typed as their domain, as the host 0133 stores: "https://Shop.Example.com/about" and "shop.example.com." are
 * "shop.example.com". Only a scheme, a path and one final dot are taken off; anything else that is not the shape is refused, never
 * repaired (a port, a user name, an IP literal, an underscore, non-ASCII: an international name must be typed in punycode, xn--).
 */
export function parseScanHost(raw: unknown): HostParse {
  if (typeof raw !== "string") return { ok: false, error: "invalid_host" };
  let s = raw.trim().toLowerCase();
  if (s.startsWith("https://")) s = s.slice(8);
  else if (s.startsWith("http://")) s = s.slice(7);
  const cut = s.search(/[/?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.length < 4 || s.length > 253 || !HOST_RE.test(s)) return { ok: false, error: "invalid_host" };
  if (isHostingParent(s)) return { ok: false, error: "hosting_parent" };
  return { ok: true, host: s };
}

/** 0131's site shape (ads_site_url_ok), which request_brand_scan holds the scan's URL to, and no backslash. */
export const SCAN_URL_RE = /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})(\/[\x21-\x7e]*)?$/;
export function parseScanUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return s.length >= 12 && s.length <= 300 && SCAN_URL_RE.test(s) && !s.includes("\\") ? s : null;
}

/** The host of a scan URL (already shape-checked), or null. */
export function scanUrlHost(url: string): string | null {
  const m = /^https:\/\/([^/]+)/.exec(url);
  return m ? m[1] : null;
}

/** Is ``host`` the verified domain or one of its subdomains (what request_brand_scan accepts)? */
export function coveredBy(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export const IDEM_RE = /^[A-Za-z0-9_:.-]{8,128}$/;

// ── what the routes read ────────────────────────────────────────────────────────────────────────────────────────────

export const CHECK_CODES = ["verified", "mismatch", "no_record", "dns_error", "timeout", "expired", "worker_lost"] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

export interface BrandDomain {
  id: string;
  host: string;
  recordName: string;
  recordValue: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckCode: CheckCode | "other" | null;
  /** A check was asked for and the worker has not answered it yet. */
  pending: boolean;
}

const TOKEN = /^[0-9a-f]{32}$/;
const ISO = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

export function coerceDomains(rows: unknown, pendingIds: ReadonlySet<string>): BrandDomain[] {
  if (!Array.isArray(rows)) return [];
  const out: BrandDomain[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const id = parseScanId(r?.id);
    const host = typeof r?.host === "string" && HOST_RE.test(r.host) ? r.host : null;
    const token = typeof r?.token === "string" && TOKEN.test(r.token) ? r.token : null;
    if (!id || !host || !token) continue;
    const code = typeof r.last_check_code === "string" ? r.last_check_code : null;
    out.push({
      id, host, recordName: `_nightshift.${host}`, recordValue: `nightshift-verify=${token}`, verifiedAt: ISO(r.verified_at),
      lastCheckedAt: ISO(r.last_checked_at),
      lastCheckCode: code === null ? null : (CHECK_CODES as readonly string[]).includes(code) ? (code as CheckCode) : "other",
      pending: pendingIds.has(id),
    });
  }
  return out;
}

export const SCAN_STATUSES = ["requested", "running", "ready", "failed"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** Where a proposed field came from: 0133's closed list of places. */
export const SCAN_PLACES = [
  "title", "meta_description", "og_site_name", "og_title", "og_description", "og_image", "twitter_title", "twitter_description",
  "twitter_image", "jsonld_organization", "jsonld_product", "icon", "apple_touch_icon", "theme_color", "css", "logo_palette",
] as const;
export type ScanPlace = (typeof SCAN_PLACES)[number];

export interface ScanSource {
  /** Shown as TEXT, never as a link: nothing here opens the scanned site. */
  url: string;
  where: ScanPlace;
}
export interface Proposed<T> {
  value: T;
  source: ScanSource;
}
export interface ScanProduct {
  title: Proposed<string>;
  description: Proposed<string> | null;
  price: Proposed<string> | null;
  image: Proposed<string> | null;
}
export interface ScanFields {
  name: Proposed<string> | null;
  description: Proposed<string> | null;
  logo: Proposed<string> | null;
  palette: Proposed<string[]> | null;
  fonts: Proposed<string[]> | null;
  themeColor: Proposed<string> | null;
}
export interface BrandScan {
  id: string;
  url: string;
  status: ScanStatus;
  errorCode: string | null;
  credits: number | null;
  charged: number | null;
  createdAt: string | null;
  fields: ScanFields;
  products: ScanProduct[];
  pages: string[];
  notes: { code: string; url: string | null }[];
  accepted: string[];
  kitId: string | null;
}

const URL_RE = /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})(\/[\x21-\x7e]*)?$/;
const urlOk = (v: unknown): v is string => typeof v === "string" && v.length <= 2048 && URL_RE.test(v) && !v.includes("\\");
const HEX = /^#[0-9a-f]{6}$/;
const FONT = /^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,59}$/;
const CODE = /^[a-z0-9_]{1,64}$/;

function source(raw: unknown): ScanSource | null {
  const s = raw as { url?: unknown; where?: unknown } | null;
  if (!s || typeof s !== "object" || !urlOk(s.url) || typeof s.where !== "string" || !(SCAN_PLACES as readonly string[]).includes(s.where)) return null;
  return { url: s.url, where: s.where as ScanPlace };
}

function field<T>(raw: unknown, value: (v: unknown) => T | null): Proposed<T> | null {
  const f = raw as { value?: unknown; source?: unknown } | null;
  if (!f || typeof f !== "object") return null;
  const v = value(f.value);
  const src = source(f.source);
  return v === null || !src ? null : { value: v, source: src };
}

const text = (max: number) => (v: unknown) => (typeof v === "string" && v.length >= 1 && v.length <= max ? v : null);
const asset = (v: unknown) => parseScanId(v);
const colour = (v: unknown) => (typeof v === "string" && HEX.test(v) ? v : null);
const colours = (v: unknown) => (Array.isArray(v) && v.length >= 1 && v.length <= 8 && v.every((c) => typeof c === "string" && HEX.test(c)) ? (v as string[]) : null);
const fonts = (v: unknown) => (Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((c) => typeof c === "string" && FONT.test(c)) ? (v as string[]) : null);

/** A scan row as the panel shows it. A value of the wrong shape is dropped (never shown, never offered), not repaired. */
export function coerceScan(r: Record<string, unknown> | null | undefined): BrandScan | null {
  const id = parseScanId(r?.id);
  const status = typeof r?.status === "string" && (SCAN_STATUSES as readonly string[]).includes(r.status) ? (r.status as ScanStatus) : null;
  const url = typeof r?.url === "string" && urlOk(r.url) ? r.url : null;
  if (!r || !id || !status || !url) return null;
  const res = (r.result && typeof r.result === "object" ? r.result : {}) as Record<string, unknown>;
  const f = (res.fields && typeof res.fields === "object" ? res.fields : {}) as Record<string, unknown>;
  const products = Array.isArray(res.products) ? (res.products as Record<string, unknown>[]) : [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
  return {
    id,
    url,
    status,
    errorCode: typeof r.error_code === "string" && CODE.test(r.error_code) ? r.error_code : null,
    credits: num(r.price_credits),
    charged: num(r.charged_credits),
    createdAt: ISO(r.created_at),
    fields: {
      name: field(f.name, text(80)),
      description: field(f.description, text(1000)),
      logo: field(f.logo, asset),
      palette: field(f.palette, colours),
      fonts: field(f.fonts, fonts),
      themeColor: field(f.theme_color, colour),
    },
    products: products.slice(0, 8).flatMap((p) => {
      const title = field(p?.title, text(120));
      if (!title) return [];
      return [{ title, description: field(p.description, text(1000)), price: field(p.price, text(40)), image: field(p.image, asset) }];
    }),
    pages: (Array.isArray(res.pages) ? res.pages : []).filter(urlOk).slice(0, 6),
    notes: (Array.isArray(res.notes) ? (res.notes as Record<string, unknown>[]) : [])
      .filter((n) => typeof n?.code === "string" && CODE.test(n.code))
      .slice(0, 20)
      .map((n) => ({ code: n.code as string, url: urlOk(n.url) ? n.url : null })),
    accepted: Array.isArray(r.accepted_fields) ? (r.accepted_fields as unknown[]).filter((x): x is string => typeof x === "string" && ACCEPT_FIELD_RE.test(x)) : [],
    kitId: parseScanId(r.kit_id),
  };
}

export const BRAND_SCAN_COLUMNS =
  "id, url, host, status, error_code, result, price_credits, charged_credits, accepted_fields, kit_id, created_at";
export const BRAND_DOMAIN_COLUMNS = "id, host, token, verified_at, last_checked_at, last_check_code, check_requested_at";

export interface ScanQuote {
  onSale: boolean;
  /** What a finished scan is CHARGED (the owner exempted the scan from job_minimum). The scan is started with this as its ceiling. */
  credits: number | null;
  /** What is HELD while the scan runs: the price raised to job_minimum (reserve_credits demands it of every hold); the rest is released. */
  hold: number | null;
  exempt: boolean;
}
export function coerceQuote(raw: unknown): ScanQuote | null {
  const q = raw as { on_sale?: unknown; credits?: unknown; hold?: unknown; exempt?: unknown } | null;
  if (!q || typeof q !== "object" || typeof q.on_sale !== "boolean") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const credits = num(q.credits);
  if (q.on_sale && credits === null) return null;
  if (!q.on_sale) return { onSale: false, credits: null, hold: null, exempt: q.exempt === true };
  // A hold below the price is impossible; one that is missing reads as the price itself (never as a smaller number).
  const hold = num(q.hold) !== null && num(q.hold)! >= credits! ? num(q.hold) : credits;
  return { onSale: true, credits, hold, exempt: q.exempt === true };
}

// ── accepting ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const KIT_FIELDS = ["name", "description", "site_url", "logo", "palette", "theme_color", "fonts"] as const;
export type KitField = (typeof KIT_FIELDS)[number];
export const ACCEPT_FIELD_RE = /^(name|description|site_url|logo|palette|fonts|theme_color|product:[0-7])$/;

/** The fields this scan can offer to accept (only what it proposed; site_url always, it is the scanned address). */
export function offeredFields(scan: BrandScan): string[] {
  const out: string[] = [];
  const f = scan.fields;
  if (f.name) out.push("name");
  if (f.description) out.push("description");
  out.push("site_url");
  if (f.logo) out.push("logo");
  if (f.palette) out.push("palette");
  if (f.themeColor) out.push("theme_color");
  if (f.fonts) out.push("fonts");
  scan.products.forEach((_, i) => out.push(`product:${i}`));
  return out;
}

export type AcceptParse = { ok: true; kitId: string | null; fields: string[] } | { ok: false; error: "invalid_fields" | "bad_request" };

export function parseAcceptInput(raw: unknown): AcceptParse {
  const b = raw as { kit_id?: unknown; fields?: unknown } | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "bad_request" };
  const kitId = b.kit_id === null || b.kit_id === undefined || b.kit_id === "" ? null : parseScanId(b.kit_id);
  if (b.kit_id && !kitId) return { ok: false, error: "bad_request" };
  if (!Array.isArray(b.fields) || b.fields.length < 1 || b.fields.length > 15) return { ok: false, error: "invalid_fields" };
  const fields = b.fields.filter((x): x is string => typeof x === "string" && ACCEPT_FIELD_RE.test(x));
  if (fields.length !== b.fields.length || new Set(fields).size !== fields.length) return { ok: false, error: "invalid_fields" };
  return { ok: true, kitId, fields };
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ScanError =
  | "unauthorized" | "forbidden" | "not_found" | "bad_request" | "org_required" | "not_available" | "not_configured" | "read_failed" | "failed"
  | "invalid_host" | "hosting_parent" | "invalid_url" | "invalid_idempotency_key" | "invalid_fields" | "name_required" | "invalid_reference"
  | "limit_reached" | "too_soon" | "platform_busy" | "org_daily_limit" | "not_on_sale" | "price_changed" | "domain_not_verified" | "scan_in_progress"
  | "idempotency_conflict" | "scan_not_ready" | "insufficient_credits" | "scan_hold_unavailable" | "parallel_limit";

const NS400 = ["invalid_host", "hosting_parent", "invalid_url", "invalid_idempotency_key", "invalid_fields", "name_required", "invalid_reference"];
const NS409 = ["not_on_sale", "price_changed", "domain_not_verified", "scan_in_progress", "idempotency_conflict", "scan_not_ready"];

export interface MappedScanError {
  error: ScanError;
  status: number;
  /** A number the database named (a cap, the seconds to wait, the price now); absent when it named none. */
  max?: number;
  retryAfter?: number;
  price?: number;
  /** What a scan holds while it runs (scan_hold_unavailable), as the database named it. */
  hold?: number;
}

/** A database refusal as a closed word. The platform's cap names no number, so none is shown (rule 5). */
export function mapScanError(error: { code?: string; message?: string; details?: string } | null | undefined): MappedScanError {
  const word = (error?.message ?? "").trim();
  const details = error?.details ?? "";
  switch (error?.code) {
    case "NS400":
      return { error: NS400.includes(word) ? (word as ScanError) : "bad_request", status: 400 };
    case "NS409": {
      if (!NS409.includes(word)) return { error: "failed", status: 502 };
      const m = /(?:^|\s)price=(\d{1,6}(?:\.\d{1,2})?)(?:\s|$)/.exec(details);
      return m && word === "price_changed" ? { error: "price_changed", status: 409, price: Number(m[1]) } : { error: word as ScanError, status: 409 };
    }
    case "NS402": {
      if (word !== "scan_hold_unavailable") return { error: "insufficient_credits", status: 402 };
      const m = /(?:^|\s)hold=(\d{1,6}(?:\.\d{1,2})?)\s+price=(\d{1,6}(?:\.\d{1,2})?)(?:\s|$)/.exec(details);
      return m ? { error: "scan_hold_unavailable", status: 402, hold: Number(m[1]), price: Number(m[2]) } : { error: "scan_hold_unavailable", status: 402 };
    }
    case "NS429": {
      if (word === "too_soon") {
        const m = /(?:^|\s)retry_after=(\d{1,4})(?:\s|$)/.exec(details);
        return m ? { error: "too_soon", status: 429, retryAfter: Number(m[1]) } : { error: "too_soon", status: 429 };
      }
      if (word === "platform_busy") return { error: "platform_busy", status: 429 };
      // This workspace's share of the day: the database names no number, so none is shown.
      if (word === "org_daily_limit") return { error: "org_daily_limit", status: 429 };
      if (word === "parallel run limit reached") return { error: "parallel_limit", status: 429 };
      const m = /(?:^|\s)max=(\d{1,5})(?:\s|$)/.exec(details);
      return m ? { error: "limit_reached", status: 409, max: Number(m[1]) } : { error: "limit_reached", status: 409 };
    }
    case "42501":
      return { error: "forbidden", status: 403 };
    case "P0002":
      return { error: "not_found", status: 404 };
    case "PGRST202":
    case "PGRST205":
    case "42883":
    case "42P01":
    case "42703":
      return { error: "not_available", status: 503 };
  }
  if (/could not find the (function|table)|does not exist/i.test(error?.message ?? "")) return { error: "not_available", status: 503 };
  return { error: "failed", status: 502 };
}

/** Every closed failure code the worker or 0133 stores on a scan, which the panel has a sentence for (anything else: "other"). */
export const SCAN_FAILURES = [
  "ownership_not_proven", "ownership_unknown", "nothing_found", "invalid_result", "worker_error", "expired", "worker_lost", "hold_missing",
  "fetch_robots", "fetch_not_public", "fetch_timeout", "fetch_dns", "fetch_tls", "fetch_connect", "fetch_off_site", "fetch_hosting_parent",
  "fetch_http_status", "fetch_too_large", "fetch_content_type", "fetch_too_many_redirects",
] as const;
