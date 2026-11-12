/**
 * The seeded edit run of "reuse a look" (editor parity phase 2), behind tests/editor-look.test.ts (held to the
 * TypeScript checks, with undo / redo) and tests/editor-look-fuzz.test.ts (the documents it makes, written to
 * samples/editor_look_fuzz_docs.json.gz and held to the PYTHON validator by tests/test_editor_look_fuzz.py). Not a
 * test file itself.
 *
 * The timelines of the editing core's run (lib/editor-core-fuzz.ts: 1080p, 9:16, 1440p and 4K at 24-60 fps; fast,
 * slow, reversed, frozen and still clips; cross-fades; music) are given texts, overlays and shapes, and get the
 * multi-select edits (delete, move, nudge, copy and paste of a list), paste attributes (from a clip or a stored
 * preset), and the ripple edits with sync lock (clip removed, trim, ripple trim, extract, insert, silence cuts, gap
 * closed) with random lanes locked; then the editor's own settling, exactly as the editor runs them.
 */
import {
  layout,
  modelDuration,
  removeClip,
  rippleTrimTo,
  splitClip,
  toDoc,
  validateTimeline,
  closeGap,
  gapsOf,
  ms,
  type EditorModel,
  type PictureOverlay,
  type TextClip,
  type TimelineDoc,
  type VideoClip,
} from "@/lib/editor";
import { liftRange } from "@/lib/editorRange";
import { trimLimited } from "@/lib/editorMotion";
import { applyCuts } from "@/lib/editorSilence";
import { settleAll } from "@/lib/editorSettle";
import { SYNC_LANES, extractInSync, insertInSync, syncLock, NO_LOCKS, type SyncLane, type SyncLocks } from "@/lib/editorSync";
import { allItems, copyItems, moveClips, nudgeItems, pasteItems, removeItems, type Item } from "@/lib/editorSelection";
import { LOOK_GROUPS, copyLook, pasteLook, sanitizeLook } from "@/lib/editorPasteLook";
import { SHAPE_KINDS, type ShapeLayer } from "@/lib/editorShapes";
import { FA, FB, FM, FP, FUZZ_KIND, FUZZ_LEN, randomModel, rng } from "./editor-core-fuzz";

export const FO = "55555555-5555-4555-8555-555555555555"; // an overlay picture
export const lookAssets = { [FA]: "video", [FB]: "video", [FP]: "image", [FM]: "audio", [FO]: "image" } as Record<string, string>;
const kindOf = (id: string) => (id === FO ? "image" : FUZZ_KIND[id]) as "video" | "image" | "audio";
const isVideoAsset = (id: string) => kindOf(id) === "video";

/** A timeline of the core run with texts, overlays and shapes over it. */
export function randomLookModel(r: () => number): EditorModel {
  const m = randomModel(r);
  const total = Math.max(1, modelDuration(m));
  const at = () => Math.round(r() * total * 0.9 * 1000) / 1000;
  const len = () => 0.3 + Math.round(r() * 2500) / 1000;
  const texts: TextClip[] = Array.from({ length: Math.floor(r() * 4) }, (_, i) => {
    const s = at();
    return { id: `x${i + 1}`, start_s: s, end_s: ms(s + len()), text: `T${i}`, size: 64, x: 0.5, y: 0.85, anchor: "center" };
  });
  const overlays: PictureOverlay[] = Array.from({ length: Math.floor(r() * 3) }, (_, i) => {
    const s = at();
    return { id: `o${i + 1}`, asset_id: FO, start_s: s, end_s: ms(s + len()), x: 0.7, y: 0.3, w: 0.2, opacity: 1 };
  });
  const kinds = SHAPE_KINDS.filter((k) => k !== "pill" && k !== "progress");
  const shapes: ShapeLayer[] = Array.from({ length: Math.floor(r() * 3) }, (_, i) => {
    const s = at();
    return { id: `h${i + 1}`, kind: kinds[Math.floor(r() * kinds.length)], start_s: s, end_s: ms(s + len()), color: "#FFCC00", opacity: 1 };
  });
  // a look on some clips, so paste attributes has something to copy
  const looks: Partial<VideoClip>[] = [
    { grade: { brightness: 0.1, contrast: 1.1, saturation: 1.2 } },
    { filter: "warm", vignette: 0.3 },
    { color: { hue: 15, curve: "matte" } as VideoClip["color"] },
    { mask: { shape: "ellipse", w: 0.7, h: 0.7, feather: 0.1 } },
    { fx: { glitch: 30 } },
    { move: { from: { zoom: 1 }, to: { zoom: 1.4 } }, fit: "cover" },
    { fade_in_s: 0.2, gain_db: -3 },
  ];
  let clips = m.clips;
  for (const c of m.clips) {
    if (r() >= 0.4) continue;
    const tried = clips.map((x) => (x.id === c.id ? { ...x, ...looks[Math.floor(r() * looks.length)] } : x));
    // a look this clip cannot take (a fade on a clip with an entrance, longer than a short clip) is not given
    if (!validateTimeline(toDoc({ ...m, clips: layout(tried) })).length) clips = tried;
  }
  return {
    ...m,
    clips: layout(clips),
    texts,
    ...(overlays.length ? { overlays } : {}),
    ...(shapes.length ? { shapes } : {}),
  };
}

