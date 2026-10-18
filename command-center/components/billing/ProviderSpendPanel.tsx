"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatNumber, formatUsdOwner } from "@/lib/number-format";
import type { ProviderSpend, SpendGroup, SpendSummary } from "@/lib/owner-reads";
import { ErrorState } from "@/components/ReadError";

/**
 * What the providers charged us over the last N days, from owner_provider_spend (NIGHTSHIFT_OWNER_RPC on).
 *
 * The database adds the cost ledger up by provider, so this is a few dozen rows, not a page of raw ones that PostgREST
 * may cut at its cap. It keeps the rule of the whole Billing page: an unknown is not a zero. A provider with any
 * unpriced row has no total ("unknown", with the priced part as "at least"), and a name that is not a provider's
 * bill (rendering, stock footage...) is listed apart as our own estimate. Nothing here is summed across the two.
 */
export function ProviderSpendPanel({
  state,
  summary,
  days,
}: {
  /** `unsupported`: migration 0106 not applied. `failed`: the read errored (no figure). `ok`: summary is set. */
  state: "ok" | "failed" | "unsupported";
  summary: SpendSummary | null;
  days: number;
}) {
  const { t, locale } = useI18n();
  const s = t.ownerRpc.spend;
  const usd = (v: number) => formatUsdOwner(v, locale);

  const value = (usdTotal: number | null, atLeast: number | null) =>
    usdTotal !== null ? usd(usdTotal) : atLeast !== null ? fmt(s.atLeast, { usd: usd(atLeast) }) : s.unknown;
  const unpricedText = (n: number) => (n === 1 ? s.unpricedOne : fmt(s.unpriced, { n }));

  const nameOf = (p: ProviderSpend) =>
    p.kind === "estimate" ? ((s.names as Record<string, string>)[p.provider] ?? p.provider) : (p.label ?? p.provider);

  function renderGroup(key: string, title: string, group: SpendGroup, rows: ProviderSpend[], hint?: string) {
    if (rows.length === 0) return null;
    return (
      <div key={key} className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h3>
          <p className="tnum text-[15px] font-semibold text-[var(--color-fg)]" aria-label={`${s.total}: ${value(group.usd, group.atLeastUsd)}`}>
            {value(group.usd, group.atLeastUsd)}
          </p>
        </div>
        {hint && <p className="text-xs leading-relaxed text-[var(--color-muted)]">{hint}</p>}
        {group.usd === null && group.unpricedRows > 0 && <p className="text-xs text-[var(--color-warn)]">{unpricedText(group.unpricedRows)}</p>}
        <ul className="flex flex-col">
          {rows.map((p) => (
            <li key={p.provider} className="flex items-start justify-between gap-3 border-t border-[var(--color-border)] py-2.5 first:border-t-0">
              <div className="min-w-0">
                <p className="break-words text-sm text-[var(--color-fg)]">{nameOf(p)}</p>
                <p className="text-xs text-[var(--color-muted)]">
                  {[
                    p.units !== null && p.unit ? `${formatNumber(p.units, locale, 2)} ${p.unit}` : "",
                    p.days > 0 ? fmt(s.activeDays, { n: p.days }) : "",
                    p.dateUnknown ? s.dateUnknown : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <p className="tnum text-sm font-semibold text-[var(--color-fg)]">{value(p.usd, p.atLeastUsd)}</p>
                {p.usd === null && p.unpricedRows > 0 && <p className="text-xs text-[var(--color-warn)]">{unpricedText(p.unpricedRows)}</p>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const billed = summary?.providers.filter((p) => p.kind === "billed") ?? [];
  const estimates = summary?.providers.filter((p) => p.kind === "estimate") ?? [];

  return (
    <section id="provider-spend" className="panel flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="provider-spend-title">
      <div>
        <h2 id="provider-spend-title" className="t-section">
          {s.title}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">{fmt(s.subtitle, { days })}</p>
      </div>
      {state === "failed" ? (
        <ErrorState compact message={s.failed} />
      ) : state === "unsupported" ? (
        <p className="text-sm text-[var(--color-muted)]">{s.unsupported}</p>
      ) : !summary || summary.providers.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">{s.empty}</p>
      ) : (
        <>
          {renderGroup("billed", s.billedTitle, summary.billed, billed)}
          {renderGroup("estimates", s.estimatesTitle, summary.estimates, estimates, s.estimatesHint)}
        </>
      )}
    </section>
  );
}
