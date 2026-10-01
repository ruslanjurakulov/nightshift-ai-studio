import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Dictionary, Locale } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { CREDIT_PACKS } from "@/lib/paddle";
import type { PricingTeaser as PricingTeaserData } from "@/lib/landing";
import { Slug } from "@/components/site/Slug";

/**
 * How Nightshift charges, and what is on sale — from the same source /pricing
 * uses (lib/pricing.ts and the plan catalog, via pricingTeaser()). A price
 * appears only when the owner set one; a pack Paddle sells without a display
 * price reads "price at checkout". With nothing on sale the panel lists the
 * pack sizes the checkout will sell (CREDIT_PACKS, the same list the payment
 * webhook credits) and says plainly that prices are not published yet.
 */
export function PricingTeaser({
  t,
  locale,
  teaser,
}: {
  t: Dictionary;
  locale: Locale;
  teaser: PricingTeaserData;
  hour?: string;
}) {
  const p = t.site.pricingTeaser;
  const old = t.landing.pricing;

  return (
    <section id="pricing" aria-labelledby="pricing-title" className="st-section">
      <div className="st-wrap">
        <Slug>{p.slug}</Slug>
        <div className="mt-8 grid gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-14">
          <div>
            <h2 id="pricing-title" className="st-h2">
              {p.title}
            </h2>
            <p className="st-lead mt-6">{p.lead}</p>
            <ol className="st-flow" aria-label={p.slug}>
              {p.ledger.map((step) => (
                <li key={step.id} data-id={step.id}>
                  <b>{step.word}</b>
                  <span>{step.body}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="st-panel self-start">
            {teaser.kind === "plans" ? (
              <>
                <div className="st-panel-head">
                  <h3 className="st-kicker text-[var(--ns-text)]">{p.plansLabel}</h3>
                </div>
                <ul className="st-price-rows">
                  {teaser.plans.map((plan) => (
                    <li key={plan.id} className="st-price-row">
                      <span className="st-price-name">{plan.name}</span>
                      <span className="st-price-credits st-num">
                        {formatCredits(plan.credits, locale)}
                        <small>
                          {p.credits} · {p.perMonth}
                        </small>
                      </span>
                      {plan.price ? (
                        <span className="st-price-money st-num">{plan.price}</span>
                      ) : (
                        <span className="st-price-pending">{p.atCheckout}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : teaser.kind === "packs" ? (
              <>
                <div className="st-panel-head">
                  <h3 className="st-kicker text-[var(--ns-text)]">{p.packsLabel}</h3>
                </div>
                <ul className="st-price-rows">
                  {teaser.packs.map((pack) => (
                    <li key={pack.id} className="st-price-row">
                      <span className="st-price-name">{t.credits.buy.pack[pack.id]}</span>
                      <span className="st-price-credits st-num">
                        {formatCredits(pack.credits, locale)}
                        <small>{p.credits}</small>
                      </span>
                      {pack.price ? (
                        <span className="st-price-money st-num">{pack.price}</span>
                      ) : (
                        <span className="st-price-pending">{p.atCheckout}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <div className="st-panel-head">
                  <h3 className="st-kicker text-[var(--ns-text)]">{old.announcedTitle}</h3>
                </div>
                <div className="px-4 pt-4">
                  <p className="st-small">{p.sizesBody}</p>
                </div>
                <ul className="st-price-rows" aria-label={p.sizesTitle}>
                  {CREDIT_PACKS.map((pack) => (
                    <li key={pack.id} className="st-price-row">
                      <span className="st-price-name">{t.credits.buy.pack[pack.id]}</span>
                      <span className="st-price-credits st-num">
                        {formatCredits(pack.credits, locale)}
                        <small>{p.credits}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="border-t border-[var(--ns-rule)] px-4 py-2">
              <Link href="/pricing" className="st-link">
                {p.cta}
                <ArrowRight aria-hidden />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
