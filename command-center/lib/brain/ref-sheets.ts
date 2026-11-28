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

import {
  CAMERA_MOVES, CAP, FILM, SHOT_SIZES, arr, characterLine, NO_TEXT, obj, plain, readCharacters, sid,
  type Brief, type BriefCharacter, type BriefScene, type CameraMove, type ShotSize,
} from "@/lib/brain/logic";
import { MODEL_ID } from "@/lib/brain/film-models";
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
  /**
   * The idempotency key the job was (or is being) created with, saved BEFORE create_creative_job is called: when the save of the
   * job id after it fails, the next read finds the job by this key (0225 lets a member read creative_jobs.idempotency_key), so a
   * picture that was paid for is never lost from the sheet.
   */
  key?: string | null;
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

export const SHEETS_MAX = CAP.characters * (CAP.stages + 1);

/** A stored sheet list read back from the BRIEF, defensively (it is JSON a person's session wrote): anything malformed is dropped. */
export function readSheets(raw: unknown): RefSheet[] {
  if (!Array.isArray(raw)) return [];
  const out: RefSheet[] = [];
  // Never more sheets than a BRIEF can ask for (CAP.characters x (CAP.stages + the character's own look)): a list written straight
  // through 0199 is bounded here too.
  const list = raw.slice(0, SHEETS_MAX);
  const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);
  const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  for (const s of list) {
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
        key: typeof w.key === "string" && /^sheet:[0-9a-f]{48}$/.test(w.key) ? w.key : null,
      });
    }
    out.push({ character_id: o.character_id, stage: (o.stage as string | null) ?? null, views: views.slice(0, SHEET_VIEWS.length) });
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
    // Over the per-scene character cap: said as missing (drawn from words alone), never silently dropped from the report.
    if (seen.size > SELECT.characters) { missing.push(x.character_id); continue; }
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
    line: said.length ? `${REF_LINE}${said.join(" ")}` : "",
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
 * public spec as sellable_models returns it, under `inputs` (where image_refs_max already is): sellable_models projects only the
 * registry's `inputs` object, so a top-level field would never reach here, and #970 must put it under `inputs` (or extend the
 * projection). Absent: undefined, and refGate reads the adapters' own declaration. Malformed: null, unknown (closed).
 */
