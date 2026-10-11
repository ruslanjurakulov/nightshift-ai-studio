import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { RECOVERY_COOKIE, decodeRecovery, recoveryMatches } from "@/lib/recovery";
import { FORGOT_PASSWORD_PATH } from "@/lib/public-paths";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  return { title: { absolute: `${t.recovery.resetTitle} · ${t.brand.name}` }, robots: { index: false, follow: false } };
}

/**
 * Choose a new password. Meant for a RECOVERY session: a signed-in session that
 * /auth/callback marked for this page (lib/recovery.ts) and that belongs to the
 * same account the marker names. Anyone else — signed out, or signed in the
 * ordinary way, which has Settings → Account and security — is sent to
 * /forgot-password with a fixed notice. That is a UX guard, not a security
 * control: the marker is unsigned and adds no capability beyond the session. The e-mail shown
 * is the account's own, so a person is never asked to reset one they do not
 * recognise without seeing whose it is.
 */
export default async function ResetPasswordPage() {
  const user = await getUser();
  const marker = decodeRecovery((await cookies()).get(RECOVERY_COOKIE)?.value);
  if (!user || !recoveryMatches(marker, user.id)) redirect(`${FORGOT_PASSWORD_PATH}?s=needs_link`);
  return <ResetPasswordForm email={user.email ?? ""} />;
}
