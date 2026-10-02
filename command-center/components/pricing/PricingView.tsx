import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, Clock, Eye, Receipt, RotateCcw } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import type { CreditRates, Pricing } from "@/lib/pricing";
import { plansOnSale, type GenerationRates, type PlanMatrix as Matrix } from "@/lib/plans";
import { PackCards } from "@/components/pricing/PackCards";
import { PlanMatrix } from "@/components/pricing/PlanMatrix";
import { PlanCompare } from "@/components/pricing/PlanCompare";
import { ErrorState } from "@/components/ReadError";
import { FaqList, faqForSale } from "@/components/landing/Faq";
import { Slug } from "@/components/site/Slug";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { CREDIT_PACKS } from "@/lib/paddle";
import { moneyAnchor, type MoneyAnchor as Anchor } from "@/lib/landing";
import { MoneyAnchor } from "@/components/site/MoneyAnchor";

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
  packValidMonths,
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
  packValidMonths?: number | null;
  /** What money a visitor can know before signing up (lib/landing.ts moneyAnchor);
   *  without it, only what `pricing` holds (no API price list). */
  anchor?: Anchor;
}) {
  const p = t.pricing;
  const steps = [
    { icon: Clock, title: p.how1Title, body: p.how1Body },
    { icon: Receipt, title: p.how2Title, body: p.how2Body },
    { icon: RotateCcw, title: p.how3Title, body: p.how3Body },
    { icon: Eye, title: p.how4Title, body: p.how4Body },
  ];
  const rateText = (n: number | null) => (n === null ? p.rateUnset : fmt(p.rateValue, { n: formatCredits(n, locale) }));
  // The database's own policy when it could be read (it is what expires the
  // credits); the operator's env otherwise.
  const months = packValidMonths === undefined ? CREDIT_EXPIRY_MONTHS : packValidMonths;
  const expiry = months === null ? p.expiryNever : fmt(p.expiryAfter, { m: months });
  const showPlans = plans !== null && plansOnSale(plans);
  const credits = `/${ALL_CHANNELS_SLUG}/credits`;
  const primary = signedIn ? { href: credits, label: p.ctaSignedIn } : { href: "/signup", label: p.ctaSignedOut };
  // The expiry line is this deployment's own policy, so it sits among the terms.
  // p.terms opens with the two plan lines (renewal, cancelling); with no plan
  // on sale they would describe something nobody can buy, so they go.
  const saleTerms = showPlans ? p.terms : p.terms.slice(2);
  const expiryAt = showPlans ? 3 : 1;
  const terms = [...saleTerms.slice(0, expiryAt), expiry, ...saleTerms.slice(expiryAt)];
  const faq = faqForSale(p.faq, showPlans, t.site.packsOnly);
  const faqLink = (id: string) => (id === "cancel" || id === "refund" ? { href: "/terms#credits", label: p.linkTerms } : null);

  const pp = t.site.pricingPage;

  return (
    <div>
      <section aria-labelledby="pricing-title" className="st-wrap st-hero">
        <div>
          <p className="st-kicker">{showPlans ? p.eyebrow : pp.eyebrowNoPlans}</p>
          <h1 id="pricing-title" className="st-h1 mt-5">
            {p.title}
          </h1>
          {/* "Pick a monthly plan" only when there is a plan to pick. */}
          <p className="st-lead mt-7">{showPlans ? p.lead : pp.leadNoPlans}</p>
          <MoneyAnchor t={t} locale={locale} anchor={anchor ?? moneyAnchor(pricing, null)} titleId="anchor-title" className="mt-8" />
          {showPlans && <p className="st-small mt-3">{p.noYearly}</p>}
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
        </div>

        <section aria-labelledby="math-title" className="st-monitor self-start">
          <div className="st-monitor-head">
            <div className="st-monitor-title">
              <b>{pp.mathSlug}</b>
            </div>
          </div>
          <div className="px-4 pb-2 pt-4">
            <h2 id="math-title" className="st-h3">
              {pp.mathTitle}
            </h2>
            <p className="st-small mt-2">{pp.mathLead}</p>
          </div>
          <dl className="st-formula mx-4 mb-4 mt-3">
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
        </section>
      </section>

      {plansFailed && (
        <section id="plans" aria-labelledby="plans-title" className="st-section">
          <div className="st-wrap">
            <h2 id="plans-title" className="st-h2">
              {t.plans.matrixTitle}
            </h2>
            <div className="st-panel mt-8">
              <ErrorState compact message={t.plans.readFailed} />
            </div>
          </div>
        </section>
      )}

      {showPlans && plans && (
        <section id="plans" aria-labelledby="plans-title" className="st-section">
          <div className="st-wrap flex flex-col gap-8">
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
            <ul className="flex max-w-3xl flex-col gap-2 text-[14px] text-[var(--ns-text-dim)]">
              {generationRates ? <li>{t.creditsPage.eq.note}</li> : !signedIn && <li>{p.eqSignedOut}</li>}
              <li>{t.plans.expiresNote}</li>
              <li>{t.plans.spendOrder}</li>
              <li>{t.plans.apiNote}</li>
            </ul>

            <div className="mt-6 flex flex-col gap-5">
              <div>
                <h3 id="compare-title" className="st-h3">
                  {p.compareTitle}
                </h3>
                <p className="st-small mt-2">{p.compareLead}</p>
              </div>
              <PlanCompare matrix={plans} titleId="compare-title" />
            </div>
          </div>
        </section>
      )}

      <section id="packs" aria-labelledby="packs-title" className="st-section">
        <div className="st-wrap grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14">
          <div>
            <h2 id="packs-title" className="st-h2">
              {p.packsTitle}
            </h2>
            <p className="st-lead mt-5">{showPlans ? p.packsLead : t.site.packsOnly.packsLead}</p>
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
              <PackCards
                packs={pricing.packs}
                paddle={pricing.paddle}
                perMinute={rates?.perMinute ?? null}
                rates={generationRates}
              />
              <p className="st-small">
                {pricing.source === "paddle" ? p.taxNote : p.checkoutClosed} {expiry}
              </p>
              {pricing.source === "paddle" && (
                <Link href={signedIn ? credits : "/login"} className="st-key self-start" data-tone="quiet">
                  {signedIn ? p.buySignedIn : p.buySignedOut}
                </Link>
              )}
            </div>
          )}
        </div>
      </section>

      <section id="terms" aria-labelledby="terms-title" className="st-section">
        <div className="st-wrap grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14">
          <div>
            <Slug>{pp.termsSlug}</Slug>
            <h2 id="terms-title" className="st-h2 mt-8">
              {p.termsTitle}
            </h2>
            <Link href="/terms#credits" className="st-link mt-5">
              {p.linkTerms}
              <ArrowRight aria-hidden />
            </Link>
          </div>
          <ul className="flex flex-col border-t border-[var(--ns-rule-strong)]">
            {terms.map((line) => (
              <li key={line} className="flex items-start gap-4 border-b border-[var(--ns-rule)] py-4 text-[16px] leading-relaxed">
                <Check className="mt-1 size-4 shrink-0 text-[var(--ns-go)]" aria-hidden />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="how-title" className="st-section">
        <div className="st-wrap grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-14">
          <div>
            <Slug>{pp.creditSlug}</Slug>
            <h2 id="how-title" className="st-h2 mt-8">
              {p.howTitle}
            </h2>
            <p className="st-lead mt-5">{p.howLead}</p>
            <ol className="mt-10 grid gap-x-10 sm:grid-cols-2">
              {steps.map(({ icon: Icon, title, body }) => (
                <li key={title} className="flex flex-col gap-3 border-t border-[var(--ns-rule)] py-6">
                  <Icon className="size-5 text-[var(--ns-text-dim)]" aria-hidden />
                  <h3 className="st-h3">{title}</h3>
                  <p className="st-body">{body}</p>
                </li>
              ))}
            </ol>
          </div>

          <aside aria-labelledby="rates-title" className="st-panel h-fit">
            <div className="st-panel-head">
              <h3 id="rates-title" className="st-kicker text-[var(--ns-text)]">
                {p.ratesTitle}
              </h3>
            </div>
            <div className="flex flex-col gap-4 p-4">
              {rates ? (
                <dl className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <dt className="st-small">{p.ratePerMinute}</dt>
                    <dd className="st-num text-[20px]">{rateText(rates.perMinute)}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="st-small">{p.rateMinimum}</dt>
                    <dd className="st-num text-[20px]">{rateText(rates.jobMinimum)}</dd>
                  </div>
                </dl>
              ) : ratesFailed ? (
                <ErrorState compact message={p.ratesReadFailed} />
              ) : (
                <p className="st-small">{signedIn ? p.ratesUnavailable : p.ratesSignedOut}</p>
              )}
              <p className="st-small border-t border-[var(--ns-rule)] pt-4 text-[12.5px]">{p.ratesNote}</p>
            </div>
          </aside>
        </div>
      </section>

      <section aria-labelledby="payments-title" className="st-section">
        <div className="st-wrap grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14">
          <div>
            <Slug>{pp.paySlug}</Slug>
            <h2 id="payments-title" className="st-h2 mt-8">
              {p.paymentsTitle}
            </h2>
          </div>
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
      </section>

      <section id="pricing-faq" aria-labelledby="pricing-faq-title" className="st-section">
        <div className="st-wrap grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <Slug>{pp.faqSlug}</Slug>
            <h2 id="pricing-faq-title" className="st-h2 mt-8">
              {p.faqTitle}
            </h2>
          </div>
          <FaqList items={faq} linkFor={faqLink} />
        </div>
      </section>

      <section aria-labelledby="pricing-final-title" className="st-section">
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
