import { createClient, getUser } from "@/lib/supabase/server";
import { customerBotUsername } from "@/lib/server/notify-channels";
import { guardNotifyWrite, notifyFail, notifyOk, readSmallJson, rpcFailure } from "@/lib/server/notify-route";
import { isChannelEvent } from "@/lib/notify-channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Switch one of the five events on or off for Telegram (migration 0102).
 * POST `{ event, enabled }`. notification_pref_set checks the event against its
 * allow-list and limits changes to 120 an hour per person.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return notifyFail("unauthorized", 401);
  const refusal = await guardNotifyWrite(request, user);
  if (refusal) return refusal;
  if (!customerBotUsername()) return notifyFail("not_configured", 503);

  const body = await readSmallJson(request);
  if (!body || !isChannelEvent(body.event) || typeof body.enabled !== "boolean") return notifyFail("bad_request", 400);

  const supabase = await createClient();
  if (!supabase) return notifyFail("not_configured", 503);
  const { data, error } = await supabase.rpc("notification_pref_set", { p_event: body.event, p_channel: "telegram", p_enabled: body.enabled });
  if (error) {
    const f = rpcFailure(error);
    return notifyFail(f.error, f.status);
  }
  // false = refused (a limit or an unknown event); the page keeps the switch where it was.
  if (data !== true) return notifyFail("rate_limited", 429);
  return notifyOk();
}
