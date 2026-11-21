"use client";

import { useId, useState } from "react";
import { Check, LogOut, Plus, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import type { DeviceAccountView, ParkedSlot } from "@/lib/device-accounts";
import {
  addAccount,
  logOutAllParked,
  logOutParked,
  switchAccount,
  useDeviceAccounts,
  type DeviceAccountsProblem,
} from "@/lib/device-accounts-client";

/**
 * The accounts kept on this device, in the avatar menu (lib/device-accounts.ts), listed the way a messenger lists them: the
 * current one checked, the others one tap away, then "Add account", and a way out of each and of all.
 *
 * Every action is a POST to the server and nothing more: the server switches, parks or signs out, and a switch or an add
 * ends in a FULL page load, so nothing the previous account was shown stays in memory. A row whose stored session the auth
 * server refused reads "Sign in again"; it is never dropped quietly, and no other account is opened in its place.
 */
export function DeviceAccounts({ enabled, onSignOutCurrent }: { enabled: boolean; onSignOutCurrent: () => Promise<void> | void }) {
  const { t } = useI18n();
  const d = t.deviceAccounts;
  const headingId = useId();
  const { accounts, reload } = useDeviceAccounts(enabled);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<DeviceAccountsProblem | null>(null);

  const words: Record<DeviceAccountsProblem, string> = {
    failed: d.failed,
    unavailable: d.unavailable,
    mismatch: d.mismatch,
    limit: d.limit,
    expired: d.expired,
  };

  async function run(key: string, action: () => Promise<{ ok: boolean; problem?: DeviceAccountsProblem }>, after?: () => void) {
    if (busy) return;
    setBusy(key);
    setProblem(null);
    const result = await action();
    if (!result.ok) {
      setProblem(result.problem ?? "failed");
      // A refused session or a dropped slot changes the list: show it as it now is.
      reload();
      setBusy(null);
      return;
    }
    after?.();
    // A switch or an add is leaving the page; anything else is done here.
    if (key.startsWith("logout")) setBusy(null);
  }

  const label = (a: DeviceAccountView) => a.name ?? a.maskedEmail;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5 border-b border-[var(--color-border)] pb-3" data-device-accounts="">
      <h3 id={headingId} className="text-xs text-[var(--color-muted)]">
        {d.title}
      </h3>

      {accounts.state === "loading" && (
        <p role="status" className="text-xs text-[var(--color-muted)]">
          {d.loading}
        </p>
      )}
      {accounts.state === "failed" && (
        <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-warn)]">
          {d.loadFailed}
          <button type="button" onClick={reload} className="btn-quiet inline-flex min-h-11 items-center gap-1 px-2 text-xs">
            <RefreshCw aria-hidden className="size-3.5" />
            {d.retry}
          </button>
        </p>
      )}

      {accounts.state === "ready" && (
        <>
          <ul className="flex flex-col gap-0.5" aria-busy={busy !== null}>
            {accounts.data.accounts.map((a) => {
              const key = a.slot === null ? "current" : `slot-${a.slot}`;
              const slot = a.slot as ParkedSlot;
              return (
                <li key={key} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-current={a.current ? "true" : undefined}
                    aria-disabled={busy !== null ? "true" : undefined}
                    aria-label={a.current ? `${d.current}: ${label(a)}` : a.stale ? `${d.signInAgain}: ${label(a)}` : fmt(d.switchTo, { name: label(a) })}
                    onClick={() => {
                      if (a.current || busy) return;
                      if (a.stale) void run(`add-${a.slot}`, () => addAccount(slot));
                      else void run(`switch-${a.slot}`, () => switchAccount(slot));
                    }}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-[var(--color-hover)] aria-[current=true]:bg-[var(--color-panel-2)] aria-disabled:cursor-progress"
                  >
                    <span aria-hidden className="inline-grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-panel-2)] text-sm font-semibold">
                      {a.initial}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium text-[var(--color-fg)]">{label(a)}</span>
                      <span className="truncate text-xs text-[var(--color-muted)]">
                        {a.stale ? `${d.expired} · ${d.signInAgain}` : a.name ? a.maskedEmail : a.current ? d.current : ""}
                      </span>
                    </span>
                    {a.current && <Check aria-hidden className="size-4 shrink-0 text-[var(--color-primary)]" />}
                    {busy === `switch-${a.slot}` || busy === `add-${a.slot}` ? (
                      <span className="text-xs text-[var(--color-muted)]">{d.working}</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={fmt(d.logOutOf, { name: label(a) })}
                    title={d.logOut}
                    aria-disabled={busy !== null ? "true" : undefined}
                    onClick={() => {
                      if (busy) return;
                      if (a.current) void onSignOutCurrent();
                      else void run(`logout-${a.slot}`, () => logOutParked(slot), reload);
                    }}
                    className="btn-sky is-quiet pill inline-flex size-11 shrink-0 items-center justify-center p-0"
                  >
                    <LogOut aria-hidden className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>

          {accounts.data.canAdd ? (
            <button
              type="button"
              aria-disabled={busy !== null ? "true" : undefined}
              onClick={() => void run("add", () => addAccount())}
              className="flex min-h-11 items-center gap-2.5 rounded-xl px-2 text-left text-sm hover:bg-[var(--color-hover)]"
            >
              <span aria-hidden className="inline-grid size-8 place-items-center rounded-full border border-dashed border-[var(--color-border)]">
                <Plus className="size-4" />
              </span>
              {busy === "add" ? d.working : d.add}
            </button>
          ) : (
            <p className="px-2 text-xs text-[var(--color-muted)]">{d.limit}</p>
          )}

          {accounts.data.accounts.length > 1 && (
            <button
              type="button"
              aria-disabled={busy !== null ? "true" : undefined}
              onClick={() =>
                void run("logout-all", logOutAllParked, () => {
                  void onSignOutCurrent();
                })
              }
              className="flex min-h-11 items-center gap-2.5 rounded-xl px-2 text-left text-sm text-[var(--color-muted)] hover:bg-[var(--color-hover)]"
            >
              <LogOut aria-hidden className="size-4" />
              {d.logOutAll}
            </button>
          )}
        </>
      )}

      {problem && (
        <p role="alert" className="px-2 text-xs text-[var(--color-warn)]">
          {words[problem]}
        </p>
      )}
    </section>
  );
}
