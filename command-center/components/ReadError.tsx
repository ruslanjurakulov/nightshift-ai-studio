"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

/**
 * The one "could not read this" state. It replaces a list, a table or a figure
 * whose read failed — never sits beside one that pretends to be empty — and
 * offers Retry. A server page retries by re-running itself (router.refresh());
 * a client load passes its own `onRetry`.
 */
export function ErrorState({
  message,
  onRetry,
  compact = false,
}: {
  /** A more specific, already-translated line; defaults to the generic one. */
  message?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();

  function retry() {
    if (onRetry) onRetry();
    else start(() => router.refresh());
  }

  return (
    <div
      role="alert"
      data-read-error
      className={`flex flex-col items-center justify-center gap-3 text-center ${compact ? "px-4 py-6" : "px-6 py-14"}`}
    >
      <span
        aria-hidden
        className="grid size-10 place-items-center rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-warn)]"
      >
        <AlertTriangle className="size-5" strokeWidth={1.5} />
      </span>
      <p className="m-0 text-[13px] font-semibold text-[var(--color-fg)]">{t.common.readFailedTitle}</p>
      <p className="m-0 max-w-[52ch] text-[13px] font-light leading-relaxed text-[var(--color-muted)]">
        {message ?? t.common.readFailedBody}
      </p>
      <button type="button" onClick={retry} disabled={pending} className="btn-sky rounded-[var(--ns-r-key)] px-4 py-1.5 text-[12px] disabled:opacity-40">
        {pending ? t.common.retrying : t.common.retry}
      </button>
    </div>
  );
}
