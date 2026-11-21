/**
 * Media library folders (migration 0049) — the pure, client-safe half.
 *
 * The database decides who may create, rename, delete and move
 * (save_media_folder / delete_media_folder / move_media_assets check editor
 * membership and that every file and folder is the organization's own). This
 * file only shapes input before it is sent, shapes rows for the page, and
 * maps the database's refusals to words the page turns into sentences.
 * Unit-tested in tests/media-folders.test.ts.
 */

import { parseMediaId } from "@/lib/media";

/** 0049's limits, mirrored so a form can say so before a round trip. The database is the authority. */
export const FOLDER_NAME_MAX = 60;
export const FOLDERS_PER_ORG = 200;
export const MOVE_MAX = 200;
/** A search box's text sent to the server, at most. */
export const SEARCH_MAX = 100;

export interface MediaFolder {
  id: string;
  name: string;
  /** Live files in it; null when the count could not be read (never shown as a number). */
  count: number | null;
}

export interface MediaFoldersState {
  /** 0049 applied and readable. */
  available: boolean;
  folders: MediaFolder[];
  /** Every live file of the organization, and those in no folder; null = unknown. */
  total: number | null;
  unfiled: number | null;
  error?: "read_failed";
}

export const FOLDERS_UNAVAILABLE: MediaFoldersState = { available: false, folders: [], total: null, unfiled: null };

export const MEDIA_FOLDER_COLUMNS = "id, name";

/**
 * A folder name as the database will store it (media_folder_clean_name): runs
 * of white space folded to one space, other control characters removed,
 * trimmed.
 */
export function cleanFolderName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return s
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
}

export type FolderInputError = "invalid_name" | "bad_request" | "no_assets" | "too_many_assets" | "invalid_asset";

export function parseFolderName(raw: unknown): { ok: true; value: string } | { ok: false; error: FolderInputError } {
  if (typeof raw !== "string") return { ok: false, error: "invalid_name" };
  const name = cleanFolderName(raw);
  // Counted in code points, as char_length() counts them.
  const n = [...name].length;
  if (n < 1 || n > FOLDER_NAME_MAX) return { ok: false, error: "invalid_name" };
  return { ok: true, value: name };
}

/**
 * POST /api/media/move's body: `folder_id` a uuid or null (explicitly: an
 * absent one is a malformed request, not "take them out of their folder"),
 * `asset_ids` 1–200 uuids, duplicates dropped.
 */
export function parseMoveInput(
  body: unknown,
): { ok: true; value: { folderId: string | null; assetIds: string[] } } | { ok: false; error: FolderInputError } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_request" };
  const b = body as { folder_id?: unknown; asset_ids?: unknown };
  if (!("folder_id" in b)) return { ok: false, error: "bad_request" };
  const folderId = b.folder_id === null ? null : parseMediaId(b.folder_id);
  if (b.folder_id !== null && !folderId) return { ok: false, error: "bad_request" };
  if (!Array.isArray(b.asset_ids)) return { ok: false, error: "bad_request" };
  if (b.asset_ids.length === 0) return { ok: false, error: "no_assets" };
  if (b.asset_ids.length > MOVE_MAX) return { ok: false, error: "too_many_assets" };
  const ids: string[] = [];
  for (const raw of b.asset_ids) {
    const id = parseMediaId(raw);
    if (!id) return { ok: false, error: "invalid_asset" };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, value: { folderId, assetIds: ids } };
}

/**
 * Text for a server-side name search, made safe for `ilike`: control
 * characters dropped, at most SEARCH_MAX characters, and the pattern's own
 * metacharacters escaped (`\`, `%`, `_`). PostgREST reads `*` as a wildcard
 * too and has no escape for it, so it is dropped rather than let a search for
 * "*" match everything.
 */
export function cleanSearch(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return s
    .replace(/[\u0000-\u001f\u007f*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_MAX);
}

export function ilikeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function count(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Folder rows plus media_folder_counts() rows -> the rail's list, by name.
 * `counts` null (the count could not be read) leaves every count unknown
 * rather than 0; a folder with no row in a readable answer holds 0 files.
 */
export function shapeFolders(
  rows: unknown,
  counts: unknown,
  locale = "en",
): { folders: MediaFolder[]; total: number | null; unfiled: number | null } {
  const byFolder = new Map<string | null, number>();
  const readable = Array.isArray(counts);
  if (readable) {
    for (const r of counts as unknown[]) {
      if (!r || typeof r !== "object") continue;
      const o = r as { folder_id?: unknown; assets?: unknown };
      const n = count(o.assets);
      if (n === null) continue;
      const id = o.folder_id === null ? null : parseMediaId(o.folder_id);
      if (o.folder_id !== null && !id) continue;
      byFolder.set(id, n);
    }
  }
  const folders: MediaFolder[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== "object") continue;
    const o = r as { id?: unknown; name?: unknown };
    const id = parseMediaId(o.id);
    if (!id || typeof o.name !== "string" || !o.name) continue;
    folders.push({ id, name: o.name, count: readable ? (byFolder.get(id) ?? 0) : null });
  }
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  folders.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
  const total = readable ? [...byFolder.values()].reduce((s, n) => s + n, 0) : null;
  return { folders, total, unfiled: readable ? (byFolder.get(null) ?? 0) : null };
}

// ── errors ──────────────────────────────────────────────────────────────────

export type FolderError =
  | FolderInputError
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "name_taken"
  | "limit_reached"
  | "not_available"
  | "org_required"
  | "network"
  | "failed";

export const FOLDER_ERRORS: readonly FolderError[] = [
  "invalid_name",
  "bad_request",
  "no_assets",
  "too_many_assets",
  "invalid_asset",
  "unauthorized",
  "forbidden",
  "not_found",
  "name_taken",
  "limit_reached",
  "not_available",
  "org_required",
  "network",
  "failed",
];

const DB_INPUT_WORDS: readonly FolderInputError[] = ["invalid_name", "no_assets", "too_many_assets", "invalid_asset"];

/** A refusal from 0049's functions -> a word and an HTTP status. */
export function mapFolderError(error: { code?: string; message?: string } | null | undefined): {
  error: FolderError;
  status: number;
} {
  const word = (error?.message ?? "").trim();
  switch (error?.code) {
    case "NS400":
      return { error: (DB_INPUT_WORDS as readonly string[]).includes(word) ? (word as FolderInputError) : "bad_request", status: 400 };
    case "NS409":
    case "23505":
      return { error: "name_taken", status: 409 };
    case "NS429":
      return { error: "limit_reached", status: 409 };
    case "42501":
      return { error: "forbidden", status: 403 };
    case "P0002":
      return { error: "not_found", status: 404 };
    case "22P02":
      return { error: "bad_request", status: 400 };
    case "PGRST202":
    case "PGRST205":
    case "42883":
    case "42P01":
    case "42703":
      return { error: "not_available", status: 503 };
  }
  if (/could not find the (function|table)|does not exist/i.test(error?.message ?? "")) return { error: "not_available", status: 503 };
  return { error: "failed", status: 502 };
}

/** A word from a route's answer, or "failed" for anything this page has no sentence for. */
export function folderErrorWord(raw: unknown): FolderError {
  return typeof raw === "string" && (FOLDER_ERRORS as readonly string[]).includes(raw) ? (raw as FolderError) : "failed";
}

/** Is this read failure "0049 is not applied" (degrade honestly) rather than a failed read? */
export function isMissingFolders(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    error.code === "PGRST202" ||
    error.code === "42703" ||
    error.code === "42883" ||
    /does not exist|could not find the (table|function)/i.test(error.message ?? "")
  );
}
