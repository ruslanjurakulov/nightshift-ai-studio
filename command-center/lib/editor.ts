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
  rampAbsolute,
  rampOutLength,
  rampSourceAt,
} from "@/lib/editorSpeedRamp";
import {
  ARROW_DIRS,
  ASPECT_MAX,
  ASPECT_MIN,
  KIND_FIELDS,
  MAX_SHAPES,
  PROGRESS_ANIMS,
  PROGRESS_EDGES,
  SHAPE_COMMON,
  SHAPE_KINDS,
  SHAPE_MOVE_KEYS,
  SHAPE_OUTLINE_MAX,
  SHAPE_REQUIRED,
  SHAPE_W_MAX,
  SHAPE_W_MIN,
  THICK_MAX,
  THICK_MIN,
  ASPECT_DEFAULT,
  DIR_DEFAULT,
  EDGE_DEFAULT,
  SHAPE_COLOR_DEFAULT,
  SHAPE_DEFAULTS,
  THICK_DEFAULTS,
  isShapeKind,
  memoryBudgetBytes,
  memoryEstimateBytes,
  type CostPicture,
  shapeTextProblem,
  shapeWorkSeconds,
  type ArrowDir,
  type CostShape,
  type WorkShape,
  type ProgressEdge,
  type ShapeLayer,
  type ShapeMoveTo,
} from "@/lib/editorShapes";
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
/** A clip's constant speed (modules/timeline.py SPEED_MIN/MAX; 0.25-4 before the editor-parity change). */
export const SPEED_MIN = 0.1;
export const SPEED_MAX = 10;
/** A speed CURVE's points keep the narrower range its sound slices were tuned for (timeline.py RAMP_SPEED_*). */
export const RAMP_SPEED_MIN = 0.25;
export const RAMP_SPEED_MAX = 4;
/** The speeds the editor's keys offer, from the document's slowest to its fastest (any value between is valid; the number box takes it). */
export const SPEEDS = [SPEED_MIN, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, SPEED_MAX] as const;
export const SIZE_MIN = 8;
export const SIZE_MAX = 512;
/** The text sizes the editor's slider offers, in output pixels. */
export const TEXT_SIZE_MIN = 24;
export const TEXT_SIZE_MAX = 200;
export const GAIN_DB_MIN = -60;
export const GAIN_DB_MAX = 12;
/** A video clip's own sound: from silent up to about 200 % (+6 dB); timeline.py CLIP_GAIN_DB_MAX. */
export const CLIP_GAIN_DB_MAX = 6;
/** The clip volume control (0-200 %): its loudest step, and 0 % is GAIN_DB_MIN (-60 dB, silent to the ear). */
export const CLIP_VOLUME_MAX_PCT = 200;
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
/** Overlays that change opacity between two visible values in a move cost a per-pixel
 *  filter (modules/timeline.py MAX_PARTIAL_OPACITY_MOVES). */
export const MAX_PARTIAL_OPACITY_MOVES = 2;
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
/** A cross-faded clip in a frame above 1440p takes no blur (the render would run out of
 *  memory; modules/timeline.py LARGE_FRAME_PX / XFADE_LARGE_BLUR_MAX). */
export const LARGE_FRAME_PX = 2560 * 1440;
export const XFADE_LARGE_BLUR_MAX = 0;
/** ... and a zoom above this on such a clip (modules/timeline.py XFADE_LARGE_ZOOM_MAX). */
export const XFADE_LARGE_ZOOM_MAX = 2;
export const ROTATIONS = [0, 90, 180, 270] as const;
/** A clip's move: the zoom window's range (modules/timeline.py MOVE_ZOOM_*). */
export const MOVE_ZOOM_MIN = 1;
export const MOVE_ZOOM_MAX = 4;
export const MOVE_POINT_DEFAULTS = { zoom: 1, x: 0.5, y: 0.5 } as const;
/** A clip's speed curve (modules/timeline.py RAMP_* / INTERP_*): 2 to 6 points,
 *  and the budget of motion-interpolated frames (1080p equivalent). */
export const RAMP_MIN_POINTS = 2;
export const RAMP_MAX_POINTS = 6;
export const RAMP_MIN_GAP = 0.01;
export const INTERP_MAX_FPS = 120;
export const INTERP_MAX_FRAMES = 300;
export const INTERP_MAX_FRAMES_DOC = 600;
const INTERP_REF_PIXELS = 1920 * 1080;
/** Stabilising decodes a clip twice: the longest range of one clip and the
 *  total per document, in seconds (modules/timeline.py STABILIZE_*). */
export const STABILIZE_MAX_S = 120;
export const STABILIZE_MAX_DOC_S = 300;
/** What stabilising is charged in the render's estimate, in 1080p-equivalent frames per
 *  second (modules/timeline.py STABILIZE_FPS_1080P). */
export const STABILIZE_FPS_1080P = 7;
/** The estimated seconds of render work stabilising a clip costs
 *  (modules/timeline.py `stabilize_seconds`). */
export function stabilizeSeconds(
  clip: Record<string, unknown>,
  fps: number,
  width: number,
  height: number,
): number {
  if (!isNum(clip.in_s) || !isNum(clip.out_s)) return 0;
  const frames = Math.max(0, ms(clip.out_s) - ms(clip.in_s)) * fps;
  return (frames * width * height) / INTERP_REF_PIXELS / STABILIZE_FPS_1080P;
}
/** No interpolation above 1440p (modules/timeline.py INTERP_MAX_PIXELS). */
export const INTERP_MAX_PIXELS = 2560 * 1440;
/** The worker's render budget and what a render is charged against it
 *  (modules/timeline.py RENDER_*, INTERP_SECONDS_PER_FRAME; editor_export has the same). */
export const RENDER_TIMEOUT_PER_S = 3;
export const RENDER_TIMEOUT_BASE_S = 120;
export const RENDER_TIMEOUT_MAX_S = 5400;
export const RENDER_PLAIN_FACTOR = 1;
export const INTERP_SECONDS_PER_FRAME = 0.4;
/** Render seconds charged per second of SOURCE a clip faster than 1x decodes beyond its own length
 *  (modules/timeline.py FAST_SECONDS_PER_SOURCE_S; calibrated on a 1080p60 phone-like source). */
export const FAST_SECONDS_PER_SOURCE_S = 0.35;
export function renderTimeoutS(lengthS: number): number {
  return Math.min(
    RENDER_TIMEOUT_MAX_S,
    RENDER_TIMEOUT_PER_S * Math.max(0, lengthS) + RENDER_TIMEOUT_BASE_S,
  );
}
/** A clip's crop rectangle (smallest side) and free angle (modules/timeline.py
 *  CROP_MIN / ANGLE_MAX). */
export const CROP_MIN = 0.05;
export const ANGLE_MAX = 180;
export const CROP_DEFAULTS = { x: 0, y: 0, w: 1, h: 1 } as const;
/** An overlay's chroma key (modules/timeline.py CHROMA_*). */
export const CHROMA_SIMILARITY_MIN = 0.01;
export const CHROMA_SIMILARITY_MAX = 0.6;
export const CHROMA_SIMILARITY_DEFAULT = 0.15;
export const CHROMA_BLEND_MAX = 0.5;
export const CHROMA_BLEND_DEFAULT = 0.1;
/** Reverse holds every frame of the range in memory at the output size
 *  (modules/timeline.py REVERSE_MAX_BYTES / REVERSE_BYTES_PER_PIXEL). */
export const REVERSE_MAX_BYTES = 512 * 1024 * 1024;
export const REVERSE_BYTES_PER_PIXEL = 1.5;
/** The most frames a reversed range may hold at this frame size
 *  (modules/timeline.py `reverse_max_frames`). */
export function reverseMaxFrames(width: number, height: number): number {
  return Math.floor(REVERSE_MAX_BYTES / (width * height * REVERSE_BYTES_PER_PIXEL));
}
/** Frames a source range decodes (`_range_frames`: ceil, float noise removed). */
function rangeFrames(rangeS: number, fps: number): number {
  return Math.ceil(Math.round(rangeS * fps * 1e6) / 1e6);
}
/** The longest source range a clip may play reversed at this frame size and
 *  rate, in seconds: a whole number of frames, rounded down to a millisecond —
 *  exactly what the validator allows (modules/timeline.py `reverse_max_seconds`). */
export function reverseMaxSeconds(width: number, height: number, fps: number): number {
  const cap = reverseMaxFrames(width, height);
  let limit = Math.floor((cap / fps) * 1000 + 1e-9) / 1000;
  while (limit > 0 && rangeFrames(limit, fps) > cap) limit = Math.round((limit - 0.001) * 1000) / 1000;
  return limit;
}
export type Rotation = (typeof ROTATIONS)[number];
/** Advanced colour on a V clip (modules/timeline.py COLOR_*; a test pins them): temperature -100 (cool)
 *  .. 100 (warm), tint -100 (green) .. 100 (magenta), hue -180..180 degrees, a named tone curve. Saturation
 *  and lightness are the clip's `grade`. */
export const COLOR_TEMP_MAX = 100;
export const COLOR_TINT_MAX = 100;
export const COLOR_HUE_MAX = 180;
export const COLOR_CURVES = [
  "lighter",
  "darker",
  "contrast",
  "strong-contrast",
  "matte",
  "cross-process",
] as const;
export type ColorCurve = (typeof COLOR_CURVES)[number];
const COLOR_KEYS = ["temperature", "tint", "hue", "curve"];
/** A shape mask on a V clip (modules/timeline.py MASK_*): centre and size in frame fractions, a feather and
 *  a rounded shape's corner radius as fractions of the shape's shorter side. */
export const MASK_SHAPES = ["rect", "ellipse", "rounded"] as const;
export type MaskShape = (typeof MASK_SHAPES)[number];
export const MASK_MIN = 0.05;
export const MASK_FEATHER_MAX = 0.5;
export const MASK_RADIUS_MAX = 0.5;
export const MASK_DEFAULTS = { x: 0.5, y: 0.5, w: 0.6, h: 0.6, feather: 0 } as const;
export const MASK_RADIUS_DEFAULT = 0.25;
const MASK_KEYS = ["shape", "x", "y", "w", "h", "feather", "radius", "invert"];
/** What colour and masks add to the render-time estimate, seconds per second of a clip at 1080p30, scaled by
 *  the frame's pixels x rate (modules/timeline.py, the same numbers; measured, docs section 14). */
