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
 * The button is only offered where a repair can happen at all
 * (sceneRepairEligibility): scene_repair.find_run repairs an UNFINISHED run
 * through its checkpoint, and a run that uploaded cleared that checkpoint.
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

/**
 * Pipeline events that mean the video reached YouTube (modules/event_log.py:
 * UPLOAD_COMPLETED, VIDEO_PUBLISHED, SHORT_COMPLETED). main.py clears the run
 * checkpoint right after the upload these follow.
 */
const UPLOADED_EVENTS: ReadonlySet<string> = new Set(["upload.completed", "video.published", "short.completed"]);

export type SceneRepairEligibility =
  | { repairable: true }
  /** "uploaded": the video reached YouTube; "unknown": no video row to judge. */
  | { repairable: false; reason: "uploaded" | "unknown" };

function present(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Can a "Regenerate scene" request on this video ever be carried out?
 *
 * Only for a run that has NOT uploaded: modules/scene_repair.find_run repairs
 * a blocked / held / awaiting-review run through its checkpoint, and main.py
 * clears that checkpoint as soon as the upload succeeds — so a request on an
 * uploaded video is filed and then never consumed.
 *
 * Derived only from what the video page already loads:
 *  - `published_at` — set by StateStore.record_video, which runs only after a
 *    successful YouTube upload (the long video's and a Short's alike);
 *  - `privacy` — written by that same call with the upload's privacy status;
 *  - the video's own pipeline events — an upload/publish event names it.
 * Any one of them present means uploaded, so not repairable. The rule leans to
 * hiding: offering a request that can never run is the bug this guards.
 *
 * Pure: it reads nothing, writes nothing and changes no permission or gate.
 */
export function sceneRepairEligibility(
  video: { published_at?: string | null; privacy?: string | null } | null | undefined,
  events?: ReadonlyArray<{ event?: string | null }> | null,
): SceneRepairEligibility {
  if (!video) return { repairable: false, reason: "unknown" };
  const uploaded =
    present(video.published_at) ||
    present(video.privacy) ||
    (events ?? []).some((e) => typeof e?.event === "string" && UPLOADED_EVENTS.has(e.event));
  return uploaded ? { repairable: false, reason: "uploaded" } : { repairable: true };
}
