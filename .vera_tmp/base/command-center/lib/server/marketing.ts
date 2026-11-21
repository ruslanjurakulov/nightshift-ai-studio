import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OwnerRead } from "@/lib/server/owner-reads";
import {
  POST_COLUMNS,
  POST_LIMIT,
  channelHandle,
  coercePosts,
  coerceSettings,
  parseMarketingFlag,
  validOrigin,
  type ListedPost,
  type MarketingSettings,
} from "@/lib/marketing-posts";

/**
 * NIGHTSHIFT_MARKETING_POSTS — a server env var, exactly `on` to turn the page and its route on (default off).
 *
 * It is the SAME variable the worker reads (tools/marketing_worker.py), so one repository variable switches both: with
 * anything else, empty included, the worker idles, this page shows only an "off" note (no database read at all) and a
 * same-origin POST to /api/marketing answers 404. It is read on every call, never at import: a restart is enough. The
 * read names the variable literally because tests/test_deploy_self_host.py scans for exactly that, so the name is also in
 * deploy/.env.web.example and .github/workflows/deploy_web.yml.
 *
 * It does not replace the database switch (marketing_settings.enabled): both must be on for a post to go out.
 */
export function marketingPostsOn(): boolean {
  return parseMarketingFlag(process.env.NIGHTSHIFT_MARKETING_POSTS);
}

/**
 * The channel the worker posts to (MARKETING_TELEGRAM_CHAT, the same repository variable: `@name` or a numeric chat id; a
 * public handle, not a secret) and the origin links are completed with, for the preview. The origin is read the way the worker
 * reads it: NOTIFY_APP_ORIGIN when it is set (a set but invalid value is unknown, as the worker would refuse it), else the
 * site's own APP_ORIGIN (which the deploy derives from the same DOMAIN the worker's default uses). Either is `null` when unset
 * or not in the shape the deploy accepts: the page then says it does not know, instead of guessing.
 */
export function marketingTargets(): { channel: string | null; origin: string | null } {
  const notify = (process.env.NOTIFY_APP_ORIGIN ?? "").trim();
  return {
    channel: channelHandle(process.env.MARKETING_TELEGRAM_CHAT),
    origin: notify !== "" ? validOrigin(notify) : validOrigin(process.env.APP_ORIGIN),
  };
}

export interface MarketingData {
  settings: MarketingSettings;
  posts: ListedPost[];
  /** The read hit its ceiling: older posts exist that this page does not list. */
  truncated: boolean;
}

type PgError = { code?: string | null; message?: string | null } | null;

/** 42883 / PGRST202: the function is not there. 42P01 / PGRST205: the table is not there (0108 not applied). */
function missing(error: PgError): boolean {
  return ["42883", "PGRST202", "42P01", "PGRST205"].includes(error?.code ?? "");
}

/**
 * The settings (owner_marketing_get) and the newest posts (a platform admin may SELECT marketing_posts), both as the
 * signed-in user. `unsupported` = migration 0108 is not applied; `failed` = unknown (never an empty list or a "0 of 2").
 * Only called while the switch is on and for an operator.
 */
export async function readMarketing(supabase: SupabaseClient): Promise<OwnerRead<MarketingData>> {
  try {
    const [settings, posts] = await Promise.all([
      supabase.rpc("owner_marketing_get"),
      supabase.from("marketing_posts").select(POST_COLUMNS).order("created_at", { ascending: false }).limit(POST_LIMIT),
    ]);
    if (missing(settings.error) || missing(posts.error)) return { state: "unsupported" };
    if (settings.error || posts.error) return { state: "failed" };
    const s = coerceSettings(settings.data);
    const p = coercePosts(posts.data);
    if (!s || !p) return { state: "failed" };
    return { state: "ok", value: { settings: s, posts: p, truncated: p.length >= POST_LIMIT } };
  } catch {
    return { state: "failed" };
  }
}
