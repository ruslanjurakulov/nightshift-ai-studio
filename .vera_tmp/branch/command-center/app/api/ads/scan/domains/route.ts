import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, readAdsBody, resolveAdsOrg } from "@/lib/server/ads-factory";
import { adsScanGate, scanFail, scanRefusal } from "@/lib/server/ads-brand-scan";
import { parseScanHost, parseScanId } from "@/lib/adsFactory/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ask to prove a domain: POST `{ org_id?, host }` (NIGHTSHIFT_ADS_BRAND_SCAN and NIGHTSHIFT_ADS_FACTORY, default off: 404).
 *
 * request_domain_verification() runs as the member: the editor role, the host shape (a public suffix or a shared hosting parent is
 * `hosting_parent`), at most 10 domains, and the same token for the same host again. Answers the TXT record to add. Nothing is
 * looked up here: the worker reads the record when the person presses Check now.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const gate = await adsScanGate();
  if (!gate.ok) return gate.response;
  const body = (await readAdsBody(request)) as { org_id?: unknown; host?: unknown } | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return scanFail("bad_request", 400);
  const host = parseScanHost(body.host);
  if (!host.ok) return scanFail(host.error, 400);
  const { org, bad } = await resolveAdsOrg(body.org_id);
  if (bad) return scanFail("bad_request", 400);
  if (!org) return scanFail("org_required", 400);

  const { data, error } = await gate.supabase.rpc("request_domain_verification", { p_org: org, p_host: host.host });
  if (error) return scanRefusal(error);
  const out = data as { id?: unknown; host?: unknown; record_name?: unknown; record_value?: unknown; verified_at?: unknown } | null;
  const id = parseScanId(out?.id);
  if (!id || typeof out?.record_name !== "string" || typeof out?.record_value !== "string") return scanFail("failed", 502);
  return NextResponse.json(
    { id, host: host.host, record_name: out.record_name, record_value: out.record_value, verified_at: typeof out.verified_at === "string" ? out.verified_at : null },
    { status: 201, headers: NO_STORE },
  );
});
