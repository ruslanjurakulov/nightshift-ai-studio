"use client";

import { useId, useRef, useState } from "react";
import { Check, LogOut, Plus, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { Avatar } from "@/components/account/Avatar";
import type { DeviceAccountView } from "@/lib/device-accounts";
import {
  addAccount,
  logOutAllParked,
  logOutParked,
  switchAccount,
  useDeviceAccounts,
  type ActionResult,
  type DeviceAccountsProblem,
} from "@/lib/device-accounts-client";
import "@/components/owner-console/owner-console.css";

/**
 * The accounts kept on this device, in the avatar menu (lib/device-accounts.ts), listed the way a messenger lists them: the
 * current one checked, the others one tap away, then "Add account", and a way out of each and of all. Drawn with the same
 * rows as the account switcher below it (owner-console.css `.acct-switch-*`), so the two lists read as one menu.
 *
 * Every action is a POST to the server and nothing more: the server switches, parks or signs out, and a switch or an add
 * ends in a FULL page load, so nothing the previous account was shown stays in memory. A row whose stored session the auth
 * server refused reads "Sign in again"; it is never dropped quietly, and no other account is opened in its place.
 */
export function DeviceAccounts({
  enabled,
  onSignOutCurrent,
  avatarV = null,
}: {
  enabled: boolean;
  onSignOutCurrent: () => Promise<void> | void;
  /** The current account's photo version, so its row shows the same avatar as the menu's header. */
  avatarV?: number | null;
}) {
  const { t } = useI18n();
  const d = t.deviceAccounts;
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const { accounts, reload } = useDeviceAccounts(enabled);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<DeviceAccountsProblem | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const words: Record<DeviceAccountsProblem, string> = {
    failed: d.failed,
    unavailable: d.unavailable,
    mismatch: d.mismatch,
    limit: d.limit,
    expired: d.expiredMessage,
    changed: d.changed,
  };

  // Focus goes to the section's heading when the element that had it disappears (a row signed out, a retry), never to <body>.
  const refocus = () => requestAnimationFrame(() => heading.current?.focus());

  async function run(key: string, action: () => Promise<ActionResult>, leaving: boolean) {
    if (busy) return;
    setBusy(key);
    setProblem(null);
    setNote(null);
    const result = await action();
    if (!result.ok) {
      setProblem(result.problem);
      // A refused session, a dropped slot or a change in another tab alters the list: show it as it now is.
      reload();
      setBusy(null);
      return;
    }
    if (result.notRevoked) setNote(d.notRevoked);
    if (result.same || !leaving) {
      reload();
      setBusy(null);
      refocus();
    }
  }

  const label = (a: DeviceAccountView) => a.name ?? a.maskedEmail;
  const disabled = busy !== null ? "true" : undefined;

  return (
    <section aria-labelledby={headingId} className="acct-switch" data-in-menu="true" data-device-accounts="">
      <h3 id={headingId} ref={heading} tabIndex={-1} className="acct-switch-h outline-none">
        {d.title}
      </h3>
      <span role="status" className="sr-only">
        {busy ? d.working : accounts.state === "loading" ? d.loading : ""}
      </span>

      {accounts.state === "loading" && (
        <p aria-hidden className="acct-switch-hint px-1">
          {d.loading}
        </p>
      )}
      {accounts.state === "failed" && (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <p role="status" className="acct-switch-err">
            {d.loadFailed}
          </p>
          <button
            type="button"
            onClick={() => {
              reload();
              refocus();
            }}
            className="btn-quiet inline-flex min-h-11 items-center gap-1 px-2 text-xs"
          >
            <RefreshCw aria-hidden className="size-3.5" />
            {d.retry}
          </button>
        </div>
      )}

      {accounts.state === "ready" && (
        <>
          <ul className="acct-switch-list" aria-busy={busy !== null}>
            {accounts.data.accounts.map((a) => {
              const key = a.slot === null ? "current" : `slot-${a.slot}`;
              const body = (
                <>
                  <span className="acct-switch-ic" aria-hidden>
                    {a.current ? <Avatar email={a.maskedEmail} version={avatarV} size={32} /> : a.initial}
                  </span>
                  <span className="acct-switch-tx">
                    <span className="acct-switch-nm truncate">{label(a)}</span>
                    <span className="acct-switch-hint truncate">
                      {a.stale ? `${d.expired} · ${d.signInAgain}` : a.current ? (a.name ? a.maskedEmail : d.current) : a.name ? a.maskedEmail : ""}
                    </span>
                  </span>
                  {a.current && (
                    <span className="acct-switch-check">
                      <Check aria-hidden className="size-4" />
                      <span className="sr-only">{d.current}</span>
                    </span>
                  )}
                  {(busy === `switch-${a.slot}` || busy === `add-${a.slot}`) && <span className="acct-switch-hint">{d.working}</span>}
                </>
              );
              return (
                <li key={key} className="flex items-center gap-1">
                  {a.current ? (
                    // The account in use: shown, not a control (there is nowhere to switch to).
                    <div className="acct-switch-row cursor-default" aria-current="true">
                      {body}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="acct-switch-row"
                      aria-disabled={disabled}
                      aria-label={a.stale ? `${d.signInAgain}: ${label(a)}` : fmt(d.switchTo, { name: label(a) })}
                      onClick={() => {
                        if (busy) return;
                        if (a.stale) void run(`add-${a.slot}`, () => addAccount(a), true);
                        else void run(`switch-${a.slot}`, () => switchAccount(a), true);
                      }}
                    >
                      {body}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={fmt(d.logOutOf, { name: label(a) })}
                    title={d.logOut}
                    aria-disabled={disabled}
                    onClick={() => {
                      if (busy) return;
                      if (a.current) void onSignOutCurrent();
                      else void run(`logout-${a.slot}`, () => logOutParked(a), false);
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
            <button type="button" className="acct-switch-row" aria-disabled={disabled} onClick={() => void run("add", () => addAccount(), true)}>
              <span className="acct-switch-ic" aria-hidden>
                <Plus className="size-4" />
              </span>
              <span className="acct-switch-tx">
                <span className="acct-switch-nm">{busy === "add" ? d.working : d.add}</span>
              </span>
            </button>
          ) : (
            <p className="acct-switch-hint px-1">{d.limit}</p>
          )}

          {accounts.data.accounts.length > 1 && (
            <button
              type="button"
              className="acct-switch-row"
              aria-disabled={disabled}
              onClick={() =>
                void run(
                  "logout-all",
                  async () => {
                    const r = await logOutAllParked();
                    if (r.ok && r.notRevoked) {
                      // Said before leaving, as an ordinary sign-out does when the server could not be reached.
                      setNote(d.notRevoked);
                      await new Promise((resolve) => setTimeout(resolve, 2500));
                    }
                    if (r.ok) await onSignOutCurrent();
                    return r.ok ? { ok: true } : r;
                  },
                  true,
                )
              }
            >
              <span className="acct-switch-ic" aria-hidden>
                <LogOut className="size-4" />
              </span>
              <span className="acct-switch-tx">
                <span className="acct-switch-nm">{d.logOutAll}</span>
              </span>
            </button>
          )}
        </>
      )}

      {problem && (
        <p role="alert" className="acct-switch-err">
          {words[problem]}
        </p>
      )}
      {note && (
        <p role="status" className="acct-switch-err">
          {note}
        </p>
      )}
    </section>
  );
}
