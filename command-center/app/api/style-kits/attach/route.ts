import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody } from "@/lib/server/style-kits";
import { mapStyleError, parseChannelRef, parseStyleId } from "@/lib/style-kits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Make a kit a channel's default look, or clear it: POST
 * `{ channel_id, kit_id }` (kit_id null clears).
 *
 * Written through the channels table's own update policy under the caller's
 * session (an editor of the channel's organization), and the database's
 * channels_style_kit_guard refuses a kit of any other organization — for this
 * route and for every other writer. A channel the caller cannot edit updates
 * zero rows: 404.
 *
 * It sets configuration only. Nothing is generated, rendered or published
 * here; nothing reads the default yet.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await readJsonBody(request)) as { channel_id?: unknown; kit_id?: unknown } | undefined;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const channel = parseChannelRef(body.channel_id);
  const kit = body.kit_id === null ? null : parseStyleId(body.kit_id);
  if (!channel || (body.kit_id !== null && !kit)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase
    .from("channels")
    .update({ default_style_kit_id: kit, updated_at: new Date().toISOString() })
    .eq("channel_id", channel)
    .select("channel_id");
  if (error) {
    const mapped = mapStyleError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  if (!Array.isArray(data) || data.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await logAudit({ action: kit ? "style_kit.attach" : "style_kit.detach", target: kit ?? undefined, channelId: channel });
  return NextResponse.json({ ok: true, channel_id: channel, kit_id: kit });
}
