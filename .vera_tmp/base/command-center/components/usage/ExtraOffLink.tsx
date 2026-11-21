"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { USAGE_LINKS } from "@/lib/usage";

/**
 * Beside a "not enough credits" message that was caused by the workspace's
 * extra-credits switch (migration 0094): the one link that fixes it, to the
 * switch itself on the Usage page. Nothing is turned on from here.
 */
export function ExtraOffLink({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const path = useChannelPath();
  return (
    <Link
      href={path(USAGE_LINKS.extraSection)}
      className={`tap-link text-[var(--color-primary)] underline underline-offset-2 ${className}`}
      data-extra-off-link
    >
      {t.usage.refusal.turnOn}
    </Link>
  );
}
