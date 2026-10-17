import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { takeLocal, type RateRule } from "@/lib/server/web-rate";

/**
 * What the GitHub secret / variable / key-check routes do around a write, besides
 * the write itself (docs/security/ADMIN_MFA.md, "Secrets and variables"):
 *
 * - a small in-process rate limit per person, so a stolen session cannot loop
 *   over the allow-list (a fixed window; per server process, which is exactly
 *   as strong as it needs to be here: it never refuses on an infrastructure
 *   error, so it cannot lock the owner out);
 * - one server log line per written name with a SHA-256 prefix of the value, so
 *   "this key changed at 03:12" is answerable from the logs and a replaced value
 *   can be told from a re-saved one. The value itself, its length and any part
 *   of it are never logged. (Eight hex characters of a hash are 32 bits: not a
 *   fragment of the value and no way back to it for a key of real entropy.)
 */

export const SECRET_WRITE_RATE: RateRule = { bucket: "setup.secrets", max: 20, windowSeconds: 600 };
export const VARIABLE_WRITE_RATE: RateRule = { bucket: "setup.variables", max: 40, windowSeconds: 600 };
export const YOUTUBE_CHECK_RATE: RateRule = { bucket: "setup.youtube", max: 30, windowSeconds: 600 };

/** The 429 to send when `userId` is over `rule`, or null. Counts the call. */
export function rateLimitRefusal(userId: string, rule: RateRule, now: number = Date.now()): NextResponse | null {
  if (takeLocal(userId, rule, now)) return null;
  return NextResponse.json(
    { error: "rate_limited" },
    { status: 429, headers: { "retry-after": String(rule.windowSeconds), "cache-control": "no-store" } },
  );
}

/** The first 8 hex characters of SHA-256(value). */
export function valueFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

/** One line per written name: who (id prefix), what kind, which name, which value (hash prefix). Never the value. */
export function logAdminWrite(
  kind: "secret" | "variable",
  userId: string,
  entries: ReadonlyArray<{ name: string; value: string }>,
): void {
  for (const { name, value } of entries) {
    console.info(`[admin-write] ${kind} user=${userId.slice(0, 8)} name=${name} sha256=${valueFingerprint(value)}`);
  }
}
