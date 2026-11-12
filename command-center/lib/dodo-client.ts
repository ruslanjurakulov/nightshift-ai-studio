/**
 * Opening a Dodo Payments checkout from the browser. Browser-only — call from
 * event handlers and effects.
 *
 * The browser never talks to Dodo's API: it asks OUR server for a session
 * (POST /api/billing/dodo/checkout, naming our pack or plan id) and goes to
 * the hosted checkout URL the server got back. Dodo then returns the customer
 * to the Credits page with ?dodo=return (or ?dodo=cancelled). That query is
 * only a hint for which message to show while the page waits for the webhook;
 * nothing is credited from it, and the balance is always the server's.
 */

import { assignTop } from "@/components/view-mode/frame-nav";
import type { DodoCheckoutItem } from "@/lib/dodo";

export type DodoOpenResult = "redirecting" | "already_subscribed" | "failed";

const BALANCE_KEY = "ns:dodo:balance-before";

export async function openDodoCheckout(item: DodoCheckoutItem, returnPath: string, balanceBefore: number | null): Promise<DodoOpenResult> {
  try {
    const res = await fetch("/api/billing/dodo/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: item.kind, id: item.id, return_path: returnPath }),
    });
    const data = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
    if (res.ok && typeof data.url === "string") {
      // What the balance was, so the page that comes back can tell "arrived" from "not yet". A convenience only:
      // private windows may refuse storage, and then the page simply waits for the next change.
      try {
        if (balanceBefore !== null) window.sessionStorage.setItem(BALANCE_KEY, String(balanceBefore));
      } catch {
        /* storage refused */
      }
      // Same tab: a window opened after an await is what popup blockers stop.
      assignTop(data.url);
      return "redirecting";
    }
    return data.error === "already_subscribed" ? "already_subscribed" : "failed";
  } catch {
    return "failed";
  }
}

/** The balance stored before the checkout opened, once (it is cleared on read), or null. */
export function takeBalanceBefore(): number | null {
  try {
    const raw = window.sessionStorage.getItem(BALANCE_KEY);
    window.sessionStorage.removeItem(BALANCE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** What the return URL says: "return" (came back from paying), "cancelled", or nothing. */
export function dodoReturnState(search: string): "return" | "cancelled" | null {
  const v = new URLSearchParams(search).get("dodo");
  return v === "return" ? "return" : v === "cancelled" ? "cancelled" : null;
}
