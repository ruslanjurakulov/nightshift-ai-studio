/**
 * The site's picture places and what each shows, kept free of picture imports: the stock stills and clips are imported in
 * components/site/samples.tsx, which re-exports all of this. The footer (components/site/stock-in-use.ts) and /mcp's scenes
 * resolve places from here without loading every stock file. tools/export_showcase.py reads the slot names from this file.
 */
import type { ClipId } from "@/components/site/clip-assets";
import { MEDIA, type MediaId } from "@/lib/site/media";
import { SHOWCASE_ENTRIES, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";

/**
 * THE MEDIA SLOTS: which picture goes where. Every page asks for a slot by name, never for a file, so swapping a picture, or
 * putting a new one in a place, is one line here. A page never shows the same picture twice.
 *
 * `ai` is the one line that puts one of OUR generations (lib/site/showcase.json, by its job id) in a slot instead of the stock
 * picture. The slot then shows that sample with its AI-generated badge only (no model name, no Try this prompt, no footnote: a
 * slot's picture is a backdrop for copy about something else, owner 2026-11-13; the model and the prompt are on the sample's own
 * gallery card) and no Pexels credit (placeMedia below). Until that job's entry and files are merged the slot keeps its stock picture,
 * so a slot is never empty and never points at a file that is not in the repository. With `ai` null, an entry exported with
 * `--slot <name>` (tools/export_showcase.py) fills the slot the same way. `aiPosition` frames the sample in the slot's box.
 *
 * The stock fields are only the fallback. The footer lists only the stock pictures a page still shows
 * (components/site/stock-in-use.ts), so a replaced one leaves the credits by itself. Its files stay: the line still names it as the fallback.
 */
export const SLOTS = {
  /** The landing's first screen: edge to edge behind the headline and the prompt bar. */
  hero: { ai: "de53f364-eaf7-4cd1-8d44-7b56b21b03b6", id: "cloud", clip: "cloud" },
  /**
   * The landing's Studio showcase: a product commercial, what the Studio makes. The Approvals showcase has no slot: a wave under
   * "Nothing airs until you say so" illustrated nothing, so it is a drawn approval screen (components/landing/ApprovalCard.tsx).
   */
  "show.studio": { ai: "f92a89ed-2145-4342-acd5-f24b8805a0f9", id: "pottery", clip: "pottery" },
  /** Behind the landing's closing panel. */
  "landing.final": { ai: "01c9f1f0-d54b-4fd3-a88f-ddf459aece73", id: "moon" },
  /** The chat card on /pricing. */
  "pricing.card": { ai: "a6768488-04c6-4325-9465-62d61f888a70", id: "floating", clip: "floating" },
  /** /solutions: the publish desk's frame (channels), and one picture above each of the other two audiences. */
  "solutions.youtube-channels": { ai: "b72e18cd-d9e5-4535-9fea-f24fbd8c3fd9", id: "caravan", clip: "caravan" },
  "solutions.creative-studio": { ai: "fc1fad12-16de-4cd5-9cd9-e77ed245f469", id: "loom", clip: "loom" },
  "solutions.developers": { ai: "1504b313-3a3c-4e78-bfda-5bca3ef7f3da", id: "citynight" },
  /** The sign-in stage and the sign-up stage. */
  "auth.login": { ai: "38c427b0-c41b-4d16-86ca-14dc2e69ec27", id: "desert", position: "54% 50%" },
  /** Not another sea of clouds (the site read as "all sea", owner 2026-11-13): the dark chocolate pour keeps the words readable. */
  "auth.signup": { ai: "a6768488-04c6-4325-9465-62d61f888a70", id: "floating", clip: "floating", position: "42% 50%" },
  /** /mcp: the header panel. The snow globe's neon city, not a coast road: /mcp already shows the waves scene. */
  "mcp.hero": { ai: "01c9f1f0-d54b-4fd3-a88f-ddf459aece73", id: "cloud", clip: "cloud" },
} as const satisfies Record<string, PlaceDef>;
export type SlotId = keyof typeof SLOTS;

/** One place's line: the sample that fills it (`ai`, a showcase job id, or null) and the stock fallback (id, clip, position). */
export type PlaceDef = { ai: string | null; aiPosition?: string; id: MediaId; position?: string; clip?: ClipId };

/**
 * What a place actually shows: one of our samples, labelled as an AI generation by its model, or the stock fallback, labelled
 * as stock by its Pexels contributor. Never a mix: a stock label on an AI clip, or an AI label on stock footage, is a lie in
 * either direction (CLAUDE.md #5), so every label on a slot is chosen from this and nothing else.
 */
export type PlaceMedia =
  | { kind: "ai"; entry: ShowcaseEntry; files: ShowcaseFiles; moving: boolean; position?: string }
  | { kind: "stock"; id: MediaId; footage: boolean; clip: ClipId | null; position?: string };

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
export const LANDING_SLOTS = ["hero", "show.studio", "landing.final"] as const satisfies readonly SlotId[];

/**
 * Samples the landing's gallery leaves out although no slot shows them: more sea, sky and surf. The first screen is a whale in a sea
 * of clouds and the tool wall's Animate tile is water around a bottle; with these as well the page read as "all sea" (owner,
 * 2026-11-13). The wave and the lighthouse it was animated from, the drone over the clouds, the coast road. Their entries stay
 * in the data file; this only keeps them off the landing.
 */
export const LANDING_LEFT_OUT: readonly string[] = [
  "ab7cc0e2-8040-4643-8e14-74219fc1d8e2",
  "f17146fd-054c-4970-9dac-f7a0dc929bd6",
  "9a52ebf1-bbe3-473c-b77c-7553bc18e0d8",
  "ab0bcba2-8374-465d-b505-8dac19977948",
];
