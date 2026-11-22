/**
 * The browser's half of a public sample's picture-to-video link (lib/site/sample-source.ts resolved `sample=` on the server to the
 * site's own poster of the picture the sample was animated from). The picture becomes the form's source the way a file attached on
 * the home page does: the library's ordinary upload (lib/creative/attach.ts uploadAttachment: a ticket from the database, the PUT,
 * the media worker's check), and only once the library holds it. That upload is the only write: nothing here quotes, holds, creates
 * a job or spends (CLAUDE.md #3); the person still presses Generate.
 *
 * Once per link visit: the library file is remembered in this tab (sessionStorage, by workspace and sample) and reused while the
 * library still holds it as a picture, so a reload, React's second effect run or a second mount never uploads the picture twice.
 * The page also swaps `sample=` for `source=<the library file>` in the address, so a reload opens the form on that file directly.
 * The worker re-encodes every upload, so the library's sha256 never equals the shipped file's: a match by hash is not possible.
 */
import { checkAttachment } from "@/lib/site/pending-attachment";
import { uploadAttachment, type AttachError } from "@/lib/creative/attach";
import { parseMediaId } from "@/lib/media";
import { isShippedPicture } from "@/lib/site/sample-source";

/** sessionStorage: `<prefix>:<workspace>:<sample>` -> the library file the sample's picture became. */
export const SAMPLE_ASSET_KEY = "nightshift.sampleSource";

export type SamplePreloadError =
  | AttachError
  /** The site's own copy of the picture did not come back (offline, a deploy that no longer has it). */
  | "picture_unavailable";

export type SamplePreload = { ok: true; assetId: string; reused: boolean } | { ok: false; error: SamplePreloadError; maxBytes?: number | null };

type KV = Pick<Storage, "getItem" | "setItem">;

export interface SamplePreloadInput {
  orgId: string;
  sample: { sampleId: string; src: string; name: string };
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

const keyOf = (orgId: string, sampleId: string) => `${SAMPLE_ASSET_KEY}:${orgId}:${sampleId}`;

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

/** The sample's picture into the library, or the file it already became in this tab. Never throws: every outcome is a result. */
export async function preloadSample(input: SamplePreloadInput): Promise<SamplePreload> {
  const doFetch = input.fetchImpl ?? fetch;
  const store = input.storage === undefined ? tabStorage() : input.storage;
  const key = keyOf(input.orgId, input.sample.sampleId);
  let kept: string | null = null;
  try {
    kept = parseMediaId(store?.getItem(key));
  } catch {
    kept = null;
  }
  if (kept && (await stillAPicture(doFetch, kept))) return { ok: true, assetId: kept, reused: true };

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
  if (!r.ok) return { ok: false, error: r.error, maxBytes: r.maxBytes ?? null };
  if (r.kind !== "image") return { ok: false, error: "wrong_kind" };
  try {
    store?.setItem(key, r.assetId);
  } catch {
    // Not remembered: the address still swaps to `source=`, so a reload of this page does not upload again.
  }
  return { ok: true, assetId: r.assetId, reused: false };
}

// One preload per workspace and sample while the page lives: a second effect run or a second mount waits for the same one.
const inflight = new Map<string, Promise<SamplePreload>>();

export function preloadSampleOnce(input: SamplePreloadInput): Promise<SamplePreload> {
  const key = keyOf(input.orgId, input.sample.sampleId);
  const running = inflight.get(key);
  if (running) return running;
  const p = preloadSample(input).then((r) => {
    // A failure may be asked again (a later visit); a success is remembered in the tab's storage.
    inflight.delete(key);
    return r;
  });
  inflight.set(key, p);
  return p;
}
