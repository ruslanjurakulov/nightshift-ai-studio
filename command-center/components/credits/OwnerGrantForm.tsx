"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { creditUnit, formatCredits, parseGrantAmount } from "@/lib/credits";
import { DEFAULT_CREDITS_PER_USD, creditsToUsd, grantTier, typedFigure } from "@/lib/confirm-tier";
import { formatUsdAmount } from "@/lib/number-format";
import { postOperator } from "@/lib/operator-post";
import { REASON_MAX, REASON_MIN, newIdempotencyKey } from "@/lib/owner-rpc";
import { ownerFailureText } from "@/lib/owner-rpc-text";
import { useConfirm } from "@/components/feedback/ConfirmDialog";

/**
 * Give credits to the current organization through the server (NIGHTSHIFT_OWNER_RPC on): the replacement for
 * GrantCreditsForm, which the Credits page uses while the flag is off.
 *
 * What is different, and why:
 *  - The call goes to /api/owner/credits/grant, which calls owner_grant_credits as the signed-in user. The database
 *    caps one grant and the rolling 24 hours, demands a reason (8 to 300 characters) and writes it to the audit trail.
 *  - A request key is made once per attempt and kept while the same grant (organization, amount, reason) is retried,
 *    so a double tap, a retry after a dropped connection and a second tap on the sheet are ONE grant: the database
 *    answers `duplicate` and adds nothing twice. Editing the amount or the reason is a new grant and gets a new key
 *    (reusing a key for different figures is refused by the database as `key_reused`).
 *  - The limits are shown before anything is typed, from the same settings row the database enforces.
 *  - Nothing is sent on the first tap: the sheet names the organization, the credits, the reason and the limits;
 *    a large grant asks for the figure back. The grant runs inside the sheet, which locks against a second tap.
 *    Every refusal is shown in the sheet in plain words (lib/owner-rpc-text.ts) with the keys live again.
 */
export interface GrantLimits {
  perCall: number | null;
  per24h: number | null;
  /** Credits given in the last 24 hours (all organizations); null when it could not be read. */
  granted24h: number | null;
  windowDays: number | null;
}

export function OwnerGrantForm({
  orgId,
  orgName,
  creditsPerUsd,
  limits,
}: {
  orgId: string;
  orgName: string;
  creditsPerUsd?: number | null;
  limits: GrantLimits;
}) {
  const { t, locale } = useI18n();
  const g = t.ownerRpc.grant;
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const lock = useRef(false);
  const attempt = useRef<{ sig: string; key: string } | null>(null);
  const answer = useRef<Record<string, unknown> | null>(null);

  const used = limits.granted24h;
  const left = limits.per24h !== null && used !== null ? Math.max(0, limits.per24h - used) : null;

  async function grant() {
    if (lock.current) return;
    const credits = parseGrantAmount(amount);
    if (credits === null) {
      setMsg({ ok: false, text: t.credits.grantInvalid });
      return;
    }
    const why = reason.trim();
    if (why.length < REASON_MIN) {
      setMsg({ ok: false, text: g.reasonShort });
      return;
    }
    if (limits.perCall !== null && credits > limits.perCall) {
      setMsg({ ok: false, text: fmt(g.overCall, { cap: formatCredits(limits.perCall, locale) }) });
      return;
    }
    lock.current = true;
    setBusy(true);
    setMsg(null);
    // One key per distinct grant; the SAME key when the same grant is tried again.
    const sig = `${orgId}|${credits}|${why}`;
    if (!attempt.current || attempt.current.sig !== sig) attempt.current = { sig, key: newIdempotencyKey() };
    const key = attempt.current.key;
    const unit = creditUnit(credits, locale, t.shell.creditUnit);
    const shown = formatCredits(credits, locale);
    const usd = creditsToUsd(credits, creditsPerUsd ?? DEFAULT_CREDITS_PER_USD);
    answer.current = null;
    const sent = await confirm({
      title: fmt(t.ownerSafety.grantTitle, { credits: shown, unit, org: orgName }),
      message: limits.windowDays === null ? g.sheetBodyNoWindow : fmt(g.sheetBody, { days: limits.windowDays }),
      confirmLabel: t.ownerSafety.grantConfirm,
      details: [
        { label: t.ownerSafety.dOrg, value: orgName },
        { label: t.ownerSafety.dCredits, value: `${shown} ${unit}` },
        { label: g.dReason, value: why },
        ...(usd === null ? [] : [{ label: t.ownerSafety.dCost, value: fmt(t.ownerSafety.costAbout, { usd: formatUsdAmount(usd, locale) }) }]),
        ...(limits.perCall === null ? [] : [{ label: g.dCallLimit, value: formatCredits(limits.perCall, locale) }]),
        ...(left === null ? [] : [{ label: g.dDayLeft, value: formatCredits(left, locale) }]),
      ],
      typeToConfirm: grantTier(credits) === 3 ? typedFigure(credits) : undefined,
      successMessage: fmt(t.ownerSafety.grantDone, { credits: shown, unit, org: orgName }),
      run: async () => {
        const out = await postOperator("/api/owner/credits/grant", { org: orgId, credits, reason: why, key });
        if (out.ok) {
          answer.current = out.data as Record<string, unknown>;
          return true;
        }
        // A dropped connection or a server error may have gone through: the same key makes a retry safe, and the
        // sentence says to look at the history first.
        return ownerFailureText(t, out, locale, true);
      },
    });
    lock.current = false;
    setBusy(false);
    if (!sent) return;
    attempt.current = null;
    setAmount("");
    setReason("");
    const reply = answer.current as Record<string, unknown> | null;
    const balance = typeof reply?.balance === "number" ? formatCredits(reply.balance, locale) : null;
    setMsg({
      ok: true,
      text:
        reply?.duplicate === true && balance !== null
          ? fmt(g.duplicate, { balance })
          : balance !== null
            ? fmt(g.given, { credits: shown, org: orgName, balance })
            : t.credits.granted,
    });
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

      <div className="flex flex-col gap-0.5 text-xs text-[var(--color-muted)]" aria-label={g.capsTitle}>
        {limits.perCall === null && limits.per24h === null ? (
          <p>{g.capsUnknown}</p>
        ) : (
          <>
            {limits.perCall !== null && <p className="tnum">{fmt(g.capCall, { cap: formatCredits(limits.perCall, locale) })}</p>}
            {limits.per24h !== null && (
              <p className="tnum">
                {used === null
                  ? fmt(g.capDayUnknown, { cap: formatCredits(limits.per24h, locale) })
                  : fmt(g.capDay, { used: formatCredits(used, locale), cap: formatCredits(limits.per24h, locale) })}
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          {t.credits.grantAmount}
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            enterKeyHint="next"
            placeholder="500"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="ns-field w-full min-w-0 sm:w-48"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          {g.reasonLabel}
          <textarea
            rows={2}
            maxLength={REASON_MAX}
            value={reason}
            placeholder={g.reasonPh}
            onChange={(e) => setReason(e.target.value)}
            className="ns-field min-w-0"
          />
          <span className="flex justify-between gap-3">
            <span>{g.reasonHint}</span>
            <span className="tnum">{fmt(g.reasonCount, { n: reason.trim().length })}</span>
          </span>
        </label>
        <button
          type="submit"
          disabled={busy || amount.trim() === ""}
          aria-busy={busy}
          className="btn-quiet min-h-11 self-start text-sm disabled:opacity-55"
        >
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
