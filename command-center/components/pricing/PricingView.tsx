import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
import type { Dictionary, Locale } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import type { CreditRates, Pricing } from "@/lib/pricing";
import { packExpiry, plansOnSale, type GenerationRates, type PackExpiry, type PlanMatrix as Matrix } from "@/lib/plans";
import { PackCards } from "@/components/pricing/PackCards";
import { PlanMatrix } from "@/components/pricing/PlanMatrix";
import { PlanCompare } from "@/components/pricing/PlanCompare";
import { ErrorState } from "@/components/ReadError";
import { FaqList, expiryTerm, faqForSale } from "@/components/landing/Faq";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { CREDIT_PACKS } from "@/lib/paddle";
import { PackPlanner } from "@/components/pricing/PackPlanner";
import { moneyAnchor, type MoneyAnchor as Anchor } from "@/lib/landing";
import { ChatCard, chatCopy } from "@/components/landing/HeroCard";
import { HeroFx } from "@/components/site/HeroFx";
import { MotionToggle } from "@/components/site/MotionToggle";
import { PriceCheck } from "@/components/landing/PriceCheck";
import { priceRatesFrom } from "@/lib/site/price-check";
import { WELCOME_CREDITS } from "@/lib/pricing";

const PADDLE_BUYER_TERMS = "https://www.paddle.com/legal/checkout-buyer-terms";

/**
 * The public Pricing page. A Server Component; only the plan and pack cards
 * are client code, because Paddle's localized price preview runs in the browser.
 *
 * Read top to bottom it answers: what it costs (plan cards, then the plans
 * side by side, then packs), what you agree to (terms at a glance — renewal,
 * cancelling, expiry, failures), what a credit buys, who takes the money, and
 * the questions people ask before paying.
 *
 * Nothing here is a number the code made up: plan and pack prices come from
 * Paddle or the owner's env, credits and limits from the plan catalog, the
 * "≈ N images" equivalents from today's price list (signed-in only), the
 * welcome grant from WELCOME_CREDITS, and when there is none of that the page
 * says so in words. There is no Monthly / Yearly switch: the plan data holds
 * monthly prices only, and a yearly discount nobody set would be invented.
 *
 * The seller is named once, in the Payments section's Merchant of Record
 * sentence — the line Paddle's reviewers look for.
 */
