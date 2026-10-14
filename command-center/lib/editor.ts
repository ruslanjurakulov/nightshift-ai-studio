/**
 * The video editor (migration 0054) — the pure, client-safe half.
 *
 * An edit is DATA: a timeline document (schemas/timeline.schema.json) that the
 * media worker renders with the existing ffmpeg engine (modules/timeline.py →
 * modules/timeline_render.py). This file holds:
 *
 *   * the editor's model of a document (one picture track laid end to end,
 *     text on top, music and sound effects under it) and the free tools as
 *     pure functions on it — trim, split, speed, clip sound, cross-fade, add /
 *     change / remove text, add / place / trim / mix sounds;
 *   * `validateTimeline`, the twin of modules/timeline.py `validate` — the
 *     save route runs it before the database is asked, and
 *     tests/editor-timeline.test.ts and tests/test_editor_doc_cases.py run the
 *     same cases through both so the two never drift apart;
 *   * `docAssetProblems`, the twin of timeline.resolve_assets' kind check:
 *     which files a document may use on which track (the database checks
 *     whose files they are);
 *   * the database's refusals mapped to words the page has sentences for.
 *
 * Nothing here spends, renders or publishes. An export is free (no credits,
 * no provider) and ends as a file in the library.
 */

import { CAPTION_STYLE_IDS, isCaptionStyleId } from "@/lib/captionStyleTable";
import {
  GRADE_KEYS,
  GRADE_RANGES,
  isNeutralGrade,
  type ClipGrade,
} from "@/lib/editorGrade";

// ── limits (modules/timeline.py, render_spec.py and 0054 hold the same) ─────

export const TIMELINE_VERSION = 1;
export const FPS_VALUES = [24, 25, 30, 50, 60] as const;
export const EDITOR_FPS = 30;
export const MIN_SIDE = 16;
export const MAX_SIDE = 4096;
/** The largest frame an export renders, 4K UHD either way (modules/timeline.py
 *  MAX_FRAME_PIXELS): larger frames do not fit the export's memory limit. */
export const MAX_FRAME_PIXELS = 3840 * 2160;
export const MAX_DURATION_S = 4 * 3600;
export const MAX_TRACKS = 32;
export const MAX_CLIPS_PER_TRACK = 2000;
export const MAX_AUDIO_CLIPS = 64;
export const MAX_TOTAL_CLIPS = 5000;
export const MAX_CUES = 5000;
export const MAX_TEXT = 500;
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
/** The speeds the editor offers (any value in 0.25–4 is valid in a document). */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const SIZE_MIN = 8;
export const SIZE_MAX = 512;
/** The text sizes the editor's slider offers, in output pixels. */
export const TEXT_SIZE_MIN = 24;
export const TEXT_SIZE_MAX = 200;
export const GAIN_DB_MIN = -60;
export const GAIN_DB_MAX = 12;
/** Music ducking (modules/timeline.py DUCK_*): a track is lowered by an exact
 *  amount while speech plays. The slider offers a narrower range than a
 *  document may hold: under 3 dB is hard to hear, over 30 dB is a mute. */
export const ROLES = ["music", "speech"] as const;
export const DUCK_DB_MIN = 1;
export const DUCK_DB_MAX = 40;
export const DUCK_ATTACK_MIN_S = 0.05;
export const DUCK_ATTACK_MAX_S = 2;
export const DUCK_RELEASE_MIN_S = 0.1;
export const DUCK_RELEASE_MAX_S = 5;
export const DUCK_UI_MIN_DB = 3;
export const DUCK_UI_MAX_DB = 30;
/** What switching ducking on starts with (the document's own defaults for
 *  attack and release; the amount is a clearly audible 12 dB). */
export const DUCK_DEFAULT: Duck = { amount_db: 12, attack_s: 0.3, release_s: 0.8 };
/** The volume slider's range for a sound: quieter than -40 dB is inaudible
 *  under a voice, louder than +6 dB clips; a typed number may use 12 dB. */
export const GAIN_UI_MIN = -40;
export const GAIN_UI_MAX = 6;
/** The longest fade the editor offers on a sound, in seconds. */
export const SOUND_FADE_MAX_S = 10;
/** A cross-fade's length (modules/timeline.py XFADE_MIN_S / XFADE_MAX_S). */
export const XFADE_MIN_S = 0.2;
export const XFADE_MAX_S = 2;
/** The cross-fade a new one starts with. */
export const XFADE_DEFAULT_S = 0.5;
/** Overlap and cross-fade must agree to within half a millisecond. */
const XFADE_TOLERANCE = 0.0005;
export const OUTLINE_MAX = 20;
/** The longest export (0054 request_editor_export, modules/editor_export.py). */
export const EXPORT_MAX_S = 1800;
/** The shortest clip a trim may leave, in seconds. */
export const MIN_CLIP_S = 0.1;
/** The most clips the editor lets one picture track hold: each one's own
 *  sound is an input of the final mix (MAX_AUDIO_CLIPS). */
export const MAX_EDITOR_CLIPS = MAX_AUDIO_CLIPS;
/** The most texts: each is its own track, and a document has at most 32. */
export const MAX_EDITOR_TEXTS = 24;
/** The most music / sound-effect clips: each is its own A track too (so two
 *  can play at once), and 1 + 24 + 6 tracks stays under the 32 allowed. */
export const MAX_EDITOR_SOUNDS = 6;
export const MAX_DOC_BYTES = 262_144;
/** Picture overlays (modules/timeline.py MAX_OVERLAYS / MAX_OVERLAY_VIDEOS /
 *  OVERLAY_W_MIN / OVERLAY_W_MAX): each is one more input of the final pass,
 *  and a video keeps a decoder open for its whole span. */
export const MAX_OVERLAYS = 16;
export const MAX_OVERLAY_VIDEOS = 4;
export const OVERLAY_W_MIN = 0.05;
export const OVERLAY_W_MAX = 1;

const FITS = ["contain", "cover", "blur"] as const;
const TRANSITIONS = ["cut", "dip_to_black", "crossfade"] as const;
/** The ffmpeg `xfade` transitions a cross-fade may use, in the order the
 *  picker lists them (modules/timeline.py XFADE_STYLES; a test pins them). The
 *  name goes into a filter graph, so the list is closed. `fade` is the plain
 *  blend every older document has; it is never stored (the document without a
 *  style is the same cross-fade). */
export const XFADE_STYLES = [
  "fade",
  "dissolve",
  "fadeblack",
  "fadewhite",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
  "slideup",
  "slidedown",
  "circleopen",
  "circleclose",
  "radial",
  "zoomin",
  "wipeup",
  "wipedown",
  "smoothleft",
  "smoothright",
  "smoothup",
  "smoothdown",
  "vertopen",
  "vertclose",
  "horzopen",
  "horzclose",
  "diagtl",
  "diagtr",
  "diagbl",
  "diagbr",
  "wipetl",
  "wipetr",
  "wipebl",
  "wipebr",
  "squeezeh",
  "squeezev",
  "pixelize",
  "hblur",
  "distance",
] as const;
export type XfadeStyle = (typeof XFADE_STYLES)[number];
export const XFADE_DEFAULT_STYLE: XfadeStyle = "fade";
/** Entrance / exit animations of a text or an overlay (modules/timeline.py
 *  ANIM_IN / ANIM_OUT; a test pins them). Slides are named by the direction the
 *  item MOVES; `typewriter` is for a text's entrance only. */
export const ANIM_OUT = [
  "fade",
  "slide-up",
  "slide-down",
  "slide-left",
  "slide-right",
  "pop",
] as const;
export const ANIM_IN = [...ANIM_OUT, "typewriter"] as const;
export type AnimOut = (typeof ANIM_OUT)[number];
export type AnimIn = (typeof ANIM_IN)[number];
/** An animation's length in seconds (ANIM_MIN_S / ANIM_MAX_S / ANIM_DEFAULT_S). */
export const ANIM_MIN_S = 0.1;
export const ANIM_MAX_S = 2;
export const ANIM_DEFAULT_S = 0.4;
/** Texts that may write themselves letter by letter in one document. */
export const MAX_TYPEWRITER_TEXTS = 20;
/** Clip effects (modules/timeline.py FILTERS / UNIT_EFFECTS / BLUR_MAX /
 *  ROTATIONS; a test pins them). */
export const FILTERS = [
  "mono",
  "sepia",
  "vintage",
  "cinematic",
  "cool",
  "warm",
  "high-contrast",
] as const;
export type ClipFilter = (typeof FILTERS)[number];
export const UNIT_EFFECTS = ["vignette", "sharpen", "grain"] as const;
/** A Gaussian blur's sigma in output pixels. */
export const BLUR_MAX = 30;
export const ROTATIONS = [0, 90, 180, 270] as const;
/** A clip's move: the zoom window's range (modules/timeline.py MOVE_ZOOM_*). */
export const MOVE_ZOOM_MIN = 1;
export const MOVE_ZOOM_MAX = 4;
export const MOVE_POINT_DEFAULTS = { zoom: 1, x: 0.5, y: 0.5 } as const;
/** Reverse holds every frame of the range in memory at the output size
 *  (modules/timeline.py REVERSE_MAX_BYTES / REVERSE_BYTES_PER_PIXEL). */
export const REVERSE_MAX_BYTES = 512 * 1024 * 1024;
export const REVERSE_BYTES_PER_PIXEL = 1.5;
/** The longest source range a clip may play reversed at this frame size and
 *  rate, in seconds (rounded down to a millisecond). */
export function reverseMaxSeconds(width: number, height: number, fps: number): number {
  return Math.floor((REVERSE_MAX_BYTES / (fps * width * height * REVERSE_BYTES_PER_PIXEL)) * 1000) / 1000;
}
export type Rotation = (typeof ROTATIONS)[number];
const EFFECT_KEYS = [
  "filter",
  "filter_strength",
  "vignette",
  "blur",
  "sharpen",
  "grain",
  "flip_h",
  "flip_v",
  "rotate",
];
/** A text's drop shadow, in output pixels (modules/timeline.py SHADOW_MAX). */
export const SHADOW_MAX = 20;
/** A text box's opacity when its colour is set without one. */
export const BOX_OPACITY_DEFAULT = 0.7;
export const ANCHORS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export const FONTS = [
  "DejaVu Sans",
  "DejaVu Serif",
  "Liberation Sans",
  "Liberation Serif",
] as const;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const DOC_REQUIRED = ["version", "width", "height", "fps", "tracks"];
const DOC_KEYS = [...DOC_REQUIRED, "captions", "overlays"];
const TRACK_REQUIRED = ["id", "kind", "clips"];
const TRACK_KEYS = [...TRACK_REQUIRED, "name"];
const A_TRACK_KEYS = [...TRACK_KEYS, "role", "duck"];
const DUCK_REQUIRED = ["amount_db"];
const DUCK_KEYS = [...DUCK_REQUIRED, "attack_s", "release_s"];
const MEDIA_REQUIRED = ["id", "asset_id", "start_s", "in_s", "out_s"];
const V_CLIP_KEYS = [
  ...MEDIA_REQUIRED,
  "fit",
  "fade_in_s",
  "fade_out_s",
  "transition",
  "speed",
  "audio",
  "grade",
  "move",
  "reverse",
  "freeze",
  ...EFFECT_KEYS,
];
const A_CLIP_KEYS = [...MEDIA_REQUIRED, "gain_db", "fade_in_s", "fade_out_s"];
const T_REQUIRED = ["id", "start_s", "end_s", "text"];
const TEXT_STYLE_KEYS = [
  "font",
  "size",
  "color",
  "outline_color",
  "outline_width",
  "bold",
];
/** Looks only a text clip has; the captions' style stays as it is. */
const TEXT_LOOK_KEYS = ["shadow", "box_color", "box_opacity"];
const ANIM_KEYS = ["anim_in", "anim_out", "anim_in_s", "anim_out_s"];
const T_CLIP_KEYS = [
  ...T_REQUIRED,
  ...TEXT_STYLE_KEYS,
  ...TEXT_LOOK_KEYS,
  "x",
  "y",
  "anchor",
  "fade_in_s",
  "fade_out_s",
  ...ANIM_KEYS,
];
const TRANSITION_KEYS = ["type", "duration_s"];
const TRANSITION_ALLOWED = [...TRANSITION_KEYS, "style"];
/** `preset` is one of CAPTION_STYLE_IDS (an animated style); absent = the plain caption. */
const CAPTION_STYLE_KEYS = [...TEXT_STYLE_KEYS, "y", "preset", "highlight_color"];
const CUE_KEYS = ["id", "start_s", "end_s", "text"];
const OVERLAY_REQUIRED = ["id", "asset_id", "start_s", "end_s"];
const OVERLAY_KEYS = [
  ...OVERLAY_REQUIRED,
  "x",
  "y",
  "w",
  "opacity",
  "anim_in",
  "anim_out",
  "anim_in_s",
  "anim_out_s",
  "move",
];

