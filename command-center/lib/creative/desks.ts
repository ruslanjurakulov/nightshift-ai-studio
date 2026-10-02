/**
 * The Studio's workspaces ("desks"): the same tools as the composer, grouped
 * by the job a person came to do, so each desk can be laid out around that
 * job instead of one form for everything. Pure and client-safe
 * (tests/studio-desks.test.ts).
 *
 * A desk only chooses which tools are offered together and how the page is
 * arranged. Pricing, holds and the create call are the composer's and do not
 * change with the desk: every tool here is one of PANEL_CAPABILITIES, and the
 * desk never adds a setting a tool does not take.
 */
import { PANEL_CAPABILITIES, isStudioCapability, type StudioCapability } from "@/lib/creative/studio";

/** The desks that hold a composer, in the order the switcher shows them. */
export const MEDIA_DESKS = ["video", "image", "enhance", "voice"] as const;
export type MediaDesk = (typeof MEDIA_DESKS)[number];

/** Every place on /create: the overview, the four composer desks, and the YouTube video run. */
export const DESKS = ["overview", ...MEDIA_DESKS, "youtube"] as const;
export type Desk = (typeof DESKS)[number];

/** Which tools each composer desk offers, in the order its tabs show them. */
export const DESK_TOOLS: Record<MediaDesk, readonly StudioCapability[]> = {
  // Make a clip from words, or animate a picture.
  video: ["t2v", "i2v"],
  // Make a picture, change one, or read one back as words.
  image: ["t2i", "edit", "describe"],
  // Make what exists bigger or cleaner: picture upscale, cut-out, video upscale.
  enhance: ["upscale", "remove_bg", "video_upscale"],
  // Speech from words, a new voice on a recording, a dub.
  voice: ["tts", "voice_change", "dub"],
};

export function isDesk(v: unknown): v is Desk {
  return typeof v === "string" && (DESKS as readonly string[]).includes(v);
}

export function isMediaDesk(v: unknown): v is MediaDesk {
  return typeof v === "string" && (MEDIA_DESKS as readonly string[]).includes(v);
}

/** The desk a tool lives on. Every composer tool is on exactly one desk. */
export function deskFor(c: StudioCapability): MediaDesk {
  for (const d of MEDIA_DESKS) if (DESK_TOOLS[d].includes(c)) return d;
  // Unreachable while DESK_TOOLS covers PANEL_CAPABILITIES (pinned by a test).
  return "image";
}

/**
 * Where /create opens. An explicit `desk` wins when it is a real one; a
 * `tool` (the sidebar, Home's quick tools, the Library's "Use in Studio")
 * opens that tool's desk; a topic from Home's composer opens the YouTube run;
 * anything else is the overview. Unknown values fall through, never throw.
 */
export function deskFromQuery(q: { desk?: unknown; tool?: unknown; hasRunPrefill?: boolean }): Desk {
  const desk = Array.isArray(q.desk) ? q.desk[0] : q.desk;
  const tool = Array.isArray(q.tool) ? q.tool[0] : q.tool;
  if (isDesk(desk)) {
    // A tool that belongs to another desk is not dropped: its own desk opens.
    if (isMediaDesk(desk) && isStudioCapability(tool) && !DESK_TOOLS[desk].includes(tool)) return deskFor(tool);
    return desk;
  }
  if (isStudioCapability(tool)) return deskFor(tool);
  if (q.hasRunPrefill) return "youtube";
  return "overview";
}

/** The desk's own link (the switcher, the sidebar, the overview's keys). */
export function deskHref(d: Desk): string {
  return d === "overview" ? "/create" : `/create?desk=${d}`;
}

/**
 * The tool "Use as picture" switches to on this desk: the current one when it
 * already starts from a picture, else the desk's first picture tool, else the
 * picture edit (the composer's behaviour before desks).
 */
export function pictureToolFor(tools: readonly StudioCapability[], current: StudioCapability, needsSource: (c: StudioCapability) => boolean): StudioCapability {
  if (needsSource(current)) return current;
  return tools.find(needsSource) ?? "edit";
}

/** Every composer tool, for the composer outside a desk (unchanged order). */
export const ALL_TOOLS: readonly StudioCapability[] = PANEL_CAPABILITIES;
