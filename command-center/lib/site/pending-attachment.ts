/**
 * The file a visitor attaches with the landing composer's "+" (components/landing/PromptBar.tsx), and the Studio picking it up
 * (components/studio/StudioHome.tsx).
 *
 * The landing has no account to keep a file in, and a file cannot travel in a link. So it stays in THIS browser only (IndexedDB,
 * one record, an hour at most) while the visitor signs up; nothing is sent anywhere from the landing. The Studio then takes it out
 * and ASKS the person whether to use it (Use / Discard); only on Use does it go through the library's ordinary upload path. Nothing
 * is priced or started by any of that: the person still presses Generate and sees the price (CLAUDE.md #3).
 *
 * The record is bound to the link that was made for it: a random nonce is kept with it and carried as `attach=<nonce>`, and the
 * Studio takes the record only when the two match. It is removed on sign-in (unless that sign-in carries its link), on sign-out,
 * when it is taken, and by a sweep once its hour is over, on the landing and on every app page.
 *
 * The record can be gone by the time the Studio looks (another browser, another device, cleared storage, past the hour, private
 * mode): the Studio then says so in words rather than opening a form that looks as if the file were there (CLAUDE.md #5).
 */
import { ALLOWED_MIME, EXT_MIME, UPLOAD_ACCEPT, UPLOAD_MAX_BYTES_DEFAULT, normalizeUploadMime } from "@/lib/media";

/**
 * What "+" offers the system picker: the picture and video entries of the library's own accept list (UPLOAD_ACCEPT). HEIC is named
 * by extension and by type there on purpose: iOS converts a HEIC to a JPEG unless the accept list names HEIC itself.
 */
export const ATTACH_ACCEPT = UPLOAD_ACCEPT.split(",")
  .filter((e) => {
    const t = e.startsWith(".") ? EXT_MIME[e.slice(1)] : e;
    const kind = t ? ALLOWED_MIME[t] : undefined;
    return kind === "image" || kind === "video";
  })
  .join(",");

export type AttachKind = "image" | "video";
export type AttachProblem = "empty" | "type" | "size";
export type AttachCheck = { ok: true; kind: AttachKind; mime: string } | { ok: false; error: AttachProblem; max?: number };

/**
 * The checks the library's upload makes first, made before anything is kept or sent: the type the database would read (0044's
 * normalization: aliases folded, an empty or generic type taken from the extension) is a picture or a video the library takes, the
 * file is not empty and not over the upload cap. `mime` is that normalized type, the one the upload declares.
 */
export function checkAttachment(file: { type: string; size: number; name?: string }): AttachCheck {
  const mime = normalizeUploadMime(file.type, file.name ?? "");
  const kind = ALLOWED_MIME[mime];
  if (kind !== "image" && kind !== "video") return { ok: false, error: "type" };
  if (!(file.size > 0)) return { ok: false, error: "empty" };
  if (file.size > UPLOAD_MAX_BYTES_DEFAULT) return { ok: false, error: "size", max: UPLOAD_MAX_BYTES_DEFAULT };
  return { ok: true, kind, mime };
}

/** An hour: enough to sign up and confirm an e-mail, short enough that a forgotten file does not sit in the browser for days. */
export const PENDING_TTL_MS = 60 * 60 * 1000;

/** The link's `attach=` value: 128 random bits, hex. */
export const NONCE_RE = /^[0-9a-f]{32}$/;

export interface PendingRecord {
  blob: Blob;
  name: string;
  type: string;
  kind: AttachKind;
  nonce: string;
  savedAt: number;
  expiresAt: number;
}

/** One record, by one key: a second attach replaces the first. */
export interface PendingStore {
  get(): Promise<PendingRecord | null>;
  put(record: PendingRecord): Promise<void>;
  delete(): Promise<void>;
  /** Read and, when `nonce` matches, delete — in ONE readwrite transaction, so two tabs never both take it. */
  take(nonce: string): Promise<PendingRecord | null | "mismatch">;
}

const DB_NAME = "nightshift-pending";
const STORE = "files";
const KEY = "landing";
/** When the kept file lapses, so a page can clear a stale one without opening IndexedDB on every visit. */
export const PENDING_MARK = "nightshift.pendingAttach";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("idb"));
  });
}

/** The browser's IndexedDB as a PendingStore; null where there is none (an old browser, a locked-down private mode). */
export function indexedDbStore(factory: IDBFactory | null | undefined = typeof indexedDB === "undefined" ? null : indexedDB): PendingStore | null {
  if (!factory) return null;
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      let r: IDBOpenDBRequest;
      try {
        r = factory.open(DB_NAME, 1);
      } catch (e) {
        reject(e);
        return;
      }
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("idb"));
      r.onblocked = () => reject(new Error("idb_blocked"));
    });
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T> => {
    const db = await open();
    try {
      const tx = db.transaction(STORE, mode);
      // Listened for before the work is awaited: a write counts only once its transaction has completed.
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("idb"));
        tx.onabort = () => reject(tx.error ?? new Error("idb_abort"));
      });
      // When a request itself fails, that is the error thrown; the transaction's own rejection is then not a second, unheard one.
      done.catch(() => undefined);
      const out = await fn(tx.objectStore(STORE));
      await done;
      return out;
    } finally {
      db.close();
    }
  };
  return {
    get: async () => run("readonly", async (s) => asRecord(await request(s.get(KEY)))),
    put: async (record) => {
      await run("readwrite", (s) => request(s.put(record, KEY)));
    },
    delete: async () => {
      await run("readwrite", (s) => request(s.delete(KEY)));
    },
    // The get's success handler queues the delete in the same transaction before it can commit: no other tab's transaction on
    // this store runs in between.
    take: async (nonce) =>
      run("readwrite", async (s) => {
        const record = asRecord(await request(s.get(KEY)));
        if (!record) return null;
        if (record.nonce !== nonce) return "mismatch" as const;
        await request(s.delete(KEY));
        return record;
      }),
  };
}