export const LOOK_REF_PIXEL_RATE = 1920 * 1080 * 30;
export const COLOR_CHROMA_SECONDS_PER_S = 0.15;
export const COLOR_HUE_SECONDS_PER_S = 0.2;
export const COLOR_CURVE_SECONDS_PER_S = 0.35;
export const MASK_SECONDS_PER_S = 0.3;
/** Effects pack on a V clip (modules/timeline.py FX_*): each an intensity 0..100, 0 = off. */
export const FX_NAMES = ["glitch", "shake", "rgb_split", "flash"] as const;
export type FxName = (typeof FX_NAMES)[number];
export const FX_MAX = 100;
/** Seconds per second of a clip at 1080p30 (scaled like the colour's; measured, docs section 16). */
export const FX_SECONDS_PER_S: Record<FxName, number> = { glitch: 0.35, shake: 0.2, rgb_split: 0.55, flash: 0.1 };
/** Above 1440p a cross-faded clip takes at most this many effects of the pack (measured: out of memory). */
export const FX_LARGE_XFADE_MAX = 1;
/** A V clip's entrance / exit (modules/timeline.py V_ANIMS); each at most half the clip. */
export const V_ANIMS = ["fade", "slide-up", "slide-down", "slide-left", "slide-right", "zoom"] as const;
export type VideoAnim = (typeof V_ANIMS)[number];
/** A slide or zoom lays the picture over black on every frame of the clip. */
export const ANIM_MOVE_SECONDS_PER_S = 0.3;
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
/** A #RRGGBB colour (the document's, one definition for the validators and the editor's colour controls). */
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const DOC_REQUIRED = ["version", "width", "height", "fps", "tracks"];
const DOC_KEYS = [...DOC_REQUIRED, "captions", "overlays", "shapes"];
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
  "denoise",
  "loudnorm",
  "crop",
  "angle",
  "speed_curve",
  "interpolate",
  "stabilize",
  "color",
  "mask",
  "fx",
  "anim_in",
  "anim_out",
  "anim_in_s",
  "anim_out_s",
  "gain_db",
  ...EFFECT_KEYS,
];
const A_CLIP_KEYS = [
  ...MEDIA_REQUIRED,
  "gain_db",
  "fade_in_s",
  "fade_out_s",
  "denoise",
  "loudnorm",
];
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
  "chroma",
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

/** One point of a speed curve: `at` is a fraction of the source range. */
export interface SpeedPoint {
  at: number;
  speed: number;
}

/** A rectangle of the source picture as fractions of it (after rotate/flip,
 *  before the fit); missing keys take CROP_DEFAULTS. */
