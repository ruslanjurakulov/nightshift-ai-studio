"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { STYLE_PRESETS, presetGradient } from "@/lib/stylePresets";
import { Chip } from "@/components/ui/Chip";
import { ContactSheet, Frame } from "@/components/ui/ContactSheet";
import { Section } from "@/components/g3/Section";

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
    <Section title={t.studio.presetsTitle} hint={t.studio.presetsHint} desk>
      {!channelId && <p className="m-0 text-base text-[var(--color-warn)]">{t.studio.pickChannelHint}</p>}
      <ContactSheet min={300} label={t.studio.presetsTitle}>
        {STYLE_PRESETS.map((p, i) => {
          const isApplied = applied === p.id;
          return (
            <Frame
              key={p.id}
              number={String(i + 1).padStart(2, "0")}
              edge={[`${t.studio.moodLabel}: ${p.mood}`]}
              aspect="16 / 9"
              selected={isApplied}
              body={
                <div className="flex h-full flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="m-0 text-base font-semibold text-[var(--color-fg)]">{p.name}</h3>
                    {isApplied && (
                      <Chip plain tone="lit" className="shrink-0">
                        {t.studio.currentBadge}
                      </Chip>
                    )}
                  </div>
                  <p className="m-0 text-sm leading-relaxed text-[var(--color-muted)]">{p.directive}</p>
                  <div className="mt-auto flex flex-col gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => apply(p.id)}
                      disabled={!channelId || busy !== null || isApplied}
                      className="btn-quiet w-full disabled:opacity-40"
                    >
                      {busy === p.id ? t.studio.applying : isApplied ? t.studio.applied : t.studio.applyBtn}
                    </button>
                    {failed === p.id && <p className="tnum m-0 text-sm text-[var(--color-fail)]">{t.studio.applyFailed}</p>}
                  </div>
                </div>
              }
            >
              <div className="size-full" style={{ background: presetGradient(p) }} aria-hidden />
            </Frame>
          );
        })}
      </ContactSheet>
    </Section>
  );
}
