import { parseMediaId, type MediaUpload, type UploadStatus } from "@/lib/media";

/**
 * Dismissing a refused or expired upload card.
 *
 * The upload ledger (media_uploads, migration 0038) is read-only for members:
 * no delete, no update, no function that removes a row, and the owner decides
 * what the database lets a member do. So a dismissal is a HIDE, kept on the
 * person who dismissed it: a short list of ticket ids in their own auth
 * user_metadata. It needs no table, no policy and no service key; it follows
 * the person across devices and reloads; and it removes nothing from the
 * ledger, so the audit trail and the quota maths are exactly as before.
 *
 * What it is not: it is not shared (a teammate still sees the card until they
 * dismiss it too) and it does not free any space (a refused upload holds none).
 *
 * The list rides inside the session token, so it is kept short: the library
 * shows the newest twenty unfinished tickets, and a person dismissing more
 * than DISMISS_MAX cards without a new one arriving in between is not a case
 * worth a larger token on every request.
 */

export const DISMISS_META_KEY = "media_dismissed_uploads";
export const DISMISS_MAX = 40;

/** Only a ticket that ended badly can go; one still on its way is never hidden. */
const DISMISSABLE: readonly UploadStatus[] = ["rejected", "expired"];

export function isDismissableStatus(status: unknown): boolean {
  return typeof status === "string" && (DISMISSABLE as readonly string[]).includes(status);
}

export function isDismissable(u: Pick<MediaUpload, "status">): boolean {
  return isDismissableStatus(u.status);
}

/**
 * The ids a person has dismissed, from their user_metadata. The person can
 * write any value into their own metadata, so anything that is not a plain
 * list of canonical ids is dropped, and the list is capped.
 */
export function parseDismissed(meta: unknown): string[] {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
  const raw = (meta as Record<string, unknown>)[DISMISS_META_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const id = parseMediaId(v);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= DISMISS_MAX) break;
  }
  return out;
}

/** The list after dismissing `id`: newest first, no repeats, the oldest fall off the end. */
export function withDismissed(list: readonly string[], id: string): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, DISMISS_MAX);
}

/** Hide the dismissed cards. Only cards that ended badly are ever hidden. */
export function withoutDismissed(uploads: readonly MediaUpload[], dismissed: ReadonlySet<string>): MediaUpload[] {
  if (dismissed.size === 0) return [...uploads];
  return uploads.filter((u) => !(dismissed.has(u.id) && isDismissable(u)));
}
