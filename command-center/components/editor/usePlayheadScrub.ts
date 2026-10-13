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
  // One stable function, so the window listeners added on press are the ones removed on release.
  const end = useRef(function endDrag() {
    pointer.current = null;
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
  }).current;
  return {
    onPointerDown: (e: PointerEvent<HTMLInputElement>) => {
      pointer.current = e.pointerType === "touch" ? "touch" : "mouse";
      // The release can land outside the slider, or be lost; the window hears it either way.
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onBlur: end,
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
