"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { chargePerUnit, formatCredits, type CreditPrice } from "@/lib/credits";
import { unitMeaning } from "@/lib/creditUnits";
import { postOperator } from "@/lib/operator-post";
import { priceBigChange, ratioText } from "@/lib/owner-rpc";
import { ownerFailureText } from "@/lib/owner-rpc-text";
import type { PriceHistoryEntry } from "@/lib/owner-reads";
import { ownerTime } from "@/lib/format";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { ErrorState } from "@/components/ReadError";

/**
 * The price history (credit_price_history) with a Restore button (NIGHTSHIFT_OWNER_RPC on).
 *
 * Restore puts a service back to what it was BEFORE a change (a price that change created is removed again). It is
 * offered on the newest change of each service only: restoring an older row would silently undo the changes after
 * it, and the way to an older state is to restore one step at a time. It goes through the same sheet and the same
 * big-change guard as any other price change, showing the price now and the price after.
 */
export function OwnerPriceHistory({
  history,
  prices,
  maxRatio,
}: {
  /** null = the read failed. */
  history: PriceHistoryEntry[] | null;
  prices: CreditPrice[];
  maxRatio: number | null;
}) {
  const { t, locale } = useI18n();
  const p = t.ownerRpc.prices;
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const name = (unit: string) => unitMeaning(unit, t.credits.unitMeaning) ?? unit;
  const figure = (n: number) => new Intl.NumberFormat(locale, { maximumSignificantDigits: 8 }).format(n);
  const state = (rate: number | null, margin: number | null) =>
    rate === null ? p.noPrice : `${figure(rate)}${margin ? ` (+${formatCredits((margin ?? 0) * 100, locale)}%)` : ""}`;

  // The newest change of each unit (the list is newest first).
  const newest = new Set<number>();
  const seen = new Set<string>();
  for (const e of history ?? []) {
    if (!seen.has(e.unit)) {
      seen.add(e.unit);
      newest.add(e.id);
    }
  }

  async function restore(e: PriceHistoryEntry) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const label = name(e.unit);
    const now = prices.find((x) => x.unit === e.unit) ?? null;
    const target = e.oldRate === null ? null : { rate: e.oldRate, margin: e.oldMargin ?? 0 };
    const limit = maxRatio ?? 3;
    const big = priceBigChange(now ? { rate: now.creditsPerUnit, margin: now.margin } : null, target, limit);
    let serverSaidBig = false;
    const done = await confirm({
      title: fmt(p.restoreTitle, { name: label }),
      message: target === null ? fmt(p.restoreBodyRemove, { name: label }) : fmt(p.restoreBody, { name: label }),
      confirmLabel: big.big ? p.bigConfirm : p.restoreConfirm,
      tone: big.big ? "danger" : "primary",
      details: [
        { label: t.ownerSafety.dService, value: label === e.unit ? e.unit : `${label} (${e.unit})` },
        { label: t.ownerSafety.dNow, value: now ? `${figure(now.creditsPerUnit)} → ${figure(chargePerUnit(now))}` : p.noPrice },
        { label: p.dAfter, value: target === null ? p.noPrice : `${figure(target.rate)} → ${figure(chargePerUnit({ unit: e.unit, creditsPerUnit: target.rate, margin: target.margin }))}` },
        ...(big.big ? [{ label: p.dLimit, value: fmt(p.limitText, { max: limit }) }] : []),
      ],
      typeToConfirm: big.big ? p.bigWord : undefined,
      successMessage: fmt(p.restoreDone, { name: label }),
      run: async () => {
        const out = await postOperator("/api/owner/prices", { action: "restore", historyId: e.id, confirm: big.big || serverSaidBig });
        if (out.ok) return true;
        if (out.data.error === "confirm_required") {
          serverSaidBig = true;
          const num = (v: unknown) => (typeof v === "number" ? v : null);
          return fmt(p.serverBig, {
            rate: ratioText(num(out.data.rate_ratio)) ?? "—",
            charged: ratioText(num(out.data.charged_ratio)) ?? "—",
            max: num(out.data.max_ratio) ?? limit,
          });
        }
        return ownerFailureText(t, out, locale, true);
      },
    });
    lock.current = false;
    setBusy(false);
    if (done) router.refresh();
  }

  const actionText = (a: PriceHistoryEntry["action"]) => (a === "delete" ? p.actionDelete : a === "restore" ? p.actionRestore : p.actionSet);

  return (
    <section id="price-history" className="panel flex scroll-mt-7 flex-col gap-3 p-5 sm:p-6" aria-labelledby="price-history-title">
      {dialog}
      <h2 id="price-history-title" className="t-section">
        {p.historyTitle}
      </h2>
      <p className="text-xs leading-relaxed text-[var(--color-muted)]">{p.historyHint}</p>
      {history === null ? (
        <ErrorState compact message={p.historyFailed} />
      ) : history.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">{p.historyEmpty}</p>
      ) : (
        <ul className="flex flex-col">
          {history.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-3 border-t border-[var(--color-border)] py-3 first:border-t-0 first:pt-0">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-[var(--color-fg)]">{name(e.unit)}</p>
                <p className="tnum text-[13px] text-[var(--color-fg)]">{fmt(p.fromTo, { from: state(e.oldRate, e.oldMargin), to: state(e.newRate, e.newMargin) })}</p>
                <p className="text-xs text-[var(--color-muted)]">
                  {actionText(e.action)} · {ownerTime(e.at, locale)}
                  {e.source === "direct" ? ` · ${p.direct}` : ""}
                  {e.reason ? ` · ${e.reason}` : ""}
                </p>
              </div>
              {newest.has(e.id) && (
                <button type="button" onClick={() => void restore(e)} disabled={busy} className="btn-quiet min-h-11 shrink-0 text-xs disabled:opacity-55">
                  {p.restore}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
