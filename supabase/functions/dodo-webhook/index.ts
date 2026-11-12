// Dodo Payments -> credits. A Supabase Edge Function (Deno), deployed with
//   supabase functions deploy dodo-webhook --no-verify-jwt
// because Dodo signs its deliveries with the endpoint's own secret (Standard
// Webhooks), not a Supabase JWT. See docs/DODO_SETUP.md.
//
// The second of the two places in the platform that turn a payment into
// credits (the first is paddle-webhook, which is not changed by this one). It
// runs here rather than in the Command Center for the same reason: it needs the
// service role, and the Command Center must never hold that key. All the logic
// lives in ../_shared/dodo.ts, which the Command Center's test suite covers;
// this file only wires the environment to it.
//
// Environment (supabase secrets set …; names only, never values in git):
//   DODO_WEBHOOK_SECRET           the endpoint's signing secret (whsec_…)
//   DODO_PRODUCT_STARTER / _CREATOR / _STUDIO
//                                 the Dodo product id (pdt_…) of each credit pack
//   DODO_PLAN_<ID>                the Dodo product id of each monthly plan in the
//                                 plans table, e.g. DODO_PLAN_PRO (creator, pro, studio)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//                                 provided by Supabase to every Edge Function
//
// Deploying it is the owner's act and changes nothing for Paddle: until a Dodo
// endpoint points here and a checkout is opened through Dodo (PAYMENTS_PROVIDER
// on the Command Center), nothing ever arrives.

import {
  createDodoRestStore,
  dodoPackTableFromEnv,
  dodoPlanTableFromEnv,
  dodoSigningKey,
  handleDodoWebhook,
  readBodyCapped,
} from "../_shared/dodo.ts";

const env = (name: string) => Deno.env.get(name) ?? undefined;

const supabaseUrl = env("SUPABASE_URL") ?? "";
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const secret = env("DODO_WEBHOOK_SECRET") ?? "";
const packs = dodoPackTableFromEnv(env);
const plans = dodoPlanTableFromEnv(Object.entries(Deno.env.toObject()), packs);

// Said once at boot, by name only.
if (!dodoSigningKey(secret)) console.error("dodo-webhook: DODO_WEBHOOK_SECRET is not a whsec_ signing secret — every delivery is refused");
if (packs.size === 0) console.error("dodo-webhook: no DODO_PRODUCT_* is set to a valid product id — pack purchases cannot be credited");

const store = createDodoRestStore({ url: supabaseUrl, serviceKey });

Deno.serve(async (req: Request): Promise<Response> => {
  if (!supabaseUrl || !serviceKey) {
    console.error("dodo-webhook: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
    return Response.json({ error: "webhook not configured" }, { status: 500 });
  }
  // The raw text, exactly as sent: the signature is over these bytes. Read with a hard cap and BEFORE the
  // signature check, so an oversized body is refused without being buffered (a non-POST has no body to read).
  let rawBody = "";
  if (req.method === "POST") {
    const read = await readBodyCapped(req);
    if (!read.ok) return Response.json({ error: "payload too large" }, { status: 413 });
    rawBody = read.text;
  }
  const res = await handleDodoWebhook(
    {
      method: req.method,
      rawBody,
      headers: {
        id: req.headers.get("webhook-id"),
        timestamp: req.headers.get("webhook-timestamp"),
        signature: req.headers.get("webhook-signature"),
      },
    },
    { secret, packs, plans, store },
  );
  return Response.json(res.body, { status: res.status });
});
