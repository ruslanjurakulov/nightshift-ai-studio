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
