"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { copyText } from "@/lib/feedback";
import { useToast } from "@/components/feedback/ToastProvider";

/**
 * A quiet icon button beside an id or URL the operator is meant to paste
 * somewhere else — a GitHub run, a support message, a query. Confirms with a
 * toast and a brief check mark; says so when the browser refused the copy
 * rather than claiming it worked.
 */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function onCopy() {
    const ok = await copyText(value, typeof navigator !== "undefined" ? navigator.clipboard : null);
    if (ok) {
      setCopied(true);
      toast.success(t.ux.copied);
    } else {
      toast.error(t.ux.copyFailed);
    }
  }

  const aria = label ? fmt(t.ux.copyLabel, { label }) : t.ux.copy;
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={aria}
      title={aria}
      className="press inline-grid size-6 shrink-0 place-items-center rounded-md align-middle text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-primary)]"
    >
      {copied ? (
        <Check aria-hidden className="size-3.5" style={{ color: "var(--color-ok)" }} />
      ) : (
        <Copy aria-hidden className="size-3.5" />
      )}
    </button>
  );
}