export interface ClipCrop {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface ClipColor {
  temperature?: number;
  tint?: number;
  hue?: number;
  curve?: ColorCurve;
}

export interface ClipMask {
  shape: MaskShape;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  feather?: number;
  /** A rounded shape's corner (fraction of the shorter side); only on `rounded`. */
  radius?: number;
  /** Black inside the shape instead of outside. */
  invert?: boolean;
}

export interface VideoClip {
  id: string;
  asset_id: string;
  start_s: number;
  in_s: number;
  out_s: number;
  speed: number;
  audio: boolean;
  /** The level of the clip's own sound in dB (GAIN_DB_MIN..CLIP_GAIN_DB_MAX); absent = 0, as
   *  recorded. Only matters with `audio: true`. The editor shows it as 0-200 %. */
  gain_db?: number;
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
  /** Clean-up of the clip's own sound: FFT noise reduction, then loudness
   *  normalisation (-16 LUFS). Only matters with `audio: true`. */
  denoise?: boolean;
  loudnorm?: boolean;
  /** Keep a rectangle of the source before the fit. */
  crop?: ClipCrop;
  /** Degrees clockwise (-180..180) the fitted picture is turned in the frame. */
  angle?: number;
  /** A speed ramp instead of `speed` (which is then 1): 2-6 points, linear
   *  between them; the first at 0 and the last at 1 of the source range. */
  speed_curve?: SpeedPoint[];
  /** Smoother slow motion by interpolation (slow to render; budgeted). */
  interpolate?: boolean;
  /** Smooth camera shake (decodes the clip twice; video only, not with freeze). */
  stabilize?: boolean;
  /** Advanced colour (lib/editorLook.ts); none = no change. */
  color?: ClipColor;
  /** A shape the picture is seen through, fixed in the frame (lib/editorLook.ts). */
  mask?: ClipMask;
  /** The effects pack, each 0..FX_MAX (lib/editorFxPack.ts). */
  fx?: Partial<Record<FxName, number>>;
  /** Entrance / exit (V_ANIMS) and their seconds (ANIM_MIN_S..ANIM_MAX_S, at most half the clip). */
  anim_in?: VideoAnim;
  anim_out?: VideoAnim;
  anim_in_s?: number;
  anim_out_s?: number;
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
  /** FFT noise reduction / loudness normalisation (-16 LUFS) of this sound. */
  denoise?: boolean;
  loudnorm?: boolean;
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
  /** Chroma key: pixels near `color` become transparent. */
  chroma?: ChromaKey;
}

export interface ChromaKey {
  color: string;
  similarity?: number;
  blend?: number;
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
  /** Drawn stickers (modules/timeline.py `shapes`; lib/editorShapes.ts). */
  shapes?: unknown[];
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
  /** Drawn stickers over the picture (arrow, ring, star, label, line, progress bar); none = the field is absent. */
  shapes?: ShapeLayer[];
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
  return ms(ms(Number(r.start_s)) + mediaLength(r));
}

/** How long a media clip lasts on the timeline (modules/timeline.py
 *  `clip_length_s`): its source range at its speed, or at its speed curve. */
function mediaLength(r: Record<string, unknown>): number {
  const range = ms(Number(r.out_s)) - ms(Number(r.in_s));
  const curve = usableCurve(r.speed_curve);
  if (curve) return ms(rampOutLength(rampAbsolute(curve, range)));
  return ms(range / speedOf(r));
}

/** The estimated render seconds a clip faster than 1x adds (modules/timeline.py `fast_seconds`):
 *  FAST_SECONDS_PER_SOURCE_S per second of source beyond its own length; 0 at or below 1x, frozen, or
 *  for a range that is not a usable number. */
export function fastSeconds(c: Record<string, unknown> | VideoClip): number {
  const r = c as Record<string, unknown>;
  if (r.freeze === true || !isNum(r.in_s) || !isNum(r.out_s)) return 0;
  const range = ms(r.out_s) - ms(r.in_s);
  if (!(range > 0)) return 0;
  return FAST_SECONDS_PER_SOURCE_S * Math.max(0, range - mediaLength(r));
}

/** The fast-clip charge as the validators apply it (modules/timeline.py `fast_estimate`): nothing for a
 *  timeline longer than the export renders (EXPORT_MAX_S), which the export refuses anyway and whose
 *  allowance has stopped growing; charging there would refuse at save drafts that saved before. */
export function fastCharged(fastEst: number, lengthS: number): number {
  return lengthS > EXPORT_MAX_S + 1e-9 ? 0 : fastEst;
}

/** A speed curve that can be worked with (the validator has the strict rules). */
function usableCurve(v: unknown): SpeedPoint[] | null {
  if (!Array.isArray(v) || v.length < RAMP_MIN_POINTS) return null;
  return v.every(
    (p) => isObj(p) && isNum(p.at) && isNum(p.speed) && p.speed > 0,
  )
    ? (v as SpeedPoint[])
    : null;
}

/** How long a video clip lasts on the timeline. */
export function clipLength(c: VideoClip): number {
  return mediaLength(c as unknown as Record<string, unknown>);
}

/** The source time shown at timeline time `t` in clip `c` (a speed curve is
 *  inverted numerically). */
export function sourceTimeAt(c: VideoClip, t: number): number {
  // A frozen clip shows the frame at in_s throughout; a reversed one walks the
  // range from its end back to its start.
  if (c.freeze) return ms(c.in_s);
  const curve = usableCurve(c.speed_curve);
  if (!curve) {
    const run = clamp((t - c.start_s) * c.speed, 0, c.out_s - c.in_s);
    return ms(c.reverse ? c.out_s - run : c.in_s + run);
  }
  const range = ms(c.out_s) - ms(c.in_s);
  return ms(c.in_s + rampSourceAt(rampAbsolute(curve, range), t - c.start_s));
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

/** The render-time estimates, in seconds, of interpolated slow motion (and its 1080p-equivalent frames) and of
 *  stabilising, over the document's V tracks (modules/timeline.py `_interp_stab_estimates`). */
function interpStabEstimates(
  counted: readonly (Record<string, unknown> & { clips: unknown[] })[],
  fps: number,
  width: number,
  height: number,
): { interp: number; interpEst: number; stabEst: number; fastEst: number; lookEst: number } {
  let interp = 0;
  let stabEst = 0;
  let fastEst = 0;
  let lookEst = 0;
  for (const t of counted)
    if (t.kind === "V")
      for (const c of t.clips) {
        if (!isObj(c)) continue;
        if (c.interpolate === true && isNum(c.in_s) && isNum(c.out_s)) {
          const pts = usableCurve(c.speed_curve);
          const slowest = pts
            ? Math.min(...pts.map((p) => p.speed))
            : isNum(c.speed) && c.speed > 0
              ? c.speed
              : 1;
          interp += interpolatedFrames(c.in_s, c.out_s, slowest, fps, width, height);
        }
        if (c.stabilize === true) stabEst += stabilizeSeconds(c, fps, width, height);
        fastEst += fastSeconds(c);
        lookEst += lookSeconds(c, fps, width, height);
      }
  return {
    interp,
    interpEst: interp <= INTERP_MAX_FRAMES_DOC ? INTERP_SECONDS_PER_FRAME * interp : 0,
    stabEst,
    fastEst,
    lookEst,
  };
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
  let stabS = 0;
  for (const t of counted)
    if (t.kind === "V")
      for (const c of t.clips)
        if (isObj(c) && c.stabilize === true && isNum(c.in_s) && isNum(c.out_s))
          stabS += ms(c.out_s) - ms(c.in_s);
  if (stabS > STABILIZE_MAX_DOC_S + 1e-9)
    problems.push(
      `timeline: at most ${STABILIZE_MAX_DOC_S} s of video can be stabilised in all (got ${Math.round(stabS)} s)`,
    );
  if (!problems.length && isInt(doc.width) && isInt(doc.height) && fps) {
    const est = interpStabEstimates(counted, fps, doc.width, doc.height);
    const { interp, interpEst, stabEst } = est;
    const fastEst = fastCharged(est.fastEst, docDuration(doc as unknown as TimelineDoc));
    const lookEst = fastCharged(est.lookEst, docDuration(doc as unknown as TimelineDoc));
    if (interp > INTERP_MAX_FRAMES_DOC)
      problems.push(
        `timeline: interpolated slow motion would make about ${Math.round(interp)} frames (1080p equivalent) in all; at most ${INTERP_MAX_FRAMES_DOC} per timeline`,
      );
    if (interpEst + stabEst + fastEst + lookEst > 0) {
      const length = docDuration(doc as unknown as TimelineDoc);
      const work = RENDER_PLAIN_FACTOR * length + interpEst + stabEst + fastEst + lookEst;
      const allowed = renderTimeoutS(length);
      if (work > allowed + 1e-9) {
        const what = [
          interpEst > 0 ? "interpolated slow motion" : "",
          stabEst > 0 ? "stabilising" : "",
          fastEst > 0 ? "playing clips faster than 1x" : "",
          lookEst > 0 ? "colour, masks and effects" : "",
        ]
          .filter(Boolean)
          .join(" and ");
        const fix = [
          interpEst > 0 ? "slow less of it" : "",
          stabEst > 0 ? "stabilise less of it" : "",
          fastEst > 0 ? "speed them up less" : "",
          lookEst > 0 ? "use fewer colour changes, masks and effects" : "",
        ]
          .filter(Boolean)
          .join(" and ");
        problems.push(
          `timeline: ${what} would take about ${Math.round(work)} s to render, but a ${Math.round(length)} s timeline is allowed ${Math.round(allowed)} s — ${fix} or make the timeline longer`,
        );
      }
    }
  }

  if (doc.captions !== undefined && doc.captions !== null)
    validateCaptions(doc.captions, problems, claim);
  else if (doc.captions === null) problems.push("captions must be an object");
  if ("overlays" in doc) validateOverlays(doc.overlays, fps, problems, claim);
  if ("shapes" in doc) {
    const before = problems.length;
    validateShapes(doc.shapes, fps, problems, claim);
    if (
      problems.length === before &&
      Array.isArray(doc.shapes) &&
      doc.shapes.length > 0 &&
      isInt(doc.width) &&
      isInt(doc.height)
    ) {
      const pics = Array.isArray(doc.overlays) ? (doc.overlays as CostPicture[]) : [];
      const need = memoryEstimateBytes(doc.shapes as CostShape[], { width: doc.width, height: doc.height }, pics);
      const budget = memoryBudgetBytes();
      if (need > budget)
        problems.push(
          `shapes: drawing them in a ${doc.width}x${doc.height} frame would need about ${Math.round(need / 1048576)} MB to render${pics.length ? " with the picture overlays" : ""}, but ${Math.round(budget / 1048576)} MB is the most the export has — make the shapes${pics.length ? " or pictures" : ""} smaller or fewer, or the frame smaller (memory)`,
        );
      else if (fps && !problems.length) {
        const length = docDuration(doc as unknown as TimelineDoc);
        const shapeEst = shapeWorkSeconds(doc.shapes as WorkShape[], fps, { width: doc.width, height: doc.height }, length);
        const est = interpStabEstimates(counted, fps, doc.width, doc.height);
        const work =
          RENDER_PLAIN_FACTOR * length +
          est.interpEst +
          est.stabEst +
          fastCharged(est.fastEst, length) +
          fastCharged(est.lookEst, length) +
          shapeEst;
        const allowed = renderTimeoutS(length);
        if (shapeEst > 0 && work > allowed + 1e-9)
          problems.push(
            `timeline: the shapes would take about ${Math.round(shapeEst)} s to render (about ${Math.round(work)} s with everything else), but a ${Math.round(length)} s timeline is allowed ${Math.round(allowed)} s — use fewer or smaller shapes, or make the timeline longer (render time)`,
          );
      }
    }
    const layers =
      (Array.isArray(doc.overlays) ? doc.overlays.length : 0) +
      (Array.isArray(doc.shapes) ? doc.shapes.length : 0);
    if (layers > MAX_OVERLAYS)
      problems.push(`overlays and shapes together: at most ${MAX_OVERLAYS} (got ${layers})`);
  }

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
  if (kind === "V") numIn(clip, "gain_db", GAIN_DB_MIN, CLIP_GAIN_DB_MAX, where, problems);
  let curve: SpeedPoint[] | null = null;
  if (kind === "V" && "speed_curve" in clip)
    curve = validateSpeedCurve(clip, where, problems);
  if (kind === "V" && "interpolate" in clip && typeof clip.interpolate !== "boolean")
    problems.push(`${where}: interpolate must be true or false`);
  if (kind === "V" && "stabilize" in clip) {
    if (typeof clip.stabilize !== "boolean")
      problems.push(`${where}: stabilize must be true or false`);
    else if (clip.stabilize && clip.freeze === true)
      problems.push(`${where}: a frozen clip is one still frame — nothing to stabilise`);
    else if (
      clip.stabilize &&
      isNum(clip.in_s) &&
      isNum(clip.out_s) &&
      ms(clip.out_s) - ms(clip.in_s) > STABILIZE_MAX_S + 1e-9
    )
      problems.push(
        `${where}: stabilising a range of more than ${STABILIZE_MAX_S} s is not offered (it decodes the clip twice) — split it`,
      );
  }
  for (const k of ["denoise", "loudnorm"])
    if (k in clip && typeof clip[k] !== "boolean")
      problems.push(`${where}: ${k} must be true or false`);
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
  if (curve) speed = null; // the length comes from the curve below
  const ins = clip.in_s;
  const outs = clip.out_s;
  if (isNum(ins) && isNum(outs) && (speed || curve)) {
    const length = curve
      ? ms(rampOutLength(rampAbsolute(curve, ms(outs) - ms(ins))))
      : ms((ms(outs) - ms(ins)) / (speed as number));
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
      frame[0] > 0 &&
      frame[1] > 0 &&
      rangeFrames(ms(outs) - ms(ins), fps) > reverseMaxFrames(frame[0], frame[1])
    )
      problems.push(
        `${where}: reverse holds every frame of the range in memory — at most ${reverseMaxSeconds(frame[0], frame[1], fps)} s at this frame size`,
      );
    else if (isNum(fi) && isNum(fo) && fi + fo > length + 1e-9)
      problems.push(`${where}: fade_in_s + fade_out_s is longer than the clip`);
  }
  if (kind === "V" && clip.interpolate === true)
    validateInterpolate(clip, where, frame, fps, curve, problems);
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
    if ("color" in clip) validateColor(clip.color, where, problems);
    if ("mask" in clip) validateMask(clip.mask, where, problems);
    if ("fx" in clip) validateFx(clip.fx, where, problems);
    validateClipAnims(clip, where, problems);
    if ("move" in clip) validateClipMove(clip.move, where, problems);
    if ("crop" in clip) validateCrop(clip.crop, where, problems);
    numIn(clip, "angle", -ANGLE_MAX, ANGLE_MAX, where, problems);
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

/** The twin of modules/timeline.py `_validate_speed_curve`: the curve's points
 *  when it is well-formed, else null. */
function validateSpeedCurve(
  clip: Record<string, unknown>,
  where: string,
  problems: string[],
): SpeedPoint[] | null {
  const cw = `${where} speed_curve`;
  const curve = clip.speed_curve;
  if (
    !Array.isArray(curve) ||
    curve.length < RAMP_MIN_POINTS ||
    curve.length > RAMP_MAX_POINTS
  ) {
    problems.push(
      `${cw}: must be a list of ${RAMP_MIN_POINTS} to ${RAMP_MAX_POINTS} points`,
    );
    return null;
  }
  let ok = true;
  const pts: SpeedPoint[] = [];
  curve.forEach((p, i) => {
    const pw = `${cw} point ${i}`;
    if (!fields(p, ["at", "speed"], ["at", "speed"], pw, problems)) {
      ok = false;
      return;
    }
    numIn(p, "at", 0, 1, pw, problems);
    numIn(p, "speed", RAMP_SPEED_MIN, RAMP_SPEED_MAX, pw, problems);
    if (
      !(
        isNum(p.at) &&
        p.at >= 0 &&
        p.at <= 1 &&
        isNum(p.speed) &&
        p.speed >= RAMP_SPEED_MIN &&
        p.speed <= RAMP_SPEED_MAX
      )
    ) {
      ok = false;
      return;
    }
    pts.push({ at: p.at, speed: p.speed });
  });
  if (!ok) return null;
  if (pts[0].at !== 0 || pts[pts.length - 1].at !== 1) {
    problems.push(`${cw}: the first point must be at 0 and the last at 1`);
    return null;
  }
  if (pts.some((p, i) => i > 0 && p.at - pts[i - 1].at < RAMP_MIN_GAP - 1e-12)) {
    problems.push(`${cw}: points must be at least ${RAMP_MIN_GAP} apart, in order`);
    return null;
  }
  if (isNum(clip.speed ?? 1) && (clip.speed ?? 1) !== 1)
    problems.push(`${where}: a speed curve replaces speed (leave speed out or 1)`);
  for (const k of ["reverse", "freeze"])
    if (clip[k] === true)
      problems.push(`${where}: a speed curve cannot be combined with ${k}`);
  return pts;
}

/** The 1080p-equivalent frames `interpolate` has to make for a clip
 *  (modules/timeline.py `interpolated_frames`). */
export function interpolatedFrames(
  inS: number,
  outS: number,
  minSpeed: number,
  fps: number,
  width: number,
  height: number,
): number {
  const rate = Math.min(INTERP_MAX_FPS, Math.ceil(fps / minSpeed));
  const frames = Math.ceil((ms(outS) - ms(inS)) * rate);
  return (frames * width * height) / INTERP_REF_PIXELS;
}

function validateInterpolate(
  clip: Record<string, unknown>,
  where: string,
  frame: [unknown, unknown],
  fps: number | null,
  curve: SpeedPoint[] | null,
  problems: string[],
) {
  if (clip.reverse === true || clip.freeze === true) {
    problems.push(
      `${where}: interpolate is for forward slow motion (not with reverse or freeze)`,
    );
    return;
  }
  const speeds: unknown[] = curve ? curve.map((p) => p.speed) : [clip.speed ?? 1];
  if (!speeds.every(isNum) || Math.min(...(speeds as number[])) >= 1) {
    problems.push(
      `${where}: interpolate is for slow motion (some part must play below speed 1)`,
    );
    return;
  }
  if (
    !(isInt(frame[0]) && isInt(frame[1]) && fps && isNum(clip.in_s) && isNum(clip.out_s))
  )
    return;
  if (frame[0] * frame[1] > INTERP_MAX_PIXELS) {
    problems.push(
      `${where}: interpolate is not offered above 1440p (${frame[0]}x${frame[1]} is too big: the render would run out of memory) — lower the timeline's size or leave it out`,
    );
    return;
  }
  const cost = interpolatedFrames(
    clip.in_s,
    clip.out_s,
    Math.min(...(speeds as number[])),
    fps,
    frame[0],
    frame[1],
  );
  if (cost > INTERP_MAX_FRAMES)
    problems.push(
      `${where}: interpolating this range would make about ${Math.round(cost)} frames (1080p equivalent); at most ${INTERP_MAX_FRAMES} per clip — shorten the range`,
    );
}

/** The twin of modules/timeline.py `_validate_crop`. */
function validateCrop(crop: unknown, where: string, problems: string[]) {
  const cw = `${where} crop`;
  if (!fields(crop, ["x", "y", "w", "h"], [], cw, problems)) return;
  for (const k of ["x", "y"]) numIn(crop, k, 0, 1, cw, problems);
  for (const k of ["w", "h"]) numIn(crop, k, CROP_MIN, 1, cw, problems);
  for (const [pos, size] of [
    ["x", "w"],
    ["y", "h"],
  ] as const) {
    const a = crop[pos] ?? 0;
    const b = crop[size] ?? 1;
    if (isNum(a) && isNum(b) && a + b > 1 + 1e-9)
      problems.push(`${cw}: ${pos} + ${size} must not go past the picture`);
  }
}

/** The twin of modules/timeline.py `_validate_chroma`. */
function validateChroma(chroma: unknown, where: string, problems: string[]) {
  const cw = `${where} chroma`;
  if (!fields(chroma, ["color", "similarity", "blend"], ["color"], cw, problems))
    return;
  if (
    "color" in chroma &&
    !(typeof chroma.color === "string" && HEX_RE.test(chroma.color))
  )
    problems.push(`${cw}: color must be a #RRGGBB colour`);
  numIn(chroma, "similarity", CHROMA_SIMILARITY_MIN, CHROMA_SIMILARITY_MAX, cw, problems);
  numIn(chroma, "blend", 0, CHROMA_BLEND_MAX, cw, problems);
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

/** A V clip's `color` (modules/timeline.py _validate_color). */
function validateColor(color: unknown, where: string, problems: string[]) {
  const cw = `${where} color`;
  if (!fields(color, COLOR_KEYS, [], cw, problems)) return;
  if (!Object.keys(color).length) problems.push(`${cw}: give at least one of ${COLOR_KEYS.join(", ")}`);
  numIn(color, "temperature", -COLOR_TEMP_MAX, COLOR_TEMP_MAX, cw, problems);
  numIn(color, "tint", -COLOR_TINT_MAX, COLOR_TINT_MAX, cw, problems);
  numIn(color, "hue", -COLOR_HUE_MAX, COLOR_HUE_MAX, cw, problems);
  if (
    "curve" in color &&
    !(typeof color.curve === "string" && (COLOR_CURVES as readonly string[]).includes(color.curve))
  )
    problems.push(`${cw}: curve is not available`);
}

/** A V clip's `fx` (modules/timeline.py _validate_fx). */
function validateFx(fx: unknown, where: string, problems: string[]) {
  const fw = `${where} fx`;
  if (!fields(fx, [...FX_NAMES], [], fw, problems)) return;
  if (!Object.keys(fx).length) problems.push(`${fw}: give at least one of ${FX_NAMES.join(", ")}`);
  for (const k of FX_NAMES) numIn(fx, k, 0, FX_MAX, fw, problems);
}

/** A V clip's entrance and exit (modules/timeline.py _validate_clip_anims). */
function validateClipAnims(clip: Record<string, unknown>, where: string, problems: string[]) {
  for (const side of ["in", "out"] as const) {
    const name = `anim_${side}`;
    const dur = `anim_${side}_s`;
    if (name in clip && !(typeof clip[name] === "string" && (V_ANIMS as readonly string[]).includes(clip[name] as string)))
      problems.push(`${where}: ${name} is not available`);
    if (dur in clip) {
      numIn(clip, dur, ANIM_MIN_S, ANIM_MAX_S, where, problems);
      if (!(name in clip)) problems.push(`${where}: ${dur} needs ${name}`);
    }
    const fade = clip[`fade_${side}_s`];
    if (name in clip && isNum(fade) && fade > 0)
      problems.push(`${where}: ${name} and fade_${side}_s cannot both be set`);
    if (name in clip && isNum(clip.in_s) && isNum(clip.out_s)) {
      const d = dur in clip ? clip[dur] : ANIM_DEFAULT_S;
      const length = mediaLength(clip);
      if (Number.isFinite(length) && isNum(d) && d > length / 2 + 1e-9)
        problems.push(`${where}: ${name} lasts more than half the clip`);
    }
  }
}

/** A V clip's `mask` (modules/timeline.py _validate_mask). */
function validateMask(mask: unknown, where: string, problems: string[]) {
  const mw = `${where} mask`;
  if (!fields(mask, MASK_KEYS, ["shape"], mw, problems)) return;
  if (!(typeof mask.shape === "string" && (MASK_SHAPES as readonly string[]).includes(mask.shape)))
    problems.push(`${mw}: shape must be rect, ellipse or rounded`);
  for (const k of ["x", "y"]) numIn(mask, k, 0, 1, mw, problems);
  for (const k of ["w", "h"]) numIn(mask, k, MASK_MIN, 1, mw, problems);
  numIn(mask, "feather", 0, MASK_FEATHER_MAX, mw, problems);
  if ("radius" in mask) {
    numIn(mask, "radius", 0, MASK_RADIUS_MAX, mw, problems);
    if (mask.shape === "rect" || mask.shape === "ellipse")
      problems.push(`${mw}: radius is only for a rounded shape`);
  }
  if ("invert" in mask && typeof mask.invert !== "boolean")
    problems.push(`${mw}: invert must be true or false`);
}

/** The estimated render seconds a clip's colour and mask add (modules/timeline.py `look_seconds`). */
export function lookSeconds(
  c: Record<string, unknown> | VideoClip,
  fps: number,
  width: number,
  height: number,
): number {
  const r = c as Record<string, unknown>;
  const color = isObj(r.color) ? r.color : {};
  let per = 0;
  if (color.temperature || color.tint) per += COLOR_CHROMA_SECONDS_PER_S;
  if (color.hue) per += COLOR_HUE_SECONDS_PER_S;
  if (color.curve) per += COLOR_CURVE_SECONDS_PER_S;
  if (isObj(r.mask)) per += MASK_SECONDS_PER_S;
  const fx = isObj(r.fx) ? r.fx : {};
  for (const k of FX_NAMES) if (isNum(fx[k]) && fx[k] > 0) per += FX_SECONDS_PER_S[k];
  const moves = ["slide-up", "slide-down", "slide-left", "slide-right", "zoom"];
  if (moves.includes(r.anim_in as string) || moves.includes(r.anim_out as string)) per += ANIM_MOVE_SECONDS_PER_S;
  if (per <= 0 || !isNum(r.in_s) || !isNum(r.out_s)) return 0;
  const length = mediaLength(r);
  if (!Number.isFinite(length)) return 0;
  return (per * Math.max(0, length) * (width * height * fps)) / LOOK_REF_PIXEL_RATE;
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
  // An animation on one side and a plain fade on the other: the fade becomes
  // an animation too, so a long entrance would be cut short by the exit that
  // starts at end_s - fade_out_s (modules/timeline.py, same words).
  if (("anim_in" in clip) !== ("anim_out" in clip)) {
    const animKey = "anim_in" in clip ? "anim_in" : "anim_out";
    const side = "anim_in" in clip ? "fade_out_s" : "fade_in_s";
    const mixed = clip[`${animKey}_s`] ?? ANIM_DEFAULT_S;
    const other = clip[side] ?? 0;
    if (
      isNum(s) &&
      isNum(e) &&
      isNum(mixed) &&
      isNum(other) &&
      e > s &&
      other > 0 &&
      mixed + other > ms(e) - ms(s) + 1e-9
    )
      problems.push(
        `${where}: the animation (${mixed} s) and ${side} (${other} s) are longer than the text is shown`,
      );
  }
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
    if ("chroma" in ov) validateChroma(ov.chroma, where, problems);
  });
  const slow = overlays.filter(partialOpacityMove).length;
  if (slow > MAX_PARTIAL_OPACITY_MOVES)
    problems.push(
      `overlays: at most ${MAX_PARTIAL_OPACITY_MOVES} may change opacity between two visible values during a move (got ${slow}) — fade to or from 0, or keep the opacity`,
    );
}

/** The twin of modules/timeline.py `_validate_shapes`. */
function validateShapes(
  shapes: unknown,
  fps: number | null,
  problems: string[],
  claim: (i: unknown, w: string) => void,
) {
  if (!Array.isArray(shapes)) {
    problems.push("shapes must be a list");
    return;
  }
  if (shapes.length > MAX_SHAPES) {
    problems.push(`shapes: at most ${MAX_SHAPES}`);
    return;
  }
  const keys = [...new Set([...SHAPE_COMMON, ...Object.values(KIND_FIELDS).flat()])];
  shapes.forEach((sh, i) => {
    if (!fields(sh, keys, SHAPE_REQUIRED, `shapes[${i}]`, problems)) return;
    const where = `shape ${String(sh.id)}`;
    claim(sh.id, where);
    const kind = sh.kind;
    if (!isShapeKind(kind)) {
      problems.push(`${where}: kind must be one of ${JSON.stringify(SHAPE_KINDS)}`);
      return;
    }
    for (const k of Object.keys(sh))
      if (!SHAPE_COMMON.includes(k) && !KIND_FIELDS[kind].includes(k))
        problems.push(`${where}: ${k} does not apply to a ${kind}`);
    numIn(sh, "start_s", 0, MAX_DURATION_S, where, problems);
    numIn(sh, "end_s", 0, MAX_DURATION_S, where, problems);
    if (isNum(sh.start_s) && isNum(sh.end_s)) {
      if (ms(sh.end_s) <= ms(sh.start_s))
        problems.push(`${where}: end_s must be greater than start_s`);
      else if (fps && pyRound(ms(sh.end_s) * fps) - pyRound(ms(sh.start_s) * fps) < 1)
        problems.push(`${where}: shorter than one frame`);
    }
    if ("color" in sh && !(typeof sh.color === "string" && HEX_RE.test(sh.color)))
      problems.push(`${where}: color must be a #RRGGBB colour`);
    numIn(sh, "opacity", 0, 1, where, problems);
    for (const k of ["x", "y"]) numIn(sh, k, 0, 1, where, problems);
    numIn(sh, "w", SHAPE_W_MIN, SHAPE_W_MAX, where, problems);
    numIn(sh, "outline", 0, SHAPE_OUTLINE_MAX, where, problems);
    numIn(sh, "aspect", ASPECT_MIN, ASPECT_MAX, where, problems);
    numIn(sh, "thick", THICK_MIN, THICK_MAX, where, problems);
    if ("dir" in sh && !(ARROW_DIRS as readonly unknown[]).includes(sh.dir))
      problems.push(`${where}: dir must be one of ${JSON.stringify(ARROW_DIRS)}`);
    if ("edge" in sh && !(PROGRESS_EDGES as readonly unknown[]).includes(sh.edge))
      problems.push(`${where}: edge must be one of ${JSON.stringify(PROGRESS_EDGES)}`);
    if (kind === "pill") {
      if (!("text" in sh)) problems.push(`${where}: text is missing`);
      else {
        const p = shapeTextProblem(sh.text);
        if (p) problems.push(`${where}: ${p}`);
      }
    }
    validateAnims(sh, where, problems, false);
    if (kind === "progress")
      for (const key of ["anim_in", "anim_out"])
        if (key in sh && !(PROGRESS_ANIMS as readonly unknown[]).includes(sh[key]))
          problems.push(
            `${where}: a progress bar takes only ${JSON.stringify(PROGRESS_ANIMS)} as ${key}`,
          );
    if ("move" in sh) validateShapeMove(sh.move, where, problems);
  });
}

function validateShapeMove(move: unknown, where: string, problems: string[]) {
  if (!fields(move, ["to"], ["to"], `${where} move`, problems) || !("to" in move))
    return;
  const to = move.to;
  const tw = `${where} move to`;
  if (!fields(to, [...SHAPE_MOVE_KEYS], [], tw, problems)) return;
  if (Object.keys(to).length === 0)
    problems.push(`${tw}: give at least one of x, y, w`);
  for (const k of ["x", "y"]) numIn(to, k, 0, 1, tw, problems);
  numIn(to, "w", SHAPE_W_MIN, SHAPE_W_MAX, tw, problems);
}

/** An overlay whose `move.to.opacity` is another visible value than its `opacity`
 *  (modules/timeline.py `_partial_opacity_move`). */
export function partialOpacityMove(ov: unknown): boolean {
  if (!isObj(ov) || !isObj(ov.move)) return false;
  const to = ov.move.to;
  const start = ov.opacity ?? 1;
  const end = isObj(to) ? to.opacity : undefined;
  return isNum(start) && isNum(end) && start > 0 && end > 0 && start !== end;
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

/** Effects a cross-fade on a frame above 1440p cannot afford
 *  (modules/timeline.py `_large_frame_crossfade_problems`). */
function largeFrameCrossfadeProblems(doc: TimelineDoc, track: TimelineTrack): string[] {
  const w = doc.width;
  const h = doc.height;
  if (!(isInt(w) && isInt(h) && w * h > LARGE_FRAME_PX)) return [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [prev, clip] of crossfades(track))
    for (const c of [prev, clip]) {
      const id = String(c.id);
      if (!seen.has(id) && isNum(c.blur) && c.blur > XFADE_LARGE_BLUR_MAX) {
        seen.add(id);
        problems.push(
          `track ${track.id} clip ${id}: blur is not offered on a cross-faded clip in a frame above 1440p (${w}x${h}) — the render would run out of memory; remove the blur, the cross-fade or lower the frame size`,
        );
      }
      const mv = c.move;
      const zooms = isObj(mv)
        ? [mv.from, mv.to].filter(isObj).map((p) => (p as Record<string, unknown>).zoom ?? 1)
        : [];
      if (!seen.has(`${id}:zoom`) && zooms.some((z) => isNum(z) && z > XFADE_LARGE_ZOOM_MAX)) {
        seen.add(`${id}:zoom`);
        problems.push(
          `track ${track.id} clip ${id}: a zoom above ${XFADE_LARGE_ZOOM_MAX} is not offered on a cross-faded clip in a frame above 1440p (${w}x${h}) — the render would run out of memory; lower the zoom, remove the cross-fade or lower the frame size`,
        );
      }
    }
  return problems;
}

/** What a mask cannot afford in a frame above 1440p (modules/timeline.py `_large_frame_mask_problems`):
 *  a cross-faded clip, or a move zooming past XFADE_LARGE_ZOOM_MAX (measured: out of memory). */
function largeFrameMaskProblems(doc: TimelineDoc, track: TimelineTrack): string[] {
  const w = doc.width;
  const h = doc.height;
  if (!(isInt(w) && isInt(h) && w * h > LARGE_FRAME_PX)) return [];
  const faded = new Set<string>();
  for (const [prev, clip] of crossfades(track)) {
    faded.add(String(prev.id));
    faded.add(String(clip.id));
  }
  const problems: string[] = [];
  for (const c of sortedClips(track)) {
    if (!isObj(c.mask)) continue;
    const id = String(c.id);
    if (faded.has(id)) {
      problems.push(
        `track ${track.id} clip ${id}: a mask is not offered on a cross-faded clip in a frame above 1440p (${w}x${h}) — the render would run out of memory`,
      );
      continue;
    }
    const mv = c.move;
    const zooms = isObj(mv)
      ? [mv.from, mv.to].filter(isObj).map((p) => (p as Record<string, unknown>).zoom ?? 1)
      : [];
    if (zooms.some((z) => isNum(z) && z > XFADE_LARGE_ZOOM_MAX))
      problems.push(
        `track ${track.id} clip ${id}: a masked clip zooms at most ${XFADE_LARGE_ZOOM_MAX} in a frame above 1440p (${w}x${h})`,
      );
  }
  return problems;
}

/** At most FX_LARGE_XFADE_MAX effects of the pack on a cross-faded clip above 1440p
 *  (modules/timeline.py `_large_frame_fx_problems`). */
function largeFrameFxProblems(doc: TimelineDoc, track: TimelineTrack): string[] {
  const w = doc.width;
  const h = doc.height;
  if (!(isInt(w) && isInt(h) && w * h > LARGE_FRAME_PX)) return [];
  const faded = new Map<string, Record<string, unknown>>();
  for (const [prev, clip] of crossfades(track)) {
    faded.set(String(prev.id), prev);
    faded.set(String(clip.id), clip);
  }
  const problems: string[] = [];
  for (const [id, c] of faded) {
    const fx = isObj(c.fx) ? c.fx : {};
    if (FX_NAMES.filter((k) => isNum(fx[k]) && fx[k] > 0).length > FX_LARGE_XFADE_MAX)
      problems.push(
        `track ${track.id} clip ${id}: a cross-faded clip takes at most ${FX_LARGE_XFADE_MAX} effect in a frame above 1440p (${w}x${h})`,
      );
  }
  return problems;
}

function transitionProblems(doc: TimelineDoc): string[] {
  const problems: string[] = [];
  for (const track of doc.tracks) {
    if (track.kind !== "V") continue;
    problems.push(...crossfadeProblems(track));
    problems.push(...largeFrameCrossfadeProblems(doc, track));
    problems.push(...largeFrameMaskProblems(doc, track));
    problems.push(...largeFrameFxProblems(doc, track));
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

/** A document clip's colour and mask as the model holds them (a colour of only zeros is none). */
function lookOf(c: Record<string, unknown>): Partial<VideoClip> {
  const out: Partial<VideoClip> = {};
  if (isObj(c.color)) {
    const col: Record<string, unknown> = {};
    for (const k of ["temperature", "tint", "hue"]) if (isNum(c.color[k]) && c.color[k] !== 0) col[k] = c.color[k];
    if (typeof c.color.curve === "string" && (COLOR_CURVES as readonly string[]).includes(c.color.curve))
      col.curve = c.color.curve;
    if (Object.keys(col).length) out.color = col as ClipColor;
  }
  if (isObj(c.mask) && typeof c.mask.shape === "string") out.mask = { ...(c.mask as unknown as ClipMask) };
  if (isObj(c.fx)) {
    const fx: Partial<Record<FxName, number>> = {};
    for (const k of FX_NAMES) if (isNum(c.fx[k]) && c.fx[k] !== 0) fx[k] = c.fx[k];
    if (Object.keys(fx).length) out.fx = fx;
  }
  for (const side of ["in", "out"] as const) {
    const a = c[`anim_${side}`];
    if (typeof a === "string" && (V_ANIMS as readonly string[]).includes(a)) {
      out[`anim_${side}`] = a as VideoAnim;
      const d = c[`anim_${side}_s`];
      out[`anim_${side}_s`] = isNum(d) ? d : ANIM_DEFAULT_S;
    }
  }
  return out;
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
      ...(isObj(o.chroma) ? { chroma: o.chroma as unknown as ChromaKey } : {}),
    });
  }
  return out;
}

/** A document's shapes as the model holds them (the defaults of the kind filled in); an
 *  entry that is not an object with a usable id, kind and span is left out. */
function shapesOf(v: unknown): ShapeLayer[] {
  if (!Array.isArray(v)) return [];
  const out: ShapeLayer[] = [];
  for (const o of v) {
    if (
      !isObj(o) ||
      typeof o.id !== "string" ||
      !isShapeKind(o.kind) ||
      !isNum(o.start_s) ||
      !isNum(o.end_s)
    )
      continue;
    const kind = o.kind;
    const num = (x: unknown, d: number) => (isNum(x) ? x : d);
    const takes = (f: string) => KIND_FIELDS[kind].includes(f);
    const anim = (key: "anim_in" | "anim_out") =>
      typeof o[key] === "string" && (ANIM_OUT as readonly string[]).includes(o[key] as string)
        ? { [key]: o[key] as AnimOut, [`${key}_s`]: num(o[`${key}_s`], ANIM_DEFAULT_S) }
        : {};
    out.push({
      id: o.id,
      kind,
      start_s: o.start_s,
      end_s: o.end_s,
      color: typeof o.color === "string" && HEX_RE.test(o.color) ? o.color.toUpperCase() : SHAPE_COLOR_DEFAULT,
      opacity: num(o.opacity, SHAPE_DEFAULTS.opacity),
      ...(takes("x") ? { x: num(o.x, SHAPE_DEFAULTS.x), y: num(o.y, SHAPE_DEFAULTS.y), w: num(o.w, SHAPE_DEFAULTS.w) } : {}),
      ...(takes("outline") && isNum(o.outline) && o.outline > 0 ? { outline: o.outline } : {}),
      ...(kind === "rect" ? { aspect: num(o.aspect, ASPECT_DEFAULT) } : {}),
      ...(kind === "arrow" ? { dir: (ARROW_DIRS as readonly unknown[]).includes(o.dir) ? (o.dir as ArrowDir) : DIR_DEFAULT } : {}),
      ...(kind === "line" || kind === "progress" ? { thick: num(o.thick, THICK_DEFAULTS[kind]) } : {}),
      ...(kind === "pill" ? { text: typeof o.text === "string" ? o.text : "" } : {}),
      ...(kind === "progress"
        ? { edge: (PROGRESS_EDGES as readonly unknown[]).includes(o.edge) ? (o.edge as ProgressEdge) : EDGE_DEFAULT }
        : {}),
      ...anim("anim_in"),
      ...anim("anim_out"),
      ...(takes("move") && isObj(o.move) && isObj(o.move.to) ? { move: o.move as unknown as { to: ShapeMoveTo } } : {}),
    });
  }
  return out;
}

/** A shape as the document writes it: only the fields its kind takes, rounded as the worker keeps them. */
function shapeToDoc(s: ShapeLayer): Record<string, unknown> {
  const takes = (f: string) => KIND_FIELDS[s.kind].includes(f);
  return {
    id: s.id,
    kind: s.kind,
    start_s: ms(s.start_s),
    end_s: ms(s.end_s),
    color: s.color,
    opacity: ms(s.opacity),
    ...(takes("x") ? { x: ms(s.x ?? SHAPE_DEFAULTS.x), y: ms(s.y ?? SHAPE_DEFAULTS.y), w: ms(s.w ?? SHAPE_DEFAULTS.w) } : {}),
    ...(takes("outline") && s.outline ? { outline: ms(s.outline) } : {}),
    ...(s.kind === "rect" ? { aspect: ms(s.aspect ?? ASPECT_DEFAULT) } : {}),
    ...(s.kind === "arrow" ? { dir: s.dir ?? DIR_DEFAULT } : {}),
    ...(s.kind === "line" || s.kind === "progress"
      ? { thick: Math.round((s.thick ?? THICK_DEFAULTS[s.kind]) * 10000) / 10000 }
      : {}),
    ...(s.kind === "pill" ? { text: s.text ?? "" } : {}),
    ...(s.kind === "progress" ? { edge: s.edge ?? EDGE_DEFAULT } : {}),
    ...(s.anim_in ? { anim_in: s.anim_in, anim_in_s: ms(s.anim_in_s ?? ANIM_DEFAULT_S) } : {}),
    ...(s.anim_out ? { anim_out: s.anim_out, anim_out_s: ms(s.anim_out_s ?? ANIM_DEFAULT_S) } : {}),
    ...(takes("move") && s.move
      ? { move: { to: Object.fromEntries(Object.entries(s.move.to).map(([k, v]) => [k, ms(v as number)])) } }
      : {}),
  };
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
      ...(isNum(c.gain_db) && c.gain_db !== 0 ? { gain_db: c.gain_db } : {}),
      ...(c.fit === "cover" || c.fit === "contain" || c.fit === "blur"
        ? { fit: c.fit as "cover" | "contain" | "blur" }
        : {}),
      ...gradeFieldOf(c.grade),
      ...effectsOf(c),
      ...lookOf(c),
      ...(c.reverse === true ? { reverse: true } : {}),
      ...(c.freeze === true ? { freeze: true } : {}),
      ...(c.denoise === true ? { denoise: true } : {}),
      ...(c.loudnorm === true ? { loudnorm: true } : {}),
      ...(isObj(c.crop) ? { crop: c.crop as ClipCrop } : {}),
      ...(isNum(c.angle) && c.angle !== 0 ? { angle: c.angle } : {}),
      ...(usableCurve(c.speed_curve) ? { speed_curve: c.speed_curve as SpeedPoint[] } : {}),
      ...(c.interpolate === true ? { interpolate: true } : {}),
      ...(c.stabilize === true ? { stabilize: true } : {}),
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
        ...(c.denoise === true ? { denoise: true } : {}),
        ...(c.loudnorm === true ? { loudnorm: true } : {}),
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
  const shapes = shapesOf(doc.shapes);
  return {
    width: doc.width,
    height: doc.height,
    fps: doc.fps,
    clips,
    texts,
    sounds,
    ...(overlays.length ? { overlays } : {}),
    ...(shapes.length ? { shapes } : {}),
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
        ...(c.gain_db !== undefined ? { gain_db: ms(c.gain_db) } : {}),
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
    ...(model.shapes ?? []).map((o) => o.id),
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
          ...(x.denoise ? { denoise: true } : {}),
          ...(x.loudnorm ? { loudnorm: true } : {}),
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
            ...(o.chroma ? { chroma: o.chroma } : {}),
          })),
        }
      : {}),
    ...(model.shapes?.length ? { shapes: model.shapes.map(shapeToDoc) } : {}),
  };
}

