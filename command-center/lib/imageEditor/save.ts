import { cleanUploadName, parseMediaId } from "@/lib/media";

/**
 * Saving = the EXISTING upload path, nothing new: POST /api/media/uploads asks the database for a ticket (membership,
 * type allowlist, size cap, storage quota), PUT /api/media/uploads/<ticket> streams the flattened picture, and the
 * media worker re-checks, re-encodes and strips it like any other upload. The browser's output is untrusted input to
 * that worker. The original is never touched: a save is always a NEW library file.
 *
 * The ticket request also names the picture this is an edit of (`parent_asset_id`, migration 0128). That id is only a request: the route
 * ignores it while the editor flag is off, the database checks that it is a live image of the same organization and the worker re-checks
 * it when it registers the file. Without 0128 (or if the original was deleted meanwhile) the file is saved WITHOUT a link, never lost, and
 * is still tied to the original by its NAME (`<name>-edited.png`).
 */
export const SAVE_FORMATS = ["png", "jpeg"] as const;
export type SaveFormat = (typeof SAVE_FORMATS)[number];
export const SAVE_MIME: Record<SaveFormat, string> = { png: "image/png", jpeg: "image/jpeg" };
const EXT: Record<SaveFormat, string> = { png: "png", jpeg: "jpg" };
/** 0.92: visually clean, much smaller than a PNG of a photograph. */
export const JPEG_QUALITY = 0.92;

/** `holiday.photo.JPG` -> `holiday.photo-edited.png`. Only the file's last path segment is used; the server cleans it again. */
export function editedName(original: unknown, format: SaveFormat): string {
  // Only a picture extension is taken off (`v1.2` and `report.final` keep theirs), and BEFORE the name is cleaned: cleaning drops a leading
  // dot, so `.png` would otherwise become the stem "png". Cut by code points: a UTF-16 cut can halve an emoji, and a lone surrogate is a
  // body Postgres refuses.
  const last = String(original ?? "").split(/[\\/]/).pop() ?? "";
  const base = cleanUploadName(last.replace(PICTURE_EXT, "")).replace(/-edited$/, "");
  const stem = Array.from(base || "picture").slice(0, 120).join("");
  return `${stem}-edited.${EXT[format]}`;
}
const PICTURE_EXT = /\.(?:jpe?g|png|webp|gif|heic|heif|jfif|bmp|tiff?)$/i;

export const SAVE_ERRORS = [
  "unauthorized",
  "forbidden",
  "media_unavailable",
  "not_available",
  "unsupported_type",
  "extension_mismatch",
  "too_large",
  "too_many_uploads",
  "quota_exceeded",
  "server_full",
  "ticket_expired",
  "ticket_used",
  "empty",
  "network",
  "export_failed",
  "failed",
] as const;
export type SaveError = (typeof SAVE_ERRORS)[number];

/** Any word the upload routes answer maps to one we have a sentence for; the rest are "failed". */
export function saveErrorCode(word: unknown): SaveError {
  return typeof word === "string" && (SAVE_ERRORS as readonly string[]).includes(word) ? (word as SaveError) : "failed";
}

export type SaveResult = { ok: true; ticket: string; name: string } | { ok: false; error: SaveError; maxBytes?: number | null };

export interface SaveInput {
  orgId: string;
  blob: Blob;
  filename: string;
  mime: string;
  /** The library picture this edit was made from. Sent as a request only; an id that is not a uuid is not sent at all. */
  parentId?: string;
  fetchImpl?: typeof fetch;
}

/** Ticket, then the streamed PUT. Never throws: every failure is a SaveResult with a code. */
export async function uploadEdited(input: SaveInput): Promise<SaveResult> {
  const doFetch = input.fetchImpl ?? fetch;
  if (input.blob.size <= 0) return { ok: false, error: "empty" };
  const parent = parseMediaId(input.parentId);
  try {
    const res = await doFetch("/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: input.orgId,
        filename: input.filename,
        mime: input.mime,
        bytes: input.blob.size,
        ...(parent ? { parent_asset_id: parent } : {}),
      }),
    });
    const ticket = (await res.json().catch(() => ({}))) as { upload_url?: unknown; ticket?: unknown; error?: unknown; max_bytes?: unknown; name?: unknown };
    const id = parseMediaId(ticket.ticket);
    // The route builds this address from the ticket id; anything else (another path, a query, a host) is not ours to PUT to.
    if (!res.ok || !id || ticket.upload_url !== `/api/media/uploads/${id}`) {
      return { ok: false, error: saveErrorCode(res.ok ? "failed" : ticket.error), maxBytes: typeof ticket.max_bytes === "number" ? ticket.max_bytes : null };
    }
    const put = await doFetch(ticket.upload_url, { method: "PUT", headers: { "content-type": input.mime }, body: input.blob });
    const body = (await put.json().catch(() => ({}))) as { error?: unknown; max_bytes?: unknown };
    if (!put.ok) return { ok: false, error: saveErrorCode(body.error), maxBytes: typeof body.max_bytes === "number" ? body.max_bytes : null };
    return { ok: true, ticket: id, name: typeof ticket.name === "string" ? ticket.name : input.filename };
  } catch {
    return { ok: false, error: "network" };
  }
}
