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
  INTERP_SECONDS_PER_FRAME,
  XFADE_LARGE_ZOOM_MAX,
  layout,
  ms,
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

export type SettleChange =
  | { kind: "reverse"; clip: number; max: number }
  | { kind: "interpolate"; clip: number }
  | { kind: "stabilize"; clip: number }
  | { kind: "blur"; clip: number }
  | { kind: "zoom"; clip: number; max: number };

function drop(c: VideoClip, ...keys: (keyof VideoClip)[]): VideoClip {
  const out = { ...c };
  for (const k of keys) delete out[k];
  return out;
}

function put(model: EditorModel, id: string, c: VideoClip): EditorModel {
  return { ...model, clips: model.clips.map((x) => (x.id === id ? c : x)) };
}

export function settleAll(model: EditorModel): { model: EditorModel; changes: SettleChange[] } {
  const hasLimits = model.clips.some((c) => c.reverse || c.interpolate || c.stabilize);
  const large = isLargeFrame(model);
  if (!hasLimits && !large) return { model, changes: [] };
  const changes: SettleChange[] = [];
  let m = model;
  const number = (id: string) => m.clips.findIndex((c) => c.id === id) + 1;

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
  for (let guard = 0; guard < 64 && !renderWork(m).ok; guard += 1) {
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

  return changes.length ? { model: m, changes } : { model, changes: [] };
}
