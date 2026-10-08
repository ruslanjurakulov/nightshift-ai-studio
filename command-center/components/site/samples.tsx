import caravan from "@/components/site/media/caravan.webp";
import caravanSm from "@/components/site/media/caravan-sm.webp";
import mist from "@/components/site/media/mist.webp";
import mistSm from "@/components/site/media/mist-sm.webp";
import coast from "@/components/site/media/coast.webp";
import coastSm from "@/components/site/media/coast-sm.webp";
import library from "@/components/site/media/library.webp";
import librarySm from "@/components/site/media/library-sm.webp";
import moon from "@/components/site/media/moon.webp";
import moonSm from "@/components/site/media/moon-sm.webp";
import market from "@/components/site/media/market.webp";
import marketSm from "@/components/site/media/market-sm.webp";
import valley from "@/components/site/media/valley.webp";
import valleySm from "@/components/site/media/valley-sm.webp";
import lighthouse from "@/components/site/media/lighthouse.webp";
import lighthouseSm from "@/components/site/media/lighthouse-sm.webp";
import dunes from "@/components/site/media/dunes.webp";
import dunesSm from "@/components/site/media/dunes-sm.webp";
import lanterns from "@/components/site/media/lanterns.webp";
import lanternsSm from "@/components/site/media/lanterns-sm.webp";
import fishermen from "@/components/site/media/fishermen.webp";
import fishermenSm from "@/components/site/media/fishermen-sm.webp";
import workshop from "@/components/site/media/workshop.webp";
import workshopSm from "@/components/site/media/workshop-sm.webp";
import citynight from "@/components/site/media/citynight.webp";
import citynightSm from "@/components/site/media/citynight-sm.webp";
import dawn from "@/components/site/media/dawn.webp";
import dawnSm from "@/components/site/media/dawn-sm.webp";
import horizon from "@/components/site/media/horizon.webp";
import horizonSm from "@/components/site/media/horizon-sm.webp";
import { CLIPS, type ClipId } from "@/components/site/clip-assets";
import { MEDIA, type MediaId } from "@/lib/site/media";

/**
 * The example frames on the public pages: stock photographs and footage by Pexels contributors, credited in
 * lib/site/media.ts (the one data file the credits are read from) and shown only as examples of the kind of picture a video can
 * use. They are real photographs and footage, not output of any account; every place that shows one says "Example" and says what
 * it is. Derivatives only (scripts/make-site-media.py, with one shared grade): the originals are not in the repository.
 *
 * Each still comes in two widths (1280 and 640) and is served as a srcset, so a phone fetches the small one. Imported
 * statically, so each is a hashed file served from this origin (img-src 'self' already allows it) with its real width and height.
 */
const pair = (lg: { src: string; width: number; height: number }, sm: { src: string; width: number }) => ({ src: lg.src, width: lg.width, height: lg.height, sm: sm.src, smWidth: sm.width });
export const SAMPLES = {
  caravan: pair(caravan, caravanSm),
  mist: pair(mist, mistSm),
  coast: pair(coast, coastSm),
  library: pair(library, librarySm),
  moon: pair(moon, moonSm),
  market: pair(market, marketSm),
  valley: pair(valley, valleySm),
  lighthouse: pair(lighthouse, lighthouseSm),
  dunes: pair(dunes, dunesSm),
  lanterns: pair(lanterns, lanternsSm),
  fishermen: pair(fishermen, fishermenSm),
  workshop: pair(workshop, workshopSm),
  citynight: pair(citynight, citynightSm),
  dawn: pair(dawn, dawnSm),
  horizon: pair(horizon, horizonSm),
} as const satisfies Record<MediaId, { src: string; width: number; height: number; sm: string; smWidth: number }>;
export type SampleId = keyof typeof SAMPLES;

/**
 * The clips: three short silent loops of stock footage, each with a dissolve at its seam so the wrap is one ordinary frame
 * step (scripts/make-site-media.py prints the measure). Two renditions of each: 1280 x 720 for a screen of 860 px or more,
 * and 640 x 360 for a phone, each in MP4 and WebM. Frame 0 of every clip is its still, which is also the poster.
 */
