import { NextResponse } from "next/server";
import { getUser, createClient } from "@/lib/supabase/server";
import { regionEditorEnabled } from "@/lib/regionEdit/flag";
import { readVersionRows } from "@/lib/server/region-edit";
import { buildChain } from "@/lib/regionEdit/versions";
import { isUuid } from "@/lib/creative/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The version history around one library picture (NIGHTSHIFT_REGION_EDITOR, default off: 404).
 *
 * GET `?asset=<id>`: the picture's ancestors up to the original and its newest descendants, from
 * media_assets.parent_asset_id, read under the member's own session (RLS: their organization's live files). Each
 * region edit is a new file linked to its parent and nothing overwrites the original; undo is moving to the parent.
 * A read that fails is `failed` / `unavailable`, never an empty list that reads as "no versions".
 */
export async function GET(request: Request) {
  if (!regionEditorEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const asset = new URL(request.url).searchParams.get("asset");
  if (!isUuid(asset)) return NextResponse.json({ error: "invalid_params" }, { status: 400 });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const read = await readVersionRows(supabase, asset);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.error === "unavailable" ? 503 : 502 });
  const chain = buildChain(read.rows, asset);
  if (!chain) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ chain });
}
