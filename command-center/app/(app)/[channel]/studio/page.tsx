import { createClient } from "@/lib/supabase/server";
import { ErrorState } from "@/components/ReadError";
import { readFailed } from "@/lib/readState";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel } from "@/components/ui";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelContext } from "@/lib/channels-server";
import { channelPath, isScoped, scopeQuery } from "@/lib/channels";
import { getOrgContext } from "@/lib/orgs-server";
import { loadStyleContext } from "@/lib/server/style-kits";
import { StyleSections } from "@/components/studio/StyleSections";
import { deriveAdvisory } from "@/lib/advisory";
import { PresetGallery } from "@/components/studio/PresetGallery";
import type { SystemEventRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Studio Canvas — the channel's visual identity in one place: a gallery of
 * style presets (the same catalog the bot expands, modules/style_presets.py)
 * and the autopilot's latest auto-picked topic. Applying a preset writes it to
 * the scoped channel; the pipeline reads that as the channel's base visual style
 * (main.py, effective_visual_style channel default), so the whole look follows.
 *
 * Below them, the organization's style kits and characters (migration 0047):
 * looks and recurring subjects built from its own media library. They are
 * configuration only — nothing reads them during a run yet.
 */
export default async function StudioPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { selection, channels, scope, slug } = await getChannelContext();
  const org = await getOrgContext();

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  let failed = false;
  if (supabase) {
    const res = await scopeQuery(
      supabase.from("system_events").select("*"),
      scope,
      { nullIsGlobal: true },
    )
      .order("ts", { ascending: false })
      .limit(500);
    failed = readFailed(res);
    events = (res.data as SystemEventRow[]) ?? [];
  }
  const agent = deriveAdvisory(events).agent;
  // Read as the member (RLS): before 0047 is applied this is "not enabled",
  // and a failed read says so — never an empty grid that reads as "none yet".
  const style = org.current ? await loadStyleContext(org.current.id, { urls: true }) : null;

  // Applying a preset needs exactly one channel to write to. When a single
  // channel is in view, find its row; "All channels" leaves this null and the
  // gallery disables its buttons rather than writing to a channel it can't name.
  const scopedChannel = isScoped(selection)
    ? channels.find((c) => c.channel_id === selection)
    : undefined;
  const agentConfig = (scopedChannel?.agent_config ?? {}) as Record<string, unknown>;
  const currentStyle =
    typeof agentConfig.visual_style_prompt === "string" ? agentConfig.visual_style_prompt : "";
  const channelKitId =
    typeof scopedChannel?.default_style_kit_id === "string" ? scopedChannel.default_style_kit_id : null;
  const styleNote = !org.current
    ? t.styleKits.noOrg
    : !style?.available
      ? t.styleKits.notEnabled
      : style.error
        ? t.styleKits.readFailed
        : null;

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="studio" title={t.studio.title} subtitle={t.studio.subtitle} />

      {/* Autopilot — the day's auto-picked topic (Track 3 Autopilot Lite) */}
      <Panel title={t.studio.autopilotTitle}>
        <div className="p-4">
          {failed ? (
            <ErrorState compact />
          ) : agent && agent.topic ? (
            <div className="space-y-1.5">
              <p className="text-[13px] text-[var(--color-muted)]">{t.studio.autopilotOnTopic}</p>
              <p className="text-base font-semibold text-[var(--color-fg)]">{agent.topic}</p>
              {agent.rationale && (
                <p className="text-[13px] text-[var(--color-muted)]">{agent.rationale}</p>
              )}
              <p className="mono text-[11px] text-[var(--color-muted)]">
                {(agent.videoProvider || t.common.dash) + " · " + (agent.voiceProvider || t.common.dash)}
              </p>
            </div>
          ) : (
            <p className="text-[13px] text-[var(--color-muted)]">{t.studio.autopilotNone}</p>
          )}
        </div>
      </Panel>

      {/* Style presets — the Studio Canvas gallery, applied to the scoped channel */}
      <PresetGallery
        channelId={scopedChannel?.channel_id ?? null}
        currentStyle={currentStyle}
        agentConfig={agentConfig}
      />

      {/* Style kits and characters — built from the organization's library (0047) */}
      {styleNote || !org.current || !style ? (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{styleNote}</div>
      ) : (
        <StyleSections
          orgId={org.current.id}
          initialKits={style.kits}
          initialCharacters={style.characters}
          channelId={scopedChannel?.channel_id ?? null}
          channelKitId={channelKitId}
          libraryHref={channelPath(slug, "/library")}
        />
      )}
    </div>
  );
}
