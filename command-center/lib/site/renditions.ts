import type { ShowcaseFiles } from "@/lib/site/showcase";

/**
 * Which file of a sample a screen gets. Today every sample has two (640 and 1280 wide); a sample whose model really made a
 * larger picture can carry a third (`lg`, with its true width), and only then is it offered. Nothing here makes a file larger
 * than it was made: a missing `lg` is simply not in the list, and the 1280 file stays the fallback everywhere.
 */

/** The still's `srcset`: the 640 and 1280 files, and the large one at its own width when the sample has one wider than 1280. */
export function posterSrcSet(f: Pick<ShowcaseFiles, "poster" | "posterSm" | "lg">): string {
  const set = `${f.posterSm} 640w, ${f.poster} 1280w`;
  return f.lg && f.lg.width > 1280 ? `${set}, ${f.lg.poster} ${f.lg.width}w` : set;
}

/** The device pixels a screen must have across before a clip's large file is worth its bytes (1280 plus a quarter). */
export const LARGE_CLIP_FROM = 1600;

/**
 * Which clip file plays: the 640 one for a phone or a small frame, the large one only for a wide frame on a screen with the
 * pixels to show it (CSS width x device pixel ratio) and a fast link, the 1280 one otherwise. Chosen once, when the clip mounts.
 */
export function clipRendition(o: { small: boolean; hasLarge: boolean; devicePixels: number; fast: boolean }): "sm" | "md" | "lg" {
  if (o.small) return "sm";
  return o.hasLarge && o.fast && o.devicePixels >= LARGE_CLIP_FROM ? "lg" : "md";
}
