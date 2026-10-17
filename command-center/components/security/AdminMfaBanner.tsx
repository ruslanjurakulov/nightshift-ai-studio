"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { mfaVerifyUrl, type MfaAction } from "@/lib/security/admin-mfa";

/** localStorage key holding the time (ms) the "turn on 2-step" nudge was last hidden. */
export const MFA_BANNER_DISMISS_KEY = "ns.mfaBanner.dismissedAt";
/** A hidden nudge comes back after this long, so it is not forgotten for good. */
export const MFA_BANNER_QUIET_MS = 24 * 60 * 60 * 1000;

/** Was the nudge hidden recently enough to stay hidden? Storage may be blocked: then it simply shows. */
export function mfaBannerDismissed(now = Date.now()): boolean {
  try {
    const at = Number(window.localStorage.getItem(MFA_BANNER_DISMISS_KEY));
    return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < MFA_BANNER_QUIET_MS;
  } catch {
    return false;
  }
}

/**
 * The notice an operator sees while the second-factor gate is not blocking
 * them (docs/security/ADMIN_MFA.md): either their session is still
 * password-only although they have an authenticator (finish the code), or they
 * have no authenticator at all (enrol one at /security). One compact row; the
 * keys are full-height touch targets on a phone.
 *
 * Only the "no authenticator yet" nudge can be hidden (for a day, remembered in
 * this browser). The "enter your code" notice has no close key and ignores the
 * stored choice: that session really is half signed-in and must say so.
 *
 * Draws nothing for any other action, so the layout can pass the gate's answer
 * straight in.
 */
export function AdminMfaBanner({ action, t, path }: { action: MfaAction; t: Dictionary["mfa"]; path?: string | null }) {
  const [hidden, setHidden] = useState(false);
  const complete = action === "warn_complete";

  useEffect(() => {
    if (action === "warn_enrol" && mfaBannerDismissed()) setHidden(true);
  }, [action]);

  if (action !== "warn_complete" && action !== "warn_enrol") return null;
  if (hidden && !complete) return null;

  function dismiss() {
    setHidden(true);
    try {
      window.localStorage.setItem(MFA_BANNER_DISMISS_KEY, String(Date.now()));
    } catch {
      /* storage blocked: it is hidden for this page view only */
    }
  }

  return (
    <div
      role="status"
      data-testid="admin-mfa-banner"
      data-action={action}
      className="relative z-20 flex items-center gap-x-3 border-b border-[var(--ns-rule)] px-4 py-1 text-sm sm:px-6"
    >
      <span aria-hidden className="ns-lamp shrink-0" data-tone="warn" />
      <p className="min-w-0 flex-1 py-1 leading-snug">{complete ? t.bannerComplete : t.bannerEnrol}</p>
      <Link
        href={complete ? mfaVerifyUrl(path) : "/security"}
        className="btn-quiet inline-flex min-h-11 shrink-0 items-center px-3 text-sm font-medium"
      >
        {complete ? t.bannerCompleteAction : t.bannerEnrolAction}
      </Link>
      {!complete && (
        <button
          type="button"
          onClick={dismiss}
          aria-label={t.bannerDismiss}
          title={t.bannerDismiss}
          className="grid size-11 shrink-0 place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          <X aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}
