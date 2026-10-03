"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowUpRight, History, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { useOverlay } from "@/components/a11y/useOverlay";
import { Presence, PresenceItem } from "@/components/motion/Presence";
import { creditPillAmount, creditUnit, formatCredits, type CreditAccount } from "@/lib/credits";
import { planName, type AccountPlan } from "@/lib/account";
import { Meter } from "@/components/ui/Meter";
import { Timecode } from "@/components/ui/Timecode";

/**
 * The credit pill in the top bar and the small menu it opens: the balance, the
 * plan, and two ways on — Add credits and Usage, both plain links to the
 * Credits page.
 *
 * What it deliberately is not: a checkout. It opens no payment form, binds no
 * card and starts no purchase — buying happens on the Credits page, after the
 * terms and the price are on screen. A top-up one click from the balance is
 * the pattern that gets people charged by accident.
 *
 * The balance comes from the layout (read server-side under the member's own
 * session). With none to show — the exempt organization, migration 0020 not
 * applied, a failed read — the pill renders nothing rather than a 0.
 */
export function CreditMenu({ account, plan = null }: { account: CreditAccount | null; plan?: AccountPlan | null }) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  const close = useCallback(() => setOpen(false), []);
  // Escape closes and focus goes back to the pill; Tab stays inside while open.
  useOverlay(open, { onClose: close, container: panelRef, opener: buttonRef });

  // A route change (one of the menu's links) closes it.
  useEffect(() => setOpen(false), [pathname]);

  // A click anywhere else closes it, as a popover does.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const amount = creditPillAmount(account);
  if (amount === null || !account) return null;

  const shown = formatCredits(amount, locale);
  const unit = creditUnit(amount, locale, t.shell.creditUnit);
  const low = amount <= 0;
  const planLabel = planName(plan, t.account.planExempt);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={fmt(t.shell.creditsOpen, { n: shown, unit })}
        className="shell-pill"
      >
        {/* The balance as a meter (IDENTITY.md): lit = free to spend, hatched =
            held for running work. The button's name already says the number. */}
        <span aria-hidden className="hidden sm:contents">
          <Meter value={amount} held={account.reserved} segments={8} label={t.shell.creditsMenu} />
        </span>
        <span className="tnum text-sm font-medium" style={low ? { color: "var(--color-warn)" } : undefined}>
          {shown}
        </span>
        <span className="hidden text-xs text-[var(--color-muted)] sm:inline">{unit}</span>
      </button>

      <Presence>
      {open && (
        <PresenceItem
          kind="popover"
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="shell-popover fixed inset-x-3 top-16 z-50 flex flex-col gap-3 p-3 outline-none sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[288px]"
        >
          <div className="flex flex-col gap-2 rounded-[var(--ns-r-key)] bg-[var(--color-panel-2)] p-3">
            <h2 id={titleId} className="ns-eyebrow">
              {t.shell.creditsMenu}
            </h2>
            <p className="flex items-baseline gap-1.5">
              <span className="text-[26px] font-semibold leading-none text-[var(--color-fg)]" style={low ? { color: "var(--color-warn)" } : undefined}>
                <Timecode value={amount} locale={locale} />
              </span>
              <span className="text-xs text-[var(--color-muted)]">
                {unit} {t.shell.available}
              </span>
            </p>
            <Meter
              value={amount}
              held={account.reserved}
              size="lg"
              segments={16}
              label={t.shell.creditsMenu}
              valueText={`${shown} ${unit} ${t.shell.available}`}
            />
            {account.reserved > 0 && (
              <p className="text-xs text-[var(--color-muted)]">
                {fmt(t.shell.onHold, { n: formatCredits(account.reserved, locale) })}
              </p>
            )}
          </div>

          <dl className="flex items-center justify-between gap-3 px-1 text-sm">
            <dt className="text-[var(--color-muted)]">{t.shell.plan}</dt>
            <dd className="truncate font-medium text-[var(--color-fg)]">{planLabel ?? t.common.dash}</dd>
          </dl>

          <div className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-3">
            <Link href={path("/credits")} onClick={close} className="btn-primary w-full">
              <Plus aria-hidden className="size-4" strokeWidth={2.25} />
              {t.shell.addCredits}
            </Link>
            <Link href={path("/credits") + "#activity-title"} onClick={close} className="shell-link justify-between">
              <span className="flex items-center gap-2.5">
                <History aria-hidden className="shell-icon size-4" strokeWidth={1.9} />
                {t.shell.usage}
              </span>
              <ArrowUpRight aria-hidden className="size-3.5 opacity-60" />
            </Link>
          </div>
        </PresenceItem>
      )}
      </Presence>
    </div>
  );
}
