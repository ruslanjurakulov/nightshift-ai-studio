"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { postOperator } from "@/lib/operator-post";
import { REASON_MAX, REASON_MIN, charCount, type ReversibleGrant } from "@/lib/owner-rpc";
import { ownerFailureText } from "@/lib/owner-rpc-text";
import { ownerTime } from "@/lib/format";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { ErrorState } from "@/components/ReadError";

/**
 * Grants given in the reversal window, each with a Reverse action (NIGHTSHIFT_OWNER_RPC on).
 *
 * Reversing is money moving back, so it is never one tap: Reverse opens a reason field (8 to 300 characters, kept in
 * the audit trail), Review opens a sheet that names the organization and the credits, and only that sheet's key
 * calls owner_reverse_grant. The database takes back only what is still unspent and records the rest as a
 * shortfall; the answer says which. A grant that already has a reversal shows "Reversed" and offers nothing.
 */
export function OwnerRecentGrants({
  orgName,
  grants,
  windowDays,
  failed,
}: {
  orgName: string;
  /** null = the read failed: nothing is offered as reversible. */
  grants: ReversibleGrant[] | null;
  windowDays: number;
  failed: boolean;
}) {
  const { t, locale } = useI18n();
  const g = t.ownerRpc.grant;
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [open, setOpen] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const lock = useRef(false);
  const answer = useRef<Record<string, unknown> | null>(null);

  async function review(grant: ReversibleGrant) {
    if (lock.current) return;
    const why = reason.trim();
    if (charCount(why) < REASON_MIN) {
      setMsg({ ok: false, text: g.reasonShort });
      return;
    }
    lock.current = true;
    setMsg(null);
    answer.current = null;
    const shown = formatCredits(grant.amount, locale);
    const done = await confirm({
      title: fmt(g.reverseTitle, { credits: shown, org: orgName }),
      message: g.reverseBody,
      confirmLabel: g.reverseConfirm,
      details: [
        { label: t.ownerSafety.dOrg, value: orgName },
        { label: g.dGrant, value: shown },
        { label: g.dGivenAt, value: ownerTime(grant.createdAt, locale) },
        { label: g.dReason, value: why },
      ],
      run: async () => {
        const out = await postOperator("/api/owner/credits/reverse", { transactionId: grant.id, reason: why });
        if (out.ok) {
          answer.current = out.data as Record<string, unknown>;
          return true;
        }
        return ownerFailureText(t, out, locale, true);
      },
    });
    lock.current = false;
    if (!done) return;
    const reply = answer.current as Record<string, unknown> | null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const reversed = num(reply?.reversed);
    const granted = num(reply?.granted);
    const shortfall = num(reply?.shortfall);
    setOpen(null);
    setReason("");
    setMsg({
      ok: true,
      text:
        reply?.duplicate === true
          ? g.reverseDuplicate
          : reversed !== null && granted !== null && shortfall !== null && shortfall > 0
            ? fmt(g.reverseShort, { reversed: formatCredits(reversed, locale), granted: formatCredits(granted, locale), shortfall: formatCredits(shortfall, locale) })
            : fmt(g.reverseDone, { reversed: reversed === null ? shown : formatCredits(reversed, locale) }),
    });
    router.refresh();
  }

  return (
    <section id="recent-grants" className="panel flex scroll-mt-7 flex-col gap-3 p-5 sm:p-6" aria-labelledby="recent-grants-title">
      {dialog}
      <h2 id="recent-grants-title" className="t-section">
        {g.recentTitle}
      </h2>
      <p className="text-xs leading-relaxed text-[var(--color-muted)]">{fmt(g.recentHint, { days: windowDays })}</p>
      {failed || grants === null ? (
        <ErrorState compact message={g.recentFailed} />
      ) : grants.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">{fmt(g.recentEmpty, { days: windowDays })}</p>
      ) : (
        <ul className="flex flex-col">
          {grants.map((row) => (
            <li key={row.id} className="flex flex-col gap-2 border-t border-[var(--color-border)] py-3 first:border-t-0 first:pt-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="tnum text-[15px] font-semibold text-[var(--color-fg)]">+{formatCredits(row.amount, locale)}</p>
                  <p className="text-xs text-[var(--color-muted)]">
                    {ownerTime(row.createdAt, locale)}
                    {row.note ? ` · ${row.note}` : ""}
                  </p>
                </div>
                {row.reversed ? (
                  <span className="shrink-0 text-xs text-[var(--color-muted)]">{g.reversedTag}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(open === row.id ? null : row.id);
                      setReason("");
                      setMsg(null);
                    }}
                    aria-expanded={open === row.id}
                    aria-controls={`reverse-form-${row.id}`}
                    aria-label={fmt(g.reverseAria, { credits: formatCredits(row.amount, locale) })}
                    className="btn-quiet btn-danger-quiet min-h-11 shrink-0 text-xs"
                  >
                    {g.reverse}
                  </button>
                )}
              </div>
              {open === row.id && !row.reversed && (
                <div id={`reverse-form-${row.id}`} className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
                    {g.reverseReasonLabel}
                    <textarea
                      rows={2}
                      maxLength={REASON_MAX}
                      value={reason}
                      placeholder={g.reasonPh}
                      onChange={(e) => setReason(e.target.value)}
                      className="ns-field min-w-0"
                    />
                    <span className="tnum self-end">{fmt(g.reasonCount, { n: charCount(reason.trim()) })}</span>
                  </label>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void review(row)} disabled={charCount(reason.trim()) < REASON_MIN} className="btn-quiet min-h-11 text-sm disabled:opacity-55">
                      {g.reverseReview}
                    </button>
                    <button type="button" onClick={() => setOpen(null)} className="btn-quiet min-h-11 text-sm">
                      {g.reverseCancel}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="min-h-4 text-xs" style={{ color: msg?.ok ? "var(--color-ok)" : "var(--color-fail)" }} aria-live="polite">
        {msg?.text}
      </p>
    </section>
  );
}
