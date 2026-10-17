/**
 * How hard an owner action is to take back, and so how much a confirm sheet
 * asks (docs/design: confirmation tiers). Pure, so the thresholds are tested.
 *
 *   0  reversible, no sheet                    (a filter, a theme)
 *   1  reversible by the owner                  (a safe toggle)
 *   2  money or access, not undoable here       (sheet: the object and the number)
 *   3  large: tier 2 plus typing the figure     (a big grant, a price swing)
 */
import { wouldLeaveNoOwner, type MemberLike } from "@/lib/members-guard";

export type ConfirmTier = 0 | 1 | 2 | 3;

/** A grant above this many credits needs the figure typed back. */
export const GRANT_TYPED_ABOVE = 5000;
/** A price moving by more than this share (0.3 = 30%) needs the new rate typed back. */
export const PRICE_SWING_TYPED_ABOVE = 0.3;

export function grantTier(credits: number): ConfirmTier {
  return credits > GRANT_TYPED_ABOVE ? 3 : 2;
}

/**
 * What the customer is charged per unit is rate x (1 + markup), so the swing is judged on that figure:
 * a markup-only change that moves it past 30% is as large as a rate change. A first price is tier 2.
 */
export function priceChangeTier(oldCharged: number | null, newCharged: number): ConfirmTier {
  if (oldCharged === null || oldCharged <= 0) return 2;
  return Math.abs(newCharged - oldCharged) / oldCharged > PRICE_SWING_TYPED_ABOVE ? 3 : 2;
}

/** A figure smaller than this is not worth typing back (0.0004 is easy to get wrong): the sheet stays tier 2. */
export const MIN_TYPED_FIGURE = 0.001;

/**
 * The text to type for a price save, or undefined when the plain tier-2 sheet is enough. A rate change types
 * the new rate; when the markup moved too, the new customer-charged figure (the number the sheet shows).
 */
export function priceTypedFigure(
  old: { rate: number; margin: number; charged: number } | null,
  next: { rate: number; margin: number; charged: number },
): string | undefined {
  if (priceChangeTier(old ? old.charged : null, next.charged) !== 3) return undefined;
  const figure = old !== null && old.margin === next.margin ? next.rate : next.charged;
  return figure >= MIN_TYPED_FIGURE ? typedFigure(figure) : undefined;
}

/** The figure to type back as plain text: no grouping, no trailing zeros. */
export function typedFigure(n: number): string {
  return String(Number(n.toPrecision(12)));
}

/**
 * Does what the person typed match what we asked for? Case, spaces and the
 * apostrophe-like marks are ignored, and a decimal comma counts as a point (many phone keyboards only have one), so «OʻCHIR» is satisfied by "ochir" on a
 * phone keyboard that has no ʻ.
 */
export function typedMatches(typed: string, expected: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/,/g, ".").replace(/[\s'`ʻʼ’‘]/g, "");
  return norm(typed) === norm(expected) && norm(expected) !== "";
}

/** `{n}` credits at `creditsPerUsd` credits per dollar, as dollars. Null without a usable rate. */
export function creditsToUsd(credits: number, creditsPerUsd: number | null | undefined): number | null {
  if (!creditsPerUsd || !Number.isFinite(creditsPerUsd) || creditsPerUsd <= 0) return null;
  return credits / creditsPerUsd;
}

/** One credit is about a cent of vendor cost (docs/sql/prices_defaults_2026_10_03.sql) when no `usd` price is set. */
export const DEFAULT_CREDITS_PER_USD = 100;

/**
 * Block removing or demoting from the Team page (UI only; the database half needs a migration).
 *  - "last_owner": the only BOUND owner (lib/members-guard, the app-layer guard from the security PR).
 *  - "self": your own row, so an owner or admin never edits their own access by accident.
 */
export type MemberBlock = "self" | "last_owner" | null;
export function memberBlock(
  member: MemberLike & { email: string },
  all: readonly MemberLike[],
  me: { userId: string; email: string },
): MemberBlock {
  if (wouldLeaveNoOwner(all, member.id, "removed")) return "last_owner";
  const mine = (member.user_id !== null && member.user_id === me.userId) || member.email.toLowerCase() === me.email.toLowerCase();
  return mine ? "self" : null;
}
