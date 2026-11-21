"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { SESSION_ENDED_EVENT } from "@/lib/operator-post";
import { safeNextPath } from "@/lib/safe-redirect";

/**
 * The "sign in again" bar. Any owner action that learns the session is gone (lib/operator-post.ts) announces it on
 * `window`, and this bar stays until the person signs in: the inline message under the button says what did not happen,
 * this gives them the way forward from wherever they are, and brings them back to the same page.
 */
export function SessionEndedBar() {
  const { t } = useI18n();
  const pathname = usePathname();
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    const on = () => setEnded(true);
    window.addEventListener(SESSION_ENDED_EVENT, on);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, on);
  }, []);
  if (!ended) return null;
  const next = safeNextPath(pathname, "/command-center");
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[130] flex flex-wrap items-center justify-center gap-3 border-b border-[var(--ns-rule-strong)] bg-[var(--color-surface)] px-4 py-3 text-sm"
    >
      <span>{t.ownerTruth.sessionBar}</span>
      <a className="btn-primary" href={`/login?next=${encodeURIComponent(next)}`}>
        {t.ownerTruth.signInAgain}
      </a>
    </div>
  );
}
