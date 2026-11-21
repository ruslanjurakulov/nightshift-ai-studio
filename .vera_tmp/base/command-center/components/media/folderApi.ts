import { folderErrorWord, type FolderError } from "@/lib/media-folders";

/**
 * The library page's calls to the folder routes (migration 0049). Each
 * resolves — never throws — to the route's answer or a word the page has a
 * sentence for. Nothing here decides anything: the routes run the database's
 * functions under the member's own session.
 */

export type FolderResult<T> = { ok: true; value: T } | { ok: false; error: FolderError };

async function call<T>(url: string, method: string, body: unknown, pick: (b: Record<string, unknown>) => T | null): Promise<FolderResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { ok: false, error: res.status === 401 ? "unauthorized" : folderErrorWord(json.error) };
  const value = pick(json);
  return value === null ? { ok: false, error: "failed" } : { ok: true, value };
}

export function createFolder(orgId: string, name: string): Promise<FolderResult<{ id: string; name: string }>> {
  return call("/api/media/folders", "POST", { org_id: orgId, name }, (b) =>
    typeof b.id === "string" && typeof b.name === "string" ? { id: b.id, name: b.name } : null,
  );
}

export function renameFolder(id: string, name: string): Promise<FolderResult<{ id: string; name: string }>> {
  return call(`/api/media/folders/${encodeURIComponent(id)}`, "PATCH", { name }, (b) =>
    typeof b.id === "string" && typeof b.name === "string" ? { id: b.id, name: b.name } : null,
  );
}

export function deleteFolder(id: string): Promise<FolderResult<true>> {
  return call(`/api/media/folders/${encodeURIComponent(id)}`, "DELETE", undefined, (b) => (b.ok === true ? true : null));
}

export function moveAssets(orgId: string, folderId: string | null, assetIds: readonly string[]): Promise<FolderResult<{ moved: number }>> {
  return call("/api/media/move", "POST", { org_id: orgId, folder_id: folderId, asset_ids: assetIds }, (b) =>
    typeof b.moved === "number" ? { moved: b.moved } : null,
  );
}
