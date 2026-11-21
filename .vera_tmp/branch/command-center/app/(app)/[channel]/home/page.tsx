import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { getOrgContext } from "@/lib/orgs-server";
import { loadEditorProjects } from "@/lib/server/editor";
import { HomeCreate, type HomeProjectsReading, type HomeWaiting } from "@/components/customer/HomeCreate";
import { getChannelContext } from "@/lib/channels-server";
import { channelSlug, isScoped, orgWide } from "@/lib/channels";
import { runnableChannels } from "@/lib/home";
import { aiChatEnv, aiChatOpenFor } from "@/lib/brain/flag";
import { createClient } from "@/lib/supabase/server";
import { heldOnly } from "@/lib/heldVideos";
import { listWaitingStoryboards } from "@/lib/server/storyboards";
import { readToolAvailability } from "@/lib/server/tool-availability";
import { startAvailability } from "@/lib/start-box";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Home ("Nima yaratamiz?") — where a customer lands after sign-in (lib/navigation landingSection): the start box
 * (components/prompt/StartBox.tsx) with the Trends templates under it by purpose, what to continue, and for a new account
 * three ways to start.
 *
 * Reads only the organization's editor projects, as the signed-in member (RLS); a missing table or a failed read says
 * so instead of an empty list that reads as "none yet". Nothing here writes, prices or starts anything: the box opens
 * Create with the words, and only Create's priced press spends. The channel's autopilot run stays on Create's YouTube
 * desk (/create?desk=youtube), and the channels themselves under the avatar menu.
 */
export default async function HomePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const org = await getOrgContext();
  const orgId = org.supported && org.current ? org.current.id : null;
  let projects: HomeProjectsReading = { state: "not_available" };
  if (orgId) {
    const list = await loadEditorProjects(orgId);
    projects =
      list.state === "ok"
        ? { state: "ok", projects: list.value.map((p) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt })) }
        : list.state === "not_available"
          ? { state: "not_available" }
          : { state: "failed" };
  }
  // What waits for this person's decision (rule 3: the human approval step stays one tap from Home): videos held for review
  // and storyboards waiting for approval, across the organization's channels, as the member (RLS). A failed read is null
  // ("couldn't read"), never 0.
  let waiting: HomeWaiting = { videos: null, storyboards: null };
  const { channels, scope, selection } = await getChannelContext();
  const ids = channels.map((c) => c.channel_id);
  const supabase = ids.length > 0 ? await createClient() : null;
  if (supabase) {
    const [held, boards] = await Promise.all([
      heldOnly(supabase.from("videos").select("channel_id").in("channel_id", ids)).limit(500),
      listWaitingStoryboards(supabase, orgWide(scope)),
    ]);
    waiting = { videos: held.error ? null : (held.data?.length ?? 0), storyboards: boards === null ? null : boards.length };
  } else if (ids.length === 0) {
    waiting = { videos: 0, storyboards: 0 };
  }
  // The start box's "Channel video" goes to a channel YouTube has answered for (rule 7): the open one when it is, else the first.
  const runnable = runnableChannels(channels);
  const target = runnable.find((c) => isScoped(selection) && c.channel_id === selection) ?? runnable[0];
  const channel = target ? { slug: channelSlug(target, channels), name: target.name || target.channel_id } : null;
  // The Agent chip: open only when the server's flag lets this workspace in; computed here, never in the browser.
  const agentOpen = aiChatOpenFor(orgId, aiChatEnv());
  // Which kinds and the edit tab have something on sale: the layout's one read (React cache), so the box and the sidebar agree.
  const available = startAvailability(await readToolAvailability(orgId));
  // The Trends templates are the start box's own library now (by purpose), so Home draws no second strip of them.
  return <HomeCreate orgId={orgId} projects={projects} waiting={waiting} agentOpen={agentOpen} available={available} channel={channel} />;
}
