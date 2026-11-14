import type { LookId } from "./types";

/**
 * The five looks. Mirrored by modules/voice_explainer.LOOKS (ids only): a look the Python
 * side offers must exist here (tests/test_voice_explainer.py and tests/explainer.test.mts pin it).
 *
 * Fonts are stacks, not downloads: the render machine has no network guarantee, and a
 * missing web font would silently swap the face mid-video. Inter where it is installed,
 * DejaVu everywhere else (the worker image ships fonts-dejavu).
 */
export interface Look {
  id: LookId;
  background: string;
  /** A second background stop for the soft vertical gradient. */
  background2: string;
  panel: string;
  panelText: string;
  panelMuted: string;
  text: string;
  muted: string;
  accent: string;
  good: string;
  bad: string;
  /** Character body colours, picked by CastMember.color. */
  cast: [string, string, string, string];
  skin: string;
  /** Scenery: sky, far shapes, near shapes, warm lights. */
  sky: [string, string];
  far: string;
  near: string;
  light: string;
  /** How strongly lights glow (0..1.2): a daylit paper street must not shine like a neon one. */
  glow: number;
  /** Film grain strength (0..1); light looks show grain more, so they get less. */
  grain: number;
}

export const SANS = "Inter, 'Inter Display', 'DejaVu Sans', Arial, sans-serif";
export const SERIF = "'DejaVu Serif', Georgia, 'Times New Roman', serif";

export const LOOKS: Record<LookId, Look> = {
  dusk: {
    id: "dusk",
    background: "#16171b",
    background2: "#24252b",
    panel: "#1f2026",
    panelText: "#f2f1ee",
    panelMuted: "#8a8b93",
    text: "#ffffff",
    muted: "#9a9ba3",
    accent: "#35d07f",
    good: "#35d07f",
    bad: "#ff4d4f",
    cast: ["#e2533b", "#3d7be0", "#f2b134", "#9b59d0"],
    skin: "#1b1b1f",
    sky: ["#2c2236", "#8a5a5a"],
    far: "#3a2a33",
    near: "#5a3b3b",
    light: "#ffcf86",
    glow: 1,
    grain: 0.9,
  },
  midnight: {
    id: "midnight",
    background: "#0b1224",
    background2: "#15203d",
    panel: "#131c35",
    panelText: "#eef3ff",
    panelMuted: "#7f8bb0",
    text: "#ffffff",
    muted: "#8d9ac0",
    accent: "#5aa9ff",
    good: "#4ad6a3",
    bad: "#ff6b81",
    cast: ["#ff7a59", "#5aa9ff", "#ffd166", "#b388ff"],
    skin: "#0e1427",
    sky: ["#0b1430", "#2b3f7a"],
    far: "#16234a",
    near: "#22356b",
    light: "#9ec9ff",
    glow: 1,
    grain: 0.9,
  },
  golden: {
    id: "golden",
    background: "#2a1d12",
    background2: "#4a3018",
    panel: "#fff6e8",
    panelText: "#2a1d12",
    panelMuted: "#8f7a62",
    text: "#fff8ee",
    muted: "#e3c9a4",
    accent: "#ffb347",
    good: "#5fbf6a",
    bad: "#e8543f",
    cast: ["#d9543a", "#2f7fb5", "#3c9a5f", "#7a4fb0"],
    skin: "#2a1d12",
    sky: ["#f2994a", "#ffd194"],
    far: "#c0703a",
    near: "#8c4a26",
    light: "#fff1c1",
    glow: 0.7,
    grain: 0.7,
  },
  neon: {
    id: "neon",
    background: "#07060c",
    background2: "#15102a",
    panel: "#120f22",
    panelText: "#f7f3ff",
    panelMuted: "#8f84b8",
    text: "#ffffff",
    muted: "#a79dd0",
    accent: "#ff3fd1",
    good: "#29f0c4",
    bad: "#ff4d6d",
    cast: ["#ff3fd1", "#29f0c4", "#ffd23f", "#7c5cff"],
    skin: "#07060c",
    sky: ["#1a0b3a", "#5b1a6e"],
    far: "#2a1250",
    near: "#3d1670",
    light: "#29f0c4",
    glow: 1.2,
    grain: 1,
  },
  paper: {
    id: "paper",
    background: "#f3efe6",
    background2: "#e8e2d4",
    panel: "#ffffff",
    panelText: "#1d1b18",
    panelMuted: "#8b857a",
    text: "#1d1b18",
    muted: "#8b857a",
    accent: "#e2533b",
    good: "#2e9e5b",
    bad: "#e2533b",
    cast: ["#e2533b", "#3a6fd8", "#e8a628", "#3c9a5f"],
    skin: "#1d1b18",
    sky: ["#cfe3ea", "#f6efe0"],
    far: "#b9c8c2",
    near: "#8fa69c",
    light: "#ffe6a8",
    glow: 0.35,
    grain: 0.45,
  },
};

const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${c}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** a -> b by t (0..1), as #rrggbb. Scenery derives its in-between tones from the look instead of a second palette. */
export const mix = (a: string, b: string, t: number): string => {
  const [x, y] = [hex(a), hex(b)];
  const k = Math.max(0, Math.min(1, t));
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, "0")).join("")}`;
};

/** A colour with an alpha, as rgba(): for glows and shadows. */
export const alpha = (c: string, a: number): string => {
  const [r, g, b] = hex(c);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
};

export const LOOK_IDS = Object.keys(LOOKS) as LookId[];

/** The look, or a throw: an unknown id is a broken request, never "the default look" (CLAUDE.md rule 4). */
export const lookFor = (id: unknown): Look => {
  if (typeof id === "string" && Object.prototype.hasOwnProperty.call(LOOKS, id)) return LOOKS[id as LookId];
  throw new Error(`unknown look ${JSON.stringify(id)}: one of ${LOOK_IDS.join(", ")}`);
};