export function PricingView({
  t,
  locale,
  pricing,
  signedIn,
  rates,
  ratesFailed = false,
  generationRates = null,
  plans,
  plansFailed = false,
  expiry,
  anchor,
}: {
  t: Dictionary;
  locale: Locale;
  pricing: Pricing;
  signedIn: boolean;
  /** Live rates; null when the visitor may not read them or 0020 is not applied. */
  rates: CreditRates | null;
  /** The rates read itself failed (as opposed to "not published" / signed out): they are unknown. */
  ratesFailed?: boolean;
  /** Today's generation prices for the "≈ N images" lines; null = not readable here (signed out, or failed). */
  generationRates?: GenerationRates | null;
  /** The plan matrix (0034); null when the catalog is absent or could not be read. */
  plans: Matrix | null;
  /** The catalog read itself failed: the plans are unknown, not "none on sale". */
  plansFailed?: boolean;
  /** Top-up validity from the database (credit_lot_policies); undefined = not known, use the env. */
  /** How long top-up credits last (lib/plans.ts packExpiry); default: the env alone. */
  expiry?: PackExpiry;
  /** What money a visitor can know before signing up (lib/landing.ts moneyAnchor);
   *  without it, only what `pricing` holds (no API price list). */
  anchor?: Anchor;
}) {
  const p = t.pricing;
  const steps = [
    { title: p.how1Title, body: p.how1Body },
    { title: p.how2Title, body: p.how2Body },
    { title: p.how3Title, body: p.how3Body },
    { title: p.how4Title, body: p.how4Body },
  ];
  // The database's own policy when it could be read (it is what expires the
  // credits); the operator's env otherwise.
  const expiryState: PackExpiry = expiry ?? packExpiry(null, CREDIT_EXPIRY_MONTHS);
  const expiryLine = expiryTerm(p, expiryState);
  const showPlans = plans !== null && plansOnSale(plans);
  const credits = `/${ALL_CHANNELS_SLUG}/credits`;
  const primary = signedIn ? { href: credits, label: p.ctaSignedIn } : { href: "/signup", label: p.ctaSignedOut };
  // The expiry line is this deployment's own policy, so it sits among the terms.
  // p.terms opens with the two plan lines (renewal, cancelling); with no plan
  // on sale they would describe something nobody can buy, so they go.
  const saleTerms = showPlans ? p.terms : p.terms.slice(2);
  const expiryAt = showPlans ? 3 : 1;
  const terms = [...saleTerms.slice(0, expiryAt), expiryLine, ...saleTerms.slice(expiryAt)];
  const faq = faqForSale(p.faq, showPlans, t.site.packsOnly, expiryState);
  const faqLink = (id: string) => (id === "cancel" || id === "refund" ? { href: "/terms#credits", label: p.linkTerms } : null);

  const pp = t.site.pricingPage;
  // The same published rate the money panel shows; with none published the price check is absent, as on the landing.
  const priceRates = priceRatesFrom(anchor ?? moneyAnchor(pricing, null));

  return (
    <div>
      <div className="nx-lit">
        <HeroFx />
        {/* The calculator is on the first phone screen: the headline, one line, the price check, then the button. */}
        <section aria-labelledby="pricing-title" className="st-wrap nx-pr-hero">
          <div className="nx-pr-copy">
            <p className="st-kicker">{showPlans ? p.eyebrow : pp.eyebrowNoPlans}</p>
            <h1 id="pricing-title" className="st-h1 nx-h1-short mt-4">
              {pp.h1}
            </h1>
            {/* "Pick a monthly plan" only when there is a plan to pick. */}
            <p className="st-lead mt-5">{showPlans ? p.lead : pp.leadNoPlans}</p>
            {showPlans && <p className="st-small mt-3">{p.noYearly}</p>}
          </div>

          {priceRates ? (
            <div className="nx-pr-calc">
              <h2 id="calc-title" className="nx-h3 mb-4">
                {t.site.calc.title}
              </h2>
              <PriceCheck t={t} locale={locale} rates={priceRates} welcome={WELCOME_CREDITS} cta={false} />
            </div>
          ) : (
            <aside aria-labelledby="get-title" className="nx-pr-calc">
              <h2 id="get-title" className="nx-kicker mb-4">
                {t.site.rules.slug}
              </h2>
              <ul className="nx-get">
                {t.site.rules.items.map((item) => (
                  <li key={item.id}>
                    <Check aria-hidden />
                    <span>{item.title}</span>
                  </li>
                ))}
              </ul>
              {/* No calculator means no published rate: say why in words (a failed read is unknown, not "none"). */}
              {!rates && (ratesFailed ? <ErrorState compact message={p.ratesReadFailed} /> : <p className="st-small mt-4">{signedIn ? p.ratesUnavailable : p.ratesSignedOut}</p>)}
            </aside>
          )}

          <div className="nx-pr-actions">
            <div className="st-hero-actions">
              <Link href={primary.href} className="st-key">
                {primary.label}
                <ArrowRight aria-hidden />
              </Link>
              <a href="#terms" className="st-link">
                {p.termsTitle}
              </a>
            </div>
            {!signedIn && <p className="st-small mt-4">{showPlans ? p.ctaNote : t.site.packsOnly.ctaNote}</p>}
            <MotionToggle pause={t.site.fx.pause} />
          </div>
        </section>
      </div>

      {/* The month planner: minutes of finished video, the credits that takes at the published rate, the pack that covers it. */}
      {priceRates && (
        <PackPlanner
          t={t}
          locale={locale}
          rates={priceRates}
          packs={pricing.packs.length > 0 ? pricing.packs : CREDIT_PACKS.map((x) => ({ id: x.id, credits: x.credits, displayPrice: null, priceId: null }))}
        />
      )}

      {/* What you can buy, in one place: the plans (when there are any) and the packs. */}
      <section id="packs" aria-labelledby="packs-title" className="st-section" data-tone="raised">
        <div className="st-wrap flex flex-col gap-10">
          {plansFailed && (
            <div id="plans">
              <h2 id="plans-title" className="st-h2">
                {t.plans.matrixTitle}
              </h2>
              <div className="st-panel mt-8">
                <ErrorState compact message={t.plans.readFailed} />
              </div>
            </div>
          )}

          {showPlans && plans && (
            <div id="plans" className="flex flex-col gap-8">
              <div>
                <h2 id="plans-title" className="st-h2">
                  {t.plans.matrixTitle}
                </h2>
                <p className="st-lead mt-5">{t.plans.matrixLead}</p>
              </div>
              <PlanMatrix
                matrix={plans}
                perMinute={rates?.perMinute ?? null}
                rates={generationRates}
                signedIn={signedIn}
                subscribeHref={`${credits}#plans`}
              />
              <p className="nx-extra">{pp.extraLine}</p>
              <details className="nx-math">
                <summary>
                  <span id="compare-title">{p.compareTitle}</span>
                  <span className="st-faq-mark" aria-hidden />
                </summary>
                <div className="flex flex-col gap-5 p-5">
                  <p className="st-small">{p.compareLead}</p>
                  <PlanCompare matrix={plans} titleId="compare-title" />
                  <ul className="flex max-w-3xl flex-col gap-2 text-[15px] text-[var(--ns-text-dim)]">
                    {generationRates ? <li>{t.creditsPage.eq.note}</li> : !signedIn && <li>{p.eqSignedOut}</li>}
                    <li>{t.plans.expiresNote}</li>
                    <li>{t.plans.spendOrder}</li>
                    <li>{t.plans.apiNote}</li>
                  </ul>
                </div>
              </details>
            </div>
          )}

          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] lg:gap-14">
            <div>
              <h2 id="packs-title" className={showPlans ? "st-h3" : "st-h2"}>
                {p.packsTitle}
              </h2>
              <p className="st-lead mt-4">{showPlans ? p.packsLead : t.site.packsOnly.packsLead}</p>
            </div>
            {pricing.source === "none" ? (
              <div className="st-panel self-start">
                <div className="st-panel-head">
                  <h3 className="st-kicker text-[var(--ns-text)]">{p.comingSoonTitle}</h3>
                  <StatusLamp tone="idle" label={pp.sizesTitle} />
                </div>
                <p className="st-small px-4 pt-4">{p.comingSoonBody}</p>
                <ul className="st-price-rows" aria-label={pp.sizesTitle}>
                  {CREDIT_PACKS.map((pack) => (
                    <li key={pack.id} className="st-price-row">
                      <span className="st-price-name">{t.credits.buy.pack[pack.id]}</span>
                      <span className="st-price-credits st-num">
                        {formatCredits(pack.credits, locale)}
                        <small>{t.site.pricingTeaser.credits}</small>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="st-small border-t border-[var(--ns-rule)] px-4 py-3">{pp.sizesNote}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <PackCards packs={pricing.packs} paddle={pricing.paddle} perMinute={rates?.perMinute ?? null} rates={generationRates} />
                <p className="st-small">
                  {pricing.source === "paddle" ? p.taxNote : p.checkoutClosed} {expiryLine}
                </p>
                {pricing.source === "paddle" && (
                  <Link href={signedIn ? credits : "/login"} className="st-key self-start" data-tone="quiet">
                    {signedIn ? p.buySignedIn : p.buySignedOut}
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* How a price goes from quote to charge: four words, the chat card as the picture, the formulas one tap away. */}
      <section aria-labelledby="how-title" className="st-section">
        <div className="st-wrap grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:items-start lg:gap-14">
          <div>
            <h2 id="how-title" className="st-h2">
              {p.howTitle}
            </h2>
            <p className="st-lead mt-5">{p.howLead}</p>
            <ol className="st-flow nx-flow" aria-label={t.site.pricingTeaser.slug}>
              {t.site.pricingTeaser.ledger.map((step) => (
                <li key={step.id} data-id={step.id}>
                  <b>{step.word}</b>
                  <span>{step.body}</span>
                </li>
              ))}
            </ol>
            <details className="nx-math">
              <summary>
                <span id="math-title">{pp.mathToggle}</span>
                <span className="st-faq-mark" aria-hidden />
              </summary>
              <ol className="st-ruled nx-math-steps">
                {steps.map(({ title, body }, i) => (
                  <li key={title}>
                    <h3 className="st-h3">
                      <span className="st-num mr-3 text-sm font-normal text-[var(--ns-text-dim)]" aria-hidden>
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {title}
                    </h3>
                    <p className="st-body">{body}</p>
                  </li>
                ))}
              </ol>
              <dl className="st-formula">
                {pp.rows.map((row) => (
                  <div key={row.id}>
                    <dt className={row.id === "return" ? "text-[var(--ns-go)]" : undefined}>{row.word}</dt>
                    <dd>
                      {/* One equation per line: "failed → return = hold" never breaks mid-way. */}
                      <code>
                        {row.formula.split(/;\s*/).map((clause) => (
                          <span key={clause} className="st-formula-clause">
                            {clause}
                          </span>
                        ))}
                      </code>
                      <p className="st-small">{row.body}</p>
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </div>
          <ChatCard copy={chatCopy(t, "pricing.card")} slot="pricing.card" compactClip />
        </div>
      </section>

      <section id="terms" aria-labelledby="terms-title" className="st-section" data-tone="raised">
        <div className="st-wrap">
          <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
            <h2 id="terms-title" className="st-h2">
              {p.termsTitle}
            </h2>
            <Link href="/terms#credits" className="st-link">
              {p.linkTerms}
              <ArrowRight aria-hidden />
            </Link>
          </div>
          {/* Up to three terms sit side by side, one each; more fill two
              newspaper columns. Either way no column ends with a hole. */}
          <ul
            className="st-terms mt-10"
            style={
              {
                "--cols": terms.length <= 3 ? terms.length : 2,
                "--rows": terms.length <= 3 ? 1 : Math.ceil(terms.length / 2),
              } as React.CSSProperties
            }
          >
            {terms.map((line) => (
              <li key={line}>
                <Check className="mt-1 size-4 shrink-0 text-[var(--ns-go)]" aria-hidden />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <div aria-labelledby="payments-title" role="group" className="nx-pay">
            <h2 id="payments-title" className="st-h3">
              {p.paymentsTitle}
            </h2>
            <div className="flex flex-col gap-4">
              <p className="st-body">{p.paymentsBody}</p>
              <p className="st-body">{p.refundsBody}</p>
              <div className="flex flex-wrap gap-x-6">
                <Link href="/terms#credits" className="st-link">
                  {p.linkTerms}
                </Link>
                <a href={PADDLE_BUYER_TERMS} target="_blank" rel="noopener noreferrer" className="st-link">
                  {p.linkBuyerTerms}
                  <ArrowUpRight aria-hidden />
                </a>
                <Link href="/privacy#processors" className="st-link">
                  {p.linkPrivacy}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="pricing-faq" aria-labelledby="pricing-faq-title" className="st-section">
        <div className="st-wrap grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <h2 id="pricing-faq-title" className="st-h2">
              {p.faqTitle}
            </h2>
          </div>
          <FaqList items={faq} linkFor={faqLink} />
        </div>
      </section>

      <section aria-labelledby="pricing-final-title" className="st-section" data-tone="raised">
        <div className="st-wrap grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:items-end">
          <h2 id="pricing-final-title" className="st-h1-page">
            {p.finalTitle}
          </h2>
          <div>
            <p className="st-lead">{p.finalLead}</p>
            <div className="st-hero-actions mt-7">
              <Link href={primary.href} className="st-key">
                {primary.label}
                <ArrowRight aria-hidden />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
