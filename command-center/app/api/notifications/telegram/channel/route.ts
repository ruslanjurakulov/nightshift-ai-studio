import { createClient, getUser } from "@/lib/supabase/server";
import { customerBotUsername } from "@/lib/server/notify-channels";
import { guardNotifyWrite, notifyFail, notifyOk, readSmallJson, rpcFailure } from "@/lib/server/notify-route";
import { CHANNEL_ACTIONS, isLanguageCode, type ChannelAction } from "@/lib/notify-channels";
import { NOTIFY_CHANNEL_RATE } from "@/lib/server/web-rate";
import { requireSameOrigin } from "@/lib/server/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One control on one of the person's own linked chats (migration 0102).
 *
 * POST `{ id, action, locale? }` with action disconnect | pause | resume | test | locale.
 * Each is a database function that touches only the caller's own row: a
 * foreign or made-up id reads the same as "not found", never "exists". A test
 * message is queued, not sent here (the notify worker sends it), and is limited
 * to three an hour per person in the database.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const user = await getUser();
  if (!user) return notifyFail("unauthorized", 401);
  const refusal = await guardNotifyWrite(request, user, NOTIFY_CHANNEL_RATE);
  if (refusal) return refusal;
  if (!customerBotUsername()) return notifyFail("not_configured", 503);

  const body = await readSmallJson(request);
  const id = typeof body?.id === "string" ? body.id : "";
  const action = body?.action as ChannelAction;
  if (!body || !UUID_RE.test(id) || !CHANNEL_ACTIONS.includes(action)) return notifyFail("bad_request", 400);

  const supabase = await createClient();
  if (!supabase) return notifyFail("not_configured", 503);

  let result: { data: unknown; error: { code?: string; message?: string } | null };
  switch (action) {
    case "disconnect":
      result = await supabase.rpc("notification_channel_disconnect", { p_id: id });
      break;
    case "pause":
    case "resume":
      result = await supabase.rpc("notification_channel_set_paused", { p_id: id, p_paused: action === "pause" });
      break;
    case "locale": {
      const locale = body.locale;
      if (!isLanguageCode(locale)) return notifyFail("bad_request", 400);
      result = await supabase.rpc("notification_channel_set_locale", { p_id: id, p_locale: locale });
      break;
    }
    case "test": {
      const r = await supabase.rpc("notification_test_send", { p_channel_id: id });
      if (r.error) {
        const f = rpcFailure(r.error);
        return notifyFail(f.error, f.status);
      }
      if (r.data === "rate_limited") return notifyFail("rate_limited", 429, { "retry-after": "3600" });
      if (r.data === "not_active") return notifyFail("not_active", 409);
      if (r.data !== "ok") return notifyFail("not_found", 404);
      return notifyOk();
    }
  }
  if (result.error) {
    const f = rpcFailure(result.error);
    return notifyFail(f.error, f.status);
  }
  if (result.data !== true) return notifyFail(action === "resume" || action === "pause" ? "not_active" : "not_found", action === "disconnect" || action === "locale" ? 404 : 409);
  return notifyOk();
});
