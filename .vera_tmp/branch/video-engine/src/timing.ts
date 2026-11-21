import type { IRScene } from "./types";

/** Scene length in seconds, or null when either time is unknown or the span is
 * not positive. Unknown is never coerced to 0. */
export const sceneDurationSeconds = (scene: IRScene): number | null => {
  const { start_s, end_s } = scene;
  if (typeof start_s !== "number" || typeof end_s !== "number") return null;
  if (!Number.isFinite(start_s) || !Number.isFinite(end_s)) return null;
  const d = end_s - start_s;
  return d > 0 ? d : null;
};

/** Frames for a scene at `fps`; at least one frame. Throws on unknown timing so
 * a render fails loudly instead of producing a guessed length. */
export const sceneDurationInFrames = (scene: IRScene, fps: number): number => {
  const d = sceneDurationSeconds(scene);
  if (d === null) {
    throw new Error(
      `Scene ${scene.id}: start_s/end_s are unknown or not increasing; the audio clock must set them before rendering.`,
    );
  }
  return Math.max(1, Math.round(d * fps));
};
