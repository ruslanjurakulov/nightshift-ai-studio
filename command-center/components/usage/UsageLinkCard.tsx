"use client";

import Link from "next/link";
import { ArrowUpRight, Activity } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";

/**
 * On the Credits page: one quiet row that points to the Usage page, where the
 * plan's allowance for this period and the extra-credits switch live. Credits
 * keeps buying and the ledger; this is the way across, not a second copy.
 */
export function UsageLinkCard() {
  const { t } = useI18n();
  const path = useChannelPath();
  const c = t.usage.fromCredits;
  return (
    <Link
      href={path("/usage")}
      className="panel flex min-h-[64px] items-center justify-between gap-4 p-4 sm:px-6"
      data-usage-link
    >
      <span className="flex min-w-0 items-start gap-3">
        <Activity aria-hidden className="mt-0.5 size-[18px] shrink-0 text-[var(--color-primary)]" strokeWidth={1.75} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[15px] font-medium">{c.title}</span>
          <span className="text-[13px] text-[var(--color-muted)]">{c.hint}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[13px] text-[var(--color-primary)]">
        <span className="hidden sm:inline">{c.open}</span>
        <ArrowUpRight aria-hidden className="size-4" />
        <span className="sr-only sm:hidden">{c.open}</span>
      </span>
    </Link>
  );
}
