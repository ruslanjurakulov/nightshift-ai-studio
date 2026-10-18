/**
 * What a spending-limit change does, in one word, so the confirm sheet can say it before the press.
 * `null` is "no limit of its own", which is the loosest setting there is: going to it is a removal, coming from it
 * is a new limit. Pure, so the wording's branches are tested rather than eyeballed on a phone.
 */
export type LimitEffect = "same" | "up" | "down" | "removed" | "set";

export function limitEffect(oldCents: number | null, newCents: number | null): LimitEffect {
  if (oldCents === newCents) return "same";
  if (newCents === null) return "removed";
  if (oldCents === null) return "set";
  return newCents > oldCents ? "up" : "down";
}
