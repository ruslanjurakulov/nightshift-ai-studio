"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { parseGrantAmount } from "@/lib/credits";

/**
 * Grant credits to the current organization — platform owner/admin only.
 *
 * Calls grant_credits() (migration 0020) through the browser's own session:
 * the function itself refuses anyone who is not a platform owner/admin, locks
 * the account, and writes the ledger row with the caller as its author. The
 * page only renders this form for those people.
 */
export function GrantCreditsForm({ orgId, orgName }: { orgId: string; orgName: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function grant() {
    const supabase = createClient();
    const credits = parseGrantAmount(amount);
    if (!supabase || busy) return;
    if (credits === null) {
      setMsg({ ok: false, text: t.credits.grantInvalid });
      return;
    }
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.rpc("grant_credits", {
      p_org: orgId,
      p_amount: credits,
      p_note: note.trim().slice(0, 500) || null,
    });
    setBusy(false);
    if (error) {
      setMsg({ ok: false, text: t.credits.grantFailed });
      return;
    }
    setAmount("");
    setNote("");
    setMsg({ ok: true, text: t.credits.granted });
    router.refresh();
  }

  const inputClass =
    "min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";

  return (
    <div className="panel flex flex-col gap-3 p-4">
      <h2 className="t-section">
        {t.credits.grantTitle} · <span className="font-light">{orgName}</span>
      </h2>
      <p className="text-[12px] text-[var(--color-muted)]">{t.credits.grantHint}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
          {t.credits.grantAmount}
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`w-36 ${inputClass}`}
          />
        </label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[11px] text-[var(--color-muted)]">
          {t.credits.grantNote}
          <input
            type="text"
            maxLength={500}
            value={note}
            placeholder={t.credits.grantNotePh}
            onChange={(e) => setNote(e.target.value)}
            className={inputClass}
          />
        </label>
        <button
          type="button"
          onClick={grant}
          disabled={busy || amount.trim() === ""}
          className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
        >
          {busy ? t.credits.granting : t.credits.grant}
        </button>
      </div>
      {msg && (
        <p className="text-[12px]" style={{ color: msg.ok ? "var(--color-ok)" : "var(--color-fail)" }} aria-live="polite">
          {msg.text}
        </p>
      )}
    </div>
  );
}
