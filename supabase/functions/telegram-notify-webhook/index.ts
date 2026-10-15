// Telegram (the CUSTOMER bot) -> notification channels. A Supabase Edge Function
// (Deno), deployed with
//   supabase functions deploy telegram-notify-webhook --no-verify-jwt
// because Telegram authenticates its calls with the secret token header set in
// setWebhook, not a Supabase JWT. See docs/NOTIFY_TELEGRAM_SETUP.md.
//
// Runs here, not in the Command Center, because it needs the service role (the
// link functions are service-role only) and the Command Center never holds that
// key. All logic is in ../_shared/telegram-notify.ts (covered by the Command
// Center's test suite); this file only wires the environment to it.
//
// Environment (supabase secrets set …), by NAME:
//   TELEGRAM_CUSTOMER_WEBHOOK_SECRET   the secret_token given to setWebhook
//                                      (24-256 characters of A-Z a-z 0-9 _ -)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//                                      provided by Supabase to every Edge Function
// The bot token is NOT needed here: replies go back in the webhook response.

import {
  MAX_BODY,
  createRestStore,
  handleTelegramWebhook,
  readBoundedText,
  secretIsUsable,
  secretMatches,
} from "../_shared/telegram-notify.ts";

const env = (name: string) => Deno.env.get(name) ?? undefined;
const supabaseUrl = env("SUPABASE_URL") ?? "";
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const secret = env("TELEGRAM_CUSTOMER_WEBHOOK_SECRET");
const store = createRestStore({ url: supabaseUrl, serviceKey });

Deno.serve(async (req: Request): Promise<Response> => {
  if (!supabaseUrl || !serviceKey) {
    console.error("telegram-notify-webhook: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
  // Nobody but Telegram gets the body read: the secret is checked first, and the
  // body is then read as a bounded stream (Content-Length may be absent or false).
  // The handler checks the secret again; this is only about not reading for strangers.
  if (req.method === "POST" && secretIsUsable(secret) && (await secretMatches(secretHeader, secret as string))) {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
      return Response.json({ error: "too_large" }, { status: 413 });
    }
    const rawBody = await readBoundedText(req.body);
    const res = await handleTelegramWebhook(
      { method: req.method, contentType: req.headers.get("content-type"), rawBody, secretHeader },
      { secret, store },
    );
    return Response.json(res.body, { status: res.status });
  }
  // Wrong or missing secret, wrong method, or not configured: the handler's own answer, body never read.
  const res = await handleTelegramWebhook(
    { method: req.method, contentType: req.headers.get("content-type"), rawBody: "", secretHeader },
    { secret, store },
  );
  return Response.json(res.body, { status: res.status });
});
