/**
 * Keeping the document one the export accepts after ANY edit.
 *
 * Several limits depend on things other than the clip a control belongs to: the
 * frame size (backwards play holds every frame in memory, smoothing and steadying
 * are charged by frame size), the length of the whole timeline (the export's time
 * allowance), and a neighbour's cross-fade (blur and zoom on a big frame). So an
 * edit elsewhere - another frame shape, a deleted clip, a shorter clip, a new
 * cross-fade - can leave a clip that was fine a moment ago over a limit, and Save
 * would then fail with a reason the person never saw.
 *
 * `settleAll` is the one policy for that, the same one a speed change uses: what
 * can be shortened is shortened to the limit (a backwards part), and what cannot
 * (smoothing, steadying, a blur, a zoom) is switched off or lowered. It returns
 * the changes it made, so the editor can say exactly what changed. It makes no
 * change at all when the document is fine (the same model back), and it never
 * touches a clip that fits.
 */
import {
  FX_LARGE_XFADE_MAX,
  FX_NAMES,
  INTERP_SECONDS_PER_FRAME,
  XFADE_LARGE_ZOOM_MAX,
  fitClipAnims,
  layout,
  lookSeconds,
  ms,
  setSpeed,
  stabilizeSeconds,
  type EditorModel,
  type VideoClip,
} from "@/lib/editor";
import { isCrossfaded, isLargeFrame } from "@/lib/editorFx";
import {
  interpolateCheck,
  interpolateFrames,
  renderWork,
  reverseCheck,
  reverseLimit,
} from "@/lib/editorMotion";
import { stabilizeCheck } from "@/lib/editorClean";
import { SHAPE_W_MIN } from "@/lib/editorShapes";
import { shapeBudgetProblem } from "@/lib/editorShapeModel";

export type SettleChange =
  | { kind: "shapeNarrowed"; shape: number }
  | { kind: "shapeRemoved"; shape: number }
  | { kind: "reverse"; clip: number; max: number }
  | { kind: "interpolate"; clip: number }
  | { kind: "stabilize"; clip: number }
  | { kind: "blur"; clip: number }
  | { kind: "zoom"; clip: number; max: number }
  | { kind: "speed"; clip: number; max: number }
  | { kind: "look"; clip: number }
  | { kind: "mask"; clip: number }
  | { kind: "fxLarge"; clip: number }
  | { kind: "anim"; clip: number }
  | { kind: "voiceClip"; clip: number }
  | { kind: "voiceSound"; sound: number };

function drop(c: VideoClip, ...keys: (keyof VideoClip)[]): VideoClip {
  const out = { ...c };
  for (const k of keys) delete out[k];
  return out;
}

function put(model: EditorModel, id: string, c: VideoClip): EditorModel {
  return { ...model, clips: model.clips.map((x) => (x.id === id ? c : x)) };
}

/** The constant-speed clips faster than 1x (a curve stays: its points are at most 4x, which always fits
 *  on its own; a frozen clip has no speed). */
function fastClips(m: EditorModel): VideoClip[] {
  return m.clips.filter((c) => !c.speed_curve && !c.freeze && c.speed > 1);
}

/** The export's time allowance without the shapes (they are settled last and must not cost clips anything). */
function fitsWithoutShapes(m: EditorModel): boolean {
  return renderWork({ ...m, shapes: undefined }).ok;
}

/**
 * Clips faster than 1x decode that many seconds of source for each second they last, and on a long timeline
 * the export cannot afford it. While the timeline is over its allowance, one fast clip at a time is slowed to
 * the fastest speed that fits (two decimals): those named in `first` (the clips this edit made faster) in that
 * order, then the fastest. A clip that cannot fit even at 1x is put at 1x and the next one is tried.
 */
