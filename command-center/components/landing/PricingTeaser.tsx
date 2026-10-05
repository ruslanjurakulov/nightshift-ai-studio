import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import type { Dictionary, Locale } from "@/lib/i18n";
import type { PackExpiry } from "@/lib/plans";
import { expiryTerm } from "@/components/landing/Faq";
import { formatCredits } from "@/lib/credits";
import { CREDIT_PACKS } from "@/lib/paddle";
import type { MoneyAnchor as Anchor, PricingTeaser as PricingTeaserData } from "@/lib/landing";
import { MoneyAnchor } from "@/components/site/MoneyAnchor";
import { displayPriceText } from "@/lib/pricing";

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
  anchor,
  expiry,
}: {
  t: Dictionary;
  locale: Locale;
  teaser: PricingTeaserData;
  anchor: Anchor;
  expiry: PackExpiry;
}) {
  const p = t.site.pricingTeaser;
  // The pack terms /pricing lists (one-time, expiry, failures returned), here
  // under the packs: what a buyer needs next to the sizes, in the space the
  // taller money column leaves. Plans have their own terms on /pricing.
  const tp = t.pricing;
  const packTerms =
    teaser.kind === "plans"
      ? []
      : [tp.terms[2], expiryTerm(tp, expiry), tp.terms[3]];

  return (
    <section id="pricing" aria-labelledby="pricing-title" className="st-section">
      <div className="st-wrap st-pricing">
        {/* Opens on the ledger, not a slug: the four words a credit goes
            through, as wide as the page. In the document the heading still
            comes first; on screen the ledger leads (CSS order). */}
        <div className="st-pricing-words">
          <h2 id="pricing-title" className="st-h2">
            {p.title}
          </h2>
          <p className="st-lead mt-6">{teaser.kind === "plans" ? p.lead : p.leadNoPlans}</p>
          <MoneyAnchor t={t} locale={locale} anchor={anchor} titleId="teaser-anchor-title" level={3} className="mt-10" />
        </div>
        <ol className="st-flow st-flow-lead" aria-label={p.slug}>
          {p.ledger.map((step) => (
            <li key={step.id} data-id={step.id}>
              <b>{step.word}</b>
              <span>{step.body}</span>
            </li>
          ))}
        </ol>

        <div className="st-pricing-side">
          <div className="st-panel st-pricing-packs">
            {teaser.kind === "plans" ? (
              <>
                <h3 className="st-caption">{p.plansLabel}</h3>
                <ul className="st-price-rows">
                  {teaser.plans.map((plan) => (
                    <li key={plan.id} className="st-price-row" data-spot>
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
            ) : (
              <>
                {/* Visible, not only an aria-label: these are one-time top-ups, not plans. */}
                <h3 id="teaser-packs-title" className="st-caption">
                  {p.packsCaption}
                </h3>
                <ul className="st-price-rows" aria-labelledby="teaser-packs-title">
                  {(teaser.kind === "packs" ? teaser.packs : CREDIT_PACKS.map((x) => ({ id: x.id, credits: x.credits, price: null }))).map(
                    (pack) => (
                      <li key={pack.id} className="st-price-row" data-spot>
                        <span className="st-price-name">{t.credits.buy.pack[pack.id]}</span>
                        <span className="st-price-credits st-num">
                          {formatCredits(pack.credits, locale)}
                          <small>{p.credits}</small>
                        </span>
                        {teaser.kind === "packs" &&
                          (pack.price ? (
                            <span className="st-price-money st-num">{displayPriceText(pack.price, locale)}</span>
                          ) : (
                            <span className="st-price-pending">{p.atCheckout}</span>
                          ))}
                      </li>
                    ),
                  )}
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
          {packTerms.length > 0 && (
            <ul className="st-teaser-terms" aria-label={t.site.pricingPage.termsSlug}>
              {packTerms.map((line) => (
                <li key={line}>
                  <Check className="mt-1 size-4 shrink-0 text-[var(--ns-go)]" aria-hidden />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
