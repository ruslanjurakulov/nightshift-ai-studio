/**
 * Visual style presets — the Studio Canvas catalog.
 *
 * Mirrors modules/style_presets.py: the same ids / names / directives (the bot
 * expands a channel's chosen preset id into the directive its generators use).
 * The extra `colors` here are for the gallery swatch only and have no backend
 * meaning. Keep the ids and directives in step with the Python catalog — each
 * side has a test asserting its catalog is well-formed.
 */

export interface StylePreset {
  id: string;
  name: string;
  /** The visual-style directive fed to Director Mode + b-roll search. */
  directive: string;
  /** One-word mood label. */
  mood: string;
  /** Three hex colors for the gallery swatch (dark → mid → light). */
  colors: [string, string, string];
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "cinematic-noir",
    name: "Cinematic Noir",
    directive:
      "cinematic film noir, high-contrast chiaroscuro lighting, deep moody shadows, desaturated, dramatic",
    mood: "tense",
    colors: ["#14171e", "#3b4252", "#c0c5ce"],
  },
  {
    id: "golden-epic",
    name: "Golden Epic",
    directive:
      "epic historical, warm golden-hour lighting, sweeping vistas, grand and majestic",
    mood: "grand",
    colors: ["#3a2410", "#b5731f", "#f2c777"],
  },
  {
    id: "neon-cyber",
    name: "Neon Cyber",
    directive:
      "neon cyberpunk, cool blue and magenta lighting, rain-slick streets, futuristic and electric",
    mood: "electric",
    colors: ["#0b1026", "#1b9aaa", "#e83e8c"],
  },
  {
    id: "soft-doc",
    name: "Soft Documentary",
    directive: "clean documentary, soft natural daylight, realistic, balanced and calm",
    mood: "calm",
    colors: ["#3d5a80", "#9fb3c8", "#eef1f4"],
  },
  {
    id: "mystery-dark",
    name: "Dark Mystery",
    directive: "dark mystery, low-key lighting, drifting fog, eerie and ominous",
    mood: "ominous",
    colors: ["#0a0f1e", "#1f2a44", "#5b6b8c"],
  },
  {
    id: "vibrant-pop",
    name: "Vibrant Pop",
    directive: "vibrant, bright saturated colors, punchy high-energy, upbeat",
    mood: "upbeat",
    colors: ["#ff5964", "#ffb400", "#38b000"],
  },
];

/** A CSS gradient for a preset's swatch. */
export function presetGradient(p: StylePreset): string {
  return `linear-gradient(135deg, ${p.colors[0]} 0%, ${p.colors[1]} 55%, ${p.colors[2]} 100%)`;
}
