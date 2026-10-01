import { coerceExports, editorErrorWord, type EditorAsset, type EditorError, type EditorExport, type TimelineDoc } from "@/lib/editor";

/**
 * The editor page's calls to its routes (migration 0054). Each resolves —
 * never throws — to the route's answer or a word the page has a sentence for.
 * Nothing here decides anything: the routes check the document and run the
 * database's functions under the member's own session. Nothing here renders
 * or spends: an export request is a row the media worker picks up.
 */

export type EditorResult<T> = { ok: true; value: T } | { ok: false; error: EditorError };

async function call<T>(url: string, method: string, body: unknown, pick: (b: Record<string, unknown>) => T | null): Promise<EditorResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { ok: false, error: res.status === 401 ? "unauthorized" : editorErrorWord(json.error) };
  const value = pick(json);
  return value === null ? { ok: false, error: "failed" } : { ok: true, value };
}

const base = (id: string) => `/api/editor/projects/${encodeURIComponent(id)}`;

export function createProject(orgId: string, title: string, assetId: string): Promise<EditorResult<{ id: string }>> {
  return call("/api/editor/projects", "POST", { org_id: orgId, title, asset_id: assetId }, (b) => (typeof b.id === "string" ? { id: b.id } : null));
}

export function saveProject(id: string, baseRev: number, title: string | null, doc: TimelineDoc): Promise<EditorResult<{ rev: number }>> {
  return call(base(id), "PUT", { base_rev: baseRev, title, doc }, (b) => (Number.isInteger(b.rev) ? { rev: b.rev as number } : null));
}

export function deleteProject(id: string): Promise<EditorResult<true>> {
  return call(base(id), "DELETE", undefined, (b) => (b.ok === true ? true : null));
}

export function requestExport(id: string, rev: number): Promise<EditorResult<{ id: string }>> {
  return call(`${base(id)}/exports`, "POST", { rev }, (b) => (typeof b.id === "string" ? { id: b.id } : null));
}

export interface ProjectSnapshot {
  rev: number;
  exports: EditorExport[];
  assets: Record<string, EditorAsset>;
}

export function fetchProject(id: string): Promise<EditorResult<ProjectSnapshot>> {
  return call(base(id), "GET", undefined, (b) =>
    Number.isInteger(b.rev) && typeof b.assets === "object" && b.assets !== null
      ? { rev: b.rev as number, exports: coerceExports(b.exports), assets: b.assets as Record<string, EditorAsset> }
      : null,
  );
}
