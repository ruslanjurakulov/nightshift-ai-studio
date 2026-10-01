import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody } from "@/lib/server/style-kits";
import { mapStyleError, parseCharacterInput, parseStyleId } from "@/lib/style-kits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Replace a character: PATCH `{ name, kind?, description?, asset_ids }`.
 * save_character() takes the organization from the row, so another
 * organization's character (or a made-up id) is a plain 404.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = parseStyleId((await params).id);
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const input = parseCharacterInput(await readJsonBody(request));
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("save_character", {
    p_org: null,
    p_character: id,
    p_name: input.value.name,
    p_kind: input.value.kind,
    p_description: input.value.description,
    p_assets: input.value.assetIds,
  });
  if (error) {
    const mapped = mapStyleError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  if (parseStyleId(data) !== id) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({ action: "character.update", target: id, detail: { references: input.value.assetIds.length } });
  return NextResponse.json({ id, name: input.value.name });
}

/** Delete a character under the caller's session (RLS: an editor of its organization). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = parseStyleId((await params).id);
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.from("characters").delete().eq("id", id).select("id");
  if (error) {
    const mapped = mapStyleError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  if (!Array.isArray(data) || data.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await logAudit({ action: "character.delete", target: id });
  return NextResponse.json({ ok: true });
}
