import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { parseMediaId } from "@/lib/media";
import {
  FOLDERS_UNAVAILABLE,
  MEDIA_FOLDER_COLUMNS,
  isMissingFolders,
  shapeFolders,
  type MediaFoldersState,
} from "@/lib/media-folders";

/**
 * Media library folders (migration 0049), read on the server.
 *
 * Everything is read with the signed-in user's own Supabase client (anon key
 * + session), so RLS returns the folders of organizations they belong to and
 * nothing else — never the service key. Counts come from
 * media_folder_counts(), a security-invoker function: it counts only the
 * files the caller can already read.
 */

/** `?org=` / `org_id` when given (must be a uuid), else the organization the app has open. */
export async function resolveMediaOrg(asked: unknown): Promise<{ org: string | null; bad: boolean }> {
  if (asked !== null && asked !== undefined && asked !== "") {
    const org = parseMediaId(asked);
    return { org, bad: !org };
  }
  const ctx = await getOrgContext();
  return { org: ctx.current?.id ?? null, bad: false };
}

/** The request's JSON body, or undefined when it is not JSON (a 400, not a 500). */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/**
 * The organization's folders with their file counts. `available: false` when
 * 0049 is not applied; `error: "read_failed"` when the read failed — never an
 * empty list that would read as "you have none". A count that could not be
 * read stays unknown (null), never 0.
 */
export async function loadMediaFolders(orgId: string, locale = "en"): Promise<MediaFoldersState> {
  const supabase = await createClient();
  if (!supabase || !parseMediaId(orgId)) return FOLDERS_UNAVAILABLE;
  try {
    const [rows, counts] = await Promise.all([
      supabase.from("media_folders").select(MEDIA_FOLDER_COLUMNS).eq("org_id", orgId).limit(500),
      Promise.resolve(supabase.rpc("media_folder_counts", { p_org: orgId })).catch(() => ({ data: null, error: { code: "network" } })),
    ]);
    if (rows.error) {
      return isMissingFolders(rows.error) ? FOLDERS_UNAVAILABLE : { ...FOLDERS_UNAVAILABLE, available: true, error: "read_failed" };
    }
    const shaped = shapeFolders(rows.data, counts.error ? null : counts.data, locale);
    return { available: true, ...shaped };
  } catch {
    return { ...FOLDERS_UNAVAILABLE, available: true, error: "read_failed" };
  }
}
