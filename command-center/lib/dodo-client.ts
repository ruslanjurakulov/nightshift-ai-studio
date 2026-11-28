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
import type { DodoCheckoutRequest } from "@/lib/dodo";

/**
 * How opening a checkout ended. `too_many` is the database's cap (50 checkouts a day per organization, 0146) and
 * `not_on_sale` an item this deployment no longer sells: both say what to do instead of "try again".
 */
export type DodoOpenResult = "redirecting" | "already_subscribed" | "too_many" | "not_on_sale" | "outdated" | "requires_plan" | "failed";

const BALANCE_KEY = "ns:dodo:balance-before";

export async function openDodoCheckout(item: DodoCheckoutRequest, returnPath: string, balanceBefore: number | null): Promise<DodoOpenResult> {
  try {
    const res = await fetch("/api/billing/dodo/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A credit count goes alone: the server prices it, so no price the page computed is ever sent.
      body: JSON.stringify(
        item.kind === "credits" ? { kind: "credits", credits: item.credits, return_path: returnPath } : { kind: item.kind, id: item.id, return_path: returnPath },
      ),
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
    if (data.error === "already_subscribed") return "already_subscribed";
    if (data.error === "too_many_checkouts") return "too_many";
    if (data.error === "not_on_sale") return "not_on_sale";
    if (data.error === "checkout_changed") return "outdated";
    if (data.error === "topup_requires_plan") return "requires_plan";
    return "failed";
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

/** Which of our items a return is about, and how it ended. */
export interface DodoReturn {
  state: "return" | "cancelled";
  item: "pack" | "plan" | null;
}

/**
 * The statuses Dodo appends to the return URL that mean "paid, or still being
 * paid" (docs: developer-resources/checkout-session, "Handle the return":
 * `status` is always present; e.g. `succeeded` for a payment, `active` for a
 * subscription). Anything else (failed, cancelled, ...) reads as "nothing was
 * charged", never as "payment received".
 */
const PAID_OR_PENDING = new Set(["succeeded", "active", "processing", "pending"]);

/**
 * What the return URL says. OUR two parameters (`dodo`, `item`) come first;
 * Dodo appends its own (`payment_id` or `subscription_id`, `status`, `email`).
 * The docs do not say how it appends to a URL that already has a query, so a
 * value is read up to a stray `?` too. Null when the URL is not a Dodo return.
 */
export function parseDodoReturn(search: string): DodoReturn | null {
  const q = new URLSearchParams(search);
  const first = (name: string) => (q.get(name) ?? "").split("?")[0];
  const flag = first("dodo");
  const rawItem = first("item");
  const item = rawItem === "pack" || rawItem === "plan" ? rawItem : null;
  if (flag === "cancelled") return { state: "cancelled", item };
  if (flag !== "return") return null;
  // Dodo's own status, wherever it ended up (after `&`, or glued to our item after a `?`).
  const glued = /[?&]status=([a-z_]+)/.exec(search)?.[1] ?? null;
  const status = q.get("status") ?? glued;
  if (status !== null && !PAID_OR_PENDING.has(status)) return { state: "cancelled", item };
  return { state: "return", item };
}

/** The query keys a Dodo return may carry: ours and Dodo's. The customer's e-mail among them must not stay in the address bar. */
const RETURN_KEYS = ["dodo", "item", "payment_id", "subscription_id", "status", "email", "license_key"];

let parsedReturn: DodoReturn | null | undefined;
const consumed = new Set<string>();

/**
 * The return for one panel (packs or plans), once per page load. The first
 * call reads the address and removes the return's query from it (history
 * replace, no navigation), so the e-mail Dodo appends is not left in the
 * address bar or the history, and a refresh does not show "payment received"
 * again. Each panel gets its own item's answer once; the other panel's is not
 * shown twice.
 */
export function takeDodoReturn(item: "pack" | "plan"): DodoReturn["state"] | null {
  if (parsedReturn === undefined) {
    parsedReturn = parseDodoReturn(window.location.search);
    if (parsedReturn) {
      try {
        const url = new URL(window.location.href);
        for (const k of RETURN_KEYS) url.searchParams.delete(k);
        // A value glued after a stray "?" lives inside a key we just deleted; nothing of Dodo's is left behind.
        window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      } catch {
        /* the message still shows; the address keeps its query */
      }
    }
  }
  if (!parsedReturn || parsedReturn.item !== item || consumed.has(item)) return null;
  consumed.add(item);
  return parsedReturn.state;
}
