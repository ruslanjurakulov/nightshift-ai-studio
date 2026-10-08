import caravan from "@/components/site/media/caravan.webp";
import caravanSm from "@/components/site/media/caravan-sm.webp";
import coast from "@/components/site/media/coast.webp";
import coastSm from "@/components/site/media/coast-sm.webp";
import cloud from "@/components/site/media/cloud.webp";
import cloudSm from "@/components/site/media/cloud-sm.webp";
import pottery from "@/components/site/media/pottery.webp";
import potterySm from "@/components/site/media/pottery-sm.webp";
import floating from "@/components/site/media/floating.webp";
import floatingSm from "@/components/site/media/floating-sm.webp";
import loom from "@/components/site/media/loom.webp";
import loomSm from "@/components/site/media/loom-sm.webp";
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
import citynight from "@/components/site/media/citynight.webp";
import citynightSm from "@/components/site/media/citynight-sm.webp";
import desert from "@/components/site/media/desert.webp";
import desertSm from "@/components/site/media/desert-sm.webp";
import peak from "@/components/site/media/peak.webp";
import waterfall from "@/components/site/media/waterfall.webp";
import mic from "@/components/site/media/mic.webp";
import reel from "@/components/site/media/reel.webp";
import trails from "@/components/site/media/trails.webp";
import fibres from "@/components/site/media/fibres.webp";
import paper from "@/components/site/media/paper.webp";
import paint from "@/components/site/media/paint.webp";
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
  coast: pair(coast, coastSm),
  cloud: pair(cloud, cloudSm),
  pottery: pair(pottery, potterySm),
  floating: pair(floating, floatingSm),
  loom: pair(loom, loomSm),
  library: pair(library, librarySm),
  moon: pair(moon, moonSm),
  market: pair(market, marketSm),
  valley: pair(valley, valleySm),
  lighthouse: pair(lighthouse, lighthouseSm),
  citynight: pair(citynight, citynightSm),
  desert: pair(desert, desertSm),
  // The capability wall's tiles: one 448 px file each.
  peak: pair(peak, peak),
  waterfall: pair(waterfall, waterfall),
  mic: pair(mic, mic),
  reel: pair(reel, reel),
  trails: pair(trails, trails),
  fibres: pair(fibres, fibres),
  paper: pair(paper, paper),
  paint: pair(paint, paint),
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
    <img src={s.src} srcSet={s.sm === s.src ? undefined : `${s.sm} ${s.smWidth}w, ${s.src} ${s.width}w`} sizes={s.sm === s.src ? undefined : sizes} width={s.width} height={s.height} alt={alt} className={className} loading={eager ? "eager" : "lazy"} decoding="async" data-sample={id} style={position ? { objectPosition: position } : undefined} {...(eager ? { fetchPriority: "high" as const } : {})} />
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
  /** The landing's first screen (the chat card): the cloud-sea clip. */
  hero: { id: "cloud", clip: "cloud" },
  /** The landing's two showcases (a clip each), and the picture behind its closing panel. */
  "show.studio": { id: "pottery", clip: "pottery" },
  /** The small lighthouse is at the top right of the footage: the wide picture is framed from the top. */
  "show.approvals": { id: "coast", clip: "coast", position: "50% 6%" },
  "landing.final": { id: "moon" },
  /** The chat card on /pricing: lanterns floating on dark water. */
  "pricing.card": { id: "floating", clip: "floating" },
  /** /solutions: the publish desk's frame (channels), and one photograph or clip above each of the other two audiences. */
  "solutions.youtube-channels": { id: "caravan", clip: "caravan" },
  "solutions.creative-studio": { id: "loom", clip: "loom" },
  "solutions.developers": { id: "citynight" },
  /** The sign-in stage is a still (golden light over dunes); the sign-up stage plays the floating lanterns, behind a pause button. */
  "auth.login": { id: "desert", position: "54% 50%" },
  "auth.signup": { id: "floating", clip: "floating", position: "42% 50%" },
  /** /mcp: the header panel plays the cloud-sea clip, framed on its dark ridge. */
  "mcp.hero": { id: "cloud", clip: "cloud" },
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
