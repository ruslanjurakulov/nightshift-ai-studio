"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import {
  PEAKS_PER_SECOND,
  barsFor,
  barsPath,
  peaksFor,
  type PeaksResult,
} from "@/lib/waveform";
import type { EditorAsset, SoundClip } from "@/lib/editor";

/** The most bars one clip draws: past this a bar is narrower than a pixel. */
const MAX_BARS = 240;

/**
 * The waveform of the part of a file a sound uses (its trim), drawn behind the
 * sound's label on the timeline. It is read in the browser from the file the
 * editor already plays; while it loads nothing is drawn, and when it cannot
 * be (a file too big for a tab, a format the browser cannot decode, a link
 * that was refused) the word for that is shown, never a flat line that would
 * read as silence.
 */
export function SoundWave({
  sound,
  asset,
}: {
  sound: Pick<SoundClip, "asset_id" | "in_s" | "out_s">;
  asset: EditorAsset | undefined;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const url = asset?.viewUrl ?? null;
  const known = asset?.durationS ?? null;
  const [result, setResult] = useState<PeaksResult | null>(null);

  useEffect(() => {
    let live = true;
    setResult(null);
    if (!url) return;
    void peaksFor(sound.asset_id, url, known).then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, [sound.asset_id, url, known]);

  const path = useMemo(() => {
    if (result?.status !== "ready") return "";
    const bars = Math.max(
      8,
      Math.min(
        MAX_BARS,
        Math.round((sound.out_s - sound.in_s) * PEAKS_PER_SECOND),
      ),
    );
    return barsPath(
      barsFor(result.peaks, result.durationS, sound.in_s, sound.out_s, bars),
    );
  }, [result, sound.in_s, sound.out_s]);

  if (!url) return null;
  if (result && result.status !== "ready")
    return (
      <span className="ml-1.5 text-xs opacity-70">
        {result.status === "too_large" ? te.waveTooLarge : te.waveUnavailable}
      </span>
    );
  if (!path) return null;
  const bars = path.split("M").length - 1;
  return (
    <svg
      aria-hidden
      data-testid="sound-wave"
      viewBox={`0 0 ${bars} 100`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 size-full text-[var(--color-primary)] opacity-45"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
