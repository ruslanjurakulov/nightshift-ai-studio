import { NextResponse } from "next/server";
import { NO_STORE, adsFail, adsGate, loadAdsWorkspace, resolveAdsOrg } from "@/lib/server/ads-factory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Ads workspace's one read (NIGHTSHIFT_ADS_FACTORY, default off: 404 before anything else is asked).
 *
 * GET `?org=<organization id>`; without it, the organization the app has open. Brand kits with their products and pictures, and
 * campaigns with their products and concepts, read under the signed-in member's own session (RLS: organizations they belong to and
 * nothing else). Read-only and free: it fetches no site, calls no model and spends no credit. A read that fails is `read_failed`,
 * never an empty workspace.
 */
export async function GET(request: Request) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const { org, bad } = await resolveAdsOrg(new URL(request.url).searchParams.get("org"));
  if (bad) return adsFail("bad_request", 400);
  if (!org) return adsFail("org_required", 400);
  const data = await loadAdsWorkspace(gate.supabase, org, { urls: true });
  if (!data.available) return adsFail("not_available", 503);
  if (data.error) return adsFail("read_failed", 502);
  return NextResponse.json({ org, kits: data.kits, campaigns: data.campaigns }, { headers: NO_STORE });
}
