import { coerceExports, editorErrorWord, type EditorAsset, type EditorError, type EditorExport, type TimelineDoc } from "@/lib/editor";
import { PROJECT_FRAME, isExportFrameChoice, type ExportFrameChoice } from "@/lib/multiRatioExport/frames";
import { parseExportQuote, type ExportQuote, type QuotableFrame } from "@/lib/hiresExport/limits";

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

/** How one frame of a several-size export request ended: queued (its export id) or refused (a word). */
export type FrameOutcome = { frame: ExportFrameChoice; id: string } | { frame: ExportFrameChoice; error: EditorError };

/**
 * Export the saved revision in several frame sizes (migration 0129): one request, ONE export per frame, each counted
 * and checked by itself. Only ids of the closed list travel ("project" = the project's own frame); no size does.
 * Resolves to an outcome for every frame that was asked, in the order asked. A frame the server did not answer for
 * is "failed", never assumed queued. If the server answers the way it does with the switch off (one plain export,
 * no per-frame list), that is said as it is: the project's own frame was queued and every other size is
 * "not_available".
 *
 * `maxCredits` (migration 0132): for each paid 1440p / 4K frame, the number of credits the person confirmed after the
 * server quoted it. Sent only when there is one, so a request without paid frames is the body it always was.
 */
export async function requestExports(
  id: string,
  rev: number,
  frames: readonly ExportFrameChoice[],
  maxCredits?: Readonly<Partial<Record<QuotableFrame, number>>>,
): Promise<EditorResult<FrameOutcome[]>> {
  let res: Response;
  try {
    res = await fetch(`${base(id)}/exports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(maxCredits && Object.keys(maxCredits).length ? { rev, frames, maxCredits } : { rev, frames }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) return { ok: false, error: "unauthorized" };
  if (Array.isArray(json.exports)) {
    const rows = (json.exports as unknown[]).filter(
      (r): r is { frame: ExportFrameChoice; id?: unknown; error?: unknown } =>
        typeof r === "object" && r !== null && isExportFrameChoice((r as { frame?: unknown }).frame),
    );
    return {
      ok: true,
      value: frames.map((frame) => {
        const r = rows.find((x) => x.frame === frame);
        return r && typeof r.id === "string" ? { frame, id: r.id } : { frame, error: r ? editorErrorWord(r.error) : "failed" };
      }),
    };
  }
  if (!res.ok) return { ok: false, error: editorErrorWord(json.error) };
  if (typeof json.id !== "string") return { ok: false, error: "failed" };
  // The server did not read `frames`: the switch is off there. It queued the plain export and nothing else.
  const plain: FrameOutcome = { frame: PROJECT_FRAME, id: json.id };
  return {
    ok: true,
    value: [plain, ...frames.filter((f) => f !== PROJECT_FRAME).map((frame): FrameOutcome => ({ frame, error: "not_available" }))],
  };
}

/** The server's quote of an export of the saved revision `rev` in `frame` (migration 0132: 1440p / 4K; 0136: up to 1080p
 *  too, "free" while its price is NULL). Never a number made up here: a quote the route did not send whole is "failed". */
export function fetchHiresQuote(id: string, rev: number, frame: QuotableFrame): Promise<EditorResult<ExportQuote>> {
  const q = new URLSearchParams({ rev: String(rev), frame });
  return call(`${base(id)}/exports/quote?${q.toString()}`, "GET", undefined, (b) => parseExportQuote(b, frame));
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

export interface ProjectChoice {
  id: string;
  title: string;
}

/** The projects of an organization a file can be sent to (read under the member's own session). */
export function listProjects(orgId: string): Promise<EditorResult<ProjectChoice[]>> {
  return call(`/api/editor/projects?org_id=${encodeURIComponent(orgId)}`, "GET", undefined, (b) =>
    Array.isArray(b.projects)
      ? (b.projects as unknown[]).flatMap((p) => {
          const r = p as { id?: unknown; title?: unknown };
          return typeof r.id === "string" && typeof r.title === "string" ? [{ id: r.id, title: r.title }] : [];
        })
      : null,
  );
}

/**
 * "Open in editor": send one library file to a new project (`target` = a
 * title) or to an existing one (`target` = its id). Writes a document and
 * nothing else — no export, no price, no publishing.
 */
export function sendAsset(
  orgId: string,
  assetId: string,
  target: { project: string } | { title: string },
): Promise<EditorResult<{ id: string }>> {
  const body = "project" in target ? { org_id: orgId, asset_id: assetId, project_id: target.project } : { org_id: orgId, asset_id: assetId, title: target.title };
  return call("/api/editor/send", "POST", body, (b) => (typeof b.id === "string" ? { id: b.id } : null));
}
