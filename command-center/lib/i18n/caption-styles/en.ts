/**
 * Animated caption styles: `t.captions.animated` (modules/caption_styles.py
 * STYLE_IDS). Own file so the main dictionaries only gain one line. Generic,
 * plain names; each note says what the style does, nothing about how good it is.
 */
export const captionStylesEn = {
  heading: "Animated style",
  hint: "Pick a ready-made style for all your captions. You can change its colours, size and position. It is free.",
  previewNote:
    "The preview only approximates the animation. The exported video shows the style exactly.",
  needCues: "Add a caption first. A style applies to the captions you already have.",
  plain: "Plain",
  plainNote: "No animation",
  sample: "Aa",
  current: "Style: {name}",
  reset: "Reset to the style's own look",
  tweaks: {
    color: "Text colour",
    highlight_color: "Highlight colour",
    size: "Size",
    y: "Position",
    yValue: "{n}% from the top",
  },
  styles: {
    karaoke: "Word by word",
    pop_in: "Bounce in",
    boxed: "Boxed",
    big_centre: "Big centre",
    lower_third: "Lower third",
    outlined: "Outlined",
    neon: "Neon glow",
    typewriter: "Typewriter",
    line_slide: "Slide up",
    clean: "Soft light",
  },
  notes: {
    karaoke: "Each word fills with the highlight colour as it is spoken",
    pop_in: "Each caption bounces in",
    boxed: "A dark box, with the current word on a coloured box",
    big_centre: "Large in the middle of the picture, one word lit at a time",
    lower_third: "A coloured block at the lower left that slides in",
    outlined: "Heavy letters with a thick coloured outline",
    neon: "Softly glowing letters",
    typewriter: "Letters appear one after another",
    line_slide: "Each caption slides up and fades in",
    clean: "Slim, light text with a soft shadow",
  },
};