function slowFastClips(
  model: EditorModel,
  first: readonly string[],
  changes: SettleChange[],
  number: (id: string) => number,
): EditorModel {
  let m = model;
  for (let guard = 0; guard < 64 && !fitsWithoutShapes(m); guard += 1) {
    const fast = fastClips(m);
    const fastest =
      first.map((id) => fast.find((c) => c.id === id)).find((c) => c !== undefined) ??
      [...fast].sort((a, b) => b.speed - a.speed)[0];
    if (!fastest) break;
    const at = (s: number) => setSpeed(m, fastest.id, s);
    let lo = 1;
    let hi = fastest.speed;
    if (fitsWithoutShapes(at(lo)))
      for (let i = 0; i < 40 && hi - lo > 0.001; i += 1) {
        const mid = (lo + hi) / 2;
        if (fitsWithoutShapes(at(mid))) lo = mid;
        else hi = mid;
      }
    let s = Math.max(1, Math.floor(lo * 100) / 100);
    while (s > 1 && !fitsWithoutShapes(at(s))) s = Math.max(1, Math.round((s - 0.01) * 100) / 100);
    m = at(s);
    changes.push({ kind: "speed", clip: number(fastest.id), max: s });
  }
  return m;
}

/**
 * `previous` (the model before the edit, when the caller has it) tells which clips the edit made faster: when
 * the timeline is over its time allowance because of fast clips, those are slowed first, before anything
 * else's smoothing or steadying is switched off (making clip 2 ten times faster must not quietly cost clip 1
 * its steadying).
 */
