import Link from "next/link";
import { ArrowUpRight, Clock, Eye, Receipt, RotateCcw } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import type { CreditRates, Pricing } from "@/lib/pricing";
import { PackCards } from "@/components/pricing/PackCards";

const PADDLE_BUYER_TERMS = "https://www.paddle.com/legal/checkout-buyer-terms";

/**
 * The public Pricing page. A Server Component; only the pack cards are client
 * code, because Paddle's localized price preview runs in the browser.
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
}: {
  t: Dictionary;
  locale: Locale;
  pricing: Pricing;
  signedIn: boolean;
  /** Live rates; null when the visitor may not read them or 0020 is not applied. */
  rates: CreditRates | null;
}) {
  const p = t.pricing;
  const steps = [
    { icon: Clock, title: p.how1Title, body: p.how1Body },
    { icon: Receipt, title: p.how2Title, body: p.how2Body },
    { icon: RotateCcw, title: p.how3Title, body: p.how3Body },
    { icon: Eye, title: p.how4Title, body: p.how4Body },
  ];
  const rateText = (n: number | null) => (n === null ? p.rateUnset : fmt(p.rateValue, { n: formatCredits(n, locale) }));
  const expiry = CREDIT_EXPIRY_MONTHS === null ? p.expiryNever : fmt(p.expiryAfter, { m: CREDIT_EXPIRY_MONTHS });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-20 px-4 pb-20 pt-10 sm:px-6 sm:pt-16 lg:gap-28">
      <section className="page-rise max-w-3xl">
        <div className="t-label text-[var(--color-primary)]">{p.eyebrow}</div>
        <h1
          className="mt-5 font-display font-semibold tracking-[-0.03em]"
          style={{ fontSize: "clamp(2.5rem, 6vw, 64px)", lineHeight: 1.04, textWrap: "balance" }}
        >
          {p.title}
        </h1>
        <p className="t-lead mt-6">{p.lead}</p>
      </section>

      <section aria-labelledby="packs-title" className="flex flex-col gap-6">
        <h2 id="packs-title" className="sr-only">
          {p.packsLabel}
        </h2>
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
                  href={signedIn ? `/${ALL_CHANNELS_SLUG}/credits` : "/login"}
                  className="btn-sky is-solid pill self-start px-6 py-3 text-sm sm:self-auto"
                >
                  {signedIn ? p.buySignedIn : p.buySignedOut}
                </Link>
              )}
            </div>
          </>
        )}
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
    </main>
  );
}