// ── document types ──────────────────────────────────────────────────────────

export type Anchor = (typeof ANCHORS)[number];

export interface Transition {
  type: (typeof TRANSITIONS)[number];
  duration_s: number;
  /** How a cross-fade blends the two pictures; none = the plain `fade`. */
  style?: XfadeStyle;
}

/** A window onto the fitted picture: zoom 1-4 (1 = all of it) and its centre
 *  as fractions of the picture. Missing keys take MOVE_POINT_DEFAULTS. */
export interface MovePoint {
  zoom?: number;
  x?: number;
  y?: number;
}
export interface ClipMove {
  from: MovePoint;
  to: MovePoint;
}
/** An overlay's end keyframe: the overlay's own values go linearly to these. */
export interface OverlayMoveTo {
  x?: number;
  y?: number;
  w?: number;
  opacity?: number;
}

export interface VideoClip {
  id: string;
  asset_id: string;
  start_s: number;
  in_s: number;
  out_s: number;
  speed: number;
  audio: boolean;
  /** blur = the whole picture over a blurred copy of itself (no bars). */
  fit?: "contain" | "cover" | "blur";
  /** The clip's colour grade (ffmpeg eq); none = no change. lib/editorGrade.ts. */
  grade?: ClipGrade;
  /** Effects (modules/timeline.py): all optional, absent = off. A turn and
   *  mirror act on the source before it is fitted; the rest on the picture. */
  filter?: ClipFilter;
  /** 0-1; 1 when absent. Needs a `filter`. */
  filter_strength?: number;
  vignette?: number;
  /** Gaussian sigma in output pixels, 0-BLUR_MAX. */
  blur?: number;
  sharpen?: number;
  grain?: number;
  flip_h?: boolean;
  flip_v?: boolean;
  /** Degrees clockwise: 0, 90, 180 or 270. */
  rotate?: Rotation;
  /** Ken Burns style move over the fitted picture (a still with one has it
   *  instead of the automatic slow zoom). */
  move?: ClipMove;
  /** Play the source range backwards; holds the whole range in memory, so the
   *  range is capped (see reverseMaxSeconds). Video only. */
  reverse?: boolean;
  /** Hold the frame at in_s for the clip's whole length; no sound, speed 1,
   *  not with reverse. Video only. */
  freeze?: boolean;
  /** Into this clip. The editor makes cross-fades; a dip_to_black from
   *  another tool is kept as it is. */
  transition?: Transition;
  fade_in_s?: number;
  fade_out_s?: number;
}

export type SoundRole = (typeof ROLES)[number];

/** Lower a music track while speech plays (modules/timeline.py): by
 *  `amount_db`, reaching it `attack_s` before speech starts and coming back
 *  over `release_s` after it ends. */
export interface Duck {
  amount_db: number;
  attack_s: number;
  release_s: number;
}

/** A music or sound-effect clip on its own A track. */
export interface SoundClip {
  id: string;
  asset_id: string;
  start_s: number;
  in_s: number;
  out_s: number;
  gain_db: number;
  fade_in_s: number;
  fade_out_s: number;
  /** What the track carries; none = music. A speech sound is what a ducked
   *  music sound is lowered under. These two live on the A track in the
   *  document (the editor gives every sound a track of its own). */
  role?: SoundRole;
  duck?: Duck;
}

export interface TextClip {
  id: string;
  start_s: number;
  end_s: number;
  text: string;
  size: number;
  x: number;
  y: number;
  anchor: Anchor;
  bold?: boolean;
  color?: string;
  font?: (typeof FONTS)[number];
  outline_color?: string;
  outline_width?: number;
  /** A soft black drop shadow, in output pixels (0 / none = no shadow). */
  shadow?: number;
  /** A box behind the text (instead of its outline); `box_opacity` needs it. */
  box_color?: string;
  box_opacity?: number;
  /** Entrance / exit animation and its length (default ANIM_DEFAULT_S). Not
   *  together with fade_in_s / fade_out_s on the same side. */
  anim_in?: AnimIn;
  anim_out?: AnimOut;
  anim_in_s?: number;
  anim_out_s?: number;
}

export interface TimelineTrack {
  id: string;
  kind: "V" | "A" | "T";
  name?: string;
  role?: SoundRole;
  duck?: Duck;
  clips: Record<string, unknown>[];
}

/** A picture or video laid over the picture (modules/timeline.py `overlays`):
 *  (x, y) is its CENTRE and w its width, as fractions of the frame; its height
 *  follows the file's own aspect ratio. Drawn in list order, later on top. */
export interface PictureOverlay {
  id: string;
  asset_id: string;
  start_s: number;
  end_s: number;
  x: number;
  y: number;
  w: number;
  opacity: number;
  /** Entrance / exit animation and its length (no typewriter on a picture). */
  anim_in?: AnimOut;
  anim_out?: AnimOut;
  anim_in_s?: number;
  anim_out_s?: number;
  /** Two-keyframe move to the given values over start_s..end_s. */
  move?: { to: OverlayMoveTo };
}

/** What an overlay's optional fields mean when absent (modules/timeline.py
 *  OVERLAY_DEFAULTS). */
export const OVERLAY_DEFAULTS = { x: 0.5, y: 0.5, w: 0.3, opacity: 1 } as const;

export interface TimelineDoc {
  version: 1;
  width: number;
  height: number;
  fps: number;
  tracks: TimelineTrack[];
  captions?: unknown;
  overlays?: unknown[];
}

/** What the editor works on: the picture laid end to end, text on top, and
 *  anything else the document holds kept as it was. */
export interface EditorModel {
  width: number;
  height: number;
  fps: number;
  clips: VideoClip[];
  texts: TextClip[];
  sounds: SoundClip[];
  /** Pictures / videos over the picture; none = the field is absent. */
  overlays?: PictureOverlay[];
  /** Tracks this editor does not edit, kept verbatim. */
  keep: TimelineTrack[];
  captions?: unknown;
}

// ── small helpers ───────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v);

