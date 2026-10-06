import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Dictionary, Locale } from "@/lib/i18n";
import type { PricingTeaser } from "@/lib/landing";
import { formatCredits } from "@/lib/credits";
import { CREDIT_PACKS } from "@/lib/paddle";
import { displayPriceText, WELCOME_CREDITS } from "@/lib/pricing";
import type { PriceRates } from "@/lib/site/price-check";
import { PriceCheck } from "@/components/landing/PriceCheck";

/**
 * Money in one place: the price check (from the published rate; absent when
 * none is published) beside what is on sale, the plans or the credit packs,
 * each priced only as far as the pricing source says (a pack Paddle sells
 * without a display price reads "price at checkout"; with nothing configured
 * the sizes are listed and prices are said not to be published). No second
 * "what it costs" panel, no ledger, no terms list: those are one tap away on
 * /pricing.
 */
export function PriceBlock({ t, locale, teaser, rates }: { t: Dictionary; locale: Locale; teaser: PricingTeaser; rates: PriceRates | null }) {
  const p = t.site.pricingTeaser;
  const rows =
    teaser.kind === "plans"
      ? teaser.plans.map((x) => ({ id: x.id, name: x.name, credits: x.credits, price: x.price, unit: `${p.credits} · ${p.perMonth}` }))
      : (teaser.kind === "packs" ? teaser.packs : CREDIT_PACKS.map((x) => ({ id: x.id, credits: x.credits, price: null as string | null }))).map((x) => ({
          id: x.id,
          name: t.credits.buy.pack[x.id],
          credits: x.credits,
          price: teaser.kind === "packs" ? x.price : null,
          unit: p.credits,
        }));
  const showPrice = teaser.kind !== "announced";
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="nx-section">
      <div className="nx-wrap">
        <h2 id="pricing-title" className="nx-h2">
          {p.title}
        </h2>
        <p className="nx-sub">{teaser.kind === "plans" ? p.lead : p.leadNoPlans}</p>
        <div className="nx-price-grid">
          {rates && <PriceCheck t={t} locale={locale} rates={rates} welcome={WELCOME_CREDITS} cta={false} />}
          <div className="nx-packs" data-spot>
            <h3 className="nx-packs-h">{teaser.kind === "plans" ? p.plansLabel : p.packsCaption}</h3>
            <ul className="nx-packs-list">
              {rows.map((r) => (
                <li key={r.id}>
                  <span className="nx-packs-name">{r.name}</span>
                  <span className="nx-packs-credits">
                    {formatCredits(r.credits, locale)} <small>{r.unit}</small>
                  </span>
                  {showPrice && (r.price ? <span className="nx-packs-price">{displayPriceText(r.price, locale)}</span> : <span className="nx-packs-pending">{p.atCheckout}</span>)}
                </li>
              ))}
            </ul>
            {teaser.kind === "announced" && <p className="nx-packs-note">{p.sizesBody}</p>}
            <Link href="/pricing" className="nx-link nx-packs-more">
              {p.cta}
              <ArrowRight aria-hidden />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
