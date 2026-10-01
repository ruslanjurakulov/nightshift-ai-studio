import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { createClient } from "@/lib/supabase/server";
import { getChannelContext } from "@/lib/channels-server";
import { channelSlug, isScoped } from "@/lib/channels";
import { getOrgContext } from "@/lib/orgs-server";
import { heldOnly, uploadedOnly } from "@/lib/heldVideos";
import { buildHomeChannels, countByChannel, lastVideoByChannel } from "@/lib/home";
import { HomeHub } from "@/components/home/HomeHub";
import { loadStudioModels } from "@/lib/server/creative";
import { isRunNowConfigured } from "@/lib/server/run-backend";
import { resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Home ("Bosh sahifa") — where a customer lands after sign-in
 * (lib/navigation landingSection). Reads only: the organization's channels
 * (already resolved for the layout), the newest uploaded video and the
 * held-for-review count per channel (two bounded `videos` reads under the
 * viewer's RLS). Nothing here writes, prices or starts anything.
 *
 * The Assistant's plan needs the models the Studio offers and whether the
 * viewer may start a run — both reads; its prices are asked only once a plan
 * is made, and nothing starts before its one confirm.
 */
export default async function HomePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { channels, selection } = await getChannelContext();
  const org = await getOrgContext();
  const orgId = org.supported && org.current ? org.current.id : null;

  const ids = channels.map((c) => c.channel_id);
  let lastVideos = new Map<string, { title: string; at: string | null }>();
  // null = the read failed: the cards say "couldn't read", never 0.
  let waiting: Map<string, number> | null = new Map();
  const supabase = ids.length > 0 ? await createClient() : null;
  if (supabase) {
    const [uploaded, held] = await Promise.all([
      uploadedOnly(supabase.from("videos").select("channel_id,title,topic,published_at").in("channel_id", ids))
        .order("published_at", { ascending: false, nullsFirst: false })
        .limit(200),
      heldOnly(supabase.from("videos").select("channel_id").in("channel_id", ids)).limit(500),
    ]);
    if (!uploaded.error) lastVideos = lastVideoByChannel(uploaded.data);
    waiting = held.error ? null : countByChannel(held.data);
  } else if (ids.length > 0) {
    waiting = null;
  }

  const homeChannels = buildHomeChannels({
    channels,
    slugOf: (c) => channelSlug(c, channels),
    lastVideos,
    waiting,
  });
  const [models, role] = await Promise.all([orgId ? loadStudioModels() : Promise.resolve([]), resolveCurrentOrgRole()]);
  const scoped = isScoped(selection) ? channels.find((c) => c.channel_id === selection) : undefined;
  const connected = homeChannels.filter((c) => c.standing !== "draft");

  return (
    <HomeHub
      channels={homeChannels}
      currentSlug={scoped ? channelSlug(scoped, channels) : null}
      orgId={orgId}
      allPrivate={connected.length > 0 && connected.every((c) => !c.autoPublish)}
      assistant={{ models, canRun: atLeast(role, "admin"), runConfigured: isRunNowConfigured }}
    />
  );
}
