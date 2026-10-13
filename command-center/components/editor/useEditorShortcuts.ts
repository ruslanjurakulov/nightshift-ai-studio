"use client";

import { useEffect, useRef } from "react";
import {
  canSplit,
  clipAt,
  removeClip,
  removeSound,
  removeText,
  splitClip,
  type EditorModel,
} from "@/lib/editor";
import { removeOverlay } from "@/lib/editorOverlay";
import { focusKind, resolveShortcut } from "@/lib/editor-shortcuts";
import { nudgePlayhead } from "@/lib/editor-timeline-view";
import type { Selection } from "./TimelineStrip";
import type { TimelineView } from "./useTimelineView";

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
  view: TimelineView;
}) {
  const ref = useRef(p);
  ref.current = p;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      // While any modal is open (the shortcuts help, a confirm) the page behind is inert, even if focus slipped to <body>.
      if (document.querySelector('[aria-modal="true"]')) return;
      // Only the editor and an idle page (focus on <body>) get these keys; the app's own header, menus and links keep theirs.
      const idle = t === document.body || t === document.documentElement;
      if (!idle && !(t instanceof Element && t.closest("[data-editor-root]"))) return;
      const el = t instanceof HTMLElement ? t : null;
      const action = resolveShortcut(
        { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, defaultPrevented: e.defaultPrevented },
        focusKind(
          el && {
            tag: el.tagName,
            inputType: el instanceof HTMLInputElement ? el.type : undefined,
            role: el.getAttribute("role"),
            editable: el.isContentEditable,
          },
        ),
      );
      if (!action) return;
      const s = ref.current;
      const fps = s.model.fps;
      switch (action) {
        case "play":
          s.togglePlay();
          break;
        case "split": {
          // The clip under the playhead is what a cut means; the selection (often a stale first clip) is only the fallback.
          const picked =
            clipAt(s.model, s.playhead)?.clip.id ?? (s.selected?.kind === "clip" ? s.selected.id : null);
          if (!picked || !canSplit(s.model, picked, s.playhead)) return;
          const out = splitClip(s.model, picked, s.playhead);
          if (out) s.apply(out.model);
          break;
        }
        case "remove": {
          const sel = s.selected;
          if (!sel) return;
          const next =
            sel.kind === "clip"
              ? removeClip(s.model, sel.id)
              : sel.kind === "text"
                ? removeText(s.model, sel.id)
                : sel.kind === "overlay"
                  ? removeOverlay(s.model, sel.id)
                  : removeSound(s.model, sel.id);
          if (next === s.model) return;
          s.apply(next);
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
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
