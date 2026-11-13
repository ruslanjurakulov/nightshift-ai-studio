"use client";

import { LoopClip } from "@/components/site/LoopClip";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";

/**
 * A model sample's loop, over its own first frame. A Client Component so the build copies the sample's video files to
 * /_next/static/media/ (see showcase-assets.ts); every rule of LoopClip holds (reduced motion, Save-Data, one clip at a time, the
 * page's pause switch). Nothing for a picture or an entry whose files are missing.
 */
export function ShowcaseClip({ jobId }: { jobId: string }) {
  const files = SHOWCASE_FILES[jobId];
  if (!files?.clip) return null;
  return <LoopClip sources={files.clip} poster={files.posterSm} compact />;
}
