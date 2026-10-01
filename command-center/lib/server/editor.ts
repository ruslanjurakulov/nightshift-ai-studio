import "server-only";
import { createClient } from "@/lib/supabase/server";
import { MEDIA_ASSET_COLUMNS, coerceAssets, parseMediaId } from "@/lib/media";
import { mediaDir, mediaUrlSecret, withUrls } from "@/lib/server/media";
import {
  EDITOR_EXPORT_COLUMNS,
  EDITOR_PROJECT_COLUMNS,
  EDITOR_PROJECT_LIST_COLUMNS,
  coerceExports,
  docAssetIds,
  type EditorAsset,
  type EditorExport,
  type TimelineDoc,
} from "@/lib/editor";

/**
 * The video editor's server half (migration 0054): reads under the signed-in
 * user's own session, so RLS returns this organization's projects, exports
 * and files and nothing else — never the service key.
 *
 * Previews are the library's signed links (the 480p proxy of a video), the
 * same ten-minute links the library page hands out; the editor asks for fresh
 * ones when a link has expired.
 */

export interface EditorProjectSummary {
  id: string;
  title: string;
  rev: number;
  updatedAt: string | null;
}

export interface EditorProjectData {
  id: string;
  orgId: string;
  title: string;
  rev: number;
  doc: TimelineDoc;
  updatedAt: string | null;
  exports: EditorExport[];
  /** The files the document uses and the finished exports, by id, with preview links. */
  assets: Record<string, EditorAsset>;
}

export type EditorRead<T> =
  | { state: "ok"; value: T }
  | { state: "not_available" }
  | { state: "not_found" }
  | { state: "read_failed" };

/** "This table does not exist": 0054 is not applied. */
function isMissing(
  e: { code?: string; message?: string } | null | undefined,
): boolean {
  return Boolean(
    e &&
    (e.code === "42P01" ||
      e.code === "PGRST205" ||
      /does not exist|could not find the table/i.test(e.message ?? "")),
  );
}

function toEditorAssets(rows: unknown): Record<string, EditorAsset> {
  const secret = mediaUrlSecret();
  const served = mediaDir() !== null;
  const out: Record<string, EditorAsset> = {};
  for (const a of coerceAssets(rows)) {
    if (a.kind !== "video" && a.kind !== "image" && a.kind !== "audio")
      continue;
    const u = withUrls(a, secret, served);
    out[a.id] = {
      id: a.id,
      kind: a.kind,
      name: a.name,
      durationS: a.durationS,
      width: a.width,
      height: a.height,
      // For a video the proxy (what a browser can play); null when the host
      // cannot serve files — the editor says so instead of a broken player.
      viewUrl: u.viewUrl,
      thumbUrl: u.thumbUrl,
    };
  }
  return out;
}

export async function loadEditorProjects(
  orgId: string,
): Promise<EditorRead<EditorProjectSummary[]>> {
  const supabase = await createClient();
  if (!supabase || !parseMediaId(orgId)) return { state: "not_available" };
  try {
    const { data, error } = await supabase
      .from("editor_projects")
      .select(EDITOR_PROJECT_LIST_COLUMNS)
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error)
      return isMissing(error)
        ? { state: "not_available" }
        : { state: "read_failed" };
    const rows = Array.isArray(data)
      ? (data as unknown as Record<string, unknown>[])
      : [];
    return {
      state: "ok",
      value: rows
        .filter((r) => typeof r.id === "string" && typeof r.title === "string")
        .map((r) => ({
          id: r.id as string,
          title: r.title as string,
          rev: Number(r.rev) || 1,
          updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
        })),
    };
  } catch {
    return { state: "read_failed" };
  }
}

/** The organization's videos a project can start from or add (newest first). */
export async function loadEditorVideos(
  orgId: string,
): Promise<EditorRead<EditorAsset[]>> {
  const supabase = await createClient();
  if (!supabase || !parseMediaId(orgId)) return { state: "not_available" };
  try {
    const { data, error } = await supabase
      .from("media_assets")
      .select(MEDIA_ASSET_COLUMNS)
      .eq("org_id", orgId)
      .eq("kind", "video")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error)
      return isMissing(error)
        ? { state: "not_available" }
        : { state: "read_failed" };
    return {
      state: "ok",
      value: Object.values(toEditorAssets(data)).filter(
        (a) => (a.durationS ?? 0) > 0,
      ),
    };
  } catch {
    return { state: "read_failed" };
  }
}

export async function loadEditorProject(
  id: string,
): Promise<EditorRead<EditorProjectData>> {
  const supabase = await createClient();
  const pid = parseMediaId(id);
  if (!supabase) return { state: "not_available" };
  if (!pid) return { state: "not_found" };
  try {
    const [project, exports] = await Promise.all([
      supabase
        .from("editor_projects")
        .select(EDITOR_PROJECT_COLUMNS)
        .eq("id", pid)
        .maybeSingle(),
      supabase
        .from("editor_exports")
        .select(EDITOR_EXPORT_COLUMNS)
        .eq("project_id", pid)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    if (project.error)
      return isMissing(project.error)
        ? { state: "not_available" }
        : { state: "read_failed" };
    // Another organization's project and a made-up id read the same: RLS returns no row.
    if (!project.data) return { state: "not_found" };
    if (exports.error) return { state: "read_failed" };
    const row = project.data as unknown as Record<string, unknown>;
    const doc = row.doc as TimelineDoc;
    const exportRows = coerceExports(exports.data);
    const ids = [
      ...new Set([
        ...docAssetIds(doc),
        ...exportRows
          .map((e) => e.assetId)
          .filter((x): x is string => Boolean(x)),
      ]),
    ]
      .map((x) => parseMediaId(x))
      .filter((x): x is string => Boolean(x));
    let assets: Record<string, EditorAsset> = {};
    if (ids.length) {
      const read = await supabase
        .from("media_assets")
        .select(MEDIA_ASSET_COLUMNS)
        .in("id", ids)
        .is("deleted_at", null);
      if (read.error) return { state: "read_failed" };
      assets = toEditorAssets(read.data);
    }
    return {
      state: "ok",
      value: {
        id: pid,
        orgId: String(row.org_id),
        title: String(row.title),
        rev: Number(row.rev) || 1,
        doc,
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
        exports: exportRows,
        assets,
      },
    };
  } catch {
    return { state: "read_failed" };
  }
}

/** One video of the caller's organization, for a new project's first clip (RLS decides). */
export async function readEditorVideo(
  orgId: string,
  assetId: string,
): Promise<EditorAsset | null> {
  const supabase = await createClient();
  const aid = parseMediaId(assetId);
  if (!supabase || !aid || !parseMediaId(orgId)) return null;
  const { data, error } = await supabase
    .from("media_assets")
    .select(MEDIA_ASSET_COLUMNS)
    .eq("id", aid)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const a = toEditorAssets([data])[aid];
  return a && a.kind === "video" ? a : null;
}
