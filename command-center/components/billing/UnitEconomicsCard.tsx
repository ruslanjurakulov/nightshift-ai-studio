"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatCard } from "@/components/ui";
import { usd } from "@/components/billing/BillingBoard";
import type { CostDriver, UnitEconomics } from "@/lib/unitEconomics";

/**
 * "1 video = $X" — the per-video cost the Billing page's provider cards cannot
 * show on their own, because they add up spend per account, not per video.
 *
 * Every dollar figure here is over FULLY priced videos only (lib/unitEconomics.ts);
 * the card says how many were left out and names the exact env var that would
 * bring them in, so a blank reads as "set this price", never as "free".
 */
export function UnitEconomicsCard({ ue, scope }: { ue: UnitEconomics; scope: string }) {
  const { t } = useI18n();
  const u = t.unitEconomics;
  const labels = u.units as Record<string, string>;
  const label = (d: Pick<CostDriver, "unit" | "provider">) =>
    `${labels[d.unit] ?? d.unit}${d.provider ? ` · ${d.provider}` : ""}`;

  if (ue.sampleSize === 0) {
    return (
      <div className="panel p-4">
        <h2 className="t-section">{u.title}</h2>
        <p className="mt-2 text-[13px] text-[var(--color-muted)]">{fmt(u.empty, { days: ue.windowDays })}</p>
      </div>
    );
  }

  const pricedSub = fmt(u.pricedOf, { priced: ue.pricedVideos, n: ue.sampleSize });
  const minuteSub = ue.minuteSample > 0 ? fmt(u.minuteSample, { n: ue.minuteSample }) : u.minuteNone;
  const top = ue.drivers.slice(0, 3);

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="t-section">{u.title}</h2>
        <span className="mono text-[11px] text-[var(--color-muted)]">
          {fmt(u.scope, { n: ue.sampleSize, days: ue.windowDays, scope })}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={u.medianVideo} value={usd(ue.medianPerVideo)} sub={pricedSub} tone={ue.medianPerVideo === null ? "idle" : undefined} />
        <StatCard label={u.p90Video} value={usd(ue.p90PerVideo)} sub={pricedSub} tone={ue.p90PerVideo === null ? "idle" : undefined} />
        <StatCard label={u.medianMinute} value={usd(ue.medianPerMinute)} sub={minuteSub} tone={ue.medianPerMinute === null ? "idle" : undefined} />
        <StatCard label={u.p90Minute} value={usd(ue.p90PerMinute)} sub={minuteSub} tone={ue.p90PerMinute === null ? "idle" : undefined} />
      </div>

      {ue.partialVideos > 0 && (
        <p className="text-[13px] text-[var(--color-warn)]" role="status">
          {fmt(u.partial, { n: ue.partialVideos })}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{u.driversTitle}</h3>
          {top.length === 0 ? (
            <p className="text-[13px] text-[var(--color-muted)]">{u.driversNone}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {top.map((d) => (
                <li key={d.key} className="flex items-baseline justify-between gap-3 text-[12px]">
                  <span className="min-w-0 truncate text-[var(--color-fg)]">{label(d)}</span>
                  <span className="mono shrink-0 text-right text-[var(--color-fg)]">
                    {usd(d.usdPerVideo)}
                    {u.perVideo}
                    {d.share !== null && (
                      <span className="text-[var(--color-muted)]">
                        {" · "}
                        {fmt(u.share, { pct: `${Math.round(d.share * 100)}%` })}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {ue.unpriced.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{u.unpricedTitle}</h3>
            <ul className="flex flex-col gap-1.5">
              {ue.unpriced.map((x) => (
                <li key={x.unit} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[12px]">
                  <span className="text-[var(--color-fg)]">{labels[x.unit] ?? x.unit}</span>
                  <span className="flex items-baseline gap-2">
                    <code className="mono text-[11px] text-[var(--color-primary)]">{x.envVar}</code>
                    <span className="mono text-[11px] text-[var(--color-muted)]">{fmt(u.unpricedIn, { n: x.videos })}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">{u.unpricedHint}</p>
          </section>
        )}
      </div>

      {ue.unattributedRows > 0 && (
        <p className="mono text-[10px] text-[var(--color-muted)]">{fmt(u.unattributed, { n: ue.unattributedRows })}</p>
      )}
    </div>
  );
}
