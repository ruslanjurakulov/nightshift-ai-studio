"use client";

import { useI18n } from "@/lib/i18n/context";
import { EmailChangeForm } from "@/components/account/EmailChangeForm";
import { PasswordChangeForm } from "@/components/account/PasswordChangeForm";
import { HandleSection } from "@/components/account/HandleSection";
import type { HandleRow } from "@/lib/handles";

/**
 * Settings → Account and security: the sign-in e-mail, the password and the
 * @username, three open sections under one heading (the page's one lit desk is
 * the workspace name above; this is ruled, not lifted).
 */
export function AccountSecurity({
  email,
  pendingEmail,
  handle,
  signupHandle,
  handlesSupported,
}: {
  email: string;
  pendingEmail: string | null;
  handle: HandleRow | null;
  signupHandle: string | null;
  /** False before migration 0096 is applied: the username part is simply not shown. */
  handlesSupported: boolean;
}) {
  const { t } = useI18n();
  return (
    <section className="panel flex flex-col gap-7 p-5 sm:p-6" aria-labelledby="account-security-title">
      <div>
        <h2 id="account-security-title" className="t-section">
          {t.accountSecurity.title}
        </h2>
        <p className="g5-sub">{t.accountSecurity.sub}</p>
      </div>
      {handlesSupported && <HandleSection row={handle} signupHandle={signupHandle} />}
      <div className={handlesSupported ? "border-t border-[var(--ns-rule)] pt-7" : undefined}>
        <EmailChangeForm email={email} pendingEmail={pendingEmail} />
      </div>
      <div className="border-t border-[var(--ns-rule)] pt-7">
        <PasswordChangeForm email={email} />
      </div>
    </section>
  );
}
