/**
 * What a spending-limit change does, in one word, so the confirm sheet can say it before the press.
 * `null` is "no limit of its own", which is the loosest setting there is: going to it is a removal, coming from it
 * is a new limit. A limit of 0 blocks every call, so it is called out on its own rather than as "lower".
 * Pure, so the wording's branches are tested rather than eyeballed on a phone.
 */
export type LimitEffect = "same" | "up" | "down" | "removed" | "set" | "blocked";

export function limitEffect(oldCents: number | null, newCents: number | null): LimitEffect {
  if (oldCents === newCents) return "same";
  if (newCents === 0) return "blocked";
  if (newCents === null) return "removed";
  if (oldCents === null) return "set";
  return newCents > oldCents ? "up" : "down";
}

/**
 * The limit that actually applies to an account: its own, held down by the plan's ceiling, or the ceiling when it has
 * none. This is the server's rule (min(cap, limit ?? cap)), so the sheet shows what will really happen, not what was
 * typed. `ceiling` null means the plan has no ceiling to bind.
 */
export function effectiveOrgLimit(limitCents: number | null, ceilingCents: number | null): number | null {
  if (ceilingCents === null) return limitCents;
  return Math.min(limitCents ?? ceilingCents, ceilingCents);
}
