"use client";

import Link from "next/link";
import { Dna } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

/**
 * "Using channel DNA · Change" — said wherever a form started from the
 * channel's DNA (migration 0056), so a pre-filled value never reads as one the
 * person chose. "Change" opens the channel's DNA card; changing a value in the
 * form itself changes only this job.
 */
export function ChannelDnaHint({ href }: { href: string }) {
  const { t } = useI18n();
  return (
    <p className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]" data-testid="dna-hint">
      <Dna aria-hidden className="size-3.5 shrink-0 text-[var(--color-primary)]" />
      <span>{t.dna.using}</span>
      <span aria-hidden>·</span>
      <Link href={href} aria-label={`${t.dna.change}: ${t.dna.title}`} className="tap-link text-[var(--color-primary)] underline">
        {t.dna.change}
      </Link>
    </p>
  );
}