/** Milliseconds, the document's resolution (modules/timeline.py `_ms`). */
export function ms(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** A media clip's speed (1 when it has none or an unusable one). */
function speedOf(c: Record<string, unknown>): number {
  const v = c.speed;
  return isNum(v) && v > 0 ? v : 1;
}

/** Where a clip ends on the timeline (modules/timeline.py `clip_end_s`). */
export function clipEnd(
  c: Record<string, unknown> | VideoClip | TextClip,
): number {
  const r = c as Record<string, unknown>;
  if ("end_s" in r) return ms(Number(r.end_s));
  return ms(
    ms(Number(r.start_s)) +
      (ms(Number(r.out_s)) - ms(Number(r.in_s))) / speedOf(r),
  );
}

/** How long a video clip lasts on the timeline. */
export function clipLength(c: VideoClip): number {
  return ms((ms(c.out_s) - ms(c.in_s)) / c.speed);
}

// ── validation: the twin of modules/timeline.py validate() ──────────────────

function fields(
  obj: unknown,
  allowed: string[],
  required: string[],
  where: string,
  problems: string[],
): obj is Record<string, unknown> {
  if (!isObj(obj)) {
    problems.push(`${where} must be an object`);
    return false;
  }
  for (const k of required)
    if (!(k in obj)) problems.push(`${where}: ${k} is missing`);
  for (const k of Object.keys(obj))
    if (!allowed.includes(k))
      problems.push(`${where}: ${k} is not a known field`);
  return true;
}

function numIn(
  obj: Record<string, unknown>,
  key: string,
  lo: number,
  hi: number,
  where: string,
  problems: string[],
  exclusiveLo = false,
) {
  if (!(key in obj)) return;
  const v = obj[key];
  const ok = isNum(v) && (exclusiveLo ? v > lo : v >= lo) && v <= hi;
  if (!ok)
    problems.push(`${where}: ${key} must be a number from ${lo} to ${hi}`);
}

function textField(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
) {
  if (!(key in obj)) return;
  const v = obj[key];
  if (typeof v !== "string" || !v.trim() || v.length > MAX_TEXT) {
    problems.push(
      `${where}: ${key} must be non-empty text of at most ${MAX_TEXT} characters`,
    );
  }
}

function textStyle(
  obj: Record<string, unknown>,
  where: string,
  problems: string[],
) {
  if ("font" in obj && !(FONTS as readonly unknown[]).includes(obj.font))
    problems.push(`${where}: font is not available`);
  if (
    "size" in obj &&
    !(isInt(obj.size) && obj.size >= SIZE_MIN && obj.size <= SIZE_MAX)
  ) {
    problems.push(
      `${where}: size must be an integer from ${SIZE_MIN} to ${SIZE_MAX}`,
    );
  }
  for (const k of ["color", "outline_color"]) {
    if (
      k in obj &&
      !(typeof obj[k] === "string" && HEX_RE.test(obj[k] as string))
    )
      problems.push(`${where}: ${k} must be a #RRGGBB colour`);
  }
  numIn(obj, "outline_width", 0, OUTLINE_MAX, where, problems);
  if ("bold" in obj && typeof obj.bold !== "boolean")
    problems.push(`${where}: bold must be true or false`);
}

/**
 * Every reason `doc` is not a renderable timeline, as readable strings.
 * Empty = valid. The same rules as modules/timeline.py `validate`, which the
 * worker runs again before it renders anything.
 */
export function validateTimeline(doc: unknown): string[] {
  const problems: string[] = [];
  if (!fields(doc, DOC_KEYS, DOC_REQUIRED, "timeline", problems))
    return problems;
  if (doc.version !== TIMELINE_VERSION)
    problems.push(`timeline: version must be ${TIMELINE_VERSION}`);
  for (const k of ["width", "height"]) {
    const v = doc[k];
    if (!(isInt(v) && v >= MIN_SIDE && v <= MAX_SIDE && v % 2 === 0))
      problems.push(
        `timeline: ${k} must be an even integer from ${MIN_SIDE} to ${MAX_SIDE}`,
      );
  }
  if (
    isInt(doc.width) &&
    isInt(doc.height) &&
    doc.width * doc.height > MAX_FRAME_PIXELS
  )
    problems.push(
      `timeline: the frame is at most ${MAX_FRAME_PIXELS} pixels (3840x2160 or 2160x3840)`,
    );
  const fps: number | null =
    isInt(doc.fps) && (FPS_VALUES as readonly number[]).includes(doc.fps)
      ? doc.fps
      : null;
  if (fps === null)
    problems.push(`timeline: fps must be one of ${FPS_VALUES.join(", ")}`);

  const ids = new Map<string, string>();
  const claim = (ident: unknown, where: string) => {
    if (!(typeof ident === "string" && ID_RE.test(ident)))
      problems.push(`${where}: id must be 1-64 letters, digits, '_' or '-'`);
    else if (ids.has(ident))
      problems.push(`${where}: id ${ident} is already used`);
    else ids.set(ident, where);
  };

  let tracks: unknown[] = [];
  if (!Array.isArray(doc.tracks))
    problems.push("timeline: tracks must be a list");
  else {
    tracks = doc.tracks;
    if (tracks.length > MAX_TRACKS)
      problems.push(`timeline: at most ${MAX_TRACKS} tracks`);
  }
  let vTracks = 0;
  tracks.forEach((track, ti) => {
    const where0 = `tracks[${ti}]`;
    const isAudio = isObj(track) && track.kind === "A";
    if (
      !fields(
        track,
        isAudio ? A_TRACK_KEYS : TRACK_KEYS,
        TRACK_REQUIRED,
        where0,
        problems,
      )
    )
      return;
    const where = `track ${String(track.id)}`;
    claim(track.id, where);
    const kind = track.kind;
    if (kind !== "V" && kind !== "A" && kind !== "T") {
      problems.push(`${where}: kind must be V, A or T`);
      return;
    }
    if (kind === "V") vTracks += 1;
    if (
      "name" in track &&
      !(typeof track.name === "string" && track.name.length <= 100)
    )
      problems.push(`${where}: name must be text of at most 100 characters`);
    if (kind === "A") validateAudioTrackOptions(track, where, problems);
    if (!Array.isArray(track.clips)) {
      problems.push(`${where}: clips must be a list`);
      return;
    }
    if (track.clips.length > MAX_CLIPS_PER_TRACK) {
      problems.push(`${where}: at most ${MAX_CLIPS_PER_TRACK} clips per track`);
      return;
    }
    track.clips.forEach((clip, ci) => {
      const cwhere =
        isObj(clip) && "id" in clip
          ? `${where} clip ${String(clip.id)}`
          : `${where} clips[${ci}]`;
      if (kind === "T") validateTextClip(clip, cwhere, problems, claim);
      else validateMediaClip(clip, kind, cwhere, fps, problems, claim, [doc.width, doc.height]);
    });
  });
  if (vTracks > 1)
    problems.push("timeline: only one video (V) track is supported");
  const counted = tracks.filter(
    (t): t is Record<string, unknown> & { clips: unknown[] } =>
      isObj(t) && Array.isArray(t.clips),
  );
  let nAudio = 0;
  for (const t of counted) {
    if (t.kind === "A") nAudio += t.clips.length;
    if (t.kind === "V")
      nAudio += t.clips.filter((c) => isObj(c) && c.audio === true).length;
  }
  if (nAudio > MAX_AUDIO_CLIPS)
    problems.push(
      `timeline: at most ${MAX_AUDIO_CLIPS} audio clips in one timeline`,
    );
  if (counted.reduce((n, t) => n + t.clips.length, 0) > MAX_TOTAL_CLIPS)
    problems.push(`timeline: at most ${MAX_TOTAL_CLIPS} clips in one timeline`);
  const nType = counted
    .filter((t) => t.kind === "T")
    .reduce(
      (n, t) =>
        n + t.clips.filter((c) => isObj(c) && c.anim_in === "typewriter").length,
      0,
    );
  if (nType > MAX_TYPEWRITER_TEXTS)
    problems.push(
      `timeline: at most ${MAX_TYPEWRITER_TEXTS} typewriter texts (got ${nType})`,
    );

  if (doc.captions !== undefined && doc.captions !== null)
    validateCaptions(doc.captions, problems, claim);
  else if (doc.captions === null) problems.push("captions must be an object");
  if ("overlays" in doc) validateOverlays(doc.overlays, fps, problems, claim);

  if (problems.length) return problems;
  const d = doc as unknown as TimelineDoc;
  const found = overlaps(d, MAX_REPORTED_OVERLAPS + 1);
  for (const ov of found.slice(0, MAX_REPORTED_OVERLAPS))
    problems.push(`track ${ov[0]}: clips ${ov[1]} and ${ov[2]} overlap`);
  if (found.length > MAX_REPORTED_OVERLAPS)
    problems.push("... and more overlaps");
  problems.push(...transitionProblems(d));
  const total = docDuration(d);
  if (total <= 0) problems.push("timeline: nothing to render");
  else if (total > MAX_DURATION_S)
    problems.push("timeline: longer than 4 hours");
  return problems;
}

/** `role` and `duck` of an A track (modules/timeline.py _validate_audio_track_options). */
function validateAudioTrackOptions(
  track: Record<string, unknown>,
  where: string,
  problems: string[],
) {
  if ("role" in track && !(ROLES as readonly unknown[]).includes(track.role))
    problems.push(`${where}: role must be music or speech`);
  if (!("duck" in track)) return;
  const duck = track.duck;
  const dwhere = `${where} duck`;
  if (fields(duck, DUCK_KEYS, DUCK_REQUIRED, dwhere, problems)) {
    numIn(duck, "amount_db", DUCK_DB_MIN, DUCK_DB_MAX, dwhere, problems);
    numIn(
      duck,
      "attack_s",
      DUCK_ATTACK_MIN_S,
      DUCK_ATTACK_MAX_S,
      dwhere,
      problems,
    );
    numIn(
      duck,
      "release_s",
      DUCK_RELEASE_MIN_S,
      DUCK_RELEASE_MAX_S,
      dwhere,
      problems,
    );
  }
  if (track.role === "speech")
    problems.push(
      `${where}: a speech track cannot be lowered under speech (remove duck or set role to music)`,
    );
}

function validateMediaClip(
  clip: unknown,
  kind: "V" | "A",
  where: string,
  fps: number | null,
  problems: string[],
  claim: (i: unknown, w: string) => void,
  frame: [unknown, unknown] = [null, null],
) {
  const keys = kind === "V" ? V_CLIP_KEYS : A_CLIP_KEYS;
  if (!fields(clip, keys, MEDIA_REQUIRED, where, problems)) return;
  claim(clip.id, where);
  if (!(typeof clip.asset_id === "string" && UUID_RE.test(clip.asset_id)))
    problems.push(`${where}: asset_id must be a uuid`);
  for (const k of ["start_s", "in_s", "out_s", "fade_in_s", "fade_out_s"])
    numIn(clip, k, 0, MAX_DURATION_S, where, problems);
  let speed: number | null = 1;
  if (kind === "V" && "speed" in clip) {
    numIn(clip, "speed", SPEED_MIN, SPEED_MAX, where, problems);
    speed =
      isNum(clip.speed) && clip.speed >= SPEED_MIN && clip.speed <= SPEED_MAX
        ? clip.speed
        : null;
  }
  if (kind === "V" && "audio" in clip && typeof clip.audio !== "boolean")
    problems.push(`${where}: audio must be true or false`);
  if (kind === "V") {
    for (const k of ["reverse", "freeze"])
      if (k in clip && typeof clip[k] !== "boolean")
        problems.push(`${where}: ${k} must be true or false`);
    if (clip.freeze === true) {
      if (clip.reverse === true)
        problems.push(`${where}: a frozen clip cannot also be reversed`);
      if (isNum(clip.speed ?? 1) && (clip.speed ?? 1) !== 1)
        problems.push(`${where}: a frozen clip has no speed (it holds one frame)`);
      if (clip.audio === true)
        problems.push(`${where}: a frozen clip has no sound`);
    }
  }
  const ins = clip.in_s;
  const outs = clip.out_s;
  if (isNum(ins) && isNum(outs) && speed) {
    const length = ms((ms(outs) - ms(ins)) / speed);
    const fi = clip.fade_in_s ?? 0;
    const fo = clip.fade_out_s ?? 0;
    if (ms(outs) - ms(ins) <= 0)
      problems.push(`${where}: out_s must be greater than in_s`);
    else if (fps && Math.round(length * fps) < 1)
      problems.push(`${where}: shorter than one frame`);
    else if (
      kind === "V" &&
      clip.reverse === true &&
      fps &&
      isInt(frame[0]) &&
      isInt(frame[1]) &&
      Math.ceil((ms(outs) - ms(ins)) * fps) * frame[0] * frame[1] * REVERSE_BYTES_PER_PIXEL >
        REVERSE_MAX_BYTES
    )
      problems.push(
        `${where}: reverse holds every frame of the range in memory — at most ${reverseMaxSeconds(frame[0], frame[1], fps)} s at this frame size`,
      );
    else if (isNum(fi) && isNum(fo) && fi + fo > length + 1e-9)
      problems.push(`${where}: fade_in_s + fade_out_s is longer than the clip`);
  }
  if (kind === "V") {
    if ("fit" in clip && !(FITS as readonly unknown[]).includes(clip.fit))
      problems.push(`${where}: fit must be contain, cover or blur`);
    if (
      "grade" in clip &&
      fields(
        clip.grade,
        [...GRADE_KEYS],
        [...GRADE_KEYS],
        `${where} grade`,
        problems,
      )
    )
      for (const k of GRADE_KEYS)
        numIn(
          clip.grade,
          k,
          GRADE_RANGES[k].min,
          GRADE_RANGES[k].max,
          `${where} grade`,
          problems,
        );
    validateEffects(clip, where, problems);
    if ("move" in clip) validateClipMove(clip.move, where, problems);
    if ("transition" in clip) {
      const tr = clip.transition;
      if (
        fields(
          tr,
          TRANSITION_ALLOWED,
          TRANSITION_KEYS,
          `${where} transition`,
          problems,
        )
      ) {
        if (!(TRANSITIONS as readonly unknown[]).includes(tr.type))
          problems.push(
            `${where}: transition type must be cut, dip_to_black or crossfade`,
          );
        if ("style" in tr) {
          if (!(XFADE_STYLES as readonly unknown[]).includes(tr.style))
            problems.push(`${where} transition: style is not known`);
          else if (tr.type !== "crossfade")
            problems.push(
              `${where} transition: a style is only for a crossfade`,
            );
        }
        if (tr.type === "crossfade")
          numIn(
            tr,
            "duration_s",
            XFADE_MIN_S,
            XFADE_MAX_S,
            `${where} transition`,
            problems,
          );
        else numIn(tr, "duration_s", 0, 10, `${where} transition`, problems);
      }
    }
  } else {
    numIn(clip, "gain_db", GAIN_DB_MIN, GAIN_DB_MAX, where, problems);
  }
}

/** The twin of modules/timeline.py `_validate_clip_move`. */
function validateClipMove(move: unknown, where: string, problems: string[]) {
  if (!fields(move, ["from", "to"], ["from", "to"], `${where} move`, problems))
    return;
  for (const k of ["from", "to"] as const) {
    if (!(k in move)) continue;
    const pw = `${where} move ${k}`;
    const point = move[k];
    if (!fields(point, ["zoom", "x", "y"], [], pw, problems)) continue;
    numIn(point, "zoom", MOVE_ZOOM_MIN, MOVE_ZOOM_MAX, pw, problems);
    numIn(point, "x", 0, 1, pw, problems);
    numIn(point, "y", 0, 1, pw, problems);
  }
}

/** The twin of modules/timeline.py `_validate_overlay_move`. */
function validateOverlayMove(move: unknown, where: string, problems: string[]) {
  if (!fields(move, ["to"], ["to"], `${where} move`, problems) || !("to" in move))
    return;
  const to = move.to;
  const tw = `${where} move to`;
  if (!fields(to, ["x", "y", "w", "opacity"], [], tw, problems)) return;
  if (Object.keys(to).length === 0)
    problems.push(`${tw}: give at least one of x, y, w, opacity`);
  for (const k of ["x", "y", "opacity"]) numIn(to, k, 0, 1, tw, problems);
  numIn(to, "w", OVERLAY_W_MIN, OVERLAY_W_MAX, tw, problems);
}

/** The twin of modules/timeline.py `_validate_effects`. */
function validateEffects(
  clip: Record<string, unknown>,
  where: string,
  problems: string[],
) {
  if (
    "filter" in clip &&
    !(typeof clip.filter === "string" && (FILTERS as readonly string[]).includes(clip.filter))
  )
    problems.push(`${where}: filter is not available`);
  numIn(clip, "filter_strength", 0, 1, where, problems);
  if ("filter_strength" in clip && !("filter" in clip))
    problems.push(`${where}: filter_strength needs a filter`);
  for (const k of UNIT_EFFECTS) numIn(clip, k, 0, 1, where, problems);
  numIn(clip, "blur", 0, BLUR_MAX, where, problems);
  for (const k of ["flip_h", "flip_v"])
    if (k in clip && typeof clip[k] !== "boolean")
      problems.push(`${where}: ${k} must be true or false`);
  if (
    "rotate" in clip &&
    !(isInt(clip.rotate) && (ROTATIONS as readonly number[]).includes(clip.rotate))
  )
    problems.push(`${where}: rotate must be 0, 90, 180 or 270`);
}

function validateTimedText(
  obj: Record<string, unknown>,
  where: string,
  problems: string[],
) {
  numIn(obj, "start_s", 0, MAX_DURATION_S, where, problems);
  numIn(obj, "end_s", 0, MAX_DURATION_S, where, problems);
  if (
    isNum(obj.start_s) &&
    isNum(obj.end_s) &&
    ms(obj.end_s) <= ms(obj.start_s)
  )
    problems.push(`${where}: end_s must be greater than start_s`);
  textField(obj, "text", where, problems);
}

/** The twin of modules/timeline.py `_validate_anims`. */
function validateAnims(
  obj: Record<string, unknown>,
  where: string,
  problems: string[],
  text: boolean,
) {
  const lists: [string, readonly string[]][] = [
    ["anim_in", text ? ANIM_IN : ANIM_OUT],
    ["anim_out", ANIM_OUT],
  ];
  for (const [key, allowed] of lists) {
    if (key in obj && !(typeof obj[key] === "string" && allowed.includes(obj[key] as string)))
      problems.push(`${where}: ${key} is not an animation this item has`);
    numIn(obj, `${key}_s`, ANIM_MIN_S, ANIM_MAX_S, where, problems);
    if (`${key}_s` in obj && !(key in obj))
      problems.push(`${where}: ${key}_s needs ${key}`);
  }
  const spans = ["anim_in", "anim_out"]
    .filter((k) => k in obj)
    .map((k) => obj[`${k}_s`] ?? ANIM_DEFAULT_S);
  const { start_s: s, end_s: e } = obj;
  if (
    spans.length &&
    spans.every(isNum) &&
    isNum(s) &&
    isNum(e) &&
    e > s &&
    (spans as number[]).reduce((a, b) => a + b, 0) > ms(e) - ms(s) + 1e-9
  )
    problems.push(`${where}: the animations are longer than the item is shown`);
}

function validateTextClip(
  clip: unknown,
  where: string,
  problems: string[],
  claim: (i: unknown, w: string) => void,
) {
  if (!fields(clip, T_CLIP_KEYS, T_REQUIRED, where, problems)) return;
  claim(clip.id, where);
  validateTimedText(clip, where, problems);
  textStyle(clip, where, problems);
  numIn(clip, "x", 0, 1, where, problems);
  numIn(clip, "y", 0, 1, where, problems);
  numIn(clip, "shadow", 0, SHADOW_MAX, where, problems);
  if (
    "box_color" in clip &&
    !(typeof clip.box_color === "string" && HEX_RE.test(clip.box_color))
  )
    problems.push(`${where}: box_color must be a #RRGGBB colour`);
  numIn(clip, "box_opacity", 0, 1, where, problems);
  if ("box_opacity" in clip && !("box_color" in clip))
    problems.push(`${where}: box_opacity needs a box_color`);
  if (
    "anchor" in clip &&
    !(ANCHORS as readonly unknown[]).includes(clip.anchor)
  )
    problems.push(`${where}: anchor is not known`);
  numIn(clip, "fade_in_s", 0, MAX_DURATION_S, where, problems);
  numIn(clip, "fade_out_s", 0, MAX_DURATION_S, where, problems);
  validateAnims(clip, where, problems, true);
  for (const [anim, fade] of [
    ["anim_in", "fade_in_s"],
    ["anim_out", "fade_out_s"],
  ] as const)
    if (anim in clip && isNum(clip[fade]) && clip[fade] > 0)
      problems.push(`${where}: ${anim} and ${fade} both set — use one`);
  const { start_s: s, end_s: e } = clip;
  const fi = clip.fade_in_s ?? 0;
  const fo = clip.fade_out_s ?? 0;
  if (
    isNum(s) &&
    isNum(e) &&
    isNum(fi) &&
    isNum(fo) &&
    e > s &&
    fi + fo > e - s + 1e-9
  )
    problems.push(`${where}: fades are longer than the text is shown`);
}

/** Python's `round` (half to even) for the frame check below: the worker rounds
 *  with it, so a time exactly between two frames must land the same way. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** The twin of modules/timeline.py `_validate_overlays`. */
function validateOverlays(
  overlays: unknown,
  fps: number | null,
  problems: string[],
  claim: (i: unknown, w: string) => void,
) {
  if (!Array.isArray(overlays)) {
    problems.push("overlays must be a list");
    return;
  }
  if (overlays.length > MAX_OVERLAYS) {
    problems.push(`overlays: at most ${MAX_OVERLAYS}`);
    return;
  }
  overlays.forEach((ov, i) => {
    if (!fields(ov, OVERLAY_KEYS, OVERLAY_REQUIRED, `overlays[${i}]`, problems))
      return;
    const where = `overlay ${String(ov.id)}`;
    claim(ov.id, where);
    if (!(typeof ov.asset_id === "string" && UUID_RE.test(ov.asset_id)))
      problems.push(`${where}: asset_id must be a uuid`);
    numIn(ov, "start_s", 0, MAX_DURATION_S, where, problems);
    numIn(ov, "end_s", 0, MAX_DURATION_S, where, problems);
    if (isNum(ov.start_s) && isNum(ov.end_s)) {
      if (ms(ov.end_s) <= ms(ov.start_s))
        problems.push(`${where}: end_s must be greater than start_s`);
      else if (fps && pyRound(ms(ov.end_s) * fps) - pyRound(ms(ov.start_s) * fps) < 1)
        problems.push(`${where}: shorter than one frame`);
    }
    for (const k of ["x", "y", "opacity"]) numIn(ov, k, 0, 1, where, problems);
    numIn(ov, "w", OVERLAY_W_MIN, OVERLAY_W_MAX, where, problems);
    validateAnims(ov, where, problems, false);
    if ("move" in ov) validateOverlayMove(ov.move, where, problems);
  });
}

function validateCaptions(
  captions: unknown,
  problems: string[],
  claim: (i: unknown, w: string) => void,
) {
  if (!fields(captions, ["style", "cues"], ["cues"], "captions", problems))
    return;
  const style = captions.style;
  if (
    style !== undefined &&
    style !== null &&
    fields(style, CAPTION_STYLE_KEYS, [], "captions style", problems)
  ) {
    textStyle(style, "captions style", problems);
    numIn(style, "y", 0, 1, "captions style", problems);
    if ("preset" in style && !isCaptionStyleId(style.preset))
      problems.push(
        `captions style: preset must be one of ${JSON.stringify(CAPTION_STYLE_IDS)}`,
      );
    if (
      "highlight_color" in style &&
      !(typeof style.highlight_color === "string" && HEX_RE.test(style.highlight_color))
    )
      problems.push("captions style: highlight_color must be a #RRGGBB colour");
  }
  if (!Array.isArray(captions.cues)) {
    problems.push("captions: cues must be a list");
    return;
  }
  if (captions.cues.length > MAX_CUES) {
    problems.push(`captions: at most ${MAX_CUES} cues`);
    return;
  }
  captions.cues.forEach((cue, i) => {
    if (!fields(cue, CUE_KEYS, CUE_KEYS, `captions cues[${i}]`, problems))
      return;
    claim(cue.id, `caption ${String(cue.id)}`);
    validateTimedText(cue, `caption ${String(cue.id)}`, problems);
  });
}

type Span = [number, number, string];

function spans(doc: TimelineDoc): [string, Span[]][] {
  const lanes: [string, Span[]][] = doc.tracks.map((t) => [
    t.id,
    t.clips
      .map((c) => [ms(Number(c.start_s)), clipEnd(c), String(c.id)] as Span)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2])),
  ]);
  const cues =
    isObj(doc.captions) && Array.isArray(doc.captions.cues)
      ? (doc.captions.cues as Record<string, unknown>[])
      : [];
  if (cues.length)
    lanes.push([
      "captions",
      cues
        .map(
          (c) =>
            [ms(Number(c.start_s)), ms(Number(c.end_s)), String(c.id)] as Span,
        )
        .sort((a, b) => a[0] - b[0]),
    ]);
  return lanes;
}

