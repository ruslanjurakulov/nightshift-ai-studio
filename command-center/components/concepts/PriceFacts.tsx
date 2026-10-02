import type { Dictionary, Locale } from "@/lib/i18n";
import { fmt } from "@/lib/i18n";
import { creditUnit, formatCredits } from "@/lib/credits";
import { WELCOME_CREDITS, displayPriceText } from "@/lib/pricing";
import type { MoneyAnchor } from "@/lib/landing";

/**
 * The money a visitor can know before signing up, as one compact row for a
 * hero: what a video costs in the app, the smallest pack, the free grant. The
 * same facts and the same words as MoneyAnchor (components/site/MoneyAnchor.tsx,
 * lib/landing.ts moneyAnchor), nothing added: a price nobody published reads
 * "No price published yet", never a zero or a default (CLAUDE.md rule 5).
 */
export function PriceFacts({
  t,
  locale,
  anchor,
  titleId,
  className = "",
}: {
  t: Dictionary;
  locale: Locale;
  anchor: MoneyAnchor;
  titleId: string;
  className?: string;
}) {
  const a = t.site.anchor;
  const credits = (n: number) => formatCredits(n, locale);
  const unit = (n: number) => creditUnit(n, locale, t.shell.creditUnit);
  const nothingOnSale = anchor.pack.kind === "none";
  return (
    <div className={`ac-facts ${className}`}>
      <h2 id={titleId} className="st-kicker text-[var(--ns-text)]">
        {a.title}
      </h2>
      <dl aria-labelledby={titleId}>
        <div>
          <dt>{a.siteLabel}</dt>
          <dd>
            {anchor.site ? (
              <>
                <span className="ac-fact-money">
                  {fmt(a.siteValue, { n: credits(anchor.site.perMinute), unit: unit(anchor.site.perMinute) })}
                </span>
                {anchor.site.minimum !== null && (
                  <span className="ac-fact-sub">
                    {fmt(a.siteMinimum, { n: credits(anchor.site.minimum), unit: unit(anchor.site.minimum) })}
                  </span>
                )}
              </>
            ) : (
              <span className="ac-fact-none">{a.none}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{a.packLabel}</dt>
          <dd>
            {anchor.pack.kind === "priced" ? (
              <span className="ac-fact-money">
                {fmt(a.packValue, { price: displayPriceText(anchor.pack.price, locale), n: credits(anchor.pack.credits) })}
              </span>
            ) : anchor.pack.kind === "checkout" ? (
              <span className="ac-fact-none">{a.packCheckout}</span>
            ) : (
              <span className="ac-fact-none">{a.none}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{a.freeLabel}</dt>
          <dd>
            <span className="ac-fact-money">{fmt(a.freeValue, { n: credits(WELCOME_CREDITS) })}</span>
          </dd>
        </div>
      </dl>
      {nothingOnSale && <p className="ac-fact-sub mt-2">{a.noneNote}</p>}
    </div>
  );
}
