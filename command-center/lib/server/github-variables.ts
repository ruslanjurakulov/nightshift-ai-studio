import "server-only";
import { GITHUB_REPO, GITHUB_TOKEN, isGithubConfigured } from "./github-secrets";

/**
 * GitHub Actions **repository variables** — the pipeline's routing switches.
 *
 * These are the plain (non-secret) settings the daily-video workflow forwards
 * into the run as `CHRONOS_*` env vars: which video generator and image
 * generator the pipeline uses, and whether the autopilot picks the day's topic.
 * Unlike secrets, variables ARE readable, so the Providers board can show the
 * current selection and change it — this is what turns "I pasted a Higgsfield
 * key" into "the pipeline actually renders with Higgsfield".
 *
 * The token is the same server-only one the secrets writer uses; this file is
 * `server-only`, so it can never ship to the browser. Only the names below may
 * be written — an allowlist, so an authenticated caller can never repoint an
 * unrelated variable the workflow trusts.
 */

/** The only variable names this endpoint may read or write. */
export const WRITABLE_VARIABLES = [
  "CHRONOS_VIDEO_PROVIDER",
  "CHRONOS_IMAGE_PROVIDER",
  "CHRONOS_ENABLE_VIDEO_GEN",
  "CHRONOS_ENABLE_MINIMAX_BROLL",
  "CHRONOS_ENABLE_IMAGE_GEN",
  "CHRONOS_AGENT_AUTOPILOT",
] as const;

export type WritableVariable = (typeof WRITABLE_VARIABLES)[number];

const ALLOW = new Set<string>(WRITABLE_VARIABLES);

export function isWritableVariable(name: string): name is WritableVariable {
  return ALLOW.has(name);
}

async function gh(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

function ghError(status: number): Error {
  return new Error(
    status === 401 || status === 403
      ? "github_unauthorized"
      : status === 404
        ? "github_repo_not_found"
        : "github_unavailable",
  );
}

/**
 * Current values of the allowlisted variables, as a name→value map. A variable
 * that has never been set is simply absent from the map (GitHub 404s it), which
 * the caller reads as "the config default is in effect". A partial/paged listing
 * is fine — one page holds far more than the handful of names here.
 */
export async function readVariables(): Promise<Record<string, string>> {
  if (!isGithubConfigured) return {};
  const res = await gh("/actions/variables?per_page=100");
  if (!res.ok) throw ghError(res.status);
  const body = (await res.json()) as { variables?: { name?: unknown; value?: unknown }[] };
  const out: Record<string, string> = {};
  for (const v of body.variables ?? []) {
    if (typeof v?.name === "string" && ALLOW.has(v.name) && typeof v.value === "string") {
      out[v.name] = v.value;
    }
  }
  return out;
}

/**
 * Create-or-update one variable. GitHub has no upsert, so this PATCHes and
 * falls back to POST when the variable does not exist yet. Returns nothing on
 * success and throws a stable error string otherwise (never GitHub's body,
 * which describes the token's own scopes).
 */
export async function putVariable(name: string, value: string): Promise<void> {
  if (!isWritableVariable(name)) throw new Error("variable_not_allowed");
  if (!isGithubConfigured) throw new Error("github_not_configured");

  const patch = await gh(`/actions/variables/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ name, value }),
  });
  if (patch.status === 204) return;
  if (patch.status === 404) {
    const post = await gh("/actions/variables", {
      method: "POST",
      body: JSON.stringify({ name, value }),
    });
    if (post.status === 201) return;
    throw ghError(post.status);
  }
  throw ghError(patch.status);
}
