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
 * The Studio link (without the channel prefix) that opens `tool` with the file
 * chosen. null for captions (not a Studio tool) and for an id that is not a
 * well-formed file id (the Studio would refuse it). `project` is an editor
 * project the person came from: the Studio then offers "Add to project" on the
 * finished result and a way back.
 */
export function improveHref(tool: ImproveTool, assetId: string, project?: string | null): string | null {
  if (!isStudioTool(tool) || !isUuid(assetId)) return null;
  const q = new URLSearchParams({ tool, source: assetId });
  if (project && isUuid(project)) q.set("project", project);
  return `/create?${q.toString()}`;
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
