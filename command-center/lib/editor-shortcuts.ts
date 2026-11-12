/**
 * The editor's keyboard shortcuts as a pure decision: which action (if any) a
 * key press means, given what has focus. The DOM side (reading the event,
 * running the action) is components/editor/useEditorShortcuts.ts.
 *
 * Undo / redo / save stay where they were (TimelineEditor); they are listed in
 * the help (SHORTCUT_HELP) so a person finds every key in one place.
 */

export type ShortcutAction =
  | "play"
  | "split"
  | "remove"
  | "left"
  | "right"
  | "leftBig"
  | "rightBig"
  | "zoomIn"
  | "zoomOut"
  | "zoomFit"
  /** J / K / L: play backwards (faster on each press), stop, play forwards (faster on each press). */
  | "shuttleBack"
  | "shuttleStop"
  | "shuttleForward"
  /** I / O: the in and out marks at the playhead. */
  | "markIn"
  | "markOut"
  /** Q / W: ripple trim the clip under the playhead up to it (its start) or from it (its end). */
  | "rippleHead"
  | "rippleTail"
  /** Up / Down: the playhead to the previous / next cut. */
  | "prevEdit"
  | "nextEdit"
  /** ; lift and ' ripple delete (extract) between the marks; , insert the copied clip at the playhead. */
  | "lift"
  | "extract"
  | "insert"
  /** V, N, Y, U: the timeline's tool (trim, roll, slip, slide). */
  | "toolTrim"
  | "toolRoll"
  | "toolSlip"
  | "toolSlide";

/** What has focus: a text field keeps every key; a "control" keeps the keys it uses itself. */
export type FocusKind =
  | "text"
  /** A button, link or checkbox: Space and Enter are its own. */
  | "control"
  /** A radio, tab or menu item: Space and the arrows are its own. */
  | "choice"
  /** A range input or role=slider (the playhead, a trim handle, a colour slider): it owns EVERY key here, so none fires. */
  | "slider"
  | "other";

export interface KeyLike {
  key: string;
  /** The physical key (KeyS, Digit0 ...); used for S and 0 only on layouts whose `key` is not a Latin letter / digit. */
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}

const TEXT_INPUT_TYPES = new Set([
  "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local",
  "month", "time", "week", "color", "file",
]);
const SLIDER_INPUT_TYPES = new Set(["range"]);

/** Classify the focused element from its tag, input type, role and editability. */
export function focusKind(el: {
  tag?: string;
  inputType?: string;
  role?: string | null;
  editable?: boolean;
} | null): FocusKind {
  if (!el) return "other";
  const tag = (el.tag ?? "").toUpperCase();
  if (el.editable || tag === "TEXTAREA" || tag === "SELECT") return "text";
  if (tag === "INPUT") {
    const type = (el.inputType ?? "text").toLowerCase();
    if (SLIDER_INPUT_TYPES.has(type)) return "slider";
    if (type === "radio") return "choice";
    if (TEXT_INPUT_TYPES.has(type) || !type) return "text";
    return "control"; // checkbox, button, submit ...
  }
  const role = (el.role ?? "").toLowerCase();
  if (role === "slider") return "slider";
  if (role === "radio" || role === "tab" || role === "menuitem") return "choice";
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY" || role === "button" || role === "checkbox" || role === "switch")
    return "control";
  return "other";
}

/**
 * The action for a key press, or null. Never fires with Ctrl / Cmd / Alt held
 * (the browser's and the editor's own combos), in a text field, after another
 * handler used the key, or when the key belongs to the focused control: Space
 * and Enter press a button, the arrows move a slider or a radio group.
 */
