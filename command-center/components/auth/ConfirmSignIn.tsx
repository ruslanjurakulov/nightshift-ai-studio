"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { AuthShell } from "@/components/auth/AuthShell";

/**
 * The confirmation card. A plain HTML form, posted by the browser itself to
 * /auth/callback — it works without JavaScript, and it is the only thing that
 * turns a pending sign-in into a session.
 */
export function ConfirmSignIn({ email, csrf, next }: { email: string; csrf: string; next: string }) {
  const { t } = useI18n();
  const s = t.signup;
  return (
    <AuthShell title={s.confirmTitle} subtitle={fmt(s.confirmBody, { email })}>
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
          <span className="truncate normal-case tracking-normal">{fmt(s.confirmContinue, { email })}</span>
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
          <span>{s.confirmWarning}</span>
        </p>
      </form>
    </AuthShell>
  );
}
