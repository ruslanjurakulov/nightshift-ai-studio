"use client";

import { useMemo } from "react";
import { useRealtimeEvents } from "@/lib/useRealtimeEvents";
import { ALL_CHANNELS, type ChannelSelection } from "@/lib/channels";
import { useI18n } from "@/lib/i18n/context";
import { deriveAdvisory } from "@/lib/advisory";
import { relativeTime } from "@/lib/format";
import type { SystemEventRow } from "@/lib/types";

/** $12.50, or "N/A" for an unknown (never a fabricated 0). */
function usd(value: number | null): string {
  return value === null || value === undefined ? "N/A" : `$${value.toFixed(2)}`;
}

/** 0.052 → "5.2%", null → "N/A". CTR is a fraction in the backend payload. */
function pct(value: number | null): string {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function Card({
  title,
  updated,
  tone,
  children,
}: {
  title: string;
  updated: string | null;
  tone?: "warn" | "ok";
  children: React.ReactNode;
}) {
  const accent =
    tone === "warn" ? "var(--color-warn, #e2a03f)" : tone === "ok" ? "var(--color-ok, #34d399)" : "var(--color-primary)";
  return (
    <section className="panel flex flex-col gap-4 p-5" style={{ borderTop: `2px solid ${accent}` }}>
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-medium">{title}</h2>
        {updated && <span className="mono text-[11px] text-[var(--color-muted)]">{relativeTime(updated)}</span>}
      </header>
      {children}
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-0">
      <span className="text-[13px] text-[var(--color-muted)]">{label}</span>
      <span className={`mono text-[13px] ${strong ? "font-semibold text-[var(--color-fg)]" : "text-[var(--color-fg)]"}`}>
        {value}
      </span>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="text-[13px] text-[var(--color-muted)]">{label}</p>;
}

export function AdvisoryPanel({
  initial,
  selection = ALL_CHANNELS,
}: {
  initial: SystemEventRow[];
  selection?: ChannelSelection;
}) {
  const { t } = useI18n();
  const { events } = useRealtimeEvents(initial, "advisory-intelligence", selection);
  const adv = useMemo(() => deriveAdvisory(events), [events]);

  const spend = adv.spend;
  const timing = adv.timing;
  const repack = adv.repackage;
  const dur = adv.durability;
  const vidiq = adv.vidiq;
  const sponsor = adv.sponsorship;
  const revenue = adv.revenue;
  const niche = adv.nicheRpm;
  const quota = adv.quota;
  const spendOv = adv.spendOverview;
  const director = adv.director;
  const agent = adv.agent;
  const elements = adv.elements;

  return (
    <div className="grid gap-5 md:grid-cols-2">
      {/* Spend forecast — roadmap #53 */}
      <Card title={t.ops.advSpendTitle} updated={spend?.ts ?? null} tone={spend?.projectedExceeds ? "warn" : undefined}>
        {!spend ? (
          <Empty label={t.ops.advNoData} />
        ) : (
          <>
            <Row label={t.ops.advSpendSpent} value={usd(spend.spentUsd)} />
            <Row label={t.ops.advSpendProjected} value={usd(spend.projectedUsd)} strong />
            <Row label={t.ops.advSpendCeiling} value={spend.ceilingUsd === null ? t.ops.advSpendNoCeiling : usd(spend.ceilingUsd)} />
            {spend.elapsedDays !== null && spend.daysInMonth !== null && (
              <Row label={t.ops.advSpendElapsed} value={`${spend.elapsedDays} / ${spend.daysInMonth}`} />
            )}
            <p
              className="mt-1 text-[13px]"
              style={{ color: spend.projectedExceeds ? "var(--color-warn, #e2a03f)" : "var(--color-muted)" }}
            >
              {spend.ceilingUsd === null
                ? t.ops.advSpendNoCeilingHint
                : spend.projectedExceeds
                  ? t.ops.advSpendOnTrackBlow
                  : t.ops.advSpendWithinCeiling}
            </p>
            {spend.hasUnpriced && <p className="text-[12px] text-[var(--color-muted)]">{t.ops.advSpendUnpriced}</p>}
          </>
        )}
      </Card>

      {/* Publish timing — roadmap #69 */}
      <Card title={t.ops.advTimingTitle} updated={timing?.ts ?? null}>
        {!timing || !timing.hasRecommendation ? (
          <Empty label={timing ? t.ops.advTimingNone : t.ops.advNoData} />
        ) : (
          <>
            <Row
              label={t.ops.advTimingBest}
              value={`${String(timing.bestHourUtc).padStart(2, "0")}:00 ${timing.timezone ?? "UTC"} · ${
                timing.bestWeekdayName ?? "?"
              }`}
              strong
            />
            <Row label={t.ops.advTimingSamples} value={timing.samples === null ? "N/A" : String(timing.samples)} />
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.ops.advTimingHint}</p>
          </>
        )}
      </Card>

      {/* Repackage candidates — roadmap #56 */}
      <Card title={t.ops.advRepackTitle} updated={repack?.ts ?? null} tone={repack && (repack.count ?? 0) > 0 ? "warn" : undefined}>
        {!repack ? (
          <Empty label={t.ops.advNoData} />
        ) : (repack.count ?? 0) === 0 || !repack.worst ? (
          <Empty label={t.ops.advRepackNone} />
        ) : (
          <>
            <Row label={t.ops.advRepackCount} value={String(repack.count)} strong />
            <Row label={t.ops.advRepackWorst} value={repack.worst.title ?? repack.worst.videoId ?? "—"} />
            <Row label={t.ops.advRepackCtr} value={pct(repack.worst.ctr)} />
            <Row label={t.ops.advRepackMedian} value={pct(repack.worst.channelMedianCtr)} />
          </>
        )}
      </Card>

      {/* State durability — roadmap #48 */}
      <Card
        title={t.ops.advDurTitle}
        updated={dur?.ts ?? null}
        tone={dur?.mirrored === true ? "ok" : dur?.mirrored === false ? "warn" : undefined}
      >
        {!dur ? (
          <Empty label={t.ops.advNoData} />
        ) : (
          <>
            <Row label={t.ops.advDurLocal} value={dur.localVideos === null ? "N/A" : String(dur.localVideos)} />
            <Row label={t.ops.advDurRemote} value={dur.remoteVideos === null ? "N/A" : String(dur.remoteVideos)} />
            <p
              className="mt-1 text-[13px]"
              style={{
                color:
                  dur.mirrored === true
                    ? "var(--color-ok, #34d399)"
                    : dur.mirrored === false
                      ? "var(--color-warn, #e2a03f)"
                      : "var(--color-muted)",
              }}
            >
              {dur.mirrored === true
                ? t.ops.advDurMirrored
                : dur.mirrored === false
                  ? t.ops.advDurGap.replace("{n}", String(dur.gap ?? "?"))
                  : dur.mirrorConfigured === false
                    ? t.ops.advDurNotConfigured
                    : t.ops.advDurUnknown}
            </p>
          </>
        )}
      </Card>

      {/* vidIQ keyword research — roadmap #75/#77 */}
      <Card title={t.ops.advVidiqTitle} updated={vidiq?.ts ?? null}>
        {!vidiq || vidiq.top.length === 0 ? (
          <Empty label={vidiq ? t.ops.advVidiqNone : t.ops.advNoData} />
        ) : (
          <>
            <Row label={t.ops.advVidiqBest} value={vidiq.best ?? vidiq.top[0].term} strong />
            {vidiq.top.slice(0, 3).map((kw) => (
              <Row
                key={kw.term}
                label={kw.term}
                value={kw.opportunity === null ? "N/A" : `${Math.round(kw.opportunity * 100)}`}
              />
            ))}
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.ops.advVidiqHint}</p>
          </>
        )}
      </Card>

      {/* Sponsorship pricing — roadmap #72 */}
      <Card title={t.ops.advSponsorTitle} updated={sponsor?.ts ?? null}>
        {!sponsor ? (
          <Empty label={t.ops.advNoData} />
        ) : (
          <>
            <Row
              label={t.ops.advSponsorPrice}
              value={sponsor.hasPrice ? usd(sponsor.priceUsd) : t.ops.advSponsorUnpriced}
              strong
            />
            <Row
              label={t.ops.advSponsorReach}
              value={sponsor.averageViews === null ? "N/A" : Math.round(sponsor.averageViews).toLocaleString()}
            />
            <Row label={t.ops.advSponsorCpm} value={usd(sponsor.cpmUsd)} />
            <Row
              label={t.ops.advSponsorVideos}
              value={sponsor.measuredVideos === null ? "N/A" : String(sponsor.measuredVideos)}
            />
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.ops.advSponsorHint}</p>
          </>
        )}
      </Card>

      {/* Revenue tracking — roadmap #71 */}
      <Card title={t.ops.advRevenueTitle} updated={revenue?.ts ?? null}>
        {!revenue ? (
          <Empty label={t.ops.advNoData} />
        ) : !revenue.hasRevenue ? (
          <Empty label={t.ops.advRevenueNone} />
        ) : (
          <>
            <Row label={t.ops.advRevenueTotal} value={usd(revenue.totalUsd)} strong />
            <Row label={t.ops.advRevenueRpm} value={usd(revenue.channelRpmUsd)} />
            <Row
              label={t.ops.advRevenueMeasured}
              value={`${revenue.measuredCount ?? 0} / ${revenue.videoCount ?? 0}`}
            />
            {revenue.top[0] && (
              <Row label={t.ops.advRevenueTop} value={usd(revenue.top[0].revenueUsd)} />
            )}
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.ops.advRevenueHint}</p>
          </>
        )}
      </Card>

      {/* Niche RPM ranking — roadmap #70 */}
      <Card title={t.ops.advNicheTitle} updated={niche?.ts ?? null}>
        {!niche || niche.niches.length === 0 ? (
          <Empty label={niche ? t.ops.advNicheNone : t.ops.advNoData} />
        ) : (
          <>
            <Row label={t.ops.advNicheBest} value={niche.bestNiche ?? t.common.na} strong />
            {niche.niches.slice(0, 4).map((n) => (
              <Row
                key={n.niche}
                label={n.niche}
                value={
                  n.tier === 2 && n.rpmUsd !== null
                    ? `${usd(n.rpmUsd)} RPM`
                    : n.avgViews !== null
                      ? `${Math.round(n.avgViews).toLocaleString()} ${t.ops.advNicheViews}`
                      : t.common.na
                }
              />
            ))}
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.ops.advNicheHint}</p>
          </>
        )}
      </Card>

      {/* Upload-quota allocation — roadmap #73 */}
      <Card title={t.ops.advQuotaTitle} updated={quota?.ts ?? null}>
        {!quota || quota.channels.length === 0 ? (
          <Empty label={quota ? t.ops.advQuotaNone : t.ops.advNoData} />
        ) : (
          <>
            <Row label={t.ops.advQuotaTotal} value={quota.totalSlots === null ? "N/A" : String(quota.totalSlots)} strong />
            {quota.channels.slice(0, 4).map((c) => (
              <Row
                key={c.channelId}
                label={c.name}
                value={`${c.slots ?? 0} · ${c.share === null ? t.common.na : `${Math.round(c.share * 100)}%`}`}
              />
            ))}
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.ops.advQuotaHint}</p>
          </>
        )}
      </Card>

      {/* All-Accounts spend overview — roadmap #53 */}
      <Card
        title={t.ops.advSpendOvTitle}
        updated={spendOv?.ts ?? null}
        tone={spendOv?.anyUnpriced ? "warn" : undefined}
      >
        {!spendOv || spendOv.channels.length === 0 ? (
          <Empty label={spendOv ? t.ops.advSpendOvNone : t.ops.advNoData} />
        ) : (
          <>
            <Row label={t.ops.advSpendOvTotal} value={usd(spendOv.totalSpentUsd)} strong />
            <Row label={t.ops.advSpendOvProjected} value={usd(spendOv.totalProjectedUsd)} />
            {spendOv.channels.slice(0, 4).map((c) => (
              <Row
                key={c.channelId}
                label={c.name}
                value={`${usd(c.spentUsd)}${
                  c.videosRemaining === null ? "" : ` · ~${c.videosRemaining} ${t.ops.advSpendOvVideos}`
                }`}
              />
            ))}
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">
              {spendOv.anyUnpriced ? t.ops.advSpendOvUnpriced : t.ops.advSpendOvHint}
            </p>
          </>
        )}
      </Card>

      {/* Director Mode shot plan — Nightshift blueprint */}
      <Card title={t.ops.advDirectorTitle} updated={director?.ts ?? null}>
        {!director || director.shots.length === 0 ? (
          <Empty label={director ? t.ops.advDirectorNone : t.ops.advNoData} />
        ) : (
          <>
            <Row
              label={t.ops.advDirectorScenes}
              value={director.scenes === null ? "N/A" : String(director.scenes)}
              strong
            />
            {director.shots.slice(0, 5).map((s, i) => (
              <Row
                key={s.scene ?? i}
                label={`${s.scene ?? i + 1}. ${s.name}`}
                value={`${s.shot} · ${s.camera}`}
              />
            ))}
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.ops.advDirectorHint}</p>
          </>
        )}
      </Card>

      {/* Autopilot agent — the day's chosen topic + why (Nightshift blueprint) */}
      <Card title={t.ops.advAgentTitle} updated={agent?.ts ?? null}>
        {!agent || !agent.topic ? (
          <Empty label={agent ? t.ops.advAgentNone : t.ops.advNoData} />
        ) : (
          <>
            <Row label={t.ops.advAgentTopic} value={agent.topic} strong />
            <Row
              label={t.ops.advAgentSource}
              value={agent.source || t.common.dash}
            />
            <Row
              label={t.ops.advAgentProviders}
              value={`${agent.videoProvider || t.common.dash} · ${agent.voiceProvider || t.common.dash}`}
            />
            {agent.rationale && (
              <p className="mt-1 text-[13px] text-[var(--color-fg)]">{agent.rationale}</p>
            )}
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.ops.advAgentHint}</p>
          </>
        )}
      </Card>

      {/* Character Bible — elements applied this run (Nightshift blueprint) */}
      <Card title={t.ops.advElementsTitle} updated={elements?.ts ?? null}>
        {!elements || elements.defined === 0 ? (
          <Empty label={elements ? t.ops.advElementsNone : t.ops.advNoData} />
        ) : (
          <>
            <Row label={t.ops.advElementsDefined} value={elements.defined === null ? "N/A" : String(elements.defined)} strong />
            <Row
              label={t.ops.advElementsScenes}
              value={elements.scenesTouched === null ? "N/A" : String(elements.scenesTouched)}
            />
            <Row
              label={t.ops.advElementsApplied}
              value={elements.applied.length ? elements.applied.slice(0, 6).join(", ") : t.common.none}
            />
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.ops.advElementsHint}</p>
          </>
        )}
      </Card>
    </div>
  );
}
