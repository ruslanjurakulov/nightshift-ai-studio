/** Why a render job failed, in the closed set modules/render_error.py writes. */
export const JOB_ERROR_CODES = ["credits", "voice", "provider_quota", "media", "render", "timeout", "held", "switched_off", "channel_reconnect_required", "credentials_missing", "spend_ceiling", "unknown"] as const;
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