/** The document's length: where its last clip, text or caption ends. */
export function docDuration(doc: TimelineDoc): number {
  let end = 0;
  for (const [, items] of spans(doc))
    for (const [, e] of items) end = Math.max(end, e);
  return end;
}

/** Python's str ordering (code points), not the locale's: the two
 *  validators must sort clips the same way. */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function sortedClips(track: TimelineTrack): Record<string, unknown>[] {
  return [...track.clips].sort(
    (a, b) =>
      ms(Number(a.start_s)) - ms(Number(b.start_s)) ||
      byCodePoint(String(a.id), String(b.id)),
  );
}

/** A V clip's cross-fade from the clip before it, in seconds (0 = none). */
export function crossfadeOf(c: Record<string, unknown> | VideoClip): number {
  const tr = (c as Record<string, unknown>).transition;
  if (!isObj(tr) || tr.type !== "crossfade" || !isNum(tr.duration_s)) return 0;
  return ms(tr.duration_s);
}

/** [previous clip, clip, seconds] for every cross-fade laid out as one
 *  (modules/timeline.py `crossfades`). */
function crossfades(
  track: TimelineTrack,
): [Record<string, unknown>, Record<string, unknown>, number][] {
  const out: [Record<string, unknown>, Record<string, unknown>, number][] =
    [];
  const clips = sortedClips(track);
  clips.forEach((c, i) => {
    const d = crossfadeOf(c);
    if (i === 0 || d <= 0) return;
    const prev = clips[i - 1];
    if (Math.abs(clipEnd(prev) - ms(Number(c.start_s)) - d) < XFADE_TOLERANCE)
      out.push([prev, c, d]);
  });
  return out;
}

/**
 * Validation reports the first MAX_REPORTED_OVERLAPS pairs and then only that
 * there are more, so the search stops one past that: a document of 5000
 * captions on one span has 12.5 million pairs, and collecting them all froze
 * the process (modules/timeline.py `overlaps` keeps the same limit).
 */
const MAX_REPORTED_OVERLAPS = 20;

function overlaps(
  doc: TimelineDoc,
  limit = Infinity,
): [string, string, string][] {
  const blended = new Set<string>();
  // Ids are checked ([A-Za-z0-9_-]) before this runs, so NUL cannot occur in one.
  const key = (lane: string, a: string, b: string) => `${lane}\0${a}\0${b}`;
  for (const t of doc.tracks)
    if (t.kind === "V")
      for (const [p, c] of crossfades(t)) {
        blended.add(key(t.id, String(p.id), String(c.id)));
        blended.add(key(t.id, String(c.id), String(p.id)));
      }
  const found: [string, string, string][] = [];
  for (const [lane, items] of spans(doc)) {
    for (let i = 0; i < items.length; i += 1) {
      const [, e1, id1] = items[i];
      for (let j = i + 1; j < items.length; j += 1) {
        const [s2, , id2] = items[j];
        if (s2 >= e1) break;
        if (blended.size && blended.has(key(lane, id1, id2))) continue;
        found.push([lane, id1, id2]);
        if (found.length >= limit) return found;
      }
    }
  }
  return found;
}

/** The twin of modules/timeline.py `_crossfade_problems`. */
function crossfadeProblems(track: TimelineTrack): string[] {
  const problems: string[] = [];
  const clips = sortedClips(track);
  const laid = new Set(crossfades(track).map(([, c]) => String(c.id)));
  const into = new Map<string, number>();
  const outOf = new Map<string, number>();
  const len = (c: Record<string, unknown>) =>
    clipEnd(c) - ms(Number(c.start_s));
  clips.forEach((c, i) => {
    const d = crossfadeOf(c);
    if (d <= 0) return;
    const where = `track ${track.id} clip ${String(c.id)}`;
    if (i === 0) {
      problems.push(`${where}: a cross-fade needs a clip before it`);
      return;
    }
    const prev = clips[i - 1];
    if (!laid.has(String(c.id))) {
      problems.push(
        `${where}: a cross-fade must start its length before the previous clip ends`,
      );
      return;
    }
    for (const x of [prev, c])
      if (d > len(x) + 1e-9)
        problems.push(
          `${where}: the cross-fade is longer than clip ${String(x.id)}`,
        );
    into.set(String(c.id), d);
    outOf.set(String(prev.id), d);
  });
  for (const c of clips) {
    const a = into.get(String(c.id)) ?? 0;
    const b = outOf.get(String(c.id)) ?? 0;
    if (a && b && a + b > len(c) + 1e-9)
      problems.push(
        `track ${track.id} clip ${String(c.id)}: its cross-fades are longer than the clip`,
      );
  }
  return problems;
}

