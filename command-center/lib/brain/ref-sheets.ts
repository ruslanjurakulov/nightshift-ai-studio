/**
 * Character reference sheets for a story film (docs/studio/NIGHTSHIFT_AI.md, "Character sheets"). Pure: no network, no database.
 *
 * Ported and adapted from HKUDS/ViMax @ 01b4696ebb54805dc465f5f815f5ee87891909d8 (MIT License, Copyright (c) 2025; see
 * THIRD_PARTY_NOTICES):
 *   - the three portrait prompts (prompt_template_front / _side / _back of agents/character_portraits_generator.py), and the order
 *     they are made in: the front from words alone, the side and the back from the front;
 *   - the reference rules of agents/reference_image_selector.py (at most 8 pictures, at most one view per character, the view the
 *     shot shows the character from, the newest picture, and "Image N" counted from 0 by position in the selected list);
 *   - the per-scene character with its own look (interfaces/character.py CharacterInScene: static and dynamic features), which here
 *     is the BRIEF's look sheet at the scene's age stage.
 * Written here, not ported: ViMax asks a language model to choose the pictures; this is deterministic code (the same scene always
 * gets the same pictures, and nothing is spent choosing them). The sheet plan's storage on the BRIEF, the age stages, the caps on
 * characters and the model's own limit, and the gate below are Nightshift's own.
 */

import { characterLine, NO_TEXT, plain, type Brief, type BriefCharacter, type BriefScene } from "@/lib/brain/logic";
// The adapters' own reference_capabilities, per registry model (tools/ref_capabilities_twin.py writes it from modules/capabilities;
// tests/test_ref_capabilities_twin.py fails when it drifts). Read only where the registry row has no ref_capabilities of its own.
import REF_TWIN from "@/lib/brain/ref-capabilities.json";

export type SheetView = "front" | "side" | "back";
export const SHEET_VIEWS: readonly SheetView[] = ["front", "side", "back"];
/**
 * planned: no job yet (or a redo asked for a new one); making: a creative job holds its credits and runs; ready: made, waiting for
 * the person; approved: the person kept it, the only state the selector uses; failed: the job ended without a picture (refunded).
 */
export type ViewStatus = "planned" | "making" | "ready" | "approved" | "failed";
export interface RefView {
  view: SheetView;
  prompt: string;
  asset_id: string | null;
  status: ViewStatus;
  /** The creative job that makes it (0036). The panel reads its state on every load, so a refresh mid-job loses nothing. */
  job_id?: string | null;
  /** 0-based; a redo or a retry is the next attempt, so its idempotency key (and its job, and its price) is a new one. */
  attempt?: number;
  /** The job's own error code when it failed (a machine word), never its text. */
  error?: string | null;
}
export interface RefSheet { character_id: string; stage: string | null; views: RefView[] }

/** One character's line as every key-frame prompt says it (lib/brain/logic characterLine): the look sheet verbatim, at the stage. */
const IDENTITY = (c: BriefCharacter, stage: string | null) => {
  const label = stage ? (c.age_stages ?? []).find((a) => a.id === stage)?.label : undefined;
  return label ? `${c.name} (${label})` : c.name;
};

// ViMax's templates, word for word up to the character's name; the canvas is always 16:9 (ViMax's own choice: a wide canvas leaves
// room around a standing figure), whatever the film's aspect, because a sheet is a reference, never a frame of the film.
const CANVAS = "Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, "
  + "occupying the middle of the wide frame with enough horizontal empty space.";
const TEMPLATES: Record<SheetView, (id: string) => string> = {
  front: (id) => `Generate a full-body, front-view portrait of character ${id} based on the following description, with a pure white `
    + `background. ${CANVAS} Gazing straight ahead. Standing with arms relaxed at sides. Natural expression.`,
  side: (id) => `Generate a full-body, side-view portrait of character ${id} based on the provided front-view portrait, with a pure `
    + `white background. ${CANVAS} Facing left. Standing with arms relaxed at sides.`,
  back: (id) => `Generate a full-body, back-view portrait of character ${id} based on the provided front-view portrait, with a pure `
    + `white background. ${CANVAS} No facial features should be visible.`,
};

/**
 * One view's prompt, in English: ViMax's template, then the look sheet verbatim (the same words lib/brain/logic folds into every
 * key frame, so the sheet and the scenes describe one person), the film's visual style and the no-text rule.
 * Adapted: ViMax gives the side and the back only the front picture. Here they carry the look and the style too: an edit model
 * that reads only "the provided portrait" re-draws the outfit's colours and the art style at will, and the sheet would then
 * disagree with the scenes it is meant to steer.
 */
