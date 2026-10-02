import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { CommentInbox, type InboxPrice } from "@/components/inbox/CommentInbox";
import { getChannelContext } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";
import { isPlatformAdmin, resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles-shared";
import { readCreditPrices } from "@/lib/server/credits";
import { isMissingRelation } from "@/lib/style-kits";
import {
  COMMENT_COLUMNS,
  DRAFT_COLUMNS,
  INBOX_LIMITS,
  INTENT_COLUMNS,
  POST_COLUMNS,
  POST_COLUMNS_0081,
  buildItems,
  parseComments,
  parseDrafts,
  parseIntents,
  parsePosts,
  replyDraftPrice,
} from "@/lib/comment-inbox";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The comment inbox (migration 0081): the channel's comments, drafted replies
 * a person asks for, edits and approves. Everything is read as the signed-in
 * member (RLS: their organization's channels only). A read that failed is said
 * to have failed: never an empty inbox that reads as "no comments", and an
 * unset price is "not priced", never free.
 */
export default async function InboxPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { channels, scope } = await getChannelContext();
  const header = <PageHeader icon="inbox" title={t.inbox.title} subtitle={t.inbox.subtitle} />;
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;

  const res = await scopeQuery(supabase.from("inbox_comments").select(COMMENT_COLUMNS), scope)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(INBOX_LIMITS.listMax);
  if (res.error) {
    return (
      <div className="rhythm stagger-enter">
        {header}
        <p className="text-[13px] text-[var(--color-muted)]">{isMissingRelation(res.error) ? t.inbox.notEnabled : t.inbox.readFailed}</p>
      </div>
    );
  }
  const comments = parseComments(res.data);
  const ids = comments.map((c) => c.id);

  const [drafts, intents, firstPosts, videos] = ids.length
    ? await Promise.all([
        supabase.from("reply_drafts").select(DRAFT_COLUMNS).in("comment_id", ids).order("created_at", { ascending: false }).limit(400),
        supabase.from("reply_intents").select(INTENT_COLUMNS).in("comment_id", ids).limit(400),
        supabase.from("reply_posts").select(POST_COLUMNS).in("comment_id", ids).limit(400),
        supabase.from("videos").select("video_id,title").in("video_id", [...new Set(comments.map((c) => c.videoId))].slice(0, 100)),
      ])
    : [null, null, null, null];
  // 0090's wait_reason column is not there yet (0081 alone): read the posts without it.
  let posts: { data: unknown; error: { code?: string; message?: string } | null } | null = firstPosts;
  if (posts?.error && isMissingRelation(posts.error)) {
    posts = await supabase.from("reply_posts").select(POST_COLUMNS_0081).in("comment_id", ids).limit(400);
  }
  // A read that failed is unknown: the page says so rather than showing comments with no state.
  if (drafts?.error || intents?.error || posts?.error) {
    return (
      <div className="rhythm stagger-enter">
        {header}
        <p className="text-[13px] text-[var(--color-muted)]">{t.inbox.readFailed}</p>
      </div>
    );
  }

  const videoTitles: Record<string, string> = {};
  for (const v of (Array.isArray(videos?.data) ? videos.data : []) as Array<{ video_id?: unknown; title?: unknown }>) {
    if (typeof v.video_id === "string" && typeof v.title === "string") videoTitles[v.video_id] = v.title.slice(0, 200);
  }
  const channelNames: Record<string, string> = {};
  for (const c of channels) channelNames[c.channel_id] = c.name ?? c.channel_id;

  // The price as charged (credit_rates(), never the margin). Unset = not priced = drafting is off.
  const org = await getOrgContext();
  const prices = await readCreditPrices(supabase);
  let exempt = false;
  if (org.current) {
    const e = await supabase.rpc("credits_exempt", { p_org: org.current.id });
    exempt = !e.error && e.data === true;
  }
  const credits = prices.failed ? null : replyDraftPrice(prices.prices);
  const price: InboxPrice = prices.failed
    ? { state: "failed", credits: null }
    : credits === null
      ? { state: "unpriced", credits: null }
      : credits === 0 || exempt
        ? { state: "included", credits: 0 }
        : { state: "priced", credits };

  // Presentation only: the database re-checks every action. In the operator's own
  // organization only a platform admin may start a draft (0081, as 0036).
  const role = await resolveCurrentOrgRole();
  const canAct = atLeast(role, "editor") && (!exempt || (await isPlatformAdmin()));

  const items = buildItems(comments, parseDrafts(drafts?.data), parseIntents(intents?.data), parsePosts(posts?.data));
  return (
    <div className="rhythm stagger-enter">
      {header}
      <CommentInbox items={items} channelNames={channelNames} videoTitles={videoTitles} price={price} canAct={canAct} />
    </div>
  );
}
