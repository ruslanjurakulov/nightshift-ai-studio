import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MfaChallenge } from "@/components/auth/MfaChallenge";
import { isSupabaseConfigured } from "@/lib/config";
import { getDictionary } from "@/lib/i18n/server";
import { safeLoginReturn } from "@/lib/safe-redirect";
import { getUser } from "@/lib/supabase/server";
import { adminMfaMode, readMfaState } from "@/lib/security/admin-mfa-server";
import { normalizeAal } from "@/lib/security/aal";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  return { title: { absolute: `${t.mfa.title} · ${t.brand.name}` }, robots: { index: false, follow: false } };
}

/**
 * /login/verify: the second step of sign-in.
 *
 * The SERVER decides whether a code is needed, from the auth server's own
 * answer (lib/security/admin-mfa-server.ts), so this page cannot be skipped or
 * forced by what the browser claims. Anyone who needs nothing is sent straight
 * on, which is also what keeps the middleware's redirect to here from looping:
 * a session that the middleware sends here is, by the same rule, one this page
 * shows the form to.
 *
 * - Signed out: /login.
 * - `NIGHTSHIFT_ADMIN_MFA=off` (break-glass): no code is asked anywhere.
 * - Already aal2, or no verified factor (so no code exists): on to `next`.
 * - Otherwise the code form. If the state cannot be read the form is shown too:
 *   it can only ask for MORE, and it always has a sign-out.
 */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next: rawNext } = await searchParams;
  const next = safeLoginReturn(rawNext ?? null, "/command-center");
  if (!isSupabaseConfigured) redirect("/login");
  const user = await getUser();
  if (!user) redirect("/login");
  if (adminMfaMode() === "off") redirect(next);
  const state = await readMfaState(user);
  if (state && (!state.hasVerifiedFactor || normalizeAal(state.aal) === "aal2")) redirect(next);
  return <MfaChallenge next={next} />;
}