/** The model's length in seconds (picture and text; overlays never lengthen it). */
export function modelDuration(model: EditorModel): number {
  return docDuration(toDoc(model));
}

/**
 * Keep an item's entrance and exit inside the time it is shown (the validator
 * refuses otherwise): when a text or an overlay is shortened, the two lengths
 * shrink in proportion (never under ANIM_MIN_S); when both cannot fit, the exit
 * goes and the entrance is kept. The same item back when it already fits.
 */
export function fitAnims<
  T extends {
    start_s: number;
    end_s: number;
    anim_in?: string;
    anim_out?: string;
    anim_in_s?: number;
    anim_out_s?: number;
    fade_in_s?: number;
    fade_out_s?: number;
  },
>(item: T): T {
  const shown = ms(item.end_s - item.start_s);
  const floor3 = (v: number) => Math.floor(v * 1000 + 1e-6) / 1000;
  const a = item.anim_in ? (item.anim_in_s ?? ANIM_DEFAULT_S) : 0;
  const b = item.anim_out ? (item.anim_out_s ?? ANIM_DEFAULT_S) : 0;
  // A plain fade on the side with no animation is an animation too (the
  // document counts it): it takes its time out of what the animations may use.
  const fade =
    (item.anim_in ? 0 : (item.fade_in_s ?? 0)) + (item.anim_out ? 0 : (item.fade_out_s ?? 0));
  const room = shown - fade;
  if (a + b <= room + 1e-9) return item;
  const next: T = { ...item };
  const dropIn = () => {
    delete next.anim_in;
    delete next.anim_in_s;
  };
  const dropOut = () => {
    delete next.anim_out;
    delete next.anim_out_s;
  };
  if (a > 0 && b > 0) {
    const k = room / (a + b);
    const na = Math.max(ANIM_MIN_S, floor3(a * k));
    const nb = Math.max(ANIM_MIN_S, floor3(b * k));
    if (na + nb <= room + 1e-9) {
      next.anim_in_s = na;
      next.anim_out_s = nb;
      return next;
    }
    dropOut();
    if (a > room) {
      if (room < ANIM_MIN_S) dropIn();
      else next.anim_in_s = Math.max(ANIM_MIN_S, Math.min(a, floor3(room)));
    }
    return next;
  }
  const own = a > 0 ? a : b;
  if (room < ANIM_MIN_S - 1e-9) {
    if (a > 0) dropIn();
    else dropOut();
    return next;
  }
  const cut = Math.max(ANIM_MIN_S, Math.min(own, floor3(room)));
  if (a > 0) next.anim_in_s = cut;
  else next.anim_out_s = cut;
  return next;
}

