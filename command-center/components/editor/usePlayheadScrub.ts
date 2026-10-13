"use client";

import { useRef, type ChangeEvent, type PointerEvent } from "react";
import type { EditorModel } from "@/lib/editor";
import { snapPlayhead } from "@/lib/editor-timeline-view";
import type { TimelineView } from "./useTimelineView";

/**
 * Props for the playhead slider: a drag with a pointer snaps to the edges of
 * clips, texts and sounds (when snapping is on); a key press steps frame by
 * frame and is never snapped, so the playhead cannot stick to an edge.
 */
export function usePlayheadScrub({
  clips,
  model,
  view,
  setPlayhead,
  setPlaying,
}: {
  clips: EditorModel["clips"];
  model: Pick<EditorModel, "texts" | "sounds">;
  view: TimelineView;
  setPlayhead: (t: number) => void;
  setPlaying: (on: boolean) => void;
}) {
  const pointer = useRef<"mouse" | "touch" | null>(null);
  const end = () => {
    pointer.current = null;
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLInputElement>) => {
      pointer.current = e.pointerType === "touch" ? "touch" : "mouse";
    },
    onPointerUp: end,
    onPointerCancel: end,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setPlaying(false);
      const raw = Number(e.target.value);
      const max = Number(e.target.max);
      // Pixels per second of the slider itself: that is what the finger moves.
      const w = e.target.getBoundingClientRect().width;
      setPlayhead(
        pointer.current && max > 0 && w > 0
          ? snapPlayhead(raw, { clips, texts: model.texts, sounds: model.sounds }, w / max, view.snap, pointer.current === "touch")
          : raw,
      );
    },
  };
}
