"use client";

import Link from "next/link";
import { Coins } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits, type CreditAccount } from "@/lib/credits";

/**
 * The organization's available credits, in the header — shown only for an
 * organization that pays (the layout passes null for the operator's own,
 * exempt organization, and before migration 0020). The hold for runs still in
 * progress is in the tooltip and on the Credits page it links to.
 */
export function CreditBalanceChip({ account }: { account: CreditAccount | null }) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  if (!account) return null;
  const title = fmt(t.credits.headerTitle, {
    available: formatCredits(account.available, locale),
    reserved: formatCredits(account.reserved, locale),
  });
  return (
    <Link
      href={path("/credits")}
      title={title}
      aria-label={`${t.credits.headerLabel}: ${title}`}
      className="btn-sky is-quiet pill h-9 gap-2 px-3 sm:h-10 sm:px-4"
    >
      <Coins aria-hidden className="size-3.5 shrink-0 text-[var(--color-muted)]" />
      <span className="mono text-[13px]" style={{ color: account.available > 0 ? undefined : "var(--color-warn)" }}>
        {formatCredits(account.available, locale)}
      </span>
      {account.reserved > 0 && (
        <span className="mono hidden text-[11px] text-[var(--color-muted)] sm:inline">
          +{formatCredits(account.reserved, locale)}
        </span>
      )}
    </Link>
  );
}
