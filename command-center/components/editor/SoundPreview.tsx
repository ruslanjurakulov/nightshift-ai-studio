"use client";

import { useEffect, useRef } from "react";
import {
  duckGainAt,
  soundLength,
  type EditorAsset,
  type SoundClip,
} from "@/lib/editor";

/** dB → the 0..1 an <audio> element takes (it cannot go louder than 1).
 *  `duckGain` (linear, 0..1) is the ducking envelope's value at this moment. */
export function previewVolume(gainDb: number, duckGain = 1): number {
  return Math.min(1, Math.max(0, 10 ** (gainDb / 20) * duckGain));
}

const NO_SPEECH: readonly (readonly [number, number])[] = [];

/**
 * Plays the music and sound clips in the preview, following the playhead:
 * each sound is a hidden <audio> of its library file, started at the right
 * point of the file while the playhead is inside it and paused outside. The
 * preview is approximate (a browser cannot play louder than the file, and
 * fades are heard in the export); the export is the ffmpeg render.
 */
export function SoundPreview({
  sounds,
  assets,
  playhead,
  playing,
  speech = NO_SPEECH,
}: {
  sounds: readonly SoundClip[];
  assets: Record<string, EditorAsset>;
  playhead: number;
  playing: boolean;
  /** Where speech plays (editor.ts speechSpans): what a ducked sound is lowered under. */
  speech?: readonly (readonly [number, number])[];
}) {
  const refs = useRef(new Map<string, HTMLAudioElement>());

  useEffect(() => {
    for (const x of sounds) {
      const el = refs.current.get(x.id);
      if (!el) continue;
      const into = playhead - x.start_s;
      const inside = into >= 0 && into < soundLength(x);
      if (!playing || !inside) {
        if (!el.paused) el.pause?.();
        continue;
      }
      el.volume = previewVolume(
        x.gain_db,
        x.duck ? duckGainAt(x.duck, speech, playhead) : 1,
      );
      const want = x.in_s + into;
      // Seek only when it drifted: re-seeking every frame would stutter.
      if (el.paused || Math.abs((el.currentTime || 0) - want) > 0.3) {
        try {
          el.currentTime = want;
        } catch {
          /* not loaded yet */
        }
      }
      if (el.paused) void el.play?.()?.catch?.(() => {});
    }
  }, [sounds, playhead, playing, speech]);

  return (
    <div hidden>
      {sounds.map((x) => {
        const src = assets[x.asset_id]?.viewUrl;
        return src ? (
          <audio
            key={x.id}
            preload="auto"
            src={src}
            ref={(el) => {
              if (el) refs.current.set(x.id, el);
              else refs.current.delete(x.id);
            }}
          />
        ) : null;
      })}
    </div>
  );
}
