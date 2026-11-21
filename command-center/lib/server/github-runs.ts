import "server-only";
import { fetchWithTimeout } from "@/lib/server/fetch-timeout";
import { GITHUB_REPO, GITHUB_TOKEN, isGithubConfigured } from "@/lib/server/github-secrets";

/**
 * What GitHub says about one channel's dispatched Run now, for the Studio's live view (Actions backend). The dispatch API answers no
 * run id, so the run is found by what it must contain: a daily_video.yml workflow_dispatch run created at or just after the dispatch
 * moment with a job named `make-video (<channel id>)` (the job's own `name:` in daily_video.yml). Only the job's status words come
 * back: never a URL, a log, a run id or anything of the token's.
 *
 * The token is shared with Run now's dispatch and the secret writes: using it up would block those for every workspace (Breach,
 * Lens). So GitHub is asked at most once per CACHE_MS per run (the key rounds `since` to the second), identical requests share one
 * read, a found run is pinned (later reads cost one call), the whole process spends at most BUDGET calls a minute, and the route
 * charges the person's own rate limit before any read that is not cached. Past any of these the answer is null: not known.
 */
export type WorkflowRunStatus =
  /** Dispatched, no matching run seen yet (GitHub can take a few seconds to list a new run). */
  | { state: "not_seen" }
  | { state: "queued" | "in_progress" }
  | { state: "completed"; conclusion: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "other" };

const WORKFLOW = "daily_video.yml";
/** dispatched_at is taken just before the dispatch call; this much clock skew between us and GitHub is allowed, no more. */
const SKEW_MS = 30 * 1000;
/** A run created this long after the dispatch is not this dispatch's (GitHub lists a dispatched run within seconds). */
const AFTER_MS = 10 * 60 * 1000;
const CACHE_MS = 30 * 1000;
const CACHE_MAX = 500;
/** GitHub calls this process may make per minute for the live view, across every person. */
const BUDGET = 30;

type Entry = { at: number; value: Promise<WorkflowRunStatus | null>; runId: number | null };
const cache = new Map<string, Entry>();
let spent: number[] = [];

function take(): boolean {
  const now = Date.now();
  spent = spent.filter((t) => now - t < 60_000);
  if (spent.length >= BUDGET) return false;
  spent.push(now);
  return true;
}

async function gh(path: string): Promise<Response | null> {
  if (!take()) return null;
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

type Job = { name?: unknown; status?: unknown; conclusion?: unknown };

async function jobsOf(runId: number): Promise<Job[] | null> {
  const res = await gh(`/actions/runs/${runId}/jobs?per_page=30`);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { jobs?: Job[] } | null;
  return body && Array.isArray(body.jobs) ? body.jobs : null;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Finds this dispatch's run: the earliest at or after the dispatch whose video jobs name this channel. */
async function find(channelId: string, at: number): Promise<{ status: WorkflowRunStatus | null; runId: number | null }> {
  // A closed range: newest-first paging can never push the real run off the page (Breach 7, Lens).
  const range = `${iso(at - SKEW_MS)}..${iso(at + AFTER_MS)}`;
  const res = await gh(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30&created=${encodeURIComponent(range)}`);
  if (!res || !res.ok) return { status: null, runId: null };
  const body = (await res.json().catch(() => null)) as { workflow_runs?: { id?: unknown; created_at?: unknown }[] } | null;
  if (!body || !Array.isArray(body.workflow_runs)) return { status: null, runId: null };
  const runs = body.workflow_runs
    .filter((r): r is { id: number; created_at: string } => typeof r.id === "number" && typeof r.created_at === "string")
    .filter((r) => Date.parse(r.created_at) >= at - SKEW_MS && Date.parse(r.created_at) <= at + AFTER_MS)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const want = `make-video (${channelId})`;
  for (const r of runs) {
    const jobs = await jobsOf(r.id);
    if (!jobs) return { status: null, runId: null };
    const job = jobs.find((j) => j.name === want);
    if (job) return { status: statusOf(job), runId: r.id };
    // Its matrix is not known until `resolve` finished: this run may still be ours, so no later run is taken in its place
    // (a later dispatch of the same channel would otherwise answer for this one).
    const resolve = jobs.find((j) => j.name === "resolve");
    if (!resolve || resolve.status !== "completed") return { status: { state: "not_seen" }, runId: null };
  }
  return { status: { state: "not_seen" }, runId: null };
}

/**
 * Null when GitHub could not be asked or did not answer (not configured, over a budget, a timeout, a 4xx/5xx): the view then says the
 * workflow's status is not known, never "queued" or "not seen". `mayAsk` is the person's own rate limit, charged only when GitHub
 * would actually be asked.
 */
export async function dispatchedRunStatus(
  channelId: string,
  dispatchedAtMs: number,
  mayAsk: () => Promise<boolean> = async () => true,
): Promise<WorkflowRunStatus | null> {
  if (!isGithubConfigured) return null;
  const key = `${channelId}|${Math.floor(dispatchedAtMs / 1000)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (!(await mayAsk())) return hit ? hit.value : null;
  const pinned = hit?.runId ?? null;
  const entry: Entry = { at: Date.now(), runId: pinned, value: Promise.resolve(null) };
  entry.value = (async () => {
    if (pinned !== null) {
      // The run was found before: one call for its jobs, never a search that could land on another run.
      const jobs = await jobsOf(pinned);
      const job = jobs?.find((j) => j.name === `make-video (${channelId})`);
      return job ? statusOf(job) : null;
    }
    const found = await find(channelId, dispatchedAtMs);
    entry.runId = found.runId;
    return found.status;
  })();
  if (cache.size >= CACHE_MAX && !cache.has(key)) cache.delete(cache.keys().next().value as string);
  cache.set(key, entry);
  return entry.value;
}

/** Tests only. */
export function clearRunStatusCache(): void {
  cache.clear();
  spent = [];
}
