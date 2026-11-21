/**
 * The app's start box (components/prompt/StartBox.tsx, on Home and at the Studio start): where its send key goes, and how the
 * Trends templates under it are grouped. Pure and client-safe (tests/start-box.test.tsx).
 *
 * Every answer here is an ADDRESS. Nothing is run, priced or spent by the box (CLAUDE.md rule 3): the place it opens shows the
 * price, and only that place's own press starts anything. Words that do not fit an address are kept in this browser through the
 * landing's own handoff (lib/site/idea-handoff.ts, `?idea=1`), never put in one; only closed enums (`format`, `kind`) ride along.
 */
import { TOPIC_MAX, lengthSeconds, runHandoffHref, type HomeLanguage } from "@/lib/home";
import { KIND_DESK, createHref, type CreateKind } from "@/lib/customer/create";
// The number only, from the operations table (no model tables, no registry): the start box is client code on Home.
import { MAX_VIDEO_EDIT_WORDS } from "@/lib/creative/operations";
import { IDEA_MAX, IDEA_PARAM } from "@/lib/site/idea-handoff";
import { TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateDto } from "@/lib/templates/trends";
import { deskOpen, toolOpen, type ToolAvailability } from "@/lib/tool-availability";

export const START_TABS = ["create", "edit"] as const;
export type StartTab = (typeof START_TABS)[number];

/** AI film | Ad | Channel video. The only value of `format=` an address ever carries. */
export const START_FORMATS = ["film", "ad", "channel"] as const;
export type StartFormat = (typeof START_FORMATS)[number];

export function isStartFormat(v: unknown): v is StartFormat {
  return typeof v === "string" && (START_FORMATS as readonly string[]).includes(v);
}

/**
 * `/studio?ai=new`: "open Nightshift AI with a new conversation" (S5's panel, #843). That page reads the kept words (`ns.idea.v1`)
 * once and types them in only if its box is empty; while the panel is closed for the workspace it sends `ai=new&idea=1` on to
 * Create's prefilled box itself (lib/brain/flag.ts ideaNeedsCreate), so the words are never left unread behind an absent panel.
 * `format` goes last and is harmless there: S5 ignores parameters it does not know.
 */
export const AI_PARAM = "ai";
export const AI_NEW = "new";

/**
 * Whether `/studio?ai=new` has a reader for the kept words. True since #843 (components/brain/NightshiftAiPanel.tsx reads them);
 * kept as a switch, with its tests, so a chip that would open a panel ignoring the words can be closed again in one line.
 */
export const AI_READER_READY = true;

/** The Agent chip can be used: the server's flag is open for this workspace AND the page it opens can read the words. */
export function agentUsable(agentOpen: boolean, aiReader: boolean = AI_READER_READY): boolean {
  return agentOpen && aiReader;
}

/**
 * The "AI edit" tab's desk and tool. The Enhance desk is where Create changes something that already exists; of its tools the one
 * that takes words and changes a video by them is `video_edit` (lib/creative/desks.ts). The person picks the clip there.
 */
export const EDIT_DESK_HREF = `/create?desk=enhance&tool=video_edit&${IDEA_PARAM}=1`;

/**
 * The most the "AI edit" tab takes: what `video_edit` takes (0100, lib/creative/studio wordsMax). The field stops there, rather than
 * taking 2000 characters the desk would quietly cut to 500.
 */
export const EDIT_WORDS_MAX = MAX_VIDEO_EDIT_WORDS;

/** The field's limit on a tab. */
export function wordsLimit(tab: StartTab): number {
  return tab === "edit" ? EDIT_WORDS_MAX : IDEA_MAX;
}

/** More characters than the tab takes (words typed on the create tab, then the tab switched to edit). */
export function overLimit(tab: StartTab, words: string): boolean {
  return Array.from(words.trim()).length > wordsLimit(tab);
}

/**
 * Which of the box's choices have something on sale behind them, as the Studio start's own chips say it (lib/tool-availability.ts):
 * a kind is its Create desk (KIND_DESK: Audio is the Voice desk), the edit tab is the one tool it opens, `video_edit` on the Enhance
 * desk (a sold upscale does not make the edit tab work). `null` = not known (the read failed): drawn usable and marked nothing, never
 * "not available" on a guess (rule 5).
 */
export type StartAvailable = { video: boolean | null; image: boolean | null; audio: boolean | null; edit: boolean | null };

export const UNKNOWN_START: StartAvailable = { video: null, image: null, audio: null, edit: null };

export function startAvailability(av: ToolAvailability): StartAvailable {
  if (av.state === "unknown") return UNKNOWN_START;
  return {
    video: deskOpen(av, KIND_DESK.video),
    image: deskOpen(av, KIND_DESK.image),
    audio: deskOpen(av, KIND_DESK.audio),
    edit: toolOpen(av, "video_edit"),
  };
}

