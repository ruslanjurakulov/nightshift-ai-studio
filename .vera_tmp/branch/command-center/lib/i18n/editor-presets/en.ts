/**
 * The editor's export format picker: `t.editor.exportPreset`. Own file so the main
 * dictionaries only gain one line. The platform names are proper nouns and stay as
 * they are in every language; the lengths are this project's advice, not a platform's rule.
 */
export const exportPresetEn = {
  legend: "Export format",
  summary: "Export format: {name}",
  summaryCustom: "Export format: custom size",
  hint: "Sets the frame size and frame rate of the whole video. Save your changes, then export.",
  detail: "{w} × {h} px, {fps} frames per second",
  custom: "This project has a custom size ({w} × {h} px, {fps} frames per second). Choose a format to change it.",
  longForFormat: "This video is {length}. This format works best up to {max}. You can still export it.",
  names: {
    youtube_1080p: "YouTube wide 16:9, 1080p",
    youtube_720p: "Wide 16:9, 720p (smaller file)",
    vertical_1080p: "Shorts, Reels, TikTok 9:16",
    square_1080: "Square 1:1",
    feed_4x5_1080: "Feed portrait 4:5",
  },
};
