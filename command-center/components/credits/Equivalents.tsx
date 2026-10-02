"use client";

import { usePublicI18n } from "@/lib/i18n/public-context";
import { fmt } from "@/lib/i18n/core";
import { creditEquivalents, type GenerationRates } from "@/lib/plans";

type Forms = { one: string; few: string; many: string; other: string };

/** The plural form for `n` in `locale` (Russian needs one/few/many; en and uz one/other). */
export function pluralForm(forms: Forms, n: number, locale: string): string {
  let cat: Intl.LDMLPluralRule = "other";
  try {
    cat = new Intl.PluralRules(locale).select(n);
  } catch {
    // An unknown locale falls back to "other", which every dictionary fills.
  }
  return cat === "one" || cat === "few" || cat === "many" ? forms[cat] : forms.other;
}

/** A date as "1 Oct 2026" in the page's language; "—" when there is none. */
export function shortDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(d);
}

/**
 * "≈ 1,200 images · or ≈ 40 videos of 5 s" for an amount of credits — each
 * part computed from today's prices (lib/plans.ts creditEquivalents) and left
 * out when that kind of generation has no price. Renders nothing when no part
 * can be computed: no equivalent is better than an invented one.
 */
export function Equivalents({ credits, rates, className = "" }: { credits: number; rates: GenerationRates | null; className?: string }) {
  const { t, locale } = usePublicI18n();
  const eq = creditEquivalents(credits, rates);
  if (!eq) return null;
  const e = t.creditsPage.eq;
  const n = (v: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v);
  const parts: string[] = [];
  if (eq.images !== null) parts.push(fmt(pluralForm(e.images, eq.images, locale), { n: n(eq.images) }));
  if (eq.videos) parts.push(fmt(pluralForm(e.videos, eq.videos.count, locale), { n: n(eq.videos.count), s: eq.videos.seconds }));
  if (eq.minutes !== null) parts.push(fmt(pluralForm(e.minutes, eq.minutes, locale), { n: n(eq.minutes) }));
  return (
    <p
      className={`flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] leading-relaxed text-[var(--color-muted)] [font-variant-numeric:tabular-nums] ${className}`}
      data-equivalents
    >
      {parts.map((p, i) => (
        <span key={p} className="inline-flex items-baseline gap-x-1.5">
          {i > 0 && <span>{e.or}</span>}
          <span className="whitespace-nowrap text-[var(--color-fg)]">{p}</span>
        </span>
      ))}
    </p>
  );
}
