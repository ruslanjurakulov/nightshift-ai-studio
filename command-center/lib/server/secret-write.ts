import "server-only";
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
 * - one server log line per name written or refused, so "this key changed at
 *   03:12" is answerable from the logs: who (a user-id prefix), which NAME, and
 *   the outcome (accepted, or rejected with the reason code). Nothing derived
 *   from the value is ever logged: no hash, no length, no prefix, no fragment
 *   (CLAUDE.md, non-negotiable 1).
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

export type WriteOutcome = { outcome: "accepted" } | { outcome: "rejected"; reason: string };

/** One line per name: who (id prefix), what kind, which name, the outcome. Never anything about the value. */
export function logAdminWrite(kind: "secret" | "variable", userId: string, name: string, result: WriteOutcome): void {
  const tail = result.outcome === "rejected" ? ` outcome=rejected reason=${result.reason}` : " outcome=accepted";
  console.info(`[admin-write] ${kind} user=${userId.slice(0, 8)} name=${name}${tail}`);
}
