import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * A per-user rate limit for Command Center routes that spend the operator's
 * quota on each call (ElevenLabs characters, Actions minutes, a key check
 * against ElevenLabs). The count lives in the database (take_web_rate,
 * migration 0042), so it holds across serverless instances.
 *
 * Before 0042 is applied the function does not exist; the limit then falls
 * back to a counter in this process — weaker (per instance), but never
 * "unlimited". Any other failure refuses the request: an unknown count is not
 * permission to spend.
 */

export type RateDecision = "ok" | "limited" | "unavailable";

export interface RateRule {
  /** [a-z0-9_.:-]{1,64} — the database refuses anything else. */
  bucket: string;
  max: number;
  windowSeconds: number;
}

export const VOICE_LIST_RATE: RateRule = { bucket: "elevenlabs.voices", max: 20, windowSeconds: 3600 };
export const VOICE_PREVIEW_RATE: RateRule = { bucket: "elevenlabs.preview", max: 10, windowSeconds: 3600 };
/** Notification channel controls (pause, disconnect, language): a few real edits, not a loop. The link, test and
 *  preference calls are limited again inside their own database functions (0102). */
export const NOTIFY_CHANNEL_RATE: RateRule = { bucket: "notify.channel", max: 60, windowSeconds: 3600 };
/** Profile photo changes (upload or remove) per person: a few real edits, not a loop. */
export const AVATAR_WRITE_RATE: RateRule = { bucket: "avatar.write", max: 20, windowSeconds: 3600 };

/**
 * The editor's writes, per person. They protect the database and the worker
 * from a loop, not a person from their own pace: the editor saves when the
 * person presses save or exports (its draft autosave is local), a few times a
 * minute at the very most, so each limit is 5-10x what real editing needs. A
 * refused save says "rate_limited" (429, retry-after) and the editor keeps its
 * unsaved work in the local draft.
 */
/** Saves of a project (PUT): 300 per 10 minutes = 30 a minute. */
export const EDITOR_SAVE_RATE: RateRule = { bucket: "editor.save", max: 300, windowSeconds: 600 };
/** New projects (POST): 60 an hour; one organization may hold only so many anyway. */
export const EDITOR_CREATE_RATE: RateRule = { bucket: "editor.create", max: 60, windowSeconds: 3600 };
/** Export requests (POST): 30 an hour; the database also allows one at a time and a daily count. */
export const EDITOR_EXPORT_RATE: RateRule = { bucket: "editor.export", max: 30, windowSeconds: 3600 };
/** "Open in editor" sends (POST): 120 per 10 minutes = 12 a minute. */
export const EDITOR_SEND_RATE: RateRule = { bucket: "editor.send", max: 120, windowSeconds: 600 };

const local = new Map<string, { start: number; count: number }>();

/** The in-process fallback (pre-0042). Exported for tests. */
export function takeLocal(userId: string, rule: RateRule, now = Date.now()): boolean {
  const windowMs = rule.windowSeconds * 1000;
  const start = Math.floor(now / windowMs) * windowMs;
  const key = `${userId}:${rule.bucket}`;
  const cur = local.get(key);
  const next = cur && cur.start === start ? { start, count: cur.count + 1 } : { start, count: 1 };
  local.set(key, next);
  return next.count <= rule.max;
}

function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? "");
}

export async function takeWebRate(userId: string, rule: RateRule): Promise<RateDecision> {
  const supabase = await createClient();
  if (!supabase) return "unavailable";
  try {
    const { data, error } = await supabase.rpc("take_web_rate", {
      p_bucket: rule.bucket,
      p_max: rule.max,
      p_window_seconds: rule.windowSeconds,
    });
    if (error) {
      if (isMissingFunction(error)) return takeLocal(userId, rule) ? "ok" : "limited";
      return "unavailable";
    }
    return data === true ? "ok" : "limited";
  } catch {
    return "unavailable";
  }
}

/** The route's answer for a refused decision. */
export function rateRefusal(decision: Exclude<RateDecision, "ok">, rule: RateRule) {
  return decision === "limited"
    ? { body: { error: "rate_limited" }, status: 429, headers: { "retry-after": String(rule.windowSeconds) } }
    : { body: { error: "rate_limit_unavailable" }, status: 503, headers: {} as Record<string, string> };
}
