import silkroad from "@/components/site/samples/silkroad.webp";
import library from "@/components/site/samples/library.webp";
import moon from "@/components/site/samples/moon.webp";
import nightmarket from "@/components/site/samples/nightmarket.webp";
import valley from "@/components/site/samples/valley.webp";
import lighthouse from "@/components/site/samples/lighthouse.webp";
import silkroadDusk from "@/components/site/samples/silkroad-dusk.webp";
import libraryTeal from "@/components/site/samples/library-teal.webp";
import valleyRose from "@/components/site/samples/valley-rose.webp";
import nightmarketCool from "@/components/site/samples/nightmarket-cool.webp";
import lighthouseWide from "@/components/site/samples/lighthouse-wide.webp";
import silkroadMp4 from "@/components/site/clips/silkroad.mp4";
import silkroadWebm from "@/components/site/clips/silkroad.webm";
import libraryMp4 from "@/components/site/clips/library.mp4";
import libraryWebm from "@/components/site/clips/library.webm";
import valleyMp4 from "@/components/site/clips/valley.mp4";
import valleyWebm from "@/components/site/clips/valley.webm";

/**
 * The example frames on the public pages: six AI-generated stills, made on
 * 2026-10-05 for demonstration (see docs/design/SITE_ENGAGE.md for their
 * provenance). They stand in where a finished result would be, and every place
 * that shows one says "Example" next to it; none is output of a real account,
 * a customer's work or a claim about what the product produces.
 *
 * Imported statically, so each is a hashed file served from this origin
 * (img-src 'self' already allows it) with its real width and height.
 */
export const SAMPLES = {
  silkroad,
  library,
  moon,
  nightmarket,
  valley,
  lighthouse,
  // Graded and cropped variants of the six (scripts/make-site-sample-variants.py), so no two pages share a look.
  "silkroad-dusk": silkroadDusk,
  "library-teal": libraryTeal,
  "valley-rose": valleyRose,
  "nightmarket-cool": nightmarketCool,
  "lighthouse-wide": lighthouseWide,
} as const;
export type SampleId = keyof typeof SAMPLES;

/** The six whole stills. A variant is described, in every language, as the still it comes from. */
export type BaseId = "silkroad" | "library" | "moon" | "nightmarket" | "valley" | "lighthouse";
export const SAMPLE_BASE: Record<SampleId, BaseId> = {
  silkroad: "silkroad",
  library: "library",
  moon: "moon",
  nightmarket: "nightmarket",
  valley: "valley",
  lighthouse: "lighthouse",
  "silkroad-dusk": "silkroad",
  "library-teal": "library",
  "valley-rose": "valley",
  "nightmarket-cool": "nightmarket",
  "lighthouse-wide": "lighthouse",
};

/**
 * The clips: slow camera moves (a push-in and a drift) over three of the stills, 8 seconds, seamless, no sound,
 * about 135 to 230 KB each in each of two formats (scripts/render-site-clips.sh). Frame 0 of every clip is its
 * still, which is also the poster. They are the stills, moved, and are labelled as such wherever they play.
 */
export const CLIPS = {
  silkroad: { mp4: silkroadMp4, webm: silkroadWebm },
  library: { mp4: libraryMp4, webm: libraryWebm },
  valley: { mp4: valleyMp4, webm: valleyWebm },
} as const;
export type ClipId = keyof typeof CLIPS;

/**
 * One example frame as an <img> that fills its aspect-ratio box (the box, not
 * the picture, decides the layout, so nothing shifts when it loads). Lazy by
 * default; the one on the first screen is eager (the hero card). `alt` is empty when
 * the surrounding picture is hidden from assistive tech and already described.
 */
export type SampleCrop = "a" | "b" | "c" | "d";

/**
 * `crop` frames the same still differently (a zoomed region, see .nx-art[data-crop] in site-next.css), so the page's
 * six frames do not read as the same picture repeated: the capability examples and the demo's thumbnail are crops,
 * the hero and the gallery are the whole frames.
 */
export function SampleImg({ id, alt = "", className, eager = false, crop, position }: { id: SampleId; alt?: string; className?: string; eager?: boolean; crop?: SampleCrop; position?: string }) {
  const s = SAMPLES[id];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={s.src} width={s.width} height={s.height} alt={alt} className={className} loading={eager ? "eager" : "lazy"} decoding="async" data-sample={id} data-crop={crop} style={position ? { objectPosition: position } : undefined} {...(eager ? { fetchPriority: "high" as const } : {})} />
  );
}

/**
 * THE MEDIA SLOTS: which still goes where. Every page asks for a slot by name (<SlotImg slot="hero" />), never for a
 * file, so swapping a picture, or putting a new one in a place, is one line here. At most one still per section, and a
 * page uses a different still in each slot (the landing's three showcases are three different frames).
 *
 * To add a still: put the WebP in ./samples/ (900 px wide, under 60 KB), import it above and add it to SAMPLES, give it
 * an alt in lib/i18n/site/{en,ru,uz}.ts (site.samples.alts), then point a slot at it. Nothing else changes.
 */
export const SLOTS = {
  /** The landing's first screen (the chat card). */
  hero: { id: "silkroad", clip: "silkroad" },
  /** The landing's three showcases. */
  "show.video": { id: "library", clip: "library" },
  "show.studio": { id: "valley", clip: "valley" },
  "show.approvals": { id: "moon" },
  /** The chat cards on /pricing and /mcp. */
  "pricing.card": { id: "nightmarket" },
  "mcp.card": { id: "lighthouse", position: "50% 22%" },
  /** The three ways in on /solutions (one still each, none repeated on the page). */
  "sol.channels": { id: "library-teal" },
  "sol.studio": { id: "valley-rose" },
  "sol.developers": { id: "lighthouse-wide" },
  /** The stage beside the sign-in and sign-up forms, and the band over them on a phone. */
  "auth.signin": { id: "nightmarket-cool" },
  "auth.signup": { id: "silkroad-dusk" },
} as const satisfies Record<string, { id: SampleId; crop?: SampleCrop; position?: string; clip?: ClipId }>;
export type SlotId = keyof typeof SLOTS;

/** A slot's still. `alt` is the description for where the picture stands alone; empty where it is decorative. */
export function SlotImg({ slot, alt = "", className, eager = false }: { slot: SlotId; alt?: string; className?: string; eager?: boolean }) {
  const s: { id: SampleId; crop?: SampleCrop; position?: string } = SLOTS[slot];
  return <SampleImg id={s.id} alt={alt} className={className} eager={eager} crop={s.crop} position={s.position} />;
}

/** The description of a slot's still, from the dictionary's six (a variant is described as the still it comes from). */
export function slotAlt(alts: Record<BaseId, string>, slot: SlotId): string {
  return alts[SAMPLE_BASE[SLOTS[slot].id]];
}

/** The clip a slot plays, if it has one. */
export function slotClip(slot: SlotId): ClipId | null {
  const s: { id: SampleId; clip?: ClipId } = SLOTS[slot];
  return s.clip ?? null;
}
