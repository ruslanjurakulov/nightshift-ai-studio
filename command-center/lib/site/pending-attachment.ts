/**
 * The file a visitor attaches with the landing composer's "+" (components/landing/PromptBar.tsx), and the Studio picking it up
 * (components/studio/StudioHome.tsx).
 *
 * The landing has no account to keep a file in, and a file cannot travel in a link. So it stays in THIS browser only (IndexedDB,
 * one record, an hour at most) while the visitor signs up; nothing is sent anywhere from the landing. The Studio then takes it out
 * (read once, deleted), uploads it through the library's ordinary upload path, and opens the right tool with it chosen. Nothing is
 * priced or started by any of that: the person still presses Generate and sees the price (CLAUDE.md #3).
 *
 * The record can be gone by the time the Studio looks (another browser, another device, cleared storage, past the hour, private
 * mode): the Studio then says so in words rather than opening a form that looks as if the file were there (CLAUDE.md #5).
 */
import { ALLOWED_MIME, UPLOAD_MAX_BYTES_DEFAULT } from "@/lib/media";

/** What "+" offers the system picker. The library's own type list (ALLOWED_MIME) is what is then accepted. */
export const ATTACH_ACCEPT = "image/*,video/*";

export type AttachKind = "image" | "video";
export type AttachProblem = "empty" | "type" | "size";
export type AttachCheck = { ok: true; kind: AttachKind } | { ok: false; error: AttachProblem; max?: number };

/**
 * The checks the library's upload makes first, made before anything is kept or sent: a picture or a video of a type the library
 * takes, not empty, not over the upload cap. A type the browser could not name (an empty `type`) is refused here, the way the
 * library's ticket would refuse it.
 */
export function checkAttachment(file: { type: string; size: number }): AttachCheck {
  const kind = ALLOWED_MIME[file.type];
  if (kind !== "image" && kind !== "video") return { ok: false, error: "type" };
  if (!(file.size > 0)) return { ok: false, error: "empty" };
  if (file.size > UPLOAD_MAX_BYTES_DEFAULT) return { ok: false, error: "size", max: UPLOAD_MAX_BYTES_DEFAULT };
  return { ok: true, kind };
}

/** An hour: enough to sign up and confirm an e-mail, short enough that a forgotten file does not sit in the browser for days. */
export const PENDING_TTL_MS = 60 * 60 * 1000;

export interface PendingRecord {
  blob: Blob;
  name: string;
  type: string;
  kind: AttachKind;
  savedAt: number;
  expiresAt: number;
}

/** One record, by one key: a second attach replaces the first. */
export interface PendingStore {
  get(): Promise<PendingRecord | null>;
  put(record: PendingRecord): Promise<void>;
  delete(): Promise<void>;
}

const DB_NAME = "nightshift-pending";
const STORE = "files";
const KEY = "landing";
/** When the kept file lapses, so the landing can clear a stale one without opening IndexedDB on every visit. */
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
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      const tx = db.transaction(STORE, mode);
      // Listened for before the request is awaited: a write counts only once its transaction has completed.
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("idb"));
        tx.onabort = () => reject(tx.error ?? new Error("idb_abort"));
      });
      // When the request itself fails, that is the error thrown; the transaction's own rejection is then not a second, unheard one.
      done.catch(() => undefined);
      const out = await request(fn(tx.objectStore(STORE)));
      await done;
      return out;
    } finally {
      db.close();
    }
  };
  return {
    get: async () => {
      const v = (await run("readonly", (s) => s.get(KEY))) as unknown;
      return isRecord(v) ? v : null;
    },
    put: async (record) => {
      await run("readwrite", (s) => s.put(record, KEY));
    },
    delete: async () => {
      await run("readwrite", (s) => s.delete(KEY));
    },
  };
}

function isRecord(v: unknown): v is PendingRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<PendingRecord>;
  return (
    typeof Blob !== "undefined" &&
    r.blob instanceof Blob &&
    typeof r.name === "string" &&
    typeof r.type === "string" &&
    (r.kind === "image" || r.kind === "video") &&
    typeof r.savedAt === "number" &&
    typeof r.expiresAt === "number"
  );
}

type Mark = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function marks(): Mark | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Keep the file in this browser for PENDING_TTL_MS. Throws when the browser will not keep it (the bar then says so and stays). */
export async function keepPending(file: File, kind: AttachKind, store: PendingStore | null, now: number = Date.now(), mark: Mark | null = marks()): Promise<void> {
  if (!store) throw new Error("no_store");
  const record: PendingRecord = { blob: file, name: file.name, type: file.type, kind, savedAt: now, expiresAt: now + PENDING_TTL_MS };
  await store.put(record);
  try {
    mark?.setItem(PENDING_MARK, String(record.expiresAt));
  } catch {
    // The mark only lets the landing clear a stale file cheaply; the record carries its own expiry.
  }
}

export type Pickup =
  | { state: "ready"; file: File; kind: AttachKind }
  /** It was kept, but longer ago than PENDING_TTL_MS. */
  | { state: "expired" }
  /** Nothing is kept in this browser (another browser or device, cleared storage, already picked up). */
  | { state: "missing" }
  /** This browser has no storage the page can read. */
  | { state: "unavailable" };

/** Take the kept file out: read once, then deleted whatever it held, so a reload never uploads it twice. */
export async function takePending(store: PendingStore | null, now: number = Date.now(), mark: Mark | null = marks()): Promise<Pickup> {
  if (!store) return { state: "unavailable" };
  let record: PendingRecord | null;
  try {
    record = await store.get();
  } catch {
    return { state: "unavailable" };
  }
  try {
    await store.delete();
  } catch {
    // Not deleted: it still lapses by its own expiry, and the landing clears it on a later visit.
  }
  try {
    mark?.removeItem(PENDING_MARK);
  } catch {
    // As above.
  }
  if (!record) return { state: "missing" };
  if (record.expiresAt <= now) return { state: "expired" };
  const file = new File([record.blob], record.name || "upload", { type: record.type });
  return { state: "ready", file, kind: record.kind };
}

/** On the landing: a file kept and never picked up is removed once its hour is over. Opens IndexedDB only when a mark says one is kept. */
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
