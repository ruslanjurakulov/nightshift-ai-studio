import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { MEDIA_URL_TTL_S, mediaDir, mediaUrlSecret, signedMediaPath } from "@/lib/server/media";
import { MEDIA_ASSET_COLUMNS, coerceAssets, mapMediaError, parseMediaId, type MediaVariant } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One asset (migration 0038), read under the caller's session: RLS returns it
 * only to a member of its organization and only while it is not deleted, so
 * another organization's id — or a made-up one — is a plain 404. The answer
 * carries short-lived signed links (GET /api/media/file/…) for each file the
 * asset has; they are minted only after that read.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.from("media_assets").select(MEDIA_ASSET_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    const mapped = mapMediaError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  const asset = coerceAssets(data ? [data] : [])[0];
  if (!asset) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const secret = mediaUrlSecret();
  const served = Boolean(secret && mediaDir());
  const urls: Partial<Record<MediaVariant, string>> = {};
  if (served && secret) {
    for (const v of ["original", ...asset.variants] as MediaVariant[]) urls[v] = signedMediaPath(secret, asset.id, v, asset.mime);
  }
  return NextResponse.json({
    asset,
    urls,
    urls_expire_in: served ? MEDIA_URL_TTL_S : null,
    served,
  });
}

/**
 * Delete an asset: soft_delete_asset() under the caller's session (a member of
 * its organization; another org's asset reads as not found). The row stays for
 * provenance; the worker removes the files and returns the bytes to the quota.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("soft_delete_asset", { p_asset: id });
  if (error) {
    const mapped = mapMediaError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  await logAudit({ action: "media.delete", target: id, detail: { changed: data === true } });
  return NextResponse.json({ ok: true, deleted: data === true });
}
