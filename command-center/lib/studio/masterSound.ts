/**
 * What the finished project's file says about its own sound (S2, Lens I4): the assembly writes it on the master's provenance
 * (`provenance.sound`, modules/film_assembly.py `sound_record`), and the live view shows it next to the final video.
 *
 * Rule 5: a master without the record (made before S2, or a read that failed) is "unknown", never "normal". Every number shown is
 * the one the assembly measured; nothing here computes or guesses one.
 */

export type LoudnessMode = "linear" | "dynamic" | "silent" | "unknown";

export interface MeasuredLoudness {
  /** Integrated loudness (LUFS), true peak (dBTP) and loudness range (LU) the mix measured before the pass. null = not recorded. */
  i: number | null;
  tp: number | null;
  lra: number | null;
}

export type MasterSound =
  | { state: "unknown" }
  /** The project has no sound at all (no narration, no music, no shot's own sound). */
  | { state: "none" }
  | {
      state: "ready";
      mode: LoudnessMode;
      measured: MeasuredLoudness;
      /** Shots whose priced sound option was bought and whose sound the project does not play: "already paid for". */
      paidUnused: number;
      /** Shots whose file carries sound that is left out by default (a model whose sound comes with the clip). */
      defaultUnused: number;
    };

const UNKNOWN: MasterSound = { state: "unknown" };

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function modeOf(loud: Record<string, unknown>): LoudnessMode {
  if (loud.mode === "linear") return "linear";
  if (loud.mode === "dynamic") return "dynamic";
  if (loud.mode === null && typeof loud.status === "string" && loud.status.startsWith("not applied")) return "silent";
  return "unknown";
}

/** `provenance.sound` of the master (whatever the database answered) as the view reads it. */
export function coerceMasterSound(raw: unknown): MasterSound {
  const s = rec(raw);
  if (!s || s.mix_format !== 2) return UNKNOWN;
  if (s.status === "no sound") return { state: "none" };
  const loud = rec(s.master_loudness);
  if (s.status !== "mastered" || !loud) return UNKNOWN;
  const m = rec(loud.measured) ?? {};
  let paidUnused = 0;
  let defaultUnused = 0;
  for (const scene of Array.isArray(s.scenes) ? s.scenes : []) {
    const sc = rec(scene);
    if (!sc) continue;
    const status = Array.isArray(sc.clip_sound) ? sc.clip_sound : [];
    const paid = Array.isArray(sc.sound_paid) ? sc.sound_paid : [];
    const file = Array.isArray(sc.file_sound) ? sc.file_sound : [];
    status.forEach((st, k) => {
      if (st === "used" || st === "lip-synced") return;
      if (paid[k] === true) paidUnused += 1;
      else if (st === "muted" && sc.source === "default" && file[k] === true) defaultUnused += 1;
    });
  }
  return { state: "ready", mode: modeOf(loud), measured: { i: num(m.I), tp: num(m.TP), lra: num(m.LRA) }, paidUnused, defaultUnused };
}