function transitionProblems(doc: TimelineDoc): string[] {
  const problems: string[] = [];
  for (const track of doc.tracks) {
    if (track.kind !== "V") continue;
    problems.push(...crossfadeProblems(track));
    const clips = [...track.clips].sort(
      (a, b) =>
        ms(Number(a.start_s)) - ms(Number(b.start_s)) ||
        String(a.id).localeCompare(String(b.id)),
    );
    const fades = new Map(
      clips.map((c) => [
        String(c.id),
        [Number(c.fade_in_s ?? 0), Number(c.fade_out_s ?? 0)],
      ]),
    );
    clips.forEach((c, i) => {
      const tr = c.transition as
        | { type?: string; duration_s?: number }
        | undefined;
      if (tr?.type !== "dip_to_black" || !tr.duration_s) return;
      const half = tr.duration_s / 2;
      const f = fades.get(String(c.id))!;
      f[0] = Math.max(f[0], half);
      if (i > 0 && clipEnd(clips[i - 1]) === ms(Number(c.start_s))) {
        const p = fades.get(String(clips[i - 1].id))!;
        p[1] = Math.max(p[1], half);
      }
    });
    for (const c of clips) {
      const [fi, fo] = fades.get(String(c.id))!;
      if (fi + fo > clipEnd(c) - ms(Number(c.start_s)) + 1e-9)
        problems.push(
          `track ${track.id} clip ${String(c.id)}: its fades and transitions are longer than the clip`,
        );
    }
  }
  return problems;
}

// ── the editor's model ──────────────────────────────────────────────────────

/** The next clip's start: never before the previous clip's end as Python
 *  rounds it (a touching cut is not an overlap; a 1 ms early start would be). */
function nextStart(prevEnd: number): number {
  return Math.ceil(prevEnd * 1000 - 1e-6) / 1000;
}

/** The style of a clip's cross-fade as a spread (nothing for the plain one). */
function styleOf(c: Record<string, unknown> | VideoClip): { style?: XfadeStyle } {
  const tr = (c as Record<string, unknown>).transition;
  if (
    !isObj(tr) ||
    tr.type !== "crossfade" ||
    !(XFADE_STYLES as readonly unknown[]).includes(tr.style) ||
    tr.style === XFADE_DEFAULT_STYLE
  )
    return {};
  return { style: tr.style as XfadeStyle };
}

/** The style of the cross-fade into a clip (`fade` when it has none). */
export function crossfadeStyleOf(c: Record<string, unknown> | VideoClip): XfadeStyle {
  return styleOf(c).style ?? XFADE_DEFAULT_STYLE;
}

/** A clip without its transition (a key set to undefined would still be a
 *  field the validator sees). */
function withoutTransition(c: VideoClip): VideoClip {
  const rest = { ...c };
  delete rest.transition;
  return rest;
}

/**
 * Lay the picture clips end to end from 0, in order: no gaps, and no
 * overlaps except a cross-fade, which starts a clip exactly its length before
 * the previous one ends. A cross-fade is kept inside what both clips can give
 * — never longer than the clip itself, never into the part of the previous
 * clip its own cross-fade uses, and always leaving it a moment of its own so
 * the clips keep their order — and dropped (a cut) when less than
 * XFADE_MIN_S is left. The first clip has nothing to cross-fade from.
 */
export function layout(clips: VideoClip[]): VideoClip[] {
  let prevEnd = 0;
  let prevIn = 0;
  let prevLen = 0;
  return clips.map((c, i) => {
    let x = i > 0 ? crossfadeOf(c) : 0;
    if (x > 0) {
      // The previous clip must still start strictly before this one, or
      // sorting by start (both validators do) could swap the two.
      x = Math.min(x, XFADE_MAX_S, prevLen - prevIn - 0.001, clipLength(c));
      x = Math.floor(x * 1000 + 1e-6) / 1000;
      if (x < XFADE_MIN_S) x = 0;
    }
    let base: VideoClip = c;
    if (x > 0)
      base = {
        ...c,
        transition: { type: "crossfade", duration_s: x, ...styleOf(c) },
      };
    else if (c.transition?.type === "crossfade") base = withoutTransition(c);
    const start = i === 0 ? 0 : x > 0 ? ms(prevEnd - x) : nextStart(prevEnd);
    const placed = { ...base, start_s: start };
    prevEnd = clipEnd(placed);
    prevIn = x;
    prevLen = clipLength(placed);
    return placed;
  });
}

/** The longest cross-fade clip `id` can have from the clip before it (0 when
 *  it cannot have one: the first clip, or too little material on a side). */
export function maxCrossfade(model: EditorModel, id: string): number {
  const clips = layout(model.clips);
  const i = clips.findIndex((c) => c.id === id);
  if (i <= 0) return 0;
  const prevIn = crossfadeOf(clips[i - 1]);
  const nextOut = i + 1 < clips.length ? crossfadeOf(clips[i + 1]) : 0;
  const max = Math.min(
    XFADE_MAX_S,
    ms(clipLength(clips[i - 1]) - prevIn - 0.001),
    ms(clipLength(clips[i]) - nextOut - 0.001),
  );
  const floored = Math.floor(max * 1000 + 1e-6) / 1000;
  return floored >= XFADE_MIN_S ? floored : 0;
}

/** Cross-fade into clip `id` over `seconds` (bounded by maxCrossfade), or
 *  back to a cut with 0. Unchanged when the clip cannot have one. */
export function setCrossfade(
  model: EditorModel,
  id: string,
  seconds: number,
): EditorModel {
  const i = model.clips.findIndex((c) => c.id === id);
  if (i < 0) return model;
  if (!(seconds > 0)) {
    if (model.clips[i].transition?.type !== "crossfade") return model;
    return {
      ...model,
      clips: layout(
        model.clips.map((c) => (c.id === id ? withoutTransition(c) : c)),
      ),
    };
  }
  const max = maxCrossfade(model, id);
  if (!max) return model;
  const d = ms(clamp(seconds, XFADE_MIN_S, max));
  return {
    ...model,
    clips: layout(
      model.clips.map((c) =>
        c.id === id
          ? {
              ...c,
              transition: { type: "crossfade", duration_s: d, ...styleOf(c) },
            }
          : c,
      ),
    ),
  };
}

/** Change the style of the cross-fade into clip `id` (the plain `fade` removes
 *  the field: the document is then the one it was before styles existed).
 *  Unchanged when the clip has no cross-fade, or already has that style. */
export function setCrossfadeStyle(
  model: EditorModel,
  id: string,
  style: XfadeStyle,
): EditorModel {
  const i = model.clips.findIndex((c) => c.id === id);
  if (i < 0 || !(XFADE_STYLES as readonly string[]).includes(style)) return model;
  const tr = model.clips[i].transition;
  if (tr?.type !== "crossfade") return model;
  const current = styleOf(model.clips[i]).style ?? XFADE_DEFAULT_STYLE;
  if (current === style) return model;
  const next: Transition = {
    type: "crossfade",
    duration_s: tr.duration_s,
    ...(style === XFADE_DEFAULT_STYLE ? {} : { style }),
  };
  return {
    ...model,
    clips: model.clips.map((c) => (c.id === id ? { ...c, transition: next } : c)),
  };
}

/** The renderer's default text colours (modules/timeline.py TEXT_DEFAULTS):
 *  part of the video, not of the app's theme, so the preview uses them too. */
export const TEXT_COLOR = "#FFFFFF";
export const TEXT_OUTLINE_COLOR = "#000000";

const DEFAULT_TEXT: Omit<TextClip, "id" | "start_s" | "end_s" | "text"> = {
  size: 64,
  x: 0.5,
  y: 0.85,
  anchor: "center",
  bold: true,
};

/** A document's `grade` as the model keeps it: the three numbers, or nothing
 *  for none, an unusable value or "no change" (the same clip without it). */
function gradeFieldOf(v: unknown): { grade: ClipGrade } | object {
  if (!isObj(v) || !GRADE_KEYS.every((k) => isNum(v[k]))) return {};
  const grade = {
    brightness: v.brightness,
    contrast: v.contrast,
    saturation: v.saturation,
  } as ClipGrade;
  return isNeutralGrade(grade) ? {} : { grade };
}

/** A document clip's effect fields as the model holds them: only the ones
 *  that are usable and not "off" (the validator has the strict rules). */
function effectsOf(c: Record<string, unknown>): Partial<VideoClip> {
  const out: Record<string, unknown> = {};
  if (typeof c.filter === "string" && (FILTERS as readonly string[]).includes(c.filter)) {
    out.filter = c.filter;
    if (isNum(c.filter_strength) && c.filter_strength !== 1)
      out.filter_strength = c.filter_strength;
  }
  for (const k of [...UNIT_EFFECTS, "blur"])
    if (isNum(c[k]) && c[k] !== 0) out[k] = c[k];
  for (const k of ["flip_h", "flip_v"]) if (c[k] === true) out[k] = true;
  if (isInt(c.rotate) && (ROTATIONS as readonly number[]).includes(c.rotate) && c.rotate !== 0)
    out.rotate = c.rotate;
  return out as Partial<VideoClip>;
}

function transitionOf(v: unknown): { transition: Transition } | object {
  if (
    !isObj(v) ||
    !(TRANSITIONS as readonly unknown[]).includes(v.type) ||
    !isNum(v.duration_s)
  )
    return {};
  return {
    transition: {
      type: v.type as Transition["type"],
      duration_s: v.duration_s,
      ...(v.type === "crossfade" ? styleOf({ transition: v }) : {}),
    },
  };
}

/** A document's duck as the model holds it (defaults filled in), or null
 *  when it has none or it is not an object. */
function duckOf(v: unknown): Duck | null {
  if (!isObj(v) || !isNum(v.amount_db)) return null;
  return {
    amount_db: v.amount_db,
    attack_s: isNum(v.attack_s) ? v.attack_s : DUCK_DEFAULT.attack_s,
    release_s: isNum(v.release_s) ? v.release_s : DUCK_DEFAULT.release_s,
  };
}

/** A document's overlays as the model holds them (defaults filled in); an
 *  entry that is not an object with a usable id, asset and span is left out. */
function overlaysOf(v: unknown): PictureOverlay[] {
  if (!Array.isArray(v)) return [];
  const out: PictureOverlay[] = [];
  for (const o of v) {
    if (
      !isObj(o) ||
      typeof o.id !== "string" ||
      typeof o.asset_id !== "string" ||
      !isNum(o.start_s) ||
      !isNum(o.end_s)
    )
      continue;
    const num = (x: unknown, d: number) => (isNum(x) ? x : d);
    const anim = (key: "anim_in" | "anim_out") =>
      typeof o[key] === "string" &&
      (ANIM_OUT as readonly string[]).includes(o[key] as string)
        ? {
            [key]: o[key] as AnimOut,
            [`${key}_s`]: num(o[`${key}_s`], ANIM_DEFAULT_S),
          }
        : {};
    out.push({
      id: o.id,
      asset_id: o.asset_id,
      start_s: o.start_s,
      end_s: o.end_s,
      x: num(o.x, OVERLAY_DEFAULTS.x),
      y: num(o.y, OVERLAY_DEFAULTS.y),
      w: num(o.w, OVERLAY_DEFAULTS.w),
      opacity: num(o.opacity, OVERLAY_DEFAULTS.opacity),
      ...anim("anim_in"),
      ...anim("anim_out"),
      ...(isObj(o.move) ? { move: o.move as unknown as { to: OverlayMoveTo } } : {}),
    });
  }
  return out;
}

