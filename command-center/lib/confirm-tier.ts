/**
 * How hard an owner action is to take back, and so how much a confirm sheet
 * asks (docs/design: confirmation tiers). Pure, so the thresholds are tested.
 *
 *   0  reversible, no sheet                    (a filter, a theme)
 *   1  reversible by the owner                  (a safe toggle)
 *   2  money or access, not undoable here       (sheet: the object and the number)
 *   3  large: tier 2 plus typing the figure     (a big grant, a price swing)
 */
export type ConfirmTier = 0 | 1 | 2 | 3;

/** A grant above this many credits needs the figure typed back. */
export const GRANT_TYPED_ABOVE = 5000;
/** A price moving by more than this share (0.3 = 30%) needs the new rate typed back. */
export const PRICE_SWING_TYPED_ABOVE = 0.3;

export function grantTier(credits: number): ConfirmTier {
  return credits > GRANT_TYPED_ABOVE ? 3 : 2;
}

/** A first price (no old rate) is tier 2; so is a swing up to 30%. A deleted price is always 2. */
export function priceChangeTier(oldRate: number | null, newRate: number): ConfirmTier {
  if (oldRate === null || oldRate <= 0) return 2;
  return Math.abs(newRate - oldRate) / oldRate > PRICE_SWING_TYPED_ABOVE ? 3 : 2;
}

/** The figure to type back as plain text: no grouping, no trailing zeros. */
export function typedFigure(n: number): string {
  return String(Number(n.toPrecision(12)));
}

/**
 * Does what the person typed match what we asked for? Case, spaces and the
 * apostrophe-like marks are ignored, so «OʻCHIR» is satisfied by "ochir" on a
 * phone keyboard that has no ʻ.
 */
export function typedMatches(typed: string, expected: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s'`ʻʼ’‘]/g, "");
  return norm(typed) === norm(expected) && norm(expected) !== "";
}

/** `{n}` credits at `creditsPerUsd` credits per dollar, as dollars. Null without a usable rate. */
export function creditsToUsd(credits: number, creditsPerUsd: number | null | undefined): number | null {
  if (!creditsPerUsd || !Number.isFinite(creditsPerUsd) || creditsPerUsd <= 0) return null;
  return credits / creditsPerUsd;
}

/** One credit is about a cent of vendor cost (docs/sql/prices_defaults_2026_10_03.sql) when no `usd` price is set. */
export const DEFAULT_CREDITS_PER_USD = 100;

/** Block removing or demoting your own row, or the last owner (UI-side; the database guard needs a migration). */
export type MemberBlock = "self" | "last_owner" | null;
export function memberBlock(
  member: { id: string; user_id: string | null; email: string; role: string },
  all: { role: string }[],
  me: { userId: string; email: string },
): MemberBlock {
  const owners = all.filter((m) => m.role === "owner").length;
  if (member.role === "owner" && owners <= 1) return "last_owner";
  const mine = (member.user_id !== null && member.user_id === me.userId) || member.email.toLowerCase() === me.email.toLowerCase();
  return mine ? "self" : null;
}
