/**
 * "Improve with AI" where the file is — the pure half (tests/improve-ai.test.ts).
 *
 * A library tile, the library viewer and an editor clip or overlay picture
 * offer the AI tools that fit the file's type. Nothing here prices, starts or
 * spends anything: every tool is an EXISTING Studio tool opened with the file
 * already chosen (`/create?tool=…&source=…`, the same link the library's
 * "Use in Studio" uses), and the Studio shows the database's price before
 * anything starts. A tool no model is sold for on this deployment is listed as
 * "not available yet" rather than hidden or offered as a dead end.
 *
 * Auto-captions are the one tool that is not a Studio tool: they are made in
 * the editor from a clip (components/editor/CaptionsPanel), so for them the
 * entry opens the editor on its Captions panel instead of a link here.
 */
import { isUuid } from "@/lib/creative/operations";
import { MODEL_ID_RE } from "@/lib/models-admin";
import { modelsFor, promptRule, wordsMax, type StudioModel, type StudioPrefill } from "@/lib/creative/studio";

export type ImproveKind = "image" | "video" | "audio";

export function isImproveKind(v: unknown): v is ImproveKind {
  return v === "image" || v === "video" || v === "audio";
}

/** Studio tools that start from a file, plus captions (made in the editor). */
export const IMPROVE_STUDIO_TOOLS = ["upscale", "remove_bg", "edit", "i2v", "video_upscale", "dub", "voice_change"] as const;
export type ImproveStudioTool = (typeof IMPROVE_STUDIO_TOOLS)[number];
export type ImproveTool = ImproveStudioTool | "captions";

/** What fits each file type, in the order the menu lists it. */
export const IMPROVE_TOOLS: Record<ImproveKind, readonly ImproveTool[]> = {
  // Sharper and bigger, background out, change by words, bring to life.
  image: ["upscale", "remove_bg", "edit", "i2v"],
  // Sharper and bigger, subtitles, another language, another voice.
  video: ["video_upscale", "captions", "dub", "voice_change"],
  // Another voice, another language.
  audio: ["voice_change", "dub"],
};

export function improveTools(kind: unknown): readonly ImproveTool[] {
  return isImproveKind(kind) ? IMPROVE_TOOLS[kind] : [];
}

export function isStudioTool(tool: ImproveTool): tool is ImproveStudioTool {
  return tool !== "captions";
}

/**
 * The most words "Improve with AI" carries into the Studio. They travel in the address, so they are held well under
 * what a proxy or a browser would cut (the Studio's own box takes up to 4000, and the person can keep typing there).
 */
export const IMPROVE_PROMPT_MAX = 1000;

/** The words' limit for one tool: the smaller of the address's and the tool's own (lib/creative/studio wordsMax). */
export function improvePromptMax(tool: ImproveStudioTool): number {
  return Math.min(IMPROVE_PROMPT_MAX, wordsMax(tool));
}

/**
 * Whether the tool is asked by words — the same rule the Studio's box follows (lib/creative/studio promptRule):
 * "required" (edit by prompt), "optional" (upscale, animate) or "none" (cut out, the video and voice tools, captions).
 */
export function improveWords(tool: ImproveTool): "required" | "optional" | "none" {
  return isStudioTool(tool) ? promptRule(tool) : "none";
}

/** "Auto" as the address carries it: the database picks the model at the Studio's quote (0075). */
export const AUTO_MODEL = "auto";

// Never part of what a person typed on purpose, and the words travel in a link anyone can craft: C0 controls other
// than a line break and a tab, DEL and the C1 controls, and the bidi overrides and isolates (U+202A–202E,
// U+2066–2069), which would make the words shown in the Studio's box read in another order than they are sent; and the
// characters that show nothing at all: zero-width spaces, joiners and marks (U+200B–200F), the word joiner and invisible
// operators (U+2060–2064), the byte-order mark, and the tag characters (U+E0000–E007F), which can carry a whole hidden
// sentence inside words that look harmless. tools/export_showcase.py CONTROL_RE is the same set.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

/**
 * At most `max` UTF-16 units (the box's maxLength measure; the database's char_length counts code points, never more)
 * without cutting a character in half: a surrogate pair split at the limit would leave a lone half, which the Studio
 * box draws as a replacement mark and the database stores as it is.
 */
