"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { StateBlock } from "@/components/states/StateBlock";

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
  const { t } = usePublicI18n();
  const router = useRouter();
  const [pending, start] = useTransition();

  function retry() {
    if (onRetry) onRetry();
    else start(() => router.refresh());
  }

  return (
    <StateBlock
      role="alert"
      data-read-error
      tone="warn"
      compact={compact}
      title={t.common.readFailedTitle}
      actions={
        <button type="button" onClick={retry} disabled={pending} className="btn-quiet disabled:opacity-40">
          {pending ? t.common.retrying : t.common.retry}
        </button>
      }
    >
      {message ?? t.common.readFailedBody}
    </StateBlock>
  );
}
