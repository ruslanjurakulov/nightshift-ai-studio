import { uploadEdited, type SaveError } from "@/lib/imageEditor/save";
import { parseMediaId, knownUploadReason, type UploadReason } from "@/lib/media";
import type { EditorAsset } from "@/lib/editor";

/**
 * Voice-over recorded in the editor (owner decision 2026-11-11: the microphone on the editor page only).
 *
 * A take is never kept in the browser as the result: "Add to timeline" sends it through the media library's ordinary
 * upload path (POST /api/media/uploads asks the database for a ticket: membership of the organization, the type
 * allowlist, the size cap, the quota; PUT streams the body; the media worker sniffs the content, probes it with a
 * forced demuxer and registers it as an AUDIO asset of that organization). Only once the worker has registered it does
 * the editor put it on the timeline, as an ordinary sound: the same document, validation and render as any other.
 */

/** Shorter than this is a slip of the finger, not a take. */
export const VOICEOVER_MIN_SECONDS = 1;
/** Ten minutes: a long narration, still one sound the editor can trim. The recorder stops itself here. */
export const VOICEOVER_MAX_SECONDS = 600;
/** The page's clock ticks every 250 ms; a take well past the limit means the tab was paused while recording. */
export const VOICEOVER_TOLERANCE_SECONDS = 1;
/** Asked of the recorder so the size of a long take is predictable: 10 min at 128 kbit/s is 9.6 MB. */
export const VOICEOVER_BITS_PER_SECOND = 128_000;
/**
 * Refused in the browser before any request: twice what 10 minutes at the asked rate should be (a browser may ignore
 * the rate), and well under the library's per-file cap (0038 default 95 MiB). The database's own cap and the
 * organization's quota still decide, and their answer is shown.
 */
export const VOICEOVER_MAX_BYTES = 25 * 1024 * 1024;

/** How often the upload is asked about while the server checks it, and for how long before the page stops waiting. */
export const VOICEOVER_POLL_MS = 1500;
export const VOICEOVER_WAIT_MS = 3 * 60 * 1000;

/**
 * The recorder's type -> the type the upload declares and the extension its name carries.
 *
 * WebM gets NO extension: the database maps `.webm` to VIDEO (media_ext_mime) and would refuse an audio upload so named
 * (`extension_mismatch`); without one only the declared type and then the content decide, and the worker stores a
 * sound-only WebM as audio/webm. Ogg and MP4 (Safari) have audio extensions of their own.
 */
const TAKE_TYPES: Record<string, { type: string; ext: string }> = {
  "audio/webm": { type: "audio/webm", ext: "" },
  "audio/ogg": { type: "audio/ogg", ext: "ogg" },
  "audio/mp4": { type: "audio/mp4", ext: "m4a" },
  "audio/wav": { type: "audio/wav", ext: "wav" },
  "audio/x-wav": { type: "audio/wav", ext: "wav" },
  "audio/wave": { type: "audio/wav", ext: "wav" },
};

export function voiceTakeType(mime: string | null | undefined): { type: string; ext: string } | null {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TAKE_TYPES, base) ? TAKE_TYPES[base] : null;
}

/** "Voice-over 2026-11-11 12-30-05" (+ ".ogg" / ".m4a" / ".wav"): a label in the library, never a path. */
export function takeName(now: Date, ext: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  return `Voice-over ${stamp}${ext ? `.${ext}` : ""}`;
}

export type VoiceOverError =
  /** The take is over VOICEOVER_MAX_BYTES (refused here) or the database's cap (`maxBytes` then says what it is). */
  | "too_large"
  | SaveError
  /** The worker refused the file; `reason` says why when it is a word we know. */
  | "rejected"
  /** The ticket lapsed before the worker took it. */
  | "expired"
  /** Uploaded, but the server did not finish checking it while the page waited: it will appear in the library. */
  | "still_checking"
  /** The registered file is not a sound with a length (cannot happen for a real take; never placed if it does). */
  | "not_audio"
  /** Registered, but the project had no room for another sound when it arrived (the editor's answer, not the server's). */
  | "full";

export type VoiceOverResult =
  | { ok: true; asset: EditorAsset }
  | { ok: false; error: VoiceOverError; reason?: UploadReason | null; maxBytes?: number | null };

export interface VoiceOverUpload {
  orgId: string;
  blob: Blob;
  type: string;
  name: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Upload one take and wait for the library to hold it. Never throws: every outcome is a result. An aborted signal
 * (the page was left) ends the wait quietly as "still_checking": the upload itself, once sent, is the server's.
 */
export async function uploadVoiceOver(input: VoiceOverUpload): Promise<VoiceOverResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? wait;
  const now = input.now ?? Date.now;
  if (input.blob.size <= 0) return { ok: false, error: "empty" };
  if (input.blob.size > VOICEOVER_MAX_BYTES) return { ok: false, error: "too_large", maxBytes: VOICEOVER_MAX_BYTES };

  const sent = await uploadEdited({ orgId: input.orgId, blob: input.blob, filename: input.name, mime: input.type, fetchImpl: doFetch });
  if (!sent.ok) return { ok: false, error: sent.error, maxBytes: sent.maxBytes ?? null };

  const deadline = now() + VOICEOVER_WAIT_MS;
  let assetId: string | null = null;
  while (!assetId) {
    if (input.signal?.aborted || now() > deadline) return { ok: false, error: "still_checking" };
    await sleep(VOICEOVER_POLL_MS);
    if (input.signal?.aborted) return { ok: false, error: "still_checking" };
    let body: { status?: unknown; reason?: unknown; asset_id?: unknown };
    try {
      const res = await doFetch(`/api/media/uploads/${sent.ticket}`, { cache: "no-store", signal: input.signal });
      if (res.status === 401) return { ok: false, error: "unauthorized" };
      // A failed read is not a failed upload: ask again until the deadline.
      if (!res.ok) continue;
      body = (await res.json().catch(() => ({}))) as typeof body;
    } catch {
      if (input.signal?.aborted) return { ok: false, error: "still_checking" };
      continue;
    }
    if (body.status === "rejected") return { ok: false, error: "rejected", reason: knownUploadReason(typeof body.reason === "string" ? body.reason : null) };
    if (body.status === "expired") return { ok: false, error: "expired" };
    if (body.status === "ingested") assetId = parseMediaId(body.asset_id);
  }

  try {
    const res = await doFetch(`/api/media/${assetId}`, { cache: "no-store", signal: input.signal });
    if (!res.ok) return { ok: false, error: res.status === 401 ? "unauthorized" : "failed" };
    const b = (await res.json().catch(() => ({}))) as {
      asset?: { id?: unknown; kind?: unknown; name?: unknown; durationS?: unknown };
      urls?: { original?: unknown };
    };
    const a = b.asset ?? {};
    const id = parseMediaId(a.id);
    const duration = typeof a.durationS === "number" && Number.isFinite(a.durationS) ? a.durationS : null;
    if (!id || id !== assetId || a.kind !== "audio" || duration === null || !(duration > 0)) return { ok: false, error: "not_audio" };
    const view = typeof b.urls?.original === "string" && b.urls.original.startsWith("/api/media/file/") ? b.urls.original : null;
    return {
      ok: true,
      asset: { id, kind: "audio", name: typeof a.name === "string" ? a.name : input.name, durationS: duration, width: null, height: null, viewUrl: view, thumbUrl: null },
    };
  } catch {
    return { ok: false, error: input.signal?.aborted ? "still_checking" : "network" };
  }
}
