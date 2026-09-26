// Paddle -> credits. A Supabase Edge Function (Deno), deployed with
//   supabase functions deploy paddle-webhook --no-verify-jwt
// because Paddle signs its deliveries with its own secret, not a Supabase JWT.
// See docs/PADDLE_SETUP.md.
//
// This is the only place in the platform that turns a payment into credits,
// and it runs here rather than in the Command Center because it needs the
// service role (add_purchased_credits is service-role only) and the Command
// Center must never hold that key. All the logic lives in ../_shared/paddle.ts,
// which the Command Center's test suite covers; this file only wires the
// environment to it.
//
// Environment (supabase secrets set …):
//   PADDLE_WEBHOOK_SECRET        the notification destination's secret key
//   PADDLE_PRICE_STARTER / _CREATOR / _STUDIO
//                                the Paddle price id of each credit pack
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//                                provided by Supabase to every Edge Function

import { createRestStore, handlePaddleWebhook, priceTableFromEnv } from "../_shared/paddle.ts";

const env = (name: string) => Deno.env.get(name) ?? undefined;

const supabaseUrl = env("SUPABASE_URL") ?? "";
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const secret = env("PADDLE_WEBHOOK_SECRET") ?? "";
const prices = priceTableFromEnv(env);

if (prices.size === 0) {
  // Said once at boot, by name only: every purchase would be rejected.
  console.error("paddle-webhook: no PADDLE_PRICE_* is set to a valid price id — purchases cannot be credited");
}

const store = createRestStore({ url: supabaseUrl, serviceKey });

Deno.serve(async (req: Request): Promise<Response> => {
  if (!supabaseUrl || !serviceKey) {
    console.error("paddle-webhook: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
    return Response.json({ error: "webhook not configured" }, { status: 500 });
  }
  // The raw text, exactly as sent: the signature is over these bytes.
  const rawBody = await req.text();
  const res = await handlePaddleWebhook(
    { method: req.method, rawBody, signature: req.headers.get("paddle-signature") },
    { secret, prices, store },
  );
  return Response.json(res.body, { status: res.status });
});
