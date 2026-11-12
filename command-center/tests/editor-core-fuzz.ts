/**
 * The seeded edit run behind tests/editor-core.test.ts (5,000 edits, held to the TypeScript checks) and
 * tests/editor-core-fuzz.test.ts (the documents it makes, written to samples/editor_core_fuzz_docs.json.gz and
 * held to the PYTHON validator by tests/test_editor_core_fuzz.py). Not a test file itself.
 *
 * Every operation of the editing core runs on random timelines (1080p, 9:16, 1440p and 4K frames at 24 to 60 fps;
 * fast, slow, reversed, frozen and still clips; cross-fades, fades, entrances; music), then the editor's own
 * settling, exactly as the editor runs them. Each changed state is checked by `check` and kept.
 */
import {
  gapOf,
  layout,
  modelDuration,
  rippleTrimTo,
  rollEdit,
  slideClip,
  slipClip,
  splitClip,
  toDoc,
  type EditorModel,
  type SoundClip,
  type TimelineDoc,
  type VideoClip,
} from "@/lib/editor";
import { NO_MARKS, extractRange, insertAt, liftRange, markedRange, setMark, splitEdit } from "@/lib/editorRange";
import { settleAll } from "@/lib/editorSettle";

export const FA = "11111111-1111-4111-8111-111111111111"; // a 10 s video
export const FB = "22222222-2222-4222-8222-222222222222"; // a 6 s video
export const FP = "33333333-3333-4333-8333-333333333333"; // a picture
export const FM = "44444444-4444-4444-8444-444444444444"; // a 30 s sound
export const FUZZ_LEN: Record<string, number | "still"> = { [FA]: 10, [FB]: 6, [FP]: "still", [FM]: 30 };
export const FUZZ_KIND: Record<string, "video" | "image" | "audio"> = { [FA]: "video", [FB]: "video", [FP]: "image", [FM]: "audio" };
export const fuzzSourceOf = (id: string) => FUZZ_LEN[id] ?? null;
const kindOf = (id: string) => FUZZ_KIND[id];

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAMES = [
  [1920, 1080],
  [1080, 1920],
  [2560, 1440],
  [3840, 2160],
] as const;
const RATES = [24, 25, 30, 60];

export function randomModel(r: () => number): EditorModel {
  const n = 1 + Math.floor(r() * 6);
  const clips: VideoClip[] = [];
  for (let i = 0; i < n; i += 1) {
    const kind = r();
    const asset = kind < 0.15 ? FP : kind < 0.55 ? FA : FB;
    const len = asset === FP ? 8 : (FUZZ_LEN[asset] as number);
    // Times on the millisecond, not the tenth: the rounding of odd lengths at odd speeds is what has to agree.
    const a = Math.round(r() * (len - 1) * 1000) / 1000;
    const b = Math.min(len, Math.round((a + 0.5 + r() * (len - a - 0.5)) * 1000) / 1000);
    const c: VideoClip = {
      id: `c${i + 1}`,
      asset_id: asset,
      start_s: 0,
      in_s: asset === FP ? 0 : a,
      out_s: asset === FP ? 1 + Math.round(r() * 4000) / 1000 : b,
      speed: 1,
      audio: asset !== FP && r() < 0.8,
    };
    const v = r();
    if (asset !== FP && v < 0.2) c.speed = [0.25, 0.5, 0.75, 1.5, 2, 3, 7][Math.floor(r() * 7)];
    else if (asset !== FP && v < 0.27) c.reverse = true;
    else if (asset !== FP && v < 0.32) {
      c.freeze = true;
      c.audio = false;
    }
    if (i > 0 && r() < 0.3) c.transition = { type: "crossfade", duration_s: 0.3 + Math.round(r() * 700) / 1000 };
    if (r() < 0.2) c.fade_in_s = 0.2;
    if (r() < 0.2) c.fade_out_s = 0.3;
    if ((c.fade_in_s ?? 0) + (c.fade_out_s ?? 0) > (c.out_s - c.in_s) / c.speed - 0.05) {
      delete c.fade_in_s;
      delete c.fade_out_s;
    }
    if (r() < 0.1 && !c.fade_in_s) c.anim_in = "zoom";
    clips.push(c);
  }
  const [width, height] = FRAMES[Math.floor(r() * FRAMES.length)];
  const fps = RATES[Math.floor(r() * RATES.length)];
  const sounds: SoundClip[] = [];
  for (let k = 0; k < Math.floor(r() * 3); k += 1) {
    const a = Math.round(r() * 10 * 1000) / 1000;
    sounds.push({
      id: `m${k + 1}`,
      asset_id: FM,
      start_s: Math.round(r() * 8 * 1000) / 1000,
      in_s: a,
      out_s: Math.min(30, Math.round((a + 1 + r() * 12) * 1000) / 1000),
      gain_db: 0,
      fade_in_s: r() < 0.3 ? 0.5 : 0,
      fade_out_s: r() < 0.3 ? 0.5 : 0,
      ...(k === 0 && r() < 0.5 ? { role: "music" as const, duck: { amount_db: 12, attack_s: 0.3, release_s: 0.8 } } : {}),
    });
  }
  return { width, height, fps, clips: layout(clips), texts: [], sounds, keep: [] };
}

