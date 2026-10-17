import { fmt } from "@/lib/i18n/core";
import type { Dictionary } from "@/lib/i18n";

/**
 * The words for a failed write to /api/setup/secrets or /api/setup/variables.
 *
 * Maps the route's stable error codes to short, translated sentences. The only
 * thing ever put into a sentence is the secret or variable NAME the server
 * names (and only if it looks like one): never the value, a prefix of it or its
 * length, and never the reason text of a refused value.
 */
export function setupFailureText(
  t: Pick<Dictionary, "providers" | "mfa">,
  data: { error?: unknown; name?: unknown; reason?: unknown } | null | undefined,
  fallback: string,
): string {
  switch (data?.error) {
    case "mfa_recent_required":
      return t.mfa.recentRequired;
    case "mfa_enrol_required":
      return t.mfa.enrolRequired;
    case "rate_limited":
      return t.providers.rateLimited;
    case "bad_value": {
      const name = typeof data.name === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(data.name) ? data.name : null;
      return name ? fmt(t.providers.badValue, { name }) : fallback;
    }
    default:
      return fallback;
  }
}
