import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { loadStyleContext, readJsonBody, resolveStyleOrg } from "@/lib/server/style-kits";
import { mapStyleError, parseCharacterInput, parseStyleId } from "@/lib/style-kits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The organization's characters and products (migration 0047), read under the
 * caller's session (RLS: members of the organization only). `?org=` picks
 * one; otherwise the organization the app has open.
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
  return NextResponse.json({ org, characters: ctx.characters });
}

/**
 * Create a character: POST `{ org_id?, name, kind?, description?, asset_ids }`.
 * `name` is the @name (^[a-z0-9_]{2,32}$ once "@" is dropped and letters are
 * lower-cased), unique in the organization — a taken one is a 409.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const input = parseCharacterInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const { org, bad } = await resolveStyleOrg((body as { org_id?: unknown }).org_id);
  if (bad) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!org) return NextResponse.json({ error: "org_required" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("save_character", {
    p_org: org,
    p_character: null,
    p_name: input.value.name,
    p_kind: input.value.kind,
    p_description: input.value.description,
    p_assets: input.value.assetIds,
  });
  if (error) {
    const mapped = mapStyleError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  const id = parseStyleId(data);
  if (!id) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({ action: "character.create", target: id, detail: { references: input.value.assetIds.length } });
  return NextResponse.json({ id, name: input.value.name }, { status: 201 });
}