export { CLIPS, type ClipId };

/**
 * One example frame as an <img> that fills its aspect-ratio box (the box, not the picture, decides the layout, so nothing
 * shifts when it loads). Lazy by default; the one on the first screen is eager (the hero card). `alt` is empty when the
 * surrounding picture is hidden from assistive tech and already described. `sizes` says how wide it is drawn, so the browser
 * picks the 640 or the 1280 file.
 */
export function SampleImg({ id, alt = "", className, eager = false, position, sizes = "100vw" }: { id: SampleId; alt?: string; className?: string; eager?: boolean; position?: string; sizes?: string }) {
  const s = SAMPLES[id];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={s.src} srcSet={`${s.sm} ${s.smWidth}w, ${s.src} ${s.width}w`} sizes={sizes} width={s.width} height={s.height} alt={alt} className={className} loading={eager ? "eager" : "lazy"} decoding="async" data-sample={id} style={position ? { objectPosition: position } : undefined} {...(eager ? { fetchPriority: "high" as const } : {})} />
  );
}

/**
 * THE MEDIA SLOTS: which picture goes where. Every page asks for a slot by name (<SlotImg slot="hero" />), never for a
 * file, so swapping a picture, or putting a new one in a place, is one line here. A page never shows the same picture
 * twice, and /mcp's six scenes are six different ones.
 *
 * To add one: run it through scripts/make-site-media.py (OUT_STILLS), import both widths above, add it to SAMPLES and to
 * lib/site/media.ts (its credit), give it an alt in lib/i18n/site/{en,ru,uz}.ts (site.samples.alts), then point a slot at it.
 */
export const SLOTS = {
  /** The landing's first screen (the chat card): the caravan clip. */
  hero: { id: "caravan", clip: "caravan" },
  /** The landing's three showcases, and the picture behind its closing panel. */
  "show.video": { id: "library" },
  "show.studio": { id: "mist", clip: "mist" },
  /** The small lighthouse is at the top right of the footage: the wide picture is framed from the top. */
  "show.approvals": { id: "coast", clip: "coast", position: "50% 6%" },
  "landing.final": { id: "moon" },
  /** The chat card on /pricing. */
  "pricing.card": { id: "lanterns" },
  /** /solutions: one photograph per audience tab. */
  "solutions.youtube-channels": { id: "fishermen" },
  "solutions.creative-studio": { id: "workshop" },
  "solutions.developers": { id: "citynight" },
  /** The sign-in and sign-up stages. */
  "auth.login": { id: "dawn" },
  "auth.signup": { id: "horizon" },
} as const satisfies Record<string, { id: SampleId; position?: string; clip?: ClipId }>;
export type SlotId = keyof typeof SLOTS;

/** A slot's still. `alt` is the description for where the picture stands alone; empty where it is decorative. */
export function SlotImg({ slot, alt = "", className, eager = false, sizes }: { slot: SlotId; alt?: string; className?: string; eager?: boolean; sizes?: string }) {
  const s: { id: SampleId; position?: string } = SLOTS[slot];
  return <SampleImg id={s.id} alt={alt} className={className} eager={eager} position={s.position} sizes={sizes} />;
}

/** The description of a slot's still, from the dictionary's alts. */
export function slotAlt(alts: Record<SampleId, string>, slot: SlotId): string {
  return alts[SLOTS[slot].id];
}

/** The clip a slot plays, if it has one. */
export function slotClip(slot: SlotId): ClipId | null {
  const s: { id: SampleId; clip?: ClipId } = SLOTS[slot];
  return s.clip ?? null;
}

/** Where a slot's picture (and its clip) is framed inside its box, when it is not the centre. */
export function slotPosition(slot: SlotId): string | undefined {
  const s: { id: SampleId; position?: string } = SLOTS[slot];
  return s.position;
}

/** The slot's still's id, and whether it is a frame of footage (labelled "stock footage") or a photograph. */
export function slotSample(slot: SlotId): { id: SampleId; footage: boolean } {
  const id = SLOTS[slot].id;
  return { id, footage: MEDIA[id].kind === "video" };
}
