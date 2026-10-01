import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody } from "@/lib/server/style-kits";
import { mapStyleError, parseKitInput, parseStyleId } from "@/lib/style-kits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Replace a kit's name, description and references: PATCH
 * `{ name, description?, asset_ids }`. The kit's organization is its own —
 * save_style_kit() takes it from the row, so another organization's kit (or a
 * made-up id) is a plain 404.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = parseStyleId((await params).id);
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const input = parseKitInput(await readJsonBody(request));
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("save_style_kit", {
    p_org: null,
    p_kit: id,
    p_name: input.value.name,
    p_description: input.value.description,
    p_assets: input.value.assetIds,
  });
  if (error) {
    const mapped = mapStyleError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  if (parseStyleId(data) !== id) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({ action: "style_kit.update", target: id, detail: { references: input.value.assetIds.length } });
  return NextResponse.json({ id });
}

/**
 * Delete a kit under the caller's session (RLS: an editor of its
 * organization). Its references go with it, and any channel that used it as
 * its default look is left with none (ON DELETE SET NULL). Zero rows deleted
 * is a 404, whoever's the id was.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = parseStyleId((await params).id);
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.from("style_kits").delete().eq("id", id).select("id");
  if (error) {
    const mapped = mapStyleError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  if (!Array.isArray(data) || data.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await logAudit({ action: "style_kit.delete", target: id });
  return NextResponse.json({ ok: true });
}