function asRecord(v: unknown): PendingRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<PendingRecord>;
  return typeof Blob !== "undefined" &&
    r.blob instanceof Blob &&
    typeof r.name === "string" &&
    typeof r.type === "string" &&
    (r.kind === "image" || r.kind === "video") &&
    typeof r.nonce === "string" &&
    typeof r.savedAt === "number" &&
    typeof r.expiresAt === "number"
    ? (r as PendingRecord)
    : null;
}

type Mark = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function marks(): Mark | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 128 random bits from the browser's CSPRNG, hex. */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Keep the file in this browser for PENDING_TTL_MS, bound to a fresh nonce, and return that nonce (the link carries it). Throws when
 * the browser will not keep it (the bar then says so and stays). `mime` is the normalized type the upload will declare.
 */
export async function keepPending(
  file: File,
  kind: AttachKind,
  store: PendingStore | null,
  opts: { mime?: string; now?: number; mark?: Mark | null; nonce?: string } = {},
): Promise<string> {
  if (!store) throw new Error("no_store");
  const now = opts.now ?? Date.now();
  const nonce = opts.nonce ?? newNonce();
  const record: PendingRecord = { blob: file, name: file.name, type: opts.mime ?? file.type, kind, nonce, savedAt: now, expiresAt: now + PENDING_TTL_MS };
  await store.put(record);
  try {
    (opts.mark === undefined ? marks() : opts.mark)?.setItem(PENDING_MARK, String(record.expiresAt));
  } catch {
    // The mark only lets a page clear a stale file cheaply; the record carries its own expiry.
  }
  return nonce;
}

export type Pickup =
  | { state: "ready"; file: File; kind: AttachKind }
  /** It was kept, but longer ago than PENDING_TTL_MS. */
  | { state: "expired" }
  /** Nothing is kept in this browser for THIS link (another browser or device, cleared storage, already taken, another link's). */
  | { state: "missing" }
  /** This browser has no storage the page can read. */
  | { state: "unavailable" };

/**
 * Take the kept file out for the link's nonce: read and deleted in one transaction, so a reload or a second tab never takes it twice.
 * A record made for another link is left where it is (it lapses on its own) and reads as missing.
 */
export async function takePending(store: PendingStore | null, nonce: string, now: number = Date.now(), mark: Mark | null = marks()): Promise<Pickup> {
  if (!store) return { state: "unavailable" };
  if (!NONCE_RE.test(nonce)) return { state: "missing" };
  let record: PendingRecord | null | "mismatch";
  try {
    record = await store.take(nonce);
  } catch {
    return { state: "unavailable" };
  }
  if (record === "mismatch" || !record) return { state: "missing" };
  try {
    mark?.removeItem(PENDING_MARK);
  } catch {
    // The record is gone already; the mark only saves a later page a look.
  }
  if (record.expiresAt <= now) return { state: "expired" };
  const file = new File([record.blob], record.name || "upload", { type: record.type });
  return { state: "ready", file, kind: record.kind };
}

/** Remove the kept file whatever it is (sign-out, a sign-in that does not carry its link). Never throws. */
export async function discardPending(store: PendingStore | null = indexedDbStore(), mark: Mark | null = marks()): Promise<void> {
  try {
    if (mark && !mark.getItem(PENDING_MARK)) return;
  } catch {
    // Unreadable mark: look anyway.
  }
  try {
    await store?.delete();
  } catch {
    // Left for the sweep.
  }
  try {
    mark?.removeItem(PENDING_MARK);
  } catch {
    // As above.
  }
}

/** Whether a destination after sign-in is the Studio link made for a kept file (then the sign-in keeps it). */
export function carriesPending(destination: string | null | undefined): boolean {
  try {
    const v = new URL(destination ?? "", "https://x.invalid").searchParams.get("attach");
    return !!v && NONCE_RE.test(v);
  } catch {
    return false;
  }
}

/** A file kept and never picked up is removed once its hour is over. Opens IndexedDB only when a mark says one is kept. */
export async function dropExpired(store: PendingStore | null, now: number = Date.now(), mark: Mark | null = marks()): Promise<void> {
  let until: number;
  try {
    const raw = mark?.getItem(PENDING_MARK);
    if (!raw) return;
    until = Number(raw);
  } catch {
    return;
  }
  if (Number.isFinite(until) && until > now) return;
  try {
    await store?.delete();
  } catch {
    // Left for the next visit.
  }
  try {
    mark?.removeItem(PENDING_MARK);
  } catch {
    // As above.
  }
}
