import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel } from "@/components/ui";
import { getDictionary } from "@/lib/i18n/server";
import { getChannelSelection } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { deriveAdvisory } from "@/lib/advisory";
import { STYLE_PRESETS, presetGradient } from "@/lib/stylePresets";
import type { SystemEventRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Studio Canvas — the channel's visual identity in one place: a gallery of
 * style presets (the same catalog the bot expands, modules/style_presets.py)
 * and the autopilot's latest auto-picked topic. Read-only: an operator sets a
 * channel's visual style to a preset id, and the whole visual pipeline follows.
 */
export default async function StudioPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const selection = await getChannelSelection();

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  if (supabase) {
    const { data } = await scopeQuery(
      supabase.from("system_events").select("*"),
      selection,
      { nullIsGlobal: true },
    )
      .order("ts", { ascending: false })
      .limit(500);
    events = (data as SystemEventRow[]) ?? [];
  }
  const agent = deriveAdvisory(events).agent;

  return (
    <div className="rhythm stagger-enter">
      <div>
        <h1 className="t-hero">{t.studio.title}</h1>
        <p className="t-lead mt-4">{t.studio.subtitle}</p>
      </div>

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

      {/* Style presets — the Studio Canvas gallery */}
      <div>
        <h2 className="t-section">{t.studio.presetsTitle}</h2>
        <p className="t-lead mt-2 mb-4 text-[13px]">{t.studio.presetsHint}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STYLE_PRESETS.map((p) => (
            <div
              key={p.id}
              className="panel overflow-hidden p-0 transition-transform duration-200 hover:-translate-y-0.5 hover:border-[var(--color-primary-dim)]"
            >
              <div
                className="h-24 w-full"
                style={{ background: presetGradient(p) }}
                aria-hidden
              />
              <div className="space-y-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--color-fg)]">{p.name}</span>
                  <span className="pill border border-[var(--color-border)] px-2 py-0.5 mono text-[10px] text-[var(--color-muted)]">
                    {t.studio.moodLabel}: {p.mood}
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">{p.directive}</p>
                <p className="mono text-[11px] text-[var(--color-muted)]">
                  {t.studio.applyHint} <span className="text-[var(--color-primary)]">{p.id}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
