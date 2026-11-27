"use client";

import { useContext, type MouseEvent, type PointerEvent } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { I18nContext } from "@/lib/i18n/public-context";
import { setSoundOn, useSoundOn, useSoundVideo } from "@/lib/site/sound";

/**
 * The speaker toggle on a clip with sound (owner decision 2026-11-22: every video on the site has sound). Every clip autoplays
 * muted, as browsers require; this turns THIS clip's sound on and every other clip's off (lib/site/sound.ts).
 *
 * It renders nothing unless a clip with an audio track is registered under `clip` (LoopClip registers one only when its files
 * carry a track, and only while its video is in the page), so a silent clip, or one shown as its still under reduced motion,
 * Save-Data or a slow link, never offers sound (CLAUDE.md #5). Nor without a dictionary: an unnamed button is worse than none.
 *
 * LoopClip renders it inside the clip's box. A place whose clip sits under other content (the landing's first screen) renders the
 * clip with `soundToggle={false}` and puts `<SoundToggle clip={jobId} />` where a pointer and a screen reader can reach it.
 *
 * It is a positioned sibling over the clip (z-index 5, above a card's stretched link overlay), never meant to sit inside an <a>.
 * Its click and pointerdown never reach a card's link or the page's tap-to-pause (lib/site/motion.ts motionTap, which also skips
 * `data-tap-ignore`): default prevented, propagation stopped. A toggle button: one name, `aria-pressed` says whether the sound is on.
 */
export function SoundToggle({ clip, className }: { clip: string; className?: string }) {
  const ctx = useContext(I18nContext);
  const video = useSoundVideo(clip);
  const on = useSoundOn(video);
  if (!video || !ctx) return null;
  // Whether or not the clip ends up inside a card's link (or under a stretched one), the press is the toggle's alone: no
  // navigation, no card handler, no tap-to-pause; pointerdown too, so a card that acts on press-start never sees it.
  const keep = (e: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const click = (e: MouseEvent<HTMLButtonElement>) => {
    keep(e);
    setSoundOn(video, !on);
  };
  const Icon = on ? Volume2 : VolumeX;
  return (
    <button type="button" className={className ? `nx-clip-sound ${className}` : "nx-clip-sound"} aria-pressed={on} aria-label={ctx.t.site.samples.sound} onClick={click} onPointerDown={keep} data-sound-for={clip} data-tap-ignore="">
      <Icon aria-hidden="true" focusable="false" size={20} strokeWidth={2} />
    </button>
  );
}
