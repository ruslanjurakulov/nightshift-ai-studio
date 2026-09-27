/**
 * The account panel's numbers — the pure half, client-safe and unit-tested.
 *
 * Everything here is derived from rows the signed-in user's own session read
 * (migration 0020's ledger, RLS: an organization's viewers). Nothing is
 * assumed: a value that could not be read is null, and the panel shows "—".
 */

import { CREDIT_PACKS, type CreditPackId } from "@/lib/paddle";
// Type-only: erased at build, so this client-safe file never loads the server module.
import type { ConnectedAccount } from "@/lib/connectedAccounts";

export type { ConnectedAccount, Platform } from "@/lib/connectedAccounts";

/**
 * What the panel calls the account's plan.
 *
 * - `free`      — the ledger has no purchase: only grants (the welcome grant,
 *                 an operator top-up) or nothing at all.
 * - `pack`      — the last purchase was this pack (the largest one, when a
 *                 single checkout bought several).
 * - `purchased` — there is a purchase, but its pack cannot be told from the
 *                 row (an older note format, a custom amount). Said as
 *                 "credits purchased" — never guessed into a pack name.
 * - `exempt`    — the operator's own organization, which is never charged.
 * - `unknown`   — the ledger could not be read (no organization, 0020 not
 *                 applied, a failed query).
 */
export type Plan =
  | { kind: "free" }
  | { kind: "pack"; pack: CreditPackId }
  | { kind: "purchased" }
  | { kind: "exempt" }
  | { kind: "unknown" };

/** One credit_transactions row, as far as the plan needs it. */
export interface LedgerPurchaseRow {
  kind: string;
  amount: number | string | null;
  note: string | null;
  created_at?: string | null;
}

const PACK_IDS = CREDIT_PACKS.map((p) => p.id) as readonly CreditPackId[];
const PACK_CREDITS: Record<CreditPackId, number> = Object.fromEntries(
  CREDIT_PACKS.map((p) => [p.id, p.credits]),
) as Record<CreditPackId, number>;

/**
 * The pack a purchase row was for.
 *
 * The Paddle webhook writes the note as `Paddle txn_…: 1× creator, 2× starter`
 * (supabase/functions/_shared/paddle.ts). When several packs were bought in
 * one checkout, the largest names the plan. A note that names none falls back
 * to the amount, only when it is exactly one pack's credits; otherwise null.
 */
export function packFromPurchase(row: Pick<LedgerPurchaseRow, "amount" | "note">): CreditPackId | null {
  const found = new Set<CreditPackId>();
  const note = row.note ?? "";
  for (const m of note.matchAll(/\d+\s*[×x]\s*([a-z]+)/gi)) {
    const id = m[1].toLowerCase();
    if ((PACK_IDS as readonly string[]).includes(id)) found.add(id as CreditPackId);
  }
  if (found.size > 0) {
    return [...found].sort((a, b) => PACK_CREDITS[b] - PACK_CREDITS[a])[0];
  }
  const amount = Number(row.amount);
  if (!Number.isFinite(amount)) return null;
  return PACK_IDS.find((id) => PACK_CREDITS[id] === amount) ?? null;
}

/**
 * The plan from the organization's purchase rows (any order; other kinds are
 * ignored). `null` means the ledger could not be read — unknown, not free.
 */
export function derivePlan(rows: readonly LedgerPurchaseRow[] | null | undefined): Plan {
  if (!rows) return { kind: "unknown" };
  const purchases = rows
    .filter((r) => r.kind === "purchase")
    .map((r, i) => ({ r, i, t: r.created_at ? Date.parse(r.created_at) : NaN }))
    // Newest first; rows without a time keep the order they were given in.
    .sort((a, b) => (Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t ? b.t - a.t : a.i - b.i));
  if (purchases.length === 0) return { kind: "free" };
  const pack = packFromPurchase(purchases[0].r);
  return pack ? { kind: "pack", pack } : { kind: "purchased" };
}

/**
 * Credits charged for finished runs: the sum of the ledger's `capture` rows
 * (0020 writes them negative). `total` is the row count the database reported;
 * when fewer rows than that were read, the sum would be short, so it is null.
 */
export function creditsSpent(
  rows: readonly { kind?: string; amount: number | string | null; job_id?: string | null }[] | null | undefined,
  total: number | null | undefined,
): number | null {
  if (!rows) return null;
  if (typeof total === "number" && total > rows.length) return null;
  let sum = 0;
  for (const r of rows) {
    // A failed paid download (0030) is refunded with a positive 'refund' row
    // on the same job: it nets out of what was spent.
    const downloadRefund = r.kind === "refund" && (r.job_id ?? "").startsWith("download:");
    if (r.kind !== undefined && r.kind !== "capture" && !downloadRefund) continue;
    const n = Number(r.amount);
    if (!Number.isFinite(n)) return null;
    sum += -n;
  }
  // Ledger amounts are numeric(14,2); keep the sum at that precision.
  return Math.round(sum * 100) / 100;
}

/** The credits block of the panel. `available` = balance − reserved (on hold). */
export interface AccountCredits {
  available: number;
  reserved: number;
  /** Null when the capture rows could not all be read. */
  spent: number | null;
}

/** What GET /api/account returns. */
export interface AccountSummary {
  email: string | null;
  plan: Plan;
  /** Null for the operator's exempt organization, before 0020, or on error. */
  credits: AccountCredits | null;
  accounts: ConnectedAccount[];
  /** Instagram / TikTok: true when the deployment has that platform's app
   *  keys, so the panel links to Connect instead of "coming soon". */
  connectable: { instagram: boolean; tiktok: boolean };
}

/** Coerce the route's JSON; anything malformed reads as unknown / empty. */
export function coerceAccountSummary(data: unknown): AccountSummary | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const plan = coercePlan(d.plan);
  const c = d.credits as Record<string, unknown> | null | undefined;
  const credits =
    c && typeof c === "object" && Number.isFinite(c.available) && Number.isFinite(c.reserved)
      ? {
          available: c.available as number,
          reserved: c.reserved as number,
          spent: Number.isFinite(c.spent) ? (c.spent as number) : null,
        }
      : null;
  const accounts = Array.isArray(d.accounts)
    ? (d.accounts as unknown[]).filter(isConnectedAccount)
    : [];
  const k = (d.connectable ?? {}) as Record<string, unknown>;
  const connectable = { instagram: k.instagram === true, tiktok: k.tiktok === true };
  return { email: typeof d.email === "string" ? d.email : null, plan, credits, accounts, connectable };
}

function coercePlan(v: unknown): Plan {
  const p = v as { kind?: unknown; pack?: unknown } | null;
  if (!p || typeof p !== "object") return { kind: "unknown" };
  if (p.kind === "pack" && (PACK_IDS as readonly unknown[]).includes(p.pack))
    return { kind: "pack", pack: p.pack as CreditPackId };
  if (p.kind === "free" || p.kind === "purchased" || p.kind === "exempt") return { kind: p.kind };
  return { kind: "unknown" };
}

function isConnectedAccount(v: unknown): v is ConnectedAccount {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    (a.platform === "youtube" || a.platform === "instagram" || a.platform === "tiktok") &&
    typeof a.id === "string" &&
    typeof a.name === "string" &&
    (a.avatarUrl === null || typeof a.avatarUrl === "string") &&
    typeof a.connected === "boolean"
  );
}
