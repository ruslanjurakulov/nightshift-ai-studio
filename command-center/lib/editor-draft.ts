import {
  allowDraftWrites,
  clearAllEditorDrafts,
  DRAFT_PREFIX,
  draftWritesBlocked,
  keys,
  remove,
  store,
} from "@/lib/editor-draft-store";
import { MAX_DOC_BYTES, validateTimeline, type TimelineDoc } from "@/lib/editor";

/**
 * A local draft of the editor document (the browser's own memory, nothing is
 * sent anywhere). Save stays explicit and export stays blocked while unsaved:
 * a draft only lets a crash, a closed tab or an expired session not cost the
 * person their edits.
 *
 * Isolation is the key requirement. A draft is stored under
 * `userId + projectId + base revision`, and the same three values are stored
 * inside it and checked again on read, so a draft written by one account is
 * never offered to another on the same browser, a draft of project X never to
 * project Y, and a draft based on an older revision never as if it were current.
 *
 * Every storage access is wrapped: with storage blocked, full or throwing, each
 * function degrades to "no draft" and the editor works exactly as before.
 */

/** How long the editor waits after the last change before writing a draft. */
export const DRAFT_DEBOUNCE_MS = 1500;
/** A draft nobody came back to is removed after this long. */
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface Draft {
  /** When it was written (ms since epoch). */
  savedAt: number;
  title: string;
  doc: TimelineDoc;
}

export type WriteResult = "ok" | "unavailable" | "too_big" | "invalid";

const part = (v: string | number) => encodeURIComponent(String(v));

export function draftKey(userId: string, projectId: string, rev: number): string {
  return `${DRAFT_PREFIX}:${part(userId)}:${part(projectId)}:${part(rev)}`;
}

const projectPrefix = (userId: string, projectId: string) =>
  `${DRAFT_PREFIX}:${part(userId)}:${part(projectId)}:`;

const usable = (userId: string, projectId: string, rev: number) =>
  userId.length > 0 && projectId.length > 0 && Number.isInteger(rev) && rev >= 0;

const byteLength = (text: string): number => {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
};

/** Writes the draft for this user, project and base revision. Never throws. */
export function writeDraft(
  userId: string,
  projectId: string,
  rev: number,
  draft: { title: string; doc: TimelineDoc },
  now: number = Date.now(),
): WriteResult {
  if (!usable(userId, projectId, rev)) return "invalid";
  const s = draftWritesBlocked() ? null : store();
  if (!s) return "unavailable";
  try {
    const text = JSON.stringify({
      v: 1,
      u: userId,
      p: projectId,
      r: rev,
      savedAt: now,
      title: draft.title,
      doc: draft.doc,
    });
    // The server refuses a document over MAX_DOC_BYTES, so a larger draft could never be saved anyway.
    if (byteLength(text) > MAX_DOC_BYTES) return "too_big";
    s.setItem(draftKey(userId, projectId, rev), text);
    return "ok";
  } catch {
    return "unavailable";
  }
}

/** The draft for exactly this user, project and revision, or null. Corrupt or expired drafts are removed. */
export function readDraft(
  userId: string,
  projectId: string,
  rev: number,
  now: number = Date.now(),
): Draft | null {
  if (!usable(userId, projectId, rev)) return null;
  const s = store();
  if (!s) return null;
  const key = draftKey(userId, projectId, rev);
  try {
    const raw = s.getItem(key);
    if (raw === null) return null;
    const d = JSON.parse(raw) as Record<string, unknown> | null;
    const ok =
      d !== null &&
      typeof d === "object" &&
      d.v === 1 &&
      d.u === userId &&
      d.p === projectId &&
      d.r === rev &&
      typeof d.savedAt === "number" &&
      Number.isFinite(d.savedAt) &&
      now - d.savedAt <= DRAFT_TTL_MS &&
      typeof d.title === "string" &&
      d.doc !== null &&
      typeof d.doc === "object" &&
      validateTimeline(d.doc).length === 0;
    if (!ok) {
      remove(s, [key]);
      return null;
    }
    return {
      savedAt: d.savedAt as number,
      title: d.title as string,
      doc: d.doc as TimelineDoc,
    };
  } catch {
    remove(s, [key]);
    return null;
  }
}

/** True when this user has a draft of this project that was based on another revision. */
export function hasStaleDraft(
  userId: string,
  projectId: string,
  rev: number,
): boolean {
  if (!usable(userId, projectId, rev)) return false;
  const s = store();
  if (!s) return false;
  const current = draftKey(userId, projectId, rev);
  return keys(s, projectPrefix(userId, projectId)).some((k) => k !== current);
}

export function clearDraft(userId: string, projectId: string, rev: number): void {
  if (!usable(userId, projectId, rev)) return;
  const s = store();
  if (s) remove(s, [draftKey(userId, projectId, rev)]);
}

/** Removes this user's drafts of this project that are based on any other revision (or all of them with `rev` null). */
export function clearOtherDrafts(
  userId: string,
  projectId: string,
  rev: number | null,
): void {
  if (!userId || !projectId) return;
  const s = store();
  if (!s) return;
  const keep = rev === null ? null : draftKey(userId, projectId, rev);
  remove(
    s,
    keys(s, projectPrefix(userId, projectId)).filter((k) => k !== keep),
  );
}

/** Removes drafts nobody came back to, whoever wrote them. */
export function purgeExpiredDrafts(now: number = Date.now()): void {
  const s = store();
  if (!s) return;
  const old: string[] = [];
  for (const k of keys(s, `${DRAFT_PREFIX}:`)) {
    try {
      const d = JSON.parse(s.getItem(k) ?? "null") as { savedAt?: unknown } | null;
      if (
        !d ||
        typeof d.savedAt !== "number" ||
        now - d.savedAt > DRAFT_TTL_MS
      )
        old.push(k);
    } catch {
      old.push(k);
    }
  }
  remove(s, old);
}

export { allowDraftWrites, clearAllEditorDrafts, DRAFT_PREFIX };
