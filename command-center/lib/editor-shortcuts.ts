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
  | "zoomFit";

/** What has focus: a text field keeps every key; a "control" keeps the keys it uses itself. */
export type FocusKind = "text" | "control" | "slider" | "other";

export interface KeyLike {
  key: string;
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
const SLIDER_INPUT_TYPES = new Set(["range", "radio"]);

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
    if (TEXT_INPUT_TYPES.has(type) || !type) return "text";
    return "control"; // checkbox, button, submit ...
  }
  const role = (el.role ?? "").toLowerCase();
  if (role === "slider" || role === "radio" || role === "tab" || role === "menuitem") return "slider";
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
  if (focus === "text") return null;
  const key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const owned = focus === "control" || focus === "slider";
  if (key === " " || key === "Spacebar") return owned || e.repeat ? null : "play";
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (focus === "slider") return null;
    const base = key === "ArrowLeft" ? "left" : "right";
    return e.shiftKey ? (`${base}Big` as ShortcutAction) : base;
  }
  if (e.repeat && (lower === "s" || key === "Delete" || key === "Backspace")) return null;
  if (lower === "s") return "split";
  if (key === "Delete" || key === "Backspace") return "remove";
  if (key === "+" || key === "=") return "zoomIn";
  if (key === "-" || key === "_") return "zoomOut";
  if (key === "0") return "zoomFit";
  return null;
}

/** One row of the shortcuts help. `keys` are literal key names; `labelKey` names the dictionary entry. */
export interface ShortcutHelpRow {
  action: ShortcutAction | "undo" | "redo" | "save";
  keys: string[][];
}

export const SHORTCUT_HELP: readonly ShortcutHelpRow[] = [
  { action: "play", keys: [["Space"]] },
  { action: "split", keys: [["S"]] },
  { action: "remove", keys: [["Delete"], ["Backspace"]] },
  { action: "left", keys: [["←"], ["→"]] },
  { action: "leftBig", keys: [["Shift", "←"], ["Shift", "→"]] },
  { action: "zoomIn", keys: [["+"], ["-"]] },
  { action: "zoomFit", keys: [["0"]] },
  { action: "undo", keys: [["Ctrl", "Z"]] },
  { action: "redo", keys: [["Ctrl", "Shift", "Z"]] },
  { action: "save", keys: [["Ctrl", "S"]] },
];
