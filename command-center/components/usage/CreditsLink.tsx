"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";

/** The way back to the Credits page (buying and the ledger live there), on this channel. */
export function CreditsLink() {
  const { t } = useI18n();
  const path = useChannelPath();
  return (
    <Link href={path("/credits")} className="btn-quiet text-sm">
      {t.usage.openCredits}
      <ArrowUpRight className="size-3.5" aria-hidden />
    </Link>
  );
}
