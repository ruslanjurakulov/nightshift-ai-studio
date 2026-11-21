"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import { useSavedAccountsPresent } from "@/components/auth/saved-accounts-context";
import { usePublicI18n } from "@/lib/i18n/public-context";
import type { DeviceAccountView, ParkedSlot } from "@/lib/device-accounts";
import { logOutParked, switchAccount, useDeviceAccounts, type DeviceAccountsProblem } from "@/lib/device-accounts-client";

/**
 * The sign-in page's "continue as" for the accounts still kept on this device (lib/device-accounts.ts): after "Add account"
 * left the browser signed out on purpose, or after one account signed out while others stayed. Continuing is the same
 * server switch as in the avatar menu (a fresh session from the auth server, that account's own second factor). A row whose
 * session was refused says so and can be removed; to use it, sign in with the form below like anyone else.
 * Draws nothing at all when no account is kept here, so the ordinary sign-in page is unchanged.
 */
export function SavedAccounts() {
  const { t } = usePublicI18n();
  const d = t.deviceAccounts;
  const present = useSavedAccountsPresent();
  const { accounts, reload } = useDeviceAccounts(present);
  const [busy, setBusy] = useState<ParkedSlot | null>(null);
  const [problem, setProblem] = useState<DeviceAccountsProblem | null>(null);
  if (!present || accounts.state !== "ready") return null;
  const parked = accounts.data.accounts.filter((a): a is DeviceAccountView & { slot: ParkedSlot } => a.slot !== null);
  if (parked.length === 0) return null;
  const words: Record<DeviceAccountsProblem, string> = {
    failed: d.failed,
    unavailable: d.unavailable,
    mismatch: d.mismatch,
    limit: d.failed,
    expired: d.expired,
  };

  async function act(slot: ParkedSlot, action: () => Promise<{ ok: boolean; problem?: DeviceAccountsProblem }>, stay: boolean) {
    if (busy !== null) return;
    setBusy(slot);
    setProblem(null);
    const result = await action();
    if (!result.ok) setProblem(result.problem ?? "failed");
    if (!result.ok || stay) {
      reload();
      setBusy(null);
    }
  }

  return (
    <section aria-label={d.savedTitle} className="mt-6 flex flex-col gap-2" data-saved-accounts="">
      <h2 className="st-small m-0">{d.savedTitle}</h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {parked.map((a) => {
          const name = a.name ?? a.maskedEmail;
          return (
            <li key={a.slot} className="flex items-center gap-2">
              <button
                type="button"
                disabled={a.stale || busy !== null}
                onClick={() => void act(a.slot, () => switchAccount(a.slot), false)}
                className="st-fieldset flex min-h-11 flex-1 items-center gap-3 rounded-xl border border-[var(--ns-rule)] px-3 py-2 text-left disabled:cursor-default"
              >
                <span aria-hidden className="inline-grid size-8 shrink-0 place-items-center rounded-full border border-[var(--ns-rule)] text-sm font-semibold">
                  {a.initial}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[15px]">{a.stale ? name : fmt(d.continueAs, { name })}</span>
                  <span className="st-small truncate">{a.stale ? `${d.expired} · ${d.signInAgain}` : a.name ? a.maskedEmail : ""}</span>
                </span>
                {busy === a.slot && <span className="st-small ml-auto">{d.working}</span>}
              </button>
              <button
                type="button"
                aria-label={fmt(d.logOutOf, { name })}
                title={d.logOut}
                disabled={busy !== null}
                onClick={() => void act(a.slot, () => logOutParked(a.slot), true)}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--ns-rule)]"
              >
                <X aria-hidden className="size-4" />
              </button>
            </li>
          );
        })}
      </ul>
      {problem && (
        <p role="alert" className="st-small m-0 text-[var(--color-warn)]">
          {words[problem]}
        </p>
      )}
    </section>
  );
}
