/**
 * "Could not read" is not "nothing there" (CLAUDE.md #5).
 *
 * A Supabase query that errors returns `data: null`; the old habit was
 * `data ?? []`, which turned a failed read into a 0, an empty table or a
 * "Not required" switch. Pages now ask `readFailed()` first and render an
 * ErrorState / an "unknown" figure instead. A genuinely empty result (no error,
 * no rows) keeps its normal empty state.
 */

/** Anything with the `error` field a Supabase response carries. */
export type ReadResult = { error?: unknown } | null | undefined;

/** True when any of the reads failed. A missing result (never attempted) is not a failure. */
export function readFailed(...results: ReadResult[]): boolean {
  return results.some((r) => Boolean(r && r.error));
}

/**
 * A count that is only a number when the read behind it succeeded.
 * `null` is what every KPI renders as "unknown".
 */
export function knownCount(value: number, ok: boolean): number | null {
  return ok ? value : null;
}

/**
 * The command-center status chip. Healthy needs evidence: a readable backend,
 * no failures in the last day AND at least one recorded event — an empty event
 * stream is "no activity yet", never "system healthy".
 */
export type ChipState = "unreadable" | "attention" | "noActivity" | "healthy";

export function commandCenterChip(input: { readable: boolean; errors24h: number | null; events: number }): ChipState {
  if (!input.readable) return "unreadable";
  if ((input.errors24h ?? 0) > 0) return "attention";
  if (input.events === 0) return "noActivity";
  return "healthy";
}