export function resolveShortcut(e: KeyLike, focus: FocusKind): ShortcutAction | null {
  if (e.defaultPrevented) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (focus === "text" || focus === "slider") return null;
  const key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const owned = focus === "control" || focus === "choice";
  if (key === " " || key === "Spacebar") return owned || e.repeat ? null : "play";
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (focus === "choice") return null;
    const base = key === "ArrowLeft" ? "left" : "right";
    return e.shiftKey ? (`${base}Big` as ShortcutAction) : base;
  }
  // S and 0 follow the physical key on layouts where `key` is not Latin (Cyrillic: "ы", AZERTY: "à").
  const isS = /^[a-z]$/i.test(key) ? lower === "s" : e.code === "KeyS";
  const isZero = /^[0-9]$/.test(key) ? key === "0" : (e.code === "Digit0" || e.code === "Numpad0") && key !== "Insert";
  if (e.repeat && (isS || key === "Delete" || key === "Backspace")) return null;
  if (isS) return "split";
  if (key === "Delete" || key === "Backspace") return "remove";
  if (key === "+" || key === "=") return "zoomIn";
  if (key === "-" || key === "_") return "zoomOut";
  if (isZero) return "zoomFit";
  if (key === "ArrowUp" || key === "ArrowDown") {
    // A radio group moves with Up / Down too; Shift is left for later (a range select).
    if (focus === "choice" || e.shiftKey) return null;
    return key === "ArrowUp" ? "prevEdit" : "nextEdit";
  }
  // The keys below act once per press: a held J must not run the shuttle up to its top speed by itself.
  if (e.repeat) return null;
  // ; ' and , by the character typed, Shift or not: on many layouts (German, French, Turkish ...) typing them needs
  // Shift, and the character is what the key means. On US keys Shift turns them into : " < , which are not mapped.
  if (e.key in PUNCTUATION_ACTIONS) return PUNCTUATION_ACTIONS[e.key];
  // Letters and the physical-key forms are left alone with Shift (kept for later variants).
  if (e.shiftKey) return null;
  const letter = latinLetter(e);
  if (letter && letter in LETTER_ACTIONS) return LETTER_ACTIONS[letter];
  const mark = punctuation(e);
  if (mark && mark in PUNCTUATION_ACTIONS) return PUNCTUATION_ACTIONS[mark];
  return null;
}

/** The single letters, by the Latin letter of the key (the physical key on other layouts). */
const LETTER_ACTIONS: Record<string, ShortcutAction> = {
  j: "shuttleBack",
  k: "shuttleStop",
  l: "shuttleForward",
  i: "markIn",
  o: "markOut",
  q: "rippleHead",
  w: "rippleTail",
  v: "toolTrim",
  n: "toolRoll",
  y: "toolSlip",
  u: "toolSlide",
};
const PUNCTUATION_ACTIONS: Record<string, ShortcutAction> = { ";": "lift", "'": "extract", ",": "insert" };
const PUNCTUATION_CODES: Record<string, string> = { Semicolon: ";", Quote: "'", Comma: "," };

/** The Latin letter a key press means: its `key` on a Latin layout, else its physical key (Cyrillic "о" is KeyJ). */
function latinLetter(e: KeyLike): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  if (e.key.length !== 1 || e.key.charCodeAt(0) < 128) return null;
  const m = /^Key([A-Z])$/.exec(e.code ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** ; ' or , by the key, or by the physical key on a layout where it types a letter (Cyrillic "ж", "э", "б"). */
function punctuation(e: KeyLike): string | null {
  if (e.key in PUNCTUATION_ACTIONS) return e.key;
  if (e.key.length !== 1 || e.key.charCodeAt(0) < 128) return null;
  return PUNCTUATION_CODES[e.code ?? ""] ?? null;
}

/**
 * Ctrl / Cmd + K: split at the playhead (the "add edit" of other editors), the same action as S. Never in a text
 * field or on a slider, never with Alt or Shift, never a held-down repeat. It is also the app's command palette:
 * useEditorShortcuts takes it only while the timeline has focus, so everywhere else it still opens the palette.
 */
export function resolveModShortcut(e: KeyLike, focus: FocusKind): "split" | null {
  if (e.defaultPrevented || e.repeat) return null;
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  if (focus === "text" || focus === "slider") return null;
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : (e.code ?? "").replace(/^Key/, "").toLowerCase();
  return letter === "k" ? "split" : null;
}

/**
 * Alt + Left / Right: nudge the selected texts, sounds, overlays and shapes one frame (with Shift five), as other
 * editors do. Never in a text field (Alt + arrow moves by words there on a Mac) or on a slider, never with Ctrl /
 * Cmd, and not in a radio group (the arrows are its own).
 */
export function resolveNudgeShortcut(e: KeyLike, focus: FocusKind): { frames: number } | null {
  if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey) return null;
  if (focus === "text" || focus === "slider" || focus === "choice") return null;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return null;
  const n = e.shiftKey ? 5 : 1;
  return { frames: e.key === "ArrowLeft" ? -n : n };
}

/**
 * Ctrl / Cmd + Alt + V: paste attributes (the copied clip's look onto the selected clips, in a dialog that asks which
 * groups). Never in a text field or on a slider, never with Shift, never a held-down repeat; the physical key on a
 * layout whose V is not a Latin letter.
 */
