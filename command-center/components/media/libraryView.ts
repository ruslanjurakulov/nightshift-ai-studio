import type { LibraryAsset, MediaKind, MediaUpload } from "@/lib/media";

/**
 * The library's view state, as pure functions: which chip is on, what the
 * search box says, which way it is sorted. Nothing here fetches or decides
 * anything the server decides — it only narrows and orders what the member's
 * session already read. Unit-tested in tests/media-library-view.test.ts.
 */

export type LibraryFilter = "all" | "image" | "video" | "audio";
export const LIBRARY_FILTERS: readonly LibraryFilter[] = ["all", "image", "video", "audio"];

export type LibrarySort = "newest" | "oldest" | "name";
export const LIBRARY_SORTS: readonly LibrarySort[] = ["newest", "oldest", "name"];

export interface LibraryView {
  filter: LibraryFilter;
  query: string;
  sort: LibrarySort;
}

export const DEFAULT_VIEW: LibraryView = { filter: "all", query: "", sort: "newest" };

/** Case- and accent-insensitive form used by the search box. */
export function normalizeQuery(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function matchesQuery(name: string | null, fallback: string, q: string): boolean {
  if (!q) return true;
  return normalizeQuery(name ?? fallback).includes(q);
}

function time(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Newest or oldest first; rows without a date go last either way; ties by id so the order never flickers. */
export function compareByDate<T extends { id: string; createdAt: string | null }>(sort: LibrarySort) {
  return (a: T, b: T): number => {
    const ta = time(a.createdAt);
    const tb = time(b.createdAt);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return sort === "newest" ? tb - ta : ta - tb;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** How many assets each chip would show. "All" includes captions, which have no chip of their own. */
export function countByFilter(assets: readonly Pick<LibraryAsset, "kind">[]): Record<LibraryFilter, number> {
  const out: Record<LibraryFilter, number> = { all: assets.length, image: 0, video: 0, audio: 0 };
  for (const a of assets) if (a.kind === "image" || a.kind === "video" || a.kind === "audio") out[a.kind] += 1;
  return out;
}

/** The assets the grid shows for this view, in order. `label` names a nameless asset for search. */
export function visibleAssets(
  assets: readonly LibraryAsset[],
  view: LibraryView,
  label: (kind: MediaKind) => string = (k) => k,
  locale?: string,
): LibraryAsset[] {
  const q = normalizeQuery(view.query);
  return assets
    .filter((a) => view.filter === "all" || a.kind === view.filter)
    .filter((a) => matchesQuery(a.name, label(a.kind), q))
    .sort(view.sort === "name" ? compareByName(label, locale) : compareByDate(view.sort));
}

/** A to Z by the name the tile shows (digits in natural order, accents folded); ties newest first, then by id. */
export function compareByName(label: (kind: MediaKind) => string = (k) => k, locale?: string) {
  // The app's language, not the machine's: the server and the browser must order alike.
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  return (a: LibraryAsset, b: LibraryAsset): number => {
    const c = collator.compare(a.name ?? label(a.kind), b.name ?? label(b.kind));
    return c !== 0 ? c : compareByDate<LibraryAsset>("newest")(a, b);
  };
}

// ── the view in the address bar ─────────────────────────────────────────────

/** The query keys the library owns; every other key in the address is left alone. */
export const VIEW_KEYS = ["kind", "q", "sort"] as const;
const QUERY_MAX = 80;

/**
 * The view named by an address's query (`?kind=video&q=intro&sort=name`).
 * Anything unknown or malformed falls back to the default for that part, so a
 * hand-edited link never breaks the page.
 */
export function parseView(params: { get(name: string): string | null } | Record<string, string | string[] | undefined>): LibraryView {
  const get = (name: string): string | null => {
    if (typeof (params as { get?: unknown }).get === "function") return (params as { get(n: string): string | null }).get(name);
    const v = (params as Record<string, string | string[] | undefined>)[name];
    return (Array.isArray(v) ? v[0] : v) ?? null;
  };
  const kind = get("kind");
  const sort = get("sort");
  return {
    filter: LIBRARY_FILTERS.includes(kind as LibraryFilter) ? (kind as LibraryFilter) : DEFAULT_VIEW.filter,
    query: (get("q") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, QUERY_MAX),
    sort: LIBRARY_SORTS.includes(sort as LibrarySort) ? (sort as LibrarySort) : DEFAULT_VIEW.sort,
  };
}

/** Write a view into an existing query string: only non-default parts are kept, other keys untouched. */
export function applyViewToSearch(search: string, view: LibraryView): string {
  const p = new URLSearchParams(search);
  for (const k of VIEW_KEYS) p.delete(k);
  if (view.filter !== DEFAULT_VIEW.filter) p.set("kind", view.filter);
  if (view.query.trim() !== "") p.set("q", view.query.slice(0, QUERY_MAX));
  if (view.sort !== DEFAULT_VIEW.sort) p.set("sort", view.sort);
  const out = p.toString();
  return out ? `?${out}` : "";
}

/** Everything between two ids (inclusive) in the order shown; the anchor missing -> just the clicked one. */
export function selectRange(order: readonly string[], anchor: string | null, to: string): string[] {
  const a = anchor === null ? -1 : order.indexOf(anchor);
  const b = order.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

const EXT_KIND: Readonly<Record<string, MediaKind>> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  gif: "image",
  heic: "image",
  heif: "image",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  flac: "audio",
  aac: "audio",
  vtt: "caption",
  srt: "caption",
};

/**
 * Which chip an upload still on its way belongs under, guessed from its name.
 * Display only: the server reads the real type from the content, and nothing
 * is accepted or refused on this guess. Unknown -> null (shown under All).
 */
export function guessUploadKind(name: string): MediaKind | null {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name.trim());
  return m ? (EXT_KIND[m[1].toLowerCase()] ?? null) : null;
}

/** Uploads not yet in the library, narrowed like the assets (always newest first: they are "now"). */
export function visibleUploads(uploads: readonly MediaUpload[], view: LibraryView): MediaUpload[] {
  const q = normalizeQuery(view.query);
  return uploads
    .filter((u) => view.filter === "all" || guessUploadKind(u.name) === view.filter)
    .filter((u) => matchesQuery(u.name, "", q))
    .sort(compareByDate("newest"));
}

/** The viewer's arrow keys: one step, stopping at either end (no wrap — the end should feel like an end). */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(length - 1, current + delta));
}

/** True when the view narrows anything (so "nothing matches" offers to reset). */
export function isNarrowed(view: LibraryView): boolean {
  return view.filter !== "all" || normalizeQuery(view.query) !== "";
}

/**
 * The files of one folder (null: every file). A file whose folder was not
 * read (no `folderId` at all: the library before migration 0049) is only
 * ever in "every file".
 */
export function inFolder<T extends { folderId?: string | null }>(assets: readonly T[], folder: string | null): T[] {
  if (folder === null) return [...assets];
  return assets.filter((a) => a.folderId === folder);
}

/**
 * Where every selected file already is: a folder id, null (all in no folder),
 * or undefined (they are in different places, or none is selected) — the move
 * picker marks that place "here now" and does not offer it.
 */
export function commonFolder(
  assets: readonly { id: string; folderId?: string | null }[],
  selected: ReadonlySet<string>,
): string | null | undefined {
  let place: string | null | undefined;
  let seen = false;
  for (const a of assets) {
    if (!selected.has(a.id)) continue;
    if (a.folderId === undefined) return undefined;
    if (!seen) {
      place = a.folderId;
      seen = true;
    } else if (place !== a.folderId) return undefined;
  }
  return seen ? place : undefined;
}

/** "1 file" / "3 files": the one plural the folder strings need (ru and uz read the same either way). */
export function fileCount(words: { count: string; countOne: string }, n: number): string {
  return n === 1 ? words.countOne : words.count.replace("{n}", String(n));
}