export function sheetPrompt(b: Pick<Brief, "visual_style" | "style">, c: BriefCharacter, stage: string | null, view: SheetView): string {
  const style = b.visual_style || b.style;
  return plain([
    TEMPLATES[view](IDENTITY(c, stage)),
    `Features: ${characterLine(c, stage)}`,
    NO_TEXT,
    style ? `Style: ${style}` : "",
  ].filter(Boolean).join("\n"), Number.MAX_SAFE_INTEGER, true);
}

/** The (character, stage) pairs the scenes show: a stage a scene names, or the character's own look where a scene names none. */
function stagesShown(b: Pick<Brief, "scenes">, c: BriefCharacter): (string | null)[] {
  const stages = (c.age_stages ?? []).map((a) => a.id);
  if (!stages.length) return [null];
  const shown = new Set<string | null>(stages);
  // A scene that shows a staged character without naming a stage is drawn from the character's own look (characterLine): it needs
  // that sheet too, but only when there is such a look to draw.
  if (c.look && (b.scenes ?? []).some((s) => inFrameOf(s).some((x) => x.character_id === c.id && !x.age_stage))) shown.add(null);
  return [...shown];
}

/** The sheets a BRIEF asks for: front, side and back per character and per age stage, every view still to make. */
export function planSheets(b: Pick<Brief, "characters" | "scenes" | "visual_style" | "style">): RefSheet[] {
  const out: RefSheet[] = [];
  for (const c of b.characters ?? []) {
    for (const stage of stagesShown(b, c)) {
      out.push({ character_id: c.id, stage, views: SHEET_VIEWS.map((view) => ({ view, prompt: sheetPrompt(b, c, stage, view), asset_id: null, status: "planned" as const })) });
    }
  }
  return out;
}

/** A stored sheet list read back from the BRIEF, defensively (it is JSON a person's session wrote): anything malformed is dropped. */
export function readSheets(raw: unknown): RefSheet[] {
  if (!Array.isArray(raw)) return [];
  const out: RefSheet[] = [];
  const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);
  const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (!isId(o.character_id) || !(o.stage === null || isId(o.stage)) || !Array.isArray(o.views)) continue;
    const views: RefView[] = [];
    for (const v of o.views) {
      const w = (v ?? {}) as Record<string, unknown>;
      if (!SHEET_VIEWS.includes(w.view as SheetView) || typeof w.prompt !== "string") continue;
      const status = (["planned", "making", "ready", "approved", "failed"] as const).find((x) => x === w.status) ?? "planned";
      views.push({
        view: w.view as SheetView, prompt: w.prompt, asset_id: isUuid(w.asset_id) ? w.asset_id : null, status,
        job_id: isUuid(w.job_id) ? w.job_id : null,
        attempt: typeof w.attempt === "number" && Number.isInteger(w.attempt) && w.attempt >= 0 && w.attempt < 1000 ? w.attempt : 0,
        error: typeof w.error === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(w.error) ? w.error : null,
      });
    }
    out.push({ character_id: o.character_id, stage: (o.stage as string | null) ?? null, views });
  }
  return out;
}

/**
 * The plan as the BRIEF says it now, with what was already made kept: a view whose prompt is unchanged keeps its job, its picture
 * and the person's approval. A view whose look changed starts again as planned (its old picture shows someone else now); a sheet
 * of a character the story no longer has is dropped from the BRIEF (its pictures stay in the library).
 */
export function mergeSheets(prev: readonly RefSheet[] | undefined, plan: readonly RefSheet[]): RefSheet[] {
  return plan.map((p) => {
    const old = (prev ?? []).find((x) => x.character_id === p.character_id && x.stage === p.stage);
    return { ...p, views: p.views.map((v) => {
      const o = old?.views.find((x) => x.view === v.view);
      if (!o) return v;
      // The attempt counter survives a changed prompt: a new job must never reuse an old attempt's idempotency key.
      if (o.prompt !== v.prompt) return { ...v, attempt: (o.attempt ?? 0) + (o.job_id ? 1 : 0) };
      return o;
    }) };
  });
}

/** A view the person can have made now: the front at any time, the side and the back once their front has a picture. */
export function makeable(sheet: RefSheet, v: RefView): boolean {
  if (v.status !== "planned" && v.status !== "failed") return false;
  if (v.view === "front") return true;
  const front = sheet.views.find((x) => x.view === "front");
  return !!front?.asset_id && (front.status === "ready" || front.status === "approved");
}

// ---- the per-scene selector (ViMax reference_image_selector's rules, as code) ----

/** At most 4 characters per scene (the smallest per-model character limit documented for the key-frame models), 8 pictures. */
export const SELECT = { characters: 4, refs: 8 } as const;

function inFrameOf(s: Pick<BriefScene, "in_frame" | "character_ids">): { character_id: string; age_stage: string | null }[] {
  return s.in_frame?.length ? s.in_frame : s.character_ids.map((id) => ({ character_id: id, age_stage: null }));
}

