/**
 * "Regenerate scene" requests (roadmap PR 2.3, migration 0015).
 *
 * A Storyboard button files a `review_intents` row with action
 * "regenerate_scene" and the scene's Video IR id — exactly the pattern the
 * review panel's "Render it again" uses. The row is the whole effect: nothing
 * in a browser renders, spends or publishes. The repair is a daily_video.yml
 * dispatch with `repair_scenes` (modules/scene_repair.py); it consumes the
 * matching rows when it has rebuilt the scene. Who may file is the database's
 * decision (the review_intents insert policy: editor and above).
 *
 * Pure, so it is unit-tested directly.
 */

/** The Video IR scene id shape the database check also enforces. */
const SCENE_ID = /^s\d{3,4}$/;

export function isSceneId(v: unknown): v is string {
  return typeof v === "string" && SCENE_ID.test(v);
}

export interface SceneRepairIntent {
  channel_id: string;
  video_id: string;
  action: "regenerate_scene";
  scene_id: string;
}

/** The row to insert, or null when any part is missing or malformed — a
 *  request that names no real scene is never filed. */
export function sceneRepairIntent(
  channelId: string | null | undefined,
  videoId: string | null | undefined,
  sceneId: string | null | undefined,
): SceneRepairIntent | null {
  const channel = (channelId ?? "").trim();
  const video = (videoId ?? "").trim();
  if (!channel || !video || !isSceneId(sceneId)) return null;
  return { channel_id: channel, video_id: video, action: "regenerate_scene", scene_id: sceneId };
}

/** Scene ids with a request still waiting (unconsumed) — the button then
 *  shows "requested" instead of offering to file a duplicate. */
export function pendingSceneRequests(
  rows: ReadonlyArray<{ action?: string | null; scene_id?: string | null; consumed_at?: string | null }> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows ?? []) {
    if (r?.action === "regenerate_scene" && !r.consumed_at && isSceneId(r.scene_id)) out.add(r.scene_id);
  }
  return out;
}
