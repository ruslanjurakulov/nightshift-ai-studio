/**
 * The customer's Create and Home screens (the investor-sprint IA): what a kind is, what a trend template is, how a
 * template becomes a filled form, and the Director's prompt guidance. Pure: no fetch, no price, no spend. Every price
 * on these screens is the server's quote (GeneratePanel asks /api/creative/quote), and every paid job is one press.
 */
import { isImageQuality, type StudioCapability, type StudioModel, type StudioPrefill } from "@/lib/creative/studio";
import type { MediaDesk } from "@/lib/creative/desks";

/** The three tabs on Home and Create. */
export const CREATE_KINDS = ["video", "image", "audio"] as const;
export type CreateKind = (typeof CREATE_KINDS)[number];

/** The tool a kind starts on, and the desk whose tools it offers (Video also animates a picture: i2v). */
export const KIND_TOOL: Readonly<Record<CreateKind, StudioCapability>> = { video: "t2v", image: "t2i", audio: "tts" };
export const KIND_DESK: Readonly<Record<CreateKind, MediaDesk>> = { video: "video", image: "image", audio: "voice" };

export function isCreateKind(v: unknown): v is CreateKind {
  return typeof v === "string" && (CREATE_KINDS as readonly string[]).includes(v);
}

/** The prompt a link may carry: one bounded line, so a link can never stuff the box. */
export const LINK_PROMPT_MAX = 2000;
export function cleanLinkPrompt(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, LINK_PROMPT_MAX);
}

/** `/create?kind=video&prompt=…` — fills the form only; nothing is priced until the form asks, nothing spent until the press. */
export function createHref(kind: CreateKind, prompt = "", template?: string): string {
  const q = new URLSearchParams({ kind });
  const words = cleanLinkPrompt(prompt);
  if (words) q.set("prompt", words);
  if (template) q.set("template", template);
  return `/create?${q.toString()}`;
}

// --- Trend templates (stream S3's API: GET /api/templates, GET /api/templates/<slug>) -------------------------------

/** The S3 contract, exactly: `{ slug, kind, title, prompt, model_id, aspect, duration_s, quality, director? }`. */
export interface TrendTemplate {
  slug: string;
  kind: CreateKind;
  title: string;
  prompt: string;
  model_id: string;
  aspect: string | null;
  duration_s: number | null;
  quality: string | null;
  director: string | null;
  /** Optional extras S3 may add; read only when well-formed. */
  thumbnail_url: string | null;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null;

/** One template from the API, or null when it is not one (never a half-filled guess). */
export function parseTemplate(raw: unknown): TrendTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === "string" && SLUG_RE.test(r.slug) ? r.slug : null;
  const title = str(r.title, 120);
  const prompt = str(r.prompt, LINK_PROMPT_MAX);
  const model = str(r.model_id, 120);
  if (!slug || !title || !prompt || !model || !isCreateKind(r.kind)) return null;
  const duration = typeof r.duration_s === "number" && Number.isFinite(r.duration_s) && r.duration_s > 0 ? r.duration_s : null;
  const thumb = typeof r.thumbnail_url === "string" && /^https:\/\//.test(r.thumbnail_url) ? r.thumbnail_url : null;
  return {
    slug,
    kind: r.kind,
    title,
    prompt,
    model_id: model,
    aspect: str(r.aspect, 12),
    duration_s: duration,
    quality: str(r.quality, 24),
    director: str(r.director, 400),
    thumbnail_url: thumb,
  };
}

/** The list answer: an array, or `{ templates: [...] }`. Null when the body is neither (the screen says "couldn't read"). */
export function parseTemplateList(raw: unknown): TrendTemplate[] | null {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { templates?: unknown }).templates) ? (raw as { templates: unknown[] }).templates : null;
  if (!list) return null;
  return list.map(parseTemplate).filter((t): t is TrendTemplate => t !== null);
}

/** The single answer: the template itself, or `{ template: {...} }`. */
export function parseTemplateOne(raw: unknown): TrendTemplate | null {
  const direct = parseTemplate(raw);
  if (direct) return direct;
  return raw && typeof raw === "object" ? parseTemplate((raw as { template?: unknown }).template) : null;
}

