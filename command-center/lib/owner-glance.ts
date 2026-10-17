import { BILLED_PROVIDERS, latestBalance, type BalanceRow } from "@/lib/billing";
import { workerView, type WorkerRow } from "@/lib/workers";

/**
 * The numbers on the Command Center's phone strip, derived from rows the page already reads (provider
 * balance snapshots, worker heartbeats). Pure; tests/owner-glance.test.ts pins them. An unknown stays null:
 * the strip says "unknown", never a 0 and never a green tick (CLAUDE.md rule 5).
 */

/** Below this share of a provider's allowance left, the balance reads as running low (warn). */
export const BALANCE_LOW_PCT = 20;
/** Below this it reads as about to run out (fail). */
export const BALANCE_CRITICAL_PCT = 5;

export interface LowestBalance {
  provider: string;
  name: string;
  /** Whole percent of the allowance left, 0-100. */
  pct: number;
  checkedAt: string;
}

/**
 * The provider with the least of its allowance left, from the newest snapshot of each. Only a snapshot that
 * says both how much is left and how much there was counts; a provider with no balance API (or a snapshot
 * with no total) is skipped, not counted as empty. Null when no provider reports a usable balance.
 */
export function lowestProviderBalance(rows: BalanceRow[]): LowestBalance | null {
  let worst: LowestBalance | null = null;
  for (const p of BILLED_PROVIDERS) {
    const snap = latestBalance(rows, p.id);
    if (!snap || snap.remaining === null || snap.total === null) continue;
    const remaining = Number(snap.remaining);
    const total = Number(snap.total);
    if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) continue;
    const pct = Math.min(100, Math.max(0, Math.round((remaining / total) * 100)));
    if (!worst || pct < worst.pct) worst = { provider: p.id, name: p.name, pct, checkedAt: snap.checked_at };
  }
  return worst;
}

export type GlanceTone = "ok" | "warn" | "fail" | "idle";

export function balanceTone(pct: number): GlanceTone {
  return pct < BALANCE_CRITICAL_PCT ? "fail" : pct < BALANCE_LOW_PCT ? "warn" : "ok";
}

export interface WorkersAlive {
  alive: number;
  total: number;
  /** Workers that said they run but whose heartbeat is stale, plus ones that reported a failure. */
  silent: number;
}

/** How many registered workers are reporting right now (a running worker with a stale heartbeat is not). */
export function workersAlive(rows: WorkerRow[], nowMs: number): WorkersAlive {
  let alive = 0;
  let silent = 0;
  for (const r of rows) {
    const shown = workerView(r, nowMs).shown;
    if (shown === "running" || shown === "starting") alive += 1;
    else if (shown === "notReporting" || shown === "failed") silent += 1;
  }
  return { alive, total: rows.length, silent };
}
