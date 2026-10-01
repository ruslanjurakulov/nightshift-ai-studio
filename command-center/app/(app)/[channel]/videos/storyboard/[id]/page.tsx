import { createClient } from "@/lib/supabase/server";
import { getChannelPath } from "@/lib/channels-path-server";
import { getChannelScope } from "@/lib/channels-server";
import { channelInScope } from "@/lib/channels";
import { isOperator, requireOrgRole } from "@/lib/auth/org-roles";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { ErrorState } from "@/components/ReadError";
import { EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { StoryboardReview } from "@/components/storyboard/StoryboardReview";
import { getDictionary } from "@/lib/i18n/server";
import { quoteStoryboard, readStoryboard } from "@/lib/server/storyboards";
import type { StoryboardQuote } from "@/lib/storyboardReview";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * A run waiting at "Storyboard ready" (migration 0057): its scene cards and
 * the one price of its render, computed here on the server from the
 * storyboard's own length — the same estimate the approve route checks the
 * press against. The page itself changes nothing.
 */
export default async function StoryboardPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { id } = await params;
  const { t } = await getDictionary();
  const ts = t.storyboardReview;
  const path = await getChannelPath();
  const supabase = await createClient();
  const header = <PageHeader icon="videos" title={ts.title} subtitle={ts.subtitle} />;
  if (!supabase) return <NotConfigured />;

  const read = await readStoryboard(supabase, id);
  // Another organization's storyboard reads exactly like a missing one: RLS
  // hides it from a member elsewhere, and a platform admin sees it only after
  // switching to its organization.
  const visible = read.ok && channelInScope(read.storyboard.channelId, await getChannelScope());
  if (!read.ok || !visible) {
    return (
      <div className="rhythm stagger-enter">
        {header}
        {!read.ok && read.error !== "not_found" ? (
          <ErrorState message={read.error === "storyboard_unavailable" ? ts.errUnavailable : ts.readErr} />
        ) : (
          <EmptyState>{ts.notFound}</EmptyState>
        )}
      </div>
    );
  }
  const storyboard = read.storyboard;
  const access = await requireOrgRole({ channelId: storyboard.channelId }, "admin");
  const quote: StoryboardQuote =
    storyboard.status === "ready"
      ? await quoteStoryboard(supabase, storyboard, access.ok && access.source === "org" ? access.orgId : null)
      : { kind: "unavailable", reason: "read_failed" };
  const operator = await isOperator();

  return (
    <div className="rhythm stagger-enter">
      {header}
      <StoryboardReview
        storyboard={storyboard}
        quote={quote}
        canRun={access.ok}
        backHref={path("/videos")}
        bottomBar={!operator}
      />
    </div>
  );
}