export function settleAll(
  model: EditorModel,
  previous?: EditorModel,
): { model: EditorModel; changes: SettleChange[] } {
  const hasLimits =
    model.clips.some(
      (c) =>
        c.reverse || c.interpolate || c.stabilize || c.speed > 1 || c.color || c.mask || c.fx || c.anim_in || c.anim_out || c.voice,
    ) ||
    model.sounds.some((x) => x.voice) ||
    Boolean(model.shapes?.length);
  const large = isLargeFrame(model);
  if (!hasLimits && !large) return { model, changes: [] };
  const changes: SettleChange[] = [];
  let m = model;
  const number = (id: string) => m.clips.findIndex((c) => c.id === id) + 1;

  // 0. an entrance or exit longer than half its clip (after a trim or a speed change) is held to half of it, and
  //    dropped under ANIM_MIN_S (lib/editor.ts fitClipAnims, as a split does); again at the end (step 6), since
  //    step 1 can shorten a backwards clip
  const fitAnims = () => {
    for (const c of [...m.clips]) {
      const fitted = fitClipAnims(c);
      if (fitted === c) continue;
      m = put(m, c.id, fitted);
      if (!changes.some((x) => x.kind === "anim" && x.clip === number(c.id)))
        changes.push({ kind: "anim", clip: number(c.id) });
    }
  };
  fitAnims();

  // 1. a backwards part is shortened to what the frame size lets it hold
  for (const c of [...m.clips]) {
    if (!c.reverse || reverseCheck(m, c).ok) continue;
    const max = reverseLimit(m);
    m = { ...m, clips: layout(m.clips.map((x) => (x.id === c.id ? { ...x, out_s: ms(x.in_s + max) } : x))) };
    changes.push({ kind: "reverse", clip: number(c.id), max });
  }

  // 2. a cross-faded clip in a frame above 1440p takes no blur and a zoom of at most the cap
  if (large)
    for (const c of [...m.clips]) {
      if (!isCrossfaded(m, c.id)) continue;
      let x = m.clips.find((k) => k.id === c.id)!;
      if ((x.blur ?? 0) > 0) {
        m = put(m, c.id, drop(x, "blur"));
        changes.push({ kind: "blur", clip: number(c.id) });
        x = m.clips.find((k) => k.id === c.id)!;
      }
      const mv = x.move;
      if (mv && [mv.from, mv.to].some((p) => (p.zoom ?? 1) > XFADE_LARGE_ZOOM_MAX)) {
        const cap = (p: typeof mv.from) => ((p.zoom ?? 1) > XFADE_LARGE_ZOOM_MAX ? { ...p, zoom: XFADE_LARGE_ZOOM_MAX } : p);
        m = put(m, c.id, { ...x, move: { from: cap(mv.from), to: cap(mv.to) } });
        changes.push({ kind: "zoom", clip: number(c.id), max: XFADE_LARGE_ZOOM_MAX });
      }
    }

  // 2a. in such a frame a mask is not offered on a cross-faded clip, and a masked clip zooms at most the cap
  if (large)
    for (const c of [...m.clips]) {
      let x = m.clips.find((k) => k.id === c.id)!;
      // ... and at most FX_LARGE_XFADE_MAX effects of the pack: the strongest stays
      const on = FX_NAMES.filter((k) => (x.fx?.[k] ?? 0) > 0);
      if (on.length > FX_LARGE_XFADE_MAX && isCrossfaded(m, c.id)) {
        const keep = [...on].sort((a, b) => (x.fx![b] ?? 0) - (x.fx![a] ?? 0)).slice(0, FX_LARGE_XFADE_MAX);
        m = put(m, c.id, { ...x, fx: Object.fromEntries(keep.map((k) => [k, x.fx![k]])) });
        changes.push({ kind: "fxLarge", clip: number(c.id) });
        x = m.clips.find((k) => k.id === c.id)!;
      }
      if (!x.mask) continue;
      if (isCrossfaded(m, c.id)) {
        m = put(m, c.id, drop(x, "mask"));
        changes.push({ kind: "mask", clip: number(c.id) });
        continue;
      }
      const mv = x.move;
      if (mv && [mv.from, mv.to].some((p) => (p.zoom ?? 1) > XFADE_LARGE_ZOOM_MAX)) {
        const cap = (p: typeof mv.from) => ((p.zoom ?? 1) > XFADE_LARGE_ZOOM_MAX ? { ...p, zoom: XFADE_LARGE_ZOOM_MAX } : p);
        m = put(m, c.id, { ...x, move: { from: cap(mv.from), to: cap(mv.to) } });
        changes.push({ kind: "zoom", clip: number(c.id), max: XFADE_LARGE_ZOOM_MAX });
      }
    }

  // 2b. over the export's time allowance, and fast clips' decoding is what tips it (with every fast clip at
  //     1x it would fit): the fast clips are slowed first, those this edit made faster before the others, and
  //     smoothing and steadying stay. When it would not fit even then, they are settled below first.
  if (!fitsWithoutShapes(m) && fastClips(m).length) {
    const allAtOne = fastClips(m).reduce((x, c) => setSpeed(x, c.id, 1), m);
    if (fitsWithoutShapes(allAtOne)) {
      const before = new Map((previous?.clips ?? []).map((c) => [c.id, c.speed_curve ? 1 : c.speed]));
      const edited = fastClips(m)
        .filter((c) => c.speed > (before.get(c.id) ?? Number.POSITIVE_INFINITY))
        .sort((a, b) => b.speed - a.speed)
        .map((c) => c.id);
      m = slowFastClips(m, edited, changes, number);
    }
  }

  // 3. smoothing and steadying that no longer fit are switched off, the last clip first
  //    (each is judged as if it were on, with the others as they stand)
  for (const c of [...m.clips].reverse()) {
    const x = m.clips.find((k) => k.id === c.id)!;
    if (x.interpolate && !interpolateCheck(m, x).ok) {
      m = put(m, c.id, drop(x, "interpolate"));
      changes.push({ kind: "interpolate", clip: number(c.id) });
    }
  }
  for (const c of [...m.clips].reverse()) {
    const x = m.clips.find((k) => k.id === c.id)!;
    if (x.stabilize && !stabilizeCheck(m, x).ok) {
      m = put(m, c.id, drop(x, "stabilize"));
      changes.push({ kind: "stabilize", clip: number(c.id) });
    }
  }

  // 4. what is left must fit the export's time allowance together: the dearest goes first
  // (judged without the shapes: they are settled below, and must not cost the clips their smoothing)
  const withoutShapes = (x: EditorModel) => renderWork({ ...x, shapes: undefined });
  for (let guard = 0; guard < 64 && !withoutShapes(m).ok; guard += 1) {
    let worst: { id: string; kind: "interpolate" | "stabilize"; cost: number } | null = null;
    for (const c of m.clips) {
      if (c.interpolate) {
        const cost = INTERP_SECONDS_PER_FRAME * interpolateFrames(m, c);
        if (!worst || cost > worst.cost) worst = { id: c.id, kind: "interpolate", cost };
      }
      if (c.stabilize) {
        const cost = stabilizeSeconds(c as unknown as Record<string, unknown>, m.fps, m.width, m.height);
        if (!worst || cost > worst.cost) worst = { id: c.id, kind: "stabilize", cost };
      }
    }
    if (!worst) break;
    const x = m.clips.find((k) => k.id === worst!.id)!;
    changes.push({ kind: worst.kind, clip: number(worst.id) });
    m = put(m, worst.id, drop(x, worst.kind));
  }

  // 4b. what is still over after that and is fast clips' decoding: slowed as in 2b
  m = slowFastClips(m, [], changes, number);

  // 4c. what is still over is colour and masks (another frame size or rate, a shorter timeline): the
  //     dearest clip's colour and mask come off first, the last clip first on a tie
  for (let guard = 0; guard < 64 && !fitsWithoutShapes(m); guard += 1) {
    let worst: { id: string; cost: number } | null = null;
    for (const c of m.clips) {
      const cost = lookSeconds(c, m.fps, m.width, m.height);
      if (cost > 0 && (!worst || cost >= worst.cost)) worst = { id: c.id, cost };
    }
    if (!worst) break;
    const x = m.clips.find((k) => k.id === worst!.id)!;
    changes.push({ kind: "look", clip: number(worst.id) });
    // a fade costs nothing: only a slide or a zoom goes with the colour, mask and effects
    const moves = (["in", "out"] as const).flatMap((s) =>
      x[`anim_${s}`] && x[`anim_${s}`] !== "fade" ? ([`anim_${s}`, `anim_${s}_s`] as const) : [],
    );
    m = put(m, worst.id, drop(x, "color", "mask", "fx", ...moves));
  }

  // 4d. what is still over is clean voice (sound: 0.1 s per second, so only a timeline already at its limit):
  //     the last clean-voiced sound first, then the clips' own sounds from the last
  for (let guard = 0; guard < 128 && !fitsWithoutShapes(m); guard += 1) {
    const si = m.sounds.map((x) => Boolean(x.voice)).lastIndexOf(true);
    if (si >= 0) {
      const { voice: _v, ...rest } = m.sounds[si];
      void _v;
      m = { ...m, sounds: m.sounds.map((x, i) => (i === si ? rest : x)) };
      changes.push({ kind: "voiceSound", sound: si + 1 });
      continue;
    }
    const c = [...m.clips].reverse().find((x) => x.voice);
    if (!c) break;
    m = put(m, c.id, drop(c, "voice"));
    changes.push({ kind: "voiceClip", clip: number(c.id) });
  }

  // 5. shapes that no longer fit the export's memory or time (another frame size, a shorter timeline) are made
  //    narrower, the widest first, and the last ones are removed only when even the narrowest do not fit
  for (let guard = 0; guard < 400 && shapeBudgetProblem(m) !== null; guard += 1) {
    const list = m.shapes ?? [];
    const widest = [...list].filter((s) => (s.w ?? 0) > SHAPE_W_MIN + 1e-9).sort((a, b) => (b.w ?? 0) - (a.w ?? 0))[0];
    if (widest) {
      const next = { ...widest, w: Math.max(SHAPE_W_MIN, Math.round(widest.w! * 0.9 * 1000) / 1000) };
      const to = widest.move?.to.w;
      if (widest.move && to !== undefined) next.move = { to: { ...widest.move.to, w: Math.min(to, next.w) } };
      m = { ...m, shapes: list.map((s) => (s.id === widest.id ? next : s)) };
      if (!changes.some((c) => c.kind === "shapeNarrowed" && c.shape === list.indexOf(widest) + 1))
        changes.push({ kind: "shapeNarrowed", shape: list.indexOf(widest) + 1 });
      continue;
    }
    if (!list.length) break;
    const gone = list[list.length - 1];
    m = list.length > 1 ? { ...m, shapes: list.slice(0, -1) } : (({ shapes: _s, ...rest }) => (void _s, rest))(m);
    changes.push({ kind: "shapeRemoved", shape: list.length });
    void gone;
  }

  // 6. what steps 1-5 shortened keeps its animations inside it
  fitAnims();

  return changes.length ? { model: m, changes } : { model, changes: [] };
}
