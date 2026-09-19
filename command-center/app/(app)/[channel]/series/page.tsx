import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { SeriesBoard } from "@/components/series/SeriesBoard";
import type { SeriesRow } from "@/lib/series";

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

  if (supabase) {
    const [s, c] = await Promise.all([
      supabase.from("content_series").select("*").order("created_at", { ascending: false }).limit(500),
      supabase.from("channels").select("channel_id,name").order("channel_id"),
    ]);
    if (s.error && /content_series/.test(s.error.message)) tableMissing = true;
    series = (s.data as SeriesRow[]) ?? [];
    channels = (c.data as ChannelOption[]) ?? [];
  }
  if (channels.length === 0) channels = [{ channel_id: "default", name: "Default" }];

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
