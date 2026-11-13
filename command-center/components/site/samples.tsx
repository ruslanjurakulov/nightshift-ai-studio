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
import { CLIPS, type ClipId } from "@/components/site/clip-assets";
import { MEDIA, type MediaId } from "@/lib/site/media";
import { SHOWCASE_ENTRIES, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";

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
 * THE MEDIA SLOTS: which picture goes where. Every page asks for a slot by name, never for a file, so swapping a picture, or
 * putting a new one in a place, is one line here. A page never shows the same picture twice.
 *
 * `ai` is the one line that puts one of OUR generations (lib/site/showcase.json, by its job id) in a slot instead of the stock
 * picture. The slot then shows that sample with the sample's own labels (the AI badge, the model, the maker's credit, Try this
 * prompt) and no Pexels credit (placeMedia below). Until that job's entry and files are merged the slot keeps its stock picture,
 * so a slot is never empty and never points at a file that is not in the repository. With `ai` null, an entry exported with
 * `--slot <name>` (tools/export_showcase.py) fills the slot the same way. `aiPosition` frames the sample in the slot's box.
 *
 * The stock fields are only the fallback. The footer lists only the stock pictures a page still shows
 * (components/site/stock-in-use.ts), so a replaced one leaves the credits by itself. Its files stay: the line still names it as the fallback.
 */
export const SLOTS = {
  /** The landing's first screen: edge to edge behind the headline and the prompt bar. */
  hero: { ai: null, id: "cloud", clip: "cloud" },
  /** The landing's two showcases. */
  "show.studio": { ai: null, id: "pottery", clip: "pottery" },
  /** The small lighthouse is at the top right of the footage: the wide picture is framed from the top. */
  "show.approvals": { ai: null, id: "coast", clip: "coast", position: "50% 6%" },
  /** Behind the landing's closing panel. */
  "landing.final": { ai: null, id: "moon" },
  /** The chat card on /pricing. */
  "pricing.card": { ai: null, id: "floating", clip: "floating" },
  /** /solutions: the publish desk's frame (channels), and one picture above each of the other two audiences. */
  "solutions.youtube-channels": { ai: null, id: "caravan", clip: "caravan" },
  "solutions.creative-studio": { ai: null, id: "loom", clip: "loom" },
  "solutions.developers": { ai: null, id: "citynight" },
  /** The sign-in stage and the sign-up stage. */
  "auth.login": { ai: null, id: "desert", position: "54% 50%" },
  "auth.signup": { ai: null, id: "floating", clip: "floating", position: "42% 50%" },
  /** /mcp: the header panel. */
  "mcp.hero": { ai: null, id: "cloud", clip: "cloud" },
} as const satisfies Record<string, PlaceDef>;
export type SlotId = keyof typeof SLOTS;

/** One place's line: the sample that fills it (`ai`, a showcase job id, or null) and the stock fallback (id, clip, position). */
export type PlaceDef = { ai: string | null; aiPosition?: string; id: SampleId; position?: string; clip?: ClipId };

/**
 * What a place actually shows: one of our samples, labelled as an AI generation by its model, or the stock fallback, labelled
 * as stock by its Pexels contributor. Never a mix: a stock label on an AI clip, or an AI label on stock footage, is a lie in
 * either direction (CLAUDE.md #5), so every label on a slot is chosen from this and nothing else.
 */
export type PlaceMedia =
  | { kind: "ai"; entry: ShowcaseEntry; files: ShowcaseFiles; moving: boolean; position?: string }
  | { kind: "stock"; id: SampleId; footage: boolean; clip: ClipId | null; position?: string };

/** The sample a line names (or, with `ai` null, the newest entry exported for `name`) when its entry and its files are both here; else the stock fallback. */
export function placeMedia(
  def: PlaceDef,
  name: string | null,
  entries: readonly ShowcaseEntry[] = SHOWCASE_ENTRIES,
  files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES,
): PlaceMedia {
  const entry = def.ai ? entries.find((e) => e.jobId === def.ai) : name ? entries.find((e) => e.slot === name) : undefined;
  const f = entry ? files[entry.jobId] : undefined;
  if (entry && f) return { kind: "ai", entry, files: f, moving: entry.kind === "video" && f.clip !== null, position: def.aiPosition };
  return { kind: "stock", id: def.id, footage: MEDIA[def.id].kind === "video", clip: def.clip ?? null, position: def.position };
}

/** What a slot shows (placeMedia over its line). */
export function slotMedia(slot: SlotId, entries?: readonly ShowcaseEntry[], files?: Readonly<Record<string, ShowcaseFiles>>): PlaceMedia {
  return placeMedia(SLOTS[slot], slot, entries, files);
}

/** The showcase jobs these slots show right now: a page leaves them out of its own gallery, so no clip is shown twice on it. */
export function slotJobs(slots: readonly SlotId[], entries?: readonly ShowcaseEntry[], files?: Readonly<Record<string, ShowcaseFiles>>): string[] {
  return slots.flatMap((s) => {
    const m = slotMedia(s, entries, files);
    return m.kind === "ai" ? [m.entry.jobId] : [];
  });
}

/** The landing's own slots (its gallery leaves out the samples they show). */
export const LANDING_SLOTS = ["hero", "show.studio", "show.approvals", "landing.final"] as const satisfies readonly SlotId[];
