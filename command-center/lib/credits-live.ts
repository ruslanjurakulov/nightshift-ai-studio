"use client";

import { useEffect, useSyncExternalStore } from "react";
import { coerceAccount, type CreditAccount } from "@/lib/credits";

/**
 * The open organization's credit account as last read, shared by the header's credit pill and the Studio's price key.
 *
 * WHY: the pill read the value the layout rendered with, and nothing re-read it, so after Generate it went on showing 400 while
 * 25 were held (Pixel audit, 2026-11-13); the price key could not tell that a price was more than the balance. The layout's value
 * SEEDS this store; refreshCredits() re-reads the account (GET /api/credits/account, the member's own RLS read) after a
 * generation is started, cancelled or finished, and when the tab comes back into view.
 *
 * Only an organization the layout seeded is ever read: the operator's exempt organization (no pill) and a database without 0020
 * stay unseeded, so nothing here asks for them or shows a number for them. A read that fails keeps the last value (never a zero).
 * Nothing here spends or holds: it only reads.
 */

type Entry = { orgId: string; account: CreditAccount; seed: string };

let entry: Entry | null = null;
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const seedKey = (a: CreditAccount) => `${a.balance}/${a.reserved}`;

/**
 * The layout's value for `orgId`. A NEW server value (a navigation re-rendered the layout) replaces what the store holds; the same
 * server value seen again (a re-render of the same page) does not undo a fresher read.
 */
export function seedCredits(orgId: string | null, account: CreditAccount | null): void {
  if (!orgId || !account) return;
  const key = seedKey(account);
  if (entry && entry.orgId === orgId && entry.seed === key) return;
  entry = { orgId, account, seed: key };
  emit();
}

/** The account the store holds for `orgId`, or null (not seeded: exempt, not supported, or another organization). */
export function creditsFor(orgId: string | null | undefined): CreditAccount | null {
  return orgId && entry && entry.orgId === orgId ? entry.account : null;
}

/**
 * Re-reads the seeded organization's account. Concurrent calls share one request. No-op for an organization that was not seeded.
 * Resolves once the store is updated (or the read failed and the old value stays).
 */
export function refreshCredits(orgId: string | null | undefined): Promise<void> {
  if (!orgId || !entry || entry.orgId !== orgId) return Promise.resolve();
  const running = inFlight.get(orgId);
  if (running) return running;
  const p = (async () => {
    try {
      const res = await fetch(`/api/credits/account?org_id=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { account?: unknown } | null;
      if (!body || !body.account || typeof body.account !== "object") return;
      // Another organization was opened meanwhile: this answer is not its.
      if (!entry || entry.orgId !== orgId) return;
      entry = { orgId, account: coerceAccount(body.account), seed: entry.seed };
      emit();
    } catch {
      // Unknown, never a zero: the last value stays.
    } finally {
      inFlight.delete(orgId);
    }
  })();
  inFlight.set(orgId, p);
  return p;
}

/**
 * The live account for `orgId`. With `seed` (the header): the layout's value seeds the store, and a tab that comes back into view
 * re-reads it. null when nothing was seeded for this organization (`seed` null means the layout shows no credits: then neither
 * does this, whatever the store holds).
 */
export function useLiveCredits(orgId: string | null | undefined, seed?: CreditAccount | null): CreditAccount | null {
  const seeding = seed !== undefined;
  const balance = seed?.balance;
  const reserved = seed?.reserved;
  // Seeded after render (an update to the store during render would re-render other components mid-render).
  useEffect(() => {
    if (seeding && orgId && balance !== undefined && reserved !== undefined) seedCredits(orgId, coerceAccount({ balance, reserved }));
  }, [seeding, orgId, balance, reserved]);
  const live = useSyncExternalStore(subscribe, () => creditsFor(orgId), () => null);
  const hasSeed = !!seed;
  useEffect(() => {
    if (!seeding || !orgId || !hasSeed) return;
    const onShow = () => {
      if (document.visibilityState === "visible") void refreshCredits(orgId);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [seeding, orgId, hasSeed]);
  if (!seeding) return live;
  // The layout shows no credits for this organization: neither does this, whatever the store holds.
  if (!seed) return null;
  return live ?? seed;
}

/** Tests only: forget everything. */
export function resetCreditsLive(): void {
  entry = null;
  inFlight.clear();
  emit();
}
