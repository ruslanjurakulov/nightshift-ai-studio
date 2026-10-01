import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { loadStyleContext, readJsonBody, resolveStyleOrg } from "@/lib/server/style-kits";
import { mapStyleError, parseKitInput, parseStyleId } from "@/lib/style-kits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The organization's style kits (migration 0047), read under the caller's
 * session: RLS returns kits of organizations they belong to and nothing else.
 * `?org=` picks one; otherwise the organization the app has open. Cover
 * images come as short-lived signed links.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { org, bad } = await resolveStyleOrg(new URL(request.url).searchParams.get("org"));
  if (bad) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!org) return NextResponse.json({ error: "org_required" }, { status: 400 });
  const ctx = await loadStyleContext(org, { urls: true });
  if (!ctx.available) return NextResponse.json({ error: "not_available" }, { status: 503 });
  if (ctx.error) return NextResponse.json({ error: "read_failed" }, { status: 502 });
  return NextResponse.json({ org, kits: ctx.kits });
}

/**
 * Create a kit: POST `{ org_id?, name, description?, asset_ids }`.
 * save_style_kit() runs as the signed-in user and checks that they edit this
 * organization and that every id is a live image of ITS library — another
 * organization's asset is refused however it got into the request.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const input = parseKitInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const { org, bad } = await resolveStyleOrg((body as { org_id?: unknown }).org_id);
  if (bad) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!org) return NextResponse.json({ error: "org_required" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("save_style_kit", {
    p_org: org,
    p_kit: null,
    p_name: input.value.name,
    p_description: input.value.description,
    p_assets: input.value.assetIds,
  });
  if (error) {
    const mapped = mapStyleError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  const id = parseStyleId(data);
  if (!id) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({ action: "style_kit.create", target: id, detail: { references: input.value.assetIds.length } });
  return NextResponse.json({ id }, { status: 201 });
}
