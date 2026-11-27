/**
 * A file attached with the composer's "+" (the Studio's own, and the landing's kept one picked up by the Studio): which tool it
 * opens, and its trip into the library. Client-safe; unit-tested in tests/studio-attach.test.tsx.
 *
 * The upload is the library's EXISTING path, nothing new (lib/imageEditor/save uploadEdited): POST /api/media/uploads asks the
 * database for a ticket (membership, type allowlist, size cap, quota), PUT streams the file, the media worker sniffs and registers
 * it. Only once the worker has registered it does the form get it as its source. Nothing here asks a price or creates a job: the
 * form is filled and the person presses Generate (CLAUDE.md #3).
 */
import { uploadEdited, type SaveError } from "@/lib/imageEditor/save";
import { knownUploadReason, parseMediaId, type UploadReason } from "@/lib/media";
import { modelsFor, needsSource, needsVideo, promptRule, wordsMax, type StudioCapability, type StudioModel } from "@/lib/creative/studio";
import { DESK_TOOLS, type MediaDesk } from "@/lib/creative/desks";
import type { AttachKind } from "@/lib/site/pending-attachment";

/**
 * The tools that start from a video in the library, in the order an attached video tries them: change it by the words first (the
 * words typed with it say what to change), then make it sharper, change its shape, take its background out.
 */
export const VIDEO_IN_TOOLS = ["video_edit", "video_upscale", "video_reframe", "video_remove_bg"] as const satisfies readonly StudioCapability[];

const takes = (kind: AttachKind, c: StudioCapability) => (kind === "image" ? needsSource(c) : needsVideo(c));
const sold = (models: readonly StudioModel[], c: StudioCapability) => modelsFor([...models], c).length > 0;

/**
 * The tool an attachment opens. On a desk, that desk's first tool for this kind of file that a model is sold for (the Image desk
 * edits a picture, Video animates it, Enhance upscales it, as its [+] did before the file picker; a video on Enhance gets its first
 * video tool on sale); when none of them is on sale, its first tool for the file anyway, whose form says plainly that nothing is on
 * sale (an Enhance whose upscale is not sold opened a dead upscale form while its cut-out was on sale). Only where the desk has no
 * tool for it, or there is no desk (the home page's file): a picture animates (picture to video), a video opens the first video-in
 * tool a model is sold for, else the first of them anyway, as above (never another tool that quietly does something else,
 * CLAUDE.md #4). The person can switch the tool afterwards; the switch is announced.
 */
export function toolForAttachment(kind: AttachKind, models: readonly StudioModel[], desk: MediaDesk | null = null): StudioCapability {
  const fits = desk ? DESK_TOOLS[desk].filter((c) => takes(kind, c)) : [];
  const own = fits.find((c) => sold(models, c)) ?? fits[0];
  if (own) return own;
  if (kind === "image") return "i2v";
  return VIDEO_IN_TOOLS.find((c) => sold(models, c)) ?? VIDEO_IN_TOOLS[0];
}

/** How often the upload is asked about while the worker checks it, and for how long the page waits (lib/editor-voiceover's). */
export const ATTACH_POLL_MS = 1500;
export const ATTACH_WAIT_MS = 3 * 60 * 1000;

export type AttachError =
  | SaveError
  /** The worker refused the file; `reason` says why when it is a word we know. */
  | "rejected"
  /** The ticket lapsed before the worker took it. */
  | "expired"
  /** Uploaded, but still being checked when the page stopped waiting: it will be in the library. */
  | "still_checking"
  /** The worker registered it as neither a picture nor a video (a file whose name or type said otherwise). */
  | "wrong_kind"
  /** Asked about the upload, the server said this person may not see it (403): final, never "still checking". */
  | "upload_forbidden"
  /** The upload is no longer there to ask about (404 or 410): dismissed, or cleaned up. Final. */
  | "upload_gone";

export type AttachResult =
  | { ok: true; assetId: string; kind: AttachKind }
  | { ok: false; error: AttachError; reason?: UploadReason | null; maxBytes?: number | null };

