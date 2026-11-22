import { preload } from "react-dom";
import type { Dictionary } from "@/lib/i18n";
import { posterSrcSet } from "@/lib/site/renditions";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { MotionToggle } from "@/components/site/MotionToggle";
import { HERO_JOB, reelItem } from "@/components/landing/home/home-reel";
import { IdeaBox } from "@/components/landing/home/IdeaBox";
import "@/components/landing/home/home.css";

/** The hero picture's widths, as the browser should choose them: the whole screen. */
const HERO_SIZES = "100vw";

/**
 * The first screen of "/": one of our own Studio's clips edge to edge (orbit, the night city, the steaming street stall), one
 * headline, one sentence and the idea box. Its own file because two pages draw it: the owner kept this first screen when "/" went
 * back to the pre-20-November Landing (2026-11-22), so Landing and HomePage both start with it and it can never drift between them.
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
        <div className="hm-hero-media" data-clip="sample" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.f.posterSm}
            srcSet={posterSrcSet(item.f)}
            sizes={HERO_SIZES}
            width={item.e.width}
            height={item.e.height}
            alt=""
            className="hm-hero-still"
            fetchPriority="high"
          />
          <ShowcaseClip jobId={item.e.jobId} compact={false} early />
        </div>
      )}
      <div className="hm-hero-veil" aria-hidden="true" />
      <div className="hm-wrap hm-hero-body">
        <p className="hm-eyebrow">{h.eyebrow}</p>
        <h1 id="hm-hero-title" className="ds-display hm-hero-title">
          {h.title}
        </h1>
        <p className="hm-hero-lead">{h.lead}</p>
        <IdeaBox copy={h.idea} />
        <a href="#how" className="hm-idea-more">
          {h.secondary}
        </a>
      </div>
      {item && (
        <p className="hm-hero-credit">
          <span className="hm-badge">{h.ai}</span> {h.reelLabel}
        </p>
      )}
      <MotionToggle pause={t.site.fx.pause} />
    </section>
  );
}