export const fuzzAssets = { [FA]: "video", [FB]: "video", [FP]: "image", [FM]: "audio" } as Record<string, string>;

/** Run `docs` random timelines of `steps` edits each from `seed`; `check` sees every state (after settling). */
export function runFuzz(
  seed: number,
  docs: number,
  steps: number,
  check: (m: EditorModel, where: string) => void,
): { states: TimelineDoc[]; edits: number; byOp: number[] } {
  const r = rng(seed);
  const states: TimelineDoc[] = [];
  const byOp = new Array(11).fill(0) as number[];
  let edits = 0;
  for (let doc = 0; doc < docs; doc += 1) {
    let m = settleAll(randomModel(r)).model;
    check(m, `seed ${seed} doc ${doc} start`);
    states.push(toDoc(m));
    let marks = NO_MARKS;
    let clipboard: VideoClip | null = null;
    for (let step = 0; step < steps; step += 1) {
      const clips = layout(m.clips);
      const total = modelDuration(m);
      const pick = clips.length ? clips[Math.floor(r() * clips.length)] : null;
      const t = Math.round(r() * total * m.fps) / m.fps;
      const d = (r() - 0.5) * 6;
      const op = Math.floor(r() * 11);
      let next = m;
      let keepsLength = false;
      if (op === 0 && pick) {
        next = rollEdit(m, pick.id, d, fuzzSourceOf);
        keepsLength = true;
      } else if (op === 1 && pick) {
        next = slipClip(m, pick.id, d, fuzzSourceOf);
        keepsLength = true;
      } else if (op === 2 && pick) {
        next = slideClip(m, pick.id, d, fuzzSourceOf);
        keepsLength = true;
      } else if (op === 3) next = rippleTrimTo(m, t, r() < 0.5 ? "head" : "tail")?.model ?? m;
      else if (op === 4) marks = setMark(marks, r() < 0.5 ? "in" : "out", t, m.fps, total);
      else if (op === 5) {
        const rg = markedRange(marks, total, m.fps);
        const out = rg ? extractRange(m, rg[0], rg[1]) : null;
        if (out && "model" in out) next = out.model;
      } else if (op === 6) {
        const rg = markedRange(marks, total, m.fps);
        const out = rg ? liftRange(m, rg[0], rg[1]) : null;
        if (out && rg && "model" in out) {
          next = out.model;
          // nothing after the range moves: every clip that started after it starts where it did
          const after = layout(m.clips).filter((c) => c.start_s > rg[1] + 2.01);
          for (const c of after) {
            const now = layout(next.clips).find((x) => x.id === c.id);
            if (now && Math.abs(now.start_s - c.start_s) > 0.0011)
              throw new Error(`seed ${seed} doc ${doc} step ${step}: lift moved ${c.id} ${c.start_s} -> ${now.start_s}`);
          }
        }
      } else if (op === 7 && clipboard) {
        const out = insertAt(m, clipboard, t);
        if ("model" in out) next = out.model;
      } else if (op === 8 && pick) clipboard = pick;
      else if (op === 9 && pick) {
        const out = splitEdit(m, pick.id, r() < 0.5 ? "j" : "l", 1 + Math.floor(r() * 24), fuzzSourceOf, kindOf);
        if ("model" in out) next = out.model;
      } else if (op === 10 && pick) next = splitClip(m, pick.id, t)?.model ?? m;
      edits += 1;
      if (next === m) continue;
      byOp[op] += 1;
      if (keepsLength && Math.abs(modelDuration(next) - total) > 0.003)
        throw new Error(`seed ${seed} doc ${doc} step ${step}: op ${op} changed the length ${total} -> ${modelDuration(next)}`);
      const settled = settleAll(next, m).model;
      // A gap is black whatever settling does: settling never closes, opens or moves one.
      for (const c of layout(next.clips)) {
        const s2 = settled.clips.find((x) => x.id === c.id);
        if (s2 && gapOf(s2) !== gapOf(c))
          throw new Error(`seed ${seed} doc ${doc} step ${step}: settling changed the gap before ${c.id}`);
      }
      check(settled, `seed ${seed} doc ${doc} step ${step} op ${op}`);
      states.push(toDoc(settled));
      m = settled;
    }
  }
  return { states, edits, byOp };
}
