"use client";

import { LoopClip } from "@/components/site/LoopClip";
import { SHOWCASE_ITEMS, showcaseCaptions, showcasePoster, showcaseVideo } from "@/lib/showcase/items";

/**
 * A Studio piece's loop on the landing (lib/showcase/items.ts: made in our own Studio, served from public/showcase/). Its files
 * can only come from that list, so this cannot be handed stock footage. One MP4 at the size the model made it, so every
 * rendition LoopClip may choose is that file, and no WebM is listed. Every LoopClip rule holds: nothing under reduced motion,
 * Save-Data or a slow link (the poster stays), nothing fetched until it is near the screen, paused off screen and by the page's
 * pause switch. A piece with spoken words carries them as a captions track (public/showcase/<slug>.vtt), shown by default because
 * the clip plays muted; `captionsLabel` is the track's name in the visitor's language.
 */
export function StudioClip({ slug, captionsLabel }: { slug: string; captionsLabel: string }) {
  const mp4 = showcaseVideo(slug);
  const lang = SHOWCASE_ITEMS.find((x) => x.slug === slug)?.captions;
  const captions = lang ? { src: showcaseCaptions(slug), srcLang: lang, label: captionsLabel } : undefined;
  return <LoopClip sources={{ mp4, smMp4: mp4 }} poster={showcasePoster(slug)} together captions={captions} />;
}
