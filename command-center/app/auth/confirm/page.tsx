import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ConfirmSignIn } from "@/components/auth/ConfirmSignIn";
import { PENDING_COOKIE, decodePending } from "@/lib/auth-confirm";
import { safeNextPath } from "@/lib/safe-redirect";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * "Continue as <email>?" — the step between an emailed sign-in link and a
 * session (lib/auth-confirm.ts). Shown only while this browser holds a pending
 * sign-in; without one the link is spent, expired or was never opened here.
 * The address shown is the one Supabase verified, so a person handed someone
 * else's link sees at once that it is not theirs.
 */
export default async function ConfirmSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const pending = decodePending((await cookies()).get(PENDING_COOKIE)?.value);
  if (!pending) redirect("/login?error=link_invalid");
  const raw = (await searchParams).next;
  const next = safeNextPath(typeof raw === "string" ? raw : null);
  return <ConfirmSignIn email={pending.email} csrf={pending.csrf} next={next} />;
}
