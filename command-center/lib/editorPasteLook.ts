/**
 * Paste attributes (Premiere's "Paste Attributes", CapCut's "Copy / paste effects") and look presets: a picture
 * clip's look, copied from one clip and put on others, group by group, or saved under a name in this browser.
 *
 * A look is only fields a V clip already has; nothing new reaches the document. The groups are made from the
 * validator's own field list (`V_CLIP_FIELDS`, `CLIP_EFFECT_FIELDS` in lib/editor.ts), and a test holds every field
 * of that list to a group here or to `NOT_LOOK`, so a field added later cannot be left out by accident.
 *
 * A pasted group REPLACES that group on the clip (a clip pasted the "Colour" of a clip with no colour has none
 * after it), so the clips end up looking alike. A value the target cannot take (a fade longer than a short clip, a
 * clip's own-sound setting on a picture) is skipped for that clip, never forced: the result is held to
 * `validateTimeline` here, and the editor then settles it (`settleAll`) like any edit, which keeps the export's
 * budgets (a mask on a cross-faded clip in a 4K frame, an entrance longer than half a short clip).
 */
import {
  CLIP_EFFECT_FIELDS,
  V_CLIP_FIELDS,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type EditorModel,
  type VideoClip,
} from "@/lib/editor";

/** The groups a person ticks, in the order the dialog shows them. */
export const LOOK_GROUPS = ["effects", "grade", "color", "mask", "fx", "motion", "anims", "fades", "audio"] as const;
export type LookGroup = (typeof LOOK_GROUPS)[number];

/** The fields of each group. `effects` is the validator's own effect list (filters, vignette, blur, sharpen,
 *  grain, the mirror and the turn). */
export const GROUP_FIELDS: Record<LookGroup, readonly string[]> = {
  effects: CLIP_EFFECT_FIELDS,
  grade: ["grade"],
  color: ["color"],
  mask: ["mask"],
  fx: ["fx"],
  /** The picture's place in the frame: fit, the move (zoom / pan), crop and free angle. */
  motion: ["fit", "move", "crop", "angle"],
  anims: ["anim_in", "anim_out", "anim_in_s", "anim_out_s"],
  fades: ["fade_in_s", "fade_out_s"],
  /** The clip's own sound: its level, noise reduction and loudness. */
  audio: ["gain_db", "denoise", "loudnorm"],
};

/**
 * The V-clip fields that are not a look, and why: what and where the clip is (id, file, place, part of the file),
 * its timing (speed, a curve, backwards, a held frame: they change its length, and with it the whole timeline),
 * whether its sound plays (the mix has a limit), the way into it (a cross-fade belongs to its place, as a paste
 * already rules), and the two that are charged to the export's time per project and depend on speed and frame
 * size (smooth slow motion, steadying).
 */
export const NOT_LOOK: readonly string[] = [
  "id",
  "asset_id",
  "start_s",
  "in_s",
  "out_s",
  "speed",
  "speed_curve",
  "reverse",
  "freeze",
  "audio",
  "transition",
  "interpolate",
  "stabilize",
];

export const LOOK_FIELDS: readonly string[] = LOOK_GROUPS.flatMap((g) => GROUP_FIELDS[g]);

/** A copied look: the look fields a clip has (deep copies), nothing else. */
export type Look = Partial<Record<string, unknown>>;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The look of clip `c`: every look field it has. */
export function copyLook(c: VideoClip): Look {
  const src = c as unknown as Record<string, unknown>;
  const out: Look = {};
  for (const k of LOOK_FIELDS) if (src[k] !== undefined) out[k] = clone(src[k]);
  return out;
}

/** The groups a look has something in (the dialog ticks these; the others would only clear). */
export function groupsIn(look: Look): LookGroup[] {
  return LOOK_GROUPS.filter((g) => GROUP_FIELDS[g].some((k) => look[k] !== undefined));
}

/** Why a group was not put on a clip. */
export type SkipReason = "kind" | "invalid";
export interface LookSkip {
  clip: string;
  group: LookGroup;
  why: SkipReason;
}

