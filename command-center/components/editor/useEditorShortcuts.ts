"use client";

import { useEffect, useRef } from "react";
import {
  canSplit,
  clipAt,
  duplicateClip,
  insertClipCopy,
  nextEditPoint,
  removeClip,
  removeSound,
  removeText,
  splitClip,
  type EditorModel,
  type VideoClip,
} from "@/lib/editor";
import { removeOverlay } from "@/lib/editorOverlay";
import { removeShape } from "@/lib/editorShapeModel";
import {
  focusKind,
  resolveClipShortcut,
  resolveModShortcut,
  resolveNudgeShortcut,
  resolvePasteAttributes,
  resolveShortcut,
  type ShortcutAction,
} from "@/lib/editor-shortcuts";
import { nudgePlayhead } from "@/lib/editor-timeline-view";
import type { Selection } from "./TimelineStrip";
import type { TimelineView } from "./useTimelineView";

/** The keys of the editing core (J / K / L, I / O, Q / W, ; ' , and the tool letters): the editor runs them, the
 *  same functions its buttons call, so a key and its button can never do two different things. */
export type CoreAction = Exclude<
  ShortcutAction,
  "play" | "split" | "remove" | "left" | "right" | "leftBig" | "rightBig" | "zoomIn" | "zoomOut" | "zoomFit" | "prevEdit" | "nextEdit"
>;

/**
 * The editor's single-key shortcuts (Space, S, Delete, arrows, + / - / 0).
 * Which key means what, and when a key is left alone (a text field, a focused
 * button or slider, a dialog), is lib/editor-shortcuts.ts; this runs the
 * action on the editor's own state. Undo / redo / save live in TimelineEditor.
 */
