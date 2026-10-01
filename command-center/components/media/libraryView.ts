import type { LibraryAsset, MediaKind, MediaUpload } from "@/lib/media";

/**
 * The library's view state, as pure functions: which chip is on, what the
 * search box says, which way it is sorted. Nothing here fetches or decides
 * anything the server decides — it only narrows and orders what the member's
 * session already read. Unit-tested in tests/media-library-view.test.ts.
 */

export type LibraryFilter = "all" | "image" | "video" | "audio";
export const LIBRARY_FILTERS: readonly LibraryFilter[] = ["all", "image", "video", "audio"];

export type LibrarySort = "newest" | "oldest";

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
): LibraryAsset[] {
  const q = normalizeQuery(view.query);
  return assets
    .filter((a) => view.filter === "all" || a.kind === view.filter)
    .filter((a) => matchesQuery(a.name, label(a.kind), q))
    .sort(compareByDate(view.sort));
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
