import { preload } from "react-dom";
import type { Dictionary } from "@/lib/i18n";
import { posterSrcSet } from "@/lib/site/renditions";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { MotionToggle } from "@/components/site/MotionToggle";
import { SoundToggle } from "@/components/site/SoundToggle";
import { HERO_JOB, reelItem } from "@/components/landing/home/home-reel";
import { IdeaBox } from "@/components/landing/home/IdeaBox";
import { AiMark } from "@/components/site/AiMark";
import "@/components/landing/home/home.css";

/** The hero picture's widths, as the browser should choose them: the whole screen. */
const HERO_SIZES = "100vw";

/**
 * The first screen of "/": one of our own Studio's clips edge to edge (orbit, the night city, the steaming street stall), and over it,
 * centred, one headline, one line and the idea box as a single glass bar with its note under it (the owner's "in this style", after
 * kling.ai's hero, 2026-11-22). Nothing else: the page's nav already leads to "How it works", and the eyebrow said the brand the
 * header says. Its own file because two pages draw it: the owner kept this first screen when "/" went back to the pre-20-November
 * Landing (2026-11-22), so Landing and HomePage both start with it and it can never drift between them.
 *
 * Performance (LCP < 2.5 s on mobile 4G, no layout shift): the largest thing is the STILL, preloaded with a phone-sized candidate in
 * its srcset; the clip is fetched only after load and idle, and never under reduced motion, Save-Data or a slow link
 * (components/site/LoopClip.tsx). The box has its height before anything loads (home.css .hm-hero).
 */
export function HomeHero({ t }: { t: Dictionary }) {
  const h = t.landingHome.hero;
  const item = reelItem(HERO_JOB);
  if (item) preload(item.f.posterSm, { as: "image", imageSrcSet: posterSrcSet(item.f), imageSizes: HERO_SIZES, fetchPriority: "high" });
  return (
    // Dark whatever the page's theme: the words sit on a moving picture, and the picture is night.
    <section aria-labelledby="hm-hero-title" className="hm-hero" data-theme-scope="dark">
      {item && (
        // The page's mark for "one of our samples, in its own box", as every other sample place carries it: the landing's
        // no-clip-twice check (tests/site-landing-dedupe.test.tsx) sees the first screen too, and a model tile whose only sample on
        // the page is this one lands here (#sample-<job>, as on a slot's box).
        <div id={`sample-${item.e.jobId}`} className="hm-hero-media" data-clip="sample" data-showcase-entry={item.e.jobId} aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            data-sample-job={item.e.jobId}
            src={item.f.posterSm}
            srcSet={posterSrcSet(item.f)}
            sizes={HERO_SIZES}
            width={item.e.width}
            height={item.e.height}
            alt=""
            className="hm-hero-still"
            fetchPriority="high"
          />
          <ShowcaseClip jobId={item.e.jobId} compact={false} early soundToggle={false} />
        </div>
      )}
      <div className="hm-hero-veil" aria-hidden="true" />
      <div className="hm-wrap hm-hero-body">
        <h1 id="hm-hero-title" className="ds-display hm-hero-title">
          {h.title}
        </h1>
        <p className="hm-hero-sub">{h.subline}</p>
        <IdeaBox copy={h.idea} thumb={item?.f.posterSm} mirror={item ? `sample-${item.e.jobId}` : undefined} />
      </div>
      {item && (
        // Just "AI" for the eye (the owner, 2026-11-22); a screen reader hears what it means and where it was made (AiMark).
        <p className="hm-hero-credit">
          <span className="hm-badge">
            <AiMark short={t.site.gallery.badge} name={h.aiCredit} />
          </span>
        </p>
      )}
      {/* Outside the aria-hidden picture, so a screen reader and a pointer reach it; nothing until the hero's clip has sound and plays. */}
      {item && <SoundToggle clip={item.e.jobId} className="hm-hero-sound" />}
      <MotionToggle pause={t.site.fx.pause} />
    </section>
  );
}
