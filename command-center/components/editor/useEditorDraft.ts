"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorAsset, TimelineDoc } from "@/lib/editor";
import {
  DRAFT_DEBOUNCE_MS,
  allowDraftWrites,
  clearDraft,
  clearOtherDrafts,
  hasStaleDraft,
  purgeExpiredDrafts,
  readDraft,
  writeDraft,
  type Draft,
} from "@/lib/editor-draft";

/** What the editor shows about a draft found when the project was opened. */
export type Resume =
  | { kind: "none" }
  /** A draft based on this very revision that differs from it: offer it back. */
  | { kind: "restore"; draft: Draft }
  /** A draft based on an older revision: the project moved on, it is never applied. */
  | { kind: "stale" }
  /** A draft naming files that are no longer in the library. */
  | { kind: "unusable" };

/** Is the in-progress document being kept on this device? null: nothing to keep. */
export type Kept = "kept" | "off" | null;

const NONE: Resume = { kind: "none" };

const assetIdsOf = (doc: TimelineDoc): string[] => [
  ...new Set(
    doc.tracks.flatMap((t) =>
      t.clips.flatMap((c) =>
        typeof c.asset_id === "string" ? [c.asset_id] : [],
      ),
    ),
  ),
];

/**
 * Local draft autosave and resume for the editor. Keeps the in-progress
 * document in this browser (debounced), offers it back on the next open when
 * it is based on the revision that is still current, and never applies a draft
 * on its own. Does nothing without a user id. Save stays explicit.
 */
export function useEditorDraft(p: {
  userId: string;
  projectId: string;
  /** The revision the page was opened at: drafts are matched against it. */
  initialRev: number;
  /** The revision the editor holds now: drafts are written against it. */
  rev: number;
  dirty: boolean;
  /** `JSON.stringify(toDoc(model))` of the document being edited. */
  currentJson: string;
  title: string;
  /** The saved document and title as the page was opened, to see whether a draft differs. */
  saved: string;
  savedTitle: string;
  resolveAsset: (id: string) => EditorAsset | undefined;
  onRestore: (draft: Draft, assets: Record<string, EditorAsset>) => void;
}) {
  const { userId, projectId, initialRev, rev, dirty, currentJson, title } = p;
  const [resume, setResume] = useState<Resume>(NONE);
  const [kept, setKept] = useState<Kept>(null);
  const wrote = useRef(false);
  const first = useRef({ saved: p.saved, savedTitle: p.savedTitle });
  const pending = resume.kind === "restore";

  const latest = useRef({ ...p, pending });
  useEffect(() => {
    latest.current = { ...p, pending };
  });

  // Opening the project: is there a draft to offer?
  useEffect(() => {
    if (!userId) return;
    allowDraftWrites();
    purgeExpiredDrafts();
    const d = readDraft(userId, projectId, initialRev);
    if (d) {
      const same =
        JSON.stringify(d.doc) === first.current.saved &&
        d.title.trim() === first.current.savedTitle;
      if (same) {
        clearDraft(userId, projectId, initialRev);
      } else if (assetIdsOf(d.doc).every((id) => latest.current.resolveAsset(id))) {
        setResume({ kind: "restore", draft: d });
      } else {
        clearDraft(userId, projectId, initialRev);
        setResume({ kind: "unusable" });
      }
    } else if (hasStaleDraft(userId, projectId, initialRev)) {
      setResume({ kind: "stale" });
    }
  }, [userId, projectId, initialRev]);

  // A save moved the project to a new revision: older drafts are history now.
  useEffect(() => {
    if (!userId || rev === initialRev) return;
    clearOtherDrafts(userId, projectId, rev);
    setResume(NONE);
  }, [userId, projectId, initialRev, rev]);

  const write = useCallback(() => {
    const l = latest.current;
    if (!l.userId) return;
    let doc: TimelineDoc;
    try {
      doc = JSON.parse(l.currentJson) as TimelineDoc;
    } catch {
      return;
    }
    const out = writeDraft(l.userId, l.projectId, l.rev, {
      title: l.title,
      doc,
    });
    if (out === "ok") wrote.current = true;
    setKept(out === "ok" ? "kept" : "off");
  }, []);

  // Debounced autosave; a clean document needs no draft. While a found draft is
  // waiting for an answer nothing is written over it.
  useEffect(() => {
    if (!userId) return;
    if (!dirty) {
      if (wrote.current) {
        wrote.current = false;
        clearDraft(userId, projectId, rev);
      }
      setKept(null);
      return;
    }
    if (pending) return;
    const id = setTimeout(write, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [userId, projectId, rev, dirty, currentJson, title, pending, write]);

  // The tab is hidden or going away, or the editor is closing: write now, not in 1.5 s.
  useEffect(() => {
    const flush = () => {
      const l = latest.current;
      if (l.userId && l.dirty && !l.pending) write();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [write]);

  const restore = useCallback(() => {
    if (resume.kind !== "restore") return;
    const assets: Record<string, EditorAsset> = {};
    for (const id of assetIdsOf(resume.draft.doc)) {
      const a = latest.current.resolveAsset(id);
      if (a) assets[id] = a;
    }
    setResume(NONE);
    p.onRestore(resume.draft, assets);
  }, [resume, p]);

  const discard = useCallback(() => {
    if (userId) clearOtherDrafts(userId, projectId, null);
    wrote.current = false;
    setResume(NONE);
    setKept(null);
  }, [userId, projectId]);

  return { resume, kept, restore, discard };
}
