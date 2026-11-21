"use client";

import Link from "next/link";
import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { fmt } from "@/lib/i18n/core";
import { safeDigest } from "@/lib/feedback";
import "@/app/(app)/app-pages-g5.css";

/**
 * What an error boundary shows. Deliberately says nothing about what failed:
 * a thrown message can hold a URL, a token prefix or a database row, and this
 * is the screen people screenshot to ask for help. The digest is the handle
 * that finds the real error in the server log.
 *
 * It says what is true (this page could not load, nothing saved was lost) and
 * offers the one next step as the lit key (try again), with the way out beside
 * it. It carries its own look because it also renders where the app's shell
 * (and its stylesheet) is gone: the root boundary and global-error.
 */
export function ErrorScreen({
  error,
  reset,
  homeHref,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref: string;
}) {
  const { t } = usePublicI18n();
  const digest = safeDigest(error.digest);

  useEffect(() => {
    // Still visible to whoever opens devtools, as it would be without a boundary.
    console.error(error);
  }, [error]);

  return (
    <div className="g5-boundary">
      <section role="alert" className="g5-boundary-desk">
        <div aria-hidden className="g5-boundary-slug">
          <span className="ns-lamp" data-tone="fail" data-size="md" />
        </div>
        <h1 className="g5-boundary-title">{t.ux.errorTitle}</h1>
        <p className="g5-state-body">{t.ux.errorBody}</p>
        <div className="g5-state-actions">
          <button type="button" onClick={reset} className="btn-primary">
            <RotateCcw aria-hidden className="size-4" />
            {t.ux.errorRetry}
          </button>
          <Link href={homeHref} className="btn-quiet">
            {t.ux.errorHome}
          </Link>
        </div>
        {digest && <p className="mono g5-boundary-ref">{fmt(t.ux.errorRef, { digest })}</p>}
      </section>
    </div>
  );
}
