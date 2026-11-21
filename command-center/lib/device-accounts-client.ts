"use client";

import { useCallback, useEffect, useState } from "react";
import { clearAllCreateAttempts } from "@/lib/create-attempt-store";
import { clearAllDrafts } from "@/lib/create-draft";
import { clearAllEditorDrafts } from "@/lib/editor-draft-store";
import { discardPendingAtSignOut } from "@/lib/site/pending-attachment";
import { createClient } from "@/lib/supabase/client";
import {
  DEVICE_ACCOUNTS_ADD,
  DEVICE_ACCOUNTS_API,
  DEVICE_ACCOUNTS_CHANNEL,
  DEVICE_ACCOUNTS_LOGOUT,
  DEVICE_ACCOUNTS_SWITCH,
  type DeviceAccountView,
  type DeviceAccountsAnswer,
  type ParkedSlot,
} from "@/lib/device-accounts";

/** Why an action did not happen, in the words the menu has for it (lib/i18n/device-accounts). */
export type DeviceAccountsProblem = "failed" | "unavailable" | "mismatch" | "limit" | "expired" | "changed";

export type ActionResult =
  | { ok: true; notRevoked?: boolean; same?: boolean }
  | { ok: false; problem: DeviceAccountsProblem };

type Row = Pick<DeviceAccountView, "slot" | "nonce">;

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function problemFor(status: number, error: unknown): DeviceAccountsProblem {
  if (status === 503) return "unavailable";
  if (error === "session_expired") return "expired";
  if (error === "account_mismatch") return "mismatch";
  if (error === "account_limit") return "limit";
  if (error === "slot_changed" || error === "unknown_slot") return "changed";
  return "failed";
}

/**
 * What belongs to the person in view and lives in this browser's storage (the unfinished Create form, its attempts, the
 * editor's drafts, a file kept from the home page): it goes before another account is shown, exactly as at sign-out, so
 * the next account never opens the previous one's work.
 */
async function forgetLocalWork(): Promise<void> {
  clearAllDrafts();
  clearAllCreateAttempts();
  clearAllEditorDrafts();
  await discardPendingAtSignOut();
}

/** Only a path on this site: the server's answer is trusted, but never as a way off the origin (`//x`, `/\x`, `https:`). */
export function samePath(to: unknown): string {
  if (typeof to !== "string" || !to.startsWith("/") || to.includes("\\")) return "/";
  try {
    const url = new URL(to, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

/** A FULL load, never the client router: no cached page or server-component payload of the previous account survives. */
function hardNavigate(to: string) {
  window.location.assign(to);
}

/** This tab, so it does not reload on its own announcement (another BroadcastChannel in the same tab hears it too). */
const TAB = Math.random().toString(36).slice(2);

/** Tells this browser's other tabs that the account in use changed, so they reload instead of acting as the old one. */
function announce() {
  try {
    const channel = new BroadcastChannel(DEVICE_ACCOUNTS_CHANNEL);
    channel.postMessage({ type: "changed", from: TAB });
    channel.close();
  } catch {
    /* no BroadcastChannel: the other tabs reload on their next navigation instead */
  }
}

/**
 * One account change at a time in this browser: two tabs switching at the same moment would each park the account the
 * other is activating, and the browser keeps only the last cookie of each name. Without Web Locks, it runs as it is.
 */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks) return fn();
  return locks.request(DEVICE_ACCOUNTS_CHANNEL, fn) as Promise<T>;
}

/** The browser client refreshing the outgoing session mid-switch would write it back over the new one: it stops first. */
function holdBrowserRefresh() {
  try {
    void createClient()?.auth.stopAutoRefresh();
  } catch {
    /* nothing to stop */
  }
}

async function leaveTo(json: Record<string, unknown> | null): Promise<void> {
  await forgetLocalWork();
  announce();
  hardNavigate(samePath(json?.to));
}

export function switchAccount(row: Row): Promise<ActionResult> {
  return exclusive(async () => {
    try {
      holdBrowserRefresh();
      const { status, json } = await post(DEVICE_ACCOUNTS_SWITCH, { slot: row.slot, nonce: row.nonce });
      if (status !== 200) return { ok: false, problem: problemFor(status, json?.error) };
      if (json?.same === true) return { ok: true, same: true };
      await leaveTo(json);
      return { ok: true };
    } catch {
      return { ok: false, problem: "unavailable" };
    }
  });
}

/** "Add account", or "Sign in again" for a refused row (`replace`). The browser then signs in as anyone does. */
export function addAccount(replace?: Row): Promise<ActionResult> {
  return exclusive(async () => {
    try {
      holdBrowserRefresh();
      const body = replace ? { replace: replace.slot, nonce: replace.nonce } : {};
      const { status, json } = await post(DEVICE_ACCOUNTS_ADD, body);
      if (status !== 200) return { ok: false, problem: problemFor(status, json?.error) };
      await leaveTo(json);
      return { ok: true };
    } catch {
      return { ok: false, problem: "unavailable" };
    }
  });
}

export function logOutParked(row: Row): Promise<ActionResult> {
  return exclusive(async () => {
    try {
      const { status, json } = await post(DEVICE_ACCOUNTS_LOGOUT, { slot: row.slot, nonce: row.nonce });
      if (status !== 200) return { ok: false, problem: problemFor(status, json?.error) };
      announce();
      return { ok: true, notRevoked: json?.revoked === false };
    } catch {
      return { ok: false, problem: "unavailable" };
    }
  });
}

export function logOutAllParked(): Promise<ActionResult> {
  return exclusive(async () => {
    try {
      const { status, json } = await post(DEVICE_ACCOUNTS_LOGOUT, { all: true });
      if (status !== 200) return { ok: false, problem: problemFor(status, json?.error) };
      return { ok: true, notRevoked: typeof json?.unrevoked === "number" && json.unrevoked > 0 };
    } catch {
      return { ok: false, problem: "unavailable" };
    }
  });
}

/**
 * Every tab of the app listens: when another tab switched, added or signed out an account, this one reloads, so its forms
 * never submit as an account it is not showing. Mounted once per frame (the avatar menu, the Owner Console's shell).
 */
export function useDeviceAccountsSync(): void {
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(DEVICE_ACCOUNTS_CHANNEL);
      channel.onmessage = (e: MessageEvent) => {
        const data = e.data as { type?: unknown; from?: unknown } | null;
        if (data?.type === "changed" && data.from !== TAB) window.location.reload();
      };
    } catch {
      channel = null;
    }
    return () => channel?.close();
  }, []);
}

export type AccountsState = { state: "loading" } | { state: "failed" } | { state: "ready"; data: DeviceAccountsAnswer };

/** GET the list while `enabled` (the menu open, the sign-in page mounted); `reload` reads it again after an action. */
export function useDeviceAccounts(enabled: boolean): { accounts: AccountsState; reload: () => void } {
  const [accounts, setAccounts] = useState<AccountsState>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setAccounts((a) => (a.state === "ready" ? a : { state: "loading" }));
    fetch(DEVICE_ACCOUNTS_API, { credentials: "same-origin", cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as DeviceAccountsAnswer;
        if (!Array.isArray(data?.accounts)) throw new Error("shape");
        if (alive) setAccounts({ state: "ready", data });
      })
      .catch(() => {
        if (alive) setAccounts({ state: "failed" });
      });
    return () => {
      alive = false;
    };
  }, [enabled, tick]);
  return { accounts, reload };
}

export type { ParkedSlot };
