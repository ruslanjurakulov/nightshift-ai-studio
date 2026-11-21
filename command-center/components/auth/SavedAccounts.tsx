"use client";

import { useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { useSavedAccountsPresent } from "@/components/auth/saved-accounts-context";
import { AuthAlert } from "@/components/auth/AuthShell";
import type { DeviceAccountView, ParkedSlot } from "@/lib/device-accounts";
import { logOutParked, switchAccount, useDeviceAccounts, type ActionResult, type DeviceAccountsProblem } from "@/lib/device-accounts-client";

/**
 * The sign-in page's "continue as" for the accounts still kept on this device (lib/device-accounts.ts): after "Add account"
 * left the browser signed out on purpose, or after one account signed out while others stayed. Continuing is the same
 * server switch as in the avatar menu (a fresh session from the auth server, that account's own second factor). A row whose
 * session was refused says so and points to the form below; it can be removed. Draws nothing at all when no account is
 * kept here, so the ordinary sign-in page is unchanged and asks for nothing extra.
 */
export function SavedAccounts() {
  const { t } = usePublicI18n();
  const d = t.deviceAccounts;
  const present = useSavedAccountsPresent();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const { accounts, reload } = useDeviceAccounts(present);
  const [busy, setBusy] = useState<ParkedSlot | null>(null);
  const [problem, setProblem] = useState<DeviceAccountsProblem | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!present) return null;

  if (accounts.state === "failed") {
    return (
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <AuthAlert tone="warn">{d.loadFailed}</AuthAlert>
        <button type="button" onClick={reload} className="st-link text-[15px]">
          {d.retry}
        </button>
      </div>
    );
  }
  if (accounts.state !== "ready") return null;
  const parked = accounts.data.accounts.filter((a): a is DeviceAccountView & { slot: ParkedSlot } => a.slot !== null);
  if (parked.length === 0) return null;
  const words: Record<DeviceAccountsProblem, string> = {
    failed: d.failed,
    unavailable: d.unavailable,
    mismatch: d.mismatch,
    limit: d.failed,
    expired: d.expiredMessage,
    changed: d.changed,
  };

  async function act(slot: ParkedSlot, action: () => Promise<ActionResult>, stay: boolean) {
    if (busy !== null) return;
    setBusy(slot);
    setProblem(null);
    setNote(null);
    const result = await action();
    if (!result.ok) setProblem(result.problem);
    else if (result.notRevoked) setNote(d.notRevoked);
    if (!result.ok || stay || result.same) {
      reload();
      setBusy(null);
      requestAnimationFrame(() => heading.current?.focus());
    }
  }

  return (
    <section aria-labelledby={headingId} className="mt-6 flex flex-col gap-2" data-saved-accounts="">
      <h2 id={headingId} ref={heading} tabIndex={-1} className="st-small m-0 outline-none">
        {d.savedTitle}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {parked.map((a) => {
          const name = a.name ?? a.maskedEmail;
          return (
            <li key={a.slot} className="flex items-center gap-2">
              <button
                type="button"
                aria-disabled={a.stale || busy !== null ? "true" : undefined}
                aria-label={a.stale ? `${name}: ${d.staleBelow}` : fmt(d.continueAs, { name })}
                onClick={() => {
                  if (a.stale || busy !== null) return;
                  void act(a.slot, () => switchAccount(a), false);
                }}
                className="flex min-h-11 min-w-0 flex-1 flex-row items-center gap-3 rounded-[var(--ns-r-key,6px)] border border-[var(--ns-rule)] px-3 py-2 text-left hover:bg-[var(--color-hover)] aria-disabled:cursor-default"
              >
                <span aria-hidden className="inline-grid size-8 shrink-0 place-items-center rounded-[var(--ns-r-key,6px)] border border-[var(--ns-rule)] text-sm font-semibold">
                  {a.initial}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px]">{a.stale ? name : fmt(d.continueAs, { name })}</span>
                  <span className="st-small truncate">{a.stale ? d.staleBelow : a.name ? a.maskedEmail : ""}</span>
                </span>
                {busy === a.slot && <span className="st-small shrink-0">{d.working}</span>}
              </button>
              <button
                type="button"
                aria-label={fmt(d.logOutOf, { name })}
                title={d.logOut}
                aria-disabled={busy !== null ? "true" : undefined}
                onClick={() => {
                  if (busy !== null) return;
                  void act(a.slot, () => logOutParked(a), true);
                }}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--ns-r-key,6px)] border border-[var(--ns-rule)] hover:bg-[var(--color-hover)]"
              >
                <X aria-hidden className="size-4" />
              </button>
            </li>
          );
        })}
      </ul>
      <span role="status" className="sr-only">
        {busy !== null ? d.working : ""}
      </span>
      {problem && <AuthAlert tone="warn">{words[problem]}</AuthAlert>}
      {note && <AuthAlert tone="warn">{note}</AuthAlert>}
    </section>
  );
}