export interface AttachUpload {
  orgId: string;
  file: File;
  kind: AttachKind;
  /** The type the upload declares: 0044's normalization of the browser's (lib/media normalizeUploadMime). Default: the file's own. */
  mime?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /**
   * The ticket once the file is sent (before the worker has checked it): a caller that must not send the same file twice
   * (lib/creative/sample-preload.ts) keeps it, to ask about that upload again (waitForUpload) instead of sending another.
   */
  onTicket?: (ticket: string) => void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Upload one file and wait for the library to hold it. Never throws: every outcome is a result. */
export async function uploadAttachment(input: AttachUpload): Promise<AttachResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? wait;
  const now = input.now ?? Date.now;
  // The signal reaches the PUT too: a page left mid-transfer stops sending the file, not only asking about it.
  const sent = await uploadEdited({
    orgId: input.orgId,
    blob: input.file,
    filename: input.file.name,
    mime: input.mime ?? input.file.type,
    fetchImpl: doFetch,
    signal: input.signal,
  });
  if (!sent.ok) return { ok: false, error: sent.error, maxBytes: sent.maxBytes ?? null };
  input.onTicket?.(sent.ticket);
  return waitForUpload({ ticket: sent.ticket, fetchImpl: doFetch, sleep, now, signal: input.signal });
}

/**
 * An upload already sent (its ticket): wait for the library to hold it, then read what it registered. The second half of
 * uploadAttachment, for a caller that kept a ticket from an earlier press. Never throws.
 */
export async function waitForUpload(input: {
  ticket: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<AttachResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? wait;
  const now = input.now ?? Date.now;
  const sent = { ticket: input.ticket };
  const deadline = now() + ATTACH_WAIT_MS;
  let assetId: string | null = null;
  while (!assetId) {
    if (input.signal?.aborted || now() > deadline) return { ok: false, error: "still_checking" };
    await sleep(ATTACH_POLL_MS);
    if (input.signal?.aborted) return { ok: false, error: "still_checking" };
    let body: { status?: unknown; reason?: unknown; asset_id?: unknown };
    try {
      const res = await doFetch(`/api/media/uploads/${sent.ticket}`, { cache: "no-store", signal: input.signal });
      if (res.status === 401) return { ok: false, error: "unauthorized" };
      // Answers that will not change by asking again: said at once, not after three minutes of "still checking".
      if (res.status === 403) return { ok: false, error: "upload_forbidden" };
      if (res.status === 404 || res.status === 410) return { ok: false, error: "upload_gone" };
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

  // What the worker registered it as decides the tool, not the name or the type the browser gave it.
  try {
    const res = await doFetch(`/api/media/${assetId}`, { cache: "no-store", signal: input.signal });
    if (!res.ok) return { ok: false, error: res.status === 401 ? "unauthorized" : "failed" };
    const b = (await res.json().catch(() => ({}))) as { asset?: { id?: unknown; kind?: unknown } };
    if (parseMediaId(b.asset?.id) !== assetId) return { ok: false, error: "failed" };
    const kind = b.asset?.kind;
    if (kind !== "image" && kind !== "video") return { ok: false, error: "wrong_kind" };
    return { ok: true, assetId, kind };
  } catch {
    return { ok: false, error: input.signal?.aborted ? "still_checking" : "network" };
  }
}

/** The words the attached tool's form starts with: none for a tool that takes none, else cut to that tool's own limit (whole characters). */
export function attachWords(c: StudioCapability, words: string): string {
  if (promptRule(c) === "none") return "";
  return Array.from(words.trim()).slice(0, wordsMax(c)).join("").trim();
}

/**
 * Where the words for an attachment that did not make it come from: the attach flow's own, or the library's upload refusals
 * (t.media.errors, whose `too_large` names the cap the database answered with).
 */
export function attachErrorKey(
  error: AttachError,
): { flow: "rejected" | "expiredTicket" | "stillChecking" | "wrongKind" | "uploadForbidden" | "uploadGone" } | { media: SaveError } {
  if (error === "rejected") return { flow: "rejected" };
  if (error === "expired") return { flow: "expiredTicket" };
  if (error === "still_checking") return { flow: "stillChecking" };
  if (error === "wrong_kind") return { flow: "wrongKind" };
  if (error === "upload_forbidden") return { flow: "uploadForbidden" };
  if (error === "upload_gone") return { flow: "uploadGone" };
  return { media: error };
}