// The facing a shot implies, read from the words the storyboard already has (camera position, first frame). Kept deliberately
// small: a phrase that plainly says "from behind" or "in profile". Anything else is the front, which is what a wide, two-shot,
// medium or close shot of a character shows in the storyboards the plan writes.
const BACK = /\b(from behind|behind (him|her|them)|back to (the )?camera|back view|rear view|seen from the back|from the back)\b/i;
const SIDE = /\b(in profile|profile view|side view|from the side|side-on|side on)\b/i;

/** The view ViMax's rule asks for: the one the shot shows the character from. Every shot size (over-the-shoulder and inserts too)
 *  reads its facing from those words alone; the shot size never decides it. Applied to every character in the scene. */
export function wantedView(s: Pick<BriefScene, "camera" | "first_frame">): SheetView {
  const text = `${s.camera?.position ?? ""} ${s.first_frame ?? ""}`;
  if (BACK.test(text)) return "back";
  if (SIDE.test(text)) return "side";
  return "front";
}

export interface ScenePick { character_id: string; stage: string | null; wanted: SheetView; view: SheetView; asset_id: string; image: number }
export interface SceneSelection {
  refs: { kind: "character"; asset_id: string }[];
  picks: ScenePick[];
  /** In-frame characters with no approved sheet for their stage: drawn from words alone, said by the panel, never another stage's. */
  missing: string[];
  /** The line the key-frame prompt gains: who is which "Image N". Empty when nothing was selected. */
  line: string;
  /** Why this scene can take none of its pictures, by name: a picture whose size or type is not known to fit (never guessed). */
  refused?: "ref_size_unknown" | "ref_type_not_taken" | "refs_too_large";
}

/** A library picture as the selector needs it (media_assets.bytes and mime, read under the person's session). */
export interface AssetFacts { bytes: number | null; mime: string | null }
/** The picture types every key-frame adapter that takes references reads (Nano Banana's: PNG, JPEG, WebP library files). */
export const REF_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
/** 14 MiB of pictures per call: Nano Banana's adapter limit (MAX_TOTAL_IMAGE_BYTES), the smallest of the models that take them. */
export const REF_BYTES_MAX = 14 * 1024 * 1024;

/**
 * What the model receives before this scene's own pictures (the film's references, 0198 film_take_job puts them first): their
 * count, so "Image N" counts as the model does, and their bytes, so the total stays under REF_BYTES_MAX.
 */
export interface RefBudget { offset: number; offsetBytes: number; maxPictures: number }

/**
 * One scene's reference pictures. Per in-frame character (first 4), the approved view the shot implies; when that view is not
 * approved, the front (the picture of the same person and stage, named in `picks.wanted` so the swap is never silent). Never a
 * different age stage: a child's scene steered by the adult's face is the failure the stages exist to prevent (rule 4).
 * `maxPictures`: the model's own image_refs_max (and the worker's 16), counting the film's pictures. A picture whose size or type
 * is unknown is not counted as small: the scene is refused by name, so the person learns it before any take is priced.
 */
