"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { safeDigest } from "@/lib/feedback";

/**
 * What an error boundary shows. Deliberately says nothing about what failed:
 * a thrown message can hold a URL, a token prefix or a database row, and this
 * is the screen people screenshot to ask for help. The digest is the handle
 * that finds the real error in the server log.
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
  const { t } = useI18n();
  const digest = safeDigest(error.digest);

  useEffect(() => {
    // Still visible to whoever opens devtools, as it would be without a boundary.
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-4 py-16 text-center">
      <span
        aria-hidden
        className="grid size-12 place-items-center rounded-full border"
        style={{
          borderColor: "color-mix(in srgb, var(--color-fail) 45%, var(--color-border))",
          color: "var(--color-fail)",
        }}
      >
        <AlertTriangle className="size-5" />
      </span>
      <h1 className="text-xl font-semibold text-[var(--color-fg)]">{t.ux.errorTitle}</h1>
      <p className="text-[14px] leading-relaxed text-[var(--color-muted)]">{t.ux.errorBody}</p>
      <div className="mt-2 flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <button
          type="button"
          onClick={reset}
          className="btn-sky is-solid pill inline-flex items-center justify-center gap-2 px-5 py-2 text-[13px]"
        >
          <RotateCcw aria-hidden className="size-3.5" />
          {t.ux.errorRetry}
        </button>
        <Link href={homeHref} className="btn-sky is-quiet pill px-5 py-2 text-center text-[13px]">
          {t.ux.errorHome}
        </Link>
      </div>
      {digest && <p className="mono text-[11px] text-[var(--color-muted)]">{fmt(t.ux.errorRef, { digest })}</p>}
    </div>
  );
}
