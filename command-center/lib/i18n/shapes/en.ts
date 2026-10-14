/**
 * The editor's shapes and stickers (arrow, circle, rectangle, star, label, line,
 * progress bar): `t.editor.shapes`. Own file so the main dictionaries only gain one
 * line. Plain statements about what each control does; nothing about the result.
 */
export const shapesEn = {
  add: "Add shape",
  addTitle: "Add a shape or sticker over the video",
  addConfirm: "Add to video",
  kindLegend: "Shape",
  kinds: {
    arrow: "Arrow",
    circle: "Circle",
    rect: "Rectangle",
    star: "Star",
    pill: "Label",
    line: "Line",
    progress: "Progress bar",
  },
  heading: "Shape {n}: {kind}",
  start: "Shown from (seconds)",
  end: "Shown until (seconds)",
  toPlayhead: "Start at the playhead",
  wholeVideo: "Fill the whole video",
  atClip: "Fill the clip at the playhead",
  colorLegend: "Colour",
  colorPicker: "Pick a colour",
  colorCode: "Colour code, like #FFD60A",
  colorBad: "Use a code of six digits or letters A to F after #, like #FFD60A.",
  swatches: {
    yellow: "Yellow",
    red: "Red",
    green: "Green",
    blue: "Blue",
    white: "White",
    black: "Black",
  },
  x: "Horizontal position",
  y: "Vertical position",
  size: "Size (share of the video width)",
  opacity: "Opacity",
  percent: "{v}%",
  numberLabel: "{name}, percent",
  outline: "Outline thickness (0 = solid)",
  aspect: "Width compared with height",
  aspectValue: "{v} to 1",
  dirLegend: "Points",
  dirs: { right: "Right", left: "Left", up: "Up", down: "Down" },
  thick: "Thickness (share of the video height)",
  text: "Label text",
  textHint:
    "Up to {max} characters of Latin or Cyrillic letters, digits and common punctuation. Emoji and other scripts cannot be drawn in the exported video, so they are not accepted.",
  textDropped: "Characters that cannot be drawn in the exported video (emoji, other scripts) were left out.",
  textEmpty: "A label needs at least one character, so the last text is kept.",
  readyLegend: "Ready labels",
  labels: {
    subscribe: "Subscribe",
    new: "New",
    link: "Link below",
    part2: "Part 2",
  },
  edgeLegend: "Edge of the video",
  edges: { bottom: "Bottom", top: "Top" },
  progressNote:
    "The bar is as wide as the video and fills from left to right across the time it is shown: empty on its first frame, full on its last. It can only fade in or out and does not move.",
  pillNote:
    "In the preview the label's width is an estimate; the exported file measures the real letters.",
  moveTitle: "Move to an end position",
  moveToggle: "Move while it is shown",
  moveEndX: "Ends at, left to right",
  moveEndY: "Ends at, top to bottom",
  moveEndW: "Ends at size",
  moveSame: "Same as the start",
  moveHint:
    "The shape moves in a straight line from the position and size above to these over the time it is shown. To fade it in or out use the entrance and exit.",
  layerHint: "Later shapes are drawn on top of earlier ones.",
  delete: "Delete shape",
  reset: "Reset position, size and opacity",
  track: "Shapes",
  clipLabel: "Shape {n}: {kind}, from {from} to {to}",
  handle:
    "Shape {n} in the preview. Arrow keys move it by 1%, Shift + arrow by 5%.",
  keysHint:
    "In the preview, select the shape's frame and use the arrow keys to move it, or drag it.",
  previewNote:
    "Shapes are drawn above pictures and below text. The preview is close to the export; the exported file is the reference.",
  pastEnd: "This shape starts after the video ends, so it will not appear.",
  cutEnd: "This shape runs past the end of the video; the rest is cut.",
  invisible: "Opacity is 0, so this shape will not appear.",
  shapesFull: "A project can have at most {max} shapes.",
  budgetMemory:
    "That shape does not fit: the export can draw only so much at this frame size (about {need} MB needed, {max} MB available). Make the other shapes smaller or remove one.",
  budgetTime:
    "That shape does not fit: the export would take about {work} s, but a {length} s video is allowed {allowed} s. Use fewer or smaller shapes, or make the video longer.",
  budgetUse:
    "The shapes use {pct}% of what the export can draw at this frame size. A shape stops growing at the limit.",
  settledNarrowed: "Shape {n} was made narrower so the export can still draw all the shapes.",
  settledRemoved:
    "Shape {n} was removed because the export could not draw all the shapes at this size. Undo brings it back.",
  layersFull:
    "Pictures and shapes together can fill at most {max} layers, so no more can be added.",
};
