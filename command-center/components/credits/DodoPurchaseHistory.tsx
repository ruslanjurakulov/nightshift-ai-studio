"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatUsdAmount } from "@/lib/number-format";
import type { DodoHistoryRead, DodoPurchaseRow } from "@/lib/dodo-history";
import { ErrorState } from "@/components/ReadError";
import { LocalTime } from "@/components/ui/LocalTime";
import { Timecode } from "@/components/ui/Timecode";

/**
 * The purchase history (invoices) on the Credits page when Dodo sells, for an owner or admin: each Dodo payment that credited
 * the workspace (migration 0157), what it bought, when, the amount Dodo charged (tax included), its refund state, and Dodo's
 * own invoice PDF on demand. Rule 5: a value the database did not give is "—", never a 0 or a guess.
 *
 * The invoice is fetched by this script from our own route (app/api/billing/dodo/invoice), which checks that the payment is
 * this workspace's before it asks Dodo; a refusal is said in words, and the row can be tried again.
 */

type InvoiceError = "rate_limited" | "not_found" | "failed" | "unavailable" | "busy";
type InvoiceState = { busy: true } | { busy: false; error: InvoiceError | null };

function amountText(row: DodoPurchaseRow, locale: string, unknown: string): string {
  // The webhook credits USD payments only, so another currency cannot be a credited row; were one there, its minor units are not
  // known to be cents, and it is said as unknown rather than formatted as dollars.
  if (row.amountMinor === null || row.currency !== "USD") return unknown;
  return formatUsdAmount(row.amountMinor / 100, locale, 2, 2);
}

export function DodoPurchaseHistory({ read }: { read: DodoHistoryRead }) {
  const { t, locale } = useI18n();
  const h = t.addCredits.history;
  const [invoices, setInvoices] = useState<Record<string, InvoiceState>>({});

  function itemText(row: DodoPurchaseRow): string {
    if (!row.item) return h.unknown;
    if (row.item.kind === "pack") return fmt(h.itemPack, { name: t.credits.buy.pack[row.item.id] });
    if (row.item.kind === "amount") return h.itemAmount;
    return h.itemPlan;
  }

  async function download(paymentId: string) {
    if (invoices[paymentId]?.busy) return;
    setInvoices((s) => ({ ...s, [paymentId]: { busy: true } }));
    let error: InvoiceError | null = "failed";
    try {
      const res = await fetch(`/api/billing/dodo/invoice?payment=${encodeURIComponent(paymentId)}`, { cache: "no-store" });
      if (res.ok && (res.headers.get("content-type") ?? "").startsWith("application/pdf")) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `invoice-${paymentId}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoked after the click has been handed to the browser's download.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        error = null;
      } else {
        // The route says whose refusal it is: Dodo's own (no invoice yet, its limit) or ours (not this workspace's payment,
        // Dodo not selling here, our per-person limit). Each has a different remedy.
        const code = ((await res.json().catch(() => ({}))) as { error?: unknown }).error;
        if (res.status === 429) error = code === "invoice_rate_limited" ? "rate_limited" : "busy";
        else if (res.status === 404 && code === "invoice_not_found") error = "not_found";
        else if (res.status === 404 || res.status === 403) error = "unavailable";
      }
    } catch {
      error = "failed";
    }
    setInvoices((s) => ({ ...s, [paymentId]: { busy: false, error } }));
  }

  return (
    <section id="invoices" className="panel flex scroll-mt-7 flex-col gap-3 p-5 sm:p-6" aria-labelledby="invoices-title" data-purchase-history={read.state}>
      <div className="flex flex-col gap-1">
        <h2 id="invoices-title" className="t-section">
          {h.title}
        </h2>
        <p className="text-sm font-light text-[var(--color-muted)]">{h.lead}</p>
      </div>

      {read.state === "unsupported" && <p className="text-sm text-[var(--color-muted)]">{h.notMigrated}</p>}
      {read.state === "failed" && <ErrorState compact message={h.readFailed} />}
      {read.state === "ok" && read.rows.length === 0 && <p className="text-sm text-[var(--color-muted)]">{h.empty}</p>}

      {read.state === "ok" && read.rows.length > 0 && (
        <>
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--color-muted)]">
                  <th scope="col" className="px-1 py-2 font-normal">{h.colDate}</th>
                  <th scope="col" className="px-1 py-2 font-normal">{h.colItem}</th>
                  <th scope="col" className="px-1 py-2 text-right font-normal">{h.colCredits}</th>
                  <th scope="col" className="px-1 py-2 text-right font-normal">{h.colAmount}</th>
                  <th scope="col" className="px-1 py-2 font-normal">{h.colStatus}</th>
                  <th scope="col" className="px-1 py-2 font-normal">{h.colPayment}</th>
                  <th scope="col" className="px-1 py-2 font-normal">{h.colInvoice}</th>
                </tr>
              </thead>
              <tbody>
                {read.rows.map((row) => {
                  const inv = invoices[row.paymentId];
                  const err = inv && !inv.busy ? inv.error : null;
                  return (
                    <tr key={row.paymentId} className="border-t border-[var(--color-border)] align-top" data-payment={row.paymentId}>
                      <td className="px-1 py-2 whitespace-nowrap">{row.paidAt ? <LocalTime iso={row.paidAt} locale={locale} /> : h.unknown}</td>
                      <td className="px-1 py-2">{itemText(row)}</td>
                      <td className="tnum px-1 py-2 text-right">{row.credits === null ? h.unknown : <Timecode value={row.credits} locale={locale} />}</td>
                      <td className="tnum px-1 py-2 text-right whitespace-nowrap">{amountText(row, locale, h.unknown)}</td>
                      <td className="px-1 py-2" data-status={row.status}>{h.status[row.status]}</td>
                      <td className="px-1 py-2 font-mono text-xs break-all">{row.paymentId}</td>
                      <td className="px-1 py-2">
                        <button
                          type="button"
                          onClick={() => download(row.paymentId)}
                          disabled={inv?.busy === true}
                          className="tap-link text-[var(--color-primary)] underline underline-offset-2 disabled:no-underline disabled:opacity-60"
                        >
                          {inv?.busy ? h.preparing : h.download}
                        </button>
                        {err && (
                          <p className="mt-1 max-w-[16rem] text-xs" style={{ color: "var(--color-fail)" }} role="alert">
                            {h.invoiceError[err]}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            {h.amountNote}
            {read.rows.length >= 100 ? ` ${h.limit}` : ""}
          </p>
        </>
      )}
    </section>
  );
}
