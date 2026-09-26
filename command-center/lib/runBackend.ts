/**
 * Where "Run now" sends a run: GitHub Actions (the default) or the Supabase job
 * queue a VPS worker drains (roadmap phase B, docs/WORKER_VPS.md).
 *
 * Chosen by the SERVER env var NIGHTSHIFT_RUN_BACKEND — never by the browser,
 * so nobody can pick a backend by editing a request. Anything other than the
 * exact value "queue" is Actions: a typo must fall back to the path that has
 * always worked, not to one that may have no worker behind it.
 *
 * Pure (no server-only import) so it is unit-tested directly; the callers are
 * the run route and the server pages.
 */

export type RunBackend = "actions" | "queue";

export function resolveRunBackend(env: Record<string, string | undefined>): RunBackend {
  return (env.NIGHTSHIFT_RUN_BACKEND ?? "").trim().toLowerCase() === "queue" ? "queue" : "actions";
}

/** Whether "Run now" can work at all on this backend. Actions needs the GitHub
 *  forwarding token/repo; the queue needs only Supabase, which the whole app
 *  already needs (the worker holds its own service key, the web never does). */
export function isRunConfigured(
  backend: RunBackend,
  wiring: { github: boolean; supabase: boolean },
): boolean {
  return backend === "queue" ? wiring.supabase : wiring.github;
}

export type RunOptions = {
  topic?: string;
  niche?: string;
  duration?: number;
  language?: string;
  visualStyle?: string;
  videoProvider?: string;
  imageProvider?: string;
};

/** The workflow's choice lists (daily_video.yml); migration 0017 checks the same. */
export const VIDEO_PROVIDERS = ["minimax", "higgsfield", "kling", "veo", "seedance", "wan"] as const;
export const IMAGE_PROVIDERS = ["pexels", "leonardo"] as const;

/**
 * The render_jobs row for a "Run now" in queue mode: exactly the inputs the
 * Actions dispatch forwards, trimmed and capped the same way, and nothing else.
 *
 * Deliberately absent: `privacy` (the worker then runs private, as the Actions
 * dispatch pins it), `resume` and `repair_scenes`, and every worker-owned
 * column. The insert RLS policy in 0017 refuses any of those from a signed-in
 * user anyway — this is the honest shape, that is the guarantee.
 */
export function buildRenderJobInsert(
  channelId: string,
  opts: RunOptions,
  requestedBy: string,
  creditRef?: string | null,
): {
  channel_id: string;
  kind: "daily";
  params: Record<string, string | number>;
  requested_by: string;
  credit_ref?: string;
} {
  const params: Record<string, string | number> = {};
  const topic = opts.topic?.trim();
  const niche = opts.niche?.trim();
  const language = opts.language?.trim();
  const visualStyle = opts.visualStyle?.trim();
  if (topic) params.topic = topic.slice(0, 300);
  if (niche) params.niche = niche.slice(0, 120);
  if (typeof opts.duration === "number" && Number.isFinite(opts.duration) && opts.duration > 0) {
    params.duration = Math.min(3600, Math.max(30, Math.round(opts.duration)));
  }
  if (language) params.language = language.slice(0, 40);
  if (visualStyle) params.visual_style = visualStyle.slice(0, 300);
  const videoProvider = opts.videoProvider?.trim().toLowerCase();
  const imageProvider = opts.imageProvider?.trim().toLowerCase();
  if (videoProvider && (VIDEO_PROVIDERS as readonly string[]).includes(videoProvider))
    params.video_provider = videoProvider;
  if (imageProvider && (IMAGE_PROVIDERS as readonly string[]).includes(imageProvider))
    params.image_provider = imageProvider;
  // The credit hold that pays for this job (migration 0020) — a column, not a
  // param: the pipeline never sees it, the worker settles it. Only sent when a
  // hold exists, so a database without 0020 gets exactly the old insert.
  const row = { channel_id: channelId, kind: "daily" as const, params, requested_by: requestedBy };
  return creditRef ? { ...row, credit_ref: creditRef } : row;
}

export type QueueJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type QueueJob = {
  id: number;
  kind: string;
  status: QueueJobStatus | "unknown";
  attempts: number;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  error: string | null;
};

const STATUSES: readonly string[] = ["queued", "running", "succeeded", "failed", "cancelled"];

/** A render_jobs row as the Create page shows it. An unexpected status reads
 *  "unknown" — never coerced into one that claims progress. */
export function toQueueJob(row: Record<string, unknown>): QueueJob {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const status = typeof row.status === "string" && STATUSES.includes(row.status) ? row.status : "unknown";
  return {
    id: typeof row.id === "number" ? row.id : Number(row.id ?? 0),
    kind: typeof row.kind === "string" ? row.kind : "daily",
    status: status as QueueJob["status"],
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    created_at: str(row.created_at) ?? "",
    started_at: str(row.started_at),
    heartbeat_at: str(row.heartbeat_at),
    finished_at: str(row.finished_at),
    error: str(row.error),
  };
}
