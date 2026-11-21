"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ShieldCheck, UserRound } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { OWNER_CONSOLE } from "@/lib/owner-mode";
import "@/components/owner-console/owner-console.css";

export type AccountKind = "user" | "owner";

/**
 * The two accounts the platform owner keeps, listed the way a messenger lists its accounts: one row each, the current one
 * marked. "User" is the owner's own workspace, drawn exactly as a customer sees it; "Owner" is the Owner Console.
 *
 * Drawn only for the platform owner (the server decided it and passed `show`). Choosing a row asks the server
 * (POST /api/account/owner-mode), which checks the role again and remembers the choice for this device; then the app
 * opens that account's first screen. It changes what is drawn, never what anyone may open: every owner route still checks
 * the role on the server. A refused or failed switch leaves everything as it was and says so.
 */
export function AccountSwitcher({ current, onDone }: { current: AccountKind; onDone?: () => void }) {
  const { t } = useI18n();
  const s = t.ownerConsole.switcher;
  const router = useRouter();
  const [busy, setBusy] = useState<AccountKind | null>(null);
  const [failed, setFailed] = useState(false);

  async function choose(kind: AccountKind) {
    if (busy) return;
    if (kind === current) {
      onDone?.();
      // The Owner row is also the way back to the console from an owner tool page (the operator pages keep their own URLs).
      if (kind === "owner") router.push(OWNER_CONSOLE);
      return;
    }
    setBusy(kind);
    setFailed(false);
    try {
      const res = await fetch("/api/account/owner-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: kind === "owner" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      onDone?.();
      // "/" lands the User account on its workspace's Home (app/(app)/[channel]/page.tsx); the Owner account opens the console.
      router.push(kind === "owner" ? OWNER_CONSOLE : "/");
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  const rows: { kind: AccountKind; label: string; hint: string; Icon: typeof UserRound }[] = [
    { kind: "user", label: s.user, hint: s.userHint, Icon: UserRound },
    { kind: "owner", label: s.owner, hint: s.ownerHint, Icon: ShieldCheck },
  ];

  return (
    <div className="acct-switch" data-testid="account-switcher">
      <p className="acct-switch-h" id="acct-switch-h">
        {s.title}
      </p>
      <ul role="list" aria-labelledby="acct-switch-h" className="acct-switch-list">
        {rows.map(({ kind, label, hint, Icon }) => {
          const on = kind === current;
          return (
            <li key={kind}>
              <button
                type="button"
                className="acct-switch-row"
                aria-current={on ? "true" : undefined}
                aria-busy={busy === kind}
                disabled={busy !== null}
                onClick={() => choose(kind)}
                data-account={kind}
              >
                <span className="acct-switch-ic" aria-hidden>
                  <Icon className="size-4" strokeWidth={1.8} />
                </span>
                <span className="acct-switch-tx">
                  <span className="acct-switch-nm">{busy === kind ? s.switching : label}</span>
                  <span className="acct-switch-hint">{hint}</span>
                </span>
                {on && (
                  <span className="acct-switch-check">
                    <Check aria-hidden className="size-4" strokeWidth={2.2} />
                    <span className="sr-only">{s.current}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {failed && (
        <p role="alert" className="acct-switch-err">
          {s.failed}
        </p>
      )}
    </div>
  );
}
