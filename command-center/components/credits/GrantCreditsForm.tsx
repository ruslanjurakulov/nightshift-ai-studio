"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { creditUnit, formatCredits, parseGrantAmount } from "@/lib/credits";
import { DEFAULT_CREDITS_PER_USD, creditsToUsd, grantTier, typedFigure } from "@/lib/confirm-tier";
import { formatUsdAmount } from "@/lib/number-format";
import { useConfirm } from "@/components/feedback/ConfirmDialog";

/**
 * Grant credits to the current organization — platform owner/admin only.
 *
 * Calls grant_credits() (migration 0020) through the browser's own session:
 * the function itself refuses anyone who is not a platform owner/admin, locks
 * the account, and writes the ledger row with the caller as its author. The
 * page only renders this form for those people.
 *
 * Money moves from here, so nothing is sent on the first tap: a sheet names the
 * organization and the exact number of credits (and about what they cost), and
 * a large grant asks for the figure to be typed back. The grant itself runs
 * inside the sheet, which locks against a second tap while it is in flight.
 * grant_credits has no request id, so a retry after an error that may have
 * reached the server is the owner's call; the sheet says the ledger is the
 * place to check (the error text does).
 */
export function GrantCreditsForm({
  orgId,
  orgName,
  creditsPerUsd,
}: {
  orgId: string;
  orgName: string;
  /** Credits one dollar of vendor cost is priced at (the `usd` price), when set. */
  creditsPerUsd?: number | null;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const lock = useRef(false);

  async function grant() {
    if (lock.current) return;
    const credits = parseGrantAmount(amount);
    if (credits === null) {
      setMsg({ ok: false, text: t.credits.grantInvalid });
      return;
    }
    const supabase = createClient();
    if (!supabase) return;
    lock.current = true;
    setBusy(true);
    setMsg(null);
    const unit = creditUnit(credits, locale, t.shell.creditUnit);
    const shown = formatCredits(credits, locale);
    const usd = creditsToUsd(credits, creditsPerUsd ?? DEFAULT_CREDITS_PER_USD);
    const tier = grantTier(credits);
    const sent = await confirm({
      title: fmt(t.ownerSafety.grantTitle, { credits: shown, unit, org: orgName }),
      message: t.ownerSafety.grantBody,
      confirmLabel: t.ownerSafety.grantConfirm,
      details: [
        { label: t.ownerSafety.dOrg, value: orgName },
        { label: t.ownerSafety.dCredits, value: `${shown} ${unit}` },
        ...(usd === null ? [] : [{ label: t.ownerSafety.dCost, value: fmt(t.ownerSafety.costAbout, { usd: formatUsdAmount(usd, locale) }) }]),
      ],
      typeToConfirm: tier === 3 ? typedFigure(credits) : undefined,
      successMessage: fmt(t.ownerSafety.grantDone, { credits: shown, unit, org: orgName }),
      run: async () => {
        const { error } = await supabase.rpc("grant_credits", {
          p_org: orgId,
          p_amount: credits,
          p_note: note.trim().slice(0, 500) || null,
        });
        return error ? `${t.credits.grantFailed} ${t.ownerSafety.checkLedger}` : true;
      },
    });
    lock.current = false;
    setBusy(false);
    if (!sent) return;
    setAmount("");
    setNote("");
    setMsg({ ok: true, text: t.credits.granted });
    router.refresh();
  }

  return (
    <form
      noValidate
      className="panel flex flex-col gap-3 p-5 sm:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        void grant();
      }}
    >
      {dialog}
      <h2 className="t-section">
        {t.credits.grantTitle} · <span className="font-light">{orgName}</span>
      </h2>
      <p className="text-xs text-[var(--color-muted)]">{t.credits.grantHint}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          {t.credits.grantAmount}
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            enterKeyHint="go"
            placeholder="500"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="ns-field w-36 min-w-0"
          />
        </label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs text-[var(--color-muted)]">
          {t.credits.grantNote}
          <input
            type="text"
            maxLength={500}
            value={note}
            placeholder={t.credits.grantNotePh}
            onChange={(e) => setNote(e.target.value)}
            className="ns-field min-w-0"
          />
        </label>
        <button type="submit" disabled={busy || amount.trim() === ""} aria-busy={busy} className="btn-quiet text-sm disabled:opacity-55">
          {busy && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
          {busy ? t.credits.granting : t.credits.grant}
        </button>
      </div>
      <p className="min-h-4 text-xs" style={{ color: msg?.ok ? "var(--color-ok)" : "var(--color-fail)" }} aria-live="polite">
        {msg?.text}
      </p>
    </form>
  );
}
