"use client";

import { ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

/**
 * The credit line a model's maker requires beside the model and its results (spec.attribution; Runway's Terms of Use §1:
 * "prominently display 'Powered by Runway' and link to runway.com"). The words are the maker's own and stay as given in every
 * language: the terms name that exact line. Only the spoken label around them is ours. Nothing is drawn when the model asks for none.
 */
export function ModelAttribution({
  attribution,
  className = "",
}: {
  attribution: { text: string; url: string } | null | undefined;
  className?: string;
}) {
  const { t, fmt } = useI18n();
  if (!attribution) return null;
  const label = fmt(t.gen.attributionOpens, { text: attribution.text });
  return (
    <a
      href={attribution.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      data-testid="model-attribution"
      className={`tap-link inline-flex w-fit items-center gap-1 text-xs text-[var(--color-muted)] underline underline-offset-2 ${className}`.trim()}
    >
      {attribution.text}
      <ExternalLink aria-hidden className="size-3 shrink-0" strokeWidth={2} />
    </a>
  );
}
