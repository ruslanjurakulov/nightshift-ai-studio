import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { getOrgContext } from "@/lib/orgs-server";
import { loadEditorProjects } from "@/lib/server/editor";
import { HomeCreate, type HomeProjectsReading, type HomeWaiting } from "@/components/customer/HomeCreate";
import { getChannelContext } from "@/lib/channels-server";
import { orgWide } from "@/lib/channels";
import { createClient } from "@/lib/supabase/server";
import { heldOnly } from "@/lib/heldVideos";
import { listWaitingStoryboards } from "@/lib/server/storyboards";
import { TrendsStrip } from "@/components/trends/TrendsStrip";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Home ("Nima yaratamiz?") — where a customer lands after sign-in (lib/navigation landingSection): the prompt box with
 * its Video | Image | Audio tabs, the top trend templates (stream S3's GET /api/templates, a designed placeholder until
 * it is deployed), what to continue, and for a new account three ways to start.
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
  const { channels, scope } = await getChannelContext();
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
  // Trends (0183): stream S3's strip of the first six templates, in Home's slot (one strip, never a second copy).
  return <HomeCreate orgId={orgId} projects={projects} waiting={waiting} trends={<TrendsStrip />} />;
}
