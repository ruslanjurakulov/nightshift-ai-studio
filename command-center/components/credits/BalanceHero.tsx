"use client";

import { ArrowDown } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import type { BalanceSplit, GenerationRates } from "@/lib/plans";
import { Equivalents, shortDate } from "@/components/credits/Equivalents";
import { Meter } from "@/components/ui/Meter";
import { Timecode } from "@/components/ui/Timecode";

/**
 * The top of the Credits page: what can be spent now, what is held by jobs in
 * progress, and where the available credits come from (plan credits that
 * expire with the billing period, top-up packs with their own expiry, bonus
 * credits). Every figure comes from a read (lib/plans.ts balanceSplit); an
 * unread one says "unknown", and a source the account does not have is not
 * listed — never a made-up 0.
 */
export function BalanceHero({
  split,
  rates,
  offers,
  extraOff = false,
}: {
  split: BalanceSplit;
  rates: GenerationRates | null;
  /** Which purchase sections exist further down the page (the buttons jump to them). */
  offers: { plans: boolean; packs: boolean };
  /** The extra-credits switch is off (0094): pack credits are kept but not used for new runs. */
  extraOff?: boolean;
}) {
  const { t, locale } = useI18n();
  const cp = t.credits;
  const p = t.creditsPage;
  const figure = (n: number | null) => <Timecode value={n} locale={locale} unknown={t.common.unknown} />;
  const spoken = (n: number | null) => (n === null ? t.common.unknown : formatCredits(n, locale));
  const expiry = (source: "plan" | "pack" | "other", at: string | null) => {
    if (!at) return source === "plan" ? null : p.noExpiry;
    const date = shortDate(at, locale);
    return fmt(source === "plan" ? p.planExpires : source === "pack" ? p.packExpires : p.otherExpires, { date });
  };

  return (
    // The one lit desk of this page: the balance, with the way to add to it.
    <section className="panel ns-desk bal-desk" aria-labelledby="balance-title">
      <div className="bal-main">
        <h2 id="balance-title" className="t-panel">
          {p.balanceTitle}
        </h2>

        <div className="flex flex-col gap-2">
          <span className="text-sm text-[var(--color-muted)]">{cp.available}</span>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span
              className="t-figure bal-figure"
              style={{ color: split.available === null ? "var(--color-idle)" : "var(--color-fg)" }}
              data-balance-available
            >
              {figure(split.available)}
            </span>
            {split.available !== null && <span className="text-base text-[var(--color-muted)]">{p.unit}</span>}
          </div>
          {/* The balance as a VU ladder: lit = free to spend, hatched = held for
              running work. Drawn only from real figures; unread, there is no meter. */}
          {split.available !== null && (
            <Meter
              value={split.available}
              held={split.held}
              max={split.total}
              size="lg"
              segments={24}
              label={cp.available}
              valueText={`${spoken(split.available)} ${cp.available}${split.held ? `, ${spoken(split.held)} ${cp.reserved}` : ""}`}
              scale={split.total !== null ? { from: formatCredits(0, locale), to: formatCredits(split.total, locale) } : undefined}
              className="mt-1"
            />
          )}
          {split.available !== null && <Equivalents credits={split.available} rates={rates} />}
        </div>

        <dl className="bal-facts">
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-[var(--color-muted)]">{cp.reserved}</dt>
            <dd className="text-[22px] font-semibold" style={{ color: split.held === null ? "var(--color-idle)" : undefined }}>
              {figure(split.held)}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-[var(--color-muted)]">{cp.balance}</dt>
            <dd className="text-[22px] font-semibold" style={{ color: split.total === null ? "var(--color-idle)" : undefined }}>
              {figure(split.total)}
            </dd>
          </div>
        </dl>
        {split.held !== null && <p className="-mt-2 text-sm leading-relaxed text-[var(--color-muted)]">{p.heldHint}</p>}

        {(offers.packs || offers.plans) && (
          <div className="flex flex-wrap gap-2">
            {offers.packs && (
              <a href="#topups" className="btn-primary text-sm">
                {p.getMore}
                <ArrowDown className="size-3.5" aria-hidden />
              </a>
            )}
            {offers.plans && (
              <a href="#plans" className={`${offers.packs ? "btn-quiet" : "btn-primary"} text-sm`}>
                {p.seePlans}
                <ArrowDown className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
        )}
      </div>

      {split.sources && split.sources.length > 0 && (
        <div className="bal-side flex flex-col gap-2">
          <h3 className="text-sm font-medium">{p.sourcesTitle}</h3>
          <ul className="flex flex-col">
            {split.sources.map((s) => {
              const when = expiry(s.source, s.expiresAt);
              return (
                <li
                  key={s.source}
                  className="flex items-start justify-between gap-4 border-t border-[var(--color-border)] py-3 first:border-t-0 first:pt-1"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[15px]">{p.source[s.source]}</span>
                    {when && <span className="text-sm text-[var(--color-muted)]">{when}</span>}
                    {extraOff && s.source === "pack" && (
                      <span className="text-sm text-[var(--color-warn)]" data-source-off>
                        {t.usage.credits.sourceOff}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-[17px] font-semibold"><Timecode value={s.credits} locale={locale} /></span>
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-[var(--color-muted)]">{p.spendOrder}</p>
        </div>
      )}
    </section>
  );
}