export function resolvePasteAttributes(e: KeyLike, focus: FocusKind): boolean {
  if (e.defaultPrevented || e.repeat) return false;
  if (!(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey) return false;
  if (focus === "text" || focus === "slider") return false;
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : (e.code ?? "").replace(/^Key/, "").toLowerCase();
  return letter === "v";
}

/** The preview's shuttle: playing or not, and at which rate (negative = backwards). */
export interface Shuttle {
  playing: boolean;
  rate: number;
}
/** The fastest the shuttle goes either way. */
export const SHUTTLE_MAX = 8;

/**
 * J / K / L as other editors have them: L plays forwards, and each further L while it plays doubles the rate up to
 * {@link SHUTTLE_MAX}; J does the same backwards; K stops. Turning round (J while playing forwards) starts again
 * at 1x the other way.
 */
export function nextShuttle(now: Shuttle, key: "shuttleBack" | "shuttleStop" | "shuttleForward"): Shuttle {
  if (key === "shuttleStop") return { playing: false, rate: 1 };
  const dir = key === "shuttleForward" ? 1 : -1;
  if (!now.playing || Math.sign(now.rate) !== dir) return { playing: true, rate: dir };
  return { playing: true, rate: dir * Math.min(SHUTTLE_MAX, Math.abs(now.rate) * 2) };
}

/** The clip clipboard: Ctrl / Cmd + D, C or V on the editor (never in a text field or on a slider, never
 *  with Alt or Shift, never a held-down repeat). Copy also stays the browser's while some text on the page
 *  is selected (`textSelected`): a person copying words must get the words. */
export type ClipShortcut = "duplicate" | "copy" | "paste";
export function resolveClipShortcut(
  e: KeyLike,
  focus: FocusKind,
  textSelected = false,
): ClipShortcut | null {
  if (e.defaultPrevented || e.repeat) return null;
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  if (focus === "text" || focus === "slider") return null;
  // The physical key on layouts whose `key` is not a Latin letter (Cyrillic: "в", "с", "м").
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : (e.code ?? "").replace(/^Key/, "").toLowerCase();
  if (letter === "d") return "duplicate";
  if (letter === "c") return textSelected ? null : "copy";
  if (letter === "v") return "paste";
  return null;
}

/** One row of the shortcuts help. `keys` are literal key names; `labelKey` names the dictionary entry. */
export interface ShortcutHelpRow {
  action: ShortcutAction | ClipShortcut | "splitMod" | "undo" | "redo" | "save" | "multiSelect" | "nudgeSel" | "nudgeSelBig" | "pasteAttributes";
  keys: string[][];
}

export const SHORTCUT_HELP: readonly ShortcutHelpRow[] = [
  { action: "play", keys: [["Space"]] },
  { action: "split", keys: [["S"]] },
  { action: "splitMod", keys: [["Ctrl", "K"]] },
  { action: "remove", keys: [["Delete"], ["Backspace"]] },
  { action: "left", keys: [["←"], ["→"]] },
  { action: "leftBig", keys: [["Shift", "←"], ["Shift", "→"]] },
  { action: "zoomIn", keys: [["+"], ["-"]] },
  { action: "zoomFit", keys: [["0"]] },
  { action: "shuttleBack", keys: [["J"]] },
  { action: "shuttleStop", keys: [["K"]] },
  { action: "shuttleForward", keys: [["L"]] },
  { action: "prevEdit", keys: [["↑"], ["↓"]] },
  { action: "markIn", keys: [["I"]] },
  { action: "markOut", keys: [["O"]] },
  { action: "extract", keys: [["'"]] },
  { action: "lift", keys: [[";"]] },
  { action: "insert", keys: [[","]] },
  { action: "rippleHead", keys: [["Q"]] },
  { action: "rippleTail", keys: [["W"]] },
  { action: "toolTrim", keys: [["V"]] },
  { action: "toolRoll", keys: [["N"]] },
  { action: "toolSlip", keys: [["Y"]] },
  { action: "toolSlide", keys: [["U"]] },
  { action: "duplicate", keys: [["Ctrl", "D"]] },
  { action: "copy", keys: [["Ctrl", "C"]] },
  { action: "paste", keys: [["Ctrl", "V"]] },
  { action: "multiSelect", keys: [["Shift", "Click"], ["Ctrl", "Click"]] },
  { action: "nudgeSel", keys: [["Alt", "←"], ["Alt", "→"]] },
  { action: "nudgeSelBig", keys: [["Alt", "Shift", "←"], ["Alt", "Shift", "→"]] },
  { action: "pasteAttributes", keys: [["Ctrl", "Alt", "V"]] },
  { action: "undo", keys: [["Ctrl", "Z"]] },
  { action: "redo", keys: [["Ctrl", "Shift", "Z"]] },
  { action: "save", keys: [["Ctrl", "S"]] },
];
