/**
 * "Use this picture" on a public sample's picture-to-video form (lib/site/sample-source.ts resolved `sample=` on the server to the
 * site's own poster of the picture the sample was animated from). Nothing here runs on load: the form shows the poster as a proposed
 * source and writes nothing for a visitor who never presses the key (Atlas decision 22 Nov: a copy per visitor would fill our media
 * volume and every visitor's quota). On the press, the picture becomes the form's source the way a file attached on the home page
 * does: the library's ordinary upload (lib/creative/attach.ts uploadAttachment: a ticket from the database, the PUT, the media
 * worker's check), and only once the library holds it. That upload is the only write: nothing here quotes, holds, creates a job or
 * spends (CLAUDE.md #3); the price is asked only once the source exists, and Generate is its own press.
 *
 * Once per workspace: the worker re-encodes every upload, so the library's sha256 never equals the shipped file's. The copy is found
 * again by a stable marker instead: its name (`sample-<source job>.webp`, lib/site/sample-source.ts sampleFileName), the size the
 * worker measured AND its maker, read back through the library's name search narrowed to the caller's own files and uploads
 * (GET /api/media?org=&q=&mine=1: created_by = the signed-in user, on the server, under RLS). An upload of that name still being sent
 * or checked is asked about, never sent again; the tab also remembers the file and the pending upload (sessionStorage).
 */
import { checkAttachment } from "@/lib/site/pending-attachment";
import { uploadAttachment, waitForUpload, type AttachError, type AttachResult } from "@/lib/creative/attach";
import { parseMediaId } from "@/lib/media";
import { isShippedPicture } from "@/lib/site/sample-source";

/** sessionStorage: `<prefix>:<workspace>:<source picture job>` -> the library file the picture became. */
export const SAMPLE_ASSET_KEY = "nightshift.sampleSource";
/** sessionStorage: `<prefix>:<workspace>:<source picture job>` -> the upload sent and not yet checked (asked about, never sent again). */
export const SAMPLE_TICKET_KEY = "nightshift.sampleSource.ticket";

export type SamplePreloadError =
  | AttachError
  /** The site's own copy of the picture did not come back (offline, a deploy that no longer has it). */
  | "picture_unavailable";

export type SamplePreload =
  /** `reused`: an earlier copy of this person's was chosen, nothing was sent. `thumbUrl`: the library's own signed thumbnail of it. */
  | { ok: true; assetId: string; reused: boolean; thumbUrl: string | null }
  | { ok: false; error: SamplePreloadError; maxBytes?: number | null };

type KV = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

export interface SamplePicture {
  sampleId: string;
  src: string;
  name: string;
  sourceJobId: string;
  width: number;
  height: number;
}

