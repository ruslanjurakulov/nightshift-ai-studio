/**
 * The editor's cross-fade styles and text looks: `t.editor.looks`. Own file so
 * the main dictionaries only gain one line. Plain statements of what each
 * choice does; nothing about how good the result is.
 */
export const looksEn = {
  /** Cross-fade styles (modules/timeline.py XFADE_STYLES). */
  styleLegend: "Blend style",
  styleHint:
    "How the previous clip turns into this one. The preview shows one clip at a time and does not play the blend; the exported video does.",
  styleChosen: "Blend style: {name}.",
  styles: {
    fade: "Fade",
    dissolve: "Grainy dissolve",
    fadeblack: "Through black",
    fadewhite: "Through white",
    wipeleft: "Wipe left",
    wiperight: "Wipe right",
    slideleft: "Slide left",
    slideright: "Slide right",
    slideup: "Slide up",
    slidedown: "Slide down",
    circleopen: "Circle opens",
    circleclose: "Circle closes",
    radial: "Radial sweep",
    zoomin: "Zoom in",
  },
  /** Text looks (samples/text_looks.json). */
  lookLegend: "Text look",
  lookHint:
    "A look sets the font, size, colour, outline, shadow, box and position of this text in one step. Change any of them afterwards. The outline, shadow and box are drawn in the exported video; the preview approximates them.",
  lookSample: "Aa",
  looks: {
    title: "Title",
    lower_third: "Lower third",
    caption: "Bold caption",
    subtitle: "Subtitle",
    outline: "Outlined",
    shadow: "Shadow",
    label: "Label",
    highlight: "Highlight",
  },
  lookNone: "Custom",
  lookCurrent: "Current look: {name}.",
};