/** Clip `c` with `groups` of `look` in place of its own (the group's fields the look does not have are removed). */
function withGroups(c: VideoClip, look: Look, groups: readonly LookGroup[]): VideoClip {
  const out = { ...c } as unknown as Record<string, unknown>;
  for (const g of groups)
    for (const k of GROUP_FIELDS[g]) {
      if (look[k] === undefined) delete out[k];
      else out[k] = clone(look[k]);
    }
  return out as unknown as VideoClip;
}

/** Groups a clip of this kind never takes: a picture has no sound of its own. */
function kindRefuses(kind: EditorAsset["kind"] | undefined, g: LookGroup): boolean {
  return g === "audio" && kind === "image";
}

/**
 * `look`'s `groups` put on the picture clips `ids` (ids that are not picture clips are ignored). Held to the
 * validator: when the whole paste is a document the validator accepts it is the answer; otherwise each clip takes
 * the groups one by one and keeps those that leave the document as valid as it was. The same model back when
 * nothing changes.
 */
export function pasteLook(
  model: EditorModel,
  ids: readonly string[],
  look: Look,
  groups: readonly LookGroup[],
  kindOf: (assetId: string) => EditorAsset["kind"] | undefined = () => undefined,
): { model: EditorModel; changed: number; skipped: LookSkip[] } {
  const want = new Set(ids);
  const skipped: LookSkip[] = [];
  const plan = new Map<string, LookGroup[]>();
  for (const c of model.clips) {
    if (!want.has(c.id)) continue;
    const ok: LookGroup[] = [];
    for (const g of groups) {
      if (kindRefuses(kindOf(c.asset_id), g)) skipped.push({ clip: c.id, group: g, why: "kind" });
      else ok.push(g);
    }
    plan.set(c.id, ok);
  }
  const problems = (m: EditorModel) => validateTimeline(toDoc(m)).length;
  const base = problems(model);
  const put = (m: EditorModel, id: string, gs: readonly LookGroup[]): EditorModel => ({
    ...m,
    clips: m.clips.map((c) => (c.id === id ? withGroups(c, look, gs) : c)),
  });
  let next = model;
  for (const [id, gs] of plan) next = put(next, id, gs);
  if (problems(next) > base) {
    // Something does not fit some clip: clip by clip, group by group, only what keeps the document valid.
    next = model;
    for (const [id, gs] of plan) {
      const kept: LookGroup[] = [];
      for (const g of gs) {
        const tryIt = put(next, id, [...kept, g]);
        if (problems(tryIt) > base) skipped.push({ clip: id, group: g, why: "invalid" });
        else kept.push(g);
      }
      next = put(next, id, kept);
    }
  }
  const before = new Map(model.clips.map((c) => [c.id, JSON.stringify(c)]));
  const changed = next.clips.filter((c) => want.has(c.id) && before.get(c.id) !== JSON.stringify(c)).length;
  return { model: changed ? next : model, changed, skipped };
}

// ── presets, kept in this browser ──────────────────────────────────────────

export const PRESET_VERSION = 1;
export const MAX_PRESETS = 24;
export const MAX_PRESET_NAME = 40;
/** The most the stored list may take (it is read whole on every open). */
export const MAX_PRESET_BYTES = 64 * 1024;

export interface LookPreset {
  name: string;
  look: Look;
}

const storeKey = (userId?: string | null) => `ns:editor:look-presets:v${PRESET_VERSION}:${userId || "anon"}`;

/** A name as it is kept: no control characters, spaces collapsed, at most MAX_PRESET_NAME characters. */
export function cleanPresetName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Control, zero-width and direction characters would let a name hide or reorder what is shown next to it.
  const bad = (c: number) =>
    c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
  const plain = Array.from(raw)
    .map((ch) => (bad(ch.codePointAt(0) ?? 0) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(plain).slice(0, MAX_PRESET_NAME).join("").trim();
}

/** A document that is valid without any look: one ten-second clip of a 1080p, 30 fps picture. */
const PROBE_ASSET = "00000000-0000-4000-8000-000000000001";
function probe(c: Partial<VideoClip> = {}): EditorModel {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    clips: [{ id: "c1", asset_id: PROBE_ASSET, start_s: 0, in_s: 0, out_s: 10, speed: 1, audio: true, ...c }],
    texts: [],
    sounds: [],
    keep: [],
  };
}

