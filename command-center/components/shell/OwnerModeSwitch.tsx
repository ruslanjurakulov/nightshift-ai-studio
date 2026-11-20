"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { useShell } from "@/components/shell/ShellContext";
import { landingSection } from "@/lib/navigation";

/**
 * The avatar menu's Owner mode switch, drawn for the platform operator only (useShell().ownerSwitch, decided by the
 * layout on the server). Pressing it asks the server (POST /api/account/owner-mode), which checks the role again and
 * sets the preference; the frame changes on the refresh that follows. A refused or failed request leaves the frame as
 * it is and says so. It changes how the app is drawn, never what anyone may open.
 */
export function OwnerModeSwitch({ onDone }: { onDone?: () => void }) {
  const { t } = useI18n();
  const { ownerSwitch, operator: on } = useShell();
  const router = useRouter();
  const path = useChannelPath();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!ownerSwitch) return null;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/account/owner-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: !on }),
      });
      if (!res.ok) throw new Error(String(res.status));
      onDone?.();
      // Each frame opens on its own first screen: the console's Command Center, the customer's Home.
      router.push(path("/" + landingSection(!on)));
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-busy={busy}
        disabled={busy}
        onClick={toggle}
        className="side-link w-full text-left"
        data-testid="owner-mode-switch"
      >
        <ShieldCheck aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span>{t.customerApp.shell.ownerMode}</span>
          <span className="text-xs text-[var(--color-muted)]">{t.customerApp.shell.ownerModeHint}</span>
        </span>
        <span aria-hidden className={on ? "ns-switch is-on" : "ns-switch"} />
      </button>
      {failed && (
        <p role="alert" className="px-3 text-xs text-[var(--color-warn)]">
          {t.customerApp.shell.ownerModeFailed}
        </p>
      )}
    </div>
  );
}
