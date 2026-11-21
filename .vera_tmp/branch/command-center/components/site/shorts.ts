import type { ShowcaseEntry, ShowcaseFiles } from "@/lib/site/showcase";
import { modelLeftOut } from "@/lib/site/showcase";
import { tryHref } from "@/lib/site/showcase-link";
import type { ClipSources } from "@/components/site/LoopClip";

/**
 * Whether the site's sample clips carry sound. They do not: tools/export_showcase.py encodes every rendition with `-an`, so the
 * files on this site have no audio track at all. The feed's sound key reads "This clip has no sound" and is disabled for such a
 * clip, rather than offering an "unmute" that would turn on nothing. The day the exporter keeps audio, this becomes per clip.
 */
export const SITE_CLIPS_HAVE_SOUND = false;

/** A 9:16 clip is 1.78 tall to 1 wide; 1.6 keeps the 1280 x 2240 and 1280 x 2276 renditions and leaves 4:5 (1.25) out. */
const VERTICAL = 1.6;

/** One clip of the phone's Shorts feed: everything the Client Component needs, as plain data. */
export type ShortsItem = {
  jobId: string;
  modelName: string;
  prompt: string;
  poster: string;
  posterSm: string;
  sources: ClipSources;
  width: number;
  height: number;
  /** "Use this prompt" (lib/site/showcase-link.ts tryHref): a link that fills the Studio form, nothing more. */
  href: string | null;
  /** The model is not on sale (operator preview or shut down): the button says "Use", not "Try" this model. */
  leftOut: boolean;
  sound: boolean;
};

/** The samples the feed shows: the vertical clips among the gallery's, in its order. */
export function shortsItems(items: readonly { e: ShowcaseEntry; f: ShowcaseFiles }[], signedIn: boolean, now: Date): ShortsItem[] {
  return items.flatMap(({ e, f }) =>
    e.kind === "video" && f.clip && e.height >= e.width * VERTICAL
      ? [
          {
            jobId: e.jobId,
            modelName: e.modelName,
            prompt: e.prompt,
            poster: f.poster,
            posterSm: f.posterSm,
            sources: f.clip,
            width: e.width,
            height: e.height,
            href: tryHref(e, signedIn, now),
            leftOut: modelLeftOut(e, now) !== null,
            sound: SITE_CLIPS_HAVE_SOUND,
          },
        ]
      : [],
  );
}
