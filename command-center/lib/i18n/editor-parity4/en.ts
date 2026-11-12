/**
 * The editor's talking-head pack (`t.editor.parity4`): clean voice, mute or bleep words, a text's letter spacing,
 * italic and line alignment. English is the source: ru.ts and uz.ts are typed `Parity4Dictionary`. The ru and uz
 * sentences are drafts: have a native speaker read them.
 */
export const parity4En = {
  settledVoiceClip: "Clip {n}: clean voice was taken off its sound: with it the video would take longer to export than it is allowed.",
  settledVoiceSound: "Sound {n}: clean voice was taken off: with it the video would take longer to export than it is allowed.",
  voice: {
    toggle: "Clean voice",
    hint: "For speech: cuts rumble and hum, reduces background hiss and harsh “s” sounds, evens loud and quiet words, and sets the loudness to -16 LUFS. It includes noise reduction and even loudness, so those two switch off.",
    included: "Clean voice already includes this.",
    previewNote: "The preview plays the sound as it was recorded; the export applies clean voice.",
    renderTime:
      "Not offered here: with it the export would take about {work} s for a {length} s timeline, and {allowed} s is allowed. Turn something else off first.",
  },
  bleeps: {
    title: "Mute or bleep words",
    hint: "Press a word to silence it in the exported video, press it again to bring it back. A word's time is its caption's time shared out over the caption's words, so a bleep is as close as the caption's timing: move the caption's start or end if one misses.",
    modeLegend: "New bleeps",
    modes: { mute: "Silence", tone: "Beep" },
    wordAria: "{word}, {start} s",
    caption: "Caption {n}",
    more: "Show more captions",
    listHeading: "Bleeped: {n} of {max}",
    range: "{start}–{end} s",
    remove: "Remove",
    removeAria: "Remove the bleep at {start} s",
    modeAria: "Bleep at {start} s",
    none: "Nothing is bleeped yet.",
    full: "At most {max} bleeps in one video.",
    noRoom: "No room for a bleep there: it would run into the next one.",
    previewNote: "The preview goes quiet over each bleep; the beep itself is heard in the export.",
  },
  text: {
    title: "Text properties",
    tracking: "Letter spacing",
    trackingValue: "{v}",
    italic: "Italic",
    alignLegend: "Line alignment",
    alignAuto: "As placed",
    aligns: { left: "Left", center: "Centre", right: "Right" },
    alignHint: "How the lines of a text with several lines line up. One line stays where it is placed.",
    previewNote: "The preview's spacing is close to the export's, not exact.",
    emoji: "Emoji are not drawn yet: the export's fonts have none.",
  },
};

export type Parity4Dictionary = typeof parity4En;
