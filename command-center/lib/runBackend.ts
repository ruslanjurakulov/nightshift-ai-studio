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
  ttsModel?: string;
  voiceId?: string;
  /** "Making this for:" (migration 0029) — which connected account the video
   *  is meant for. A hint recorded on the job; the pipeline never reads it. */
  publishHint?: string;
};

/** The workflow's choice lists (daily_video.yml); migration 0017 checks the same. */
export const VIDEO_PROVIDERS = ["minimax", "higgsfield", "kling", "veo", "seedance", "wan"] as const;
import { formatPublishHint, parsePublishHint } from "./publish";
import { IMAGE_PROVIDERS } from "./imageProviders";
import { isTtsModel, isVoiceId } from "./ttsModels";

export { IMAGE_PROVIDERS };

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
  const ttsModel = opts.ttsModel?.trim();
  if (ttsModel && isTtsModel(ttsModel)) params.tts_model = ttsModel;
  const voiceId = opts.voiceId?.trim();
  if (voiceId && isVoiceId(voiceId)) params.voice_id = voiceId;
  const hint = parsePublishHint(opts.publishHint);
  if (hint) params.publish_hint = formatPublishHint(hint.platform, hint.id);
  // The credit hold that pays for this job (migration 0020) — a column, not a
  // param: the pipeline never sees it, the worker settles it. Only sent when a
  // hold exists, so a database without 0020 gets exactly the old insert.
  const row = { channel_id: channelId, kind: "daily" as const, params, requested_by: requestedBy };
  return creditRef ? { ...row, credit_ref: creditRef } : row;
}

export type QueueJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Why a render job failed, in the closed set modules/render_error.py writes. */
export const JOB_ERROR_CODES = ["credits", "voice", "provider_quota", "media", "render", "timeout", "held", "unknown"] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

/**
 * `render_jobs.error` is operator text behind a stable prefix, `[code:voice] main.py exited with code 1\n<log tail>`
 * (the worker adds it, modules/render_error.py; the column is plain text so no migration is needed). Returns the code
 * and the text without the prefix. A failure written before codes existed has no prefix: `code` is null; a prefix this
 * build does not know reads "unknown". Pure.
 */
export function parseJobError(error: string | null | undefined): { code: JobErrorCode | null; text: string | null } {
  if (typeof error !== "string" || error === "") return { code: null, text: null };
  const m = /^\[code:([a-z_]+)\][ \t]?/.exec(error);
  if (!m) return { code: null, text: error };
  const code = (JOB_ERROR_CODES as readonly string[]).includes(m[1]) ? (m[1] as JobErrorCode) : "unknown";
  return { code, text: error.slice(m[0].length) || null };
}

export type QueueJob = {
  id: number;
  kind: string;
  status: QueueJobStatus | "unknown";
  attempts: number;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  /** The operator's text (header and log tail), without the code prefix. The events route sends it to the operator only. */
  error: string | null;
  /** Why it failed, for a plain sentence; null when the job did not fail or failed before codes. */
  errorCode: JobErrorCode | null;
  /** Failed and its credit hold was released (read from the organization's own reservation); null = not known / no hold. */
  creditsReturned: boolean | null;
};

const STATUSES: readonly string[] = ["queued", "running", "succeeded", "failed", "cancelled"];

/** A render_jobs row as the Create page shows it. An unexpected status reads
 *  "unknown" — never coerced into one that claims progress. */
export function toQueueJob(row: Record<string, unknown>): QueueJob {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const status = typeof row.status === "string" && STATUSES.includes(row.status) ? row.status : "unknown";
  const parsed = parseJobError(str(row.error));
  return {
    id: typeof row.id === "number" ? row.id : Number(row.id ?? 0),
    kind: typeof row.kind === "string" ? row.kind : "daily",
    status: status as QueueJob["status"],
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    created_at: str(row.created_at) ?? "",
    started_at: str(row.started_at),
    heartbeat_at: str(row.heartbeat_at),
    finished_at: str(row.finished_at),
    error: parsed.text,
    errorCode: parsed.code,
    creditsReturned: null,
  };
}

/**
 * Mark each FAILED job whose credit hold was released ("your credits were returned"). `refs` is render_jobs.credit_ref
 * per job id, `reservations` the organization's own credit_reservations rows (RLS shows members their own). Only a
 * reservation read as `released` says yes. An `open` or `captured` one is `false` (credits are still held, or were
 * charged: the page says nothing about a refund); a missing row or an unreadable table leaves null, so the page never
 * claims a refund it did not see. Only `true` is ever shown. Pure.
 */
export function withCreditsReturned(
  jobs: QueueJob[],
  refs: { id: number; credit_ref: string | null }[],
  reservations: { job_id: string; status: string }[],
): QueueJob[] {
  const refOf = new Map(refs.map((r) => [Number(r.id), r.credit_ref]));
  const statusOf = new Map(reservations.map((r) => [r.job_id, r.status]));
  return jobs.map((j) => {
    const ref = j.status === "failed" ? refOf.get(j.id) : null;
    const status = ref ? statusOf.get(ref) : undefined;
    return status === undefined ? j : { ...j, creditsReturned: status === "released" };
  });
}

/** What a customer may be sent about a job: the code and the refund fact, never the operator's log text. */
export function forCustomer(job: QueueJob): QueueJob {
  return { ...job, error: null };
}
