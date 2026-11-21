import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { Note } from "@/components/g3/Section";
import { ResearchBoard } from "@/components/research/ResearchBoard";
import { getChannelContext } from "@/lib/channels-server";
import { ALL_CHANNELS } from "@/lib/channels";
import { getDictionary } from "@/lib/i18n/server";
import { resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles-shared";
import { isMissingFunction } from "@/lib/orgs";
import {
  parseCompetitors,
  parseOwn,
  parsePanel,
  parseThemes,
  parseTopic,
  unreadPanel,
  type Panel,
} from "@/lib/research";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Rpc = { data: unknown; error: { code?: string; message?: string } | null };

/** A reader's answer as a panel; a missing function (0202 not applied) is "not enabled here", any other failure is "could not read". */
function panelOf<T>(res: Rpc, parse: (d: unknown) => T | null): Panel<T> {
  if (res.error) return unreadPanel<T>(isMissingFunction(res.error));
  return parsePanel(res.data, parse);
}

/**
 * Channel research (migration 0202): the channel's own YouTube numbers, the competitors a person named, the channels YouTube lists
 * for a topic, and themes in the channel's own comments. Read with the signed-in member's own session through the four reader
 * functions (each checks the channel's organization itself). Nothing here calls YouTube or spends: Refresh writes a request row and
 * the queue worker fetches.
 */
export default async function ResearchPage({ searchParams }: { searchParams: Promise<{ topic?: string | string[] }> }) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const header = <PageHeader icon="research" title={t.research.title} subtitle={t.research.subtitle} />;
  const { selection, slug } = await getChannelContext();
  if (selection === ALL_CHANNELS) {
    return (
      <div className="rhythm ns-open stagger-enter">
        {header}
        <Note>{t.research.pickChannel}</Note>
      </div>
    );
  }
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;

  const raw = (await searchParams).topic;
  // As typed (trimmed, capped): the database normalizes it, the same way it did when the search was asked for.
  const topicQuery = typeof raw === "string" && raw.trim().length >= 2 ? raw.trim().slice(0, 80) : null;
  const channel = selection;
  const [own, competitors, topic, themes] = (await Promise.all([
    supabase.rpc("research_own_channel", { p_channel: channel }),
    supabase.rpc("research_competitors_view", { p_channel: channel }),
    supabase.rpc("research_topic_channels", { p_channel: channel, p_topic: topicQuery }),
    supabase.rpc("research_comment_themes", { p_channel: channel, p_days: 28 }),
  ])) as Rpc[];

  // Presentation only: every writer checks the role again in the database.
  const role = await resolveCurrentOrgRole();
  return (
    <div className="rhythm ns-open stagger-enter">
      {header}
      <ResearchBoard
        channel={channel}
        slug={slug}
        canEdit={atLeast(role, "editor")}
        own={panelOf(own, parseOwn)}
        competitors={panelOf(competitors, parseCompetitors)}
        topic={panelOf(topic, parseTopic)}
        themes={panelOf(themes, parseThemes)}
        topicQuery={topicQuery}
        nowMs={Date.now()}
      />
    </div>
  );
}
