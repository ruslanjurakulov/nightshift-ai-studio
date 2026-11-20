import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { AGE_PAGE_METHODS, AGE_TERMS_VERSION, coerceAgeState } from "@/lib/age";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "no-store" };

/**
 * POST { adult: boolean, from: "welcome" | "create" } — the person's own 18+ statement, recorded once by the database for the
 * signed-in user only (0199's record_adult_attestation: security definer, auth.uid(), first answer stands). The method is
 * chosen here, not by the body: an account that signed in with Google is recorded as "google". Nothing else is written,
 * spent or read. GET answers the current state for the page.
 */
export const POST = requireSameOrigin(async (request: Request) => {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }
  const b = (body ?? {}) as { adult?: unknown; from?: unknown };
  if (typeof b.adult !== "boolean" || !(AGE_PAGE_METHODS as readonly unknown[]).includes(b.from))
    return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  const provider = (user.app_metadata as { provider?: unknown } | undefined)?.provider;
  const method = provider === "google" ? "google" : (b.from as string);
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });
  const { data, error } = await supabase.rpc("record_adult_attestation", {
    p_adult: b.adult,
    p_terms_version: AGE_TERMS_VERSION,
    p_method: method,
  });
  // A database without 0199 cannot record anything: say so, never pretend it was saved.
  if (error) return NextResponse.json({ error: "age_unavailable" }, { status: 503, headers: NO_STORE });
  const state = coerceAgeState(data);
  const recorded = (data as { recorded?: unknown } | null)?.recorded === true;
  return NextResponse.json({ state, recorded }, { headers: NO_STORE });
});

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ state: "unknown" }, { headers: NO_STORE });
  const { data, error } = await supabase.rpc("my_adult_attestation");
  return NextResponse.json({ state: error ? "unknown" : coerceAgeState(data) }, { headers: NO_STORE });
}
