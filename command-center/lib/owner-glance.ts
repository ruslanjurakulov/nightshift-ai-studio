import { BILLED_PROVIDERS, latestBalance, type BalanceRow } from "@/lib/billing";
import { workerView, type WorkerRow } from "@/lib/workers";
import { isOwnerToday } from "@/lib/owner-time";

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

/** A balance snapshot older than this is not today's number: the tile is never "fine" on it. */
export const BALANCE_STALE_MS = 24 * 60 * 60 * 1000;

/** Is the snapshot older than a day (or unreadable)? */
export function balanceStale(checkedAt: string, nowMs: number): boolean {
  const at = Date.parse(checkedAt);
  return !Number.isFinite(at) || nowMs - at > BALANCE_STALE_MS;
}

/** Critical below 5%, low below 20%; a stale snapshot caps at warn, since the real figure may be lower. */
export function balanceTone(pct: number, stale = false): GlanceTone {
  const tone: GlanceTone = pct < BALANCE_CRITICAL_PCT ? "fail" : pct < BALANCE_LOW_PCT ? "warn" : "ok";
  return stale && tone === "ok" ? "warn" : tone;
}

export interface WorkersAlive {
  alive: number;
  total: number;
  /** Workers that said they run but whose heartbeat is stale, plus ones that reported a failure. */
  silent: number;
  /** Workers that reported a clean stop: not broken, but not working either. */
  stopped: number;
}

/** How many registered workers are reporting right now (a running worker with a stale heartbeat is not; a stopped one is counted apart). */
export function workersAlive(rows: WorkerRow[], nowMs: number): WorkersAlive {
  let alive = 0;
  let silent = 0;
  let stopped = 0;
  for (const r of rows) {
    const shown = workerView(r, nowMs).shown;
    if (shown === "running" || shown === "starting") alive += 1;
    else if (shown === "notReporting" || shown === "failed") silent += 1;
    else if (shown === "stopped") stopped += 1;
  }
  return { alive, total: rows.length, silent, stopped };
}

/**
 * The workers tile's tone: fine only when every registered worker is alive. A stopped or silent worker is
 * never "all reporting"; with none alive it is a failure.
 */
export function workersTone(w: WorkersAlive | null): GlanceTone {
  if (!w || w.total === 0) return "idle";
  if (w.alive === w.total) return "ok";
  return w.alive === 0 ? "fail" : "warn";
}

/** How many rows of today's cost ledger the page reads; a day that fills it is not summed. */
export const SPEND_ROW_LIMIT = 1000;

export type SpendToday =
  /** The read failed or timed out: unknown, worth a Retry. */
  | { kind: "failed" }
  /** The nightly mirror has not written anything today (Tashkent day): today's spend is not in the ledger yet. */
  | { kind: "not_synced" }
  /** The mirror ran today and there are no rows for today: "no rows yet", never a measured $0. */
  | { kind: "no_rows" }
  /** So many rows that they are not added up here (the figure would be a floor). Not a read failure. */
  | { kind: "too_many" }
  /** Only unpriced rows today: there is no figure. */
  | { kind: "not_priced" }
  | { kind: "ok"; usd: number; unpriced: number };

/**
 * What the pipeline spent today, from the cost ledger rows of the owner's day. The ledger is MIRRORED (nightly), so a
 * figure is only shown when the newest `synced_at` is on the owner's day: before that, "$0.00" would be the mirror's age,
 * not a measurement. A row without `estimated_usd` is not $0: it is counted as unpriced, and a day with only unpriced rows
 * has no figure at all.
 */
export function spendToday(input: {
  rows: { quantity?: number | null; estimated_usd?: number | string | null }[] | null;
  /** The newest `video_costs.synced_at` (any row), or null when it could not be read / there is none. */
  newestSyncMs: number | null;
  failed: boolean;
  nowMs: number;
}): SpendToday {
  if (input.failed || input.rows === null) return { kind: "failed" };
  if (input.newestSyncMs === null || !isOwnerToday(input.newestSyncMs, input.nowMs)) return { kind: "not_synced" };
  if (input.rows.length >= SPEND_ROW_LIMIT) return { kind: "too_many" };
  if (input.rows.length === 0) return { kind: "no_rows" };
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const r of input.rows) {
    const v = typeof r.estimated_usd === "string" ? Number(r.estimated_usd) : r.estimated_usd;
    if (typeof v === "number" && Number.isFinite(v)) {
      usd += v;
      priced += 1;
    } else if ((r.quantity ?? 0) > 0) {
      unpriced += 1;
    }
  }
  return priced > 0 ? { kind: "ok", usd, unpriced } : { kind: "not_priced" };
}