/** A new id for a clip or a text: letters and digits, never one the model uses. */
export function freshId(
  model: EditorModel,
  prefix: "c" | "x" | "m" | "o" | "h",
): string {
  // Track ids share the namespace too (v1, a1, t1, t2… are tracks).
  const used = new Set([
    "v1",
    ...model.clips.map((c) => c.id),
    ...model.texts.map((t) => t.id),
    ...model.sounds.map((x) => x.id),
    ...(model.overlays ?? []).map((o) => o.id),
    ...(model.shapes ?? []).map((o) => o.id),
    ...model.keep.flatMap((t) => [t.id, ...t.clips.map((c) => String(c.id))]),
  ]);
  for (
    let n =
      model.clips.length +
      model.texts.length +
      model.sounds.length +
      (model.overlays?.length ?? 0) +
      (model.shapes?.length ?? 0) +
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

// ── rolling, slip, slide and ripple-trim-to-playhead (no new field) ─────────
//
// Each is a change of `in_s` / `out_s` only, laid out by `layout` like a trim, so a document they make is one
// both validators already judge. Times given to them are TIMELINE seconds unless named otherwise; what they
// may do is worked out first as a range and the request is held to it, so a drag past a limit stops at the
// limit instead of leaving a clip under a frame, past its file, or too short for a cross-fade it has.

/** Where a clip's file ends (null: not known, or a still, which has no end). */
export type SourceLength = (assetId: string) => number | null;

/** A side of a clip on the timeline: `head` is where it starts, `tail` where it ends. */
type Side = "head" | "tail";

/** Which source edge a timeline side moves: a reversed clip plays its range from the end. */
function sourceEdge(c: VideoClip, side: Side): "in" | "out" {
  if (c.freeze) return "out";
  return (side === "head") !== Boolean(c.reverse) ? "in" : "out";
}

/** How much a cross-fade needs a clip to keep (layout drops one that no longer fits, which would change the
 *  timeline's length): its own cross-fade in, the next clip's in, and the millisecond layout keeps between them. */
function crossfadeNeed(clips: VideoClip[], i: number): number {
  const into = i > 0 ? crossfadeOf(clips[i]) : 0;
  const out = i + 1 < clips.length ? crossfadeOf(clips[i + 1]) : 0;
  return into + out > 0 ? into + out + 0.002 : 0;
}

/**
 * The timeline seconds side `side` of clip `c` may grow (positive) or shrink (negative) by: [lo, hi]. Kept inside
 * its file (`max`, unbounded when not known) and at least {@link minPieceS} of source long. A frozen clip holds
 * the frame at `in_s`, so either side only changes its hold (`out_s`); its length is not capped by the file.
 */
function sideRoom(c: VideoClip, side: Side, max: number, fps: number): [number, number] {
  const min = minPieceS(c, fps);
  if (c.freeze) return [c.in_s + min - c.out_s, Number.POSITIVE_INFINITY];
  const s = c.speed > 0 ? c.speed : 1;
  return sourceEdge(c, side) === "out"
    ? [(c.in_s + min - c.out_s) / s, (max - c.out_s) / s]
    : [(c.in_s - (c.out_s - min)) / s, c.in_s / s];
}

/** Clip `c` grown on side `side` by `d` timeline seconds (negative shrinks it); its fades and entrance / exit
 *  are held to the new length as a split piece's are. */
function growSide(c: VideoClip, side: Side, d: number): VideoClip {
  const s = c.freeze ? 1 : c.speed > 0 ? c.speed : 1;
  const out: VideoClip =
    sourceEdge(c, side) === "out"
      ? { ...c, out_s: ms(c.out_s + d * s) }
      : { ...c, in_s: ms(c.in_s - d * s) };
  fitPieceFades(out);
  fitPieceAnims(out);
  return out;
}

/** `d` held to [lo, hi], each bound rounded inwards to the millisecond: 0 when the range is empty or the step is
 *  under half a millisecond, and never a step the other way than asked (a range that does not hold 0 must not turn
 *  "left" into "right"). The step itself is not rounded: the edges it moves are, so a run of one-frame steps
 *  (1/30 s) lands on the frames instead of drifting a millisecond per step. */
function holdDelta(d: number, lo: number, hi: number): number {
  const l = Math.ceil(lo * 1000 - 1e-6) / 1000;
  const h = Math.floor(hi * 1000 + 1e-6) / 1000;
  if (!(l <= h) || !Number.isFinite(d)) return 0;
  const v = clamp(d, l, h);
  return Math.abs(v) >= 0.0005 && Math.sign(v) === Math.sign(d) ? v : 0;
}

const srcMax = (c: VideoClip, sourceOf: SourceLength) => {
  const v = sourceOf(c.asset_id);
  return v && v > 0 ? ms(v) : Number.POSITIVE_INFINITY;
};

/** How far the cut into clip `id` can roll: [earliest, latest] in timeline seconds from where it is (null when
 *  there is no cut there: the first clip, a missing id, or a speed curve on either side). */
export function rollRange(model: EditorModel, id: string, sourceOf: SourceLength): [number, number] | null {
  const clips = layout(model.clips);
  const i = clips.findIndex((c) => c.id === id);
  if (i <= 0) return null;
  const a = clips[i - 1];
  const b = clips[i];
  if (a.speed_curve || b.speed_curve) return null;
  const [aLo, aHi] = sideRoom(a, "tail", srcMax(a, sourceOf), model.fps);
  const [bLo, bHi] = sideRoom(b, "head", srcMax(b, sourceOf), model.fps);
  return [
    Math.max(aLo, -bHi, crossfadeNeed(clips, i - 1) - clipLength(a)),
    Math.min(aHi, -bLo, clipLength(b) - crossfadeNeed(clips, i)),
  ];
}

/**
 * Rolling edit: the cut between clip `id` and the clip before it moves `d` timeline seconds (later when
 * positive). The clip before ends `d` later and clip `id` starts `d` later in the same place, so nothing else
 * moves and the timeline keeps its length. Held to {@link rollRange}; the same model back when it cannot move.
 */
export function rollEdit(model: EditorModel, id: string, d: number, sourceOf: SourceLength): EditorModel {
  const r = rollRange(model, id, sourceOf);
  if (!r) return model;
  const step = holdDelta(d, r[0], r[1]);
  if (step === 0) return model;
  const clips = layout(model.clips);
  const i = clips.findIndex((c) => c.id === id);
  const next = clips.map((c, k) =>
    k === i - 1 ? growSide(c, "tail", step) : k === i ? growSide(c, "head", -step) : c,
  );
  return { ...model, clips: layout(next) };
}

/** How far clip `id` can slip: [lo, hi] SOURCE seconds from where its range is (null without a known file
 *  length: a still, or a file whose length was never read, is never guessed). */
export function slipRange(model: EditorModel, id: string, sourceOf: SourceLength): [number, number] | null {
  const c = model.clips.find((x) => x.id === id);
  if (!c) return null;
  const max = srcMax(c, sourceOf);
  if (!Number.isFinite(max)) return null;
  // A frozen clip only needs its frame inside the file (its hold is not the file's).
  if (c.freeze) return [-c.in_s, max - minPieceS(c, model.fps) - c.in_s];
  return [-c.in_s, max - c.out_s];
}

/**
 * Slip edit: clip `id` shows `ds` SOURCE seconds later (earlier when negative) of its file, with the same length
 * in the same place. Nothing else moves. A speed curve slips too (its points are fractions of the range).
 */
export function slipClip(model: EditorModel, id: string, ds: number, sourceOf: SourceLength): EditorModel {
  const r = slipRange(model, id, sourceOf);
  if (!r) return model;
  const step = holdDelta(ds, r[0], r[1]);
  if (step === 0) return model;
  return {
    ...model,
    clips: layout(
      model.clips.map((c) => (c.id === id ? { ...c, in_s: ms(c.in_s + step), out_s: ms(c.out_s + step) } : c)),
    ),
  };
}

/** How far clip `id` can slide: [lo, hi] timeline seconds (null for the first or last clip, which have no
 *  neighbour on one side, and when a neighbour has a speed curve). */
export function slideRange(model: EditorModel, id: string, sourceOf: SourceLength): [number, number] | null {
  const clips = layout(model.clips);
  const i = clips.findIndex((c) => c.id === id);
  if (i <= 0 || i >= clips.length - 1) return null;
  const a = clips[i - 1];
  const c = clips[i + 1];
  if (a.speed_curve || c.speed_curve) return null;
  const [aLo, aHi] = sideRoom(a, "tail", srcMax(a, sourceOf), model.fps);
  const [cLo, cHi] = sideRoom(c, "head", srcMax(c, sourceOf), model.fps);
  return [
    Math.max(aLo, -cHi, crossfadeNeed(clips, i - 1) - clipLength(a)),
    Math.min(aHi, -cLo, clipLength(c) - crossfadeNeed(clips, i + 1)),
  ];
}

/**
 * Slide edit: clip `id` moves `d` timeline seconds (later when positive) with the same content; the clip before
 * it ends `d` later and the clip after it starts `d` later, so the timeline keeps its length. Held to
 * {@link slideRange}; the same model back when it cannot move.
 */
export function slideClip(model: EditorModel, id: string, d: number, sourceOf: SourceLength): EditorModel {
  const r = slideRange(model, id, sourceOf);
  if (!r) return model;
  const step = holdDelta(d, r[0], r[1]);
  if (step === 0) return model;
  const clips = layout(model.clips);
  const i = clips.findIndex((c) => c.id === id);
  const next = clips.map((c, k) =>
    k === i - 1 ? growSide(c, "tail", step) : k === i + 1 ? growSide(c, "head", -step) : c,
  );
  return { ...model, clips: layout(next) };
}

/**
 * Ripple trim to the playhead: the clip under timeline time `t` loses what plays before `t` (`head`) or from `t`
 * on (`tail`), and the clips after it close up. `playhead` is where the edit now is (the clip's start after a
 * head trim). Null when there is nothing to trim (no clip, `t` on its first frame), when a piece under a frame
 * would be left, or on a speed curve (its points would need moving, as for a split).
 */
export function rippleTrimTo(
  model: EditorModel,
  t: number,
  side: Side,
): { model: EditorModel; playhead: number } | null {
  const hit = clipAt(model, t);
  if (!hit || hit.clip.speed_curve) return null;
  const c = hit.clip;
  const end = clipEnd(c);
  const cut = ms(side === "head" ? t - c.start_s : end - t);
  if (cut < 0.5 / model.fps) return null;
  const [lo] = sideRoom(c, side, Number.POSITIVE_INFINITY, model.fps);
  if (-cut < lo - 1e-9) return null;
  const next = growSide(c, side, -cut);
  if (c.move) {
    // The window goes on from where the whole move had reached at the playhead, as a split's halves do.
    const f = clamp((ms(t) - c.start_s) / clipLength(c), 0, 1);
    const at = (k: keyof typeof MOVE_POINT_DEFAULTS) => {
      const a = c.move!.from[k] ?? MOVE_POINT_DEFAULTS[k];
      const b = c.move!.to[k] ?? MOVE_POINT_DEFAULTS[k];
      return ms(a + (b - a) * f);
    };
    const mid = { zoom: at("zoom"), x: at("x"), y: at("y") };
    next.move = side === "head" ? { from: mid, to: c.move.to } : { from: c.move.from, to: mid };
  }
  const out = { ...model, clips: layout(model.clips.map((x) => (x.id === c.id ? next : x))) };
  return { model: out, playhead: side === "head" ? c.start_s : ms(t) };
}

/** Every place a cut is on the picture lane (each clip's start and end), in order, without repeats. */
export function editPoints(model: EditorModel): number[] {
  const out = new Set<number>();
  for (const c of layout(model.clips)) {
    out.add(ms(c.start_s));
    out.add(clipEnd(c));
  }
  return [...out].sort((a, b) => a - b);
}

/** The next (dir 1) or previous (dir -1) cut from timeline time `t`, or null when there is none that way. */
export function nextEditPoint(model: EditorModel, t: number, dir: 1 | -1): number | null {
  const pts = editPoints(model);
  // Half a millisecond: the playhead parked on a cut is AT it, so the key goes on to the next one.
  if (dir > 0) return pts.find((p) => p > t + 0.0005) ?? null;
  for (let i = pts.length - 1; i >= 0; i -= 1) if (pts[i] < t - 0.0005) return pts[i];
  return null;
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
        sourceS: sourceTimeAt(c, t),
      };
  }
  return null;
}

