"use client";

import { LoopClip } from "@/components/site/LoopClip";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";

/**
 * A model sample's loop, over its own first frame. A Client Component so the build copies the sample's video files to
 * /_next/static/media/ (see showcase-assets.ts); every rule of LoopClip holds (reduced motion, Save-Data, one clip at a time, the
 * page's pause switch). Nothing for a picture or an entry whose files are missing.
 *
 * `compact` defaults to true (a gallery card is never wide); a slot that fills a wide box (the landing's first screen) passes
 * false and gets the 1280 file on a wide screen. `early` is the first screen's clip, started after load and idle.
 */
export function ShowcaseClip({
  jobId,
  compact = true,
  early = false,
  position,
  together = false,
}: {
  jobId: string;
  compact?: boolean;
  early?: boolean;
  position?: string;
  together?: boolean;
}) {
  const files = SHOWCASE_FILES[jobId];
  if (!files?.clip) return null;
  // A sample whose model made a larger clip offers it to a wide screen (lib/site/renditions.ts); the 1280 file is the fallback.
  // Only a file that is really wider than the 1280 one counts as larger.
  const sources = files.lg?.clip && files.lg.width > 1280 ? { ...files.clip, lg: files.lg.clip } : files.clip;
  return <LoopClip sources={sources} poster={files.posterSm} compact={compact} early={early} position={position} together={together} />;
}
