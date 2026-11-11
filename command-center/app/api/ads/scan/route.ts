import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, readAdsBody, resolveAdsOrg } from "@/lib/server/ads-factory";
import { adsScanGate, loadScanState, scanFail, scanRefusal } from "@/lib/server/ads-brand-scan";
import { IDEM_RE, parseScanId, parseScanUrl } from "@/lib/adsFactory/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The brand scan (migration 0133; NIGHTSHIFT_ADS_BRAND_SCAN and NIGHTSHIFT_ADS_FACTORY, default off: 404 before anything is read).
 *
 * GET `?org=<id>`: the organization's domains (with the TXT record each needs), its latest scans and the quote, read under the
 * member's own session. POST `{ org_id?, url, idem, max_credits }`: request_brand_scan() as the member, which checks the editor role,
 * the verified domain, the price (`not_on_sale` while it is NULL; `price_changed` above max_credits), the caps, and holds the credits.
 * This route opens no site and resolves no name: the worker does, after it reads the DNS record again.
 */
export async function GET(request: Request) {
  const gate = await adsScanGate();
  if (!gate.ok) return gate.response;
  const { org, bad } = await resolveAdsOrg(new URL(request.url).searchParams.get("org"));
  if (bad) return scanFail("bad_request", 400);
  if (!org) return scanFail("org_required", 400);
  const state = await loadScanState(gate.supabase, org);
  if (!state.available) return scanFail("not_available", 503);
  if (state.error) return scanFail("read_failed", 502);
  return NextResponse.json({ org, quote: state.quote, domains: state.domains, scans: state.scans, pictures: state.pictures }, { headers: NO_STORE });
}

export const POST = requireSameOrigin(async function POST(request: Request) {
  const gate = await adsScanGate();
  if (!gate.ok) return gate.response;
  const body = (await readAdsBody(request)) as { org_id?: unknown; url?: unknown; idem?: unknown; max_credits?: unknown } | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return scanFail("bad_request", 400);
  const url = parseScanUrl(body.url);
  if (!url) return scanFail("invalid_url", 400);
  if (typeof body.idem !== "string" || !IDEM_RE.test(body.idem)) return scanFail("invalid_idempotency_key", 400);
  const max = typeof body.max_credits === "number" && Number.isFinite(body.max_credits) && body.max_credits >= 0 && body.max_credits <= 1000 ? body.max_credits : null;
  if (max === null) return scanFail("bad_request", 400);
  const { org, bad } = await resolveAdsOrg(body.org_id);
  if (bad) return scanFail("bad_request", 400);
  if (!org) return scanFail("org_required", 400);

  const { data, error } = await gate.supabase.rpc("request_brand_scan", { p_org: org, p_url: url, p_idem: body.idem, p_max_credits: max });
  if (error) return scanRefusal(error);
  const out = data as { id?: unknown; status?: unknown; credits?: unknown; replayed?: unknown } | null;
  const id = parseScanId(out?.id);
  if (!id) return scanFail("failed", 502);
  return NextResponse.json(
    { id, status: typeof out?.status === "string" ? out.status : "requested", credits: typeof out?.credits === "number" ? out.credits : null, replayed: out?.replayed === true },
    { status: out?.replayed === true ? 200 : 201, headers: NO_STORE },
  );
});
