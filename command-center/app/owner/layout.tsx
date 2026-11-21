import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { getUser } from "@/lib/supabase/server";
import { currentMfaAction, operatorLookup } from "@/lib/auth/org-roles";
import { ENROL_PATH, mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { ownerAccess } from "@/lib/server/owner-analytics";
import { AppProviders } from "@/components/AppProviders";
import { getDictionary, getLocale } from "@/lib/i18n/server";
import { AdminMfaBanner } from "@/components/security/AdminMfaBanner";
import { OwnerShell } from "@/components/owner-console/OwnerShell";
import { OWNER_CONSOLE } from "@/lib/owner-mode";
import { PATH_HEADER } from "@/lib/channels";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The Owner Console (/owner): the platform owner's account in the account switcher. Every request asks the database who
 * this is (owner_analytics_is_owner(), migration 0182 — the guard Owner Analytics uses): the owner gets the console, and
 * anyone else — a customer, an admin who is not the owner, a session that could not be checked as owner — gets the
 * public 404, exactly as for a URL that does not exist, so the console's existence says nothing. The pages behind it keep
 * their own database checks; this layout is the first lock, not the only one.
 *
 * The second factor is the app's own rule (docs/security/ADMIN_MFA.md), decided here again because this route is outside
 * the app's layout: a session that needs the code is sent to verify it first.
 */
export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  if (!isSupabaseConfigured) notFound();
  const user = await getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(OWNER_CONSOLE)}`);

  const lookup = await operatorLookup();
  const access = await ownerAccess();
  // The second factor is the admin's rule, and the platform owner is an admin: when the database has said "owner", that is
  // the answer even if the separate admin lookup failed — otherwise a failed lookup would let the owner in without the code.
  const mfa = await currentMfaAction(user, lookup.operator || access === "owner");
  const path = (await headers()).get(PATH_HEADER) ?? OWNER_CONSOLE;
  if (mfa === "challenge") redirect(mfaVerifyUrl(path));
  if (mfa === "enrol_only") redirect(ENROL_PATH);

  const { t } = await getDictionary();
  const locale = await getLocale();

  if (access !== "owner") {
    // Only an operator ever hears why: the database could not be asked, or it has no owner check yet. Anyone else (or an
    // operator the database answered "no" for: an admin) gets the 404 and learns nothing.
    if (lookup.operator && (access === "missing" || access === "error")) {
      const c = t.ownerConsole;
      return (
        <AppProviders locale={locale}>
          <main id="main" className="mx-auto flex max-w-xl flex-col gap-3 p-6">
            <h1 className="m-0 text-lg font-semibold">{c.title}</h1>
            <p role="alert" className="m-0 text-[var(--color-muted)]">
              {access === "missing" ? c.needsMigration : c.checkFailed}
            </p>
            {access === "error" && (
              <a className="btn-quiet self-start" href={OWNER_CONSOLE}>
                {c.retry}
              </a>
            )}
          </main>
        </AppProviders>
      );
    }
    notFound();
  }

  return (
    <AppProviders locale={locale}>
      <OwnerShell email={user.email ?? null}>
        <AdminMfaBanner action={mfa} t={t.mfa} path={path} />
        {children}
      </OwnerShell>
    </AppProviders>
  );
}
