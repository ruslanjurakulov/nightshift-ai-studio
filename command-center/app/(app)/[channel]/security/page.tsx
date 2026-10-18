import { PageHeader } from "@/components/PageHeader";
import { SecurityBoard } from "@/components/security/SecurityBoard";
import { OwnerSecurityPanel } from "@/components/security/OwnerSecurityPanel";
import { getDictionary } from "@/lib/i18n/server";
import { isOperator } from "@/lib/auth/org-roles";
import { createClient } from "@/lib/supabase/server";
import { ownerRpcOn } from "@/lib/server/owner-rpc";
import { readOwnerSecurity, readOwnerSecurityEvents } from "@/lib/server/owner-reads";
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
 *
 * With NIGHTSHIFT_OWNER_RPC=on, a platform owner/admin also sees the database's own
 * safety state, read-only (OwnerSecurityPanel): the gate, the limits, who has how many
 * authenticators, and the newest security events. The page offers no way to switch the
 * database gate; that is a separate, deliberate step.
 */
export default async function SecurityPage() {
  const { t } = await getDictionary();
  const showOwner = ownerRpcOn() && (await isOperator());
  const supabase = showOwner ? await createClient() : null;
  const [security, events] = supabase
    ? await Promise.all([readOwnerSecurity(supabase), readOwnerSecurityEvents(supabase, 30)])
    : [null, null];

  return (
    <div className="rhythm ns-open g5-page">
      <PageHeader icon="security" title={t.security.title} subtitle={t.security.subtitle} />
      <SecurityBoard />
      {security && events && (
        <OwnerSecurityPanel
          state={security.state}
          security={security.state === "ok" ? security.value : null}
          events={events.state === "ok" ? events.value : null}
          eventsState={events.state}
        />
      )}
    </div>
  );
}
