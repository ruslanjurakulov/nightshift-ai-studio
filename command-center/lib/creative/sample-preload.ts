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
 * again by a stable marker instead: its name (`sample-<source job>.webp`, lib/site/sample-source.ts sampleFileName) AND the size the
 * worker measured, read back through the library's existing name search (GET /api/media?org=&q=, matched on the server, under the
 * caller's RLS: only a live file of this workspace). The tab also remembers the file (sessionStorage) as a fast path. Either one
 * found and still a picture: no upload.
 */
import { checkAttachment } from "@/lib/site/pending-attachment";
import { uploadAttachment, type AttachError } from "@/lib/creative/attach";
import { parseMediaId } from "@/lib/media";
import { isShippedPicture } from "@/lib/site/sample-source";

/** sessionStorage: `<prefix>:<workspace>:<source picture job>` -> the library file the picture became. */
export const SAMPLE_ASSET_KEY = "nightshift.sampleSource";

export type SamplePreloadError =
  | AttachError
  /** The site's own copy of the picture did not come back (offline, a deploy that no longer has it). */
  | "picture_unavailable";

export type SamplePreload = { ok: true; assetId: string; reused: boolean } | { ok: false; error: SamplePreloadError; maxBytes?: number | null };

type KV = Pick<Storage, "getItem" | "setItem">;

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

const keyOf = (orgId: string, sample: SamplePicture) => `${SAMPLE_ASSET_KEY}:${orgId}:${sample.sourceJobId}`;

/** Is this library file still there, ours to read, and a picture? A read only (GET). */
async function stillAPicture(doFetch: typeof fetch, assetId: string): Promise<boolean> {
  try {
    const res = await doFetch(`/api/media/${assetId}`, { cache: "no-store" });
    if (!res.ok) return false;
    const b = (await res.json().catch(() => ({}))) as { asset?: { id?: unknown; kind?: unknown } };
    return parseMediaId(b.asset?.id) === assetId && b.asset?.kind === "image";
  } catch {
    return false;
  }
}

/**
 * A live picture of this workspace with the copy's name and size, newest first (the route's order), or null. A read only: the
 * library's own search, which the caller's RLS limits to this workspace's live files. A failed read is "not found" (the copy is then
 * made; the tab's memory still keeps a second press from making another).
 */
export async function findSampleCopy(doFetch: typeof fetch, orgId: string, sample: SamplePicture): Promise<string | null> {
  try {
    const q = new URLSearchParams({ org: orgId, q: sample.name });
    const res = await doFetch(`/api/media?${q.toString()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const b = (await res.json().catch(() => ({}))) as { assets?: unknown };
    if (!Array.isArray(b.assets)) return null;
    for (const a of b.assets as Array<Record<string, unknown> | null>) {
      const id = parseMediaId(a?.id);
      if (id && a && a.kind === "image" && a.name === sample.name && a.width === sample.width && a.height === sample.height) return id;
    }
    return null;
  } catch {
    return null;
  }
}

/** The sample's picture into the library, or the copy this workspace already has. Never throws: every outcome is a result. */
export async function copySample(input: SamplePreloadInput): Promise<SamplePreload> {
  const doFetch = input.fetchImpl ?? fetch;
  const store = input.storage === undefined ? tabStorage() : input.storage;
  const key = keyOf(input.orgId, input.sample);
  const remember = (id: string) => {
    try {
      store?.setItem(key, id);
    } catch {
      // Not remembered: the name search finds the copy again.
    }
  };
  let kept: string | null = null;
  try {
    kept = parseMediaId(store?.getItem(key));
  } catch {
    kept = null;
  }
  if (kept && (await stillAPicture(doFetch, kept))) return { ok: true, assetId: kept, reused: true };
  const found = await findSampleCopy(doFetch, input.orgId, input.sample);
  if (found) {
    remember(found);
    return { ok: true, assetId: found, reused: true };
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
  const r = await uploadAttachment({ orgId: input.orgId, file, kind: "image", mime: check.mime, fetchImpl: doFetch, sleep: input.sleep, now: input.now });
  // A refused or unfinished upload is never used: no id is remembered and the form keeps no source.
  if (!r.ok) return { ok: false, error: r.error, maxBytes: r.maxBytes ?? null };
  if (r.kind !== "image") return { ok: false, error: "wrong_kind" };
  remember(r.assetId);
  return { ok: true, assetId: r.assetId, reused: false };
}

// One copy at a time per workspace and picture: a second press (or a second section on the page) waits for the same one.
const inflight = new Map<string, Promise<SamplePreload>>();

export function copySampleOnce(input: SamplePreloadInput): Promise<SamplePreload> {
  const key = keyOf(input.orgId, input.sample);
  const running = inflight.get(key);
  if (running) return running;
  const p = copySample(input).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
