"use client";

import { useEffect, useSyncExternalStore } from "react";
import { coerceAccount, type CreditAccount } from "@/lib/credits";

/**
 * The open organization's credit account as last read, shared by the header's credit pill and the Studio's price key.
 *
 * WHY: the pill read the value the layout rendered with, and nothing re-read it, so after Generate it went on showing 400 while
 * 25 were held (Pixel audit, 2026-11-13); the price key could not tell that a price was more than the balance. The layout's reading
 * SEEDS this store (with the time the server read it); refreshCredits() re-reads the account (GET /api/credits/account, the member's
 * own RLS read) after a generation is started, cancelled or finished, and when the tab comes back into view.
 *
 * Only an organization the layout seeded is ever read: the operator's exempt organization (no pill) and a database without 0020
 * stay unseeded, so nothing here asks for them or shows a number for them. A read that fails keeps the last value (never a zero);
 * when that read followed something that moved credits (a hold, a cancel, a finished job), the value is marked `stale` until a read
 * succeeds, and the pill says it may be out of date. Nothing here spends or holds: it only reads.
 */

type Entry = {
  orgId: string;
  account: CreditAccount;
  /** The server reading this entry was seeded from (the layout's read time), so the same reading seen again changes nothing. */
  seedToken: string;
  /** When this browser last read the account itself (ms); a server reading older than that never replaces it. 0 = never. */
  fetchedAt: number;
  /** A read after a change of credits failed: the number may not include that change. */
  stale: boolean;
};

let entry: Entry | null = null;
const listeners = new Set<() => void>();
/** One read at a time per organization; a request that arrives while one is running asks for one more read after it (trailing). */
const flights = new Map<string, { running: Promise<void>; again: boolean; mutation: boolean }>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * The layout's reading for `orgId`, read on the server at `readAt` (ISO). A new reading replaces what the store holds unless this
 * browser read the account itself after it (a cached page replayed by back navigation must not undo a fresher read). Without
 * `readAt` the reading is told apart by its numbers.
 */
export function seedCredits(orgId: string | null, account: CreditAccount | null, readAt?: string | null): void {
  if (!orgId || !account) return;
  const token = readAt || `${account.balance}/${account.reserved}`;
  if (entry && entry.orgId === orgId) {
    if (entry.seedToken === token) return;
    const at = readAt ? Date.parse(readAt) : NaN;
    if (entry.fetchedAt && Number.isFinite(at) && at < entry.fetchedAt) return;
  }
  entry = { orgId, account, seedToken: token, fetchedAt: 0, stale: false };
  emit();
}

/** The account the store holds for `orgId`, or null (not seeded: exempt, not supported, or another organization). */
export function creditsFor(orgId: string | null | undefined): CreditAccount | null {
  return orgId && entry && entry.orgId === orgId ? entry.account : null;
}

/** Whether the value held for `orgId` may miss a change (a read after a hold, a cancel or a finished job failed). */
export function creditsStale(orgId: string | null | undefined): boolean {
  return !!(orgId && entry && entry.orgId === orgId && entry.stale);
}

async function readOnce(orgId: string, mutation: boolean): Promise<void> {
  let account: CreditAccount | null = null;
  try {
    const res = await fetch(`/api/credits/account?org_id=${encodeURIComponent(orgId)}`, { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { account?: unknown } | null;
      if (body && body.account && typeof body.account === "object") account = coerceAccount(body.account);
    }
  } catch {
    account = null;
  }
  // Another organization was opened meanwhile: this answer is not its.
  if (!entry || entry.orgId !== orgId) return;
  if (account) entry = { ...entry, account, fetchedAt: Date.now(), stale: false };
  else if (mutation) entry = { ...entry, stale: true };
  else return;
  emit();
}

/**
 * Re-reads the seeded organization's account. `cause` "mutation" (the default): something just moved credits, so a failed read
 * marks the value stale; "view": the tab came back into view. A call while a read is running does not reuse that read (it may have
 * started before the hold): one more read follows it. No-op for an organization that was not seeded. Resolves once the store holds
 * the answer of a read that started after this call.
 */
export function refreshCredits(orgId: string | null | undefined, cause: "mutation" | "view" = "mutation"): Promise<void> {
  if (!orgId || !entry || entry.orgId !== orgId) return Promise.resolve();
  const flight = flights.get(orgId);
  if (flight) {
    flight.again = true;
    flight.mutation ||= cause === "mutation";
    return flight.running;
  }
  const f = { running: Promise.resolve(), again: true, mutation: cause === "mutation" };
  f.running = (async () => {
    try {
      while (f.again) {
        f.again = false;
        const mutation = f.mutation;
        f.mutation = false;
        await readOnce(orgId, mutation);
      }
    } finally {
      flights.delete(orgId);
    }
  })();
  flights.set(orgId, f);
  return f.running;
}

/**
 * The live account and whether it may be out of date. With `seed` (the header): the layout's reading seeds the store, and a tab
 * that comes back into view re-reads it. `seed` null = the layout shows no credits for this organization: then neither does this,
 * whatever the store holds.
 */
export function useLiveCreditsState(
  orgId: string | null | undefined,
  seed?: CreditAccount | null,
  readAt?: string | null,
): { account: CreditAccount | null; stale: boolean } {
  const seeding = seed !== undefined;
  const balance = seed?.balance;
  const reserved = seed?.reserved;
  // Seeded after render (an update to the store during render would re-render other components mid-render).
  useEffect(() => {
    if (seeding && orgId && balance !== undefined && reserved !== undefined)
      seedCredits(orgId, coerceAccount({ balance, reserved }), readAt ?? null);
  }, [seeding, orgId, balance, reserved, readAt]);
  const live = useSyncExternalStore(subscribe, () => (orgId && entry && entry.orgId === orgId ? entry : null), () => null);
  const hasSeed = !!seed;
  useEffect(() => {
    if (!seeding || !orgId || !hasSeed) return;
    const onShow = () => {
      if (document.visibilityState === "visible") void refreshCredits(orgId, "view");
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [seeding, orgId, hasSeed]);
  if (!seeding) return { account: live?.account ?? null, stale: live?.stale ?? false };
  if (!seed) return { account: null, stale: false };
  return { account: live?.account ?? seed, stale: live?.stale ?? false };
}

/** The live account for `orgId` (see useLiveCreditsState). */
export function useLiveCredits(orgId: string | null | undefined, seed?: CreditAccount | null, readAt?: string | null): CreditAccount | null {
  return useLiveCreditsState(orgId, seed, readAt).account;
}

/** Tests only: forget everything. */
export function resetCreditsLive(): void {
  entry = null;
  flights.clear();
  emit();
}