/** The source second a split at timeline time `t` cuts at (modules/timeline.py
 *  split_clip): a reversed clip plays its range from the end. */
function cutPoint(c: VideoClip, t: number): number {
  return ms(c.reverse ? c.out_s - (t - c.start_s) * c.speed : c.in_s + (t - c.start_s) * c.speed);
}

/** The shortest piece of SOURCE a split may leave of a clip: MIN_CLIP_S, or one frame of the timeline at the
 *  clip's speed when that is longer (at 10x a frame at 30 fps is 0.333 s of source; a shorter piece would be
 *  under one frame, which the validators refuse). */
export function minPieceS(c: Pick<VideoClip, "speed">, fps: number): number {
  const speed = c.speed > 0 ? c.speed : 1;
  return Math.max(MIN_CLIP_S, fps > 0 ? speed / fps : 0);
}

/** Can clip `id` be split at timeline time `t` (both halves at least `minPieceS` of source)? */
export function canSplit(model: EditorModel, id: string, t: number): boolean {
  if (model.clips.length >= MAX_EDITOR_CLIPS) return false;
  const c = layout(model.clips).find((x) => x.id === id);
  if (!c) return false;
  // A clip with a speed curve is not split (the part left of the cut would
  // need its own curve): remove the curve first, as the backend asks.
  if (c.speed_curve) return false;
  const cut = cutPoint(c, t);
  const min = minPieceS(c, model.fps);
  return (
    t > c.start_s &&
    t < clipEnd(c) &&
    cut - c.in_s >= min - 1e-9 &&
    c.out_s - cut >= min - 1e-9
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
  const c = layout(model.clips).find((x) => x.id === id)!;
  return splitAt(model, id, t, cutPoint(c, ms(t)));
}

/**
 * Split a forward clip at SOURCE time `cut` (the silence cuts are source times: converting them to a timeline
 * time rounded to the millisecond and back drifts by up to speed x 0.5 ms, which put a piece of exactly
 * `minPieceS` just under it at 6x). The same pieces and the same rules as {@link splitClip}.
 */
export function splitClipAtSource(
  model: EditorModel,
  id: string,
  cut: number,
): { model: EditorModel; newId: string } | null {
  if (model.clips.length >= MAX_EDITOR_CLIPS) return null;
  const c = layout(model.clips).find((x) => x.id === id);
  if (!c || c.speed_curve || c.reverse || c.freeze) return null;
  const at = ms(cut);
  const min = minPieceS(c, model.fps);
  if (!(at - c.in_s >= min - 1e-9 && c.out_s - at >= min - 1e-9)) return null;
  return splitAt(model, id, c.start_s + (at - c.in_s) / c.speed, at);
}

function splitAt(
  model: EditorModel,
  id: string,
  t: number,
  cut: number,
): { model: EditorModel; newId: string } {
  const clips = layout(model.clips);
  const i = clips.findIndex((x) => x.id === id);
  const c = clips[i];
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
  // A piece keeps its side's fade only as long as the piece is (the validator's rule: fade in + fade out
  // within the clip's length; modules/timeline.py split_clip does the same). The way in stays with the first
  // half and the way out with the second, each held to half its piece.
  delete first.anim_out;
  delete first.anim_out_s;
  delete second.anim_in;
  delete second.anim_in_s;
  fitPieceFades(first);
  fitPieceFades(second);
  fitPieceAnims(first);
  fitPieceAnims(second);
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

/** Hold a split piece's animation to half the piece; under ANIM_MIN_S it goes (modules/timeline.py
 *  `_fit_piece_anims`). */
/** A clip with its animations held to half its length (dropped under ANIM_MIN_S): the same clip when they fit.
 *  For the editor's settle step after a trim or a speed change (lib/editorSettle.ts). */
export function fitClipAnims(c: VideoClip): VideoClip {
  if (!c.anim_in && !c.anim_out) return c;
  const out = { ...c };
  fitPieceAnims(out);
  return out.anim_in === c.anim_in &&
    out.anim_out === c.anim_out &&
    out.anim_in_s === c.anim_in_s &&
    out.anim_out_s === c.anim_out_s
    ? c
    : out;
}

function fitPieceAnims(c: VideoClip): void {
  const half = Math.floor((clipLength(c) / 2) * 1000) / 1000;
  for (const side of ["in", "out"] as const) {
    const name = `anim_${side}` as const;
    const dur = `anim_${side}_s` as const;
    if (!c[name]) continue;
    const d = Math.min(c[dur] ?? ANIM_DEFAULT_S, half);
    if (d < ANIM_MIN_S) {
      delete c[name];
      delete c[dur];
    } else c[dur] = ms(d);
  }
}

/** Shorten a split piece's fades so fade in + fade out fit its length (the in-fade first gives way). */
function fitPieceFades(c: VideoClip): void {
  // The cap is the EXACT length floored to the millisecond: a length on a half millisecond (0.4225) rounds up here
  // (ms) and down in Python (_ms), so a fade fitted to either rounding could be refused by the other validator.
  const exact = c.speed_curve ? clipLength(c) : (c.out_s - c.in_s) / (c.speed > 0 ? c.speed : 1);
  const cap = Math.max(0, Math.floor(exact * 1000 + 1e-7) / 1000);
  const fo = Math.min(c.fade_out_s ?? 0, cap);
  const fi = Math.max(0, Math.min(c.fade_in_s ?? 0, Math.floor((cap - fo) * 1000 + 1e-7) / 1000));
  if (c.fade_out_s !== undefined) c.fade_out_s = ms(fo);
  if (c.fade_in_s !== undefined) c.fade_in_s = ms(fi);
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
      model.clips.map((c) => {
        if (c.id !== id) return c;
        // One constant speed replaces a curve (a document has either).
        const { speed_curve: _curve, ...rest } = c;
        void _curve;
        return { ...rest, speed: s };
      }),
    ),
  };
}