/** A channel video's length when the box sends one: Home's composer default (5–10 min, HOME_LENGTHS m5_10). The run form shows it. */
export const CHANNEL_LENGTH = "m5_10" as const;

export interface StartChoice {
  tab: StartTab;
  /** The Agent chip is on. */
  agent: boolean;
  /** The server said Nightshift AI is open for this workspace. A closed answer overrides `agent`. */
  agentOpen: boolean;
  /** A test seam for AI_READER_READY; unset, the constant decides. */
  aiReader?: boolean;
  /** With Agent on: the format Nightshift AI's questions are shaped by. Either way, `channel` is a channel video. */
  format: StartFormat;
  /** With Agent off: Video | Image | Audio, Create's own three kinds (Home's old choice). */
  kind: CreateKind;
}

export interface StartContext {
  /** The channel-scoped path helper (lib/channels-client useChannelPath). */
  path: (section: string) => string;
  /** The verified channel a channel video is made for, or null when there is none (rule 7). */
  channel: string | null;
  language: HomeLanguage;
}

export type StartRoute =
  /** The words are kept in this browser and the address says only `idea=1`. `fallback` is where to go with the words in the
   *  address instead when this browser will not keep them, or null when the place cannot take words from an address (the box
   *  then says so, rather than arriving with an empty field). */
  | { via: "idea"; href: string; fallback: string | null }
  /** The channel run form, topic in the address (a topic is short: TOPIC_MAX); `cut` when the words were longer. */
  | { via: "topic"; href: string; cut: boolean }
  /** No verified channel: the way to connect one. */
  | { via: "connect"; href: string };

/** A channel topic as the run form keeps it: one line, spaces folded (lib/home runPrefillFromQuery). */
export function topicWords(words: string): string {
  return words.replace(/\s+/g, " ").trim();
}

export function topicCut(words: string): boolean {
  return topicWords(words).length > TOPIC_MAX;
}

export function startRoute(c: StartChoice, words: string, ctx: StartContext): StartRoute {
  if (c.tab === "edit") return { via: "idea", href: ctx.path(EDIT_DESK_HREF), fallback: null };
  // Agent on reaches Nightshift AI only when the server said it is open; a closed answer is never a way in.
  if (c.agent && agentUsable(c.agentOpen, c.aiReader)) {
    const q = new URLSearchParams({ [AI_PARAM]: AI_NEW, [IDEA_PARAM]: "1", format: c.format });
    return { via: "idea", href: ctx.path(`/studio?${q.toString()}`), fallback: null };
  }
  if (c.format === "channel") {
    if (!ctx.channel) return { via: "connect", href: ctx.path("/channels/new") };
    const topic = topicWords(words);
    return {
      via: "topic",
      href: runHandoffHref(ctx.channel, { topic, seconds: lengthSeconds(CHANNEL_LENGTH), language: ctx.language }),
      cut: topic.length > TOPIC_MAX,
    };
  }
  // Create's box for the kind, filled once by its idea pickup; the fallback is the same screen with the words in the address.
  const kindQ = c.kind === "video" ? "" : `&kind=${c.kind}`;
  return { via: "idea", href: ctx.path(`/create?${IDEA_PARAM}=1${kindQ}`), fallback: ctx.path(createHref(c.kind, words)) };
}

// ── the templates under the box, by purpose ─────────────────────────────────

export const TEMPLATE_PURPOSES = ["storytelling", "marketing", "brand"] as const;
export type TemplatePurpose = (typeof TEMPLATE_PURPOSES)[number];

/** Which Trends categories (migration 0183/0186) each purpose holds. Every category is in exactly one (pinned by a test). */
export const PURPOSE_CATEGORIES: Readonly<Record<TemplatePurpose, readonly TemplateCategory[]>> = {
  storytelling: ["story", "lifestyle"],
  marketing: ["business", "viral"],
  brand: ["text"],
};

export function purposeOf(category: TemplateCategory): TemplatePurpose {
  for (const p of TEMPLATE_PURPOSES) if (PURPOSE_CATEGORIES[p].includes(category)) return p;
  // Unreachable while PURPOSE_CATEGORIES covers TEMPLATE_CATEGORIES.
  return "storytelling";
}

/** The templates in purpose order, the gallery's own order kept inside each; a purpose with none is left out (never drawn empty). */
export function groupTemplates(list: readonly TemplateDto[]): { purpose: TemplatePurpose; templates: TemplateDto[] }[] {
  const by: Record<TemplatePurpose, TemplateDto[]> = { storytelling: [], marketing: [], brand: [] };
  for (const t of list) if ((TEMPLATE_CATEGORIES as readonly string[]).includes(t.category)) by[purposeOf(t.category)].push(t);
  return TEMPLATE_PURPOSES.filter((p) => by[p].length > 0).map((p) => ({ purpose: p, templates: by[p] }));
}
