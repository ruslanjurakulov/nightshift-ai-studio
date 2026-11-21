import "server-only";
import { fetchWithTimeout } from "@/lib/server/fetch-timeout";
import { GITHUB_REPO, GITHUB_TOKEN, isGithubConfigured } from "@/lib/server/github-secrets";

/**
 * What GitHub says about one channel's dispatched Run now, for the Studio's live view (Actions backend). The dispatch API answers no
 * run id, so the run is found by what it must contain: a daily_video.yml workflow_dispatch run created around the dispatch moment
 * with a job named `make-video (<channel id>)` (the job's own `name:` in daily_video.yml). Only the job's status words come back:
 * never a URL, a log, a run id or anything of the token's.
 */
export type WorkflowRunStatus =
  /** Dispatched, no matching run seen yet (GitHub can take a few seconds to list a new run). */
  | { state: "not_seen" }
  | { state: "queued" | "in_progress" }
  | { state: "completed"; conclusion: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "other" };

const WORKFLOW = "daily_video.yml";
/** A run listed this long before the dispatch is another one (clock skew between us and GitHub stays well inside this). */
const BEFORE_MS = 2 * 60 * 1000;
/** A run created this long after the dispatch is not this dispatch's (GitHub lists a dispatched run within seconds). */
const AFTER_MS = 10 * 60 * 1000;
/** Many viewers poll every 6 s; GitHub is asked at most this often per (channel, dispatch). */
const CACHE_MS = 30 * 1000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; value: WorkflowRunStatus | null }>();

async function gh(path: string): Promise<Response | null> {
  try {
    return await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
  } catch {
    return null;
  }
}

const CONCLUSIONS = new Set(["success", "failure", "cancelled", "timed_out", "skipped"]);

export function statusOf(job: { status?: unknown; conclusion?: unknown }): WorkflowRunStatus {
  if (job.status === "completed") {
    const c = typeof job.conclusion === "string" && CONCLUSIONS.has(job.conclusion) ? job.conclusion : "other";
    return { state: "completed", conclusion: c as "success" };
  }
  // queued, waiting, requested and pending are all "not started yet" to a person.
  return job.status === "in_progress" ? { state: "in_progress" } : { state: "queued" };
}

/**
 * Null when GitHub could not be asked or did not answer (not configured, a timeout, a 4xx/5xx): the view then says the workflow's
 * status is not known, never "queued" or "not seen".
 */
export async function dispatchedRunStatus(channelId: string, dispatchedAtMs: number): Promise<WorkflowRunStatus | null> {
  if (!isGithubConfigured) return null;
  const key = `${channelId}|${dispatchedAtMs}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await readStatus(channelId, dispatchedAtMs);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function readStatus(channelId: string, at: number): Promise<WorkflowRunStatus | null> {
  const from = new Date(at - BEFORE_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const res = await gh(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=10&created=${encodeURIComponent(`>=${from}`)}`);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { workflow_runs?: { id?: unknown; created_at?: unknown }[] } | null;
  if (!body || !Array.isArray(body.workflow_runs)) return null;
  const runs = body.workflow_runs
    .filter((r) => typeof r.id === "number" && typeof r.created_at === "string" && Date.parse(r.created_at) <= at + AFTER_MS)
    .sort((a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)));
  const want = `make-video (${channelId})`;
  for (const r of runs) {
    const jr = await gh(`/actions/runs/${r.id as number}/jobs?per_page=30`);
    if (!jr || !jr.ok) return null;
    const jobs = (await jr.json().catch(() => null)) as { jobs?: { name?: unknown; status?: unknown; conclusion?: unknown }[] } | null;
    if (!jobs || !Array.isArray(jobs.jobs)) return null;
    const job = jobs.jobs.find((j) => j.name === want);
    if (job) return statusOf(job);
    // A run whose video job is not created yet (only `resolve` so far) cannot be told apart from another channel's: not_seen, not a guess.
  }
  return { state: "not_seen" };
}

/** Tests only. */
export function clearRunStatusCache(): void {
  cache.clear();
}
