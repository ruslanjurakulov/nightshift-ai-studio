import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, Clock, Eye, Receipt, RotateCcw } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import type { CreditRates, Pricing } from "@/lib/pricing";
import { plansOnSale, type PlanMatrix as Matrix } from "@/lib/plans";
import { PackCards } from "@/components/pricing/PackCards";
import { PlanMatrix } from "@/components/pricing/PlanMatrix";
import { ErrorState } from "@/components/ReadError";
import { FaqList } from "@/components/landing/Faq";

const PADDLE_BUYER_TERMS = "https://www.paddle.com/legal/checkout-buyer-terms";

/**
 * The public Pricing page. A Server Component; only the plan and pack cards
 * are client code, because Paddle's localized price preview runs in the browser.
 *
 * Read top to bottom it answers: what it costs (plans, then packs), what you
 * agree to (terms at a glance — renewal, cancelling, expiry, failures), what a
 * credit buys, who takes the money, and the questions people ask before paying.
 *
 * Nothing here is a number the code made up: pack prices come from Paddle or
 * the owner's env, rates from the live price list, and when there is neither
 * the page says so in words.
 */
export function PricingView({
  t,
  locale,
  pricing,
  signedIn,
  rates,
  ratesFailed = false,
  plans,
  plansFailed = false,
  packValidMonths,
}: {
  t: Dictionary;
  locale: Locale;
  pricing: Pricing;
  signedIn: boolean;
  /** Live rates; null when the visitor may not read them or 0020 is not applied. */
  rates: CreditRates | null;
  /** The rates read itself failed (as opposed to "not published" / signed out): they are unknown. */
  ratesFailed?: boolean;
  /** The plan matrix (0034); null when the catalog is absent or could not be read. */
  plans: Matrix | null;
  /** The catalog read itself failed: the plans are unknown, not "none on sale". */
  plansFailed?: boolean;
  /** Top-up validity from the database (credit_lot_policies); undefined = not known, use the env. */
  packValidMonths?: number | null;
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
  const terms = [...p.terms.slice(0, 3), expiry, ...p.terms.slice(3)];
  const faqLink = (id: string) => (id === "cancel" || id === "refund" ? { href: "/terms#credits", label: p.linkTerms } : null);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-20 px-4 pb-20 pt-10 sm:px-6 sm:pt-16 lg:gap-28">
      <section aria-labelledby="pricing-title" className="page-rise max-w-3xl">
        <div className="t-label text-[var(--color-primary)]">{p.eyebrow}</div>
        <h1
          id="pricing-title"
          className="mt-5 font-display font-semibold tracking-[-0.03em]"
          style={{ fontSize: "clamp(2.5rem, 6vw, 64px)", lineHeight: 1.04, textWrap: "balance" }}
        >
          {p.title}
        </h1>
        <p className="t-lead mt-6">{p.lead}</p>
        <div className="mt-8 flex flex-col gap-3 min-[420px]:flex-row min-[420px]:flex-wrap min-[420px]:items-center">
          <Link href={primary.href} className="btn-sky is-solid pill min-h-12 px-7 text-[15px]">
            {primary.label}
            <ArrowRight className="btn-arrow size-4" aria-hidden />
          </Link>
          <a href="#terms" className="btn-sky ghost pill min-h-12 px-7 text-[15px]">
            {p.termsTitle}
          </a>
        </div>
        {!signedIn && <p className="mt-4 text-[13px] font-light text-[var(--color-muted)]">{p.ctaNote}</p>}
      </section>

      {plansFailed && (
        <section id="plans" aria-labelledby="plans-title" className="flex scroll-mt-24 flex-col gap-6">
          <div className="max-w-3xl">
            <h2 id="plans-title" className="t-section">
              {t.plans.matrixTitle}
            </h2>
          </div>
          <div className="panel">
            <ErrorState compact message={t.plans.readFailed} />
          </div>
        </section>
      )}

      {showPlans && plans && (
        <section id="plans" aria-labelledby="plans-title" className="flex scroll-mt-24 flex-col gap-6">
          <div className="max-w-3xl">
            <h2 id="plans-title" className="t-section">
              {t.plans.matrixTitle}
            </h2>
            <p className="t-lead mt-3">{t.plans.matrixLead}</p>
          </div>
          <PlanMatrix
            matrix={plans}
            perMinute={rates?.perMinute ?? null}
            signedIn={signedIn}
            subscribeHref={`${credits}#plans`}
          />
          <ul className="flex max-w-3xl flex-col gap-2 text-[13px] font-light text-[var(--color-muted)]">
            <li>{t.plans.expiresNote}</li>
            <li>{t.plans.spendOrder}</li>
            <li>{t.plans.apiNote}</li>
          </ul>
        </section>
      )}

      <section aria-labelledby="packs-title" className="flex flex-col gap-6">
        <h2 id="packs-title" className={showPlans ? "t-section" : "sr-only"}>
          {showPlans ? t.plans.topupsTitle : p.packsLabel}
        </h2>
        {showPlans && <p className="t-lead -mt-3 max-w-3xl">{t.plans.topupsLead}</p>}
        {pricing.source === "none" ? (
          <div className="glass-card flex flex-col gap-3 rounded-[22px] border border-dashed border-[var(--color-primary)] p-6 sm:p-10">
            <h3 className="text-[1.5rem] font-semibold tracking-[-0.02em]">{p.comingSoonTitle}</h3>
            <p className="t-lead">{p.comingSoonBody}</p>
            <p className="mono text-[12px] text-[var(--color-muted)]">{p.comingSoonOperator}</p>
          </div>
        ) : (
          <>
            <PackCards packs={pricing.packs} paddle={pricing.paddle} perMinute={rates?.perMinute ?? null} />
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-[13px] font-light text-[var(--color-muted)]">
                {pricing.source === "paddle" ? p.taxNote : p.checkoutClosed} {expiry}
              </p>
              {pricing.source === "paddle" && (
                <Link
                  href={signedIn ? credits : "/login"}
                  className="btn-sky is-solid pill self-start px-6 py-3 text-sm sm:self-auto"
                >
                  {signedIn ? p.buySignedIn : p.buySignedOut}
                </Link>
              )}
            </div>
          </>
        )}
      </section>

      <section
        id="terms"
        aria-labelledby="terms-title"
        className="glass-card scroll-mt-24 rounded-[22px] border border-[var(--color-border)] p-6 sm:p-10"
      >
        <h2 id="terms-title" className="text-[1.625rem] font-semibold tracking-[-0.02em]">
          {p.termsTitle}
        </h2>
        <ul className="mt-6 grid gap-x-10 gap-y-4 md:grid-cols-2">
          {terms.map((line) => (
            <li key={line} className="flex items-start gap-3 text-[15px] leading-relaxed">
              <Check className="mt-1 size-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <Link
          href="/terms#credits"
          className="mt-6 inline-flex min-h-11 items-center gap-1.5 text-[14px] text-[var(--color-primary)] underline-offset-4 hover:underline"
        >
          {p.linkTerms}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </section>

      <section aria-labelledby="how-title" className="grid gap-10 lg:grid-cols-[1fr_20rem] lg:gap-14">
        <div>
          <h2 id="how-title" className="t-section">
            {p.howTitle}
          </h2>
          <p className="t-lead mt-4 max-w-2xl">{p.howLead}</p>
          <ol className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2">
            {steps.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-5">
                <Icon className="size-5 text-[var(--color-primary)]" aria-hidden />
                <h3 className="t-panel">{title}</h3>
                <p className="text-[14px] font-light leading-relaxed text-[var(--color-muted)]">{body}</p>
              </li>
            ))}
          </ol>
        </div>

        <aside aria-labelledby="rates-title" className="panel flex h-fit flex-col gap-4 p-6">
          <h3 id="rates-title" className="t-label">
            {p.ratesTitle}
          </h3>
          {rates ? (
            <dl className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <dt className="text-[13px] font-light text-[var(--color-muted)]">{p.ratePerMinute}</dt>
                <dd className="mono text-[18px]">{rateText(rates.perMinute)}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-[13px] font-light text-[var(--color-muted)]">{p.rateMinimum}</dt>
                <dd className="mono text-[18px]">{rateText(rates.jobMinimum)}</dd>
              </div>
            </dl>
          ) : ratesFailed ? (
            <ErrorState compact message={p.ratesReadFailed} />
          ) : (
            <p className="text-[14px] font-light leading-relaxed text-[var(--color-muted)]">
              {signedIn ? p.ratesUnavailable : p.ratesSignedOut}
            </p>
          )}
          <p className="border-t border-[var(--color-border)] pt-4 text-[12px] font-light leading-relaxed text-[var(--color-muted)]">
            {p.ratesNote}
          </p>
        </aside>
      </section>

      <section
        aria-labelledby="payments-title"
        className="glass-card flex flex-col gap-5 rounded-[22px] border border-[var(--color-border)] p-6 sm:p-10"
      >
        <h2 id="payments-title" className="text-[1.625rem] font-semibold tracking-[-0.02em]">
          {p.paymentsTitle}
        </h2>
        <p className="t-lead">{p.paymentsBody}</p>
        <p className="t-lead">{p.refundsBody}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          <Link href="/terms#credits" className="btn-sky pill px-5 py-2.5 text-sm">
            {p.linkTerms}
          </Link>
          <a
            href={PADDLE_BUYER_TERMS}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-sky ghost pill px-5 py-2.5 text-sm"
          >
            {p.linkBuyerTerms}
            <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
          <Link href="/privacy#processors" className="btn-sky ghost pill px-5 py-2.5 text-sm">
            {p.linkPrivacy}
          </Link>
        </div>
      </section>

      <section id="pricing-faq" aria-labelledby="pricing-faq-title" className="grid scroll-mt-24 gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
        <h2 id="pricing-faq-title" className="t-section lg:sticky lg:top-28 lg:self-start">
          {p.faqTitle}
        </h2>
        <FaqList items={p.faq} linkFor={faqLink} />
      </section>

      <section
        aria-labelledby="pricing-final-title"
        className="lp-horizon relative overflow-hidden rounded-[28px] border border-[var(--color-border)] px-5 py-14 text-center sm:px-12 sm:py-20"
      >
        <h2
          id="pricing-final-title"
          className="mx-auto max-w-2xl font-display font-semibold tracking-[-0.03em]"
          style={{ fontSize: "clamp(1.75rem, 4vw, 44px)", lineHeight: 1.08, textWrap: "balance" }}
        >
          {p.finalTitle}
        </h2>
        <p className="t-lead mx-auto mt-4">{p.finalLead}</p>
        <div className="mt-8 flex justify-center">
          <Link href={primary.href} className="btn-sky is-solid pill min-h-12 px-7 text-[15px]">
            {primary.label}
            <ArrowRight className="btn-arrow size-4" aria-hidden />
          </Link>
        </div>
        <span className="lp-horizon-line absolute inset-x-[12%] bottom-0 h-px" aria-hidden />
      </section>
    </div>
  );
}
