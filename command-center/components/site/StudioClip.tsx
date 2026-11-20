"use client";

import { LoopClip } from "@/components/site/LoopClip";
import { showcasePoster, showcaseVideo } from "@/lib/showcase/items";

/**
 * A Studio piece's loop on the landing (lib/showcase/items.ts: made in our own Studio, served from public/showcase/). Its files
 * can only come from that list, so this cannot be handed stock footage. One MP4 at the size the model made it, so every
 * rendition LoopClip may choose is that file, and no WebM is listed. Every LoopClip rule holds: nothing under reduced motion,
 * Save-Data or a slow link (the poster stays), nothing fetched until it is near the screen, paused off screen and by the page's
 * pause switch.
 */
export function StudioClip({ slug }: { slug: string }) {
  const mp4 = showcaseVideo(slug);
  return <LoopClip sources={{ mp4, smMp4: mp4 }} poster={showcasePoster(slug)} together />;
}
