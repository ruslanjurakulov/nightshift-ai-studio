import type { StyleBible } from "./types";

/** Mirrors modules/style_presets.DEFAULT_BIBLE. */
export const DEFAULT_STYLE: StyleBible = {
  heading_font: "Georgia, 'Times New Roman', serif",
  body_font: "'Helvetica Neue', Arial, sans-serif",
  palette: {
    background: "#101114",
    primary: "#e9e6df",
    accent: "#d4a54a",
    text: "#ffffff",
  },
  caption_style: "word_highlight",
  transition: "crossfade",
  preferred_recipes: [],
};

/** A complete style: any missing field falls back to the default. */
export const resolveStyle = (style?: StyleBible | null): StyleBible => ({
  ...DEFAULT_STYLE,
  ...(style ?? {}),
  palette: { ...DEFAULT_STYLE.palette, ...(style?.palette ?? {}) },
});
