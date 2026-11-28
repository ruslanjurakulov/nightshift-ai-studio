"use client";

import { LoopClip } from "@/components/site/LoopClip";
import { SHOWCASE_ITEMS, showcaseCaptions, showcasePoster, showcaseVideo } from "@/lib/showcase/items";
import { templateMediaUrl, type MediaManifest } from "@/lib/templates/trends";
import mediaManifest from "@/lib/templates/media-manifest.json";

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
  const item = SHOWCASE_ITEMS.find((x) => x.slug === slug);
  const lang = item?.captions;
  const captions = lang ? { src: showcaseCaptions(slug), srcLang: lang, label: captionsLabel } : undefined;
  // Sound only where the item says its file has a track (checked against the file by tests/clip-sound.test.tsx), never assumed.
  return <LoopClip sources={{ mp4, smMp4: mp4 }} poster={showcasePoster(slug)} together captions={captions} audio={item?.audio === true} soundKey={`studio:${slug}`} />;
}

/**
 * A Trends template's preview on the landing (public/templates/<slug>/preview.mp4, made through our own Studio API with the
 * template's prompt and model). Only a file the manifest says ships can be named, so nothing outside our own previews is
 * reachable. A 480p H.264 file, so it is already the small rendition. Every LoopClip rule holds. No speaker toggle: the manifest
 * says nothing about sound, and a toggle is offered only where data says there is a track (CLAUDE.md #5).
 */
export function TemplateClip({ slug }: { slug: string }) {
  const mp4 = templateMediaUrl(mediaManifest as MediaManifest, slug, "preview");
  const poster = templateMediaUrl(mediaManifest as MediaManifest, slug, "poster");
  if (!mp4 || !poster) return null;
  return <LoopClip sources={{ mp4, smMp4: mp4 }} poster={poster} together />;
}
