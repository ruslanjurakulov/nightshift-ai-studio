import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import type { PricingTeaser } from "@/lib/landing";
import { formatCredits } from "@/lib/credits";
import { CREDIT_PACKS } from "@/lib/paddle";
import { displayPriceText, packMinutes, WELCOME_CREDITS } from "@/lib/pricing";
import type { PriceRates } from "@/lib/site/price-check";
import { PriceCheck } from "@/components/landing/PriceCheck";

/**
 * Money in one place: the quote as an itemised slip (from the published rate;
 * absent when none is published) beside what is on sale, the plans or the
 * credit packs as large rows, each priced only as far as the pricing source
 * says (a pack Paddle sells without a display price reads "price at checkout";
 * with nothing configured the sizes are listed and prices are said not to be
 * published). The welcome grant is the first row, from WELCOME_CREDITS, and
 * the minutes under a plan are its credits at the published per-minute rate.
 * No second "what it costs" panel, no ledger, no terms list: those are one tap
 * away on /pricing.
 */
export function PriceBlock({ t, locale, teaser, rates }: { t: Dictionary; locale: Locale; teaser: PricingTeaser; rates: PriceRates | null }) {
  const p = t.site.pricingTeaser;
  const showPrice = teaser.kind !== "announced";
  type Row = { id: string; name: string; price: string | null; detail: string[] };
  const packCredits = (n: number) => `${formatCredits(n, locale)} ${p.credits}`;
  const free: Row = {
    id: "free",
    name: t.site.anchor.freeLabel,
    // "Free" is the plan page's own word for the welcome grant, not a price this file makes up.
    price: t.plans.free,
    detail: [fmt(t.site.anchor.freeValue, { n: formatCredits(WELCOME_CREDITS, locale) })],
  };
  const rows: Row[] =
    teaser.kind === "plans"
      ? teaser.plans.map((x) => {
          const minutes = packMinutes(x.credits, rates?.perMinute ?? null);
          return {
            id: x.id,
            name: x.name,
            price: x.price ? displayPriceText(x.price, locale) : null,
            detail: [fmt(t.plans.monthlyCredits, { n: formatCredits(x.credits, locale) }), ...(minutes !== null ? [fmt(t.plans.minutes, { m: formatCredits(minutes, locale) })] : [])],
          };
        })
      : (teaser.kind === "packs" ? teaser.packs : CREDIT_PACKS.map((x) => ({ id: x.id, credits: x.credits, price: null as string | null }))).map((x) => ({
          id: x.id,
          name: t.credits.buy.pack[x.id],
          price: teaser.kind === "packs" && x.price ? displayPriceText(x.price, locale) : null,
          detail: [packCredits(x.credits)],
        }));
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="nx-section">
      <div className="nx-wrap">
        <h2 id="pricing-title" className="nx-h2">
          {p.title}
        </h2>
        <p className="nx-sub">{teaser.kind === "plans" ? p.lead : p.leadNoPlans}</p>
        <div className="nx-price-grid">
          {rates && <PriceCheck t={t} locale={locale} rates={rates} welcome={WELCOME_CREDITS} cta={false} slip />}
          <div className="nx-plans">
            <h3 className="nx-plans-h">{teaser.kind === "plans" ? p.plansLabel : p.packsCaption}</h3>
            {teaser.kind === "plans" && <p className="nx-plans-lead">{t.pricing.noYearly}</p>}
            <ul className="nx-plans-list">
              {[free, ...rows].map((r) => (
                <li key={r.id}>
                  <span className="nx-rows-name">{r.name}</span>
                  {r.id === "free" || showPrice ? (
                    r.price ? (
                      <span className="nx-rows-fig" data-free={r.id === "free" ? "true" : undefined}>
                        {r.price}
                        {r.id !== "free" && teaser.kind === "plans" && <small>{p.perMonth}</small>}
                      </span>
                    ) : (
                      <span className="nx-rows-pending">{p.atCheckout}</span>
                    )
                  ) : null}
                  <p className="nx-rows-detail">
                    {r.detail.map((d) => (
                      <span key={d}>{d}</span>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
            {teaser.kind === "announced" && <p className="nx-plans-note">{p.sizesBody}</p>}
            <Link href="/pricing" className="nx-link nx-plans-more">
              {p.cta}
              <ArrowRight aria-hidden />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