export function setClipAudio(
  model: EditorModel,
  id: string,
  audio: boolean,
): EditorModel {
  if (audio && audioInputs(model) >= MAX_AUDIO_CLIPS) return model;
  // A frozen frame has no sound (the document refuses both).
  if (audio && model.clips.find((c) => c.id === id)?.freeze) return model;
  return {
    ...model,
    clips: model.clips.map((c) => (c.id === id ? { ...c, audio } : c)),
  };
}

/** The clip volume control's percent for a clip's own sound (100 = as recorded; GAIN_DB_MIN reads 0). */
export function clipVolumePct(c: Pick<VideoClip, "gain_db">): number {
  const db = c.gain_db ?? 0;
  if (db <= GAIN_DB_MIN) return 0;
  return Math.round(100 * 10 ** (db / 20));
}

/** dB for a percent of the control: 0 % is GAIN_DB_MIN, 200 % is held at CLIP_GAIN_DB_MAX
 *  (+6 dB reads 200 %), to the millisecond-style 3 decimals the document stores. */
export function volumePctToDb(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return GAIN_DB_MIN;
  return ms(clamp(20 * Math.log10(pct / 100), GAIN_DB_MIN, CLIP_GAIN_DB_MAX));
}

/** Set the level of a clip's own sound from the control's percent. 100 % REMOVES the field,
 *  so an untouched clip keeps exactly its document. */