const times = (m: EditorModel, lane: SyncLane) =>
  JSON.stringify(
    lane === "sounds"
      ? m.sounds.map((x) => [x.id, x.start_s])
      : (lane === "texts" ? m.texts : lane === "overlays" ? (m.overlays ?? []) : (m.shapes ?? [])).map((x) => [x.id, x.start_s, x.end_s]),
  );

/** The editor's history, as TimelineEditor keeps it: each edit pushes the model before it; undo and redo move it. */
class History {
  past: EditorModel[] = [];
  future: EditorModel[] = [];
  constructor(public now: EditorModel) {}
  apply(next: EditorModel) {
    this.past.push(this.now);
    this.future = [];
    this.now = next;
  }
  undo() {
    const p = this.past.pop();
    if (!p) return;
    this.future.unshift(this.now);
    this.now = p;
  }
  redo() {
    const f = this.future.shift();
    if (!f) return;
    this.past.push(this.now);
    this.now = f;
  }
}

export const LOOK_OPS = 15;

/** Run `docs` random timelines of `steps` edits each from `seed`; `check` sees every state (after settling). */
export function runLookFuzz(
  seed: number,
  docs: number,
  steps: number,
  check: (m: EditorModel, where: string) => void,
): { states: TimelineDoc[]; edits: number; byOp: number[]; undone: number } {
  const r = rng(seed);
  const states: TimelineDoc[] = [];
  const byOp = new Array(LOOK_OPS).fill(0) as number[];
  let edits = 0;
  let undone = 0;
  const sourceOf = (id: string) => FUZZ_LEN[id] ?? null;
  for (let doc = 0; doc < docs; doc += 1) {
    const h = new History(settleAll(randomLookModel(r)).model);
    check(h.now, `seed ${seed} doc ${doc} start`);
    states.push(toDoc(h.now));
    const docsHere: string[] = [JSON.stringify(toDoc(h.now))];
    const snapshots: [EditorModel, string][] = [[h.now, JSON.stringify(h.now)]];
    let locks: SyncLocks = NO_LOCKS;
    let board: VideoClip | null = null;
    for (let step = 0; step < steps; step += 1) {
      const m = h.now;
      const clips = layout(m.clips);
      const total = modelDuration(m);
      const pick = clips.length ? clips[Math.floor(r() * clips.length)] : null;
      const t = Math.round(r() * total * m.fps) / m.fps;
      const items = allItems(m);
      const some = (): Item[] => items.filter(() => r() < 0.35);
      const op = Math.floor(r() * LOOK_OPS);
      const where = `seed ${seed} doc ${doc} step ${step} op ${op}`;
      let next = m;
      // the ops that only ripple (sync lock alone moves the lanes): a locked lane must keep its times
      let rippleOnly = false;
      if (op === 0) next = removeItems(m, some(), locks).model;
      else if (op === 1) next = moveClips(m, some(), r() < 0.5 ? -1 : 1);
      else if (op === 2) next = nudgeItems(m, some(), ((r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * 10))) / m.fps).model;
      else if (op === 3) {
        const b = copyItems(m, some());
        next = pasteItems(m, b, pick?.id ?? null, t, { locks, isVideoAsset }).model;
      } else if (op === 4 && pick) {
        const targets = clips.filter(() => r() < 0.5).map((c) => c.id);
        const groups = LOOK_GROUPS.filter(() => r() < 0.6);
        // half the time the look comes back through a stored preset (sanitised), as a preset pastes it
        const look = r() < 0.5 ? copyLook(pick) : sanitizeLook(JSON.parse(JSON.stringify(copyLook(pick))));
        next = pasteLook(m, targets, look, groups, kindOf).model;
      } else if (op === 5 && pick) {
        next = syncLock(m, removeClip(m, pick.id), locks);
        rippleOnly = true;
      } else if (op === 6 && pick) {
        const src = sourceOf(pick.asset_id);
        const edge = r() < 0.5 ? "in" : "out";
        const v = edge === "in" ? pick.in_s + (r() - 0.5) * 2 : pick.out_s + (r() - 0.5) * 2;
        if (!pick.speed_curve && !pick.freeze && !pick.reverse) {
          // the editor's trim. A trim it leaves invalid (shorter than its fades, or under a frame at a high speed:
          // that predates sync lock, and Save refuses it) is not what this run is about.
          const trimmed = trimLimited(m, pick.id, edge, ms(v), typeof src === "number" ? src : null);
          if (!validateTimeline(toDoc(trimmed)).length) next = syncLock(m, trimmed, locks);
        }
        rippleOnly = true;
      } else if (op === 7) {
        const out = rippleTrimTo(m, t, r() < 0.5 ? "head" : "tail");
        if (out) next = syncLock(m, out.model, locks);
        rippleOnly = true;
      } else if (op === 8) {
        const a = Math.round(r() * total * m.fps) / m.fps;
        const out = extractInSync(m, Math.min(a, t), Math.max(a, t), locks);
        if ("model" in out) next = out.model;
        rippleOnly = true;
      } else if (op === 9 && board) {
        const out = insertInSync(m, board, t, locks);
        if ("model" in out) next = out.model;
        rippleOnly = true;
      } else if (op === 10 && pick) {
        // silence cuts on a plain video clip with its own sound (what the panel offers)
        if (kindOf(pick.asset_id) === "video" && pick.audio && !pick.reverse && !pick.freeze && !pick.speed_curve) {
          const cuts: [number, number][] = [];
          let a = pick.in_s + 0.2 + r() * 0.5;
          while (a + 0.3 < pick.out_s - 0.2) {
            const b = Math.min(pick.out_s - 0.2, a + 0.2 + r() * 1.2);
            cuts.push([ms(a), ms(b)]);
            a = b + 0.2 + r() * 1.5;
          }
          if (cuts.length) next = applyCuts(m, pick.id, cuts, locks).model;
        }
        rippleOnly = true;
      } else if (op === 11) {
        const g = gapsOf(m)[0];
        if (g) next = syncLock(m, closeGap(m, g.before), locks);
        rippleOnly = true;
      } else if (op === 12) {
        const a = Math.round(r() * total * m.fps) / m.fps;
        const out = liftRange(m, Math.min(a, t), Math.max(a, t));
        if ("model" in out) next = out.model;
      } else if (op === 13) {
        const lane = SYNC_LANES[Math.floor(r() * SYNC_LANES.length)];
        locks = { ...locks, [lane]: !locks[lane] };
      } else if (op === 14 && pick) {
        if (r() < 0.5) board = pick;
        else next = splitClip(m, pick.id, t)?.model ?? m;
      }
      edits += 1;
      if (next === m) continue;
      byOp[op] += 1;
      if (rippleOnly)
        for (const lane of SYNC_LANES)
          if (locks[lane] && times(next, lane) !== times(m, lane))
            throw new Error(`${where}: the locked ${lane} lane moved`);
      for (const x of [...next.texts, ...next.sounds, ...(next.overlays ?? []), ...(next.shapes ?? [])])
        if (!(x.start_s >= 0)) throw new Error(`${where}: ${x.id} starts before 0 (${x.start_s})`);
      const settled = settleAll(next, m).model;
      check(settled, where);
      h.apply(settled);
      states.push(toDoc(settled));
      docsHere.push(JSON.stringify(toDoc(settled)));
      snapshots.push([settled, JSON.stringify(settled)]);
    }
    // No operation changed a model it was given (the history keeps them): each is as it was when it was made.
    for (const [x, json] of snapshots)
      if (JSON.stringify(x) !== json) throw new Error(`seed ${seed} doc ${doc}: an operation changed an earlier state`);
    // Undo all the way back and redo all the way forward: every step is the identical document it was.
    const n = docsHere.length - 1;
    for (let k = n - 1; k >= 0; k -= 1) {
      h.undo();
      undone += 1;
      if (JSON.stringify(toDoc(h.now)) !== docsHere[k]) throw new Error(`seed ${seed} doc ${doc}: undo to ${k} is not that document`);
    }
    for (let k = 1; k <= n; k += 1) {
      h.redo();
      if (JSON.stringify(toDoc(h.now)) !== docsHere[k]) throw new Error(`seed ${seed} doc ${doc}: redo to ${k} is not that document`);
    }
  }
  return { states, edits, byOp, undone };
}
