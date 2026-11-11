/**
 * The editor's parity batch 2b: the effects pack and entrance / exit animations on a video clip, "apply to all
 * cuts" and beat markers (`t.editor.parity2b`). English is the source: ru.ts and uz.ts are typed
 * `Parity2bDictionary`. The ru and uz sentences are drafts: have a native speaker read them.
 */
export const parity2bEn = {
  fx: {
    title: "Effects",
    names: { glitch: "Glitch", shake: "Shake", rgb_split: "RGB split", flash: "Flash" },
    value: "{v}",
    hint: "Each effect is 0 (off) to 100. Glitch flickers in short bursts, flash pulses brighter, shake moves the picture inside the frame.",
    previewNote: "The preview does not draw these effects; the export does.",
    largeXfade: "In a frame above 1440p a cross-faded clip takes one effect (more would run the export out of memory).",
  },
  anim: {
    title: "Animation",
    inLegend: "Entrance",
    outLegend: "Exit",
    none: "None",
    names: {
      fade: "Fade",
      "slide-up": "Slide up",
      "slide-down": "Slide down",
      "slide-left": "Slide left",
      "slide-right": "Slide right",
      zoom: "Zoom",
    },
    length: "Length",
    value: "{v} s",
    hint: "A slide moves the whole picture in from the frame's edge (or out to it) over black; zoom grows it from 60 % (or shrinks it). Each lasts at most half the clip.",
    fadeSide: "This side already fades from black. Set its fade to 0 to animate it instead.",
    tooShort: "This clip is too short for an animation (it needs at least 0.2 s).",
    previewNote: "The preview does not draw the animation; the export does.",
  },
  budget: "Effects and animations would make the video take about {work} s to export, but a {length} s video is allowed {allowed} s. This change was not made.",
  transitionAll: {
    button: "Apply this cross-fade to all cuts",
    done: { one: "{n} cut now cross-fades like this one.", few: "{n} cuts now cross-fade like this one.", many: "{n} cuts now cross-fade like this one." },
    none: "No other cut has room for this cross-fade.",
  },
  beats: {
    title: "Beats",
    find: "Find beats",
    working: "Listening for beats…",
    found: { one: "{n} beat found. It shows on the timeline, and clip edges snap to it.", few: "{n} beats found. They show on the timeline, and clip edges snap to them.", many: "{n} beats found. They show on the timeline, and clip edges snap to them." },
    none: "No clear beat in this sound.",
    hide: "Hide beats",
    hint: "Listens to this sound in your browser and marks where the beats fall. Nothing is saved with the project.",
    too_large: "This file is too long or too big to listen to in the browser.",
    unavailable: "The browser could not read this file's sound. Try again later.",
    busy: "Another file is being listened to, or too many were just now. Try again in a minute.",
    no_sound: "This file has no sound to listen to.",
    marker: "Beat",
  },
  settledFx: "Clip {n} keeps only its strongest effect: in a frame above 1440p a cross-faded clip takes one.",
};

export type Parity2bDictionary = typeof parity2bEn;
