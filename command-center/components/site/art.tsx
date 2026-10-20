import heroNight from "@/components/site/art/hero-night.webp";
import step1 from "@/components/site/art/step-1.webp";
import step2 from "@/components/site/art/step-2.webp";
import step3 from "@/components/site/art/step-3.webp";
import toolImage from "@/components/site/art/tool-image.webp";
import toolVideo from "@/components/site/art/tool-video.webp";
import toolVoice from "@/components/site/art/tool-voice.webp";
import toolEdit from "@/components/site/art/tool-edit.webp";
import toolAnimate from "@/components/site/art/tool-animate.webp";
import toolUpscale from "@/components/site/art/tool-upscale.webp";
import toolCutout from "@/components/site/art/tool-cutout.webp";
import toolStyles from "@/components/site/art/tool-styles.webp";
import thumbSilkroad from "@/components/site/art/thumb-silkroad.webp";
import { ART_SIZE, type ArtId } from "@/lib/site/art";

/**
 * The AI-generated illustrations (lib/site/art.ts says which stands where and what they are). Imported statically, like the stock
 * stills in samples.tsx: each is a hashed file served from this origin (img-src 'self' already allows it) with its real width and
 * height, so the box is reserved before the file arrives. One file each, drawn at most 360 px wide (the steps, the tool tiles and
 * the sample thumbnail), so no srcset: the 800 px file is already twice what the biggest box needs.
 */
type Img = { src: string } | string;
/** Next hands an imported image over as { src, width, height }; a plain bundler (the test runner's) as the URL. */
const urlOf = (m: Img) => (typeof m === "string" ? m : m.src);
const ART: Record<ArtId, Img> = {
  "step-1": step1,
  "step-2": step2,
  "step-3": step3,
  "tool-image": toolImage,
  "tool-video": toolVideo,
  "tool-voice": toolVoice,
  "tool-edit": toolEdit,
  "tool-animate": toolAnimate,
  "tool-upscale": toolUpscale,
  "tool-cutout": toolCutout,
  "tool-styles": toolStyles,
  "thumb-silkroad": thumbSilkroad,
};

/** One illustration as an image element with its own width and height (CSS sizes it; the attributes reserve the aspect ratio). Lazy: none of them is on the first screen. */
export function ArtImg({ id, alt, className }: { id: ArtId; alt: string; className?: string }) {
  const { width, height } = ART_SIZE[id];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={urlOf(ART[id])} width={width} height={height} alt={alt} className={className} loading="lazy" decoding="async" data-art-id={id} />
  );
}

/** A 1 x 1 transparent GIF: what the hero's img holds where the backdrop is not wanted (see HeroBackdrop). */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * The desktop hero's backdrop: a dark studio at night whose left 40% is empty, behind the headline. Decorative (an empty alt: assistive tech skips it); the page's words never depend on it, they sit on a dark base and, where the picture
 * is bright, on a scrim of their own (site-next.css, "The hero's backdrop").
 *
 * It is wanted from 1024 px up only: below that the hero is the phone panel with its own footage. The <source> is the whole trick:
 * an image that is merely `display: none` is still fetched, and this one is 94 KB, so under 1024 px the browser takes the blank
 * GIF and never asks for the picture. Eager and high priority above that (it is the largest paint on a wide first screen).
 */
export function HeroBackdrop() {
  return (
    <picture className="nx-hero-bg">
      <source media="(min-width: 1024px)" srcSet={urlOf(heroNight)} type="image/webp" />
      <img src={BLANK} width={ART_SIZE["hero-night"].width} height={ART_SIZE["hero-night"].height} alt="" loading="eager" decoding="async" fetchPriority="high" data-art-id="hero-night" />
    </picture>
  );
}
