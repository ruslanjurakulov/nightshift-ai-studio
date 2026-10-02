import Link from "next/link";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { formatUsd } from "@/lib/api/pricing";
import { WELCOME_CREDITS } from "@/lib/pricing";
import type { MoneyAnchor as Anchor } from "@/lib/landing";

/**
 * What a visitor can know about money before signing up (lib/landing.ts
 * moneyAnchor): the smallest pack's published price, a video's price through
 * the API from the live list, and the free grant. A price nobody published is
 * said in words — never a zero, never a default.
 */
export function MoneyAnchor({
  t,
  locale,
  anchor,
  titleId,
  level = 2,
  className = "",
}: {
  t: Dictionary;
  locale: Locale;
  anchor: Anchor;
  titleId: string;
  /** The heading level of "What it costs" where it sits. */
  level?: 2 | 3;
  className?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  const a = t.site.anchor;
  const none = <span className="st-anchor-none">{a.none}</span>;
  const nothingOnSale = anchor.pack.kind === "none";
  return (
    <div className={`st-anchor ${className}`}>
      <Heading id={titleId} className="st-kicker text-[var(--ns-text)]">
        {a.title}
      </Heading>
      <dl aria-labelledby={titleId}>
        <div>
          <dt>{a.packLabel}</dt>
          <dd>
            {anchor.pack.kind === "priced" ? (
              <span className="st-anchor-money">
                {fmt(a.packValue, { price: anchor.pack.price, n: formatCredits(anchor.pack.credits, locale) })}
              </span>
            ) : anchor.pack.kind === "checkout" ? (
              <span className="st-anchor-none">{a.packCheckout}</span>
            ) : (
              none
            )}
          </dd>
        </div>
        <div>
          <dt>
            {a.apiLabel}
            {anchor.api && (
              <Link href="/docs/api#pricing" className="st-anchor-src">
                {a.apiSource}
              </Link>
            )}
          </dt>
          <dd>
            {anchor.api ? (
              <>
                <span className="st-anchor-money">
                  {fmt(a.apiValue, { perMinute: formatUsd(anchor.api.perMinuteCents, locale) })}
                </span>
                {anchor.api.minimumCents !== null && (
                  <span className="st-anchor-sub">
                    {fmt(a.apiMinimum, { minimum: formatUsd(anchor.api.minimumCents, locale) })}
                  </span>
                )}
              </>
            ) : (
              none
            )}
          </dd>
        </div>
        <div>
          <dt>{a.freeLabel}</dt>
          <dd>
            <span className="st-anchor-money">
              {fmt(a.freeValue, { n: formatCredits(WELCOME_CREDITS, locale) })}
            </span>
          </dd>
        </div>
      </dl>
      {nothingOnSale && <p className="st-small mt-3">{a.noneNote}</p>}
    </div>
  );
}