export function refCapabilitiesOf(spec: unknown): string[] | null | undefined {
  const o = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
  const inputs = o.inputs && typeof o.inputs === "object" ? (o.inputs as Record<string, unknown>) : {};
  const v = inputs.ref_capabilities;
  if (v === undefined) return undefined;
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
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
  const own = refCapabilitiesOf(spec);
  const caps = own !== undefined ? own : Object.prototype.hasOwnProperty.call(twin, modelId) ? [...twin[modelId]] : null;
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
export function carrySheets(prev: unknown): { ref_sheets?: RefSheet[]; film_link?: FilmLink } {
  const o = prev && typeof prev === "object" ? (prev as { ref_sheets?: unknown; film_link?: unknown }) : {};
  const sheets = readSheets(o.ref_sheets);
  const link = readFilmLink(o.film_link);
  return { ...(sheets.length ? { ref_sheets: sheets } : {}), ...(link ? { film_link: link } : {}) };
}

/**
 * The draft film the chat's choice saved its storyboard into, and which film scene each BRIEF scene became (written by the turn
 * route right after its save_film, from the film's own answer). The only link attach trusts: a film id the browser names that is
 * not this one is refused, and a scene is matched by its id here, never by position.
 */
export interface FilmLink { film_id: string; scenes: { brief: string; film: string }[] }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readFilmLink(raw: unknown): FilmLink | null {
  const o = obj(raw);
  if (typeof o.film_id !== "string" || !UUID_RE.test(o.film_id)) return null;
  const scenes = arr(o.scenes).slice(0, FILM.maxScenes).map(obj)
    .filter((x) => typeof x.brief === "string" && /^[a-z][a-z0-9_-]{0,15}$/i.test(x.brief) && typeof x.film === "string" && UUID_RE.test(x.film))
    .map((x) => ({ brief: String(x.brief), film: String(x.film) }));
  return { film_id: o.film_id, scenes };
}
/** The link from save_film's answer (0166 film_read: scenes in position order), paired with the BRIEF's scenes in story order. */
export function filmLinkOf(filmId: string, briefScenes: readonly { id: string }[], saved: unknown): FilmLink | null {
  const scenes = arr(obj(saved).scenes).map(obj);
  if (!UUID_RE.test(filmId) || scenes.length !== briefScenes.length) return null;
  const ordered = [...scenes].sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
  if (ordered.some((x) => typeof x.id !== "string" || !UUID_RE.test(x.id))) return null;
  return { film_id: filmId, scenes: briefScenes.map((b, i) => ({ brief: b.id, film: String(ordered[i].id) })) };
}

/** What the sheets need of a BRIEF, re-read through the BRIEF's own caps (never the stored jsonb cast as a Brief, BR-RS-03). */
export type SheetBrief = Pick<Brief, "characters" | "scenes" | "visual_style" | "style"> & {
  kind: Brief["kind"]; ref_sheets: RefSheet[]; film_link: FilmLink | null;
};
export function readSheetBrief(raw: unknown): SheetBrief {
  const r = obj(raw);
  const chars = readCharacters(r.characters);
  const known = new Set(chars.map((c) => c.id));
  const scenes = arr(r.scenes).slice(0, FILM.maxScenes).map(obj).map((o, i): BriefScene => {
    const inFrame = arr(o.in_frame).slice(0, CAP.characters).map(obj)
      .map((x) => ({ character_id: sid(x.character_id, ""), age_stage: typeof x.age_stage === "string" ? sid(x.age_stage, "") || null : null }))
      .filter((x) => known.has(x.character_id));
    const cam = obj(o.camera);
    const shot = SHOT_SIZES.find((x) => x === o.shot) as ShotSize | undefined;
    const move = (CAMERA_MOVES.find((x) => x === cam.move) ?? "static") as CameraMove;
    return {
      id: sid(o.id, `s${i + 1}`), n: i + 1, title: plain(o.title, CAP.title), duration_s: typeof o.duration_s === "number" ? o.duration_s : 0,
      visual_prompt: "", dialogue: [], location_id: null, prop_ids: [], clip_model: null,
      character_ids: arr(o.character_ids).slice(0, CAP.characters).map((x) => sid(x, "")).filter((x) => known.has(x)),
      keyframe_model: typeof o.keyframe_model === "string" && MODEL_ID.test(o.keyframe_model) ? o.keyframe_model : null,
      ...(shot ? { shot } : {}),
      ...(typeof cam.position === "string" ? { camera: { position: plain(cam.position, CAP.camera), move } } : {}),
      ...(typeof o.first_frame === "string" ? { first_frame: plain(o.first_frame, CAP.frame) } : {}),
      ...(inFrame.length ? { in_frame: inFrame } : {}),
    };
  });
  return {
    kind: r.kind === "short" || r.kind === "long" ? r.kind : null,
    characters: chars, scenes,
    visual_style: plain(r.visual_style, CAP.visualStyle) || undefined,
    style: plain(r.style, CAP.style) || null,
    ref_sheets: readSheets(r.ref_sheets),
    film_link: readFilmLink(r.film_link),
  };
}

const STATUS_RANK: Record<ViewStatus, number> = { planned: 0, failed: 1, making: 2, ready: 3, approved: 4 };
const sameView = (x: RefView | undefined, y: RefView | undefined) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
/**
 * Two writers of the same sheets (two tabs, or a chat turn and a press): the fresher BRIEF's list merged with ours view by view.
 * A view THIS write changed (it differs from `base`, what this request started from) is ours: an intent saved before its create,
 * a revert after a refused create, an approval, a redo. Any other view keeps the later attempt, and within one attempt the further
 * state, of the two. A view only one side has is kept. Without a compare-and-swap in the database this narrows the window to the
 * moment between the re-read and the write; it does not close it.
 */
export function mergeConcurrent(fresh: readonly RefSheet[], ours: readonly RefSheet[], base: readonly RefSheet[] = []): RefSheet[] {
  const key = (s: Pick<RefSheet, "character_id" | "stage">) => `${s.character_id}:${s.stage ?? ""}`;
  const was = new Map(base.map((s) => [key(s), s]));
  const out = new Map<string, RefSheet>(fresh.map((s) => [key(s), s]));
  for (const s of ours) {
    const f = out.get(key(s));
    if (!f) { out.set(key(s), s); continue; }
    out.set(key(s), { ...s, views: SHEET_VIEWS.map((v) => {
      const a = f.views.find((x) => x.view === v);
      const b = s.views.find((x) => x.view === v);
      if (!a || !b) return (b ?? a)!;
      if (!sameView(b, was.get(key(s))?.views.find((x) => x.view === v))) return b;
      const ra = [a.attempt ?? 0, STATUS_RANK[a.status]];
      const rb = [b.attempt ?? 0, STATUS_RANK[b.status]];
      return rb[0] > ra[0] || (rb[0] === ra[0] && rb[1] >= ra[1]) ? b : a;
    }).filter(Boolean) });
  }
  // Never cut to SHEETS_MAX here: a sheet past the 40th may hold a paid job's id. The writer refuses a longer list by name
  // (too_many_sheets), as 0249 does.
  return [...out.values()];
}

/** The reference line attach adds to a key-frame prompt; an older one is replaced, never added twice. */
export const REF_LINE = "Reference pictures: ";
export function withRefLine(prompt: string, line: string): string {
  const kept = prompt.split("\n").filter((l) => !l.startsWith(REF_LINE)).join("\n");
  return line ? `${kept}\n${line}` : kept;
}
