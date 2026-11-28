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

/** Why the sound is unknown, each with its own sentence (Pixel M2): the record could not be read, the file was made before sound
 * checks were recorded, or the file carries no record. */
export type UnknownCause = "read_failed" | "made_before" | "no_record";

export type MasterSound =
  | { state: "unknown"; cause: UnknownCause }
  /** The project has no sound at all (no narration, no music, no clip's own sound). */
  | { state: "none" }
  | {
      state: "ready";
      mode: LoudnessMode;
      measured: MeasuredLoudness;
      /** Clips bought with the priced sound option whose sound this video does not play. null: not recorded (rule 5, never 0). */
      paidUnused: number | null;
      /** Clips whose file carries sound left out by default (a model whose sound comes with the clip). null: not recorded. */
      defaultUnused: number | null;
    };

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

export const MIX_FORMAT = 2;

/**
 * The master's sound as the view reads it. `mixFormat` is the master's `provenance.mix_format` and `raw` its `provenance.sound`
 * (whatever the database answered). A master from before the record (no mix_format, or an older one) is "made_before".
 */
export function coerceMasterSound(mixFormat: unknown, raw: unknown): MasterSound {
  if (typeof mixFormat !== "number" || mixFormat < MIX_FORMAT) return { state: "unknown", cause: "made_before" };
  const s = rec(raw);
  if (!s || s.mix_format !== MIX_FORMAT) return { state: "unknown", cause: "no_record" };
  if (s.status === "no sound") return { state: "none" };
  const loud = rec(s.master_loudness);
  if (s.status !== "mastered" || !loud) return { state: "unknown", cause: "no_record" };
  const m = rec(loud.measured) ?? {};
  let paidUnused: number | null = 0;
  let defaultUnused: number | null = 0;
  for (const scene of Array.isArray(s.scenes) ? s.scenes : []) {
    const sc = rec(scene);
    if (!sc) continue;
    const status = Array.isArray(sc.clip_sound) ? sc.clip_sound : [];
    if (!status.length) continue;
    // A scene that lists its clips but not whether each was paid for (or what its file carries) leaves the count unknown, never
    // a 0 that reads as "nothing" (Pixel L5).
    const paid = Array.isArray(sc.sound_paid) && sc.sound_paid.length === status.length ? sc.sound_paid : null;
    const file = Array.isArray(sc.file_sound) && sc.file_sound.length === status.length ? sc.file_sound : null;
    if (!paid) paidUnused = null;
    if (!paid || !file) defaultUnused = null;
    status.forEach((st, k) => {
      if (st === "used" || st === "lip-synced") return;
      if (paid && paid[k] === true) {
        if (paidUnused !== null) paidUnused += 1;
      } else if (paid && file && st === "muted" && sc.source === "default" && file[k] === true && defaultUnused !== null) {
        defaultUnused += 1;
      }
    });
  }
  return { state: "ready", mode: modeOf(loud), measured: { i: num(m.I), tp: num(m.TP), lra: num(m.LRA) }, paidUnused, defaultUnused };
}