export function toModel(doc: TimelineDoc): EditorModel {
  const v = doc.tracks.find((t) => t.kind === "V");
  const clips: VideoClip[] = (v?.clips ?? [])
    .map((c) => ({
      id: String(c.id),
      asset_id: String(c.asset_id),
      start_s: Number(c.start_s),
      in_s: Number(c.in_s),
      out_s: Number(c.out_s),
      speed: isNum(c.speed) ? c.speed : 1,
      audio: c.audio === true,
      ...(c.fit === "cover" || c.fit === "contain" || c.fit === "blur"
        ? { fit: c.fit as "cover" | "contain" | "blur" }
        : {}),
      ...gradeFieldOf(c.grade),
      ...effectsOf(c),
      ...(c.reverse === true ? { reverse: true } : {}),
      ...(c.freeze === true ? { freeze: true } : {}),
      ...(isObj(c.move) ? { move: c.move as unknown as ClipMove } : {}),
      ...transitionOf(c.transition),
      ...(isNum(c.fade_in_s) && c.fade_in_s > 0
        ? { fade_in_s: c.fade_in_s }
        : {}),
      ...(isNum(c.fade_out_s) && c.fade_out_s > 0
        ? { fade_out_s: c.fade_out_s }
        : {}),
    }))
    .sort(
      (a, b) => a.start_s - b.start_s || byCodePoint(a.id, b.id),
    );
  // Every music / sound clip, whatever A track it was on: each gets a track
  // of its own again in toDoc, so two can play at once.
  const sounds: SoundClip[] = doc.tracks
    .filter((t) => t.kind === "A")
    .flatMap((t) =>
      t.clips.map((c) => ({
        id: String(c.id),
        asset_id: String(c.asset_id),
        start_s: Number(c.start_s),
        in_s: Number(c.in_s),
        out_s: Number(c.out_s),
        gain_db: isNum(c.gain_db) ? c.gain_db : 0,
        fade_in_s: isNum(c.fade_in_s) ? c.fade_in_s : 0,
        fade_out_s: isNum(c.fade_out_s) ? c.fade_out_s : 0,
        // Every clip of the track carries the track's own options: each
        // becomes a track of its own again in toDoc.
        ...(t.role === "music" || t.role === "speech" ? { role: t.role } : {}),
        ...(duckOf(t.duck) ? { duck: duckOf(t.duck) as Duck } : {}),
      })),
    );
  // Every text track's texts, in track order (later ones draw on top).
  const texts = doc.tracks
    .filter((t) => t.kind === "T")
    .flatMap((t) =>
      t.clips.map((c) => ({
        ...DEFAULT_TEXT,
        ...(c as Partial<TextClip>),
        id: String(c.id),
        start_s: Number(c.start_s),
        end_s: Number(c.end_s),
        text: String(c.text ?? ""),
      })),
    );
  const overlays = overlaysOf(doc.overlays);
  return {
    width: doc.width,
    height: doc.height,
    fps: doc.fps,
    clips,
    texts,
    sounds,
    ...(overlays.length ? { overlays } : {}),
    keep: doc.tracks.filter((t) => t !== v && t.kind !== "T" && t.kind !== "A"),
    ...(doc.captions !== undefined ? { captions: doc.captions } : {}),
  };
}

/**
 * The document for a model. Each text gets its own T track: texts on one
 * track may not share time (the renderer calls that an overlap), and two
 * texts on screen at once — a title and a caption-like line — is normal.
 */
export function toDoc(model: EditorModel): TimelineDoc {
  const tracks: TimelineTrack[] = [
    {
      id: "v1",
      kind: "V",
      clips: layout(model.clips).map((c) => ({
        ...c,
        in_s: ms(c.in_s),
        out_s: ms(c.out_s),
        speed: ms(c.speed),
      })),
    },
    ...model.keep,
  ];
  // Ids are one namespace across tracks, clips, sounds and texts.
  const used = new Set([
    ...tracks.flatMap((t) => [t.id, ...t.clips.map((c) => String(c.id))]),
    ...model.sounds.map((x) => x.id),
    ...model.texts.map((t) => t.id),
    ...(model.overlays ?? []).map((o) => o.id),
  ]);
  let a = 1;
  const soundTracks: TimelineTrack[] = [];
  for (const x of model.sounds) {
    while (used.has(`a${a}`)) a += 1;
    used.add(`a${a}`);
    soundTracks.push({
      id: `a${a}`,
      kind: "A",
      ...(x.role ? { role: x.role } : {}),
      ...(x.duck && x.role !== "speech"
        ? {
            duck: {
              amount_db: ms(x.duck.amount_db),
              attack_s: ms(x.duck.attack_s),
              release_s: ms(x.duck.release_s),
            },
          }
        : {}),
      clips: [
        {
          id: x.id,
          asset_id: x.asset_id,
          start_s: ms(x.start_s),
          in_s: ms(x.in_s),
          out_s: ms(x.out_s),
          gain_db: ms(x.gain_db),
          fade_in_s: ms(x.fade_in_s),
          fade_out_s: ms(x.fade_out_s),
        },
      ],
    });
  }
  // Sounds go right after the picture (where a music track always sat).
  tracks.splice(1, 0, ...soundTracks);
  let n = 1;
  for (const t of model.texts) {
    while (used.has(`t${n}`)) n += 1;
    used.add(`t${n}`);
    tracks.push({
      id: `t${n}`,
      kind: "T",
      clips: [
        {
          ...t,
          start_s: ms(t.start_s),
          end_s: ms(t.end_s),
          x: ms(t.x),
          y: ms(t.y),
        },
      ],
    });
  }
  return {
    version: 1,
    width: model.width,
    height: model.height,
    fps: model.fps,
    tracks,
    ...(model.captions !== undefined ? { captions: model.captions } : {}),
    ...(model.overlays?.length
      ? {
          overlays: model.overlays.map((o) => ({
            id: o.id,
            asset_id: o.asset_id,
            start_s: ms(o.start_s),
            end_s: ms(o.end_s),
            x: ms(o.x),
            y: ms(o.y),
            w: ms(o.w),
            opacity: ms(o.opacity),
            ...(o.anim_in ? { anim_in: o.anim_in, anim_in_s: ms(o.anim_in_s ?? ANIM_DEFAULT_S) } : {}),
            ...(o.anim_out ? { anim_out: o.anim_out, anim_out_s: ms(o.anim_out_s ?? ANIM_DEFAULT_S) } : {}),
            ...(o.move ? { move: o.move } : {}),
          })),
        }
      : {}),
  };
}

/** The model's length in seconds (picture and text; overlays never lengthen it). */
export function modelDuration(model: EditorModel): number {
  return docDuration(toDoc(model));
}

/** A new id for a clip or a text: letters and digits, never one the model uses. */
export function freshId(
  model: EditorModel,
  prefix: "c" | "x" | "m" | "o",
): string {
  // Track ids share the namespace too (v1, a1, t1, t2… are tracks).
  const used = new Set([
    "v1",
    ...model.clips.map((c) => c.id),
    ...model.texts.map((t) => t.id),
    ...model.sounds.map((x) => x.id),
    ...(model.overlays ?? []).map((o) => o.id),
    ...model.keep.flatMap((t) => [t.id, ...t.clips.map((c) => String(c.id))]),
  ]);
  for (
    let n =
      model.clips.length +
      model.texts.length +
      model.sounds.length +
      (model.overlays?.length ?? 0) +
      1;
    ;
    n += 1
  ) {
    const id = `${prefix}${n}`;
    if (!used.has(id)) return id;
  }
}

export interface EditorAsset {
  id: string;
  kind: "video" | "image" | "audio";
  name: string | null;
  durationS: number | null;
  width: number | null;
  height: number | null;
  viewUrl: string | null;
  thumbUrl: string | null;
}

