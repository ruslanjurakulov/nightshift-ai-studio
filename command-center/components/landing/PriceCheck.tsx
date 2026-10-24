import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { creditUnit, formatCredits } from "@/lib/credits";
import { formatUsd } from "@/lib/api/pricing";
import { freeMinutes, quoteCents, quoteCredits, type PriceRates } from "@/lib/site/price-check";
import { PriceSlider, type PriceRow } from "@/components/landing/PriceSlider";

/** The slider's own range: a control's bounds, not a claim about what can be made. */
const MIN = 1;
const MAX = 20;
const START = 5;

/**
 * Slide a length, read the price, from the published rate and nothing else.
 * Rendered only when the pricing source has a per-minute rate
 * (components/landing/Landing.tsx): with none, the page's money panel says "No
 * price published yet" and this section is absent, so it cannot show a default
 * or a zero. A Server Component: it works out the whole table (one row per
 * minute) here, with the same formatters as the rest of the page, so the
 * browser only picks a row.
 */
export function PriceCheck({
  t,
  locale,
  rates,
  welcome,
  href = "/signup",
  cta = true,
  slip = false,
}: {
  t: Dictionary;
  locale: Locale;
  rates: PriceRates;
  welcome: number;
  href?: string;
  cta?: boolean;
  /** Show the quote as an itemised slip (quote, hold, charge, return) instead of one figure. */
  slip?: boolean;
}) {
  const c = t.site.calc;
  const unit = (n: number) => creditUnit(n, locale, t.shell.creditUnit);
  const rows: PriceRow[] = Array.from({ length: MAX - MIN + 1 }, (_, i) => {
    const minutes = MIN + i;
    const credits = quoteCredits(minutes, rates);
    const cents = quoteCents(credits, rates);
    const quote = fmt(c.credits, { n: formatCredits(credits, locale), unit: unit(credits) });
    // The smallest quote can override length x rate; the line then says that rule, never a product that is not the figure.
    const floored = rates.minimum !== null && rates.minimum > minutes * rates.perMinute;
    return {
      minutes,
      length: fmt(c.minutes, { n: formatCredits(minutes, locale) }),
      quote,
      ...(slip
        ? {
            basis: floored
              ? fmt(c.floor, { n: formatCredits(credits, locale), unit: unit(credits) })
              : fmt(c.basis, { m: formatCredits(minutes, locale), n: formatCredits(rates.perMinute, locale), unit: unit(rates.perMinute) }),
            charge: fmt(c.atMost, { n: formatCredits(credits, locale), unit: unit(credits) }),
          }
        : {}),
      usd: cents !== null && rates.pack ? fmt(c.usd, { usd: formatUsd(cents, locale), pack: t.credits.buy.pack[rates.pack] }) : null,
    };
  });
  const free = freeMinutes(welcome, rates);
  const ledger = t.site.pricingTeaser.ledger;
  return (
    <div className="nx-calc" data-spot={slip ? undefined : true} data-slip={slip ? "true" : undefined}>
      <PriceSlider
        rows={rows}
        start={START}
        lengthLabel={c.length}
        quoteLabel={c.quote}
        slip={slip ? { rest: c.rest, lines: ledger.map((l) => ({ id: l.id, word: l.word, note: l.id === "quote" ? null : l.body })) } : undefined}
      >
        {rates.minimum !== null && <p className="nx-calc-sub">{fmt(c.floor, { n: formatCredits(rates.minimum, locale), unit: unit(rates.minimum) })}</p>}
        {free !== null && <p className="nx-calc-sub">{fmt(c.free, { n: formatCredits(welcome, locale), m: formatCredits(free, locale) })}</p>}
      </PriceSlider>
      <p className="nx-calc-rule">
        {c.rule} <span className="nx-calc-src">{c.source}.</span>
      </p>
      {cta && (
        <div className="nx-calc-cta">
          <Link href={href} className="nx-btn">
            {c.cta}
            <ArrowRight aria-hidden />
          </Link>
          <Link href="/pricing" className="nx-link">
            {c.more}
          </Link>
        </div>
      )}
    </div>
  );
}
