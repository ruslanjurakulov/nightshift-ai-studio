"use client";

import { usePublicI18n } from "@/lib/i18n/public-context";
import { fmt } from "@/lib/i18n/core";
import { AuthShell } from "@/components/auth/AuthShell";

/**
 * The confirmation card. A plain HTML form, posted by the browser itself to
 * /auth/callback — it works without JavaScript, and it is the only thing that
 * turns a pending sign-in into a session.
 */
export function ConfirmSignIn({ email, csrf, next, recovery = false }: { email: string; csrf: string; next: string; recovery?: boolean }) {
  const { t } = usePublicI18n();
  const s = t.signup;
  // A password-recovery link says what it will do: reset THIS account's password.
  const title = recovery ? t.recovery.confirmTitle : s.confirmTitle;
  const body = recovery ? t.recovery.confirmBody : s.confirmBody;
  const cont = recovery ? t.recovery.confirmContinue : s.confirmContinue;
  const warning = recovery ? t.recovery.confirmWarning : s.confirmWarning;
  return (
    <AuthShell title={title} subtitle={fmt(body, { email })}>
      <form method="post" action="/auth/callback" className="mt-8 flex flex-col gap-3">
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="next" value={next} />
        <button
          type="submit"
          name="action"
          value="continue"
          className="st-key"
          data-block="true"
        >
          <span className="truncate normal-case tracking-normal">{fmt(cont, { email })}</span>
        </button>
        <button
          type="submit"
          name="action"
          value="cancel"
          className="st-key"
          data-tone="quiet"
          data-block="true"
        >
          {s.confirmCancel}
        </button>
        <p className="st-alert mt-2" data-tone="warn">
          <span aria-hidden className="ns-lamp mt-1.5" data-tone="warn" />
          <span>{warning}</span>
        </p>
      </form>
    </AuthShell>
  );
}