/**
 * Can this workspace start the template's model for the template's tool right now? Only a model that is on sale here,
 * makes that tool, has no lock and is not switched off. Anything else is "unavailable": the screen says so and lets the
 * person choose another model themselves. A template never silently moves to a different model (CLAUDE.md #4).
 */
export function templateModel(
  tpl: Pick<TrendTemplate, "kind" | "model_id">,
  models: readonly StudioModel[],
  switchedOff: readonly string[] = [],
): { state: "ready"; model: StudioModel } | { state: "unavailable"; reason: "not_offered" | "locked" | "switched_off" } {
  const tool = KIND_TOOL[tpl.kind];
  if (switchedOff.includes(tpl.model_id)) return { state: "unavailable", reason: "switched_off" };
  const model = models.find((m) => m.id === tpl.model_id && m.capabilities.includes(tool));
  if (!model) return { state: "unavailable", reason: "not_offered" };
  if (model.lock) return { state: "unavailable", reason: "locked" };
  return { state: "ready", model };
}

/**
 * The form a template fills. `model` is the template's own model, or "" when the person is to pick one (the template's
 * model is unavailable): the panel then shows its picker, and the settings it does not offer are dropped by the panel
 * itself, never swapped for others here.
 */
export function templatePrefill(tpl: TrendTemplate, model: string): StudioPrefill {
  const video = tpl.kind === "video";
  return {
    capability: KIND_TOOL[tpl.kind],
    model,
    prompt: tpl.director ? `${tpl.prompt}, ${tpl.director}` : tpl.prompt,
    aspect: tpl.aspect ?? "16:9",
    duration: tpl.duration_s ?? 5,
    sourceId: null,
    resolution: video ? tpl.quality : null,
    quality: !video && tpl.quality && isImageQuality(tpl.quality) ? tpl.quality : null,
  };
}

/** The alternatives offered when a template's model is unavailable: the models on sale for its tool, none locked. */
export function alternativeModels(kind: CreateKind, models: readonly StudioModel[], switchedOff: readonly string[] = []): StudioModel[] {
  const tool = KIND_TOOL[kind];
  return models.filter((m) => m.capabilities.includes(tool) && !m.lock && !switchedOff.includes(m.id));
}

// --- The Director: prompt guidance -----------------------------------------------------------------------------------

export const DIRECTOR_GROUPS = ["camera", "motion", "lighting", "palette"] as const;
export type DirectorGroup = (typeof DIRECTOR_GROUPS)[number];

/**
 * The words each preset adds to the prompt. In English on purpose: they are prompt text for the model, which is what
 * the models are best at reading, not interface copy (the chips' names are in lib/i18n). They are guidance: no model is
 * promised to follow them, and the screen says so.
 */
export const DIRECTOR_PRESETS: Readonly<Record<DirectorGroup, Readonly<Record<string, string>>>> = {
  camera: {
    wide: "wide establishing shot",
    closeUp: "close-up shot",
    lowAngle: "low-angle shot",
    overhead: "overhead top-down shot",
    handheld: "handheld camera",
  },
  motion: {
    dolly: "slow dolly-in",
    orbit: "orbiting camera move",
    pan: "smooth pan",
    still: "locked-off static camera",
    slowMo: "slow motion",
  },
  lighting: {
    golden: "golden-hour light",
    neon: "neon night lighting",
    softbox: "soft studio lighting",
    moody: "moody low-key lighting",
    daylight: "bright natural daylight",
  },
  palette: {
    warm: "warm color palette",
    cool: "cool teal and blue palette",
    mono: "black and white",
    pastel: "soft pastel palette",
    vivid: "vivid saturated colors",
  },
};

export type DirectorPicks = Partial<Record<DirectorGroup, string>>;

/** The guidance text for the picks, in group order; "" for Auto (nothing picked). Unknown keys are ignored. */
export function directorText(picks: DirectorPicks): string {
  return DIRECTOR_GROUPS.map((g) => {
    const key = picks[g];
    return key ? DIRECTOR_PRESETS[g][key] : undefined;
  })
    .filter((w): w is string => typeof w === "string")
    .join(", ");
}

/** Camera and motion mean nothing to a still picture or a voice: the Director offers only what the kind can use. */
export function directorGroupsFor(kind: CreateKind): readonly DirectorGroup[] {
  if (kind === "video") return DIRECTOR_GROUPS;
  if (kind === "image") return ["camera", "lighting", "palette"];
  return [];
}