export function setClipVolume(model: EditorModel, id: string, pct: number): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at) return model;
  const db = volumePctToDb(pct);
  if ((at.gain_db ?? 0) === db) return model;
  return {
    ...model,
    clips: model.clips.map((c) => {
      if (c.id !== id) return c;
      const { gain_db: _old, ...rest } = c;
      void _old;
      return db === 0 ? rest : { ...rest, gain_db: db };
    }),
  };
}

/** Why a clip's own sound cannot be detached to a sound track of its own, or null when it can.
 *  A sound clip has no speed or direction, so only a forward clip at 1x is offered; a photo has no
 *  sound; the editor holds at most MAX_EDITOR_SOUNDS sounds. */
export type DetachProblem = "no_sound" | "not_video" | "retimed" | "sounds_full";
export function detachProblem(
  model: EditorModel,
  id: string,
  assetKind: EditorAsset["kind"] | undefined,
): DetachProblem | null {
  const c = model.clips.find((x) => x.id === id);
  if (!c || !c.audio || c.freeze) return "no_sound";
  if (assetKind !== "video") return "not_video";
  if (c.speed !== 1 || c.speed_curve || c.reverse) return "retimed";
  if (model.sounds.length >= MAX_EDITOR_SOUNDS) return "sounds_full";
  return null;
}

/**
 * Detach a clip's own sound: the clip goes silent and the same stretch of the same file becomes a
 * sound of its own (a speech sound, as the clip's sound was for ducking), where it starts on the
 * timeline now; from then on it is moved, trimmed and deleted like any sound and no longer follows
 * the clip. Its level and clean-up go with it. One input of the mix either way (MAX_AUDIO_CLIPS).
 * Null when `detachProblem` says no.
 */
export function detachClipAudio(
  model: EditorModel,
  id: string,
  assetKind: EditorAsset["kind"] | undefined,
): { model: EditorModel; soundId: string } | null {
  if (detachProblem(model, id, assetKind) !== null) return null;
  const c = layout(model.clips).find((x) => x.id === id)!;
  const soundId = freshId(model, "m");
  const sound: SoundClip = {
    id: soundId,
    asset_id: c.asset_id,
    start_s: ms(c.start_s),
    in_s: ms(c.in_s),
    out_s: ms(c.out_s),
    gain_db: ms(clamp(c.gain_db ?? 0, GAIN_DB_MIN, GAIN_DB_MAX)),
    fade_in_s: 0,
    fade_out_s: 0,
    role: "speech",
    ...(c.denoise ? { denoise: true } : {}),
    ...(c.loudnorm ? { loudnorm: true } : {}),
  };
  return {
    model: {
      ...model,
      clips: model.clips.map((x) => {
        if (x.id !== id) return x;
        const { gain_db: _g, denoise: _d, loudnorm: _l, ...rest } = x;
        void _g;
        void _d;
        void _l;
        return { ...rest, audio: false };
      }),
      sounds: [...model.sounds, sound],
    },
    soundId,
  };
}

/** Can one more clip go on the picture lane? */
export function canInsertClip(model: EditorModel): boolean {
  return model.clips.length < MAX_EDITOR_CLIPS;
}

/**
 * A copy of `source` (a clip of this project: duplicate, or paste) put right after clip `afterId`
 * (at the end when that is not on the lane), with a fresh id. The copy keeps every setting of the
 * original but its way in: it follows the clip before it with a cut (a cross-fade belongs to the
 * place a clip was, not to the clip). Its own sound is off when the mix is already full. The
 * editor's settling (lib/editorSettle.ts) then keeps per-project budgets (smoothing, steadying) honest.
 */
export function insertClipCopy(
  model: EditorModel,
  source: VideoClip,
  afterId: string | null,
): { model: EditorModel; id: string } | null {
  if (!canInsertClip(model)) return null;
  const id = freshId(model, "c");
  const copy: VideoClip = withoutTransition({
    ...(JSON.parse(JSON.stringify(source)) as VideoClip),
    id,
    audio: source.audio && audioInputs(model) < MAX_AUDIO_CLIPS,
  });
  const clips = layout(model.clips);
  const i = afterId === null ? -1 : clips.findIndex((c) => c.id === afterId);
  const at = i < 0 ? clips.length : i + 1;
  const next = [...clips.slice(0, at), copy, ...clips.slice(at)];
  return { model: { ...model, clips: layout(next) }, id };
}

/** Duplicate clip `id`: its copy right after it. */
export function duplicateClip(
  model: EditorModel,
  id: string,
): { model: EditorModel; id: string } | null {
  const c = model.clips.find((x) => x.id === id);
  return c ? insertClipCopy(model, c, id) : null;
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
      return fitAnims(next);
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
  // An export in another frame (migration 0129, modules/editor_export.py): the row's frame was not exactly an entry of
  // the closed list, or the worker's switch was off when it arrived.
  "invalid_frame",
  "frame_off",
  // A paid 1440p / 4K export (migration 0132, modules/editor_export.py): the worker's switch was off (the database gave
  // the credits back when the export failed), the hold was no longer open when the worker took it, or the version is
  // faster than 4K allows (30 fps). Above 1080p is never free: a row without a paid frame whose picture is above 1080p, a
  // paid export of a document with a speed curve (its length cannot be priced), or a render that would start more minutes
  // than were priced.
  "hires_off",
  "credits_released",
  "hires_fps",
  "hires_needs_paid_export",
  "hires_speed_curve",
  "hires_length_mismatch",
] as const;
export type ExportReason = (typeof EXPORT_REASONS)[number];

/** The frame an export was asked in (migration 0129): a format of the closed list and its size as the database's
 *  list had it. Absent (null) = the project's own frame, which is every export before 0129. */
export interface ExportFrame {
  preset: string;
  width: number;
  height: number;
}

export interface EditorExport {
  id: string;
  rev: number;
  status: ExportStatus;
  reason: ExportReason | "other" | null;
  durationS: number | null;
  assetId: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  /** The frame it was asked in. ABSENT for the project's own frame (and when the columns were not read: before 0129,
   *  or with the switch off), so a plain export is the object it always was. */
  frame?: ExportFrame;
}

export const EDITOR_EXPORT_COLUMNS =
  "id, rev, status, reason, duration_s, asset_id, created_at, finished_at";
/** The same, with the frame an export was asked in (migration 0129). Read only while the switch is on; a database
 *  without 0129 answers "no such column" and the reader falls back to the columns above (lib/server/editor.ts). */
export const EDITOR_EXPORT_FRAME_COLUMNS = `${EDITOR_EXPORT_COLUMNS}, frame_preset, frame_width, frame_height`;
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
    // The row's three columns (the server's read) or the object the route sent on (the page's poll). All three or
    // nothing: a frame that is half there is shown as no frame, never as a guessed one.
    const f = isObj(r.frame) ? r.frame : null;
    const preset = f ? f.preset : r.frame_preset;
    const fw = f ? f.width : r.frame_width;
    const fh = f ? f.height : r.frame_height;
    const frame: ExportFrame | null =
      typeof preset === "string" && /^[a-z0-9_]{1,32}$/.test(preset) && isInt(fw) && isInt(fh) && fw > 0 && fh > 0
        ? { preset, width: fw, height: fh }
        : null;
    out.push({
      id: r.id,
      rev: Number(r.rev) || 0,
      status,
      reason,
      durationS: Number.isFinite(dur) && dur > 0 ? dur : null,
      assetId: str(r.asset_id, r.assetId),
      createdAt: str(r.created_at, r.createdAt),
      finishedAt: str(r.finished_at, r.finishedAt),
      ...(frame ? { frame } : {}),
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
  // A paid 1440p / 4K export (migration 0132): the size is not on sale, its price changed after the person confirmed
  // it, the credits are short, the video is longer than the size allows, no confirmed price came with the request,
  // the plan's parallel runs are in use (a held paid export is a run in progress, 0034), 4K of a project over 30 fps, a
  // document with a speed curve, or a project whose own frame is above 1080p asked for free.
  "not_on_sale",
  "price_changed",
  "insufficient_credits",
  "hires_too_long",
  "quote_required",
  "parallel_runs",
  "hires_fps",
  "hires_speed_curve",
  "hires_needs_paid_export",
  // Exports up to 1080p are sold (migration 0136, the owner set their price): the plain request holds nothing, so it is
  // refused and the editor asks the price and the person's yes first.
  "export_needs_quote",
  // A speed curve the renderer would refuse (0136 prices a curve at its rendered length, so a curve it cannot read is
  // not priced at all): the quote and the paid request refuse it.
  "invalid_speed_curve",
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
  // 0132
  hires_too_long: "hires_too_long",
  price_changed: "price_changed",
  parallel_runs: "parallel_runs",
  hires_fps: "hires_fps",
  hires_speed_curve: "hires_speed_curve",
  hires_needs_paid_export: "hires_needs_paid_export",
  // 0136
  export_needs_quote: "export_needs_quote",
  invalid_speed_curve: "invalid_speed_curve",
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
    // 0132: a paid export. NS402 is reserve_credits' "insufficient credits" (renamed by the function), NS403 "not on sale".
    case "NS402":
      return { error: "insufficient_credits", status: 402 };
    case "NS403":
      return { error: "not_on_sale", status: 403 };
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

/** What a track kind may hold (modules/timeline.py TRACK_ASSET_KINDS). A sound may be a video
 *  file's sound (a clip's detached audio); a picture has none. */
const TRACK_ASSET_KINDS: Record<"V" | "A", readonly string[]> = {
  V: ["video", "image"],
  A: ["audio", "video"],
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