/** The frame for a first video: its own orientation, at the editor's rate. */
export function frameFor(asset: Pick<EditorAsset, "width" | "height">): {
  width: number;
  height: number;
} {
  const w = asset.width ?? 0;
  const h = asset.height ?? 0;
  if (w > 0 && h > 0 && h > w) return { width: 1080, height: 1920 };
  if (w > 0 && h > 0 && h === w) return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

/** A first document: the whole video, with its own sound. */
export function newDocForAsset(
  asset: Pick<EditorAsset, "id" | "durationS" | "width" | "height">,
): TimelineDoc | null {
  const dur = asset.durationS;
  if (!dur || !(dur > 0)) return null;
  const out = Math.min(ms(dur), EXPORT_MAX_S);
  const { width, height } = frameFor(asset);
  return {
    version: 1,
    width,
    height,
    fps: EDITOR_FPS,
    tracks: [
      {
        id: "v1",
        kind: "V",
        clips: [
          {
            id: "c1",
            asset_id: asset.id,
            start_s: 0,
            in_s: 0,
            out_s: out,
            speed: 1,
            audio: true,
          },
        ],
      },
    ],
  };
}

/** How long a still picture is held when it is sent to the editor (a person
 *  trims it; any length is valid, the file has no time inside it). */
export const STILL_DEFAULT_S = 5;

/** A first document for ANY library file sent to the editor: a video starts
 *  as itself, a picture as a still held {@link STILL_DEFAULT_S} seconds, a
 *  sound as an audio track under an empty picture track (the export is black
 *  with the sound). null when the file has no known length where one is
 *  needed — an unknown length is never guessed. */
export function newDocForAnyAsset(
  asset: Pick<EditorAsset, "id" | "kind" | "durationS" | "width" | "height">,
): TimelineDoc | null {
  if (asset.kind === "video") return newDocForAsset(asset);
  const { width, height } = frameFor(asset);
  const empty: EditorModel = {
    width,
    height,
    fps: EDITOR_FPS,
    clips: [],
    texts: [],
    sounds: [],
    keep: [],
  };
  if (asset.kind === "image") {
    const next = addStill(empty, asset);
    return next === empty ? null : toDoc(next);
  }
  const out = addSound(empty, asset, 0);
  return out ? toDoc(out.model) : null;
}

/** A picture as one more clip at the end of the picture track: a still, no
 *  sound of its own (the renderer ignores `audio` on a picture anyway). */
export function addStill(
  model: EditorModel,
  asset: Pick<EditorAsset, "id">,
): EditorModel {
  if (model.clips.length >= MAX_EDITOR_CLIPS) return model;
  const clip: VideoClip = {
    id: freshId(model, "c"),
    asset_id: asset.id,
    start_s: 0,
    in_s: 0,
    out_s: STILL_DEFAULT_S,
    speed: 1,
    audio: false,
  };
  return { ...model, clips: layout([...model.clips, clip]) };
}

/** Why a file could not be added to an existing project. */
export type AppendProblem = "clips_full" | "sounds_full" | "no_duration";

/**
 * Add a library file to a saved document, the way the editor's own "add"
 * buttons would: a video or a picture goes to the END of the picture track, a
 * sound starts at 0 under the picture (the person moves it). Everything else
 * in the document — frame size, texts, captions, other tracks — is kept.
 *
 * Which organization the file belongs to is NOT decided here: the route reads
 * the file under the caller's session scoped to the project's organization,
 * and the database checks it again on save (0054 editor_doc_problem).
 */
export function appendAssetToDoc(
  doc: TimelineDoc,
  asset: Pick<EditorAsset, "id" | "kind" | "durationS">,
): { ok: true; doc: TimelineDoc } | { ok: false; problem: AppendProblem } {
  const model = toModel(doc);
  if (asset.kind === "audio") {
    if (!asset.durationS || !(asset.durationS > 0))
      return { ok: false, problem: "no_duration" };
    const out = addSound(model, asset, 0);
    return out
      ? { ok: true, doc: toDoc(out.model) }
      : { ok: false, problem: "sounds_full" };
  }
  if (asset.kind === "video" && !(asset.durationS && asset.durationS > 0))
    return { ok: false, problem: "no_duration" };
  const next =
    asset.kind === "video"
      ? addClip(model, asset)
      : addStill(model, asset);
  return next === model
    ? { ok: false, problem: "clips_full" }
    : { ok: true, doc: toDoc(next) };
}

/** How many sounds the final mix would have: every clip playing its own
 *  sound and every music / sound clip (MAX_AUDIO_CLIPS bounds them). */
export function audioInputs(model: EditorModel): number {
  return model.clips.filter((c) => c.audio).length + model.sounds.length;
}

export function addClip(
  model: EditorModel,
  asset: Pick<EditorAsset, "id" | "durationS">,
): EditorModel {
  if (!asset.durationS || model.clips.length >= MAX_EDITOR_CLIPS) return model;
  const clip: VideoClip = {
    id: freshId(model, "c"),
    asset_id: asset.id,
    start_s: 0,
    in_s: 0,
    out_s: ms(asset.durationS),
    speed: 1,
    // Its own sound, unless the mix is already full (it can be turned on
    // once something else is turned off).
    audio: audioInputs(model) < MAX_AUDIO_CLIPS,
  };
  return { ...model, clips: layout([...model.clips, clip]) };
}

/**
 * Trim: move a clip's in or out point (source seconds). Kept inside the source
 * (0..`sourceS` when known) and at least MIN_CLIP_S of SOURCE apart; the clips
 * after it move up or down (ripple), so the picture never has a gap.
 */
export function trimClip(
  model: EditorModel,
  id: string,
  edge: "in" | "out",
  value: number,
  sourceS: number | null,
): EditorModel {
  const clips = model.clips.map((c) => {
    if (c.id !== id) return c;
    const max = sourceS && sourceS > 0 ? ms(sourceS) : Number.POSITIVE_INFINITY;
    if (edge === "in")
      return { ...c, in_s: ms(clamp(value, 0, c.out_s - MIN_CLIP_S)) };
    return { ...c, out_s: ms(clamp(value, c.in_s + MIN_CLIP_S, max)) };
  });
  return { ...model, clips: layout(clips) };
}

/** The clip on screen at timeline time `t`, and where in its source that is. */
export function clipAt(
  model: EditorModel,
  t: number,
): { clip: VideoClip; index: number; sourceS: number } | null {
  const clips = layout(model.clips);
  for (let i = 0; i < clips.length; i += 1) {
    const c = clips[i];
    if (t >= c.start_s && t < clipEnd(c))
      return {
        clip: c,
        index: i,
        sourceS: ms(c.in_s + (t - c.start_s) * c.speed),
      };
  }
  return null;
}

/** Can clip `id` be split at timeline time `t` (both halves at least MIN_CLIP_S of source)? */
export function canSplit(model: EditorModel, id: string, t: number): boolean {
  if (model.clips.length >= MAX_EDITOR_CLIPS) return false;
  const c = layout(model.clips).find((x) => x.id === id);
  if (!c) return false;
  const cut = c.in_s + (t - c.start_s) * c.speed;
  return (
    t > c.start_s &&
    t < clipEnd(c) &&
    cut - c.in_s >= MIN_CLIP_S &&
    c.out_s - cut >= MIN_CLIP_S
  );
}

/** Split clip `id` at timeline time `t` (modules/timeline.py split_clip): the
 *  second half continues the same source at the same speed and sound. */
export function splitClip(
  model: EditorModel,
  id: string,
  t: number,
): { model: EditorModel; newId: string } | null {
  if (!canSplit(model, id, t)) return null;
  const clips = layout(model.clips);
  const i = clips.findIndex((x) => x.id === id);
  const c = clips[i];
  const cut = ms(c.in_s + (ms(t) - c.start_s) * c.speed);
  const newId = freshId(model, "c");
  // modules/timeline.py split_clip: the first half keeps the way in (its
  // transition and fade in), the second the way out (its fade out).
  // Played backwards, the part that comes first on the timeline is the LATER
  // part of the source range; a frozen clip's halves hold the same frame.
  const first: VideoClip = c.reverse
    ? { ...c, in_s: cut }
    : { ...c, out_s: cut };
  delete first.fade_out_s;
  const second: VideoClip = withoutTransition(
    c.reverse
      ? { ...c, id: newId, out_s: cut }
      : c.freeze
        ? { ...c, id: newId, out_s: ms(c.in_s + (clipEnd(c) - ms(t))) }
        : { ...c, id: newId, in_s: cut },
  );
  delete second.fade_in_s;
  if (second.audio && audioInputs(model) >= MAX_AUDIO_CLIPS)
    second.audio = false;
  if (c.move) {
    // The move goes on across the cut: the first half ends where the second
    // begins, at the window the whole move had reached at the cut.
    const f = (ms(t) - c.start_s) / clipLength(c);
    const at = (k: keyof typeof MOVE_POINT_DEFAULTS) => {
      const a = c.move!.from[k] ?? MOVE_POINT_DEFAULTS[k];
      const b = c.move!.to[k] ?? MOVE_POINT_DEFAULTS[k];
      return ms(a + (b - a) * f);
    };
    const mid = { zoom: at("zoom"), x: at("x"), y: at("y") };
    first.move = { from: c.move.from, to: mid };
    second.move = { from: mid, to: c.move.to };
  }
  const next = [...clips.slice(0, i), first, second, ...clips.slice(i + 1)];
  return { model: { ...model, clips: layout(next) }, newId };
}

export function setSpeed(
  model: EditorModel,
  id: string,
  speed: number,
): EditorModel {
  const s = clamp(ms(speed), SPEED_MIN, SPEED_MAX);
  return {
    ...model,
    clips: layout(
      model.clips.map((c) => (c.id === id ? { ...c, speed: s } : c)),
    ),
  };
}

export function setClipAudio(
  model: EditorModel,
  id: string,
  audio: boolean,
): EditorModel {
  if (audio && audioInputs(model) >= MAX_AUDIO_CLIPS) return model;
  return {
    ...model,
    clips: model.clips.map((c) => (c.id === id ? { ...c, audio } : c)),
  };
}

export function removeClip(model: EditorModel, id: string): EditorModel {
  if (model.clips.length <= 1) return model;
  return { ...model, clips: layout(model.clips.filter((c) => c.id !== id)) };
}

/** Move a clip one place earlier (-1) or later (+1). */
export function moveClip(
  model: EditorModel,
  id: string,
  by: -1 | 1,
): EditorModel {
  const clips = [...model.clips];
  const i = clips.findIndex((c) => c.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= clips.length) return model;
  [clips[i], clips[j]] = [clips[j], clips[i]];
  return { ...model, clips: layout(clips) };
}

/** Three positions a person picks from; each is a point and an anchor. */
export const TEXT_POSITIONS = {
  top: { x: 0.5, y: 0.12, anchor: "top" },
  middle: { x: 0.5, y: 0.5, anchor: "center" },
  bottom: { x: 0.5, y: 0.88, anchor: "bottom" },
} as const;
export type TextPosition = keyof typeof TEXT_POSITIONS;

export function positionOf(t: Pick<TextClip, "y">): TextPosition {
  if (t.y < 0.34) return "top";
  if (t.y > 0.66) return "bottom";
  return "middle";
}

/** A new text at timeline time `at`, three seconds long (shorter at the end). */
export function addText(
  model: EditorModel,
  at: number,
  text: string,
): { model: EditorModel; id: string } | null {
  if (model.texts.length >= MAX_EDITOR_TEXTS) return null;
  const total = Math.max(modelDuration(model), MIN_CLIP_S);
  const start = ms(clamp(at, 0, Math.max(0, total - MIN_CLIP_S)));
  const end = ms(Math.min(total, start + 3));
  const id = freshId(model, "x");
  const clip: TextClip = {
    ...DEFAULT_TEXT,
    ...TEXT_POSITIONS.bottom,
    id,
    start_s: start,
    end_s: Math.max(end, ms(start + MIN_CLIP_S)),
    text,
  };
  return { model: { ...model, texts: [...model.texts, clip] }, id };
}

export function updateText(
  model: EditorModel,
  id: string,
  patch: Partial<Omit<TextClip, "id">>,
): EditorModel {
  return {
    ...model,
    texts: model.texts.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, ...patch };
      if (patch.text !== undefined) next.text = patch.text.slice(0, MAX_TEXT);
      if (patch.size !== undefined)
        next.size = Math.round(clamp(patch.size, TEXT_SIZE_MIN, TEXT_SIZE_MAX));
      next.start_s = ms(Math.max(0, next.start_s));
      next.end_s = ms(Math.max(next.end_s, next.start_s + MIN_CLIP_S));
      return next;
    }),
  };
}

export function removeText(model: EditorModel, id: string): EditorModel {
  return { ...model, texts: model.texts.filter((t) => t.id !== id) };
}

// ── music and sound effects ─────────────────────────────────────────────────

/** Where the picture ends (the last clip's end). */
export function pictureEndOf(model: EditorModel): number {
  return layout(model.clips).reduce((e, c) => Math.max(e, clipEnd(c)), 0);
}

export function soundLength(x: Pick<SoundClip, "in_s" | "out_s">): number {
  return ms(ms(x.out_s) - ms(x.in_s));
}

export function canAddSound(model: EditorModel): boolean {
  return (
    model.sounds.length < MAX_EDITOR_SOUNDS &&
    audioInputs(model) < MAX_AUDIO_CLIPS
  );
}

/** Fades kept inside the sound: each 0..SOUND_FADE_MAX_S, and together no
 *  longer than it; the one just changed (`keep`) wins. */
function fitFades(
  x: SoundClip,
  keep: "in" | "out" | null,
): Pick<SoundClip, "fade_in_s" | "fade_out_s"> {
  const len = soundLength(x);
  let fi = ms(clamp(x.fade_in_s, 0, Math.min(SOUND_FADE_MAX_S, len)));
  let fo = ms(clamp(x.fade_out_s, 0, Math.min(SOUND_FADE_MAX_S, len)));
  if (fi + fo > len + 1e-9) {
    if (keep === "out") fi = ms(Math.max(0, len - fo));
    else fo = ms(Math.max(0, len - fi));
  }
  return { fade_in_s: fi, fade_out_s: fo };
}

/**
 * A music or sound file at timeline time `at` (the playhead): from its
 * beginning, and no longer than the picture has left — a song longer than
 * the video would make the export longer, with black at the end.
 */
export function addSound(
  model: EditorModel,
  asset: Pick<EditorAsset, "id" | "durationS">,
  at: number,
): { model: EditorModel; id: string } | null {
  const dur = asset.durationS;
  if (!dur || !(dur > 0) || !canAddSound(model)) return null;
  const picture = pictureEndOf(model);
  const start = ms(clamp(at, 0, Math.max(0, picture - MIN_CLIP_S)));
  const room = picture - start;
  const length = ms(
    Math.max(Math.min(dur, room > MIN_CLIP_S ? room : dur), MIN_CLIP_S),
  );
  const id = freshId(model, "m");
  const sound: SoundClip = {
    id,
    asset_id: asset.id,
    start_s: start,
    in_s: 0,
    out_s: ms(Math.min(length, dur)),
    gain_db: 0,
    fade_in_s: 0,
    fade_out_s: 0,
  };
  return { model: { ...model, sounds: [...model.sounds, sound] }, id };
}

/** Change a sound, kept renderable: inside its file (`sourceS` when known),
 *  at least MIN_CLIP_S long, volume within GAIN_DB_MIN..GAIN_DB_MAX, fades
 *  that fit. */
export function updateSound(
  model: EditorModel,
  id: string,
  patch: Partial<Omit<SoundClip, "id" | "asset_id">>,
  sourceS: number | null,
): EditorModel {
  return {
    ...model,
    sounds: model.sounds.map((x) => {
      if (x.id !== id) return x;
      const max =
        sourceS && sourceS > 0 ? ms(sourceS) : Number.POSITIVE_INFINITY;
      const next = { ...x, ...patch };
      next.start_s = ms(clamp(next.start_s, 0, MAX_DURATION_S));
      if (patch.in_s !== undefined)
        next.in_s = ms(clamp(next.in_s, 0, next.out_s - MIN_CLIP_S));
      if (patch.out_s !== undefined)
        next.out_s = ms(clamp(next.out_s, next.in_s + MIN_CLIP_S, max));
      next.gain_db = ms(clamp(next.gain_db, GAIN_DB_MIN, GAIN_DB_MAX));
      if (next.duck) next.duck = clampDuck(next.duck);
      // A speech sound is never lowered (the document refuses a duck on one).
      if (next.role === "speech" || !next.duck) delete next.duck;
      if (next.role === undefined) delete next.role;
      const keep =
        patch.fade_out_s !== undefined
          ? "out"
          : patch.fade_in_s !== undefined
            ? "in"
            : null;
      return { ...next, ...fitFades(next, keep) };
    }),
  };
}

