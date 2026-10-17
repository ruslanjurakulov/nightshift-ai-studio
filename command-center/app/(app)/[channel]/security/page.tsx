import { PageHeader } from "@/components/PageHeader";
import { SecurityBoard } from "@/components/security/SecurityBoard";
import { getDictionary } from "@/lib/i18n/server";
import "../../app-pages-g5.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Security — two-factor authentication (TOTP).
 *
 * Enrolment and management run entirely in the client component against the
 * browser Supabase client's `auth.mfa.*` API; Supabase Auth stores the factors,
 * so there is no application table to read here. The application asks for the
 * code at sign-in (/login/verify, the middleware and the operator guards;
 * docs/security/ADMIN_MFA.md) — this page delivers the enrolment UI.
 */
export default async function SecurityPage() {
  const { t } = await getDictionary();

  return (
    <div className="rhythm ns-open g5-page">
      <PageHeader icon="security" title={t.security.title} subtitle={t.security.subtitle} />
      <SecurityBoard />
    </div>
  );
}
