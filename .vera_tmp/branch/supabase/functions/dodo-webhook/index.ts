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
//   DODO_PRODUCT_AMOUNT           the one-time Pay What You Want product (pdt_…) a typed
//                                 amount is charged under; unset = typed amounts are not credited
//   DODO_METADATA_SECRET          32+ characters, the SAME value as the Command Center's:
//                                 the key checkout metadata is signed with (ns_sig)
//   DODO_TAX_MODE                 inclusive | exclusive — how every product's price
//                                 carries tax; unset = nothing is credited
//   DODO_WEBHOOK_MODE             live, or anything else = test: in test mode only the
//   DODO_TEST_ORG_IDS             organizations listed here (uuids) are credited
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//                                 provided by Supabase to every Edge Function
//
// Deploying it is the owner's act and changes nothing for Paddle: until a Dodo
// endpoint points here and a checkout is opened through Dodo (PAYMENTS_PROVIDER
// on the Command Center), nothing ever arrives.

import {
  createDodoRestStore,
  dodoAmountProductFromEnv,
  dodoMetadataKey,
  dodoTaxModeFromEnv,
  dodoTestOrgsFromEnv,
  dodoWebhookModeFromEnv,
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
const amountProduct = dodoAmountProductFromEnv(env, packs, plans);
const metadataSecret = env("DODO_METADATA_SECRET") ?? "";
const taxMode = dodoTaxModeFromEnv(env("DODO_TAX_MODE"));
const mode = dodoWebhookModeFromEnv(env("DODO_WEBHOOK_MODE"));
const testOrgs = dodoTestOrgsFromEnv(env("DODO_TEST_ORG_IDS"));

// Said once at boot, by name only.
if (!dodoSigningKey(secret)) console.error("dodo-webhook: DODO_WEBHOOK_SECRET is not a whsec_ signing secret — every delivery is refused");
if (packs.size === 0) console.error("dodo-webhook: no DODO_PRODUCT_* is set to a valid product id — pack purchases cannot be credited");
if (!dodoMetadataKey(metadataSecret)) console.error("dodo-webhook: DODO_METADATA_SECRET is not set (32+ characters) — nothing is credited until it is set; refunds and disputes still land");
if (!taxMode) console.error("dodo-webhook: DODO_TAX_MODE is not inclusive or exclusive — nothing is credited until it is set; refunds and disputes still land");
if (!amountProduct) console.warn("dodo-webhook: DODO_PRODUCT_AMOUNT is not a product id of its own — typed (custom-amount) purchases cannot be credited");
if (mode === "test") console.error(`dodo-webhook: TEST mode — only the ${testOrgs.size} organization(s) in DODO_TEST_ORG_IDS are credited`);

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
    { secret, metadataSecret, taxMode, mode, testOrgs, packs, plans, amountProduct, store },
  );
  return Response.json(res.body, { status: res.status });
});
