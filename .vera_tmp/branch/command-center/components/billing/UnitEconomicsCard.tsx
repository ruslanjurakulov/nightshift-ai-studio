"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatCard } from "@/components/ui";
import { StateBlock } from "@/components/states/StateBlock";
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
  const { t, locale } = useI18n();
  const u = t.unitEconomics;
  const labels = u.units as Record<string, string>;
  const label = (d: Pick<CostDriver, "unit" | "provider">) =>
    `${labels[d.unit] ?? d.unit}${d.provider ? ` · ${d.provider}` : ""}`;

  if (ue.sampleSize === 0) {
    return (
      <section className="panel" aria-labelledby="ue-title">
        <div className="g5-sechead">
          <h2 id="ue-title" className="g5-h">
            {u.title}
          </h2>
        </div>
        <StateBlock tone="idle" compact>
          {fmt(u.empty, { days: ue.windowDays })}
        </StateBlock>
      </section>
    );
  }

  const pricedSub = fmt(u.pricedOf, { priced: ue.pricedVideos, n: ue.sampleSize });
  const minuteSub = ue.minuteSample > 0 ? fmt(u.minuteSample, { n: ue.minuteSample }) : u.minuteNone;
  const top = ue.drivers.slice(0, 3);

  return (
    <section className="panel flex flex-col gap-6" aria-labelledby="ue-title">
      <div className="g5-sechead" style={{ marginBottom: 0 }}>
        <h2 id="ue-title" className="g5-h">
          {u.title}
        </h2>
        <span className="g5-note">{fmt(u.scope, { n: ue.sampleSize, days: ue.windowDays, scope })}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
        <StatCard label={u.medianVideo} value={usd(ue.medianPerVideo, locale)} sub={pricedSub} tone={ue.medianPerVideo === null ? "idle" : undefined} />
        <StatCard label={u.p90Video} value={usd(ue.p90PerVideo, locale)} sub={pricedSub} tone={ue.p90PerVideo === null ? "idle" : undefined} />
        <StatCard label={u.medianMinute} value={usd(ue.medianPerMinute, locale)} sub={minuteSub} tone={ue.medianPerMinute === null ? "idle" : undefined} />
        <StatCard label={u.p90Minute} value={usd(ue.p90PerMinute, locale)} sub={minuteSub} tone={ue.p90PerMinute === null ? "idle" : undefined} />
      </div>

      {ue.partialVideos > 0 && (
        <p className="g5-note" role="status" style={{ color: "var(--color-warn)" }}>
          {fmt(u.partial, { n: ue.partialVideos })}
        </p>
      )}

      <div className="grid grid-cols-1 gap-x-12 gap-y-6 md:grid-cols-2">
        <section className="flex flex-col gap-2" aria-labelledby="ue-drivers">
          <h3 id="ue-drivers" className="g5-k">
            {u.driversTitle}
          </h3>
          {top.length === 0 ? (
            <p className="g5-note">{u.driversNone}</p>
          ) : (
            <ul className="g5-tiles">
              {top.map((d) => (
                <li key={d.key} className="g5-tile">
                  <span className="g5-tile-name">{label(d)}</span>
                  <span className="g5-v shrink-0 text-right">
                    {usd(d.usdPerVideo, locale)}
                    {u.perVideo}
                    {d.share !== null && (
                      <span className="g5-note" style={{ display: "inline" }}>
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
          <section className="flex flex-col gap-2" aria-labelledby="ue-unpriced">
            <h3 id="ue-unpriced" className="g5-k">
              {u.unpricedTitle}
            </h3>
            <ul className="g5-tiles">
              {ue.unpriced.map((x) => (
                <li key={x.unit} className="g5-tile" style={{ flexWrap: "wrap" }}>
                  <span className="g5-tile-name">{labels[x.unit] ?? x.unit}</span>
                  <span className="flex items-baseline gap-3">
                    <code className="mono text-sm text-[var(--ns-act-ink)]">{x.envVar}</code>
                    <span className="g5-note">{fmt(u.unpricedIn, { n: x.videos })}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="g5-note">{u.unpricedHint}</p>
          </section>
        )}
      </div>

      {ue.unattributedRows > 0 && <p className="g5-note">{fmt(u.unattributed, { n: ue.unattributedRows })}</p>}
    </section>
  );
}
