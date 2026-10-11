import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { EmptyState } from "@/components/ui";
import { Figures } from "@/components/g2/Figures";
import { ChannelMark } from "@/components/channels/ChannelMark";
import "../../app-pages-g2.css";
import { num } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelContext } from "@/lib/channels-server";
import { isScoped, orgWide, scopeQuery } from "@/lib/channels";
import { summariseCosts } from "@/lib/measurement";
import { parseRevenueTracked } from "@/lib/advisory";
import { portfolioTotals, type ChannelEconomicsInput } from "@/lib/portfolio";
import type { SystemEventRow, VideoCostRow, VideoRow } from "@/lib/types";
import { uploadedOnly } from "@/lib/heldVideos";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EVENT_REVENUE_TRACKED = "revenue.tracked";

/** USD, or an em-dash when the figure is unknown. Never renders a fabricated 0. */
function usd(value: number | null, dash: string): string {
  return value === null ? dash : `$${value.toFixed(value !== 0 && Math.abs(value) < 1 ? 4 : 2)}`;
}

/** A percentage, or an em-dash when unknown. */
function pct(value: number | null, dash: string, digits = 1): string {
  return value === null ? dash : `${(value * 100).toFixed(digits)}%`;
}

/**
 * Unit-economics portfolio — every channel's cost against its revenue, and the
 * profit, margin, cost-per-video and RPM that fall out of the pair.
 *
 * Deliberately cross-channel (like /accounts): seeing them side by side is the
 * whole point, so the channel in the URL is only "you are here", not a filter.
 *
 * The money discipline is measurement.ts's, scaled up: a monetary figure shows
 * ONLY when it is actually known. A channel's cost counts as known only when
 * every recorded unit is priced — a partly-priced total is a floor that would
 * *overstate* profit, so it reads as unknown here rather than as a confident
 * number. Revenue is the real tracked figure or blank. Profit and margin need
 * both sides. Every blank is an em-dash, never a zero.
 */