/** A duck kept inside what a document accepts. */
export function clampDuck(d: Duck): Duck {
  return {
    amount_db: ms(clamp(d.amount_db, DUCK_DB_MIN, DUCK_DB_MAX)),
    attack_s: ms(clamp(d.attack_s, DUCK_ATTACK_MIN_S, DUCK_ATTACK_MAX_S)),
    release_s: ms(clamp(d.release_s, DUCK_RELEASE_MIN_S, DUCK_RELEASE_MAX_S)),
  };
}

/** Where speech plays on the timeline, sorted: every picture clip that plays
 *  its own sound and every sound marked as speech (modules/timeline.py
 *  speech_spans; the render also needs the source to really carry sound,
 *  which only the worker can tell). */
export function speechSpans(model: EditorModel): [number, number][] {
  const out: [number, number][] = [];
  for (const c of layout(model.clips))
    if (c.audio) out.push([ms(c.start_s), clipEnd(c)]);
  for (const x of model.sounds)
    if (x.role === "speech") out.push([ms(x.start_s), ms(x.start_s + soundLength(x))]);
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** Spans joined across a pause shorter than `gapS` (modules/timeline.py
 *  merge_spans): music that has no time to come back up stays down. */
export function mergeSpans(
  spans: readonly (readonly [number, number])[],
  gapS: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1];
    if (last && s - last[1] < gapS) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** The linear gain a duck applies at timeline time `t`: 1 away from speech,
 *  `10 ** (-amount / 20)` inside it, ramped over attack (ending where speech
 *  starts) and release (starting where it ends). The same envelope the
 *  export's volume filter draws (render_spec.duck_expression). */
export function duckGainAt(
  duck: Duck,
  speech: readonly (readonly [number, number])[],
  t: number,
): number {
  let depth = 0;
  for (const [s, e] of mergeSpans(speech, duck.attack_s + duck.release_s))
    depth = Math.max(
      depth,
      clamp(
        Math.min(
          (t - (s - duck.attack_s)) / duck.attack_s,
          (e + duck.release_s - t) / duck.release_s,
        ),
        0,
        1,
      ),
    );
  return 1 - (1 - 10 ** (-duck.amount_db / 20)) * depth;
}

/** True when a ducked sound has speech to be lowered under: without any, the
 *  setting does nothing and the person should be told so. */
export function hasSpeech(model: EditorModel): boolean {
  return speechSpans(model).length > 0;
}

/** End a sound where the picture ends (when it starts before that). */
export function fitSoundToPicture(model: EditorModel, id: string): EditorModel {
  const picture = pictureEndOf(model);
  const x = model.sounds.find((s) => s.id === id);
  if (!x || picture - x.start_s < MIN_CLIP_S) return model;
  return updateSound(
    model,
    id,
    { out_s: ms(x.in_s + (picture - x.start_s)) },
    null,
  );
}

export function removeSound(model: EditorModel, id: string): EditorModel {
  return { ...model, sounds: model.sounds.filter((x) => x.id !== id) };
}

/** Sounds a person should know about: one that runs past the end of the
 *  picture makes the export longer, with black at the end. */
export function soundWarnings(model: EditorModel): Record<string, "past_end"> {
  const picture = pictureEndOf(model);
  const out: Record<string, "past_end"> = {};
  for (const x of model.sounds)
    if (ms(x.start_s + soundLength(x)) > picture + 0.001) out[x.id] = "past_end";
  return out;
}

/** Text on screen at time `t`. */
export function textsAt(model: EditorModel, t: number): TextClip[] {
  return model.texts.filter((x) => t >= x.start_s && t < x.end_s);
}

/** Two texts may share time (they are layers); the problems the editor shows are
 *  the ones a person can fix: an empty text, or text that ends after the video. */
export function textWarnings(
  model: EditorModel,
): Record<string, "empty" | "past_end"> {
  const out: Record<string, "empty" | "past_end"> = {};
  const picture = layout(model.clips).reduce(
    (e, c) => Math.max(e, clipEnd(c)),
    0,
  );
  for (const t of model.texts) {
    if (!t.text.trim()) out[t.id] = "empty";
    else if (t.start_s >= picture) out[t.id] = "past_end";
  }
  return out;
}

// ── time, for people ────────────────────────────────────────────────────────

/** 83.4 → "1:23.4" */
export function formatTime(s: number): string {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60);
  const rest = v - m * 60;
  const tenths = Math.floor(rest * 10 + 1e-6) / 10;
  return `${m}:${tenths.toFixed(1).padStart(4, "0")}`;
}

// ── the database's answers ──────────────────────────────────────────────────

export type ExportStatus = "queued" | "rendering" | "done" | "failed";
export const EXPORT_REASONS = [
  "invalid_timeline",
  "asset_unavailable",
  "too_long",
  "render_failed",
  "store_failed",
  "timed_out",
  "worker_lost",
  "project_deleted",
] as const;
export type ExportReason = (typeof EXPORT_REASONS)[number];

export interface EditorExport {
  id: string;
  rev: number;
  status: ExportStatus;
  reason: ExportReason | "other" | null;
  durationS: number | null;
  assetId: string | null;
  createdAt: string | null;
  finishedAt: string | null;
}

export const EDITOR_EXPORT_COLUMNS =
  "id, rev, status, reason, duration_s, asset_id, created_at, finished_at";
export const EDITOR_PROJECT_COLUMNS =
  "id, org_id, title, rev, doc, created_at, updated_at";
export const EDITOR_PROJECT_LIST_COLUMNS = "id, title, rev, updated_at";

/**
 * Rows as the database sends them (snake_case, the server's read) AND as the
 * project route sends them on (already camelCase, what the page's poll reads):
 * the page used to read only the first shape, so a polled export lost its file,
 * its length and its times.
 */
export function coerceExports(rows: unknown): EditorExport[] {
  if (!Array.isArray(rows)) return [];
  const str = (a: unknown, b: unknown) => (typeof a === "string" ? a : typeof b === "string" ? b : null);
  const out: EditorExport[] = [];
  for (const r of rows) {
    if (!isObj(r) || typeof r.id !== "string") continue;
    const status = (["queued", "rendering", "done", "failed"] as const).find(
      (s) => s === r.status,
    );
    if (!status) continue;
    const reason =
      r.reason == null
        ? null
        : (EXPORT_REASONS as readonly unknown[]).includes(r.reason)
          ? (r.reason as ExportReason)
          : "other";
    const dur = Number(r.duration_s ?? r.durationS);
    out.push({
      id: r.id,
      rev: Number(r.rev) || 0,
      status,
      reason,
      durationS: Number.isFinite(dur) && dur > 0 ? dur : null,
      assetId: str(r.asset_id, r.assetId),
      createdAt: str(r.created_at, r.createdAt),
      finishedAt: str(r.finished_at, r.finishedAt),
    });
  }
  return out;
}

export function exportActive(exports: readonly EditorExport[]): boolean {
  return exports.some((e) => e.status === "queued" || e.status === "rendering");
}

export const EDITOR_ERRORS = [
  "unauthorized",
  "forbidden",
  "not_found",
  "bad_request",
  "invalid_title",
  "invalid_doc",
  "doc_too_large",
  "invalid_asset",
  "empty",
  "too_long",
  "stale_revision",
  "export_in_progress",
  "limit_reached",
  "daily_limit",
  "clips_full",
  "sounds_full",
  "no_duration",
  "not_available",
  "network",
  "failed",
] as const;
export type EditorError = (typeof EDITOR_ERRORS)[number];

const DB_WORDS: Partial<Record<string, EditorError>> = {
  invalid_title: "invalid_title",
  invalid_doc: "invalid_doc",
  doc_too_large: "doc_too_large",
  invalid_asset: "invalid_asset",
  empty: "empty",
  too_long: "too_long",
  stale_revision: "stale_revision",
  export_in_progress: "export_in_progress",
  limit_reached: "limit_reached",
  daily_limit: "daily_limit",
};

/** A database refusal (SQLSTATE + machine word, migration 0054) → a word and an HTTP status. */
export function mapEditorError(
  error: { code?: string; message?: string } | null | undefined,
): { error: EditorError; status: number } {
  const word = (error?.message ?? "").trim();
  switch (error?.code) {
    case "NS400":
      return { error: DB_WORDS[word] ?? "bad_request", status: 400 };
    case "NS409":
      return { error: DB_WORDS[word] ?? "stale_revision", status: 409 };
    case "NS429":
      return { error: DB_WORDS[word] ?? "limit_reached", status: 429 };
    case "42501":
      return { error: "forbidden", status: 403 };
    case "P0002":
      return { error: "not_found", status: 404 };
    case "22P02":
      return { error: "bad_request", status: 400 };
    case "PGRST202":
    case "PGRST205":
    case "42883":
    case "42P01":
    case "42703":
      return { error: "not_available", status: 503 };
  }
  if (
    /could not find the (function|table)|does not exist/i.test(
      error?.message ?? "",
    )
  )
    return { error: "not_available", status: 503 };
  return { error: "failed", status: 502 };
}

/** A word from a route's answer, or "failed" when the page has no sentence for it. */
export function editorErrorWord(raw: unknown): EditorError {
  return (EDITOR_ERRORS as readonly unknown[]).includes(raw)
    ? (raw as EditorError)
    : "failed";
}

/** A project title a person typed, the way the database stores it (0054 editor_clean_title). */
export function cleanTitle(raw: unknown): string {
  return (typeof raw === "string" ? raw : "")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
}

export function parseTitle(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: "invalid_title" } {
  const v = cleanTitle(raw);
  return v.length >= 1 && v.length <= 120
    ? { ok: true, value: v }
    : { ok: false, error: "invalid_title" };
}

/** Every asset id a document names (lower-case, once each). */
export function docAssetIds(doc: TimelineDoc): string[] {
  const ids = new Set<string>();
  for (const t of doc.tracks)
    for (const c of t.clips)
      if (typeof c.asset_id === "string") ids.add(c.asset_id.toLowerCase());
  for (const o of doc.overlays ?? [])
    if (isObj(o) && typeof o.asset_id === "string")
      ids.add(o.asset_id.toLowerCase());
  return [...ids].sort();
}

/** What a track kind may hold (modules/timeline.py TRACK_ASSET_KINDS). */
const TRACK_ASSET_KINDS: Record<"V" | "A", readonly string[]> = {
  V: ["video", "image"],
  A: ["audio"],
};

/**
 * Why the files a document names may not be used as it uses them — the twin
 * of modules/timeline.py `resolve_assets`' kind check. `kinds` is what the
 * caller's own session could read (RLS: its organizations' live files); an id
 * missing from it is not available, exactly like a made-up one. Which
 * organization a file belongs to is the database's check (0054
 * editor_doc_problem), not this one.
 */
export function docAssetProblems(
  doc: TimelineDoc,
  kinds: Record<string, string>,
): string[] {
  const problems: string[] = [];
  const known = new Map(
    Object.entries(kinds).map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const id of docAssetIds(doc))
    if (!known.has(id)) problems.push(`asset ${id} is not available`);
  for (const t of doc.tracks) {
    if (t.kind !== "V" && t.kind !== "A") continue;
    const allowed = TRACK_ASSET_KINDS[t.kind];
    for (const c of t.clips) {
      const kind = known.get(String(c.asset_id).toLowerCase());
      if (kind !== undefined && !allowed.includes(kind))
        problems.push(
          `track ${t.id} clip ${String(c.id)}: a ${t.kind} track takes ${allowed.join(" or ")}, not ${kind}`,
        );
    }
  }
  // Overlays: a picture or a video (modules/timeline.py OVERLAY_ASSET_KINDS),
  // at most MAX_OVERLAY_VIDEOS of them videos.
  let videos = 0;
  for (const o of doc.overlays ?? []) {
    if (!isObj(o)) continue;
    const kind = known.get(String(o.asset_id).toLowerCase());
    if (kind === "video") videos += 1;
    if (kind !== undefined && kind !== "video" && kind !== "image")
      problems.push(
        `overlay ${String(o.id)}: an overlay takes video or image, not ${kind}`,
      );
  }
  if (videos > MAX_OVERLAY_VIDEOS)
    problems.push(`timeline: at most ${MAX_OVERLAY_VIDEOS} video overlays`);
  return problems;
}

/** The size the database measures, roughly: the JSON text in bytes. */
export function docBytes(doc: unknown): number {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}