export interface SamplePreloadInput {
  orgId: string;
  /**
   * The signed-in person. Only a copy THEY made is ever reused (Breach, S8: a co-member could plant a file of the copy's name and
   * size). Absent: nothing is reused by name, a copy is made.
   */
  userId?: string | null;
  sample: SamplePicture;
  fetchImpl?: typeof fetch;
  storage?: KV | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function tabStorage(): KV | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

const tail = (orgId: string, sample: SamplePicture) => `${orgId}:${sample.sourceJobId}`;
const IN_PROGRESS = ["requested", "receiving", "uploaded", "ingesting"];
/** A thumbnail address the library signed (lib/server/media signedMediaPath): same origin, under the file route, nothing else. */
const THUMB = /^\/api\/media\/file\/[0-9a-f-]{36}\/[A-Za-z0-9._~%/?=&-]+$/;

/** The library file, if it is still there, ours to read, and a picture: its own thumbnail (or null). A read only (GET). */
async function readPicture(doFetch: typeof fetch, assetId: string): Promise<{ thumbUrl: string | null } | null> {
  try {
    const res = await doFetch(`/api/media/${assetId}`, { cache: "no-store" });
    if (!res.ok) return null;
    const b = (await res.json().catch(() => ({}))) as { asset?: { id?: unknown; kind?: unknown }; urls?: { thumb?: unknown } };
    if (parseMediaId(b.asset?.id) !== assetId || b.asset?.kind !== "image") return null;
    const thumb = b.urls?.thumb;
    return { thumbUrl: typeof thumb === "string" && THUMB.test(thumb) ? thumb : null };
  } catch {
    return null;
  }
}

/**
 * The library's answer for this copy's name, the caller's own files and uploads only (`mine=1`: created_by = the signed-in user, on
 * the server): a live picture of theirs with the copy's exact name and size, or an upload of that name still being sent or checked.
 * A read only. A failed or malformed read is "nothing found", never an id.
 */
export async function searchSampleCopy(
  doFetch: typeof fetch,
  orgId: string,
  sample: SamplePicture,
  userId?: string | null,
): Promise<{ assetId: string | null; ticket: string | null }> {
  const none = { assetId: null, ticket: null };
  try {
    const q = new URLSearchParams({ org: orgId, q: sample.name, mine: "1" });
    const res = await doFetch(`/api/media?${q.toString()}`, { cache: "no-store" });
    if (!res.ok) return none;
    const b = (await res.json().catch(() => ({}))) as { assets?: unknown; uploads?: unknown };
    // Without knowing who "you" are, no file is anyone's copy: one is made.
    const me = parseMediaId(userId ?? null);
    if (!me) return none;
    let assetId: string | null = null;
    if (Array.isArray(b.assets))
      for (const a of b.assets as Array<Record<string, unknown> | null>) {
        const id = parseMediaId(a?.id);
        if (id && a && a.kind === "image" && a.name === sample.name && a.width === sample.width && a.height === sample.height && a.createdBy === me) {
          assetId = id;
          break;
        }
      }
    let ticket: string | null = null;
    if (!assetId && Array.isArray(b.uploads))
      for (const u of b.uploads as Array<Record<string, unknown> | null>) {
        const id = parseMediaId(u?.id);
        if (id && u && u.name === sample.name && IN_PROGRESS.includes(String(u.status))) {
          ticket = id;
          break;
        }
      }
    return { assetId, ticket };
  } catch {
    return none;
  }
}

/** The caller's own earlier copy by name and size, or null (searchSampleCopy's file half). */
export async function findSampleCopy(doFetch: typeof fetch, orgId: string, sample: SamplePicture, userId?: string | null): Promise<string | null> {
  return (await searchSampleCopy(doFetch, orgId, sample, userId)).assetId;
}

/** The sample's picture into the library, or the copy this person already has. Never throws: every outcome is a result. */
export async function copySample(input: SamplePreloadInput): Promise<SamplePreload> {
  const doFetch = input.fetchImpl ?? fetch;
  const store = input.storage === undefined ? tabStorage() : input.storage;
  const k = tail(input.orgId, input.sample);
  const read = (prefix: string): string | null => {
    try {
      return parseMediaId(store?.getItem(`${prefix}:${k}`));
    } catch {
      return null;
    }
  };
  const write = (prefix: string, v: string) => {
    try {
      store?.setItem(`${prefix}:${k}`, v);
    } catch {
      // Not remembered: the library's own search finds the copy or the upload again.
    }
  };
  const forget = (prefix: string) => {
    try {
      if (store?.removeItem) store.removeItem(`${prefix}:${k}`);
      else store?.setItem(`${prefix}:${k}`, "");
    } catch {
      // A stale ticket is asked about once more and answers gone.
    }
  };
  const done = async (assetId: string, reused: boolean): Promise<SamplePreload> => {
    write(SAMPLE_ASSET_KEY, assetId);
    forget(SAMPLE_TICKET_KEY);
    return { ok: true, assetId, reused, thumbUrl: (await readPicture(doFetch, assetId))?.thumbUrl ?? null };
  };
  const failed = (r: Extract<AttachResult, { ok: false }>): SamplePreload => ({ ok: false, error: r.error, maxBytes: r.maxBytes ?? null });
  /** An upload already sent: asked about, never sent again. Gone or lapsed: forgotten, so a fresh copy may be made. */
  const follow = async (ticket: string): Promise<SamplePreload | "gone"> => {
    write(SAMPLE_TICKET_KEY, ticket);
    const r = await waitForUpload({ ticket, fetchImpl: doFetch, sleep: input.sleep, now: input.now });
    if (r.ok) {
      if (r.kind === "image") return done(r.assetId, false);
      forget(SAMPLE_TICKET_KEY);
      return { ok: false, error: "wrong_kind" };
    }
    if (r.error === "still_checking") return failed(r);
    forget(SAMPLE_TICKET_KEY);
    return r.error === "upload_gone" || r.error === "expired" ? "gone" : failed(r);
  };

  const kept = read(SAMPLE_ASSET_KEY);
  if (kept && (await readPicture(doFetch, kept))) return done(kept, true);
  const pending = read(SAMPLE_TICKET_KEY);
  if (pending) {
    const r = await follow(pending);
    if (r !== "gone") return r;
  }
  const found = await searchSampleCopy(doFetch, input.orgId, input.sample, input.userId);
  if (found.assetId) return done(found.assetId, true);
  if (found.ticket) {
    const r = await follow(found.ticket);
    if (r !== "gone") return r;
  }

  // The server resolved this path from the shipped data; checked again so that nothing but the site's own picture is ever fetched.
  if (!isShippedPicture(input.sample.src)) return { ok: false, error: "picture_unavailable" };
  let blob: Blob;
  try {
    const res = await doFetch(input.sample.src, { credentials: "same-origin" });
    if (!res.ok) return { ok: false, error: "picture_unavailable" };
    blob = await res.blob();
  } catch {
    return { ok: false, error: "picture_unavailable" };
  }
  const file = new File([blob], input.sample.name, { type: blob.type || "image/webp" });
  const check = checkAttachment(file);
  if (!check.ok || check.kind !== "image") return { ok: false, error: "picture_unavailable" };
  const r = await uploadAttachment({
    orgId: input.orgId,
    file,
    kind: "image",
    mime: check.mime,
    fetchImpl: doFetch,
    sleep: input.sleep,
    now: input.now,
    // Kept the moment it is sent: a reload, a second press or another tab mid-check asks about THIS upload, never sends another.
    onTicket: (ticket) => write(SAMPLE_TICKET_KEY, ticket),
  });
  // A refused or unfinished upload is never used: no file is remembered and the form keeps no source.
  if (!r.ok) {
    if (r.error !== "still_checking") forget(SAMPLE_TICKET_KEY);
    return failed(r);
  }
  if (r.kind !== "image") {
    forget(SAMPLE_TICKET_KEY);
    return { ok: false, error: "wrong_kind" };
  }
  return done(r.assetId, false);
}

// One copy at a time per workspace and picture: a second press (or a second section on the page) waits for the same one.
const inflight = new Map<string, Promise<SamplePreload>>();

export function copySampleOnce(input: SamplePreloadInput): Promise<SamplePreload> {
  const key = tail(input.orgId, input.sample);
  const running = inflight.get(key);
  if (running) return running;
  const p = copySample(input).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
