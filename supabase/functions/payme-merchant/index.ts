// Payme Business Merchant API -> credits. A Supabase Edge Function (Deno), deployed with
//   supabase functions deploy payme-merchant --no-verify-jwt
// because Payme authenticates with Basic auth on its own merchant key, not a Supabase JWT.
//
// The third place in the platform that turns a payment into credits, next to paddle-webhook and
// dodo-webhook, and for the same reason it lives here rather than in the Command Center: it needs the
// service role, and the Command Center must never hold that key. All the logic lives in
// ../_shared/payme.ts, which the Command Center's test suite covers; this file only wires the environment.
//
// *** NOT TO BE DEPLOYED until the Payme protocol facts in ../_shared/payme.ts (PAYME_SPEC) are checked
// against Payme's official Merchant API page and the payme_orders / payme_transactions migration is applied
// (VERA_REPORT.md of the payme-adapter branch). ***
//
// Environment (supabase secrets set …; names only, never values in git):
//   PAYME_MERCHANT_KEY   the cashbox key Payme signs every call with (the sandbox key while PAYME_MODE is test)
//   PAYME_MODE           live, or anything else = test: in test mode only the organizations in
//   PAYME_TEST_ORG_IDS   (uuids) can pay an order
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  provided by Supabase to every Edge Function

import {
  createPaymeRestStore,
  handlePaymeRequest,
  paymeKeyUsable,
  paymeModeFromEnv,
  paymePackTable,
  paymeTestOrgsFromEnv,
  readBodyCapped,
} from "../_shared/payme.ts";

const env = (name: string) => Deno.env.get(name) ?? undefined;

const supabaseUrl = env("SUPABASE_URL") ?? "";
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const key = env("PAYME_MERCHANT_KEY") ?? "";
const mode = paymeModeFromEnv(env("PAYME_MODE"));
const testOrgs = paymeTestOrgsFromEnv(env("PAYME_TEST_ORG_IDS"));
const packs = paymePackTable();

// Said once at boot, by name only.
if (!paymeKeyUsable(key)) console.error("payme-merchant: PAYME_MERCHANT_KEY is not set — every call is refused");
if (packs.size === 0) console.error("payme-merchant: no pack has a UZS price in PAYME_PACKS — every order is refused");
if (mode === "test") console.error(`payme-merchant: TEST mode — only the ${testOrgs.size} organization(s) in PAYME_TEST_ORG_IDS can pay`);

const store = createPaymeRestStore({ url: supabaseUrl, serviceKey });

Deno.serve(async (req: Request): Promise<Response> => {
  if (!supabaseUrl || !serviceKey) {
    console.error("payme-merchant: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
    return Response.json({ error: "not configured" }, { status: 500 });
  }
  // Read with a hard cap BEFORE anything else, so an oversized body is refused without being buffered.
  let rawBody = "";
  if (req.method === "POST") {
    const read = await readBodyCapped(req);
    if (!read.ok) return Response.json({ error: "payload too large" }, { status: 413 });
    rawBody = read.text;
  }
  const res = await handlePaymeRequest(
    { method: req.method, authorization: req.headers.get("authorization"), rawBody },
    { key, mode, testOrgs, packs, store },
  );
  return Response.json(res.body, { status: res.status });
});