export function useEditorShortcuts(p: {
  model: EditorModel;
  selected: Selection;
  playhead: number;
  total: number;
  togglePlay: () => void;
  setPlayhead: (t: number) => void;
  setPlaying: (on: boolean) => void;
  apply: (next: EditorModel) => void;
  /** A ripple edit of the picture (a clip deleted, pasted or duplicated): `apply` with sync lock. Default `apply`. */
  ripple?: (next: EditorModel) => void;
  /** Called after Delete removed an overlay: its frame is gone, so focus belongs on "Add overlay", not <body>. */
  onOverlayRemoved?: () => void;
  /** Called after Delete removed a shape: focus belongs on "Add shape", not <body>. */
  onShapeRemoved?: () => void;
  view: TimelineView;
  /** The editor's clip clipboard (Ctrl+C / Ctrl+V / Ctrl+D on a selected clip). */
  clipboard?: VideoClip | null;
  setClipboard?: (c: VideoClip) => void;
  /** Called with the id of a clip a paste or duplicate made: it becomes the selection. */
  onClipInserted?: (id: string) => void;
  /** Runs a key of the editing core (lib/editor-shortcuts.ts); without it those keys are left alone. */
  onCore?: (action: CoreAction) => void;
  /** Several items selected: Delete, Ctrl + C and Ctrl + V act on all of them. Each returns false when it does not
   *  apply (one item or none, nothing copied), and the single-item key does what it always did. */
  onRemoveMany?: () => boolean;
  onCopyMany?: () => boolean;
  onPasteMany?: () => boolean;
  /** Alt + Left / Right (Shift: five frames): nudge the selected texts, sounds, overlays and shapes; false when
   *  none is selected (the key is then left to the browser). */
  onNudge?: (frames: number) => boolean;
  /** Ctrl / Cmd + Alt + V: the paste-attributes dialog. */
  onPasteAttributes?: () => void;
}) {
  const ref = useRef(p);
  ref.current = p;

  useEffect(() => {
    /** The key, what has focus, or null when the editor must leave this key alone. */
    const read = (e: KeyboardEvent) => {
      const t = e.target;
      // While any modal is open (the shortcuts help, a confirm) the page behind is inert, even if focus slipped to <body>.
      if (document.querySelector('[aria-modal="true"]')) return null;
      // Only the editor and an idle page (focus on <body>) get these keys; the app's own header, menus and links keep theirs.
      const idle = t === document.body || t === document.documentElement;
      if (!idle && !(t instanceof Element && t.closest("[data-editor-root]"))) return null;
      const el = t instanceof HTMLElement ? t : null;
      const keyLike = { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, defaultPrevented: e.defaultPrevented };
      const focus = focusKind(
        el && {
          tag: el.tagName,
          inputType: el instanceof HTMLInputElement ? el.type : undefined,
          role: el.getAttribute("role"),
          editable: el.isContentEditable,
        },
      );
      return { keyLike, focus };
    };
    /** S and Ctrl / Cmd + K: the clip under the playhead is what a cut means; the selection (often a stale first
     *  clip) is only the fallback. */
    const split = () => {
      const s = ref.current;
      const picked =
        clipAt(s.model, s.playhead)?.clip.id ?? (s.selected?.kind === "clip" ? s.selected.id : null);
      if (!picked || !canSplit(s.model, picked, s.playhead)) return;
      const out = splitClip(s.model, picked, s.playhead);
      if (out) s.apply(out.model);
    };
    // Ctrl / Cmd + K is also the app's command palette (a listener on window too). It splits only while the timeline
    // (the strip, its tools and marks: [data-editor-timeline]) has focus, taken in the capture phase before the palette
    // sees it; anywhere else on the page, the editor's inspector and preview included, it still opens the palette.
    const onModKey = (e: KeyboardEvent) => {
      if (!(e.target instanceof Element && e.target.closest("[data-editor-timeline]"))) return;
      const r = read(e);
      if (!r || resolveModShortcut(r.keyLike, r.focus) !== "split") return;
      e.preventDefault();
      e.stopPropagation();
      split();
    };
    const onKey = (e: KeyboardEvent) => {
      const r = read(e);
      if (!r) return;
      const { keyLike, focus } = r;
      if (resolvePasteAttributes(keyLike, focus)) {
        if (!ref.current.onPasteAttributes) return;
        e.preventDefault();
        ref.current.onPasteAttributes();
        return;
      }
      const nudge = resolveNudgeShortcut(keyLike, focus);
      // Only with something to nudge: otherwise Alt + Left stays the browser's Back.
      if (nudge && ref.current.onNudge?.(nudge.frames)) {
        e.preventDefault();
        return;
      }
      const clipKey = resolveClipShortcut(keyLike, focus, Boolean(window.getSelection()?.toString()));
      if (clipKey) {
        const s = ref.current;
        // Several items selected (or a copy of several): the whole list is copied or pasted.
        if (clipKey === "copy" && s.onCopyMany?.()) return void e.preventDefault();
        if (clipKey === "paste" && s.onPasteMany?.()) return void e.preventDefault();
        const sel = s.selected?.kind === "clip" ? s.model.clips.find((c) => c.id === s.selected?.id) : undefined;
        if (!sel) return;            // nothing of the editor's is selected: the browser keeps its key
        e.preventDefault();
        if (clipKey === "copy") {
          s.setClipboard?.(sel);
          return;
        }
        const out =
          clipKey === "duplicate"
            ? duplicateClip(s.model, sel.id)
            : s.clipboard
              ? insertClipCopy(s.model, s.clipboard, sel.id)
              : null;
        if (!out) return;
        (s.ripple ?? s.apply)(out.model);
        s.onClipInserted?.(out.id);
        return;
      }
      const action = resolveShortcut(keyLike, focus);
      if (!action) return;
      const s = ref.current;
      const fps = s.model.fps;
      switch (action) {
        case "play":
          s.togglePlay();
          break;
        case "split":
          split();
          break;
        case "remove": {
          if (s.onRemoveMany?.()) break;
          const sel = s.selected;
          if (!sel) return;
          const next =
            sel.kind === "clip"
              ? removeClip(s.model, sel.id)
              : sel.kind === "text"
                ? removeText(s.model, sel.id)
                : sel.kind === "overlay"
                  ? removeOverlay(s.model, sel.id)
                  : sel.kind === "shape"
                    ? removeShape(s.model, sel.id)
                    : removeSound(s.model, sel.id);
          if (next === s.model) return;
          if (sel.kind === "overlay") s.onOverlayRemoved?.();
          if (sel.kind === "shape") s.onShapeRemoved?.();
          (sel.kind === "clip" ? (s.ripple ?? s.apply) : s.apply)(next);
          break;
        }
        case "left":
        case "right":
        case "leftBig":
        case "rightBig":
          s.setPlaying(false);
          s.setPlayhead(
            nudgePlayhead({
              playhead: s.playhead,
              dir: action.startsWith("left") ? -1 : 1,
              fps,
              total: s.total,
              big: action.endsWith("Big"),
            }),
          );
          break;
        case "zoomIn":
          s.view.zoomIn();
          break;
        case "zoomOut":
          s.view.zoomOut();
          break;
        case "zoomFit":
          s.view.fit();
          break;
        case "prevEdit":
        case "nextEdit": {
          const to = nextEditPoint(s.model, s.playhead, action === "nextEdit" ? 1 : -1);
          if (to === null) break;
          s.setPlaying(false);
          s.setPlayhead(Math.min(to, s.total));
          break;
        }
        default:
          if (!s.onCore) return;
          s.onCore(action);
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onModKey, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onModKey, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
