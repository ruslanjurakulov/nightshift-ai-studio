/**
 * The VoiceExplainer composition's contract: a whole narrated video in one render.
 *
 * The narration is the clock. Every scene and word carries times in seconds from the
 * start of the recording; the composition never invents timing. Python builds these
 * props (modules/voice_explainer.py build_props) and is the only writer: a field added
 * here must be added there, with a test that pins it.
 *
 * Visuals are a CLOSED catalogue (`Visual["kind"]`). A planner (rules or a model) picks
 * one per scene and fills its fields; anything outside the catalogue is refused in Python
 * before a render starts, so a model can never ask this renderer to draw something it
 * cannot.
 */

export type LookId = "dusk" | "midnight" | "golden" | "neon" | "paper";

export interface Word {
  text: string;
  start_s: number;
  end_s: number;
}

export type Pose = "stand" | "wave" | "point" | "think" | "cheer" | "sad" | "sit";
export type Setting = "street" | "room" | "office" | "stage";
export type Prop = "none" | "laptop" | "phone" | "coin" | "chart" | "book";
export type Mood = "worried" | "happy" | "shocked" | "thinking" | "angry" | "calm";
export type Tone = "normal" | "good" | "bad";

export interface CastMember {
  pose: Pose;
  /** Index into the look's character palette (0..3). */
  color: number;
}

export type Visual =
  | { kind: "none" }
  | {
      kind: "card";
      title: string;
      subtitle?: string;
      rows: { label: string; value: string; tone?: Tone }[];
      total?: { label: string; value: string };
    }
  | { kind: "stat"; value: string; label: string }
  | { kind: "progress"; label: string; percent: number; note?: string }
  | { kind: "characters"; setting: Setting; cast: CastMember[]; prop: Prop }
  | { kind: "emoji"; mood: Mood }
  | { kind: "checklist"; items: string[] }
  | { kind: "chat"; messages: { side: "left" | "right"; text: string }[] };

export interface ExplainerScene {
  id: string;
  start_s: number;
  end_s: number;
  /** Small line above the headline ("Amerika YouTube'ida"). */
  kicker: string;
  /** The big line. Upper-cased by the renderer. */
  headline: string;
  /** One phrase shown under the visual in the italic serif. */
  accent: string;
  visual: Visual;
}

export interface SoundCue {
  src: string;
  at_s: number;
  volume: number;
}

// A type alias, not an interface: Remotion's props constraint is Record<string, unknown>, which only an alias satisfies.
export type ExplainerProps = {
  width: number;
  height: number;
  fps: number;
  duration_s: number;
  look: LookId;
  /** Paths inside the bundle's public dir (staticFile), or "" for none. */
  narration: string;
  music: string;
  music_volume: number;
  sfx: SoundCue[];
  words: Word[];
  scenes: ExplainerScene[];
  captions: boolean;
};
