import type { Metadata } from "next";
import Link from "next/link";
import { getDictionary } from "@/lib/i18n/server";
import { AuthShell } from "@/components/auth/AuthShell";
import { isInviteNotice } from "@/lib/friend-invites";

export const dynamic = "force-dynamic";

/** Not a page to index or share: it is the end of a link that did not open sign-up. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Where /i/<token> sends a visitor it cannot start a sign-up for. Two fixed
 * messages, chosen by a code in the URL and never by text from it:
 *   invalid   one neutral line for a link that is malformed, unknown, revoked,
 *             used up or switched off — it does not say which;
 *   existing  the visitor is signed in already: an invite counts new accounts only.
 * Anything else reads as `invalid`.
 */
export default async function InviteNoticePage({ searchParams }: { searchParams: Promise<{ s?: string | string[] }> }) {
  const { t } = await getDictionary();
  const raw = (await searchParams).s;
  const code = isInviteNotice(Array.isArray(raw) ? raw[0] : raw) ? (Array.isArray(raw) ? raw[0] : raw) : "invalid";
  const existing = code === "existing";
  return (
    <AuthShell title={existing ? t.signup.inviteExistingTitle : t.signup.inviteInvalidTitle} mode="signup">
      <p className="st-body mt-4 text-[var(--ns-text)]">{existing ? t.signup.inviteExistingBody : t.signup.inviteInvalidBody}</p>
      <div className="mt-8 flex flex-col gap-3">
        {existing ? (
          <Link href="/" className="st-key" data-block="true">
            {t.signup.inviteOpenApp}
          </Link>
        ) : (
          <>
            <Link href="/signup" className="st-key" data-block="true">
              {t.signup.inviteCreateAccount}
            </Link>
            <Link href="/login" className="st-link self-center text-sm">
              {t.signup.signIn}
            </Link>
          </>
        )}
      </div>
    </AuthShell>
  );
}
