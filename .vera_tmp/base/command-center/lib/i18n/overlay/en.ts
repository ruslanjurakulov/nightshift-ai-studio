/**
 * The editor's picture overlays (a picture or video laid over the video):
 * `t.editor.overlay`. Own file so the main dictionaries only gain one line.
 * Plain statements about what the control does; nothing about the result.
 */
export const overlayEn = {
  add: "Add overlay",
  addTitle: "Add a picture or video over the video",
  noFiles: "Your library has no pictures or videos yet. Upload one first.",
  pickerPictures: "Pictures",
  pickerVideos: "Videos",
  untitled: "Untitled",
  kindImage: "Picture",
  kindVideo: "Video",
  heading: "Overlay {n}",
  file: "{name} · {kind}",
  start: "Shown from (seconds)",
  end: "Shown until (seconds)",
  toPlayhead: "Start at the playhead",
  x: "Horizontal position",
  y: "Vertical position",
  size: "Size (share of the video width)",
  opacity: "Opacity",
  percent: "{v}%",
  numberLabel: "{name}, percent",
  reset: "Reset position, size and opacity",
  delete: "Delete overlay",
  forward: "Bring forward",
  backward: "Send backward",
  layer: "Layer {n} of {total}. Later layers are drawn on top.",
  track: "Overlays",
  clipLabel: "Overlay {n}: {name}, from {from} to {to}",
  handle:
    "Overlay {n} in the preview. Arrow keys move it by 1%, Shift + arrow by 5%.",
  keysHint:
    "In the preview, select the overlay's frame and use the arrow keys to move it, or drag it.",
  previewNote: "Overlays are drawn above the picture and below text.",
  videoNote:
    "A video overlay is silent, plays from its start and cannot be longer than the video.",
  pastEnd: "This overlay starts after the video ends, so it will not appear.",
  cutEnd: "This overlay runs past the end of the video; the rest is cut.",
  invisible: "Opacity is 0, so this overlay will not appear.",
  full: "A project can have at most {max} overlays.",
  videosFull: "A project can have at most {max} video overlays.",
  noPreview: "This file has no preview here. The export still uses it.",
};
