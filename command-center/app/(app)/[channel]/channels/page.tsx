import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { getChannelPath } from "@/lib/channels-path-server";
import { NotConfigured } from "@/components/NotConfigured";
import { EmptyState } from "@/components/ui";
import { ChannelCard } from "@/components/channels/ChannelCard";
import { ChannelComparison } from "@/components/channels/ChannelComparison";
import { getChannelContext } from "@/lib/channels-server";
import { channelHealth, channelSlug, channelStats, orgWide, scopeQuery } from "@/lib/channels";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import "../../app-pages-g2.css";
import type {
  ContentQueueRow,
  MetricsSnapshotRow,
  SystemEventRow,
  VideoRow,
} from "@/lib/types";
import { uploadedOnly } from "@/lib/heldVideos";
import { getOrgContext } from "@/lib/orgs-server";
import { isPlatformAdmin, resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { fetchTokenStatuses } from "@/lib/server/channel-tokens";
import { YOUTUBE_OAUTH_SCOPES, isGoogleOAuthConfigured } from "@/lib/server/google-oauth";
import { parseVaultResult } from "@/lib/channel-tokens";
import { fetchSocialAccounts } from "@/lib/server/social-accounts";
import { isSocialConfigured } from "@/lib/server/social-oauth";
import { isSocialPlatform, parseSocialResult } from "@/lib/social-accounts";
import { SocialAccountsPanel } from "@/components/social/SocialAccountsPanel";
import { ChannelDnaSection } from "@/components/channels/ChannelDnaSection";
import { loadStyleContext } from "@/lib/server/style-kits";
import { loadDnaCharacters } from "@/lib/server/channel-dna";
import { dnaFromChannel } from "@/lib/channel-dna";
import { atLeast } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Channel management: every channel, its configuration, its credential status
 * and its own health — plus the cross-channel comparison.
 *
 * Deliberately NOT scoped by the header switcher: this is the page where you
 * look at all of them side by side.
 */
export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ yt?: string; social?: string; platform?: string }>;
}) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const sp = await searchParams;
  const ytResult = parseVaultResult(sp.yt);
  const socialWord = parseSocialResult(sp.social);
  const socialResult =
    socialWord && isSocialPlatform(sp.platform) ? { platform: sp.platform, word: socialWord } : null;
  const path = await getChannelPath();

  const { channels, credentials, notMigrated, scope: viewScope } = await getChannelContext();
  // Every channel of the current organization — not every row RLS would hand
  // a platform admin, whose other tenants would otherwise fill these limits.
  const scope = orgWide(viewScope);
  const supabase = await createClient();

  let events: SystemEventRow[] = [];
  let videos: VideoRow[] = [];
  let snapshots: MetricsSnapshotRow[] = [];
  let queue: ContentQueueRow[] = [];

  if (supabase) {
    const [ev, vid, snap, q] = await Promise.all([
      scopeQuery(supabase.from("system_events").select("*"), scope).order("ts", { ascending: false }).limit(500),
      uploadedOnly(scopeQuery(supabase.from("videos").select("*"), scope)).order("published_at", { ascending: false }).limit(500),
      supabase.from("metrics_snapshots").select("*").order("snapshot_date", { ascending: false }).limit(500),
      scopeQuery(supabase.from("content_queue").select("*"), scope).limit(500),
    ]);
    events = (ev.data as SystemEventRow[]) ?? [];
    videos = (vid.data as VideoRow[]) ?? [];
    snapshots = (snap.data as MetricsSnapshotRow[]) ?? [];
    queue = (q.data as ContentQueueRow[]) ?? [];
  }

  const stats = channelStats(channels, videos, snapshots);

  // A customer organization connects its own channels here (migration 0022);
  // the operator's organization keeps the GitHub-secret path and sees no panel.
  const org = await getOrgContext();
  const customerOrg = Boolean(org.supported && org.current && !org.current.is_default);
  const [tokens, role] = customerOrg
    ? await Promise.all([fetchTokenStatuses(), resolveCurrentOrgRole()])
    : [null, null];

  // Instagram / TikTok belong to the organization, not to one channel
  // (migration 0028) — every organization, the operator's included.
  const orgId = org.supported && org.current ? org.current.id : null;
  const [social, orgRole] = await Promise.all([fetchSocialAccounts(orgId), role ?? resolveCurrentOrgRole()]);

  // Channel DNA (0056): each channel's look and voice, with the organization's
  // kits and characters (0047) to pick from. Read as the member (RLS); a
  // workspace without 0047 or 0056 says so instead of showing empty pickers.
  const [style, dnaChars] = await Promise.all([
    orgId ? loadStyleContext(orgId) : Promise.resolve(null),
    loadDnaCharacters(channels.map((c) => c.channel_id)),
  ]);
  const styleState = !style?.available ? "unavailable" : style.error ? "failed" : "ready";
  const kitChoices = (style?.kits ?? []).map((k) => ({ id: k.id, name: k.name }));
  const characterChoices = (style?.characters ?? []).map((c) => ({ id: c.id, name: c.name }));
  // Who may edit a channel is the database's question (0018); this only hides
  // the Edit button from someone it would refuse.
  const canEditDna = atLeast(orgRole, "editor");
  // The AI-content label settings that lower what is declared (never, own_clone) are the platform team's: the database
  // refuses everyone else (migration 0114), so only a platform administrator is offered them. An unknown reads as no.
  const canLowerAiLabel = await isPlatformAdmin();

  const thumbnails = Object.fromEntries(channels.map((c) => [c.channel_id, c.credential_ref?.youtube_thumbnail ?? null]));

  return (
    <div className="rhythm ns-open stagger-enter">
      <PageHeader
        icon="channels"
        title={t.channels.title}
        subtitle={t.channels.subtitle}
        actions={
          !notMigrated ? (
            <Link href={path("/channels/new")} className="btn-primary">
              + {t.channels.add}
            </Link>
          ) : undefined
        }
      />

      {ytResult && (
        <p className={ytResult === "connected" ? "g2-ok" : "g2-warn"} role="status">
          {t.channelTokens.results[ytResult]}
        </p>
      )}

      {notMigrated ? (
        <section className="ns-desk g2-desk">
          <EmptyState>{t.channels.notMigrated}</EmptyState>
        </section>
      ) : channels.length === 0 ? (
        <section className="ns-desk g2-desk">
          <EmptyState>{t.channels.empty}</EmptyState>
        </section>
      ) : (
        <section className="ns-desk g2-desk" aria-labelledby="channels-compare-title">
          <div className="g2-stack-lg">
            <h2 id="channels-compare-title" className="g2-h2">
              {t.channels.compare}
            </h2>
            <ChannelComparison stats={stats} thumbnails={thumbnails} />
          </div>
        </section>
      )}

      <SocialAccountsPanel
        accounts={social.rows}
        available={social.available}
        hasOrg={Boolean(orgId)}
        role={orgRole}
        configured={{ instagram: isSocialConfigured("instagram"), tiktok: isSocialConfigured("tiktok") }}
        result={socialResult}
      />

      {!notMigrated && channels.length > 0 && (
        <>
          <p className="g2-note">{t.channels.isolationNote}</p>

          <div className="g2-stack-lg">
            {channels.map((channel) => (
              <ChannelCard
                key={channel.channel_id}
                channel={channel}
                slug={channelSlug(channel, channels)}
                credential={credentials.find(
                  (c) => c.channel_id === channel.channel_id && c.provider === "youtube",
                )}
                health={channelHealth(
                  channel,
                  events,
                  credentials.find((c) => c.channel_id === channel.channel_id),
                )}
                queued={
                  queue.filter((q) => q.channel_id === channel.channel_id && q.status === "queued").length
                }
                videos={videos.filter((v) => v.channel_id === channel.channel_id).length}
                canControl={atLeast(orgRole, "admin")}
                canEdit={canEditDna}
                canLowerAiLabel={canLowerAiLabel}
                vault={
                  tokens && role
                    ? {
                        status: tokens.rows.find((r) => r.channel_id === channel.channel_id) ?? null,
                        available: tokens.available,
                        role,
                        oauthConfigured: isGoogleOAuthConfigured,
                        requiredScopes: YOUTUBE_OAUTH_SCOPES,
                      }
                    : undefined
                }
                dna={
                  <ChannelDnaSection
                    channelId={channel.channel_id}
                    dna={dnaFromChannel(channel, dnaChars.byChannel.get(channel.channel_id) ?? [])}
                    kits={kitChoices}
                    characters={characterChoices}
                    styleState={styleState}
                    available={dnaChars.available}
                    failed={dnaChars.failed}
                    canEdit={canEditDna}
                    standardVoice={channel.agent_config?.tts_provider === "edge"}
                    studioHref={path("/studio")}
                  />
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