/**
 * A stored look made safe: only look fields, and of those only the groups a ten-second picture clip takes as the
 * validator rules (a group with a value it refuses is dropped whole). Anything else comes back as an empty look.
 */
export function sanitizeLook(raw: unknown): Look {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  let look: Look;
  try {
    look = {};
    for (const k of LOOK_FIELDS)
      if (Object.prototype.hasOwnProperty.call(raw, k)) {
        const v = (raw as Record<string, unknown>)[k];
        if (v !== undefined) look[k] = clone(v);
      }
  } catch {
    return {};
  }
  const out: Look = {};
  for (const g of groupsIn(look)) {
    const part: Look = {};
    for (const k of GROUP_FIELDS[g]) if (look[k] !== undefined) part[k] = look[k];
    const m = probe(part as Partial<VideoClip>);
    let ok = false;
    try {
      ok = validateTimeline(toDoc(m)).length === 0;
    } catch {
      ok = false;
    }
    if (ok) Object.assign(out, part);
  }
  // As the editor holds a look (a "no change" grade or colour is none), so a preset pastes what a copy would.
  try {
    return copyLook(toModel(toDoc(probe(out as Partial<VideoClip>))).clips[0]);
  } catch {
    return {};
  }
}

/** The saved presets, each made safe; an empty list for nothing saved, an unreadable or oversized value, another
 *  version, or a browser that will not say. Never throws. */
export function loadPresets(userId?: string | null): LookPreset[] {
  let raw: string | null = null;
  try {
    raw = typeof localStorage === "undefined" ? null : localStorage.getItem(storeKey(userId));
  } catch {
    return [];
  }
  return parsePresets(raw);
}

/** The stored text read back as presets (what `loadPresets` does after reading it). */
export function parsePresets(raw: string | null): LookPreset[] {
  if (typeof raw !== "string" || !raw || raw.length > MAX_PRESET_BYTES) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  if (o.v !== PRESET_VERSION || !Array.isArray(o.presets)) return [];
  const out: LookPreset[] = [];
  const names = new Set<string>();
  for (const p of o.presets.slice(0, MAX_PRESETS)) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) continue;
    const name = cleanPresetName((p as Record<string, unknown>).name);
    if (!name || names.has(name.toLowerCase())) continue;
    const look = sanitizeLook((p as Record<string, unknown>).look);
    if (!groupsIn(look).length) continue;
    names.add(name.toLowerCase());
    out.push({ name, look });
  }
  return out;
}

/** The text a list is stored as. */
export function serializePresets(list: readonly LookPreset[]): string {
  return JSON.stringify({ v: PRESET_VERSION, presets: list });
}

export type PresetProblem = "no_name" | "empty" | "full" | "too_large";

/**
 * The list with `look` saved as `name` (a preset of the same name, any case, is replaced), or why not: no name, a
 * look with nothing in it, MAX_PRESETS already, or more than MAX_PRESET_BYTES in all.
 */
export function withPreset(
  list: readonly LookPreset[],
  name: string,
  look: Look,
): { list: LookPreset[] } | { problem: PresetProblem } {
  const n = cleanPresetName(name);
  if (!n) return { problem: "no_name" };
  const safe = sanitizeLook(look);
  if (!groupsIn(safe).length) return { problem: "empty" };
  const rest = list.filter((p) => p.name.toLowerCase() !== n.toLowerCase());
  if (rest.length >= MAX_PRESETS) return { problem: "full" };
  const next = [...rest, { name: n, look: safe }];
  if (serializePresets(next).length > MAX_PRESET_BYTES) return { problem: "too_large" };
  return { list: next };
}

/** Keep the list in this browser; false when the browser would not (private window, storage full). */
export function savePresets(list: readonly LookPreset[], userId?: string | null): boolean {
  try {
    const text = serializePresets(list);
    if (text.length > MAX_PRESET_BYTES) return false;
    localStorage.setItem(storeKey(userId), text);
    return true;
  } catch {
    return false;
  }
}

export const presetStoreKey = storeKey;

/** Every look field is a group's or named as no look (the test of that lives in tests/editor-look.test.ts). */
export function unclassifiedFields(): string[] {
  return V_CLIP_FIELDS.filter((k) => !LOOK_FIELDS.includes(k) && !NOT_LOOK.includes(k));
}
