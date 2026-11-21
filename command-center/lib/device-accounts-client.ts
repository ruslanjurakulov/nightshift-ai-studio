"use client";

import { useCallback, useEffect, useState } from "react";
import { clearAllCreateAttempts } from "@/lib/create-attempt-store";
import { clearAllDrafts } from "@/lib/create-draft";
import { clearAllEditorDrafts } from "@/lib/editor-draft-store";
import { discardPendingAtSignOut } from "@/lib/site/pending-attachment";
import {
  DEVICE_ACCOUNTS_ADD,
  DEVICE_ACCOUNTS_API,
  DEVICE_ACCOUNTS_LOGOUT,
  DEVICE_ACCOUNTS_SWITCH,
  type DeviceAccountsAnswer,
  type ParkedSlot,
} from "@/lib/device-accounts";

/** Why an action did not happen, in the words the menu has for it (lib/i18n/device-accounts). */
export type DeviceAccountsProblem = "failed" | "unavailable" | "mismatch" | "limit" | "expired";

export type ActionResult = { ok: true } | { ok: false; problem: DeviceAccountsProblem };

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

/** Only a path on this site: the server's answer is trusted, but never as a way off the origin. */
function samePath(to: unknown): string {
  return typeof to === "string" && to.startsWith("/") && !to.startsWith("//") ? to : "/";
}

/** A FULL load, never the client router: no cached page or server-component payload of the previous account survives. */
function hardNavigate(to: string) {
  window.location.assign(to);
}

export async function switchAccount(slot: ParkedSlot): Promise<ActionResult> {
  try {
    const { status, json } = await post(DEVICE_ACCOUNTS_SWITCH, { slot });
    if (status !== 200) return { ok: false, problem: problemFor(status, json?.error) };
    await forgetLocalWork();
    hardNavigate(samePath(json?.to));
    return { ok: true };
  } catch {
    return { ok: false, problem: "unavailable" };
  }
}

/** "Add account", or "Sign in again" for a refused row (`replace`). The browser then signs in as anyone does. */
export async function addAccount(replace?: ParkedSlot): Promise<ActionResult> {
  try {
    const { status, json } = await post(DEVICE_ACCOUNTS_ADD, replace === undefined ? {} : { replace });
    if (status !== 200) return { ok: false, problem: problemFor(status, json?.error) };
    await forgetLocalWork();
    hardNavigate(samePath(json?.to));
    return { ok: true };
  } catch {
    return { ok: false, problem: "unavailable" };
  }
}

export async function logOutParked(slot: ParkedSlot): Promise<ActionResult> {
  try {
    const { status, json } = await post(DEVICE_ACCOUNTS_LOGOUT, { slot });
    return status === 200 ? { ok: true } : { ok: false, problem: problemFor(status, json?.error) };
  } catch {
    return { ok: false, problem: "unavailable" };
  }
}

export async function logOutAllParked(): Promise<ActionResult> {
  try {
    const { status, json } = await post(DEVICE_ACCOUNTS_LOGOUT, { all: true });
    return status === 200 ? { ok: true } : { ok: false, problem: problemFor(status, json?.error) };
  } catch {
    return { ok: false, problem: "unavailable" };
  }
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
