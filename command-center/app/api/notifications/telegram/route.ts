import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { customerBotUsername, readChannels } from "@/lib/server/notify-channels";
import { guardNotifyWrite, notifyFail, notifyOk, readSmallJson, rpcFailure } from "@/lib/server/notify-route";
import { isLanguageCode, isLinkToken, telegramLinkUrl } from "@/lib/notify-channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Telegram notifications (migration 0102), the person's own linking.
 *
 *   GET   { configured, channels, preferences } — what the Settings panel polls
 *         while it waits for the person to press Start in Telegram. The chat id
 *         is not in it: the column is not readable through the API.
 *   POST  { locale } — start linking: the database makes a one-time token
 *         (hashed there, 10 minutes, single use, 5 an hour) and the answer is the
 *         t.me link that carries it. The token is in this response and nowhere
 *         else: not logged, not audited, not cached. (No audit row is written for
 *         notification controls: the database refuses an action name it does not
 *         list, and listing one means replacing audit_action_allowed.)
 *
 * Everything runs as the person (anon key + session): the database functions
 * check who is asking. Off (`not_configured`, 503) until the customer bot's
 * public username is set in TELEGRAM_CUSTOMER_BOT_USERNAME.
 */
export async function GET() {
  const user = await getUser();
  if (!user) return notifyFail("unauthorized", 401);
  const bot = customerBotUsername();
  if (!bot) return NextResponse.json({ configured: false, channels: [], preferences: [] }, { headers: { "cache-control": "no-store" } });
  const view = await readChannels();
  return NextResponse.json(
    { configured: view.supported, channels: view.channels, preferences: view.preferences },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return notifyFail("unauthorized", 401);
  const refusal = await guardNotifyWrite(request, user);
  if (refusal) return refusal;
  const bot = customerBotUsername();
  if (!bot) return notifyFail("not_configured", 503);

  const body = await readSmallJson(request);
  const locale = body?.locale;
  // Only a language this app speaks is stored as the chat's language; anything else is a bad request.
  if (!body || !isLanguageCode(locale)) return notifyFail("bad_request", 400);

  const supabase = await createClient();
  if (!supabase) return notifyFail("not_configured", 503);
  const { data, error } = await supabase.rpc("notification_link_start", { p_kind: "telegram", p_locale: locale });
  if (error) {
    const f = rpcFailure(error);
    return notifyFail(f.error, f.status);
  }
  const res = data as { ok?: boolean; code?: string; token?: unknown; expires_at?: unknown } | null;
  if (!res?.ok) {
    if (res?.code === "rate_limited") return notifyFail("rate_limited", 429, { "retry-after": "3600" });
    if (res?.code === "limit") return notifyFail("limit", 409);
    return notifyFail("bad_request", 400);
  }
  const url = isLinkToken(res.token) ? telegramLinkUrl(bot, res.token) : null;
  if (!url) return notifyFail("failed", 502);
  return notifyOk({ url, expires_at: typeof res.expires_at === "string" ? res.expires_at : null });
}
