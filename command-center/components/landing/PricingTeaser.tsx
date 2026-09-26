import Link from "next/link";
import { ArrowRight, Coins, Eye, RotateCcw } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import type { PricingTeaser as PricingTeaserData } from "@/lib/landing";
import { SectionHead } from "@/components/landing/SectionHead";

/**
 * How Nightshift charges, and the packs — from the same source /pricing uses
 * (lib/pricing.ts via pricingTeaser()). A price appears only when the owner
 * set one; a pack Paddle sells without a display price reads "price at
 * checkout", and with nothing configured the section says pricing is
 * announced at launch. /pricing has the full picture.
 */
export function PricingTeaser({
  t,
  locale,
  teaser,
  hour,
}: {
  t: Dictionary;
  locale: Locale;
  teaser: PricingTeaserData;
  hour: string;
}) {
  const p = t.landing.pricing;
  const icons = [Coins, Eye, RotateCcw];

  return (
    <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-24">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-14">
        <div>
          <SectionHead hour={hour} eyebrow={p.eyebrow} title={p.title} lead={p.lead} id="pricing-title" />
          <ul className="mt-10 flex flex-col gap-6">
            {p.points.map((pt, i) => {
              const Icon = icons[i] ?? Coins;
              return (
                <li key={pt.title} className="flex gap-4">
                  <Icon className="mt-0.5 size-5 shrink-0 text-[var(--color-primary)]" aria-hidden />
                  <div>
                    <h3 className="t-panel">{pt.title}</h3>
                    <p className="mt-1 text-[14px] font-light leading-relaxed text-[var(--color-muted)]">{pt.body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="glass-card flex flex-col gap-6 self-start rounded-[22px] border border-[var(--color-border)] p-6 sm:p-8">
          {teaser.kind === "announced" ? (
            <div className="flex flex-col gap-3">
              <span className="t-label">{p.packsLabel}</span>
              <h3 className="text-[1.5rem] font-semibold tracking-[-0.02em]">{p.announcedTitle}</h3>
              <p className="text-[15px] font-light leading-relaxed text-[var(--color-muted)]">{p.announcedBody}</p>
            </div>
          ) : (
            <div>
              <h3 className="t-label">{p.packsLabel}</h3>
              <ul className="mt-4 flex flex-col">
                {teaser.packs.map((pack) => (
                  <li
                    key={pack.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-[var(--color-border)] py-4"
                  >
                    <span className="flex flex-col">
                      <span className="text-[15px] font-medium">{t.credits.buy.pack[pack.id]}</span>
                      <span className="mono text-[12px] text-[var(--color-muted)]">
                        {fmt(p.credits, { n: formatCredits(pack.credits, locale) })}
                      </span>
                    </span>
                    {pack.price ? (
                      <span className="font-display text-[1.5rem] font-semibold tracking-[-0.02em]">{pack.price}</span>
                    ) : (
                      <span className="text-[13px] text-[var(--color-muted)]">{p.atCheckout}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Link href="/pricing" className="btn-sky pill min-h-11 self-start px-5 text-sm">
            {p.cta}
            <ArrowRight className="btn-arrow size-4" aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}
