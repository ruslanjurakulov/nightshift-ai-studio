import "server-only";
import { NextResponse } from "next/server";
import { adsGate, NO_STORE, loadAdsPictures, type AdsGate } from "@/lib/server/ads-factory";
import {
  BRAND_DOMAIN_COLUMNS,
  BRAND_SCAN_COLUMNS,
  adsBrandScanEnabled,
  coerceDomains,
  coerceQuote,
  coerceScan,
  mapScanError,
  parseScanId,
  type BrandDomain,
  type BrandScan,
  type ScanError,
  type ScanQuote,
} from "@/lib/adsFactory/scan";

/**
 * The brand scan's server side (migration 0133; docs/ADS_FACTORY.md, Phase 2). Every call is the signed-in member's own Supabase
 * client (anon key + session) and one of 0133's member functions or an RLS read: never the service key, never a fetch of the site,
 * never a DNS lookup (the worker does both). Behind NIGHTSHIFT_ADS_BRAND_SCAN AND NIGHTSHIFT_ADS_FACTORY: either off = 404 before the
 * session is read.
 */

export function scanFail(error: ScanError, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

/** The first line of every /api/ads/scan route: this switch, then the Ads routes' own gate (their switch, the session, the client). */
export async function adsScanGate(): Promise<AdsGate> {
  if (!adsBrandScanEnabled()) return { ok: false, response: scanFail("not_found", 404) };
  return adsGate();
}

/** A database refusal as the route's answer: a closed word, a status, and the number the database named, when it named one. */
export function scanRefusal(error: { code?: string; message?: string; details?: string }) {
  const m = mapScanError(error);
  const extra: Record<string, unknown> = {};
  if (m.max !== undefined) extra.max = m.max;
  if (m.retryAfter !== undefined) extra.retry_after = m.retryAfter;
  if (m.price !== undefined) extra.price = m.price;
  return scanFail(m.error, m.status, extra);
}

type Client = Extract<AdsGate, { ok: true }>["supabase"];

export interface ScanState {
  available: boolean;
  error?: "read_failed";
  quote: ScanQuote | null;
  domains: BrandDomain[];
  scans: BrandScan[];
  /** Library thumbnails of the pictures the scans name (the organization's own assets; RLS). */
  pictures: Record<string, { thumbUrl: string | null; name: string | null }>;
}

const LATEST_SCANS = 3;

/** The organization's domains, its latest scans and the quote, read under the member's session. */
export async function loadScanState(supabase: Client, orgId: string): Promise<ScanState> {
  const empty: ScanState = { available: false, quote: null, domains: [], scans: [], pictures: {} };
  if (!parseScanId(orgId)) return empty;
  try {
    const [domains, checks, scans, quote] = await Promise.all([
      supabase.from("brand_domains").select(BRAND_DOMAIN_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: true }).limit(10),
      supabase.from("brand_domain_checks").select("domain_id").eq("org_id", orgId).is("finished_at", null).limit(50),
      supabase.from("brand_scans").select(BRAND_SCAN_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(LATEST_SCANS),
      supabase.rpc("quote_brand_scan", { p_org: orgId }),
    ]);
    const errors = [domains.error, checks.error, scans.error, quote.error].filter(Boolean) as { code?: string; message?: string }[];
    if (errors.length) {
      return errors.some((e) => mapScanError(e).error === "not_available") ? empty : { ...empty, available: true, error: "read_failed" };
    }
    const pending = new Set((Array.isArray(checks.data) ? checks.data : []).map((c) => parseScanId((c as { domain_id?: unknown }).domain_id)).filter((x): x is string => Boolean(x)));
    const rows = (Array.isArray(scans.data) ? scans.data : []).map((r) => coerceScan(r as Record<string, unknown>)).filter((s): s is BrandScan => Boolean(s));
    const ids = [...new Set(rows.flatMap((s) => [s.fields.logo?.value, ...s.products.map((p) => p.image?.value)]).filter((x): x is string => Boolean(x)))];
    const live = await loadAdsPictures(supabase, orgId, ids, { urls: true });
    if (live === null) return { ...empty, available: true, error: "read_failed" };
    return {
      available: true,
      quote: coerceQuote(quote.data),
      domains: coerceDomains(domains.data, pending),
      scans: rows,
      pictures: Object.fromEntries(live),
    };
  } catch {
    return { ...empty, available: true, error: "read_failed" };
  }
}