export function selectRefs(b: Pick<Brief, "characters">, sheets: readonly RefSheet[], s: BriefScene, budget: RefBudget,
                           assets: ReadonlyMap<string, AssetFacts>): SceneSelection {
  const cap = Math.max(0, Math.min(SELECT.refs, budget.maxPictures - budget.offset));
  const picks: ScenePick[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  let bytes = budget.offsetBytes;
  let refused: SceneSelection["refused"];
  for (const x of inFrameOf(s)) {
    if (seen.has(x.character_id)) continue;
    seen.add(x.character_id);
    if (seen.size > SELECT.characters) break;
    const sheet = sheets.find((h) => h.character_id === x.character_id && h.stage === (x.age_stage ?? null));
    const wanted = wantedView(s);
    const ok = (v: SheetView) => sheet?.views.find((w) => w.view === v && w.status === "approved" && w.asset_id);
    const got = ok(wanted) ?? ok("front");
    if (!got || picks.length >= cap) { missing.push(x.character_id); continue; }
    const f = assets.get(got.asset_id!);
    if (!f || f.bytes === null || !Number.isFinite(f.bytes) || f.bytes <= 0) { refused = "ref_size_unknown"; break; }
    if (!f.mime || !REF_MIMES.includes(f.mime)) { refused = "ref_type_not_taken"; break; }
    if (bytes + f.bytes > REF_BYTES_MAX) { refused = "refs_too_large"; break; }
    bytes += f.bytes;
    picks.push({ character_id: x.character_id, stage: x.age_stage ?? null, wanted, view: got.view, asset_id: got.asset_id!, image: budget.offset + picks.length });
  }
  if (refused) return { refs: [], picks: [], missing: [], line: "", refused };
  const names = new Map((b.characters ?? []).map((c) => [c.id, c]));
  const said = picks.map((p) => {
    const c = names.get(p.character_id);
    return `${c ? IDENTITY(c, p.stage) : p.character_id} should reference Image ${p.image}.`;
  });
  return {
    refs: picks.map((p) => ({ kind: "character" as const, asset_id: p.asset_id })),
    picks, missing,
    // ViMax's text_prompt rule: name each reference as "Image N" and nothing else.
    line: said.length ? `Reference pictures: ${said.join(" ")}` : "",
  };
}

// ---- the gate: may the film's key-frame model use these pictures on the worker's path? ----

/** The capability the worker makes every key frame with (0198 film_take_job: a key frame is always t2i). */
export const KEYFRAME_CAPABILITY = "t2i";

export type GateReason =
  | "model_not_set" | "not_on_sale" | "terms_gated" | "adult_attestation_required" | "refs_unknown" | "refs_not_on_keyframe" | "no_ref_slots";
export type RefGate = { open: true; imageRefsMax: number } | { open: false; reason: GateReason };

/**
 * The registry's `ref_capabilities` (S2, #970): which of a model's capabilities take reference pictures. Read from the model's
 * public spec as sellable_models returns it, at the top or under `inputs` (where image_refs_max already is). Absent, malformed, or
 * two places that disagree: null, which is unknown here (refGate then reads the adapters' own declaration, never the model's name).
 */
export function refCapabilitiesOf(spec: unknown): string[] | null {
  const o = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
  const read = (v: unknown): string[] | null | undefined =>
    v === undefined ? undefined : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  const top = read(o.ref_capabilities);
  const inputs = o.inputs && typeof o.inputs === "object" ? read((o.inputs as Record<string, unknown>).ref_capabilities) : undefined;
  if (top === null || inputs === null) return null;
  if (top && inputs && (top.length !== inputs.length || top.some((x) => !inputs.includes(x)))) return null;
  return top ?? inputs ?? null;
}

export interface GateModel { id: string; spec: unknown }

/**
 * Open only when every fact holds: the film has a key-frame model; it is on sale for t2i now (sellable_models: priced, probed, no
 * open terms gate); its spec says no terms gate; the person meets its 18+ condition; its ref_capabilities include t2i (the
 * registry's, else its adapter's own declaration through the twin);
 * it takes at least one picture. Anything unknown keeps it closed: a closed gate costs nothing, an open one that the worker refuses
 * (creative_adapters: references on a capability that cannot take them are a bad_request) is a priced film that fails at submit.
 */
export function refGate(modelId: string | null, onSaleT2i: readonly GateModel[], age: "adult" | "minor" | "none" | "unknown",
                        twin: Readonly<Record<string, readonly string[]>> = REF_TWIN.models): RefGate {
  if (!modelId) return { open: false, reason: "model_not_set" };
  const m = onSaleT2i.find((x) => x.id === modelId);
  if (!m) return { open: false, reason: "not_on_sale" };
  const spec = (m.spec && typeof m.spec === "object" ? m.spec : {}) as Record<string, unknown>;
  if (spec.terms_gate !== undefined && spec.terms_gate !== null) return { open: false, reason: "terms_gated" };
  if (spec.requires_adult === true && age !== "adult") return { open: false, reason: "adult_attestation_required" };
  // The registry's field first (S2, #970); where a row has none, what the model's adapter declares (the twin); neither: unknown.
  const caps = refCapabilitiesOf(spec) ?? (Object.prototype.hasOwnProperty.call(twin, modelId) ? [...twin[modelId]] : null);
  if (caps === null) return { open: false, reason: "refs_unknown" };
  if (!caps.includes(KEYFRAME_CAPABILITY)) return { open: false, reason: "refs_not_on_keyframe" };
  const inputs = (spec.inputs && typeof spec.inputs === "object" ? spec.inputs : {}) as Record<string, unknown>;
  const max = inputs.image_refs_max;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) return { open: false, reason: "no_ref_slots" };
  return { open: true, imageRefsMax: max };
}

/**
 * The sheets a BRIEF already holds, for a route that writes the BRIEF anew (choosing the storyboard again, pricing it): without
 * this, a re-save dropped the job ids of pictures the person paid for. Whatever no longer matches the story is re-planned when the
 * sheets are next read (mergeSheets), never shown as the new look's.
 */
export function carrySheets(prev: unknown): { ref_sheets?: RefSheet[] } {
  const sheets = readSheets(prev && typeof prev === "object" ? (prev as { ref_sheets?: unknown }).ref_sheets : undefined);
  return sheets.length ? { ref_sheets: sheets } : {};
}
