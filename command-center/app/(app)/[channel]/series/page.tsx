import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { SeriesBoard } from "@/components/series/SeriesBoard";
import type { SeriesRow } from "@/lib/series";
import { getChannelContext } from "@/lib/channels-server";
import { orgWide, scopeQuery } from "@/lib/channels";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ChannelOption = { channel_id: string; name: string };

/**
 * Series — the recurring content lines within each channel (niche, format,
 * style, cadence, platforms, automation level). A channel can run several.
 *
 * Reads the content_series table (migration 0006). If that migration has not
 * been applied yet the query fails softly and the board shows its empty state
 * with a note, rather than the page erroring — the same posture the other
 * data pages take before their tables exist.
 */
export default async function SeriesPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const supabase = await createClient();

  let series: SeriesRow[] = [];
  let channels: ChannelOption[] = [];
  let tableMissing = false;

  // Every series of the CURRENT organization, whichever channel is selected;
  // the channel options are the same org-filtered list the switcher shows.
  const ctx = await getChannelContext();
  if (supabase) {
    const s = await scopeQuery(supabase.from("content_series").select("*"), orgWide(ctx.scope))
      .order("created_at", { ascending: false })
      .limit(500);
    if (s.error && /content_series/.test(s.error.message)) tableMissing = true;
    series = (s.data as SeriesRow[]) ?? [];
    channels = ctx.channels.map((c) => ({ channel_id: c.channel_id, name: c.name }));
  }
  // The pre-multi-channel fallback. Inside an organization an empty list is
  // the truth: offering the operator's "default" channel to a tenant would
  // name a channel the tenant cannot write to.
  if (channels.length === 0 && ctx.scope.orgChannelIds === null) {
    channels = [{ channel_id: "default", name: "Default" }];
  }

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="series" title={t.series.title} subtitle={t.series.subtitle} />
      <SeriesBoard
        series={series}
        channels={channels}
        tableMissing={tableMissing}
        strings={t.series}
      />
    </div>
  );
}