export default async function PortfolioPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const dash = t.common.dash;

  const { channels, selection, notMigrated, scope: viewScope } = await getChannelContext();
  // The current organization's channels only. Per-channel figures are keyed
  // off that list already; scoping the reads keeps another tenant's rows from
  // filling the limits (RLS lets a platform admin read every tenant).
  const scope = orgWide(viewScope);
  const supabase = await createClient();

  let costs: VideoCostRow[] = [];
  let videos: VideoRow[] = [];
  let revenueEvents: SystemEventRow[] = [];

  if (supabase && channels.length > 0) {
    const [cost, vid, rev] = await Promise.all([
      scopeQuery(supabase.from("video_costs").select("*"), scope).limit(5000),
      uploadedOnly(scopeQuery(supabase.from("videos").select("*"), scope)).limit(5000),
      scopeQuery(supabase.from("system_events").select("*"), scope)
        .eq("event", EVENT_REVENUE_TRACKED)
        .order("ts", { ascending: false })
        .limit(2000),
    ]);
    // Migration 0002 may not be applied — costs then read as unknown, which is
    // the honest state, not an error to blank the whole page over.
    costs = (cost.data as VideoCostRow[]) ?? [];
    videos = (vid.data as VideoRow[]) ?? [];
    revenueEvents = (rev.data as SystemEventRow[]) ?? [];
  }

  // Newest revenue.tracked per channel. The list is ts-desc, so the first row
  // seen for a channel is its latest.
  const latestRevenue = new Map<string, SystemEventRow>();
  for (const e of revenueEvents) {
    if (!e.channel_id) continue;
    if (!latestRevenue.has(e.channel_id)) latestRevenue.set(e.channel_id, e);
  }

  const inputs: ChannelEconomicsInput[] = channels.map((c) => {
    const channelCosts = costs.filter((row) => row.channel_id === c.channel_id);
    const summary = summariseCosts(channelCosts);
    // Known cost only when nothing is unpriced: a floor would understate cost
    // and so overstate profit, which the money rule forbids.
    const cost = summary.unpricedUnits.length > 0 ? null : summary.totalUsd;

    const revenue = parseRevenueTracked(latestRevenue.get(c.channel_id) ?? null);

    return {
      channelId: c.channel_id,
      name: c.name || c.channel_id,
      videoCount: videos.filter((v) => v.channel_id === c.channel_id).length,
      cost,
      revenue: revenue?.totalUsd ?? null,
      rpm: revenue?.channelRpmUsd ?? null,
    };
  });

  const totals = portfolioTotals(inputs);
  const hereId = isScoped(selection) ? selection : null;

  // Channels earn a place once they carry any economics (a cost or a revenue);
  // a channel with only a video count is shown but its money reads as unknown.
  const anyMoney = totals.channels.some((c) => c.cost !== null || c.revenue !== null);

  const tilde = (partial: boolean) => (partial ? "~" : "");

  return (
    <div className="rhythm ns-open stagger-enter">
      <PageHeader icon="portfolio" title={t.portfolio.title} subtitle={t.portfolio.subtitle} />

      {notMigrated ? (
        <section className="ns-desk g2-desk">
          <EmptyState>{t.portfolio.empty}</EmptyState>
        </section>
      ) : channels.length === 0 ? (
        <section className="ns-desk g2-desk">
          <EmptyState>{t.portfolio.empty}</EmptyState>
        </section>
      ) : !anyMoney ? (
        <section className="ns-desk g2-desk">
          <EmptyState>{t.portfolio.notConfigured}</EmptyState>
        </section>
      ) : (
        <>
          {/* ------------------------------------------------------- summary */}
          <Figures
            items={[
              {
                label: t.portfolio.totalSpend,
                value: `${tilde(totals.costPartial)}${usd(totals.totalCost, dash)}`,
                tone: totals.totalCost === null ? "idle" : undefined,
              },
              {
                label: t.portfolio.totalRevenue,
                value: `${tilde(totals.revenuePartial)}${usd(totals.totalRevenue, dash)}`,
                tone: totals.totalRevenue === null ? "idle" : "ok",
              },
              {
                label: t.portfolio.totalProfit,
                value: usd(totals.totalProfit, dash),
                tone: totals.totalProfit === null ? "idle" : totals.totalProfit >= 0 ? "ok" : "fail",
              },
              { label: t.portfolio.avgMargin, value: pct(totals.avgMargin, dash) },
            ]}
          />

          {(totals.costPartial || totals.revenuePartial) && (
            <p className="g2-note">{t.portfolio.floorNote}</p>
          )}

          {/* -------------------------------------------------- per-channel */}
          <section className="ns-desk g2-desk" aria-labelledby="portfolio-ledger-title">
            <div className="g2-stack-lg">
              <h2 id="portfolio-ledger-title" className="g2-h2">
                {t.portfolio.title}
              </h2>
              <table className="g2-ledger g2-ledger-wide">
                <thead>
                  <tr>
                    <th scope="col">{t.portfolio.colChannel}</th>
                    <th scope="col" className="num">{t.portfolio.colVideos}</th>
                    <th scope="col" className="num">{t.portfolio.colSpend}</th>
                    <th scope="col" className="num">{t.portfolio.colRevenue}</th>
                    <th scope="col" className="num">{t.portfolio.colProfit}</th>
                    <th scope="col" className="num">{t.portfolio.colMargin}</th>
                    <th scope="col" className="num">{t.portfolio.colCostPerVideo}</th>
                    <th scope="col" className="num">{t.portfolio.colRpm}</th>
                  </tr>
                </thead>
                <tbody>
                  {totals.channels.map((c) => {
                    const here = c.channelId === hereId;
                    return (
                      <tr key={c.channelId}>
                        <td>
                          <span className="g2-ledger-name">
                            <ChannelMark name={c.name} size="sm" />
                            <span>
                              <span className="font-semibold text-[var(--color-fg)]">{c.name}</span>
                              {here && <small className="g2-here">{t.accounts.youAreHere}</small>}
                            </span>
                          </span>
                        </td>
                        <td data-label={t.portfolio.colVideos} className="num dim">{num(c.videoCount)}</td>
                        <td data-label={t.portfolio.colSpend} className="num">
                          <MoneyCell text={usd(c.cost, dash)} known={c.cost !== null} />
                        </td>
                        <td data-label={t.portfolio.colRevenue} className="num">
                          <MoneyCell text={usd(c.revenue, dash)} known={c.revenue !== null} />
                        </td>
                        <td data-label={t.portfolio.colProfit} className="num">
                          {c.profit === null ? (
                            <span className="dim">{dash}</span>
                          ) : (
                            <span style={{ color: c.profit >= 0 ? "var(--color-ok)" : "var(--color-fail)" }}>
                              {usd(c.profit, dash)}
                            </span>
                          )}
                        </td>
                        <td data-label={t.portfolio.colMargin} className="num">
                          <MoneyCell text={pct(c.margin, dash)} known={c.margin !== null} />
                        </td>
                        <td data-label={t.portfolio.colCostPerVideo} className="num">
                          <MoneyCell text={usd(c.costPerVideo, dash)} known={c.costPerVideo !== null} />
                        </td>
                        <td data-label={t.portfolio.colRpm} className="num">
                          <MoneyCell text={usd(c.rpm, dash)} known={c.rpm !== null} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <p className="g2-note tnum">{t.portfolio.unknownNote}</p>
        </>
      )}
    </div>
  );
}

/** A right-aligned money/percent cell: real value in foreground, blank muted. */
function MoneyCell({ text, known }: { text: string; known: boolean }) {
  return (
    <span className={known ? "text-[var(--color-fg)]" : "dim"}>{text}</span>
  );
}
