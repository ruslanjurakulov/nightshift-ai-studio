import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel } from "@/components/ui";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelContext } from "@/lib/channels-server";
import { isScoped, scopeQuery } from "@/lib/channels";
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
 */
export default async function StudioPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { selection, channels, scope } = await getChannelContext();

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  if (supabase) {
    const { data } = await scopeQuery(
      supabase.from("system_events").select("*"),
      scope,
      { nullIsGlobal: true },
    )
      .order("ts", { ascending: false })
      .limit(500);
    events = (data as SystemEventRow[]) ?? [];
  }
  const agent = deriveAdvisory(events).agent;

  // Applying a preset needs exactly one channel to write to. When a single
  // channel is in view, find its row; "All channels" leaves this null and the
  // gallery disables its buttons rather than writing to a channel it can't name.
  const scopedChannel = isScoped(selection)
    ? channels.find((c) => c.channel_id === selection)
    : undefined;
  const agentConfig = (scopedChannel?.agent_config ?? {}) as Record<string, unknown>;
  const currentStyle =
    typeof agentConfig.visual_style_prompt === "string" ? agentConfig.visual_style_prompt : "";

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="studio" title={t.studio.title} subtitle={t.studio.subtitle} />

      {/* Autopilot — the day's auto-picked topic (Track 3 Autopilot Lite) */}
      <Panel title={t.studio.autopilotTitle}>
        <div className="p-4">
          {agent && agent.topic ? (
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
    </div>
  );
}
