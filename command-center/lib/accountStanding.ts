export type StandingKey = "live" | "liveFailing" | "paused" | "draft";
export type StandingTone = "ok" | "warn" | "fail" | "idle";

/**
 * A channel that is switched on is not the same as a channel that works. The
 * row used to show a green "live" lamp beside 6-13 failures and 0 uploads, so
 * the first thing a reader saw contradicted the number next to it (rule 5).
 * Only a live channel can be downgraded; paused and draft channels never run,
 * so their failure counts say nothing about their standing.
 *
 * Failures with nothing ever uploaded is red (it has never worked); failures
 * on a channel that has uploaded is amber (it works, but not reliably).
 */
export function accountStanding(a: {
  standing: "live" | "paused" | "draft";
  failures: number;
  published: number;
}): { key: StandingKey; tone: StandingTone } {
  if (a.standing === "paused" || a.standing === "draft") return { key: a.standing, tone: "idle" };
  if (a.failures > 0) return { key: "liveFailing", tone: a.published > 0 ? "warn" : "fail" };
  return { key: "live", tone: "ok" };
}
