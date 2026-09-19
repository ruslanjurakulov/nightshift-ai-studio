"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { STYLE_PRESETS, presetGradient } from "@/lib/stylePresets";

/**
 * The Studio Canvas preset gallery, now clickable.
 *
 * Each card carries an "Apply to channel" button. Applying writes the preset's
 * id into the selected channel's `agent_config.visual_style_prompt` — the exact
 * field main.py reads as the channel's base visual style (it expands a preset id
 * to its directive, so Director Mode and b-roll search adopt the look). The
 * existing agent_config is spread back so nothing else in the blob is lost.
 *
 * Two deliberate limits:
 *
 * 1. It writes configuration only. Nothing here renders a frame, spends a token
 *    or publishes — it sets the look the next run will aim for.
 * 2. It needs one channel. With "All channels" selected there is no single
 *    target, so the buttons are disabled and the card says to pick a channel.
 *    A write with no channel would silently miss, which is worse than a button
 *    that plainly cannot be pressed yet.
 */
export function PresetGallery({
  channelId,
  currentStyle,
  agentConfig,
}: {
  /** The scoped channel's id, or null when "All channels" is selected. */
  channelId: string | null;
  /** The channel's current visual_style_prompt, to mark the applied preset. */
  currentStyle: string;
  /** The channel's full agent_config, spread back on write so nothing is lost. */
  agentConfig: Record<string, unknown>;
}) {
  const { t } = useI18n();
  // Optimistic view of which preset is applied. Seeded from the server value so
  // the "Current" badge is right on first paint, updated on a successful write.
  const [applied, setApplied] = useState<string>(currentStyle.trim());
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function apply(presetId: string) {
    if (!channelId || busy) return;
    const supabase = createClient();
    if (!supabase) return;
    setBusy(presetId);
    setFailed(null);
    const { error } = await supabase
      .from("channels")
      .update({
        agent_config: { ...agentConfig, visual_style_prompt: presetId },
        updated_at: new Date().toISOString(),
      })
      .eq("channel_id", channelId);
    setBusy(null);
    if (error) {
      setFailed(presetId);
      return;
    }
    setApplied(presetId);
  }

  return (
    <div>
      <h2 className="t-section">{t.studio.presetsTitle}</h2>
      <p className="t-lead mt-2 mb-4 text-[13px]">{t.studio.presetsHint}</p>
      {!channelId && (
        <p className="mb-4 text-[13px] text-[var(--color-warn)]">{t.studio.pickChannelHint}</p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {STYLE_PRESETS.map((p) => {
          const isApplied = applied === p.id;
          return (
            <div
              key={p.id}
              className="panel overflow-hidden p-0 transition-transform duration-200 hover:-translate-y-0.5 hover:border-[var(--color-primary-dim)]"
              style={isApplied ? { borderColor: "var(--color-primary)" } : undefined}
            >
              <div className="h-24 w-full" style={{ background: presetGradient(p) }} aria-hidden />
              <div className="space-y-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--color-fg)]">{p.name}</span>
                  {isApplied ? (
                    <span className="pill border border-[var(--color-primary)] px-2 py-0.5 mono text-[10px] text-[var(--color-primary)]">
                      {t.studio.currentBadge}
                    </span>
                  ) : (
                    <span className="pill border border-[var(--color-border)] px-2 py-0.5 mono text-[10px] text-[var(--color-muted)]">
                      {t.studio.moodLabel}: {p.mood}
                    </span>
                  )}
                </div>
                <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">{p.directive}</p>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="mono text-[11px] text-[var(--color-muted)]">
                    {t.studio.applyHint} <span className="text-[var(--color-primary)]">{p.id}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => apply(p.id)}
                    disabled={!channelId || busy !== null || isApplied}
                    className="btn-sky pill shrink-0 px-3 py-1.5 text-[12px] disabled:opacity-40"
                  >
                    {busy === p.id
                      ? t.studio.applying
                      : isApplied
                        ? t.studio.applied
                        : t.studio.applyBtn}
                  </button>
                </div>
                {failed === p.id && (
                  <p className="mono text-[11px] text-[var(--color-fail)]">{t.studio.applyFailed}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
