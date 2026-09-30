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
          className="cta-glass pill inline-flex items-center justify-center px-6 py-3 text-sm font-semibold"
        >
          <span className="truncate">{fmt(s.confirmContinue, { email })}</span>
        </button>
        <button
          type="submit"
          name="action"
          value="cancel"
          className="pill inline-flex items-center justify-center px-6 py-3 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          {s.confirmCancel}
        </button>
        <p className="mt-2 text-[12px] font-light text-[var(--color-muted)]">{s.confirmWarning}</p>
      </form>
    </AuthShell>
  );
}
