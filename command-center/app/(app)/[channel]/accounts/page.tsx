import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState } from "@/components/ui";
import { AccountsBoard } from "@/components/accounts/AccountsBoard";
import { getChannelContext } from "@/lib/channels-server";
import { ACCOUNT_WINDOW_DAYS, isScoped, rollupAccounts } from "@/lib/channels";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import type { ContentQueueRow, SystemEventRow, VideoRow } from "@/lib/types";
import { uploadedOnly } from "@/lib/heldVideos";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * All Accounts — every channel on one screen.
 *
 * Every other screen answers "how is this channel doing"; nothing answered "how
 * are they all doing", so the only way to find a channel that had quietly
 * stopped was to visit each one in turn. This is that missing view: what each
 * published, what is queued behind it, what failed, and which are not doing
 * anything at all.
 *
 * Like /channels this is deliberately NOT scoped by the channel in the URL —
 * looking at all of them together is the whole point. The channel the URL names
 * is marked "you are here" instead, so the address bar still means something.
 */
export default async function AccountsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();

  const { channels, credentials, selection, notMigrated } = await getChannelContext();
  const supabase = await createClient();

  let events: SystemEventRow[] = [];
  let videos: VideoRow[] = [];
  let queue: ContentQueueRow[] = [];
  let lastEventAt: Record<string, string | null> = {};

  if (supabase && channels.length > 0) {
    // `system_events.ts` is a text column holding an ISO-8601 string, so this
    // bound is a string comparison. The bot writes `datetime.utcnow().isoformat()`
    // with no zone suffix, so the bound is written the same way: a row stored
    // with a "Z" sorts AFTER the bare form of the same instant, which makes the
    // filter over-inclusive by at most a second rather than dropping rows. The
    // exact cut is then made in the derivation, from parsed times.
    const since = new Date(Date.now() - ACCOUNT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/Z$/, "");

    const [ev, vid, q, ...latest] = await Promise.all([
      supabase.from("system_events").select("*").gte("ts", since).order("ts", { ascending: false }).limit(5000),
      // nullsFirst:false keeps unpublished rows from filling the limit ahead of
      // the published ones — Postgres sorts NULLs first on a DESC order.
      uploadedOnly(supabase.from("videos").select("*")).order("published_at", { ascending: false, nullsFirst: false }).limit(2000),
      supabase.from("content_queue").select("*").limit(2000),
      // One tiny query per channel for its newest event over ALL time. The
      // windowed fetch above cannot answer this: a channel that ran once six
      // months ago and stopped has nothing inside the window, and is exactly
      // the channel this screen exists to surface. Channels number in the
      // single digits, and each of these reads one row off idx_events_ts.
      ...channels.map((c) =>
        supabase
          .from("system_events")
          .select("ts")
          .eq("channel_id", c.channel_id)
          .order("ts", { ascending: false })
          .limit(1),
      ),
    ]);

    events = (ev.data as SystemEventRow[]) ?? [];
    videos = (vid.data as VideoRow[]) ?? [];
    queue = (q.data as ContentQueueRow[]) ?? [];
    lastEventAt = Object.fromEntries(
      channels.map((c, i) => [
        c.channel_id,
        ((latest[i]?.data as { ts: string }[] | null) ?? [])[0]?.ts ?? null,
      ]),
    );
  }

  const rollup = rollupAccounts({ channels, videos, queue, events, credentials, lastEventAt });

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="accounts" title={t.accounts.title} subtitle={t.accounts.subtitle} />

      {notMigrated ? (
        <Panel title={t.accounts.title}>
          <EmptyState>{t.channels.notMigrated}</EmptyState>
        </Panel>
      ) : channels.length === 0 ? (
        <Panel title={t.accounts.title}>
          <EmptyState>{t.accounts.empty}</EmptyState>
        </Panel>
      ) : (
        <AccountsBoard rollup={rollup} here={isScoped(selection) ? selection : null} />
      )}
    </div>
  );
}
