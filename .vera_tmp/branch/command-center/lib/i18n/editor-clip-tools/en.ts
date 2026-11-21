/**
 * The editor's clip tools added for parity with phone editors: the export frame rate, a clip's own
 * volume, "detach audio", and duplicate / copy / paste of a clip (`t.editor.clipTools`). Own file so
 * the main dictionaries only gain one line. English is the source: ru.ts and uz.ts are typed
 * `ClipToolsDictionary`, so they must carry exactly these keys. The ru and uz sentences are drafts:
 * have a native speaker read them.
 */
export const clipToolsEn = {
  fps: {
    legend: "Frame rate",
    value: "{fps} fps",
    hint: "Frames per second of the whole video. 60 is smoother for fast motion and takes about twice as long to export; 24 and 25 look like cinema and TV.",
    other: "This project is at {fps} frames per second, which is not on this list. It still exports at that rate.",
  },
  volume: {
    label: "Volume",
    value: "{pct}%",
    hint: "0% is silent, 100% is the sound as it was recorded, 200% is about twice as loud. Untick the sound above to mute the clip.",
  },
  detach: {
    button: "Detach audio",
    done: "The clip's sound is now a sound of its own. Move, trim or delete it like any sound; the video clip is silent.",
    no_sound: "Turn on the clip's sound first.",
    not_video: "A photo has no sound to detach.",
    retimed: "Only a clip at normal speed, played forwards, can give its sound away: a sound has no speed or direction.",
    sounds_full: "This project already has {max} sounds. Delete one to detach this one.",
  },
  waveVideo: "The wave of a video's sound is not drawn.",
  settledSpeed: "Clip {n} now plays at {max}×: faster, it would take longer to export than a video this long is allowed.",
  renderBudgetFast: "Clips played faster than 1× would take about {work} s to export, but a {length} s video is allowed {allowed} s. Lower their speed or make the video longer.",
  clipboard: {
    group: "Copy this clip",
    duplicate: "Duplicate",
    copy: "Copy",
    paste: "Paste after this clip",
    copied: "Clip copied. Select a clip and paste the copy after it.",
    full: "The picture already has {max} clips.",
    hint: "The copy keeps every setting of the clip and follows the clip before it with a cut.",
    scDuplicate: "Duplicate the selected clip",
    scCopy: "Copy the selected clip",
    scPaste: "Paste the copied clip after the selected one",
  },
};

export type ClipToolsDictionary = typeof clipToolsEn;