function cutWhole(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * Typed words as the address may carry them: control and bidi characters out, trimmed, cut to the tool's limit on a
 * whole character. Empty for a tool that takes no words — the Studio sends none for it, and the database would refuse
 * them.
 */
export function cleanImprovePrompt(tool: ImproveStudioTool, raw: unknown): string {
  if (typeof raw !== "string" || improveWords(tool) === "none") return "";
  return cutWhole(raw.replace(CONTROL, "").trim(), improvePromptMax(tool)).trim();
}

/**
 * The text tools a link may also start with words: a model sample's "Try it" on the public site (lib/site/showcase-link.ts) opens
 * `/create?tool=t2v&model=…&prompt=…`. Same cleaning and bound as the file tools above; it only fills the box (CLAUDE.md #3).
 */
export const LINK_PROMPT_TOOLS = ["t2i", "t2v"] as const;
export type LinkPromptTool = ImproveStudioTool | (typeof LINK_PROMPT_TOOLS)[number];

export function isLinkPromptTool(tool: unknown): tool is LinkPromptTool {
  return (IMPROVE_STUDIO_TOOLS as readonly unknown[]).includes(tool) || (LINK_PROMPT_TOOLS as readonly unknown[]).includes(tool);
}

/** A link's words for any tool that takes them from a link, cleaned and bounded as cleanImprovePrompt does. */
export function cleanLinkPrompt(tool: LinkPromptTool, raw: unknown): string {
  if (typeof raw !== "string" || promptRule(tool) === "none") return "";
  return cutWhole(raw.replace(CONTROL, "").trim(), Math.min(IMPROVE_PROMPT_MAX, wordsMax(tool))).trim();
}

/**
 * The Studio link (without the channel prefix) that opens `tool` with the file
 * chosen. null for captions (not a Studio tool) and for an id that is not a
 * well-formed file id (the Studio would refuse it). `project` is an editor
 * project the person came from: the Studio then offers "Add to project" on the
 * finished result and a way back. `model` (an id, or "auto") and `prompt` (the
 * words typed in the panel) only fill the Studio's form: it keeps a model only if
 * it offers it for that tool, and nothing is priced until it shows its own price.
 */
export function improveHref(
  tool: ImproveTool,
  assetId: string,
  project?: string | null,
  pick: { model?: string | null; prompt?: string | null } = {},
): string | null {
  if (!isStudioTool(tool) || !isUuid(assetId)) return null;
  const q = new URLSearchParams({ tool, source: assetId });
  if (project && isUuid(project)) q.set("project", project);
  if (pick.model && (pick.model === AUTO_MODEL || MODEL_ID_RE.test(pick.model))) q.set("model", pick.model);
  const words = cleanImprovePrompt(tool, pick.prompt);
  if (words) q.set("prompt", words);
  return `/create?${q.toString()}`;
}

/**
 * The models the panel may offer for a tool: the Studio's own list for that capability, in its order. null = the
 * list was not read (the Studio picks). "Auto" is offered where the Studio offers it: more than one model to choose.
 */
export function improveModels(models: readonly StudioModel[] | null, tool: ImproveTool): { models: StudioModel[]; auto: boolean } | null {
  if (models === null) return null;
  if (!isStudioTool(tool)) return { models: [], auto: false };
  const list = modelsFor([...models], tool);
  return { models: list, auto: list.length > 1 };
}

const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);

/**
 * The create page's half of the link: `model=auto` starts the form on Auto, and `prompt` fills the box — cleaned and
 * bounded exactly as the link was built, and only for a tool that takes words. A form that already has words (a
 * template) keeps them. It fills the form and nothing else: no price, no hold, no start (CLAUDE.md #3).
 */
export function prefillFromImprove(initial: StudioPrefill | null, q: { model?: unknown; prompt?: unknown }): StudioPrefill | null {
  if (!initial) return initial;
  let out = initial;
  if (one(q.model) === AUTO_MODEL) out = { ...out, model: "", auto: true };
  const tool = out.capability as string;
  if (!out.prompt && isLinkPromptTool(tool)) {
    const words = cleanLinkPrompt(tool, one(q.prompt));
    if (words) out = { ...out, prompt: words };
  }
  return out;
}

/**
 * Is a tool sold on this deployment? `available` is the capabilities the
 * database would sell a model for (sellable_models); null = not known (the
 * read failed), where the tool is still offered and the Studio says plainly
 * what it finds. An empty list means nothing is sold: every tool is "not
 * available yet".
 */
export function improveAvailable(tool: ImproveTool, available: readonly string[] | null): boolean {
  return available === null || available.includes(tool);
}

/** A well-formed project id from the address, else null. */
export function parseIdParam(v: unknown): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && isUuid(s) ? s : null;
}

/** The editor link that offers a finished result for the project ("Add to project"). */
export function editorAddHref(projectId: string, assetId: string): string | null {
  if (!isUuid(projectId) || !isUuid(assetId)) return null;
  return `/editor/${projectId}?add=${assetId}`;
}

/** The capabilities, as the registry lists them, that the menu can offer (for the server read). */
export function sellableToolList(capabilities: readonly string[]): string[] {
  const known = new Set<string>([...IMPROVE_STUDIO_TOOLS, "captions"]);
  return [...new Set(capabilities)].filter((c) => known.has(c));
}
